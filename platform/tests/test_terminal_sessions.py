"""终端会话测试：会话表、状态流转、断线保留、缓冲回放、窗口大小、退出落盘、重启清理。

测试全部在临时目录里跑，不碰真实平台数据根，也不碰宿主沙箱：

- 会话表读写与原子落盘直接落在临时目录下的平台数据根里；
- 伪终端用标准库真伪终端（真进程、真 TTY、真窗口大小），但跑的是普通命令，
  不涉及任何宿主级沙箱、用户与容器操作。
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import os
import signal
import struct
import sys
import termios
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from sandbox_platform import (
    NotFoundError,
    PlatformConfig,
    PtyProcess,
    SandboxMetadata,
    UserContext,
    UserDaemon,
    ValidationError,
    container_session_kill_script,
    process_state,
    spawn_pty,
    terminate_pty_process,
)
from sandbox_platform.server import create_app
from sandbox_platform.server.deps import get_terminal_manager, get_terminal_manager_ws
from sandbox_platform.server.sessions import (
    SESSION_EXIT_REASON_CLOSED_BY_USER,
    SESSION_EXIT_REASON_EXITED,
    SESSION_EXIT_REASON_RECLAIMED,
    SESSION_STATE_EXITED,
    SESSION_STATE_ORPHANED,
    SESSION_STATE_RUNNING,
    TerminalSessionRecord,
    TerminalSessionTable,
    prepare_sessions_dir,
    purge_leftover_sessions,
)
from sandbox_platform.server.terminal import (
    FRAME_ERROR,
    FRAME_EXIT,
    MAX_PENDING_INPUT,
    TerminalFrame,
    TerminalSession,
    TerminalSessionManager,
    TerminalSpawnRequest,
)
from sandbox_platform.userspace import Privilege

# ---------------------------------------------------------------- 夹具
RECORD_FIELDS = {
    "session_id",
    "sandbox_name",
    "container_name",
    "system_user",
    "created_at",
    "last_attached_at",
    "state",
    "exit_code",
    "pid",
    "cols",
    "rows",
    "attached_count",
    "host_pid",
    "exit_reason",
}


def make_metadata(name: str = "demo") -> SandboxMetadata:
    """构造一份沙箱元数据。"""
    return SandboxMetadata(
        name=name,
        system_user=f"sandbox-{name}",
        uid=1001,
        gid=1001,
        home=f"/home/sandbox-{name}",
        subid_start=100000,
        subid_length=65536,
        image="busybox:1.37",
        socket_path="/run/user/1001/docker.sock",
        socket_mount_path="/var/run/docker.sock",
        container_name=f"sandbox-{name}",
        container_id="0123456789abcdef",
        network_name=f"{name}-net",
        unit_path=f"/home/sandbox-{name}/.config/systemd/user/docker.service",
        state="running",
    )


def make_record(session_id: str = "sess-1", **kwargs: Any) -> TerminalSessionRecord:
    """构造一条会话表记录。"""
    payload: dict[str, Any] = {
        "session_id": session_id,
        "sandbox_name": "demo",
        "container_name": "sandbox-demo",
        "system_user": "sandbox-demo",
        "created_at": "2026-10-30T01:00:00+00:00",
        "last_attached_at": "2026-10-30T01:00:00+00:00",
        "state": SESSION_STATE_RUNNING,
        "exit_code": None,
        "pid": 4242,
        "cols": 80,
        "rows": 24,
        "attached_count": 0,
        "host_pid": 0,
    }
    payload.update(kwargs)
    return TerminalSessionRecord(**payload)


class FakeService:
    """假的生命周期服务：只提供终端会话需要的查询。"""

    def __init__(self, metadata: SandboxMetadata | None = None) -> None:
        self.metadata = metadata or make_metadata()
        self.error: Exception | None = None

    def get(self, name: str) -> SandboxMetadata:
        """取沙箱元数据。"""
        if self.error is not None:
            raise self.error
        if name != self.metadata.name:
            raise NotFoundError(f"沙箱不存在：{name}")
        return self.metadata


class FakeDaemon:
    """假的沙箱守护进程入口：只记下「按会话标识收进程」的调用。"""

    def __init__(self) -> None:
        self.killed: list[tuple[str, str]] = []

    def kill_container_session(self, container: str, session_id: str) -> bool:
        """记录一次容器内会话清理。"""
        self.killed.append((container, session_id))
        return True


class FakeServiceWithDaemon(FakeService):
    """带守护进程入口的假服务。"""

    def __init__(self, metadata: SandboxMetadata | None = None) -> None:
        super().__init__(metadata)
        self.daemon = FakeDaemon()

    def daemon_for(self, name: str) -> FakeDaemon:
        """取沙箱对应的守护进程入口。"""
        return self.daemon


def pty_spawner(command: list[str]):
    """构造起会话方式：真伪终端 + 真进程（跑普通命令，不碰宿主沙箱）。"""

    def spawn(request: TerminalSpawnRequest) -> PtyProcess:
        return spawn_pty(command, cols=request.cols, rows=request.rows)

    return spawn


@pytest.fixture
def fake_service() -> FakeService:
    """假的生命周期服务。"""
    return FakeService()


@pytest.fixture
def loop():
    """后台事件循环。

    会话在创建时记住事件循环，实时输出靠它投递到浏览器连接；测试里的会话
    必须在同一个活着的循环上跑。
    """
    event_loop = asyncio.new_event_loop()
    thread = threading.Thread(target=event_loop.run_forever, daemon=True)
    thread.start()
    try:
        yield event_loop
    finally:
        event_loop.call_soon_threadsafe(event_loop.stop)
        thread.join(timeout=5)
        event_loop.close()


@pytest.fixture
def manager(config: PlatformConfig, fake_service: FakeService) -> TerminalSessionManager:
    """终端会话管理器（起会话方式换成真伪终端 + 普通命令）。"""
    return TerminalSessionManager(
        config,
        fake_service,
        spawner=pty_spawner(["cat"]),
    )


def create_session(manager: TerminalSessionManager, loop, **kwargs: Any) -> TerminalSession:
    """在后台事件循环上新建一个终端会话。"""
    future = asyncio.run_coroutine_threadsafe(manager.create("demo", **kwargs), loop)
    return future.result(timeout=30)


def collect(stream, loop, timeout: float = 2.0) -> bytes:
    """从会话的实时输出流里取一块数据。"""

    async def _take() -> bytes:
        try:
            item = await asyncio.wait_for(stream.queue.get(), timeout=timeout)
        except asyncio.TimeoutError:
            return b""
        if item is None:
            return b""
        if isinstance(item, TerminalFrame):
            return item.payload
        return bytes(item)

    return asyncio.run_coroutine_threadsafe(_take(), loop).result(timeout=timeout + 10)


def collect_frame(stream, loop, timeout: float = 2.0) -> TerminalFrame | None:
    """从会话的实时输出流里取一帧（拿提示帧用）。"""

    async def _take() -> TerminalFrame | None:
        try:
            return await asyncio.wait_for(stream.queue.get(), timeout=timeout)
        except asyncio.TimeoutError:
            return None

    return asyncio.run_coroutine_threadsafe(_take(), loop).result(timeout=timeout + 10)


def wait_record(
    config: PlatformConfig,
    session_id: str,
    predicate,
    timeout: float = 5.0,
) -> TerminalSessionRecord | None:
    """等会话记录落盘到满足条件（落盘走后台线程的合并写，不是即时的）。"""
    table = TerminalSessionTable(config)
    deadline = time.monotonic() + timeout
    while True:
        record = table.load(session_id)
        if record is not None and predicate(record):
            return record
        if time.monotonic() >= deadline:
            return record
        time.sleep(0.05)


def pty_winsize(session: TerminalSession) -> tuple[int, int]:
    """直接读伪终端的窗口大小（行数、列数）。"""
    packed = fcntl.ioctl(
        session.pty.master_fd, termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0)
    )
    rows, cols = struct.unpack("HHHH", packed)[:2]
    return rows, cols


@pytest.fixture
def client(
    manager: TerminalSessionManager,
    platform_home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    """测试客户端（终端会话管理器整体替换）。

    必须以上下文管理器方式使用：测试客户端会为每个请求开一个事件循环，
    会话在创建时记住事件循环，跨请求必须共用同一个。
    """
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    app = create_app()
    app.dependency_overrides[get_terminal_manager] = lambda: manager
    app.dependency_overrides[get_terminal_manager_ws] = lambda: manager
    with TestClient(app) as http_client:
        yield http_client


# ---------------------------------------------------------------- 会话表
def test_session_table_round_trip(config: PlatformConfig) -> None:
    """会话表读写：落盘路径固定、字段齐全、原子替换不留临时文件。"""
    prepare_sessions_dir(config)
    table = TerminalSessionTable(config)
    record = make_record("sess-abc")

    path = table.save(record)
    assert path == config.home / "terminal-sessions" / "sess-abc.json"
    assert path.is_file()

    loaded = table.load("sess-abc")
    assert loaded is not None
    assert loaded.to_dict() == record.to_dict()

    assert [item.session_id for item in table.list_all()] == ["sess-abc"]

    # 原子落盘：目录里只剩正式文件，没有残留的临时文件
    assert sorted(item.name for item in path.parent.iterdir()) == ["sess-abc.json"]

    data = json.loads(path.read_text(encoding="utf-8"))
    assert set(data) == RECORD_FIELDS

    assert table.delete("sess-abc") is True
    assert table.load("sess-abc") is None
    assert table.delete("sess-abc") is False


def test_session_table_rejects_bad_session_id(config: PlatformConfig) -> None:
    """会话标识含路径分隔符时直接拒绝，不写到目录外面去。"""
    table = TerminalSessionTable(config)
    with pytest.raises(Exception):
        table.path_for("../escape")


def test_record_state_transitions(config: PlatformConfig) -> None:
    """会话记录的状态、退出码、附着数按预期流转。"""
    table = TerminalSessionTable(config)
    record = make_record("sess-flow", attached_count=0)
    table.save(record)

    record.attached_count = 1
    record.last_attached_at = "2026-10-30T02:00:00+00:00"
    table.save(record)
    reloaded = table.load("sess-flow")
    assert reloaded is not None
    assert reloaded.attached_count == 1
    assert reloaded.last_attached_at == "2026-10-30T02:00:00+00:00"

    record.state = SESSION_STATE_EXITED
    record.exit_code = 7
    table.save(record)
    reloaded = table.load("sess-flow")
    assert reloaded is not None
    assert reloaded.state == SESSION_STATE_EXITED
    assert reloaded.exit_code == 7


def test_record_from_dict_tolerates_missing_exit_reason() -> None:
    """旧记录文件没有结束原因这个字段：读回来按空值补齐，不炸。"""
    payload = make_record("sess-legacy").to_dict()
    payload.pop("exit_reason", None)

    record = TerminalSessionRecord.from_dict(payload)

    assert record.exit_reason is None
    assert record.session_id == "sess-legacy"


# ---------------------------------------------------------------- 会话创建与附着
def test_create_session_persists_record(
    manager: TerminalSessionManager, config: PlatformConfig, loop
) -> None:
    """新建会话：登记会话表，状态运行中，窗口大小按上报值落盘。"""
    session = create_session(manager, loop, cols=120, rows=40)
    try:
        assert session.state == SESSION_STATE_RUNNING
        assert session.record.cols == 120
        assert session.record.rows == 40
        assert session.record.sandbox_name == "demo"
        assert session.record.container_name == "sandbox-demo"
        assert session.record.system_user == "sandbox-demo"
        assert session.record.pid > 0
        assert session.record.attached_count == 0

        stored = TerminalSessionTable(config).load(session.session_id)
        assert stored is not None
        assert stored.state == SESSION_STATE_RUNNING
        assert stored.cols == 120
        assert stored.rows == 40
    finally:
        session.close(SESSION_EXIT_REASON_CLOSED_BY_USER)


def test_create_session_fails_for_missing_sandbox(manager: TerminalSessionManager) -> None:
    """沙箱不存在时直接失败，不产生空会话。"""
    with pytest.raises(NotFoundError):
        asyncio.run(manager.create("nobody"))
    assert manager.list_records() == []


def test_attach_and_detach_update_counter(
    manager: TerminalSessionManager, config: PlatformConfig, loop
) -> None:
    """附着与断开：连接数与最近附着时间按预期变化并落盘。"""
    session = create_session(manager, loop)
    try:
        session.attach()
        session.attach()
        stored = wait_record(
            config, session.session_id, lambda item: item.attached_count == 2
        )
        assert stored is not None
        assert stored.attached_count == 2

        session.detach()
        stored = wait_record(
            config, session.session_id, lambda item: item.attached_count == 1
        )
        assert stored is not None
        assert stored.attached_count == 1
    finally:
        session.close(SESSION_EXIT_REASON_CLOSED_BY_USER)


def test_sessions_are_independent(manager: TerminalSessionManager, loop) -> None:
    """同一沙箱可开多个独立终端：互不影响，输入不串。"""
    first = create_session(manager, loop)
    second = create_session(manager, loop)
    try:
        assert first.session_id != second.session_id
        assert first.pty.pid != second.pty.pid
        assert first.pty.master_fd != second.pty.master_fd

        first_stream, _ = first.open_stream()
        second_stream, _ = second.open_stream()

        first.write(b"only-first\n")
        received = collect(first_stream, loop, timeout=3.0)
        assert b"only-first" in received
        # 另一个会话既没收到输入，也没收到输出
        assert collect(second_stream, loop, timeout=0.5) == b""
    finally:
        first.close(SESSION_EXIT_REASON_CLOSED_BY_USER)
        second.close(SESSION_EXIT_REASON_CLOSED_BY_USER)


# ---------------------------------------------------------------- 断线与回放
def test_disconnect_keeps_session_and_replays_buffer(
    manager: TerminalSessionManager, config: PlatformConfig, loop
) -> None:
    """断线后进程不退出、输出继续进缓冲；重连先回放再接实时流。"""
    session = create_session(manager, loop)
    try:
        stream, snapshot = session.open_stream()
        assert snapshot == b""
        session.attach()

        # 断线：浏览器断开，容器内进程继续跑
        session.close_stream(stream)
        session.detach()
        session.write(b"while-offline\n")
        time.sleep(0.5)

        stored = TerminalSessionTable(config).load(session.session_id)
        assert stored is not None
        assert stored.state == SESSION_STATE_RUNNING
        assert stored.attached_count == 0

        # 重连：回放缓冲
        stream2, snapshot2 = session.open_stream()
        assert b"while-offline" in snapshot2

        # 回放之后的新输出走实时流，不重复
        session.write(b"live-now\n")
        received = collect(stream2, loop, timeout=3.0)
        assert b"live-now" in received
        assert snapshot2.count(b"while-offline") == 1
        session.close_stream(stream2)
    finally:
        session.close(SESSION_EXIT_REASON_CLOSED_BY_USER)


def test_resize_sets_pty_window_size(manager: TerminalSessionManager, loop) -> None:
    """窗口大小同步：伪终端的窗口大小按上报值设置（直接断言 winsize）。"""
    session = create_session(manager, loop, cols=80, rows=24)
    try:
        assert pty_winsize(session) == (24, 80)

        session.resize(132, 43)
        assert pty_winsize(session) == (43, 132)
        assert session.record.cols == 132
        assert session.record.rows == 43
    finally:
        session.close(SESSION_EXIT_REASON_CLOSED_BY_USER)


def test_exit_persists_state_and_code(
    config: PlatformConfig, fake_service: FakeService, loop
) -> None:
    """容器内进程退出：状态与退出码落盘。"""
    manager = TerminalSessionManager(
        config,
        fake_service,
        spawner=pty_spawner(["sh", "-c", "printf bye; exit 7"]),
    )
    session = create_session(manager, loop)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not session.exited:
        time.sleep(0.1)

    assert session.exited
    assert session.exit_code == 7
    stored = wait_record(
        config, session.session_id, lambda item: item.state == SESSION_STATE_EXITED
    )
    assert stored is not None
    assert stored.state == SESSION_STATE_EXITED
    assert stored.exit_code == 7
    # 会话已经自己退出了：这次关闭不覆盖既有原因。
    session.close(SESSION_EXIT_REASON_CLOSED_BY_USER)
    assert session.exit_reason == SESSION_EXIT_REASON_EXITED


# ---------------------------------------------------------------- 重启清理
def test_restart_marks_orphaned_and_kills_leftover(config: PlatformConfig) -> None:
    """服务重启：遗留记录标记孤儿，按会话标识终止遗留进程，随后删除记录。"""
    prepare_sessions_dir(config)
    table = TerminalSessionTable(config)

    marker = "sess-marker-1"
    # 遗留进程的命令行里含会话标识（与真实执行路径一致）：该终止
    victim = spawn_pty([sys.executable, "-c", "import time; time.sleep(60)", marker])
    # 命令行里不含会话标识：即便进程号被复用也不该误杀
    bystander = spawn_pty(["cat"])
    try:
        table.save(make_record(marker, pid=victim.pid))
        table.save(make_record("sess-other", pid=bystander.pid))

        removed = purge_leftover_sessions(config)
        assert marker in removed
        assert "sess-other" in removed

        # 遗留进程已被终止
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and victim.poll() is None:
            time.sleep(0.1)
        assert victim.poll() is not None
        # 命令行不含会话标识的进程不受影响
        assert bystander.poll() is None
    finally:
        victim.close()
        bystander.close()

    # 记录文件已删除
    assert table.list_all() == []


def test_restart_does_not_kill_reused_pid(config: PlatformConfig) -> None:
    """进程号被复用时（命令行不含会话标识）不终止该进程。"""
    prepare_sessions_dir(config)
    table = TerminalSessionTable(config)
    bystander = spawn_pty(["cat"])
    try:
        table.save(make_record("sess-unrelated", pid=bystander.pid))
        purge_leftover_sessions(config)
        assert bystander.poll() is None
    finally:
        bystander.close()


def test_restart_removes_records_without_processes(config: PlatformConfig) -> None:
    """遗留记录里的进程早已消失：记录照样被清理，不影响服务启动。"""
    prepare_sessions_dir(config)
    table = TerminalSessionTable(config)
    table.save(make_record("sess-gone", pid=999999))
    removed = purge_leftover_sessions(config)
    assert removed == ["sess-gone"]
    assert table.list_all() == []


def test_restart_removes_corrupt_records(config: PlatformConfig) -> None:
    """遗留记录内容损坏：照样删掉，不影响服务启动。"""
    prepare_sessions_dir(config)
    path = config.home / "terminal-sessions" / "stale-session.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}", encoding="utf-8")
    removed = purge_leftover_sessions(config)
    assert removed == ["stale-session"]
    assert not path.exists()


def test_restart_marks_records_orphaned_before_delete(
    config: PlatformConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """遗留记录先被标记为孤儿，再删除。"""
    prepare_sessions_dir(config)
    table = TerminalSessionTable(config)
    table.save(make_record("sess-orphan", pid=0))

    saved_states: list[str] = []
    original_save = TerminalSessionTable.save

    def spy_save(self, record):
        saved_states.append(record.state)
        return original_save(self, record)

    monkeypatch.setattr(TerminalSessionTable, "save", spy_save)
    purge_leftover_sessions(config)
    assert SESSION_STATE_ORPHANED in saved_states
    assert table.list_all() == []


# ---------------------------------------------------------------- HTTP 接口
def test_http_create_and_list_sessions(
    client: TestClient, manager: TerminalSessionManager
) -> None:
    """新建会话接口返回会话标识与初始窗口大小；列表接口按沙箱列出会话。"""
    response = client.post("/api/terminal/sessions", json={"sandbox": "demo"})
    assert response.status_code == 201
    payload = response.json()
    assert payload["session_id"]
    assert payload["sandbox"] == "demo"
    assert payload["cols"] == 80
    assert payload["rows"] == 24
    assert payload["state"] == SESSION_STATE_RUNNING

    listing = client.get("/api/terminal/sessions", params={"sandbox": "demo"})
    assert listing.status_code == 200
    items = listing.json()
    assert len(items) == 1
    assert items[0]["session_id"] == payload["session_id"]
    assert items[0]["sandbox_name"] == "demo"
    assert set(items[0]) == RECORD_FIELDS

    empty = client.get("/api/terminal/sessions", params={"sandbox": "other"})
    assert empty.status_code == 200
    assert empty.json() == []

    manager.close_all()


def test_http_create_rejects_bad_payload(client: TestClient) -> None:
    """新建会话接口的入参校验：缺字段、多余字段、窗口大小越界都判 400。"""
    assert client.post("/api/terminal/sessions", json={}).status_code == 400
    assert (
        client.post("/api/terminal/sessions", json={"sandbox": "demo", "x": 1}).status_code
        == 400
    )
    assert (
        client.post("/api/terminal/sessions", json={"sandbox": "demo", "cols": 0}).status_code
        == 400
    )


def test_http_create_fails_when_sandbox_not_running(
    config: PlatformConfig, fake_service: FakeService, tmp_path: Path, monkeypatch
) -> None:
    """沙箱未运行时创建会话直接失败（中文错误），不产生空会话。"""
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))

    def refuse(request: TerminalSpawnRequest) -> PtyProcess:
        raise ValidationError(f"沙箱未运行，无法创建终端会话：{request.sandbox_name}")

    manager = TerminalSessionManager(config, fake_service, spawner=refuse)
    app = create_app()
    app.dependency_overrides[get_terminal_manager] = lambda: manager
    app.dependency_overrides[get_terminal_manager_ws] = lambda: manager
    with TestClient(app) as http:
        response = http.post("/api/terminal/sessions", json={"sandbox": "demo"})
    assert response.status_code == 400
    assert "沙箱未运行" in response.json()["detail"]
    assert manager.list_records() == []


# ---------------------------------------------------------------- WebSocket 协议
def test_websocket_bridges_input_and_output(
    client: TestClient, manager: TerminalSessionManager
) -> None:
    """WebSocket 桥接：二进制帧进容器、二进制帧回显、文本帧同步窗口大小。"""
    created = client.post("/api/terminal/sessions", json={"sandbox": "demo"}).json()
    session = manager.get(created["session_id"])
    assert session is not None
    try:
        with client.websocket_connect(f"/api/terminal/sessions/{created['session_id']}") as ws:
            hello = ws.receive_json()
            assert hello["type"] == "hello"
            assert hello["session_id"] == created["session_id"]
            assert hello["sandbox"] == "demo"

            ws.send_bytes(b"ping\n")
            echoed = ws.receive_bytes()
            assert b"ping" in echoed

            ws.send_json({"type": "resize", "cols": 132, "rows": 43})
            time.sleep(0.5)
            assert pty_winsize(session) == (43, 132)

            ws.send_json({"type": "bogus"})
            error = ws.receive_json()
            assert error["type"] == "error"
            assert "无法识别" in error["message"]
    finally:
        manager.close_all()


def test_websocket_replays_buffer_after_reconnect(
    client: TestClient, manager: TerminalSessionManager
) -> None:
    """断线重连：先回放缓冲再接实时流。"""
    created = client.post("/api/terminal/sessions", json={"sandbox": "demo"}).json()
    session = manager.get(created["session_id"])
    assert session is not None
    try:
        with client.websocket_connect(f"/api/terminal/sessions/{created['session_id']}") as ws:
            ws.receive_json()
            ws.send_bytes(b"before-disconnect\n")
            assert b"before-disconnect" in ws.receive_bytes()

        # 断开后容器内进程继续跑
        session.write(b"while-offline\n")
        time.sleep(0.5)

        with client.websocket_connect(f"/api/terminal/sessions/{created['session_id']}") as ws:
            ws.receive_json()
            replayed = ws.receive_bytes()
            assert b"while-offline" in replayed
    finally:
        manager.close_all()


def test_websocket_unknown_session_reports_error(client: TestClient) -> None:
    """附着到不存在的会话：回一条错误帧再断开。"""
    with client.websocket_connect("/api/terminal/sessions/nope") as ws:
        message = ws.receive_json()
        assert message["type"] == "error"
        assert "终端会话" in message["message"]


def test_websocket_reports_exit_code(
    config: PlatformConfig, fake_service: FakeService, tmp_path: Path, monkeypatch
) -> None:
    """容器内进程退出：服务端回一条 exit 帧。"""
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    manager = TerminalSessionManager(
        config,
        fake_service,
        spawner=pty_spawner(["sh", "-c", "sleep 0.5; exit 5"]),
    )
    app = create_app()
    app.dependency_overrides[get_terminal_manager] = lambda: manager
    app.dependency_overrides[get_terminal_manager_ws] = lambda: manager
    with TestClient(app) as http:
        created = http.post("/api/terminal/sessions", json={"sandbox": "demo"}).json()
        with http.websocket_connect(
            f"/api/terminal/sessions/{created['session_id']}"
        ) as ws:
            assert ws.receive_json()["type"] == "hello"
            frames = []
            for _ in range(10):
                message = ws.receive_json()
                frames.append(message)
                if message["type"] == "exit":
                    break
            assert frames[-1]["type"] == "exit"
            assert frames[-1]["code"] == 5
            # 容器内进程自己退出：原因必须是 exited（不得被当成用户主动关闭）
            assert frames[-1]["reason"] == "exited"


# ---------------------------------------------------------------- 伪终端底层
def test_exec_pty_shell_injects_session_marker(monkeypatch: pytest.MonkeyPatch) -> None:
    """容器内 shell 的命令行带会话标识与容器名。

    会话标识是「按标识收进程」的唯一依据：宿主侧 exec 进程的命令行里要有它
    （清理遗留进程用），容器内进程的环境变量里也要有它（容器内清理用）。
    """
    captured: dict[str, Any] = {}

    def fake_spawn_pty(argv, *, cols=80, rows=24, env=None, marker=None):
        captured["argv"] = list(argv)
        captured["marker"] = marker
        return spawn_pty(["cat"], cols=cols, rows=rows)

    monkeypatch.setattr("sandbox_platform.daemon.spawn_pty", fake_spawn_pty)
    daemon = UserDaemon(
        UserContext(
            user="sandbox-demo",
            uid=1001,
            gid=1001,
            home=Path("/home/sandbox-demo"),
        ),
        privilege=Privilege(enabled=False),
    )
    process = daemon.exec_pty_shell("sandbox-demo", session_id="sess-marker-9")
    try:
        argv = captured["argv"]
        # 命令行尾部是完整的 ``docker exec -it --env <会话标识> <容器名> <shell> -i``：
        # 只给子命令的话宿主侧会去执行一个叫 exec 的程序（不存在），
        # 容器内 shell 起不来。整体断言尾部形态，次序错一位就会失败。
        assert argv[-8:] == [
            "docker",
            "exec",
            "-it",
            "--env",
            "SANDBOX_TERMINAL_SESSION=sess-marker-9",
            "sandbox-demo",
            "bash",
            "-i",
        ]
        assert captured["marker"] == "sess-marker-9"
    finally:
        process.close()


def test_exec_pty_shell_sudo_branch_prefixes_user_switch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """非 root 运行的提权分支：命令行头部带 ``sudo -n -u <用户>``。

    少了这个前缀，``-u <用户>`` 会被当成外层命令的参数，产出非法命令行。
    """
    captured: dict[str, Any] = {}

    def fake_spawn_pty(argv, *, cols=80, rows=24, env=None, marker=None):
        captured["argv"] = list(argv)
        captured["marker"] = marker
        return spawn_pty(["cat"], cols=cols, rows=rows)

    monkeypatch.setattr("sandbox_platform.daemon.spawn_pty", fake_spawn_pty)
    daemon = UserDaemon(
        UserContext(
            user="sandbox-demo",
            uid=1001,
            gid=1001,
            home=Path("/home/sandbox-demo"),
        ),
        privilege=Privilege(enabled=True),
    )
    process = daemon.exec_pty_shell("sandbox-demo", session_id="sess-sudo-1")
    try:
        argv = captured["argv"]
        assert argv[:4] == ["sudo", "-n", "-u", "sandbox-demo"]
        assert argv[-8:] == [
            "docker",
            "exec",
            "-it",
            "--env",
            "SANDBOX_TERMINAL_SESSION=sess-sudo-1",
            "sandbox-demo",
            "bash",
            "-i",
        ]
        assert captured["marker"] == "sess-sudo-1"
    finally:
        process.close()


def test_container_session_kill_script_validates_session_id() -> None:
    """会话标识非法时不进命令构造（标识会拼进容器内的 shell 脚本）。"""
    with pytest.raises(Exception):
        container_session_kill_script("abc; rm -rf /")
    script = container_session_kill_script("sess-1")
    assert "SANDBOX_TERMINAL_SESSION=sess-1" in script
    # 容器内 shell 的命令行里没有标识，只能按环境变量匹配
    assert "/proc/[0-9]*/environ" in script


def test_spawn_pty_requires_python_interpreter(monkeypatch: pytest.MonkeyPatch) -> None:
    """拿不到解释器路径时直接报错，不静默降级。

    降级的后果是子进程拿不到控制终端：容器内窗口大小永远同步不上，而且
    没有任何日志提示。
    """
    monkeypatch.setattr("sandbox_platform.daemon.sys.executable", "")
    with pytest.raises(RuntimeError):
        spawn_pty(["cat"])


def test_terminate_pty_process_returns_immediately_for_zombie() -> None:
    """进程已是僵尸时立即返回：不白等宽限期，也不发无效的强杀信号。"""
    victim = spawn_pty([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        os.kill(victim.pid, signal.SIGKILL)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and process_state(victim.pid) != "Z":
            time.sleep(0.05)
        assert process_state(victim.pid) == "Z"

        started = time.monotonic()
        assert terminate_pty_process(victim.pid, "sess-none") is True
        assert time.monotonic() - started < 1.0
    finally:
        victim.close()


def test_terminate_pty_process_skips_process_without_marker() -> None:
    """命令行不含会话标识的进程一律不碰（进程号被复用时不能误杀）。"""
    bystander = spawn_pty([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        assert terminate_pty_process(bystander.pid, "sess-other") is False
        assert bystander.poll() is None
    finally:
        bystander.close()


# ---------------------------------------------------------------- 会话上限与回收
def test_session_count_limits_are_enforced(
    config: PlatformConfig, fake_service: FakeService, loop
) -> None:
    """会话数上限：单沙箱上限与全局上限都拦得住，不产生空会话。"""
    per_sandbox = TerminalSessionManager(
        config,
        fake_service,
        spawner=pty_spawner(["cat"]),
        max_sessions=5,
        max_sessions_per_sandbox=1,
    )
    overall = TerminalSessionManager(
        config,
        fake_service,
        spawner=pty_spawner(["cat"]),
        max_sessions=1,
        max_sessions_per_sandbox=5,
    )
    try:
        first = create_session(per_sandbox, loop)
        try:
            with pytest.raises(ValidationError):
                asyncio.run_coroutine_threadsafe(
                    per_sandbox.create("demo"), loop
                ).result(timeout=30)
            assert len(per_sandbox.list_records()) == 1
        finally:
            first.close(SESSION_EXIT_REASON_CLOSED_BY_USER)

        only = create_session(overall, loop)
        try:
            with pytest.raises(ValidationError):
                asyncio.run_coroutine_threadsafe(
                    overall.create("demo"), loop
                ).result(timeout=30)
            assert len(overall.list_records()) == 1
        finally:
            only.close(SESSION_EXIT_REASON_CLOSED_BY_USER)
    finally:
        per_sandbox.close_all()
        overall.close_all()


def test_idle_sessions_are_reclaimed(
    config: PlatformConfig, fake_service: FakeService, loop
) -> None:
    """无附着且空闲超时的会话被自动回收：走正常关闭流程 + 会话表更新。"""
    manager = TerminalSessionManager(
        config, fake_service, spawner=pty_spawner(["cat"]), idle_timeout=60
    )
    session = create_session(manager, loop)
    try:
        # 有浏览器连着的会话不回收
        session.attach()
        assert manager.reap_idle_sessions() == []
        session.detach()

        # 把最近附着时间推到过去，模拟长时间没人用
        session.record.last_attached_at = "2020-01-01T00:00:00+00:00"
        assert manager.reap_idle_sessions() == [session.session_id]
        assert manager.get(session.session_id) is None

        stored = wait_record(
            config, session.session_id, lambda item: item.state == SESSION_STATE_EXITED
        )
        assert stored is not None
        assert stored.state == SESSION_STATE_EXITED
    finally:
        manager.close_all()


def test_idle_reclaim_persists_reclaimed_reason(
    config: PlatformConfig, fake_service: FakeService, loop
) -> None:
    """空闲回收：结束原因落库为 ``reclaimed``（不是失败，也不是正常退出）。"""
    manager = TerminalSessionManager(
        config, fake_service, spawner=pty_spawner(["cat"]), idle_timeout=60
    )
    session = create_session(manager, loop)
    try:
        # 把最近附着时间推到过去，模拟长时间没人用
        session.record.last_attached_at = "2020-01-01T00:00:00+00:00"
        assert manager.reap_idle_sessions() == [session.session_id]
        assert manager.get(session.session_id) is None

        stored = wait_record(
            config,
            session.session_id,
            lambda item: item.exit_reason == SESSION_EXIT_REASON_RECLAIMED,
        )
        assert stored is not None
        assert stored.state == SESSION_STATE_EXITED
        assert stored.exit_reason == SESSION_EXIT_REASON_RECLAIMED
    finally:
        manager.close_all()


def test_delete_after_natural_exit_keeps_exited_reason(
    config: PlatformConfig, fake_service: FakeService, loop
) -> None:
    """会话自然退出后再删除：结束原因不被「用户主动关闭」覆盖。

    已经退出的会话走关闭流程时不再改原因：容器内进程自己退出的会话，
    原因一直是 ``exited``（客户端据此提示正常结束而不是失败）。
    """
    manager = TerminalSessionManager(
        config, fake_service, spawner=pty_spawner(["sh", "-c", "exit 0"])
    )
    session = create_session(manager, loop)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not session.exited:
        time.sleep(0.05)
    assert session.exited
    assert session.exit_reason == SESSION_EXIT_REASON_EXITED

    stored = wait_record(
        config,
        session.session_id,
        lambda item: item.exit_reason == SESSION_EXIT_REASON_EXITED,
    )
    assert stored is not None
    assert stored.exit_reason == SESSION_EXIT_REASON_EXITED

    # 删除（走的是「用户主动关闭」那条关闭流程）
    removal = manager.remove_session(session.session_id)
    assert removal is not None
    assert removal.state == SESSION_STATE_EXITED
    # 既有原因没被覆盖。
    assert session.exit_reason == SESSION_EXIT_REASON_EXITED
    manager.close_all()


def test_resize_is_persisted(
    config: PlatformConfig, fake_service: FakeService, loop
) -> None:
    """窗口大小变更也落盘（浏览器拖窗口会连发 resize，落盘走合并写）。"""
    manager = TerminalSessionManager(config, fake_service, spawner=pty_spawner(["cat"]))
    session = create_session(manager, loop, cols=80, rows=24)
    try:
        session.resize(132, 43)
        stored = wait_record(config, session.session_id, lambda item: item.cols == 132)
        assert stored is not None
        assert stored.cols == 132
        assert stored.rows == 43
    finally:
        session.close(SESSION_EXIT_REASON_CLOSED_BY_USER)
        manager.close_all()


# ---------------------------------------------------------------- 输入与输出
def test_input_over_limit_drops_newest_and_warns(
    config: PlatformConfig, fake_service: FakeService, loop
) -> None:
    """待发输入超上限：丢最新的字节（保最旧的），并给客户端发一条提示帧。"""
    manager = TerminalSessionManager(
        config,
        fake_service,
        spawner=pty_spawner([sys.executable, "-c", "import time; time.sleep(60)"]),
    )
    session = create_session(manager, loop)
    try:
        stream, _ = session.open_stream()
        # 容器内进程不读 stdin：待发缓冲填满后不会再被消费
        session._write_buffer.extend(b"x" * MAX_PENDING_INPUT)
        session.write(b"newest-bytes")
        assert b"newest-bytes" not in bytes(session._write_buffer)

        frame = collect_frame(stream, loop, timeout=5.0)
        assert frame is not None
        assert frame.kind == FRAME_ERROR
        assert "截断" in frame.message
    finally:
        session.close(SESSION_EXIT_REASON_CLOSED_BY_USER)
        manager.close_all()


def test_concurrent_attaches_do_not_duplicate_output(
    manager: TerminalSessionManager, loop
) -> None:
    """两个浏览器同时附着同一会话：每块输出各收一次；快照覆盖的序号不重复投递。"""
    session = create_session(manager, loop)
    try:
        first, first_snapshot = session.open_stream()
        second, second_snapshot = session.open_stream()
        assert first_snapshot == second_snapshot == b""

        session.write(b"shared-line\n")
        first_data = collect(first, loop, timeout=3.0)
        second_data = collect(second, loop, timeout=3.0)
        assert first_data.count(b"shared-line") == 1
        assert second_data.count(b"shared-line") == 1

        # 重连：快照已经覆盖刚才那块，实时流不再重复投递（序号去重）
        third, third_snapshot = session.open_stream()
        assert b"shared-line" in third_snapshot
        assert collect(third, loop, timeout=0.5) == b""
    finally:
        session.close(SESSION_EXIT_REASON_CLOSED_BY_USER)


def test_close_reclaims_io_thread(manager: TerminalSessionManager, loop) -> None:
    """关闭会话：I/O 线程真的退出，不留悬着的后台线程。"""
    session = create_session(manager, loop)
    thread = session._thread
    assert thread.is_alive()
    session.close(SESSION_EXIT_REASON_CLOSED_BY_USER)
    assert not thread.is_alive()


def test_close_kills_container_side_session(
    config: PlatformConfig, loop
) -> None:
    """关闭会话：按会话标识把容器内的残留进程收掉。

    杀宿主侧的 exec 客户端收不掉容器内的 shell：容器里会堆积无主 shell。
    """
    service = FakeServiceWithDaemon()
    manager = TerminalSessionManager(config, service, spawner=pty_spawner(["cat"]))
    session = create_session(manager, loop)
    session.close(SESSION_EXIT_REASON_CLOSED_BY_USER)
    assert service.daemon.killed == [("sandbox-demo", session.session_id)]
    manager.close_all()


# 子进程：先不读 stdin（模拟容器内进程停止读输入），持续写输出；
# 之后再读 stdin 并回显（用来验证 Ctrl-C 仍能送达）
SLOW_READER = """
import os, sys, time

deadline = time.time() + 1.5
while time.time() < deadline:
    sys.stdout.write("tick\\n")
    sys.stdout.flush()
    time.sleep(0.02)
while True:
    chunk = os.read(0, 4096)
    if not chunk:
        break
    sys.stdout.write(chunk.decode("latin-1"))
    sys.stdout.flush()
"""


def test_large_paste_does_not_deadlock(
    config: PlatformConfig, fake_service: FakeService, loop, tmp_path: Path
) -> None:
    """大文本粘贴不卡死：输出照常流动，Ctrl-C 仍能送达。

    阻塞式写入会造出双向死锁：写侧卡在 write 上不再读输出，输出写满后容器内
    的 shell 卡在写 stdout，两边互等，Ctrl-C 都送不进去。
    """
    script = tmp_path / "slow_reader.py"
    script.write_text(SLOW_READER, encoding="utf-8")
    manager = TerminalSessionManager(
        config,
        fake_service,
        spawner=pty_spawner([sys.executable, str(script)]),
    )
    session = create_session(manager, loop)
    try:
        stream, _ = session.open_stream()
        # 粘贴一大段文本：容器内进程此时不读 stdin，写侧必然写不进去
        session.write(b"A" * 262144)
        time.sleep(0.3)

        # 写侧没有卡死：待写字节还在排队，I/O 线程也还活着
        assert session._pending_size() > 0
        assert session._thread.is_alive()

        # 输出照常流动（真死锁时这里收不到任何输出）
        assert b"tick" in collect(stream, loop, timeout=5.0)

        # Ctrl-C 仍能送达：子进程开始读 stdin 之后能收到它
        session.write(b"\x03")
        deadline = time.monotonic() + 30
        seen = b""
        while time.monotonic() < deadline and b"\x03" not in seen:
            seen += collect(stream, loop, timeout=5.0)
        assert b"\x03" in seen
    finally:
        session.close(SESSION_EXIT_REASON_CLOSED_BY_USER)
        manager.close_all()


# ---------------------------------------------------------------- 跨实例保护
def test_purge_skips_sessions_owned_by_live_instance(
    config: PlatformConfig,
) -> None:
    """记录属于另一个还活着的服务实例时跳过清理：那个实例正在用这些会话。"""
    prepare_sessions_dir(config)
    table = TerminalSessionTable(config)
    table.save(make_record("sess-foreign", pid=0, host_pid=os.getppid()))

    assert purge_leftover_sessions(config) == []
    assert table.load("sess-foreign") is not None


def test_purge_cleans_sessions_of_dead_instance(config: PlatformConfig) -> None:
    """记录属于已经死掉的服务实例时照常清理。"""
    prepare_sessions_dir(config)
    table = TerminalSessionTable(config)
    table.save(make_record("sess-dead", pid=0, host_pid=999999))

    assert purge_leftover_sessions(config) == ["sess-dead"]
    assert table.list_all() == []


# ---------------------------------------------------------------- 会话删除
def spawn_with_marker(request: TerminalSpawnRequest) -> PtyProcess:
    """起会话：命令行里带会话标识（与真实执行路径一致，终止前拿标识复核）。"""
    return spawn_pty(
        [sys.executable, "-c", "import time; time.sleep(60)", request.session_id],
        cols=request.cols,
        rows=request.rows,
        marker=request.session_id,
    )


def test_remove_running_session_closes_and_removes(
    config: PlatformConfig, loop, monkeypatch: pytest.MonkeyPatch
) -> None:
    """运行中的会话被删除：完整关闭（终止宿主伪终端、收掉容器内残留进程）后移除记录。"""
    service = FakeServiceWithDaemon()
    manager = TerminalSessionManager(config, service, spawner=spawn_with_marker)
    session = create_session(manager, loop)
    pid = session.pty.pid

    # 桩掉进程终止层：记下终止请求（带会话标识复核），其余行为照旧
    calls: list[tuple[int, str | None]] = []
    real_terminate = terminate_pty_process

    def spy_terminate(target: int, marker: str | None = None, **kwargs: Any) -> bool:
        calls.append((target, marker))
        return real_terminate(target, marker, **kwargs)

    monkeypatch.setattr("sandbox_platform.daemon.terminate_pty_process", spy_terminate)
    try:
        removal = manager.remove_session(session.session_id)
        assert removal is not None
        assert removal.session_id == session.session_id
        assert removal.state == SESSION_STATE_RUNNING
        assert removal.closed is True
        assert removal.removed is True

        # 宿主侧伪终端被终止（终止请求带会话标识）
        assert calls == [(pid, session.session_id)]
        # 容器内按会话标识清进程树
        assert service.daemon.killed == [("sandbox-demo", session.session_id)]
        # 内存与记录文件都没了
        assert manager.get(session.session_id) is None
        assert TerminalSessionTable(config).load(session.session_id) is None
    finally:
        manager.close_all()


def test_remove_exited_session_clears_memory_and_file(
    config: PlatformConfig, fake_service: FakeService, loop
) -> None:
    """已退出的会话被删除：内存条目与记录文件都没了。"""
    manager = TerminalSessionManager(
        config, fake_service, spawner=pty_spawner(["sh", "-c", "exit 3"])
    )
    session = create_session(manager, loop)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not session.exited:
        time.sleep(0.1)
    assert session.exited

    removal = manager.remove_session(session.session_id)
    assert removal is not None
    assert removal.state == SESSION_STATE_EXITED
    # 已退出的会话不重复终止进程，但收尾（回收文件描述符、清容器内残留）
    # 照走：收尾走完了就算关闭流程走完
    assert removal.closed is True
    assert removal.removed is True
    assert manager.get(session.session_id) is None
    assert TerminalSessionTable(config).load(session.session_id) is None
    manager.close_all()


def test_remove_exited_session_reclaims_without_terminating(
    config: PlatformConfig, loop, monkeypatch: pytest.MonkeyPatch
) -> None:
    """已退出的会话：不重复终止进程，但仍走收尾（回收文件描述符、清容器内残留）。"""
    service = FakeServiceWithDaemon()
    manager = TerminalSessionManager(
        config, service, spawner=pty_spawner(["sh", "-c", "exit 3"])
    )
    session = create_session(manager, loop)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not session.exited:
        time.sleep(0.05)
    assert session.exited

    terminate_calls: list[bool] = []
    real_terminate = session.pty.terminate

    def spy_terminate() -> bool:
        terminate_calls.append(True)
        return real_terminate()

    monkeypatch.setattr(session.pty, "terminate", spy_terminate)
    removal = manager.remove_session(session.session_id)
    assert removal is not None
    # 进程早没了：不重复终止
    assert terminate_calls == []
    # 收尾照走：容器内可能残留的进程树清一次
    assert service.daemon.killed == [("sandbox-demo", session.session_id)]
    # 伪终端文件描述符回收了
    with pytest.raises(OSError):
        os.fstat(session.pty.master_fd)
    manager.close_all()


def test_remove_unknown_session_returns_none(manager: TerminalSessionManager) -> None:
    """会话不存在：返回空（路由据此回 404）。"""
    assert manager.remove_session("sess-nope") is None

def test_removed_session_record_is_not_written_back(
    config: PlatformConfig, fake_service: FakeService, loop
) -> None:
    """删掉的记录不会被晚到的落盘写回来。

    落盘走后台线程的合并写，关闭流程与退出回调都会触发落盘：不摘干净的话，
    用户刚删掉的会话会重新出现在列表里。
    """
    manager = TerminalSessionManager(config, fake_service, spawner=pty_spawner(["cat"]))
    session = create_session(manager, loop)
    assert manager.remove_session(session.session_id) is not None

    # 观察窗口内轮询：晚到的落盘一旦把记录写回来就会立刻暴露
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        assert TerminalSessionTable(config).load(session.session_id) is None
        assert manager.list_records() == []
        time.sleep(0.05)
    manager.close_all()


def test_exited_sessions_are_not_idle_reaped(
    config: PlatformConfig, fake_service: FakeService, loop
) -> None:
    """已退出的会话不纳入空闲回收：保留给用户手动删。"""
    manager = TerminalSessionManager(
        config,
        fake_service,
        spawner=pty_spawner(["sh", "-c", "exit 0"]),
        idle_timeout=60,
    )
    session = create_session(manager, loop)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not session.exited:
        time.sleep(0.1)
    assert session.exited

    # 把最近附着时间推到过去，模拟长时间没人用
    session.record.last_attached_at = "2020-01-01T00:00:00+00:00"
    assert manager.reap_idle_sessions() == []
    assert manager.get(session.session_id) is not None
    manager.close_all()


def test_http_delete_unknown_session_returns_404(client: TestClient) -> None:
    """删除不存在的会话：回 404 与固定中文提示（不回显用户输入）。"""
    response = client.delete("/api/terminal/sessions/0123456789abcdef")
    assert response.status_code == 404
    detail = response.json()["detail"]
    assert detail == "终端会话不存在或已失效"
    assert "0123456789abcdef" not in detail


def test_http_delete_invalid_session_id_returns_404(client: TestClient) -> None:
    """非法会话标识：按不存在处理，错误文案里不出现用户输入。"""
    response = client.delete("/api/terminal/sessions/not-a-session")
    assert response.status_code == 404
    detail = response.json()["detail"]
    assert detail == "终端会话不存在或已失效"
    assert "not-a-session" not in detail


def test_http_delete_same_session_twice_returns_404(
    client: TestClient, manager: TerminalSessionManager
) -> None:
    """重复删除同一会话：第二次回 404（幂等，不当成服务端故障）。"""
    created = client.post("/api/terminal/sessions", json={"sandbox": "demo"}).json()
    session_id = created["session_id"]
    first = client.delete(f"/api/terminal/sessions/{session_id}")
    assert first.status_code == 200
    second = client.delete(f"/api/terminal/sessions/{session_id}")
    assert second.status_code == 404
    assert second.json()["detail"] == "终端会话不存在或已失效"
    manager.close_all()


def test_http_delete_exited_session_removes_record(
    client: TestClient, manager: TerminalSessionManager, config: PlatformConfig
) -> None:
    """删除已退出的会话：记录文件与内存条目都没了。"""
    created = client.post("/api/terminal/sessions", json={"sandbox": "demo"}).json()
    session_id = created["session_id"]
    session = manager.get(session_id)
    assert session is not None
    session.pty.terminate()
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not session.exited:
        time.sleep(0.1)
    assert session.exited

    response = client.delete(f"/api/terminal/sessions/{session_id}")
    assert response.status_code == 200
    payload = response.json()
    assert payload["session_id"] == session_id
    assert payload["state"] == SESSION_STATE_EXITED
    # 已退出的会话不重复终止进程，但收尾走完了：关闭流程算走完
    assert payload["closed"] is True
    assert payload["removed"] is True
    assert manager.get(session_id) is None
    assert TerminalSessionTable(config).load(session_id) is None
    manager.close_all()


def test_http_delete_running_session_closes_attached_connection(
    client: TestClient, manager: TerminalSessionManager, config: PlatformConfig
) -> None:
    """删除运行中的会话：附着中的浏览器收到退出帧并断开，记录也没了。"""
    created = client.post("/api/terminal/sessions", json={"sandbox": "demo"}).json()
    session_id = created["session_id"]
    with client.websocket_connect(f"/api/terminal/sessions/{session_id}") as ws:
        assert ws.receive_json()["type"] == "hello"

        response = client.delete(f"/api/terminal/sessions/{session_id}")
        assert response.status_code == 200
        payload = response.json()
        assert payload["closed"] is True
        assert payload["state"] == SESSION_STATE_RUNNING

        # 附着中的连接走既有的退出帧路径：收到结束标记
        message = ws.receive_json()
        assert message["type"] == "exit"
        # 结束原因带上「用户主动关闭」：客户端据此提示成功而不是失败
        assert message["reason"] == "closed_by_user"
        # 随后连接被正常关闭（不是挂着等超时）
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()

    assert manager.get(session_id) is None
    assert TerminalSessionTable(config).load(session_id) is None
    manager.close_all()


def test_http_delete_survives_close_failure(
    client: TestClient,
    manager: TerminalSessionManager,
    config: PlatformConfig,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """关闭流程出错：接口仍回 200（记录照删），关闭流程未走完如实回报。

    结束标记在关闭流程**一开始**就发：即使后面的收尾出错，附着中的浏览器
    也已经收到退出帧，不会一直挂着。
    """
    created = client.post("/api/terminal/sessions", json={"sandbox": "demo"}).json()
    session_id = created["session_id"]
    session = manager.get(session_id)
    assert session is not None
    real_terminate = session.pty.terminate

    def boom() -> bool:
        raise RuntimeError("伪终端终止失败")

    monkeypatch.setattr(session.pty, "terminate", boom)
    try:
        with client.websocket_connect(f"/api/terminal/sessions/{session_id}") as ws:
            assert ws.receive_json()["type"] == "hello"

            response = client.delete(f"/api/terminal/sessions/{session_id}")
            # 记录已删：接口不回 500
            assert response.status_code == 200
            payload = response.json()
            assert payload["removed"] is True
            # 关闭流程未走完：如实回报
            assert payload["closed"] is False

            # 结束标记先发：浏览器已经收到退出帧
            message = ws.receive_json()
            assert message["type"] == "exit"
            assert message["reason"] == "closed_by_user"
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()
    finally:
        # 收尾：把伪终端进程收掉（别在测试里漏进程）
        real_terminate()
        session.pty.close()

    assert manager.get(session_id) is None
    assert TerminalSessionTable(config).load(session_id) is None
    manager.close_all()


def test_exit_frame_is_sent_before_container_cleanup(
    config: PlatformConfig, loop, monkeypatch: pytest.MonkeyPatch
) -> None:
    """结束标记先发：容器内清理还在跑时，浏览器已经收到退出帧。

    容器内清理可能跑几十秒（要走一次容器内的进程树清理）：发帧排在清理前面，
    浏览器的等待时间就不被清理耗时绑住。
    """
    cleanup_started = threading.Event()
    release_cleanup = threading.Event()

    class BlockingDaemon(FakeDaemon):
        """容器内清理会卡住，直到测试放行。"""

        def kill_container_session(self, container: str, session_id: str) -> bool:
            cleanup_started.set()
            release_cleanup.wait(timeout=10)
            return True

    service = FakeServiceWithDaemon()
    service.daemon = BlockingDaemon()
    manager = TerminalSessionManager(config, service, spawner=pty_spawner(["cat"]))
    session = create_session(manager, loop)
    stream, _ = session.open_stream()

    removals: list[Any] = []

    def remove() -> None:
        removals.append(manager.remove_session(session.session_id))

    worker = threading.Thread(target=remove, daemon=True)
    worker.start()
    try:
        assert cleanup_started.wait(timeout=10)
        # 清理还在跑：结束标记已经到了
        frame = collect_frame(stream, loop, timeout=5.0)
        assert frame is not None
        assert frame.kind == FRAME_EXIT
        # 结束原因已经写上（不等清理跑完）
        assert session.exit_reason == "closed_by_user"
    finally:
        release_cleanup.set()
        worker.join(timeout=10)

    assert removals and removals[0] is not None
    assert removals[0].closed is True
    manager.close_all()


def test_capacity_error_points_to_cleanup_entry(
    config: PlatformConfig, fake_service: FakeService, loop
) -> None:
    """会话数超限：提示里带上已退出的会话数，并指向清理入口。

    已退出的会话也占名额（它们不做自动清理），只说「已达上限」的话用户
    不知道去哪儿腾位置。
    """
    manager = TerminalSessionManager(
        config,
        fake_service,
        spawner=pty_spawner(["sh", "-c", "exit 0"]),
        max_sessions=5,
        max_sessions_per_sandbox=1,
    )
    session = create_session(manager, loop)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not session.exited:
        time.sleep(0.05)
    assert session.exited

    with pytest.raises(ValidationError) as excinfo:
        asyncio.run_coroutine_threadsafe(manager.create("demo"), loop).result(timeout=30)
    message = str(excinfo.value)
    assert "沙箱 demo 的终端会话数已达上限" in message
    assert "1 个已退出待清理" in message
    assert "后端保留的会话" in message
    manager.close_all()


def test_global_capacity_error_mentions_limit(
    config: PlatformConfig, fake_service: FakeService, loop
) -> None:
    """全局会话数超限：提示里带上上限与清理入口。"""
    manager = TerminalSessionManager(
        config,
        fake_service,
        spawner=pty_spawner(["cat"]),
        max_sessions=1,
        max_sessions_per_sandbox=5,
    )
    session = create_session(manager, loop)
    assert session is not None
    try:
        with pytest.raises(ValidationError) as excinfo:
            asyncio.run_coroutine_threadsafe(manager.create("demo"), loop).result(timeout=30)
        message = str(excinfo.value)
        assert "终端会话数已达上限（1 个" in message
        assert "后端保留的会话" in message
    finally:
        manager.close_all()
