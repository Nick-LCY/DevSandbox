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
import struct
import sys
import termios
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sandbox_platform import (
    NotFoundError,
    PlatformConfig,
    PtyProcess,
    SandboxMetadata,
    ValidationError,
    spawn_pty,
)
from sandbox_platform.server import create_app
from sandbox_platform.server.deps import get_terminal_manager, get_terminal_manager_ws
from sandbox_platform.server.sessions import (
    SESSION_STATE_EXITED,
    SESSION_STATE_ORPHANED,
    SESSION_STATE_RUNNING,
    TerminalSessionRecord,
    TerminalSessionTable,
    prepare_sessions_dir,
    purge_leftover_sessions,
)
from sandbox_platform.server.terminal import (
    TerminalSession,
    TerminalSessionManager,
    TerminalSpawnRequest,
)

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
        return item if item is not None else b""

    return asyncio.run_coroutine_threadsafe(_take(), loop).result(timeout=timeout + 10)


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
        session.close()


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
        stored = TerminalSessionTable(config).load(session.session_id)
        assert stored is not None
        assert stored.attached_count == 2

        session.detach()
        stored = TerminalSessionTable(config).load(session.session_id)
        assert stored is not None
        assert stored.attached_count == 1
    finally:
        session.close()


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
        first.close()
        second.close()


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
        session.close()


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
        session.close()


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
    stored = TerminalSessionTable(config).load(session.session_id)
    assert stored is not None
    assert stored.state == SESSION_STATE_EXITED
    assert stored.exit_code == 7
    session.close()


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
