"""运行期文件传输服务端接口测试：上传 / 下载 / 目录列表。

全部在临时目录里跑，不碰真实平台数据根，也不碰宿主沙箱与容器：

- 传输编排入口整体替换成假实现（``dependency_overrides``），只提供路由需要的
  那几个方法（**能力本体在核心包** ``sandbox_platform.transfer``，不在服务端）；
- 假下载流对齐核心包 ``DownloadStream`` 的语义（逐块读、EOF 返空字节、
  ``raise_for_status`` 核对失败原因、``close`` 回收字节泵）。

覆盖的负例与正例：401（无令牌）/ 404（沙箱不存在、文件不存在）/ 400（路径非法、
上传目标是目录、下载目录、下载特殊文件、列表目标不是目录、**上传字节数与
``Content-Length`` 不符**、**``Content-Length`` 头非法**）/ 409（沙箱已停止、
上传临时名撞名）/ 502（守护进程不可达）/ 500（其余平台异常，固定文案）。
"""

from __future__ import annotations

import asyncio
import logging
import threading
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sandbox_platform import NotFoundError, TransferError
from sandbox_platform.transfer import (
    MSG_SIZE_MISMATCH,
    REASON_DAEMON_UNREACHABLE,
    REASON_EXEC_FAILED,
    REASON_INVALID_PATH,
    REASON_NOT_FOUND,
    REASON_NOT_REGULAR,
    REASON_PARENT_NOT_WRITABLE,
    REASON_SANDBOX_STOPPED,
    REASON_SIZE_MISMATCH,
    REASON_TARGET_IS_DIR,
    REASON_TEMP_NAME_EXISTS,
    REASON_WRITE_FAILED,
    ListEntry,
)
from starlette.requests import Request
from sandbox_console import create_app
from sandbox_console.deps import get_transfer_manager
from sandbox_console.transfers import (
    RequestBodyBridge,
    _translate_upload_failure,
    iter_download_chunks,
)

from conftest import auth_headers

# 三个端点的路径（都挂在 /api 前缀下）
UPLOAD_URL = "/api/sandboxes/demo/files/upload"
DOWNLOAD_URL = "/api/sandboxes/demo/files/download"
LIST_URL = "/api/sandboxes/demo/files/list"


# ---------------------------------------------------------------- 假实现
class FakeDownloadStream:
    """假下载流：语义对齐核心包的 ``DownloadStream``。

    - ``read`` 逐块返回字节，读完返空字节（EOF）；
    - ``raise_for_status`` 核对失败原因（核心包：失败原因只在 stderr 里）；
    - ``close`` 回收字节泵（**客户端断开时必须被调用**）。
    """

    def __init__(self, path: str, size: int | None, payload: bytes) -> None:
        self.path = path
        self.size = size
        self._payload = payload
        self._offset = 0
        self.closed = False
        self.status_checked = False
        self.read_threads: list[str] = []
        self.close_threads: list[str] = []

    def read(self, size: int = 65536) -> bytes:
        """读一块字节；读完返空字节（EOF）。"""
        self.read_threads.append(threading.current_thread().name)
        if self.closed:
            return b""
        chunk = self._payload[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk

    def raise_for_status(self) -> None:
        """核对失败原因（核心包：读完要核对，否则失败下载会被当成空文件）。"""
        self.status_checked = True

    def close(self) -> None:
        """回收字节泵（幂等）。"""
        self.close_threads.append(threading.current_thread().name)
        self.closed = True


class FakeTransferManager:
    """假的传输编排入口：只提供路由需要的几个方法。"""

    def __init__(self) -> None:
        self.uploads: list[tuple[str, str, bytes]] = []
        self.upload_chunks: list[bytes] = []
        self.upload_expected_bytes: list[int | None] = []
        self.upload_error: Exception | None = None
        #: 消费到多少字节后失败（**模拟「容器内写入中断」**：取走一部分字节就失败，
        #: 且容器内的 ``size mismatch`` 标记已随容器客户端被杀而丢失）
        self.upload_fail_after_bytes: int | None = None
        self.download_error: Exception | None = None
        self.list_error: Exception | None = None
        self.download_payload = b""
        self.download_size: int | None = 0
        self.entries: list[ListEntry] = []
        self.streams: list[FakeDownloadStream] = []
        self.thread_names: list[str] = []
        # 容器内**目标文件的内容**（模拟容器侧）：字节数核对不过时**保持原样**
        self.targets: dict[str, bytes] = {}

    # -- 上传
    def upload(
        self,
        sandbox: str,
        target_path: str,
        chunks: Any,
        expected_bytes: int | None = None,
    ) -> int:
        """消费字节块迭代器（**逐块**），返回写入的字节数。

        **模拟核心包的字节数核对**（``expected_bytes``）：给了期望值、而实际字节数
        与之不等 ⇒ 抛 ``TransferError``（分类码 ``size_mismatch``）且**目标内容
        保持原样**（核心包的口径：容器内 ``mv`` **之前**核对，不符就不 ``mv``，
        旧内容不被半截内容覆盖）。

        **``upload_fail_after_bytes``**：消费到这个字节数就失败（**模拟「容器内
        写入中断」**——stderr 里的 ``size mismatch`` 标记已丢失，只能归
        ``write_failed``）。
        """
        self.thread_names.append(threading.current_thread().name)
        self.upload_expected_bytes.append(expected_bytes)
        if self.upload_error is not None and self.upload_fail_after_bytes is None:
            raise self.upload_error
        seen: list[bytes] = []
        total = 0
        for chunk in chunks:
            seen.append(chunk)
            total += len(chunk)
            if (
                self.upload_fail_after_bytes is not None
                and total >= self.upload_fail_after_bytes
            ):
                raise self.upload_error or TransferError(
                    f"文件写入中断：{target_path}", reason=REASON_WRITE_FAILED
                )
        self.upload_chunks.extend(seen)
        data = b"".join(seen)
        if expected_bytes is not None and len(data) != expected_bytes:
            raise TransferError(
                f"{MSG_SIZE_MISMATCH}：{target_path}", reason=REASON_SIZE_MISMATCH
            )
        self.uploads.append((sandbox, target_path, data))
        self.targets[target_path] = data
        return len(data)

    # -- 下载
    def download(self, sandbox: str, path: str) -> FakeDownloadStream:
        """起一条下载流（核心包：先分层探测，只放行普通文件）。"""
        self.thread_names.append(threading.current_thread().name)
        if self.download_error is not None:
            raise self.download_error
        stream = FakeDownloadStream(path, self.download_size, self.download_payload)
        self.streams.append(stream)
        return stream

    # -- 目录列表
    def list(self, sandbox: str, dir_path: str) -> list[ListEntry]:
        """列目录条目。"""
        self.thread_names.append(threading.current_thread().name)
        if self.list_error is not None:
            raise self.list_error
        return list(self.entries)


# ---------------------------------------------------------------- 夹具
@pytest.fixture
def manager() -> FakeTransferManager:
    """假的传输编排入口。"""
    return FakeTransferManager()


@pytest.fixture
def client(
    manager: FakeTransferManager,
    platform_home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    """测试客户端（传输编排入口整体替换）。"""
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    app = create_app()
    app.dependency_overrides[get_transfer_manager] = lambda: manager
    with TestClient(app, headers=auth_headers()) as http_client:
        yield http_client


# ---------------------------------------------------------------- 鉴权
def test_endpoints_require_a_token(
    manager: FakeTransferManager,
    platform_home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """无令牌：三个端点一律 401（**不另写鉴权分支**，靠 /api 中间件）。"""
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    app = create_app()
    app.dependency_overrides[get_transfer_manager] = lambda: manager
    with TestClient(app) as http_client:
        assert http_client.post(f"{UPLOAD_URL}?path=/tmp/a.bin", content=b"x").status_code == 401
        assert http_client.get(f"{DOWNLOAD_URL}?path=/tmp/a.bin").status_code == 401
        assert http_client.get(f"{LIST_URL}?path=/tmp").status_code == 401


# ---------------------------------------------------------------- 上传
def test_upload_returns_path_and_bytes(client: TestClient, manager: FakeTransferManager) -> None:
    """POST 上传：回 ``{path, bytes}``，字节数与实际写入一致。"""
    payload = b"hello transfer"
    response = client.post(f"{UPLOAD_URL}?path=/workspace/a.bin", content=payload)
    assert response.status_code == 200
    body = response.json()
    assert body == {"path": "/workspace/a.bin", "bytes": len(payload)}
    assert manager.uploads == [("demo", "/workspace/a.bin", payload)]


def test_upload_does_not_buffer_the_whole_body(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """**raw 流式读 body**：调用 ``request.body()`` 就是错（会整体缓冲进内存）。

    实测依据（ADR 0018 第 5 节）：200 MiB 的 JSON body 让控制台进程 RSS 从
    44.5 MiB 涨到 433.9 MiB ⇒ 上传端点必须 ``request.stream()`` 逐块消费。
    """
    async def _boom(self: Request) -> bytes:
        raise AssertionError("上传端点不得调用 request.body()（会整体缓冲进内存）")

    monkeypatch.setattr(Request, "body", _boom)
    response = client.post(f"{UPLOAD_URL}?path=/workspace/a.bin", content=b"streamed")
    assert response.status_code == 200
    assert response.json()["bytes"] == len(b"streamed")


def test_upload_runs_in_the_dedicated_thread_pool(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """字节搬运走**传输专用线程池**，不进事件循环的默认执行器。"""
    client.post(f"{UPLOAD_URL}?path=/workspace/a.bin", content=b"x")
    assert manager.thread_names
    assert all(name.startswith("sandbox-transfer-io") for name in manager.thread_names)


def test_upload_with_invalid_path_returns_400(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """路径非法（不是绝对路径）：400 + 固定中文 detail。"""
    manager.upload_error = TransferError(
        "容器内路径必须是绝对路径：relative/path", reason=REASON_INVALID_PATH
    )
    response = client.post(f"{UPLOAD_URL}?path=relative/path", content=b"x")
    assert response.status_code == 400
    assert "绝对路径" in response.json()["detail"]


def test_upload_to_a_directory_returns_400(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """目标是已存在目录：**前置拒绝** 400（``mv 临时名 目录`` 会 rc=0 假成功）。"""
    manager.upload_error = TransferError(
        "目标是一个目录，不能作为上传目标：/workspace/dir",
        reason=REASON_TARGET_IS_DIR,
    )
    response = client.post(f"{UPLOAD_URL}?path=/workspace/dir", content=b"x")
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "目录" in detail


def test_upload_with_stopped_sandbox_returns_409(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """沙箱已停止：409（先启动沙箱）。"""
    manager.upload_error = TransferError(
        "沙箱已停止，无法传输文件", reason=REASON_SANDBOX_STOPPED
    )
    response = client.post(f"{UPLOAD_URL}?path=/workspace/a.bin", content=b"x")
    assert response.status_code == 409
    assert "沙箱已停止" in response.json()["detail"]


def test_upload_with_temp_name_conflict_returns_409(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """上传临时名撞名：409（不是平台建的文件，重试即可）。"""
    manager.upload_error = TransferError(
        "目标目录里的临时文件名已被占用，请重试：/workspace/a.bin",
        reason=REASON_TEMP_NAME_EXISTS,
    )
    response = client.post(f"{UPLOAD_URL}?path=/workspace/a.bin", content=b"x")
    assert response.status_code == 409
    assert "临时文件名已被占用" in response.json()["detail"]


def test_upload_with_unreachable_daemon_returns_502(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """守护进程不可达（宿主侧失败）：502。"""
    manager.upload_error = TransferError(
        "守护进程无法连接 Docker，容器内命令未执行：/workspace/a.bin",
        reason=REASON_DAEMON_UNREACHABLE,
    )
    response = client.post(f"{UPLOAD_URL}?path=/workspace/a.bin", content=b"x")
    assert response.status_code == 502
    assert "Docker" in response.json()["detail"]


def test_upload_with_unknown_sandbox_returns_404(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """沙箱不存在：404。"""
    manager.upload_error = NotFoundError("沙箱不存在：nope")
    response = client.post(f"{UPLOAD_URL}?path=/workspace/a.bin", content=b"x")
    assert response.status_code == 404
    assert "沙箱不存在" in response.json()["detail"]


def test_upload_failure_never_echoes_the_stderr_text(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """**容器内的 stderr 原文只进日志**，绝不进响应。"""
    manager.upload_error = TransferError(
        "容器内命令执行失败：/workspace/a.bin", reason=REASON_EXEC_FAILED
    )
    response = client.post(f"{UPLOAD_URL}?path=/workspace/a.bin", content=b"x")
    assert response.status_code == 500
    assert response.json() == {"detail": "平台内部错误，请查看服务日志"}
    assert "stderr" not in response.text


# ---------------------------------------------------------------- 上传：字节数核对
def test_upload_with_content_length_passes_the_expected_bytes(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """带 ``Content-Length``：**期望字节数透传给核心包**（``expected_bytes``）。

    核心包拿它当契约值：容器内 ``mv`` **之前**核对实际字节数。
    """
    payload = b"hello transfer"
    response = client.post(
        f"{UPLOAD_URL}?path=/workspace/a.bin",
        content=payload,
        headers={"Content-Length": str(len(payload))},
    )
    assert response.status_code == 200
    assert response.json() == {"path": "/workspace/a.bin", "bytes": len(payload)}
    assert manager.upload_expected_bytes == [len(payload)]
    assert manager.uploads == [("demo", "/workspace/a.bin", payload)]


def test_upload_with_a_short_body_returns_400_and_keeps_the_target(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """**故意少发字节**（声明 100、实发 5）：400 + **目标保持旧内容**。

    核心包的口径：容器内 ``mv`` **之前**核对字节数，不符就删临时名 + 报错 +
    **不 ``mv``** ⇒ 旧内容不被半截内容覆盖；失败分类码 ``size_mismatch``
    ⇒ 服务端回 400（固定中文文案）。
    """
    manager.targets["/workspace/a.bin"] = b"old content"
    response = client.post(
        f"{UPLOAD_URL}?path=/workspace/a.bin",
        content=b"short",
        headers={"Content-Length": "100"},
    )
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "未完整写入" in detail
    # 期望字节数确实透传下去了（服务端这一段没掉链子）
    assert manager.upload_expected_bytes == [100]
    # 目标保持旧内容（半截内容没覆盖上去）
    assert manager.targets["/workspace/a.bin"] == b"old content"
    assert manager.uploads == []


@pytest.mark.parametrize("raw_length", ["abc", "-5", "1.5", "", " 12x"])
def test_upload_with_an_invalid_content_length_returns_400(
    client: TestClient, manager: FakeTransferManager, raw_length: str
) -> None:
    """``Content-Length`` **非法**（不是数字 / 负数 / 小数 / 空串）：**直接 400**。

    **不静默降级成「没有期望值」**：静默降级会把调用方声明的长度悄悄丢掉、
    字节数核对静默失效（用户以为有核对、实际没有）。上传**压根没发生**。
    """
    response = client.post(
        f"{UPLOAD_URL}?path=/workspace/a.bin",
        content=b"x",
        headers={"Content-Length": raw_length},
    )
    assert response.status_code == 400
    assert "Content-Length" in response.json()["detail"]
    assert manager.upload_expected_bytes == []
    assert manager.uploads == []


def test_upload_without_content_length_passes_none(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """**无 ``Content-Length``**（chunked 传输）：``expected_bytes=None``（**不核对**）。

    **残余风险**：没有长度信息时，客户端中断的上传**可能在目标路径留下半截
    文件**（核心包文档与 ``API.md`` 16.2 都写明了）。
    """

    def chunks() -> Any:
        yield b"chunk-0"
        yield b"chunk-1"

    response = client.post(f"{UPLOAD_URL}?path=/workspace/a.bin", content=chunks())
    assert response.status_code == 200
    assert manager.upload_expected_bytes == [None]


# ---------------------------------------------------------------- 下载
def test_download_returns_headers_and_exact_bytes(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """下载：响应头齐全、字节与容器内文件**逐字节一致**、中文文件名正确。"""
    payload = ("内容" * 100).encode("utf-8")
    manager.download_payload = payload
    manager.download_size = len(payload)
    response = client.get(f"{DOWNLOAD_URL}?path=/workspace/中文名.txt")
    assert response.status_code == 200
    assert response.content == payload
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["content-length"] == str(len(payload))
    disposition = response.headers["content-disposition"]
    assert disposition.startswith("attachment;")
    # ASCII 回退 + UTF-8 百分号编码（中文文件名必须正确）
    assert 'filename="___.txt"' in disposition
    assert "filename*=UTF-8''%E4%B8%AD%E6%96%87%E5%90%8D.txt" in disposition


def test_download_closes_the_byte_pump(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """下载读完要**回收字节泵**（关泵回收 exec，不留挂死进程）。"""
    manager.download_payload = b"data"
    manager.download_size = 4
    response = client.get(f"{DOWNLOAD_URL}?path=/workspace/a.bin")
    assert response.status_code == 200
    assert manager.streams
    assert manager.streams[0].closed is True
    # 读完要核对失败原因（核心包：失败原因只在 stderr 里）
    assert manager.streams[0].status_checked is True


def test_download_of_missing_file_returns_404(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """文件不存在：404。"""
    manager.download_error = TransferError(
        "文件不存在：/workspace/a.bin", reason=REASON_NOT_FOUND
    )
    response = client.get(f"{DOWNLOAD_URL}?path=/workspace/a.bin")
    assert response.status_code == 404
    assert "文件不存在" in response.json()["detail"]


def test_download_of_a_directory_returns_400(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """下载目录：400 + 明确中文文案（不放行）。"""
    manager.download_error = TransferError(
        "目标是目录：/workspace/dir", reason=REASON_TARGET_IS_DIR
    )
    response = client.get(f"{DOWNLOAD_URL}?path=/workspace/dir")
    assert response.status_code == 400
    assert "目录" in response.json()["detail"]


def test_download_of_a_special_file_returns_400(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """下载特殊文件（FIFO·设备·套接字）：400（防挂起，不放行）。"""
    manager.download_error = TransferError(
        "目标不是普通文件，不能下载：/workspace/fifo", reason=REASON_NOT_REGULAR
    )
    response = client.get(f"{DOWNLOAD_URL}?path=/workspace/fifo")
    assert response.status_code == 400
    assert "不是普通文件" in response.json()["detail"]


# ---------------------------------------------------------------- 目录列表
def test_list_returns_entries_with_hidden_files(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """列表：裸数组；条目含名称 / 类型 / 大小 / 修改时间；**隐藏文件包含在内**。"""
    manager.entries = [
        ListEntry(name="子目录", kind="dir", size=0, mtime=1700000000),
        ListEntry(name="a.bin", kind="file", size=1234, mtime=1700000001),
        ListEntry(name=".hidden", kind="file", size=7, mtime=1700000002),
    ]
    response = client.get(f"{LIST_URL}?path=/workspace")
    assert response.status_code == 200
    body = response.json()
    assert isinstance(body, list)
    assert body == [
        {"name": "子目录", "kind": "dir", "size": 0, "mtime": 1700000000},
        {"name": "a.bin", "kind": "file", "size": 1234, "mtime": 1700000001},
        {"name": ".hidden", "kind": "file", "size": 7, "mtime": 1700000002},
    ]


def test_list_of_a_file_returns_400(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """列表目标不是目录：400。"""
    manager.list_error = TransferError(
        "目标不是目录，不能列目录：/workspace/a.bin", reason=REASON_NOT_REGULAR
    )
    response = client.get(f"{LIST_URL}?path=/workspace/a.bin")
    assert response.status_code == 400
    assert "不是目录" in response.json()["detail"]


def test_list_with_unknown_sandbox_returns_404(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """沙箱不存在：404。"""
    manager.list_error = NotFoundError("沙箱不存在：nope")
    response = client.get(f"{LIST_URL}?path=/workspace")
    assert response.status_code == 404
    assert "沙箱不存在" in response.json()["detail"]


def test_upload_that_fails_early_does_not_hang_on_a_large_body(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """上传**前置就失败**时：大 body 也不能把请求挂死。

    前置失败（目标是已存在目录 / 父目录缺失 / 沙箱已停）时消费侧**已经退出**，
    body 若还在被读进**有界**桥接队列 ⇒ 队列塞满 ⇒ 喂 body 的一侧永远等不到
    空位 ⇒ 请求挂死。本用例用**分块发送**的大 body 覆盖这条路径。
    """
    manager.upload_error = TransferError(
        "目标是一个目录，不能作为上传目标：/workspace/dir",
        reason=REASON_TARGET_IS_DIR,
    )

    def chunks() -> Any:
        for _ in range(40):
            yield b"x" * 65536

    response = client.post(f"{UPLOAD_URL}?path=/workspace/dir", content=chunks())
    assert response.status_code == 400
    assert "目录" in response.json()["detail"]


def test_upload_streams_a_chunked_body_incrementally(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """分块 body 是**逐块**喂给核心包的（不是先攒齐再一次性交出去）。"""
    def chunks() -> Any:
        for index in range(8):
            yield f"chunk-{index}".encode()

    response = client.post(f"{UPLOAD_URL}?path=/workspace/a.bin", content=chunks())
    assert response.status_code == 200
    assert response.json()["bytes"] == sum(len(f"chunk-{i}".encode()) for i in range(8))
    assert len(manager.upload_chunks) >= 1


# ---------------------------------------------------------------- 上传：超长 Content-Length
def test_upload_with_an_overlong_content_length_returns_400(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """``Content-Length`` **超长数字串**（> 4300 位）：**400**（不是 500）。

    ``int()`` 对超过 ``sys.int_info.str_digits_check_threshold``（CPython 3.12
    默认 **4300** 位）的数字串抛 ``ValueError``——不拦住就是**未预期异常**
    （500 + 固定文案，调用方看不出是「头非法」）。服务端**长度预判**（> 20 位
    直接 400）+ ``try/except ValueError`` 兜底。
    """
    response = client.post(
        f"{UPLOAD_URL}?path=/workspace/a.bin",
        content=b"x",
        headers={"Content-Length": "9" * 5000},
    )
    assert response.status_code == 400
    assert "Content-Length" in response.json()["detail"]
    # 上传压根没发生
    assert manager.upload_expected_bytes == []
    assert manager.uploads == []


def test_upload_with_an_unknown_reason_returns_500(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """**分类码不在映射表里** ⇒ 500 + 固定文案（**不猜**：认不出来就不是用户侧问题）。

    固定文案之外**不回显异常原文**（容器内的 stderr 原文只进日志）。
    """
    manager.upload_error = TransferError(
        "某种还没归类的失败：/workspace/a.bin", reason="brand_new_reason"
    )
    response = client.post(f"{UPLOAD_URL}?path=/workspace/a.bin", content=b"x")
    assert response.status_code == 500
    assert response.json() == {"detail": "平台内部错误，请查看服务日志"}


def test_transfer_error_log_is_single_line(
    client: TestClient, manager: FakeTransferManager, caplog: pytest.LogCaptureFixture
) -> None:
    """**入日志前单行化**：异常原文带**用户给的路径**（路径里可以塞换行）。

    原样入日志 ⇒ **日志伪造**（调用方能往服务端日志里塞任意行，污染审计与
    告警）⇒ 入日志前把换行压成空格（**响应体不受影响**）。
    """
    manager.upload_error = TransferError(
        "文件不存在：/workspace/a.bin\n2026-01-01 伪造的一行日志",
        reason=REASON_NOT_FOUND,
    )
    with caplog.at_level(logging.INFO):
        response = client.post(f"{UPLOAD_URL}?path=/workspace/a.bin", content=b"x")
    assert response.status_code == 404
    lines = [
        record.getMessage()
        for record in caplog.records
        if "文件传输失败" in record.getMessage()
    ]
    assert lines
    assert all("\n" not in line and "\r" not in line for line in lines)


# ---------------------------------------------------------------- 上传：服务端字节计数兜底
def test_upload_interrupted_maps_to_size_mismatch(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """**服务端字节计数兜底**：写入中断且**取走的字节数少于期望值** ⇒ 400。

    真机中断场景下容器内 stderr 的 ``size mismatch`` 标记会随容器客户端
    被杀而丢失 ⇒ 核心包只能归 ``write_failed``（500）——但 ``API.md`` 承诺的是
    400。服务端自己数「核心包实际取走的字节数」：少了 ⇒ 直接归
    ``size_mismatch``（**不依赖 stderr 标记**）。
    """
    manager.upload_fail_after_bytes = 4
    manager.upload_error = TransferError(
        "文件写入中断：/workspace/a.bin", reason=REASON_WRITE_FAILED
    )
    # 声明 100 字节、实发 10 字节（客户端中断）：核心包取走 10 字节后失败
    response = client.post(
        f"{UPLOAD_URL}?path=/workspace/a.bin",
        content=b"0123456789",
        headers={"Content-Length": "100"},
    )
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "未完整写入" in detail
    # 期望字节数确实透传下去了
    assert manager.upload_expected_bytes == [100]
    # 半截内容没写进目标路径
    assert manager.uploads == []
    assert manager.targets == {}


def test_upload_failure_with_a_precise_reason_keeps_its_own_classification(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """**更精确的分类码不被字节数兜底盖掉**（字节数少了 ≠ 一定是「传少了」）。

    核心包已经给出明确结论（目标目录不可写）⇒ 维持原分类与原文案。
    """
    manager.upload_fail_after_bytes = 4
    manager.upload_error = TransferError(
        "目标目录不可写：/workspace", reason=REASON_PARENT_NOT_WRITABLE
    )
    response = client.post(
        f"{UPLOAD_URL}?path=/workspace/a.bin",
        content=b"0123456789",
        headers={"Content-Length": "100"},
    )
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "不可写" in detail
    assert "未完整写入" not in detail


def test_translate_upload_failure_maps_a_partial_body_to_size_mismatch() -> None:
    """**字节计数兜底的判定表**（直测）：取走的字节数少于期望值 ⇒ 改判 400。

    这是真机中断场景的核心判定：容器内的 ``size mismatch`` 标记丢了，核心包
    只给得出 ``write_failed`` ⇒ 服务端用自己的计数补一个更准的结论。
    """
    bridge = RequestBodyBridge()
    bridge.offer(b"0123")
    bridge.finish()
    assert list(bridge) == [b"0123"]  # 消费侧取走 4 字节
    exc = TransferError("文件写入中断：/workspace/a.bin", reason=REASON_WRITE_FAILED)
    mapped = _translate_upload_failure(exc, 10, bridge, "/workspace/a.bin")
    assert isinstance(mapped, TransferError)
    assert mapped.reason == REASON_SIZE_MISMATCH
    assert "未完整写入" in str(mapped)


def test_translate_upload_failure_keeps_the_core_classification() -> None:
    """**字节计数兜底不改判的三种情形**（判定表的另一半）。

    - 期望值未知（chunked 传输）⇒ 没有契约值可比；
    - 取走的字节数 == 期望值 ⇒ 字节数对得上，问题不在「少传了」；
    - 取走的字节数 == 0 ⇒ 失败发生在**写入之前**（前置探测 / 路径校验等）；
    - 核心包给出了更精确的分类码 ⇒ 那是真的原因，不能被字节数盖掉。
    """
    exc = TransferError("文件写入中断：/workspace/a.bin", reason=REASON_WRITE_FAILED)
    bridge = RequestBodyBridge()
    bridge.offer(b"0123")
    bridge.finish()
    assert list(bridge) == [b"0123"]

    # 期望值未知 ⇒ 不改判
    assert _translate_upload_failure(exc, None, bridge, "/workspace/a.bin") is exc
    # 字节数对得上 ⇒ 不改判
    assert _translate_upload_failure(exc, 4, bridge, "/workspace/a.bin") is exc
    # 一个字节都没取走 ⇒ 不改判（前置失败）
    assert (
        _translate_upload_failure(exc, 10, RequestBodyBridge(), "/workspace/a.bin")
        is exc
    )
    # 更精确的分类码 ⇒ 不改判
    precise = TransferError("目标目录不可写：/workspace", reason=REASON_PARENT_NOT_WRITABLE)
    assert _translate_upload_failure(precise, 10, bridge, "/workspace/a.bin") is precise


# ---------------------------------------------------------------- 下载：按声明长度裁剪
def test_download_truncates_the_body_to_the_declared_length(
    client: TestClient, manager: FakeTransferManager
) -> None:
    """**实际流超过声明长度** ⇒ 响应体**截断到声明长度**（不冲突、不报错）。

    文件在探测与读取之间变大时，实际流会超过 ``Content-Length`` ⇒ 响应体长度
    与声明值冲突 ⇒ uvicorn / h11 抛 ``LocalProtocolError``（连接异常终止）。
    服务端按声明长度裁剪 ⇒ 响应体永不超过声明长度。
    """
    payload = b"0123456789"
    manager.download_payload = payload
    manager.download_size = 4  # 声明（探测值）4 字节，实际流有 10 字节
    response = client.get(f"{DOWNLOAD_URL}?path=/workspace/a.bin")
    assert response.status_code == 200
    assert response.headers["content-length"] == "4"
    assert response.content == payload[:4]


def test_download_generator_closes_the_stream_on_an_early_exit() -> None:
    """**下载生成器提前关闭**（客户端断开）⇒ ``finally`` 里**关泵仍被调用**。

    不关泵 ⇒ 容器内的 ``cat`` 与 exec 进程一直挂着（挂死的容器内进程）。
    """
    stream = FakeDownloadStream("/workspace/a.bin", 100, b"x" * 100)

    async def _drive() -> None:
        generator = iter_download_chunks(stream)
        chunk = await anext(generator)
        assert chunk == b"x" * 100
        # 客户端断开：生成器被提前关闭
        await generator.aclose()

    asyncio.run(_drive())
    assert stream.closed is True
    # 没读完 ⇒ 不核对失败原因（核对在读完之后）
    assert stream.status_checked is False


def test_download_closes_the_stream_in_the_dedicated_thread_pool() -> None:
    """**关泵走传输专用线程池**（不阻塞事件循环）。

    ``stream.close()`` 最坏可阻塞约 6 s（按进程组回收 + stderr 排空线程收尾）——
    同步关会把事件循环堵住。
    """
    stream = FakeDownloadStream("/workspace/a.bin", 4, b"data")

    async def _drive() -> None:
        generator = iter_download_chunks(stream)
        assert b"".join([chunk async for chunk in generator]) == b"data"

    asyncio.run(_drive())
    assert stream.closed is True
    assert stream.close_threads
    assert all(name.startswith("sandbox-transfer-io") for name in stream.close_threads)


# ---------------------------------------------------------------- 请求体桥接（直测）
def test_body_bridge_queue_is_bounded() -> None:
    """**队列有界**：``maxsize`` 生效——满了就返回 ``False``（不阻塞调用方）。

    有界是端到端内存有界的关键：消费侧不取走，异步侧就不继续读 body。
    """
    bridge = RequestBodyBridge(max_chunks=2)
    assert bridge.offer(b"a") is True
    assert bridge.offer(b"b") is True
    # 满了：非阻塞地告诉调用方「等一会儿再试」
    assert bridge.offer(b"c") is False
    assert bridge.delivered_bytes == 2


def test_body_bridge_raises_the_failure_on_the_next_iteration() -> None:
    """``fail()`` 之后**迭代立刻抛错**（不把半截 body 当完整 body）。

    不抛的话，核心包会把「读到一半的 body」当成完整 body ⇒ ``mv`` 出去一个
    半截文件。
    """
    bridge = RequestBodyBridge()
    bridge.offer(b"partial")
    bridge.fail(RuntimeError("客户端断开"))
    with pytest.raises(RuntimeError, match="客户端断开"):
        list(bridge)


def test_body_bridge_finishes_normally() -> None:
    """``finish()`` 之后迭代**正常收工**（读到已投的块，然后结束）。"""
    bridge = RequestBodyBridge()
    bridge.offer(b"chunk-0")
    bridge.finish()
    assert list(bridge) == [b"chunk-0"]
    assert bridge.consumed_bytes == len(b"chunk-0")
