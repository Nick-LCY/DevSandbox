"""服务层接口测试：路由编排与错误映射。

生命周期服务在这里被整体桩掉：测试不触碰宿主（不建用户、不起容器、
不跑任何宿主命令），只验证「HTTP 载荷 → 核心包入参」与「核心包结果 → HTTP 响应」
两头的转译是否正确，以及错误映射是否固定。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sandbox_platform import (
    AlreadyExistsError,
    ConnectionInfo,
    CreateRequest,
    CreateResult,
    DeleteResult,
    LifecycleError,
    NotFoundError,
    PlatformConfig,
    ReclaimPlan,
    SandboxMetadata,
    ValidationError,
)
from sandbox_platform.server import create_app
from sandbox_platform.server.deps import get_service

import sandbox_platform.server as server_package

SERVER_DIR = Path(server_package.__file__).resolve().parent


# ---------------------------------------------------------------- 桩件
def make_metadata(name: str = "demo", state: str = "running") -> SandboxMetadata:
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
        state=state,
        created_at="2026-10-29T01:00:00+00:00",
        updated_at="2026-10-29T01:00:00+00:00",
    )


class FakeSandboxService:
    """假的生命周期服务：只记录调用，不触碰宿主。"""

    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.calls: list[tuple[str, tuple[Any, ...]]] = []
        self.metadata = make_metadata()
        self.config = PlatformConfig.from_env(
            {"SANDBOX_PLATFORM_HOME": "/tmp/sandbox-platform-test"}
        )

    def _record(self, action: str, *args: Any) -> None:
        self.calls.append((action, args))
        if self.error is not None:
            raise self.error

    def create(self, request: CreateRequest) -> CreateResult:
        self._record("create", request)
        return CreateResult(
            metadata=self.metadata,
            connection=ConnectionInfo(
                socket_path="/run/user/1001/docker.sock",
                container_name="sandbox-demo",
                exec_command="sudo -u sandbox-demo env docker exec -it sandbox-demo bash",
                docker_command="sudo -u sandbox-demo env docker ps",
                notes=("平台不预置任何默认目录",),
            ),
            steps=("创建专属用户", "登记子 UID/GID 段"),
        )

    def list(self) -> list[SandboxMetadata]:
        self._record("list")
        return [self.metadata, make_metadata("other", state="stopped")]

    def get(self, name: str) -> SandboxMetadata:
        self._record("get", name)
        return self.metadata

    def start(self, name: str) -> SandboxMetadata:
        self._record("start", name)
        return self.metadata

    def stop(self, name: str, stop_dependencies: bool = True) -> SandboxMetadata:
        self._record("stop", name, stop_dependencies)
        return self.metadata

    def reclaim_plan(self, name: str) -> ReclaimPlan:
        self._record("reclaim_plan", name)
        return ReclaimPlan(
            sandbox_name=name,
            items=("沙箱容器 sandbox-demo", "系统用户 sandbox-demo 与家目录 /home/sandbox-demo"),
            untouched_note="用户挂载的宿主机目录不受影响",
            user_mounts=("/tmp/demo",),
            incomplete=False,
        )

    def delete(self, name: str) -> DeleteResult:
        self._record("delete", name)
        return DeleteResult(
            name=name,
            existed=True,
            removed=("容器 sandbox-demo", "系统用户 sandbox-demo 与家目录 /home/sandbox-demo"),
            failed=("平台元数据 /var/lib/sandbox-platform/sandboxes/demo 删除失败",),
            plan=self.reclaim_plan(name),
        )


@pytest.fixture
def fake_service() -> FakeSandboxService:
    """假的生命周期服务实例。"""
    return FakeSandboxService()


@pytest.fixture
def client(fake_service: FakeSandboxService) -> TestClient:
    """测试客户端（生命周期服务已整体桩掉）。"""
    app = create_app()
    app.dependency_overrides[get_service] = lambda: fake_service
    return TestClient(app)


# ---------------------------------------------------------------- 沙箱管理接口
def test_create_sandbox_returns_steps_and_connection(
    client: TestClient, fake_service: FakeSandboxService
) -> None:
    """创建沙箱：返回步骤、连接方式与沙箱详情。"""
    response = client.post("/api/sandboxes", json={"name": "demo", "image": "busybox:1.37"})
    assert response.status_code == 200
    body = response.json()
    assert body["steps"] == ["创建专属用户", "登记子 UID/GID 段"]
    assert body["connection"]["container_name"] == "sandbox-demo"
    assert body["metadata"]["name"] == "demo"
    assert body["metadata"]["image"] == "busybox:1.37"


def test_create_sandbox_defaults_to_auto_image_source(
    client: TestClient, fake_service: FakeSandboxService
) -> None:
    """不传 image_source 时按 auto（一期行为）转成核心包入参。"""
    client.post("/api/sandboxes", json={"name": "demo"})
    action, args = fake_service.calls[-1]
    assert action == "create"
    request: CreateRequest = args[0]
    assert request.image_source == "auto"
    assert request.name == "demo"


def test_create_sandbox_forwards_host_image_source(
    client: TestClient, fake_service: FakeSandboxService
) -> None:
    """image_source=host 原样转给核心包（强制从宿主注入，不经镜像代理）。"""
    client.post("/api/sandboxes", json={"name": "demo", "image_source": "host"})
    request: CreateRequest = fake_service.calls[-1][1][0]
    assert request.image_source == "host"


def test_create_sandbox_translates_mounts_and_command(
    client: TestClient, fake_service: FakeSandboxService
) -> None:
    """挂载声明与启动命令按核心包语义转译。"""
    client.post(
        "/api/sandboxes",
        json={
            "name": "demo",
            "mounts": ["/tmp/demo:/data:ro"],
            "command": "sleep infinity",
            "env": {"KEY": "value"},
            "workdir": "/data",
            "network": "demo-net",
        },
    )
    request: CreateRequest = fake_service.calls[-1][1][0]
    assert request.mount_declarations == ("/tmp/demo:/data:ro",)
    assert request.command == ("sleep", "infinity")
    assert request.env == {"KEY": "value"}
    assert request.workdir == "/data"
    assert request.network_name == "demo-net"


def test_list_sandboxes_returns_name_state_image_and_created_at(
    client: TestClient,
) -> None:
    """列表：全部沙箱（含停止态），字段为名字 / 状态 / 镜像 / 创建时间。"""
    response = client.get("/api/sandboxes")
    assert response.status_code == 200
    items = response.json()
    assert len(items) == 2
    assert set(items[0]) == {"name", "state", "state_label", "image", "created_at"}
    assert items[0]["name"] == "demo"
    assert items[1]["state"] == "stopped"


def test_get_sandbox_detail(client: TestClient) -> None:
    """详情：单沙箱的完整信息。"""
    response = client.get("/api/sandboxes/demo")
    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "demo"
    assert body["container_name"] == "sandbox-demo"
    assert body["state_label"] == "运行中"


def test_start_sandbox(client: TestClient, fake_service: FakeSandboxService) -> None:
    """启动沙箱。"""
    response = client.post("/api/sandboxes/demo/start")
    assert response.status_code == 200
    assert response.json()["name"] == "demo"
    assert ("start", ("demo",)) in fake_service.calls


def test_stop_sandbox_stops_dependencies_by_default(
    client: TestClient, fake_service: FakeSandboxService
) -> None:
    """停止沙箱：默认连依赖容器一起停。"""
    response = client.post("/api/sandboxes/demo/stop")
    assert response.status_code == 200
    assert ("stop", ("demo", True)) in fake_service.calls


def test_stop_sandbox_can_keep_dependencies(
    client: TestClient, fake_service: FakeSandboxService
) -> None:
    """停止沙箱：显式要求保留依赖容器。"""
    response = client.post("/api/sandboxes/demo/stop", json={"stop_dependencies": False})
    assert response.status_code == 200
    assert ("stop", ("demo", False)) in fake_service.calls


def test_reclaim_plan_lists_items_and_untouched_note(client: TestClient) -> None:
    """回收清单：含条目、固定提示语、用户挂载目录与是否可能不完整。"""
    response = client.get("/api/sandboxes/demo/reclaim")
    assert response.status_code == 200
    body = response.json()
    assert body["sandbox_name"] == "demo"
    assert "沙箱容器 sandbox-demo" in body["items"]
    assert body["untouched_note"] == "用户挂载的宿主机目录不受影响"
    assert body["user_mounts"] == ["/tmp/demo"]
    assert body["incomplete"] is False


def test_delete_sandbox_returns_removed_and_failed(client: TestClient) -> None:
    """删除：如实返回已回收与未回收的条目。"""
    response = client.delete("/api/sandboxes/demo")
    assert response.status_code == 200
    body = response.json()
    assert body["existed"] is True
    assert "容器 sandbox-demo" in body["removed"]
    assert body["failed"]
    assert body["plan"]["untouched_note"] == "用户挂载的宿主机目录不受影响"


def test_health_endpoint(client: TestClient) -> None:
    """服务自检：版本与平台数据根。"""
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["platform_home"]


# ---------------------------------------------------------------- 错误映射
@pytest.mark.parametrize(
    ("error", "status_code"),
    [
        (ValidationError("沙箱名非法：'Bad Name'"), 400),
        (NotFoundError("沙箱不存在：demo"), 404),
        (AlreadyExistsError("沙箱已存在：demo"), 409),
        (LifecycleError("启动沙箱容器", "启动沙箱容器失败"), 500),
    ],
)
def test_platform_errors_map_to_fixed_status_codes(
    fake_service: FakeSandboxService, error: Exception, status_code: int
) -> None:
    """错误映射固定：400 / 404 / 409 / 500，消息取平台异常原文。"""
    fake_service.error = error
    app = create_app()
    app.dependency_overrides[get_service] = lambda: fake_service
    with TestClient(app) as client:
        response = client.get("/api/sandboxes/demo")
    assert response.status_code == status_code
    body = response.json()
    assert set(body) == {"detail"}
    assert body["detail"] == str(error)


def test_invalid_request_body_maps_to_400_with_chinese_detail(client: TestClient) -> None:
    """请求体不合法 → 400，中文提示。"""
    response = client.post("/api/sandboxes", json={"image": "busybox:1.37"})
    assert response.status_code == 400
    body = response.json()
    assert set(body) == {"detail"}
    assert body["detail"].startswith("请求参数不合法")


def test_unknown_api_route_returns_chinese_detail(client: TestClient) -> None:
    """未知接口 → 404，中文提示。"""
    response = client.get("/api/nope")
    assert response.status_code == 404
    assert response.json()["detail"].startswith("接口不存在")


# ---------------------------------------------------------------- 分层契约
def test_server_sources_do_not_call_host_commands() -> None:
    """服务层不直接拼宿主命令：宿主交互一律经核心包。"""
    offenders = []
    for path in sorted(SERVER_DIR.rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        if "command.run" in text or "from sandbox_platform.command" in text:
            offenders.append(path.name)
        if "from ..command" in text or "from .command" in text:
            offenders.append(path.name)
    assert offenders == []


def test_lifespan_prepares_data_dir_and_purges_leftover_sessions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """启动钩子：准备平台数据目录，清理上次遗留的终端会话记录。"""
    home = tmp_path / "platform-home"
    monkeypatch.setenv("SANDBOX_PLATFORM_HOME", str(home))
    sessions = home / "terminal-sessions"
    sessions.mkdir(parents=True)
    (sessions / "stale-session.json").write_text("{}", encoding="utf-8")

    app = create_app()
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200

    assert (home / "sandboxes").is_dir()
    assert (home / "terminal-sessions").is_dir()
    assert not (sessions / "stale-session.json").exists()
