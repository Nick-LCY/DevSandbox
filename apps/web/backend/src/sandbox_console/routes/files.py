"""运行期文件传输路由：上传 / 下载 / 只读读取 / 目录列表（四个端点）。

四条端点全挂在 ``/api/sandboxes/{name}/files/`` 下，能力本体在核心包
（``sandbox_platform.transfer``：路径校验、上传、探测、下载字节泵、只读读取、
目录列表），本模块只做**编排与转译**：入参校验、调用核心包、把结果翻成 HTTP 响应。

**三条硬口径**（ADR 0018）：

1. **上传端点必须 raw 流式读 body**（``application/octet-stream``，**无
   multipart**）：用 ``request.stream()`` 逐块消费，**不用** ``request.body()``
   ——后者把整个 body 缓冲进内存（实测 200 MiB body 让控制台进程 RSS 从
   44.5 MiB 涨到 433.9 MiB）。**「内存有界」只在字节泵层成立，端到端成立的
   前提就是这条 raw 流式读**。
2. **下载只放行普通文件**：核心包的下载编排**先做分层探测**（目录 / 普通文件 /
   FIFO·设备·套接字·其它可区分）——特殊文件一律拒（FIFO 会挂死 ``cat``）。
3. **鉴权自动生效**：端点挂在 ``/api`` 前缀下即被令牌中间件保护（不另写鉴权
   分支）；本轮**只用 GET / POST**，**CORS 白名单零改动**。

**只读读取（预览）是第四条端点**：正文依旧是**流式字节**（与下载同一套字节泵），
但**元信息走响应头**（二进制标记 / 总字节数 / 截断声明）——前端拿到响应头就能
先判二进制**立刻掐掉正文**，再按「已接收字节 / 总字节数」驱动进度条。

**大小不限**（反代与后端都无 body 上限、不会 413），但**单次请求的总时长受
部署链反代的读超时约束**（详见 ``API.md`` 的对应章节）。
"""

from __future__ import annotations

import logging
import posixpath
from urllib.parse import quote

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from sandbox_platform import FileTransferManager

from ..deps import get_transfer_manager
from ..schemas import FileListEntry, FileUploadResponse
from ..transfers import (
    iter_download_chunks,
    iter_read_chunks,
    open_download,
    open_read,
    parse_max_bytes,
    run_list,
    run_upload,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["运行期文件传输"])

#: 下载 / 只读读取响应的 Content-Type（**固定**：一律是原始字节流，不做内容嗅探）
DOWNLOAD_CONTENT_TYPE = "application/octet-stream"
#: 只读读取响应的 Content-Type（与下载同值：正文永远是原始字节）
READ_CONTENT_TYPE = DOWNLOAD_CONTENT_TYPE
#: 只读读取的**二进制标记**响应头：``true`` / ``false``（首块 NUL 嗅探的结果）
READ_BINARY_HEADER = "X-File-Binary"
#: 只读读取的**总字节数**响应头（探测值；探测不到时**不出现**）
READ_SIZE_HEADER = "X-File-Size"
#: 只读读取的**截断声明**响应头：**只在真的截断时出现**（值为 ``true``）
READ_TRUNCATED_HEADER = "X-File-Truncated"
#: 下载文件名取不到时的兜底名（ASCII 回退也用它）
DEFAULT_DOWNLOAD_NAME = "download"
#: ASCII 回退文件名里保留的字符（其余换下划线）
_ASCII_SAFE_CHARS = "._-"


# ---------------------------------------------------------------- 上传
@router.post(
    "/sandboxes/{name}/files/upload",
    response_model=FileUploadResponse,
    summary="上传文件到沙箱容器（raw 流式请求体）",
)
async def upload_sandbox_file(
    name: str,
    path: str,
    request: Request,
    manager: FileTransferManager = Depends(get_transfer_manager),
) -> FileUploadResponse:
    """把**请求体（原始字节）**写进沙箱容器的目标路径，返回写入的字节数。

    **请求体是 raw 流**（``application/octet-stream``，**无 multipart**）：
    ``request.stream()`` 逐块消费，**不整块缓冲**（内存有界）。

    语义：

    - **目标已存在 = 覆盖**（写同目录临时名 → ``mv`` 原子替换）；
    - **父目录不自动创建**：缺失即报错（文案引导先创建）；
    - **目标是已存在目录 → 前置拒绝**（400）：``mv 临时名 目录`` 会 rc=0 假成功；
    - **目标文件自身只读（0444）不是错误**（被静默覆盖）。

    失败按核心包的**失败分类码**映射状态码（见 ``errors.py`` 的映射表）；
    **容器内的 stderr 原文只进日志**，不进响应。
    """
    written = await run_upload(manager, name, path, request)
    return FileUploadResponse(path=path, bytes=written)


# ---------------------------------------------------------------- 下载
@router.get(
    "/sandboxes/{name}/files/download",
    summary="下载沙箱容器内的文件（流式响应）",
)
async def download_sandbox_file(
    name: str,
    path: str,
    manager: FileTransferManager = Depends(get_transfer_manager),
) -> StreamingResponse:
    """把沙箱容器内的文件**流式**回给调用方。

    **先分层探测再放行**（核心包的下载编排）：只允许**普通文件**——目录回 400、
    FIFO·设备·套接字等特殊文件回 400（防挂起）、不存在回 404。

    响应头：

    - ``Content-Type: application/octet-stream``；
    - ``Content-Length``：**探测到的字节数**（**声明值**）——文件在探测与读取
      之间变大时实际流会超出它，**服务端按声明值裁剪**（超出部分丢弃并记
      warning）⇒ **响应体永不超过声明长度**（否则响应体长度与 ``Content-Length``
      冲突会触发 uvicorn / h11 的 ``LocalProtocolError``，连接异常终止）；
      文件变小时按实际长度结束（协议层按「短 body」处理）；
    - ``Content-Disposition: attachment``：**ASCII 回退 + ``filename*=UTF-8''``
      百分号编码**（中文文件名必须正确）。

    **客户端断开 → 关泵回收 exec**（不留挂死的容器内进程）。
    """
    stream = await open_download(manager, name, path)
    headers = {
        "Content-Disposition": build_content_disposition(download_file_name(path)),
    }
    # 声明值（探测到的字节数）：既作响应头，也作**下载流的裁剪上限**——
    # 两者取同一个值，响应体与 ``Content-Length`` 永远不会冲突。
    declared = stream.size
    if declared is not None:
        headers["Content-Length"] = str(declared)
    return StreamingResponse(
        iter_download_chunks(stream, limit=declared),
        media_type=DOWNLOAD_CONTENT_TYPE,
        headers=headers,
    )


# ---------------------------------------------------------------- 只读读取
@router.get(
    "/sandboxes/{name}/files/read",
    summary="只读读取沙箱容器内的文件（流式响应 + 元信息响应头）",
)
async def read_sandbox_file(
    name: str,
    path: str,
    max_bytes: int | None = None,
    manager: FileTransferManager = Depends(get_transfer_manager),
) -> StreamingResponse:
    """把沙箱容器内的文件**只读**回给调用方（文件窗格 / Obsidian 预览的共同通道）。

    **正文是流式字节**（与下载同一套 ``cat`` 字节泵），**元信息全在响应头**：

    - ``X-File-Binary``：``true`` / ``false``——**首块** NUL 嗅探的结果。前端拿到
      ``true`` 就**立即掐掉正文**（不必把一整份二进制读进内存）；
    - ``X-File-Size``：**探测到的总字节数**（前端按「已接收字节 / 它」算进度条）；
    - ``X-File-Truncated``：``true``——**仅在真的截断时出现**（缺省即不截断）。
      正常流程前端按文件列表条目的 ``size`` 请求全量，所以**正常路径永远看不到
      这个头**；它只是「防护性上限真的生效了」的事实告知。

    ``max_bytes``：**防护性上限**（正整数；缺省 = **不截断**，读到 EOF）。超限时
    只回前 ``max_bytes`` 字节并给截断声明（超出部分**不读**，到限即关泵）。

    **先分层探测再放行**：只允许**普通文件**——目录回 400、FIFO·设备·套接字等
    特殊文件回 400（防挂起）、不存在回 404。

    响应头 ``Content-Length`` = ``min(总字节数, max_bytes)``（声明值与裁剪上限取
    同一个值，响应体永不超过声明长度，避 h11 的 ``LocalProtocolError``）。

    **客户端断开 → 关泵回收 exec**（二进制早退走的也是这条路）。
    """
    limit = parse_max_bytes(max_bytes)
    stream = await open_read(manager, name, path, limit)
    headers: dict[str, str] = {
        READ_BINARY_HEADER: "true" if stream.is_binary else "false",
    }
    if stream.size is not None:
        headers[READ_SIZE_HEADER] = str(stream.size)
    # 声明值：既有响应头，也是**裁剪上限**（两者取同一个值）。
    declared = stream.size
    if declared is not None and stream.max_bytes is not None:
        declared = min(declared, stream.max_bytes)
    if declared is not None:
        headers["Content-Length"] = str(declared)
    if stream.truncated:
        headers[READ_TRUNCATED_HEADER] = "true"
    return StreamingResponse(
        iter_read_chunks(stream, limit=declared),
        media_type=READ_CONTENT_TYPE,
        headers=headers,
    )


# ---------------------------------------------------------------- 目录列表
@router.get(
    "/sandboxes/{name}/files/list",
    response_model=list[FileListEntry],
    summary="列出沙箱容器内目录的条目",
)
async def list_sandbox_files(
    name: str,
    path: str,
    manager: FileTransferManager = Depends(get_transfer_manager),
) -> list[FileListEntry]:
    """列出容器内目录的条目：**名称 / 类型 / 大小 / 修改时间**。

    **隐藏文件（``.`` 开头）包含在内**；名字里的空格 / 中文 / 换行等保真。

    目标不是目录 → 400（文案「目标不是目录，不能列目录」）；不存在 → 404。
    """
    entries = await run_list(manager, name, path)
    return [
        FileListEntry(
            name=entry.name,
            kind=entry.kind,
            size=entry.size,
            mtime=entry.mtime,
        )
        for entry in entries
    ]


# ---------------------------------------------------------------- 辅助
def download_file_name(path: str) -> str:
    """从容器内路径取下载文件名（末段；取不到用兜底名）。"""
    trimmed = path.rstrip("/")
    return posixpath.basename(trimmed) or DEFAULT_DOWNLOAD_NAME


def build_content_disposition(filename: str) -> str:
    """构造 ``Content-Disposition: attachment`` 头。

    **ASCII 回退 + UTF-8 百分号编码**（RFC 6266）：浏览器优先读 ``filename*``，
    老客户端读 ``filename``。**中文文件名必须正确**——所以 ``filename*`` 一律
    给（哪怕全是 ASCII，也给一份，两边一致）。
    """
    fallback = _ascii_fallback(filename)
    encoded = quote(filename, safe="")
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"


def _ascii_fallback(filename: str) -> str:
    """ASCII 回退文件名：不可编码的字符换下划线；空则用兜底名。"""
    chars = []
    for char in filename:
        if char.isascii() and (char.isalnum() or char in _ASCII_SAFE_CHARS):
            chars.append(char)
        else:
            chars.append("_")
    return "".join(chars) or DEFAULT_DOWNLOAD_NAME
