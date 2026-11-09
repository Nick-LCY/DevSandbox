"""运行期文件传输路由：上传 / 下载 / 目录列表（三个端点）。

三条端点全挂在 ``/api/sandboxes/{name}/files/`` 下，能力本体在核心包
（``sandbox_platform.transfer``：路径校验、上传、探测、下载字节泵、目录列表），
本模块只做**编排与转译**：入参校验、调用核心包、把结果翻成 HTTP 响应。

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
from ..transfers import iter_download_chunks, open_download, run_list, run_upload

logger = logging.getLogger(__name__)

router = APIRouter(tags=["运行期文件传输"])

#: 下载响应的 Content-Type（**固定**：一律是原始字节流，不做内容嗅探）
DOWNLOAD_CONTENT_TYPE = "application/octet-stream"
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
