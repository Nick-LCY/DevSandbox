"""运行期文件传输的单元测试（不依赖宿主特权资源）。

宿主级交互（容器内 exec、字节泵）全部走假守护进程，用例只钉平台自己那一层：
路径校验、分层探测、上传链路（临时名 + mv 覆盖 + 失败清理）、错误分类、
列表解析与下载前置类型检查。

**容器内脚本按 01 轮真机实测的口径写死**（ADR 0018 第 7 节）：错误分类样本、
NUL 记录格式、分层探测分支都在用例里逐条钉住。
"""

from __future__ import annotations

import posixpath
import subprocess
import threading
import time

import pytest

import sandbox_platform
from sandbox_platform import (
    DownloadStream,
    FileTransferManager,
    ListEntry,
    NotFoundError,
    ProbeResult,
    TransferError,
)
from sandbox_platform import transfer as transfer_module
from sandbox_platform.command import CommandResult
from sandbox_platform.errors import TransferError as TransferErrorFromErrors
from sandbox_platform.transfer import (
    KIND_BLOCKDEV,
    KIND_CHARDEV,
    KIND_DIR,
    KIND_FILE,
    KIND_FIFO,
    KIND_MISSING,
    KIND_SOCKET,
    KIND_SPECIAL,
    KIND_SYMLINK,
    LIST_SCRIPT,
    MSG_DAEMON_UNREACHABLE,
    MSG_EXEC_FAILED,
    MSG_EXEC_TIMEOUT,
    MSG_IS_DIRECTORY,
    MSG_NOT_A_DIRECTORY,
    MSG_NOT_FOUND,
    MSG_NOT_REGULAR,
    MSG_NO_RUNTIME,
    MSG_PARENT_MISSING,
    MSG_PARENT_NOT_DIRECTORY,
    MSG_PARENT_NOT_WRITABLE,
    MSG_PATH_EMPTY,
    MSG_PATH_HAS_NUL,
    MSG_PATH_NOT_ABSOLUTE,
    MSG_READONLY_FS,
    MSG_TARGET_IS_DIR,
    MSG_TEMP_NAME_EXISTS,
    MSG_WRITE_FAILED,
    MSG_INVALID_SIZE,
    MSG_SIZE_MISMATCH,
    PROBE_SCRIPT,
    REASON_DAEMON_UNREACHABLE,
    REASON_EXEC_FAILED,
    REASON_INVALID_SIZE,
    REASON_NOT_FOUND,
    REASON_NOT_REGULAR,
    REASON_NO_RUNTIME,
    REASON_PARENT_MISSING,
    REASON_PARENT_NOT_DIRECTORY,
    REASON_PARENT_NOT_WRITABLE,
    REASON_READONLY,
    REASON_SIZE_MISMATCH,
    REASON_TARGET_IS_DIR,
    REASON_TEMP_NAME_EXISTS,
    REASON_WRITE_FAILED,
    TEMP_PREFIX,
    UPLOAD_SCRIPT,
    classify_stderr,
    validate_container_path,
)

CONTAINER = "sandbox-demo"


# ---------------------------------------------------------------- 假宿主
class FakeStream:
    """假字节流。

    ``max_write`` 给「**每次最多写 N 字节**」模式：``write`` 只写进去 N 字节就
    返回 N——模拟裸管道的**短写**（一次写不完整是常态，写入侧必须循环到写完）。
    """

    def __init__(self, data: bytes = b"", *, max_write: int | None = None) -> None:
        self.buffer = bytearray(data)
        self.closed = False
        self.max_write = max_write

    def write(self, data: bytes) -> int:
        if self.closed:
            return 0
        if self.max_write is not None:
            data = data[: self.max_write]
        self.buffer.extend(data)
        return len(data)

    def read(self, size: int = -1) -> bytes:
        if not self.buffer:
            return b""
        chunk = bytes(self.buffer[:size] if size and size > 0 else self.buffer)
        del self.buffer[: len(chunk)]
        return chunk

    def close(self) -> None:
        self.closed = True


class SlowDrainStream(FakeStream):
    """假 stderr 流：**读之前先慢一拍**（模拟 stderr 排空线程还没收尾）。

    只有**真有数据**时才慢（空 stderr 直接返回 EOF）：这样能钉住「stdout 的 EOF
    与 stderr 排空线程几乎同时发生」那个竞态，而不拖慢无关用例。
    """

    def __init__(self, data: bytes = b"", delay: float = 0.2) -> None:
        super().__init__(data)
        self.delay = delay

    def read(self, size: int = -1) -> bytes:
        if not self.buffer:
            return b""
        time.sleep(self.delay)
        return super().read(size)


class FakeProcess:
    """假子进程（字节泵句柄）。

    ``hang=True`` 模拟「进程还没退」（``poll()`` 返回 ``None``）：此时
    ``wait(timeout=…)`` 抛 :class:`subprocess.TimeoutExpired`——与真进程等不到
    退出码时的行为一致（``wait`` 不带 timeout 时直接返回当前退出码）。
    """

    def __init__(
        self,
        stdout: bytes = b"",
        stderr: bytes = b"",
        returncode: int = 0,
        *,
        hang: bool = False,
        stdin_max_write: int | None = None,
    ):
        self.stdin = FakeStream(max_write=stdin_max_write)
        self.stdout = FakeStream(stdout)
        self.stderr = FakeStream(stderr)
        self.pid = 4242
        self.returncode: int | None = None if hang else returncode
        self.terminated = False
        self.killed = False

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = -15

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9

    def wait(self, timeout: float | None = None) -> int | None:
        if timeout is not None and self.returncode is None:
            raise subprocess.TimeoutExpired(cmd="docker exec", timeout=timeout)
        return self.returncode


class BlockingStream(FakeStream):
    """假字节流：读操作一直阻塞（模拟容器内命令不退出）。"""

    def __init__(self) -> None:
        super().__init__()
        self.released = threading.Event()

    def read(self, size: int = -1) -> bytes:
        self.released.wait(timeout=10)
        return b""

    def close(self) -> None:
        super().close()
        self.released.set()


class BlockingProcess(FakeProcess):
    """假子进程：stdout 读不回来（命令挂住）。"""

    def __init__(self) -> None:
        super().__init__()
        self.stdout = BlockingStream()


class RacyStream(FakeStream):
    """假 stdout 流：读**阻塞**；被关掉时抛 ``ValueError``。

    模拟真管道的**跨线程竞态**：看门狗线程 ``pump.close()`` 关掉流，主线程阻塞
    在 ``read()`` 上就撞上 ``ValueError: read of closed file``（真 CPython 行为）。
    """

    def __init__(self) -> None:
        super().__init__()
        self.released = threading.Event()

    def read(self, size: int = -1) -> bytes:
        self.released.wait(timeout=10)
        if self.closed:
            raise ValueError("read of closed file")
        return b""

    def close(self) -> None:
        super().close()
        self.released.set()


class FakeDaemon:
    """假守护进程：只记账，不碰宿主。

    ``queue`` 依次给每次 ``spawn_stream`` 安排一份响应（退出码 / stdout / stderr），
    用例据此脚本化「探测返回什么」「写入失败成什么样」。

    几个旋钮：

    - ``stdin_max_write``：每次 ``write`` 最多写 N 字节（模拟裸管道**短写**）；
    - ``stderr_delay``：stderr 排空**慢一拍**（模拟排空线程还没收尾的竞态）；
    - ``hang_spawns``：哪几次 spawn 的进程**不退出**（``wait(timeout=…)`` 超时），
      下标从 0 起（同一用例里的第几次 spawn）。
    """

    def __init__(self) -> None:
        self.spawned: list[list[str]] = []
        self.execs: list[list[str]] = []
        self.processes: list[FakeProcess] = []
        self.responses: list[tuple[int, bytes, str]] = []
        self.default_response: tuple[int, bytes, str] = (0, b"", "")
        self.stdin_max_write: int | None = None
        self.stderr_delay: float = 0.0
        self.hang_spawns: set[int] = set()

    def queue(
        self, returncode: int = 0, stdout: bytes = b"", stderr: str = ""
    ) -> None:
        """给下一次 exec 安排一份响应。"""
        self.responses.append((returncode, stdout, stderr))

    def spawn_stream(self, argv: list[str] | tuple[str, ...]) -> FakeProcess:
        argv = [str(item) for item in argv]
        self.spawned.append(argv)
        if self.responses:
            returncode, stdout, stderr = self.responses.pop(0)
        else:
            returncode, stdout, stderr = self.default_response
        # 容器内 stderr 是字节：用例里习惯写文本，这里统一编成 UTF-8
        stderr_bytes = stderr.encode() if isinstance(stderr, str) else stderr
        process = FakeProcess(
            stdout,
            stderr_bytes,
            returncode,
            hang=len(self.processes) in self.hang_spawns,
            stdin_max_write=self.stdin_max_write,
        )
        if self.stderr_delay:
            process.stderr = SlowDrainStream(stderr_bytes, self.stderr_delay)
        self.processes.append(process)
        return process

    def spawn_blocking(self, argv: list[str] | tuple[str, ...]) -> FakeProcess:
        """挂住的 exec（stdout 读不回来）：测超时看门狗。"""
        argv = [str(item) for item in argv]
        self.spawned.append(argv)
        process = BlockingProcess()
        self.processes.append(process)
        return process

    def spawn_racy(self, argv: list[str] | tuple[str, ...]) -> FakeProcess:
        """挂住且**会被关流打断**的 exec：测看门狗关泵与主线程读的跨线程竞态。"""
        argv = [str(item) for item in argv]
        self.spawned.append(argv)
        process = FakeProcess()
        process.stdout = RacyStream()
        self.processes.append(process)
        return process

    def exec_in_container(
        self,
        name: str,
        argv: list[str] | tuple[str, ...],
        *,
        check: bool = False,
        timeout: int = 120,
    ) -> CommandResult:
        """非交互 exec（平台侧清理临时文件走这条）。"""
        items = [str(item) for item in argv]
        self.execs.append(["exec", name, *items])
        return CommandResult(tuple(items), 0, "", "")


class FakeService:
    """假沙箱服务：只提供取元数据与守护进程入口。"""

    def __init__(self, daemon: FakeDaemon) -> None:
        self.daemon = daemon
        self.container_name = CONTAINER

    def get(self, name: str) -> object:
        if name != "demo":
            raise NotFoundError(f"沙箱不存在：{name}")
        return type("Meta", (), {"container_name": self.container_name})()

    def daemon_for(self, name: str) -> FakeDaemon:
        return self.daemon


# ---------------------------------------------------------------- 夹具
@pytest.fixture
def daemon() -> FakeDaemon:
    """假守护进程。"""
    return FakeDaemon()


@pytest.fixture
def manager(daemon: FakeDaemon) -> FileTransferManager:
    """传输编排入口（沙箱侧能力走假实现）。"""
    return FileTransferManager(service=FakeService(daemon))  # type: ignore[arg-type]


def _upload_argv(daemon: FakeDaemon) -> list[str]:
    """取最后一次 exec 的 argv（上传那次）。"""
    return daemon.spawned[-1]


# ---------------------------------------------------------------- 路径校验
def test_relative_path_is_rejected(manager: FileTransferManager) -> None:
    """容器内路径必须绝对路径：相对路径直接拒绝（固定中文文案）。"""
    with pytest.raises(TransferError) as excinfo:
        manager.probe("demo", "workspace/a.txt")
    assert str(excinfo.value).startswith(MSG_PATH_NOT_ABSOLUTE)
    assert excinfo.value.reason == "invalid_path"


def test_empty_path_is_rejected(manager: FileTransferManager) -> None:
    """空路径直接拒绝。"""
    with pytest.raises(TransferError) as excinfo:
        manager.probe("demo", "")
    assert str(excinfo.value) == MSG_PATH_EMPTY


def test_path_with_nul_is_rejected(manager: FileTransferManager) -> None:
    """含 NUL 的路径直接拒绝（NUL 没法作为 argv 传给容器内命令）。"""
    with pytest.raises(TransferError) as excinfo:
        manager.probe("demo", "/workspace/a\x00b.txt")
    assert str(excinfo.value) == MSG_PATH_HAS_NUL


def test_invalid_path_never_reaches_the_container(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """非法路径**不落任何容器内副作用**（一条 exec 都不起）。"""
    for bad in ("", "relative/path", "/a\x00b"):
        with pytest.raises(TransferError):
            manager.upload("demo", bad, [b"x"])
    assert daemon.spawned == []


def test_path_validation_accepts_absolute_paths() -> None:
    """绝对路径通过校验（原样返回）。"""
    assert validate_container_path("/workspace/a.txt") == "/workspace/a.txt"
    assert validate_container_path("/workspace/子目录/名 字.txt") == (
        "/workspace/子目录/名 字.txt"
    )


# ---------------------------------------------------------------- 探测
def test_probe_distinguishes_the_four_branches(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """分层探测：不存在 / 目录 / 普通文件（附大小）/ 特殊文件可区分。"""
    daemon.queue(0, b"missing\n")
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"file\t1048576\t1794196233\n")
    daemon.queue(0, b"fifo\n")

    assert manager.probe("demo", "/workspace/nope").kind == KIND_MISSING
    assert manager.probe("demo", "/workspace/dir").kind == KIND_DIR
    regular = manager.probe("demo", "/workspace/a.bin")
    assert regular.kind == KIND_FILE
    assert regular.size == 1048576
    assert regular.mtime == 1794196233
    assert manager.probe("demo", "/workspace/pipe").kind == KIND_FIFO


@pytest.mark.parametrize(
    ("token", "kind"),
    [
        (b"missing\n", KIND_MISSING),
        (b"dir\n", KIND_DIR),
        (b"file\t0\t1\n", KIND_FILE),
        (b"fifo\n", KIND_FIFO),
        (b"chardev\n", KIND_CHARDEV),
        (b"blockdev\n", KIND_BLOCKDEV),
        (b"socket\n", KIND_SOCKET),
        (b"symlink\n", KIND_SYMLINK),
        (b"special\n", KIND_SPECIAL),
    ],
)
def test_probe_maps_every_layer_to_a_distinct_kind(
    manager: FileTransferManager,
    daemon: FakeDaemon,
    token: bytes,
    kind: str,
) -> None:
    """分层探测的九个分支各自对应一个类型（不与「不存在」混淆）。"""
    daemon.queue(0, token)
    assert manager.probe("demo", "/workspace/x").kind == kind


def test_probe_rejects_unparsable_output(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """探测输出认不出（空 / 未知类型标记）：给固定兜底文案，不抛解析异常。"""
    for payload in (b"", b"\n", b"wat\n"):
        daemon.queue(0, payload)
        with pytest.raises(TransferError) as excinfo:
            manager.probe("demo", "/workspace/x")
        assert str(excinfo.value).startswith(MSG_EXEC_FAILED)
        assert excinfo.value.reason == REASON_EXEC_FAILED


def test_probe_passes_path_as_positional_argument(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """探测路径**argv 直传**：作为 ``"$1"`` 位置参数，不拼进脚本文本。"""
    daemon.queue(0, b"missing\n")
    manager.probe("demo", "/workspace/edge/a\nb.txt")
    argv = daemon.spawned[-1]
    assert argv[:6] == ["docker", "exec", CONTAINER, "sh", "-c", PROBE_SCRIPT]
    assert argv[6] == "sh"
    assert argv[7] == "/workspace/edge/a\nb.txt"
    assert "/workspace/edge/a" not in PROBE_SCRIPT


def test_probe_script_keeps_the_special_file_branches() -> None:
    """探测脚本保留 FIFO / 字符设备 / 块设备 / 套接字 / 其他特殊文件的分支。

    PRD 草案的「-d / -f / else missing」把特殊文件与「不存在」混在一起，
    达不到「管道 / 设备可区分」的目的（FIFO 会挂死 ``cat``）。
    """
    for branch in ("-p", "-c", "-b", "-S", "-e"):
        assert branch in PROBE_SCRIPT
    assert "stat -L -c" in PROBE_SCRIPT


def test_probe_script_structure_is_pinned() -> None:
    """探测脚本的**结构**钉死（不是「常量跟自己比」）。

    - 路径**只经 ``"$1"`` 位置参数**进入（不拼进脚本文本）；
    - 分层判定的**顺序**固定：目录 → 普通文件 → FIFO → 字符设备 → 块设备 →
      套接字 → 符号链接 → 其他特殊文件 → 兜底「不存在」；
    - 大小取 ``stat -L -c``（O(1)），``wc -c < "$1"`` 兜底；
    - 不用 GNU-only 的 ``find -printf``，也不用没有 ``read -d`` 的写法。
    """
    assert '"$1"' in PROBE_SCRIPT
    # 分层判定的顺序（``[ -X "$1" ]`` 的先后）
    branches = ("-d", "-f", "-p", "-c", "-b", "-S", "-L", "-e")
    positions = [PROBE_SCRIPT.index(f'[ {branch} "$1"') for branch in branches]
    assert positions == sorted(positions)
    # 兜底分支在最后
    assert PROBE_SCRIPT.rindex("missing") > positions[-1]
    # 大小：stat 优先，wc 兜底
    assert "stat -L -c" in PROBE_SCRIPT
    assert 'wc -c < "$1"' in PROBE_SCRIPT
    # 禁用的写法
    assert "-printf" not in PROBE_SCRIPT
    assert "read -d" not in PROBE_SCRIPT


def test_probe_failure_is_classified_by_stderr(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """探测命令失败：按 stderr 关键词归类，不按退出码。"""
    daemon.queue(1, b"", "sh: 1: cannot create /x: Directory nonexistent")
    with pytest.raises(TransferError) as excinfo:
        manager.probe("demo", "/x")
    assert excinfo.value.reason == REASON_PARENT_MISSING


def test_exec_timeout_is_reported_by_the_watchdog(
    manager: FileTransferManager, daemon: FakeDaemon, monkeypatch: pytest.MonkeyPatch
) -> None:
    """容器内命令挂住：看门狗到点关泵，报「命令执行超时」。"""
    monkeypatch.setattr(transfer_module, "EXEC_TIMEOUT", 0.2)
    daemon.spawn_stream = daemon.spawn_blocking  # type: ignore[method-assign]
    with pytest.raises(TransferError) as excinfo:
        manager.probe("demo", "/workspace/a.bin")
    assert str(excinfo.value).startswith(MSG_EXEC_TIMEOUT)
    assert excinfo.value.reason == REASON_EXEC_FAILED


def test_exec_timeout_survives_the_watchdog_close_race(
    manager: FileTransferManager, daemon: FakeDaemon, monkeypatch: pytest.MonkeyPatch
) -> None:
    """看门狗关泵与主线程读 stdout 是**跨线程竞态**：不能漏出裸 ``ValueError``。

    看门狗线程 ``pump.close()`` 关掉 stdout，主线程阻塞在 ``pump.read()`` 上就
    可能撞上 ``ValueError: read of closed file``——那不是 ``TransferError`` 形态，
    会一路漏给调用方。应当收口成「命令执行超时」。
    """
    monkeypatch.setattr(transfer_module, "EXEC_TIMEOUT", 0.2)
    daemon.spawn_stream = daemon.spawn_racy  # type: ignore[method-assign]
    with pytest.raises(TransferError) as excinfo:
        manager.probe("demo", "/workspace/a.bin")
    assert str(excinfo.value).startswith(MSG_EXEC_TIMEOUT)
    assert excinfo.value.reason == REASON_EXEC_FAILED


# ---------------------------------------------------------------- 上传
def test_upload_writes_bytes_and_counts_them(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """上传：字节块写进容器，返回写入的字节数。"""
    daemon.queue(0, b"dir\n")  # 父目录探测
    daemon.queue(0, b"missing\n")  # 目标探测
    daemon.queue(0)  # 写入

    written = manager.upload("demo", "/workspace/a.bin", [b"hello", b"", b" world"])
    assert written == 11
    assert daemon.processes[-1].stdin.buffer == b"hello world"


def test_upload_overwrites_an_existing_file(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """目标已存在 = 覆盖：目标是普通文件时不报错，直接写。"""
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"file\t3\t1\n")  # 目标已存在（普通文件）
    daemon.queue(0)

    assert manager.upload("demo", "/workspace/a.bin", [b"new"]) == 3
    assert daemon.processes[-1].stdin.buffer == b"new"


def test_upload_rejects_a_parent_that_is_not_a_directory(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """父路径是普通文件（不是目录）→ 前置拒绝（固定中文文案）。"""
    daemon.queue(0, b"file\t3\t1\n")
    with pytest.raises(TransferError) as excinfo:
        manager.upload("demo", "/workspace/a.bin/x.txt", [b"x"])
    assert str(excinfo.value).startswith(MSG_PARENT_NOT_DIRECTORY)
    assert excinfo.value.reason == REASON_PARENT_NOT_DIRECTORY
    assert len(daemon.spawned) == 1


def test_upload_write_interruption_is_classified_by_stderr(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """容器内 ``cat`` 先失败时，宿主侧写入会断：**先按 stderr 归类**。

    父目录不可写 / 只读挂载 / 父目录缺失三类失败在真机上表现为
    ``cat > 临时名`` 报错（容器进程退出）→ 宿主侧写入抛 ``BrokenPipeError``。
    不能一律当「写入中断」，否则三类失败的固定文案全被吞掉。
    """
    daemon.queue(0, b"dir\n")  # 父目录探测
    daemon.queue(0, b"missing\n")  # 目标探测
    daemon.queue(
        2,
        b"",
        "sh: 1: cannot create /workspace/.rtf-tmp-x: Permission denied",
    )

    def broken_chunks() -> object:
        yield b"x"
        raise OSError("宿主侧写入断了（BrokenPipeError）")

    with pytest.raises(TransferError) as excinfo:
        manager.upload("demo", "/workspace/a.bin", broken_chunks())  # type: ignore[arg-type]
    assert str(excinfo.value).startswith(MSG_PARENT_NOT_WRITABLE)
    assert excinfo.value.reason == REASON_PARENT_NOT_WRITABLE
    # 失败路径照旧清理临时文件
    assert len(daemon.execs) == 1


def test_upload_write_interruption_without_stderr_is_a_write_failure(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """写入断了且容器没有 stderr（例如 exec 被强杀）：归为「写入中断」。"""
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"missing\n")
    daemon.queue(0)

    def broken_chunks() -> object:
        yield b"x"
        raise OSError("宿主侧写入断了")

    with pytest.raises(TransferError) as excinfo:
        manager.upload("demo", "/workspace/a.bin", broken_chunks())  # type: ignore[arg-type]
    assert str(excinfo.value).startswith(MSG_WRITE_FAILED)
    assert excinfo.value.reason == REASON_WRITE_FAILED
    assert len(daemon.execs) == 1


def test_upload_re_raises_non_io_failures_after_cleanup(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """非 IO 类异常（调用方自己的错）原样抛出，但临时文件仍要清掉。"""
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"missing\n")
    daemon.queue(0)

    def broken_chunks() -> object:
        yield b"x"
        raise ValueError("调用方流坏了")

    with pytest.raises(ValueError):
        manager.upload("demo", "/workspace/a.bin", broken_chunks())  # type: ignore[arg-type]
    assert len(daemon.execs) == 1


def test_upload_success_leaves_no_cleanup_and_unique_temp_names(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """成功路径不跑 ``rm``；两次上传的临时名不同（不互相踩）。"""
    for _ in range(2):
        daemon.queue(0, b"dir\n")
        daemon.queue(0, b"missing\n")
        daemon.queue(0)
        manager.upload("demo", "/workspace/a.bin", [b"x"])
    temps = [
        argv[-2]
        for argv in daemon.spawned
        if UPLOAD_SCRIPT in argv and argv[-1] == "/workspace/a.bin"
    ]
    assert len(temps) == 2
    assert temps[0] != temps[1]
    assert daemon.execs == []


def test_upload_rejects_a_directory_target(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """目标是**已存在目录** → 前置拒绝（实测 mv 对目录目标 rc=0 假成功）。"""
    daemon.queue(0, b"dir\n")  # 父目录
    daemon.queue(0, b"dir\n")  # 目标也是目录

    with pytest.raises(TransferError) as excinfo:
        manager.upload("demo", "/workspace/dir", [b"x"])
    assert str(excinfo.value).startswith(MSG_TARGET_IS_DIR)
    assert excinfo.value.reason == REASON_TARGET_IS_DIR
    # 只起了两次探测，**没有**起写入 exec
    assert len(daemon.spawned) == 2


def test_upload_rejects_a_missing_parent_directory(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """父目录缺失 → 报错引导（平台**不主动创建**父目录）。"""
    daemon.queue(0, b"missing\n")
    with pytest.raises(TransferError) as excinfo:
        manager.upload("demo", "/workspace/no-such-dir/a.bin", [b"x"])
    assert str(excinfo.value).startswith(MSG_PARENT_MISSING)
    assert excinfo.value.reason == REASON_PARENT_MISSING
    assert len(daemon.spawned) == 1


def test_upload_never_creates_the_parent_directory(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """上传链路里**没有 mkdir**：父目录缺失只报错，不代建。"""
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"missing\n")
    daemon.queue(0)
    manager.upload("demo", "/workspace/a.bin", [b"x"])
    for argv in daemon.spawned:
        assert "mkdir" not in argv


def test_upload_temp_name_sits_in_the_target_directory(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """临时名**与目标同目录**：跨设备 mv 是 copy + unlink，非原子。"""
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"missing\n")
    daemon.queue(0)
    manager.upload("demo", "/workspace/sub/a.bin", [b"x"])
    argv = _upload_argv(daemon)
    temp, target = argv[-2], argv[-1]
    assert target == "/workspace/sub/a.bin"
    assert posixpath.dirname(temp) == posixpath.dirname(target)
    assert posixpath.basename(temp).startswith(TEMP_PREFIX)


def test_upload_temp_name_uses_a_long_random_segment(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """临时名随机段**至少 16 位十六进制**（64 bit）：撞名意味着写错文件。"""
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"missing\n")
    daemon.queue(0)
    manager.upload("demo", "/workspace/a.bin", [b"x"])
    temp = _upload_argv(daemon)[-2]
    random_part = posixpath.basename(temp)[len(TEMP_PREFIX) :]
    pid_part, _, hex_part = random_part.partition("-")
    assert pid_part  # 进程号段
    assert len(hex_part) >= 16
    assert all(char in "0123456789abcdef" for char in hex_part)


def test_upload_loops_over_short_writes(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """裸管道**短写**（一次 ``write`` 写不满）：写入循环补齐，字节顺序不变。"""
    daemon.stdin_max_write = 3
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"missing\n")
    daemon.queue(0)

    payload = bytes(range(256)) * 4
    written = manager.upload("demo", "/workspace/a.bin", [payload])
    assert written == len(payload)
    assert daemon.processes[-1].stdin.buffer == payload


def test_upload_timeout_is_reported_as_exec_timeout(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """容器内的 ``cat`` + ``mv`` 不退：等退出码超时 → 报「命令执行超时」。"""
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"missing\n")
    daemon.hang_spawns = {2}  # 写入 exec（第 3 次 spawn）不退出

    with pytest.raises(TransferError) as excinfo:
        manager.upload("demo", "/workspace/a.bin", [b"x"])
    assert str(excinfo.value).startswith(MSG_EXEC_TIMEOUT)
    assert excinfo.value.reason == REASON_EXEC_FAILED


def test_upload_temp_name_collision_is_classified_and_not_removed(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """noclobber 撞名（临时名已存在）：按**既有错误路径**收口，且**不删**那个路径。

    撞名的那个路径**不是我们建的**（可能是别人放的符号链接或文件）——平台没有
    资格替用户删。也不重试：字节流是流式的，已写出去的字节无法重放。
    """
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"missing\n")
    daemon.queue(2, b"", "sh: 1: cannot create /workspace/.rtf-tmp-x: File exists")

    with pytest.raises(TransferError) as excinfo:
        manager.upload("demo", "/workspace/a.bin", [b"x"])
    assert excinfo.value.reason == REASON_TEMP_NAME_EXISTS
    assert str(excinfo.value).startswith(MSG_TEMP_NAME_EXISTS)
    assert daemon.execs == []


def test_upload_script_structure_is_pinned() -> None:
    """上传脚本的**结构**钉死（不是「常量跟自己比」）。

    ``set -C``（noclobber 走 O_EXCL，挡符号链接写穿）**必须先于**写入；
    ``cat > "$1"`` 与 ``mv "$1" "$2"`` 经位置参数拿路径，不拼进脚本文本；
    **字节数核对夹在写入与 ``mv`` 之间**（03 轮真机实测的缺陷：客户端中断上传
    ⇒ 容器内 ``cat`` 收到**干净 EOF**、rc=0 ⇒ 无条件 ``mv`` ⇒ 目标留下半截文件）。
    """
    assert "set -C" in UPLOAD_SCRIPT
    assert 'cat > "$1"' in UPLOAD_SCRIPT
    assert 'mv "$1" "$2"' in UPLOAD_SCRIPT
    # noclobber 先于写入（否则不起作用）
    assert UPLOAD_SCRIPT.index("set -C") < UPLOAD_SCRIPT.index('cat > "$1"')
    # 写入失败就不 mv（不拿半截文件去覆盖目标）
    assert UPLOAD_SCRIPT.index('cat > "$1"') < UPLOAD_SCRIPT.index('mv "$1" "$2"')
    assert "&&" not in UPLOAD_SCRIPT
    # **字节数核对在写入之后、mv 之前**（核对不过就不 mv）
    assert UPLOAD_SCRIPT.index('cat > "$1"') < UPLOAD_SCRIPT.index('wc -c < "$1"')
    assert UPLOAD_SCRIPT.index('wc -c < "$1"') < UPLOAD_SCRIPT.index('mv "$1" "$2"')
    # 不符 ⇒ 删临时名 + 打标记 + 非零退出
    assert 'rm -f -- "$1"' in UPLOAD_SCRIPT
    assert "size mismatch" in UPLOAD_SCRIPT
    assert "exit 1" in UPLOAD_SCRIPT
    # 期望字节数走位置参数 "$3"（**可选**：不给就跳过核对）
    assert '"$3"' in UPLOAD_SCRIPT
    assert '[ -n "$3" ]' in UPLOAD_SCRIPT
    # 路径只经位置参数进入
    assert "$1" in UPLOAD_SCRIPT and "$2" in UPLOAD_SCRIPT


def test_upload_passes_paths_as_argv_not_shell_text(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """路径**argv 直传**：含换行 / 引号的路径不会被 shell 拆碎。"""
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"missing\n")
    daemon.queue(0)
    tricky = "/workspace/edge/a\nb'c\".txt"
    manager.upload("demo", tricky, [b"x"])
    argv = _upload_argv(daemon)
    assert argv[-1] == tricky
    assert argv[-2] not in (tricky,)
    # 脚本文本是固定的：路径没被拼进去
    assert argv[argv.index("-c") + 1] == UPLOAD_SCRIPT
    assert tricky not in UPLOAD_SCRIPT


# ---------------------------------------------------------------- 上传：字节数核对
def test_upload_passes_the_expected_size_as_argv(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """期望字节数**argv 直传**（脚本的 ``"$3"`` 位置参数），不拼进脚本文本。"""
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"missing\n")
    daemon.queue(0)

    manager.upload("demo", "/workspace/a.bin", [b"hello"], expected_bytes=5)
    argv = _upload_argv(daemon)
    assert argv[-1] == "5"
    assert argv[-2] == "/workspace/a.bin"
    assert posixpath.basename(argv[-3]).startswith(TEMP_PREFIX)
    # 脚本文本是固定的：期望值没被拼进去
    assert argv[argv.index("-c") + 1] == UPLOAD_SCRIPT
    assert "5" not in UPLOAD_SCRIPT


def test_upload_without_expected_size_passes_no_check_argument(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """``expected_bytes=None`` ⇒ argv **不带校验参数**，行为与修复前一致。

    argv 形状：``docker exec -i <容器> sh -c <脚本> sh <临时名> <目标>``——共 10 个
    元素（多了期望字节数就变成 11 个）。
    """
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"missing\n")
    daemon.queue(0)

    manager.upload("demo", "/workspace/a.bin", [b"hello"])
    argv = _upload_argv(daemon)
    assert len(argv) == 10
    assert argv[-1] == "/workspace/a.bin"
    assert posixpath.basename(argv[-2]).startswith(TEMP_PREFIX)


def test_upload_with_a_matching_expected_size_moves_the_file(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """期望字节数**相符** ⇒ 正常 ``mv``（不报错、不清理临时文件）。"""
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"missing\n")
    daemon.queue(0)

    written = manager.upload("demo", "/workspace/a.bin", [b"hello"], expected_bytes=5)
    assert written == 5
    # 成功路径不跑 ``rm``
    assert daemon.execs == []
    assert _upload_argv(daemon)[-1] == "5"


def test_upload_size_mismatch_is_classified_and_cleans_the_temp_file(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """字节数不符 ⇒ 分类码 + 固定中文文案 + **临时名被清**。

    容器内脚本的处置：删临时名 + 打 ``size mismatch`` 标记 + 非零退出 ⇒
    **不执行 ``mv``** ⇒ **目标路径原样不动**（不会把半截内容覆盖上去）。
    """
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"missing\n")
    daemon.queue(1, b"", "rtf upload: size mismatch (expected 100, actual 40)")

    with pytest.raises(TransferError) as excinfo:
        manager.upload("demo", "/workspace/a.bin", [b"x" * 40], expected_bytes=100)
    assert excinfo.value.reason == REASON_SIZE_MISMATCH
    assert str(excinfo.value).startswith(MSG_SIZE_MISMATCH)
    # 文案指向用户的目标路径，不回显 stderr 原文与临时名
    assert "/workspace/a.bin" in str(excinfo.value)
    assert ".rtf-tmp-" not in str(excinfo.value)
    assert "size mismatch" not in str(excinfo.value)
    # 临时名被清（平台侧兜底 ``rm``，argv 直传）
    assert len(daemon.execs) == 1
    cleanup = daemon.execs[0]
    assert cleanup[:3] == ["exec", CONTAINER, "rm"]
    assert cleanup[-1] == _upload_argv(daemon)[-3]


def test_upload_size_mismatch_is_classified_even_on_the_interruption_path(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """中断路径上也按 stderr 归类：容器内的 ``size mismatch`` 标记优先。

    客户端中断上传 ⇒ 宿主侧关 stdin ⇒ 容器内 ``cat`` 收到干净 EOF ⇒ 字节数
    不符 ⇒ 打标记。宿主侧同时可能抛出写入异常——**先按 stderr 归类**
    （与既有的「容器内先失败」口径一致），不把分类码丢掉。
    """
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"missing\n")
    daemon.queue(1, b"", "rtf upload: size mismatch (expected 100, actual 40)")

    def broken_chunks() -> object:
        yield b"x" * 40
        raise OSError("宿主侧写入断了")

    with pytest.raises(TransferError) as excinfo:
        manager.upload(
            "demo", "/workspace/a.bin", broken_chunks(), expected_bytes=100
        )  # type: ignore[arg-type]
    assert excinfo.value.reason == REASON_SIZE_MISMATCH
    assert str(excinfo.value).startswith(MSG_SIZE_MISMATCH)
    assert len(daemon.execs) == 1


def test_upload_rejects_an_invalid_expected_size(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """期望字节数非法（负数 / 非整数）⇒ 固定文案 + 分类码，**不落容器内副作用**。"""
    for bad in (-1, "abc", 1.5):
        with pytest.raises(TransferError) as excinfo:
            manager.upload("demo", "/workspace/a.bin", [b"x"], expected_bytes=bad)  # type: ignore[arg-type]
        assert excinfo.value.reason == REASON_INVALID_SIZE
        assert str(excinfo.value).startswith(MSG_INVALID_SIZE)
    assert daemon.spawned == []


def test_upload_without_expected_size_keeps_the_previous_behaviour(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """``expected_bytes=None`` ⇒ **不核对字节数**（保留现状行为）。

    残余风险（写进 docstring）：没有长度信息的中断**仍可能在目标留下半截文件**
    （客户端中断 ⇒ 宿主关 stdin ⇒ 容器内 ``cat`` 收到干净 EOF、rc=0 ⇒
    ``mv`` 照常执行）。这条用例把「**不给就不核对**」钉死。
    """
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"missing\n")
    daemon.queue(0)  # 容器内不报错（修复前：字节数不符也照样 mv）

    written = manager.upload("demo", "/workspace/a.bin", [b"hello"])
    assert written == 5
    assert daemon.execs == []


def test_upload_failure_cleans_the_temp_file(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """写入失败 → **平台侧显式清理临时文件**（``cat`` 不会自清理）。"""
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"missing\n")
    daemon.queue(
        2,
        b"",
        "sh: 1: cannot create /workspace/no-such-dir/.rtf-tmp-e126b54a93fa: "
        "Directory nonexistent",
    )
    with pytest.raises(TransferError) as excinfo:
        manager.upload("demo", "/workspace/no-such-dir/a.bin", [b"x"])
    assert excinfo.value.reason == REASON_PARENT_MISSING
    # 清理命令同样是 argv 直传
    assert len(daemon.execs) == 1
    cleanup = daemon.execs[0]
    assert cleanup[:3] == ["exec", CONTAINER, "rm"]
    assert cleanup[3] == "-f"
    temp = _upload_argv(daemon)[-2]
    assert cleanup[-1] == temp


def test_upload_error_message_uses_the_target_path_not_the_temp_name(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """报错文案指向**用户的目标路径**，不回显容器内的临时名与 stderr 原文。"""
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"missing\n")
    daemon.queue(
        2,
        b"",
        "sh: 1: cannot create /workspace/no-such-dir/.rtf-tmp-e126b54a93fa: "
        "Directory nonexistent",
    )
    with pytest.raises(TransferError) as excinfo:
        manager.upload("demo", "/workspace/no-such-dir/a.bin", [b"x"])
    message = str(excinfo.value)
    assert message.startswith(MSG_PARENT_MISSING)
    assert "/workspace/no-such-dir/a.bin" in message
    assert ".rtf-tmp-" not in message
    assert "Directory nonexistent" not in message


@pytest.mark.parametrize(
    ("stderr", "reason", "message"),
    [
        # 父目录缺失：dash 与 busybox 措辞不同、退出码也不同（只按关键词分类）
        (
            "sh: 1: cannot create /workspace/no-such-dir/.rtf-tmp-x: "
            "Directory nonexistent",
            REASON_PARENT_MISSING,
            MSG_PARENT_MISSING,
        ),
        (
            "sh: can't create '/workspace/no-such-dir/.rtf-tmp-x': "
            "nonexistent directory",
            REASON_PARENT_MISSING,
            MSG_PARENT_MISSING,
        ),
        # 父目录不可写（EACCES）
        (
            "sh: 1: cannot create /workspace/.rtf-tmp-x: Permission denied",
            REASON_PARENT_NOT_WRITABLE,
            MSG_PARENT_NOT_WRITABLE,
        ),
        # 只读挂载（EROFS）
        (
            "sh: 1: cannot create /ro/.rtf-tmp-x: Read-only file system",
            REASON_READONLY,
            MSG_READONLY_FS,
        ),
        # 目录：GNU 与 busybox 措辞不同
        ("cat: /workspace: Is a directory", REASON_TARGET_IS_DIR, MSG_IS_DIRECTORY),
        ("cat: read error: Is a directory", REASON_TARGET_IS_DIR, MSG_IS_DIRECTORY),
        # 不存在：GNU 与 busybox 措辞不同
        (
            "cat: /workspace/nope.bin: No such file or directory",
            REASON_NOT_FOUND,
            MSG_NOT_FOUND,
        ),
        (
            "cat: can't open '/nope': No such file or directory",
            REASON_NOT_FOUND,
            MSG_NOT_FOUND,
        ),
        # noclobber 撞名（临时名已存在）：dash 与 busybox 措辞不同
        (
            "sh: 1: cannot create /workspace/.rtf-tmp-x: File exists",
            REASON_TEMP_NAME_EXISTS,
            MSG_TEMP_NAME_EXISTS,
        ),
        (
            "sh: can't create '/workspace/.rtf-tmp-x': File exists",
            REASON_TEMP_NAME_EXISTS,
            MSG_TEMP_NAME_EXISTS,
        ),
        # 字节数不符（**平台自己打的标记**，任何镜像上措辞都一样）
        (
            "rtf upload: size mismatch (expected 262144000, actual 189726720)",
            REASON_SIZE_MISMATCH,
            MSG_SIZE_MISMATCH,
        ),
    ],
)
def test_error_classification_only_uses_stderr_keywords(
    stderr: str, reason: str, message: str
) -> None:
    """错误分类**只按 stderr 关键词子串**：不按整句、不按退出码。"""
    error = classify_stderr(stderr, "/workspace/a.bin")
    assert error.reason == reason
    assert str(error).startswith(message)
    # stderr 原文只进日志，不进错误文案
    assert stderr not in str(error)


def test_unknown_stderr_falls_back_to_a_fixed_message() -> None:
    """认不出的 stderr：给固定兜底文案（不回显原文）。"""
    error = classify_stderr("docker: something went sideways", "/workspace/a.bin")
    assert str(error).startswith("容器内命令执行失败")
    assert "something went sideways" not in str(error)


@pytest.mark.parametrize(
    "stderr",
    [
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. "
        "Is the docker daemon running?",
        "permission denied while trying to connect to the Docker daemon socket "
        "at unix:///var/run/docker.sock",
        "error during connect: Get "
        '"http://%2Fvar%2Frun%2Fdocker.sock/v1.47/containers/x/json": '
        "dial unix /var/run/docker.sock: connect: permission denied",
    ],
)
def test_docker_daemon_failures_are_not_misread_as_directory_errors(
    stderr: str,
) -> None:
    """宿主/守护进程侧失败**不能**被当成「目标目录不可写」。

    ``permission denied while trying to connect to the Docker daemon socket``
    里也带 permission denied——按容器内的关键词归类会把宿主侧故障误报成
    「目录不可写」（分类码与文案全错，还把排查方向带偏）。
    """
    error = classify_stderr(stderr, "/workspace/a.bin")
    assert error.reason == REASON_DAEMON_UNREACHABLE
    assert str(error).startswith(MSG_DAEMON_UNREACHABLE)
    assert stderr not in str(error)


# ---------------------------------------------------------------- 下载
def test_download_starts_a_cat_pump(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """下载：前置探测放行普通文件后起 ``cat -- <path>`` 字节泵。"""
    daemon.queue(0, b"file\t5\t1\n")
    daemon.queue(0, b"hello")
    stream = manager.download("demo", "/workspace/a.bin")
    assert isinstance(stream, DownloadStream)
    assert stream.size == 5
    argv = daemon.spawned[-1]
    assert argv == ["docker", "exec", "-i", CONTAINER, "cat", "--", "/workspace/a.bin"]
    assert stream.read() == b"hello"
    stream.close()


def test_download_rejects_a_directory(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """下载目录 → 拒绝（明确文案）。"""
    daemon.queue(0, b"dir\n")
    with pytest.raises(TransferError) as excinfo:
        manager.download("demo", "/workspace")
    assert str(excinfo.value).startswith(MSG_IS_DIRECTORY)


def test_download_rejects_special_files(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """下载 FIFO / 设备 / 套接字 → 拒绝（防挂死 exec、防静默空下载）。"""
    for token in ("fifo\n", "chardev\n", "blockdev\n", "socket\n", "special\n"):
        daemon.queue(0, token.encode())
        with pytest.raises(TransferError) as excinfo:
            manager.download("demo", "/workspace/weird")
        assert str(excinfo.value).startswith(MSG_NOT_REGULAR)
        assert excinfo.value.reason == REASON_NOT_REGULAR
    # 只起了探测 exec，**没有**起 cat
    assert len(daemon.spawned) == 5


def test_download_rejects_a_symlink_that_does_not_resolve(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """悬空符号链接（``-L`` 分支）：不是普通文件，拒。"""
    daemon.queue(0, b"symlink\n")
    with pytest.raises(TransferError) as excinfo:
        manager.download("demo", "/workspace/dangling")
    assert excinfo.value.reason == REASON_NOT_REGULAR
    assert len(daemon.spawned) == 1


def test_invalid_paths_never_start_a_pump(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """下载 / 列表的非法路径同样**不落任何容器内副作用**。"""
    for bad in ("", "relative", "/a\x00b"):
        with pytest.raises(TransferError):
            manager.download("demo", bad)
        with pytest.raises(TransferError):
            manager.list("demo", bad)
    assert daemon.spawned == []


def test_download_reports_a_missing_file(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """下载不存在的路径 → 报「文件不存在」。"""
    daemon.queue(0, b"missing\n")
    with pytest.raises(TransferError) as excinfo:
        manager.download("demo", "/workspace/nope.bin")
    assert str(excinfo.value).startswith(MSG_NOT_FOUND)
    assert excinfo.value.reason == REASON_NOT_FOUND


def test_download_stream_reports_the_exec_failure(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """``cat`` 失败（原因只在 stderr 里）：读完流后能分类抛出。"""
    daemon.queue(0, b"file\t5\t1\n")
    daemon.queue(1, b"", "cat: /workspace/a.bin: No such file or directory")
    stream = manager.download("demo", "/workspace/a.bin")
    assert stream.read() == b""
    with pytest.raises(TransferError) as excinfo:
        stream.raise_for_status()
    assert excinfo.value.reason == REASON_NOT_FOUND
    stream.close()


def test_download_failure_waits_for_the_stderr_drain(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """stdout 的 EOF 与 stderr 排空线程**几乎同时**发生：尾部要等一下再取。

    不等就可能拿到**空尾部**——失败被降级成通用文案，``not_found`` 分类码丢失
    （服务端据此映射 HTTP 状态码，丢了就映射错）。本用例用「慢一拍」的假
    stderr 流把这个竞态**钉死**（不依赖排空线程恰好已经跑完）。
    """
    daemon.queue(0, b"file\t5\t1\n")
    daemon.stderr_delay = 0.2
    daemon.queue(1, b"", "cat: /workspace/a.bin: No such file or directory")
    stream = manager.download("demo", "/workspace/a.bin")
    assert stream.read() == b""
    # 竞态前提：此刻排空线程还没收尾，尾部是空的
    assert stream.pump.stderr_tail == ""
    assert stream.pump.stderr_drain_alive is True
    with pytest.raises(TransferError) as excinfo:
        stream.raise_for_status()
    assert excinfo.value.reason == REASON_NOT_FOUND
    assert str(excinfo.value).startswith(MSG_NOT_FOUND)
    stream.close()


def test_download_status_gives_up_when_the_process_never_exits(
    manager: FileTransferManager, daemon: FakeDaemon, monkeypatch: pytest.MonkeyPatch
) -> None:
    """exec 一直没退：短等拿不到退出码 → **不给失败结论**（宁可放过，不误报）。"""
    monkeypatch.setattr(transfer_module, "DOWNLOAD_STATUS_TIMEOUT", 0.05)
    daemon.queue(0, b"file\t5\t1\n")
    daemon.hang_spawns = {1}  # cat 进程（第 2 次 spawn）不退出
    stream = manager.download("demo", "/workspace/a.bin")
    assert stream.read() == b""
    stream.raise_for_status()  # 不抛异常
    stream.close()


# ---------------------------------------------------------------- 列表
@pytest.mark.parametrize(
    ("name", "type_token", "kind"),
    [
        ("plain.txt", "f", KIND_FILE),
        ("with space.txt", "f", KIND_FILE),
        ("中文名称.txt", "f", KIND_FILE),
        ("with\nnewline.txt", "f", KIND_FILE),
        ("tab\tname.txt", "f", KIND_FILE),
        (".hidden", "f", KIND_FILE),
        ("-dash-start.txt", "f", KIND_FILE),
        ("quote'name.txt", "f", KIND_FILE),
        ('double"quote.txt', "f", KIND_FILE),
        ("back\\slash.txt", "f", KIND_FILE),
        ("$dollar", "f", KIND_FILE),
        ("`backtick`", "f", KIND_FILE),
        (";semicolon", "f", KIND_FILE),
        ("star*.txt", "f", KIND_FILE),
        ("subdir", "d", KIND_DIR),
    ],
)
def test_list_keeps_awkward_names(
    manager: FileTransferManager,
    daemon: FakeDaemon,
    name: str,
    type_token: str,
    kind: str,
) -> None:
    """列表解析：15 条刁钻名字**逐条保真**（ADR 0018 第 4 节的 15 项样本）。

    名字里的空格 / 中文 / 换行 / 制表符 / 引号 / 反斜杠 / ``$`` / 反引号 /
    分号 / 通配符 / ``-`` 开头 / 隐藏文件全部保真——记录以 NUL 结尾，解析只按
    前 3 个 TAB 切。
    """
    daemon.queue(0, b"dir\n")  # 前置判定：目标是目录
    daemon.queue(0, f"{type_token}\t0\t1794196233\t{name}\0".encode())
    entries = manager.list("demo", "/workspace")
    assert entries == [ListEntry(name, kind, 0, 1794196233)]


def test_list_marks_special_entries(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """列表里的特殊条目（FIFO 等）单独标记，不与普通文件混为一谈。"""
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"x\t0\t1794196233\tpipe\0")
    entries = manager.list("demo", "/workspace")
    assert entries[0].kind == KIND_SPECIAL


def test_list_uses_a_single_find_exec(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """列表：**find 单次 exec**、NUL 结尾记录、路径走位置参数。

    另有一次 ``-d`` 前置判定（探测 exec）：``find`` 对普通文件路径**静默返回
    空**，不前置判定就会把「列了一个文件」误读成「目录是空的」。
    """
    daemon.queue(0, b"dir\n")  # 前置判定
    daemon.queue(0, b"")
    manager.list("demo", "/workspace/edge\ndir")
    find_argvs = [argv for argv in daemon.spawned if LIST_SCRIPT in argv]
    assert len(find_argvs) == 1
    argv = find_argvs[0]
    assert argv[:6] == ["docker", "exec", CONTAINER, "sh", "-c", LIST_SCRIPT]
    assert argv[6] == "sh"
    assert argv[7] == "/workspace/edge\ndir"
    assert "-exec" in LIST_SCRIPT
    assert "\\0" in LIST_SCRIPT
    assert "-printf" not in LIST_SCRIPT
    assert "read -d" not in LIST_SCRIPT


def test_list_script_structure_is_pinned() -> None:
    """列表脚本的**结构**钉死（不是「常量跟自己比」）。

    - 路径**只经 ``"$1"`` 位置参数**进入（不拼进脚本文本）；
    - ``find`` 单次 exec 产出 **NUL 结尾**的记录（字段 TAB 分隔）；
    - 内层脚本用 ``${p##*/}`` 取名字、路径走 ``"$p"``；
    - 大小取 ``stat -L -c``（O(1)），不整文件读；
    - 不用 GNU-only 的 ``find -printf``，也不用没有 ``read -d`` 的写法。
    """
    assert 'find "$1" -maxdepth 1 -mindepth 1' in LIST_SCRIPT
    assert "-exec sh -c" in LIST_SCRIPT
    assert "\\0" in LIST_SCRIPT
    assert "${p##*/}" in LIST_SCRIPT
    assert '[ -d "$p" ]' in LIST_SCRIPT
    assert '[ -f "$p" ]' in LIST_SCRIPT
    assert "stat -L -c" in LIST_SCRIPT
    assert "-printf" not in LIST_SCRIPT
    assert "read -d" not in LIST_SCRIPT


def test_list_empty_directory_is_an_empty_list(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """空目录：脚本无输出（``-exec`` 不执行）→ 空列表，不抛异常。"""
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"")
    assert manager.list("demo", "/workspace/empty") == []


def test_list_skips_malformed_records(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """字段不全的记录跳过（不拖垮整批），其余条目照常返回。"""
    daemon.queue(0, b"dir\n")
    daemon.queue(0, b"broken\0f\t1\t2\tok.txt\0")
    entries = manager.list("demo", "/workspace")
    assert entries == [ListEntry("ok.txt", KIND_FILE, 1, 2)]


def test_list_failure_is_classified(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """列目录失败：按 stderr 关键词归类。"""
    daemon.queue(0, b"dir\n")  # 前置判定通过
    daemon.queue(1, b"", "find: '/workspace/nope': No such file or directory")
    with pytest.raises(TransferError) as excinfo:
        manager.list("demo", "/workspace/nope")
    assert excinfo.value.reason == REASON_NOT_FOUND


def test_list_reports_a_missing_path(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """列不存在的路径 → 报「文件不存在」（不是「空目录」）。"""
    daemon.queue(0, b"missing\n")
    with pytest.raises(TransferError) as excinfo:
        manager.list("demo", "/workspace/nope")
    assert excinfo.value.reason == REASON_NOT_FOUND
    assert str(excinfo.value).startswith(MSG_NOT_FOUND)
    # 前置判定就报了：没有起 find exec
    assert len(daemon.spawned) == 1


def test_list_rejects_a_path_that_is_not_a_directory(
    manager: FileTransferManager, daemon: FakeDaemon
) -> None:
    """列一个**普通文件** → 报错（``find`` 对普通文件静默返回空，会被误读）。

    复用既有的分类码（``not_regular``）与文案体系（文案按场景取），不新造概念。
    """
    daemon.queue(0, b"file\t5\t1\n")
    with pytest.raises(TransferError) as excinfo:
        manager.list("demo", "/workspace/a.bin")
    assert excinfo.value.reason == REASON_NOT_REGULAR
    assert str(excinfo.value).startswith(MSG_NOT_A_DIRECTORY)
    # 只起了探测 exec，**没有**起 find exec
    assert len(daemon.spawned) == 1


# ---------------------------------------------------------------- 装配与归位
def test_transfer_error_lives_in_errors_module() -> None:
    """TransferError 归位 errors.py（仓库的业务异常都在那儿）。"""
    assert TransferError is TransferErrorFromErrors
    assert TransferError.__module__ == "sandbox_platform.errors"


def test_probe_result_helpers() -> None:
    """探测结果的类型判定：只有普通文件可下载。"""
    regular = ProbeResult(path="/a", kind=KIND_FILE, size=3, mtime=1)
    assert regular.is_regular_file is True
    assert ProbeResult(path="/a", kind=KIND_DIR).is_regular_file is False
    assert ProbeResult(path="/a", kind=KIND_MISSING).is_regular_file is False


def test_error_classification_is_case_insensitive() -> None:
    """关键词匹配**大小写不敏感**（容器内措辞大小写不可控）。"""
    error = classify_stderr("sh: 1: cannot create /x/.rtf-tmp-y: PERMISSION DENIED", "/x/a")
    assert error.reason == REASON_PARENT_NOT_WRITABLE
    error = classify_stderr("sh: 1: cannot create /x/.rtf-tmp-y: READ-ONLY FILE SYSTEM", "/x/a")
    assert error.reason == REASON_READONLY


def test_manager_without_runtime_reports_a_fixed_message() -> None:
    """未装配沙箱侧能力：固定中文文案 + 分类码，不抛 AttributeError。"""
    manager = FileTransferManager()
    for call in (
        lambda: manager.probe("demo", "/a"),
        lambda: manager.upload("demo", "/a", [b"x"]),
        lambda: manager.download("demo", "/a"),
        lambda: manager.list("demo", "/a"),
    ):
        with pytest.raises(TransferError) as excinfo:
            call()
        assert str(excinfo.value) == MSG_NO_RUNTIME
        assert excinfo.value.reason == REASON_NO_RUNTIME


def test_package_exports_the_transfer_entry_points() -> None:
    """核心包导出传输能力本体（``__all__`` 与导入体例一致）。"""
    for name in (
        "FileTransferManager",
        "ProbeResult",
        "ListEntry",
        "DownloadStream",
        "TransferError",
        "validate_container_path",
        "classify_stderr",
    ):
        assert name in sandbox_platform.__all__
        assert hasattr(sandbox_platform, name)

