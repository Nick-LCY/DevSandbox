"""端口转发服务端接口测试：转发管理 REST + 隧道 WebSocket。

全部在临时目录里跑，不碰真实平台数据根，也不碰宿主沙箱与容器：

- 转发编排入口整体替换成假实现（``dependency_overrides``），只提供路由需要
  的那几个方法（能力本体在核心包，不在服务端）；
- 字节泵用假实现（回显语义 + 关闭记账），用来验证字节透传、任一侧收敛，
  以及「连接断开即回收字节泵进程」；
- 隧道的准入（Bearer）走真实中间件：中间件与路由各校验一道。
"""

from __future__ import annotations

import asyncio
import queue
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sandbox_platform import (
    FORWARD_STATE_RUNNING,
    ForwardError,
    ForwardOpResult,
    ForwardRecord,
    ImageNotFoundError,
    NotFoundError,
    PortForwardManager,
    ValidationError,
)
from starlette.websockets import WebSocketDisconnect
from sandbox_console import create_app
from sandbox_console.auth import WEBSOCKET_BEARER_PATHS

from conftest import auth_headers
from sandbox_console.deps import (
    get_forward_manager,
    get_forward_manager_ws,
    get_tunnel_registry_ws,
)
from sandbox_console.forwards import (
    PUMP_FAILED_MESSAGE,
    PUMP_IO_EXECUTOR,
    PUMP_IO_WORKERS,
    TUNNEL_CLOSE_POLICY,
    TUNNEL_CLOSE_PUMP_ERROR,
    TUNNEL_CLOSE_SHUTDOWN,
    TunnelHandle,
    TunnelRegistry,
    write_all_bytes,
)

# 隧道路径（REST 是 /api/forwards，隧道是 /api/forward/tunnel）
TUNNEL_PATH = "/api/forward/tunnel"

# 假字节泵的读超时（兜底：真 EOF 只在字节泵关闭时出现）
FAKE_PUMP_READ_TIMEOUT = 30.0


# ---------------------------------------------------------------- 假实现
class EchoPump:
    """假字节泵：写进去什么就读出什么（回显）。

    语义对齐核心包的字节泵：

    - ``write`` 返回**实际写入长度**（可能小于入参：部分写入）；
    - ``read`` 阻塞到有数据或 EOF（读到空字节即 EOF）；
    - ``close`` 立即收尾并唤醒阻塞的读（EOF）。

    **读超时不是 EOF**：超时抛异常（真 EOF 只在关闭时出现）——否则一条
    “慢隧道”会被误判成“字节泵那头关了”。
    """

    def __init__(self) -> None:
        self._chunks: queue.Queue[bytes] = queue.Queue()
        self.closed = False
        self.close_count = 0
        self.written = bytearray()
        # 排空线程的 stderr 尾部（核心包字节泵有这个属性）
        self.stderr_text = ""
        # 搬运字节的线程名（验证走的是字节泵专用线程池）
        self.thread_names: list[str] = []

    def write(self, data: bytes) -> int:
        """把字节写进「另一端」（回显）。"""
        self.thread_names.append(threading.current_thread().name)
        if self.closed:
            return 0
        self.written.extend(data)
        self._chunks.put(bytes(data))
        return len(data)

    def read(self, size: int = 65536) -> bytes:
        """读一段字节；EOF 返回空字节。"""
        self.thread_names.append(threading.current_thread().name)
        if self.closed:
            return b""
        try:
            return self._chunks.get(timeout=FAKE_PUMP_READ_TIMEOUT)
        except queue.Empty as exc:
            # 读超时**不是 EOF**：抛异常（收敛挂在桥接任务上）
            raise TimeoutError("假字节泵读超时（字节泵该被关掉了）") from exc

    @property
    def stderr_tail(self) -> str:
        """stderr 尾部（对齐核心包字节泵的属性名）。"""
        return self.stderr_text

    def close(self) -> None:
        """回收字节泵（记账 + 唤醒阻塞的读）。"""
        self.close_count += 1
        if self.closed:
            return
        self.closed = True
        self._chunks.put(b"")

    def finish(self) -> None:
        """模拟字节泵那头关闭（EOF）：读端读到空字节。"""
        self._chunks.put(b"")


class PartialWritePump(EchoPump):
    """每次只写进一小截的字节泵（模拟裸管道的部分写入）。"""

    def __init__(self, chunk: int = 3) -> None:
        super().__init__()
        self.chunk = chunk

    def write(self, data: bytes) -> int:
        """只写进前 chunk 个字节（返回实际写入长度）。"""
        if self.closed:
            return 0
        part = data[: self.chunk]
        self.written.extend(part)
        self._chunks.put(bytes(part))
        return len(part)


class FakeForwardManager:
    """假的转发编排入口：只提供路由需要的几个方法。"""

    def __init__(self) -> None:
        self.records: dict[str, ForwardRecord] = {}
        self.pumps: list[EchoPump] = []
        self.create_error: Exception | None = None
        self.stop_error: Exception | None = None
        self.pump_error: Exception | None = None
        self.find_error: Exception | None = None
        # 标识生成用计数器（不能用记录数：删掉记录后编号会撞号）
        self._counter = 0

    # -- 查询
    def list(self, sandbox: str | None = None) -> list[ForwardRecord]:
        """列出转发记录（可按沙箱过滤）。"""
        records = list(self.records.values())
        if sandbox:
            records = [item for item in records if item.sandbox == sandbox]
        return records

    def find(self, forward_id: str) -> ForwardRecord | None:
        """按标识取转发记录。"""
        if self.find_error is not None:
            raise self.find_error
        return self.records.get(forward_id)

    # -- 建立
    def create(self, sandbox: str, container_port: int) -> ForwardRecord:
        """建立转发（出错时按核心包的口径抛异常）。"""
        if self.create_error is not None:
            raise self.create_error
        self._counter += 1
        record = ForwardRecord(
            id=f"{self._counter:012x}",
            sandbox=sandbox,
            container_port=container_port,
            state=FORWARD_STATE_RUNNING,
            host_pid=1,
        )
        self.records[record.id] = record
        return record

    # -- 停止
    def stop(self, forward_id: str) -> ForwardOpResult:
        """停止转发（删记录）。"""
        if self.stop_error is not None:
            raise self.stop_error
        if forward_id not in self.records:
            raise NotFoundError(f"端口转发不存在：{forward_id}")
        del self.records[forward_id]
        return ForwardOpResult(removed=(f"转发记录 {forward_id}",), failed=())

    # -- 字节泵
    def open_byte_pump(self, record: ForwardRecord) -> EchoPump:
        """起一条字节泵（回显实现）。"""
        if self.pump_error is not None:
            raise self.pump_error
        pump = EchoPump()
        self.pumps.append(pump)
        return pump


def make_record(forward_id: str = "a1b2c3d4e5f6", **kwargs: Any) -> ForwardRecord:
    """构造一条转发记录。"""
    payload: dict[str, Any] = {
        "id": forward_id,
        "sandbox": "demo",
        "container_port": 8080,
        "state": FORWARD_STATE_RUNNING,
        "host_pid": 1,
    }
    payload.update(kwargs)
    return ForwardRecord(**payload)


def wait_for(predicate, timeout: float = 5.0) -> bool:
    """等一个条件成立（最多等 timeout 秒）。"""
    deadline = time.monotonic() + timeout
    while True:
        if predicate():
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


# ---------------------------------------------------------------- 夹具
@pytest.fixture
def manager() -> FakeForwardManager:
    """假的转发编排入口。"""
    return FakeForwardManager()


@pytest.fixture
def client(
    manager: FakeForwardManager,
    platform_home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    """测试客户端（转发编排入口整体替换）。"""
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    app = create_app()
    app.dependency_overrides[get_forward_manager] = lambda: manager
    app.dependency_overrides[get_forward_manager_ws] = lambda: manager
    with TestClient(app, headers=auth_headers()) as http_client:
        yield http_client


# ---------------------------------------------------------------- 字节泵搬运
def test_write_all_bytes_loops_on_partial_writes() -> None:
    """部分写入要循环：裸管道一次写不全是常态，必须循环到写完。"""
    pump = PartialWritePump(chunk=3)
    written = write_all_bytes(pump, b"0123456789")
    assert written == 10
    assert bytes(pump.written) == b"0123456789"


def test_write_all_bytes_stops_when_the_pump_is_closed() -> None:
    """字节泵已关：写入返回 0（写入侧据此收敛）。"""
    pump = EchoPump()
    pump.close()
    assert write_all_bytes(pump, b"ping") == 0


# ---------------------------------------------------------------- REST：列表
def test_list_forwards_returns_a_bare_array(client: TestClient) -> None:
    """GET /api/forwards：裸数组（不包对象）。"""
    response = client.get("/api/forwards")
    assert response.status_code == 200
    assert response.json() == []


def test_list_forwards_returns_records(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """列表项字段固定：id / sandbox / container_port / state / 时间戳。"""
    manager.records["a1b2c3d4e5f6"] = make_record()
    response = client.get("/api/forwards")
    assert response.status_code == 200
    body = response.json()
    assert isinstance(body, list)
    assert len(body) == 1
    assert body[0]["id"] == "a1b2c3d4e5f6"
    assert body[0]["sandbox"] == "demo"
    assert body[0]["container_port"] == 8080
    assert body[0]["state"] == "running"
    # 宿主侧不再有转发端口：响应里不出现宿主端口字段
    assert "host_port" not in body[0]
    assert "host_port" not in response.text


# ---------------------------------------------------------------- REST：建立
def test_create_forward_returns_the_record(client: TestClient) -> None:
    """POST /api/forwards：按 {sandbox, port} 建立并返回记录（201）。"""
    response = client.post("/api/forwards", json={"sandbox": "demo", "port": 8080})
    assert response.status_code == 201
    body = response.json()
    assert body["sandbox"] == "demo"
    assert body["container_port"] == 8080
    assert body["state"] == "running"
    assert body["id"]
    assert "host_port" not in body


def test_create_forward_with_unknown_sandbox_returns_404(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """沙箱不存在：404 + 中文 detail。"""
    manager.create_error = NotFoundError("沙箱不存在：nope")
    response = client.post("/api/forwards", json={"sandbox": "nope", "port": 8080})
    assert response.status_code == 404
    assert response.json() == {"detail": "沙箱不存在：nope"}


def test_create_forward_with_invalid_port_returns_400(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """端口非法：400 + 中文 detail。"""
    manager.create_error = ValidationError("容器端口非法：70000（应为 1~65535）")
    response = client.post("/api/forwards", json={"sandbox": "demo", "port": 70000})
    assert response.status_code == 400
    assert "端口非法" in response.json()["detail"]


def test_create_forward_with_stopped_sandbox_returns_409(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """沙箱已停止：409 + 中文 detail（带「先启动沙箱」的可执行建议）。"""
    manager.create_error = ForwardError(
        "沙箱已停止，无法建立端口转发：demo（请先启动沙箱）"
    )
    response = client.post("/api/forwards", json={"sandbox": "demo", "port": 8080})
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert "沙箱已停止" in detail
    assert "请先启动沙箱" in detail


def test_create_forward_with_conflicting_container_name_returns_409(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """容器名与现有非平台容器重名：409（平台不删用户的同名容器）。"""
    manager.create_error = ForwardError(
        "容器名 demo-fwd-8080 已被占用：与现有非平台容器重名"
        "（该容器不是平台自建的转发容器，平台不会删除它）"
    )
    response = client.post("/api/forwards", json={"sandbox": "demo", "port": 8080})
    assert response.status_code == 409
    assert "重名" in response.json()["detail"]


def test_create_forward_with_broken_link_returns_503(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """转发容器起不来：503；宿主侧细节只进日志，不回显到响应。"""
    manager.create_error = ForwardError(
        "启动转发容器失败：demo-fwd-8080（容器客户端输出：宿主绝对路径 /var/lib/x）"
    )
    response = client.post("/api/forwards", json={"sandbox": "demo", "port": 8080})
    assert response.status_code == 503
    detail = response.json()["detail"]
    assert "启动转发容器失败" in detail
    assert "/var/lib/x" not in detail


def test_create_forward_with_multiline_output_returns_only_the_fixed_trunk(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """**无括号的多行**原文：响应只给固定主干文案。

    旧口径靠「按全角括号截断」取主干：没有括号的原文（容器客户端的多行
    输出）会被**整段**回显——响应里出现宿主路径与多行原文。
    """
    manager.create_error = ForwardError(
        "启动转发容器失败：Unable to find image 'alpine/socat:1.8.1.3'\n"
        "docker: Error response from daemon: pull access denied\n"
        "/var/lib/docker/overlay2/abcdef: no such file or directory"
    )
    response = client.post("/api/forwards", json={"sandbox": "demo", "port": 8080})
    assert response.status_code == 503
    detail = response.json()["detail"]
    assert detail == "启动转发容器失败"
    assert "\n" not in detail
    assert "Unable to find image" not in detail
    assert "/var/lib/docker" not in detail
    assert "pull access denied" not in response.text


def test_create_forward_with_parenthesised_detail_returns_only_the_fixed_trunk(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """带括号的原文：同样只回固定主干（不靠括号截取）。"""
    manager.create_error = ForwardError(
        "启动转发容器失败：demo-fwd-8080（容器客户端输出：宿主绝对路径 /var/lib/x）"
    )
    response = client.post("/api/forwards", json={"sandbox": "demo", "port": 8080})
    assert response.status_code == 503
    detail = response.json()["detail"]
    assert detail == "启动转发容器失败"
    assert "/var/lib/x" not in detail
    assert "demo-fwd-8080" not in detail


def test_create_forward_with_missing_image_returns_503(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """镜像拉不到：503（转发链路暂不可用），不是 400（入参错误）。"""
    manager.create_error = ImageNotFoundError(
        "镜像 alpine/socat:1.8.1.3 不可用：经统一镜像代理拉取失败"
        "（宿主绝对路径 /var/lib/x），宿主也没有该镜像的本地副本可注入"
    )
    response = client.post("/api/forwards", json={"sandbox": "demo", "port": 8080})
    assert response.status_code == 503
    detail = response.json()["detail"]
    assert detail == "转发镜像不可用（镜像拉不到）"
    assert "/var/lib/x" not in detail
    assert "alpine/socat" not in detail


@pytest.mark.parametrize(
    ("method", "path", "kwargs"),
    [
        ("GET", "/api/forwards", {}),
        ("POST", "/api/forwards", {"json": {"sandbox": "demo", "port": 8080}}),
        ("DELETE", "/api/forwards/a1b2c3d4e5f6", {}),
    ],
)
def test_forward_rest_requires_a_token(
    client: TestClient, method: str, path: str, kwargs: dict
) -> None:
    """三条转发 REST 不带令牌：401（与其它 /api 接口同口径）。"""
    response = client.request(method, path, headers={"Authorization": ""}, **kwargs)
    assert response.status_code == 401
    assert response.json() == {"detail": "访问令牌无效或缺失"}


def test_create_forward_rejects_extra_fields(client: TestClient) -> None:
    """请求体多传字段：400（extra="forbid"，不静默吞掉）。"""
    response = client.post(
        "/api/forwards",
        json={"sandbox": "demo", "port": 8080, "host_port": 18080},
    )
    assert response.status_code == 400
    assert "不允许的字段" in response.json()["detail"]


# ---------------------------------------------------------------- REST：停止
def test_delete_forward_stops_it(client: TestClient, manager: FakeForwardManager) -> None:
    """DELETE /api/forwards/{id}：停转发（删记录），回报处理清单。"""
    manager.records["a1b2c3d4e5f6"] = make_record()
    response = client.delete("/api/forwards/a1b2c3d4e5f6")
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "a1b2c3d4e5f6"
    assert body["removed"]
    assert body["failed"] == []
    assert manager.records == {}
    assert client.get("/api/forwards").json() == []


def test_delete_unknown_forward_returns_404(client: TestClient) -> None:
    """停止不存在的转发：404。"""
    response = client.delete("/api/forwards/a1b2c3d4e5f6")
    assert response.status_code == 404
    assert response.json() == {"detail": "端口转发不存在或已失效"}


def test_delete_forward_with_invalid_id_returns_404_without_echoing(
    client: TestClient,
) -> None:
    """标识非法：按「不存在」处理，且不回显用户输入。"""
    response = client.delete("/api/forwards/not-a-valid-id")
    assert response.status_code == 404
    detail = response.json()["detail"]
    assert detail == "端口转发不存在或已失效"
    assert "not-a-valid-id" not in response.text


def test_delete_forward_twice_returns_404_the_second_time(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """重复删除：首次 200（已停），二次 404（已不存在）。

    语义：**停止转发是幂等的**——第二次没有可停的东西，按「不存在」报 404。
    """
    manager.records["a1b2c3d4e5f6"] = make_record()
    first = client.delete("/api/forwards/a1b2c3d4e5f6")
    assert first.status_code == 200
    assert first.json()["removed"]
    second = client.delete("/api/forwards/a1b2c3d4e5f6")
    assert second.status_code == 404
    assert second.json() == {"detail": "端口转发不存在或已失效"}


def test_delete_forward_with_corrupted_record_does_not_echo_the_host_path(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """记录损坏：固定文案 + 不回显宿主绝对路径。

    平台侧的记录异常原文带宿主路径（``转发记录文件损坏：/var/lib/...``）：
    全局异常处理会把它当 400 直接回显——这里收敛成固定文案。
    """
    manager.stop_error = ValidationError(
        "转发记录文件损坏：/var/lib/sandbox-platform/forwards/a1b2c3d4e5f6.json"
    )
    response = client.delete("/api/forwards/a1b2c3d4e5f6")
    assert response.status_code == 404
    assert response.json() == {"detail": "端口转发不存在或已失效"}
    assert "/var/lib" not in response.text
    assert "a1b2c3d4e5f6" not in response.text


# ---------------------------------------------------------------- 隧道：准入
def test_tunnel_path_is_registered_in_the_bearer_list() -> None:
    """隧道 WS 登记在 Bearer 清单里（中间件校验令牌）。"""
    assert TUNNEL_PATH in WEBSOCKET_BEARER_PATHS


def test_tunnel_without_bearer_is_rejected(client: TestClient) -> None:
    """隧道 WS 不带令牌：握手被拒（1008），不 accept。

    口径提醒：握手在 accept 之前被拒，生产环境（uvicorn）表现为 HTTP 403，
    TestClient 下才是 ``WebSocketDisconnect(1008)``。
    """
    with pytest.raises(WebSocketDisconnect) as failure:
        with client.websocket_connect(
            f"{TUNNEL_PATH}/a1b2c3d4e5f6", headers={"Authorization": ""}
        ):
            pass
    assert failure.value.code == 1008


def test_tunnel_with_wrong_bearer_is_rejected(client: TestClient) -> None:
    """隧道 WS 带错令牌：握手被拒（1008）。"""
    with pytest.raises(WebSocketDisconnect) as failure:
        with client.websocket_connect(
            f"{TUNNEL_PATH}/a1b2c3d4e5f6", headers=auth_headers("sbx_wrong_token")
        ):
            pass
    assert failure.value.code == 1008


def test_unregistered_websocket_route_is_rejected_even_with_a_valid_token(
    platform_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """未登记的 WS 路由：即便带着有效令牌也拒握手（fail-closed 默认）。

    两份准入清单（豁免清单 / Bearer 清单）都没登记的路径一律拒握手：
    新增 WS 路由而忘了写鉴权时，默认被拒，不是裸奔。
    """
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    app = create_app()

    from starlette.websockets import WebSocket

    @app.websocket("/api/not-registered/ws")
    async def _bare_websocket(websocket: WebSocket) -> None:
        await websocket.accept()
        await websocket.send_text("裸奔")

    with TestClient(app, headers=auth_headers()) as client:
        with pytest.raises(WebSocketDisconnect) as failure:
            with client.websocket_connect("/api/not-registered/ws"):
                pass
    assert failure.value.code == 1008


# ---------------------------------------------------------------- 隧道：协议
def test_tunnel_with_unknown_forward_closes_with_1008(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """转发不存在：回一条错误帧，再按 1008 关闭。"""
    with client.websocket_connect(f"{TUNNEL_PATH}/a1b2c3d4e5f6") as ws:
        message = ws.receive_json()
        assert message["type"] == "error"
        assert "端口转发不存在" in message["message"]
        with pytest.raises(WebSocketDisconnect) as failure:
            ws.receive_json()
    assert failure.value.code == 1008


def test_tunnel_with_stopped_forward_closes_with_1008(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """转发已停止（沙箱停过）：字节泵起不来 → 错误帧 + 关闭码 1008。"""
    manager.records["a1b2c3d4e5f6"] = make_record()
    manager.pump_error = ForwardError(
        "沙箱已停止，无法建立端口转发：demo（请先启动沙箱）"
    )
    with client.websocket_connect(f"{TUNNEL_PATH}/a1b2c3d4e5f6") as ws:
        message = ws.receive_json()
        assert message["type"] == "error"
        assert "沙箱已停止" in message["message"]
        with pytest.raises(WebSocketDisconnect) as failure:
            ws.receive_json()
    assert failure.value.code == 1008


def test_tunnel_error_frame_uses_the_fixed_trunk(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """错误帧与 REST **同一口径**：只给固定主干文案，原文不进帧。

    核心异常原文（容器客户端输出、宿主路径）只进日志。
    """
    manager.records["a1b2c3d4e5f6"] = make_record()
    manager.pump_error = ForwardError(
        "启动转发容器失败：demo-fwd-8080（容器客户端输出：宿主绝对路径 /var/lib/x）"
    )
    with client.websocket_connect(f"{TUNNEL_PATH}/a1b2c3d4e5f6") as ws:
        message = ws.receive_json()
        assert message["type"] == "error"
        assert message["message"] == "启动转发容器失败"
        assert "/var/lib/x" not in message["message"]
        assert "demo-fwd-8080" not in message["message"]
        with pytest.raises(WebSocketDisconnect) as failure:
            ws.receive_json()
    assert failure.value.code == TUNNEL_CLOSE_POLICY


def test_tunnel_with_deleted_sandbox_closes_with_1008(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """记录在但沙箱已删：错误帧 + **1008**（不是 1011 的无错误帧关断）。

    这条路径现实可达：删沙箱时转发容器删不掉会保留记录。
    """
    manager.records["a1b2c3d4e5f6"] = make_record()
    manager.pump_error = NotFoundError("沙箱不存在：demo")
    with client.websocket_connect(f"{TUNNEL_PATH}/a1b2c3d4e5f6") as ws:
        message = ws.receive_json()
        assert message["type"] == "error"
        assert "沙箱不存在" in message["message"]
        with pytest.raises(WebSocketDisconnect) as failure:
            ws.receive_json()
    assert failure.value.code == TUNNEL_CLOSE_POLICY
    assert failure.value.code != 1011


def test_tunnel_with_corrupted_record_closes_with_1008(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """记录损坏（起泵时）：错误帧 + 1008，不回显宿主路径。"""
    manager.records["a1b2c3d4e5f6"] = make_record()
    manager.pump_error = ValidationError(
        "转发记录文件损坏：/var/lib/sandbox-platform/forwards/a1b2c3d4e5f6.json"
    )
    with client.websocket_connect(f"{TUNNEL_PATH}/a1b2c3d4e5f6") as ws:
        message = ws.receive_json()
        assert message["type"] == "error"
        assert "/var/lib" not in message["message"]
        with pytest.raises(WebSocketDisconnect) as failure:
            ws.receive_json()
    assert failure.value.code == TUNNEL_CLOSE_POLICY


def test_tunnel_with_unreadable_record_closes_with_1008(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """记录读不出来（取记录时）：错误帧 + 1008，不回显宿主路径。"""
    manager.find_error = ValidationError(
        "转发记录文件损坏：/var/lib/sandbox-platform/forwards/a1b2c3d4e5f6.json"
    )
    with client.websocket_connect(f"{TUNNEL_PATH}/a1b2c3d4e5f6") as ws:
        message = ws.receive_json()
        assert message["type"] == "error"
        assert "/var/lib" not in message["message"]
        with pytest.raises(WebSocketDisconnect) as failure:
            ws.receive_json()
    assert failure.value.code == TUNNEL_CLOSE_POLICY


def test_tunnel_transports_bytes_both_ways(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """隧道正常：二进制帧双向透传（字节一致）。"""
    manager.records["a1b2c3d4e5f6"] = make_record()
    with client.websocket_connect(f"{TUNNEL_PATH}/a1b2c3d4e5f6") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello"
        assert hello["forward_id"] == "a1b2c3d4e5f6"
        assert hello["sandbox"] == "demo"
        assert hello["container_port"] == 8080

        ws.send_bytes(b"ping")
        assert ws.receive_bytes() == b"ping"

        ws.send_bytes(b"\x00\x01\x02binary")
        assert ws.receive_bytes() == b"\x00\x01\x02binary"


def test_tunnel_handles_text_control_frames(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """文本帧只做控制：hello 握手回 hello，未知指令回错误帧。"""
    manager.records["a1b2c3d4e5f6"] = make_record()
    with client.websocket_connect(f"{TUNNEL_PATH}/a1b2c3d4e5f6") as ws:
        assert ws.receive_json()["type"] == "hello"

        ws.send_json({"type": "hello"})
        assert ws.receive_json()["type"] == "hello"

        ws.send_json({"type": "bogus"})
        error = ws.receive_json()
        assert error["type"] == "error"
        assert "无法识别" in error["message"]

        ws.send_text("not-json")
        error = ws.receive_json()
        assert error["type"] == "error"
        assert "JSON" in error["message"]


def test_tunnel_converges_and_reclaims_the_pump_when_client_disconnects(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """客户端断开：隧道收敛，字节泵进程被回收（不留僵尸进程）。"""
    manager.records["a1b2c3d4e5f6"] = make_record()
    with client.websocket_connect(f"{TUNNEL_PATH}/a1b2c3d4e5f6") as ws:
        assert ws.receive_json()["type"] == "hello"
        ws.send_bytes(b"ping")
        assert ws.receive_bytes() == b"ping"

    assert manager.pumps, "隧道应当起过字节泵"
    pump = manager.pumps[0]
    assert wait_for(lambda: pump.closed), "断开后字节泵必须被回收"
    assert pump.close_count >= 1


def test_tunnel_converges_when_the_byte_pump_reaches_eof(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """字节泵那头 EOF（没有 stderr 输出）：另一侧随之关闭（隧道收敛）。"""
    manager.records["a1b2c3d4e5f6"] = make_record()
    with client.websocket_connect(f"{TUNNEL_PATH}/a1b2c3d4e5f6") as ws:
        assert ws.receive_json()["type"] == "hello"
        assert manager.pumps
        manager.pumps[0].finish()
        with pytest.raises(WebSocketDisconnect):
            for _ in range(5):
                ws.receive_bytes()


def test_tunnel_reports_the_reason_when_the_byte_pump_fails(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """exec 失败（失败原因只在 stderr 里）：客户端收到**带原因的错误帧**。

    旧口径：stderr 没人排空，失败原因看不见，客户端只看到**静默关断**。
    """
    manager.records["a1b2c3d4e5f6"] = make_record()
    with client.websocket_connect(f"{TUNNEL_PATH}/a1b2c3d4e5f6") as ws:
        assert ws.receive_json()["type"] == "hello"
        assert manager.pumps
        pump = manager.pumps[0]
        pump.stderr_text = (
            "docker: Error response from daemon: no such container\n"
            "/var/lib/sandbox-platform/forwards/a1b2c3d4e5f6.json"
        )
        pump.finish()
        message = ws.receive_json()
        assert message["type"] == "error"
        assert message["message"] == PUMP_FAILED_MESSAGE
        # 原文只进日志，不回显给客户端
        assert "/var/lib" not in message["message"]
        with pytest.raises(WebSocketDisconnect) as failure:
            ws.receive_json()
    assert failure.value.code == TUNNEL_CLOSE_PUMP_ERROR


def test_tunnel_uses_a_dedicated_thread_pool_for_the_byte_pump(
    client: TestClient, manager: FakeForwardManager
) -> None:
    """字节泵的读写走**专用线程池**：不与事件循环的默认执行器抢线程。

    默认执行器容量只有十几个：并发隧道一多，读写互相等线程（饿死）。
    """
    assert PUMP_IO_WORKERS == 32
    assert PUMP_IO_EXECUTOR._max_workers == PUMP_IO_WORKERS
    manager.records["a1b2c3d4e5f6"] = make_record()
    with client.websocket_connect(f"{TUNNEL_PATH}/a1b2c3d4e5f6") as ws:
        assert ws.receive_json()["type"] == "hello"
        ws.send_bytes(b"ping")
        assert ws.receive_bytes() == b"ping"
    assert manager.pumps
    names = manager.pumps[0].thread_names
    assert names, "字节泵的读写应当跑在线程里"
    assert all(name.startswith("sandbox-pump-io") for name in names)


def test_tunnels_are_closed_when_the_service_stops(
    manager: FakeForwardManager,
    platform_home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """服务退出：活动隧道全部关掉（字节泵进程一并回收）。"""
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    app = create_app()
    app.dependency_overrides[get_forward_manager] = lambda: manager
    app.dependency_overrides[get_forward_manager_ws] = lambda: manager
    manager.records["a1b2c3d4e5f6"] = make_record()
    with TestClient(app, headers=auth_headers()) as client:
        with client.websocket_connect(f"{TUNNEL_PATH}/a1b2c3d4e5f6") as ws:
            assert ws.receive_json()["type"] == "hello"
            assert manager.pumps
            pump = manager.pumps[0]
    assert wait_for(lambda: pump.closed), "服务退出时活动隧道必须被关掉"


# ---------------------------------------------------------------- 生命周期
def test_startup_purges_leftover_forwards(
    platform_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """服务启动：清理上次遗留的转发容器与记录（与终端会话同款语义）。"""
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    calls: list[int] = []

    def fake_purge(self) -> ForwardOpResult:
        calls.append(1)
        return ForwardOpResult(removed=("转发记录 a1b2c3d4e5f6",))

    monkeypatch.setattr(PortForwardManager, "purge_leftover", fake_purge)
    app = create_app()
    with TestClient(app, headers=auth_headers()) as client:
        assert client.get("/api/health").status_code == 200
    assert calls, "启动时必须调用 purge_leftover 清理遗留转发"


def test_tunnel_registry_is_shared_by_the_app(
    platform_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """活动隧道登记表挂在应用状态上（整个进程共用一个，依赖注入取的就是它）。"""
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    app = create_app()
    registry = app.state.tunnel_registry
    assert registry is not None
    assert registry.count == 0

    class _FakeWebSocket:
        app = None

    fake = _FakeWebSocket()
    fake.app = app
    assert get_tunnel_registry_ws(fake) is registry


# ---------------------------------------------------------------- 登记表：关闭竞态
class FakeWebSocket:
    """假 WebSocket：只记关闭码。"""

    def __init__(self) -> None:
        self.close_codes: list[int] = []

    async def close(self, code: int = 1000) -> None:
        """记下关闭码（对齐 Starlette 的 close 签名）。"""
        self.close_codes.append(code)


def test_registry_rejects_tunnels_registered_after_close_all() -> None:
    """服务退出后（close_all）再登记：连接**立即被按 1001 关掉**，泵照常回收。

    竞态窗口有两个：``accept`` 与 ``registry.register`` 之间，以及
    ``close_all`` 跑完之后才来登记。两者都归这条「正在关闭」标志管。
    """
    registry = TunnelRegistry()
    pump = EchoPump()
    websocket = FakeWebSocket()

    async def scenario() -> TunnelHandle:
        await registry.close_all()
        return await registry.register("a1b2c3d4e5f6", websocket, pump)

    handle = asyncio.run(scenario())
    assert handle.accepted is False
    assert websocket.close_codes == [TUNNEL_CLOSE_SHUTDOWN]
    assert pump.closed, "被拒的隧道：字节泵要照常回收（不留僵尸进程）"
    assert registry.count == 0
    assert registry.closing is True
