"""服务层接口测试：路由编排与错误映射。

生命周期服务在这里被整体桩掉：测试不触碰宿主（不建用户、不起容器、
不跑任何宿主命令），只验证「HTTP 载荷 → 核心包入参」与「核心包结果 → HTTP 响应」
两头的转译是否正确，以及错误映射是否固定。

分层契约（服务层不直接碰宿主）由 ``test_source_contract.py`` 统一检测，
本文件不再重复。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sandbox_platform import (
    AlreadyExistsError,
    ConnectionInfo,
    CreateRequest,
    CreateResult,
    DeleteResult,
    LifecycleError,
    MountSpec,
    NotFoundError,
    PlatformConfig,
    ReclaimPlan,
    SandboxMetadata,
    SandboxService,
    ValidationError,
    parse_file_declarations,
    parse_mount_declaration,
)
from sandbox_console import create_app
from sandbox_console.deps import get_service

from conftest import auth_headers


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

    def __init__(self) -> None:
        self.error: Exception | None = None
        self.calls: list[tuple[str, tuple[Any, ...]]] = []
        self.metadata = make_metadata()
        self.config = PlatformConfig.from_env()

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
def fake_service(platform_home: Path) -> FakeSandboxService:
    """假的生命周期服务实例（平台数据根指向临时目录）。"""
    return FakeSandboxService()


def _file_declaration_error(declaration: str) -> ValidationError:
    """用核心包的真实校验产出文件注入声明的错误。

    文件注入声明的校验住在核心包里（服务端不重复实现），服务端只负责
    把核心包抛出的校验错误映射成 400。
    """
    try:
        parse_file_declarations([declaration])
    except ValidationError as exc:
        return exc
    raise AssertionError(f"该声明本该被核心包拒绝：{declaration}")


def _mount_declaration_error(declaration: str) -> ValidationError:
    """用核心包的真实校验产出挂载声明的错误（口径同注入声明）。"""
    try:
        parse_mount_declaration(declaration)
    except ValidationError as exc:
        return exc
    raise AssertionError(f"该声明本该被核心包拒绝：{declaration}")


def _core_create_error(
    platform_home: Path,
    *,
    files: tuple[str, ...] = (),
    mounts: tuple[str, ...] = (),
) -> ValidationError:
    """用核心包的真实创建前校验产出错误。

    创建前校验在任何宿主改动之前跑（不建用户、不起容器、不跑宿主命令），
    所以这里可以安全地借真实核心包产出错误文案。

    两个约束：

    - 平台数据根走 ``platform_home`` 夹具（临时目录）：沙箱名的占位文件落在
      平台数据根的锁目录里，用默认根会污染真实平台目录
      （``/var/lib/sandbox-platform``）；
    - 沙箱名带一次性后缀：名字占位同名会互撞，固定用 ``demo`` 会与别的
      用例撞名。
    """
    service = SandboxService(PlatformConfig.from_env())
    try:
        service.create(
            CreateRequest(
                name=f"fileinject-{uuid4().hex[:8]}",
                image="busybox:1.37",
                files=files,
                mount_declarations=mounts,
            )
        )
    except ValidationError as exc:
        return exc
    raise AssertionError("该声明本该被核心包拒绝")


@pytest.fixture
def client(
    fake_service: FakeSandboxService,
    platform_home: Path,
) -> TestClient:
    """测试客户端（生命周期服务已整体桩掉）。"""
    app = create_app()
    app.dependency_overrides[get_service] = lambda: fake_service
    return TestClient(app, headers=auth_headers())


# ---------------------------------------------------------------- 沙箱管理接口
def test_create_sandbox_returns_steps_and_connection(
    client: TestClient, fake_service: FakeSandboxService
) -> None:
    """创建沙箱：返回 201，响应含步骤、连接方式与沙箱详情。"""
    response = client.post("/api/sandboxes", json={"name": "demo", "image": "busybox:1.37"})
    assert response.status_code == 201
    body = response.json()
    assert body["steps"] == ["创建专属用户", "登记子 UID/GID 段"]
    assert body["connection"]["container_name"] == "sandbox-demo"
    assert body["metadata"]["name"] == "demo"
    assert body["metadata"]["image"] == "busybox:1.37"


def test_create_sandbox_defaults_to_auto_image_source(
    client: TestClient, fake_service: FakeSandboxService
) -> None:
    """不传 image_source 时按 auto 转成核心包入参。"""
    client.post("/api/sandboxes", json={"name": "demo", "image": "busybox:1.37"})
    action, args = fake_service.calls[-1]
    assert action == "create"
    request: CreateRequest = args[0]
    assert request.image_source == "auto"
    assert request.name == "demo"


def test_create_sandbox_forwards_host_image_source(
    client: TestClient, fake_service: FakeSandboxService
) -> None:
    """image_source=host 原样转给核心包（强制从宿主注入，不经镜像代理）。"""
    client.post(
        "/api/sandboxes",
        json={"name": "demo", "image": "my-local/app:dev", "image_source": "host"},
    )
    request: CreateRequest = fake_service.calls[-1][1][0]
    assert request.image_source == "host"


def test_create_sandbox_without_image_returns_422(client: TestClient) -> None:
    """缺 image 字段 → 422：默认镜像已退役，镜像必须显式指定。"""
    response = client.post("/api/sandboxes", json={"name": "demo"})
    assert response.status_code == 422
    body = response.json()
    assert set(body) == {"detail"}
    assert "image" in body["detail"]
    assert "必须显式指定沙箱镜像" in body["detail"]


def test_create_sandbox_with_empty_image_returns_422(client: TestClient) -> None:
    """image 传空串 → 422：与缺失同义（都归入「必须显式指定镜像」）。"""
    response = client.post("/api/sandboxes", json={"name": "demo", "image": ""})
    assert response.status_code == 422
    assert "必须显式指定沙箱镜像" in response.json()["detail"]


def test_create_sandbox_with_null_image_returns_422(client: TestClient) -> None:
    """image 传 null → 422：与缺失同义（都归入「必须显式指定镜像」）。"""
    response = client.post("/api/sandboxes", json={"name": "demo", "image": None})
    assert response.status_code == 422
    assert "必须显式指定沙箱镜像" in response.json()["detail"]


def test_create_sandbox_without_name_and_image_mentions_both(client: TestClient) -> None:
    """name 与 image 同时缺失：报错文案两个字段都讲，不只讲镜像。"""
    response = client.post("/api/sandboxes", json={})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "name" in detail
    assert "image" in detail
    assert "必须显式指定沙箱镜像" in detail


def test_create_sandbox_rejects_unknown_image_source(client: TestClient) -> None:
    """image_source 只允许 auto / host，拼错的值直接 400。"""
    response = client.post(
        "/api/sandboxes",
        json={"name": "demo", "image": "busybox:1.37", "image_source": "proxy"},
    )
    assert response.status_code == 400
    assert "取值不在允许范围内" in response.json()["detail"]


def test_create_sandbox_rejects_unknown_field(client: TestClient) -> None:
    """拼错的字段名不静默忽略，直接 400。"""
    response = client.post(
        "/api/sandboxes",
        json={"name": "demo", "image": "busybox:1.37", "images": "busybox:1.37"},
    )
    assert response.status_code == 400
    assert "不允许的字段" in response.json()["detail"]


def test_create_sandbox_translates_mounts_and_command(
    client: TestClient, fake_service: FakeSandboxService
) -> None:
    """挂载声明与启动命令按核心包语义转译。"""
    client.post(
        "/api/sandboxes",
        json={
            "name": "demo",
            "image": "busybox:1.37",
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


def test_create_sandbox_with_unbalanced_quotes_returns_400(client: TestClient) -> None:
    """命令里的引号不配对：400，不落成 500。"""
    response = client.post(
        "/api/sandboxes",
        json={"name": "demo", "image": "busybox:1.37", "command": "echo '未闭合"},
    )
    assert response.status_code == 400
    assert "引号" in response.json()["detail"]


# ---------------------------------------------------------------- 文件注入声明
def test_create_sandbox_passes_files_to_core(
    client: TestClient, fake_service: FakeSandboxService
) -> None:
    """文件注入声明原样转给核心包。"""
    client.post(
        "/api/sandboxes",
        json={
            "name": "demo",
            "image": "busybox:1.37",
            "files": ["/tmp/demo/secret:/run/secret"],
        },
    )
    request: CreateRequest = fake_service.calls[-1][1][0]
    assert request.files == ("/tmp/demo/secret:/run/secret",)


def test_create_sandbox_expands_home_prefix_in_file_host_segment(
    client: TestClient,
    fake_service: FakeSandboxService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """文件注入声明的宿主路径段展开 ~，容器路径段不展开。

    家目录口径锁死：把 HOME 指向固定假家目录，展开结果必须落在那里。
    """
    fake_home = "/tmp/fake-service-home"
    monkeypatch.setenv("HOME", fake_home)
    client.post(
        "/api/sandboxes",
        json={
            "name": "demo",
            "image": "busybox:1.37",
            "files": ["~/secret:/run/secret", "/tmp/demo:~/other"],
        },
    )
    request: CreateRequest = fake_service.calls[-1][1][0]
    assert request.files == (f"{fake_home}/secret:/run/secret", "/tmp/demo:~/other")


def test_create_sandbox_rejects_invalid_file_declaration_with_400(
    client: TestClient, fake_service: FakeSandboxService
) -> None:
    """文件注入声明非法 → 400：平台异常原文回显。

    校验在核心包里做（服务端不重复实现校验逻辑），这里用核心包的真实校验
    产出错误，验证错误映射口径。
    """
    fake_service.error = _file_declaration_error("relative:/run/secret")
    response = client.post(
        "/api/sandboxes",
        json={
            "name": "demo",
            "image": "busybox:1.37",
            "files": ["relative:/run/secret"],
        },
    )
    assert response.status_code == 400
    assert "绝对路径" in response.json()["detail"]


def test_create_sandbox_rejects_double_slash_file_declaration_with_400(
    client: TestClient, fake_service: FakeSandboxService
) -> None:
    """注入声明用 ``//`` 前缀绕敏感清单 → 400。

    ``os.path.normpath`` 会把**恰好两个**前导斜杠原样留着，``//etc/shadow``
    能绕开按 ``/etc`` 根的清单比对；核心包归一化时必须把前导多斜杠压平。
    """
    fake_service.error = _file_declaration_error("//etc/shadow:/run/secret")
    response = client.post(
        "/api/sandboxes",
        json={
            "name": "demo",
            "image": "busybox:1.37",
            "files": ["//etc/shadow:/run/secret"],
        },
    )
    assert response.status_code == 400
    assert "敏感清单" in response.json()["detail"]


def test_create_sandbox_rejects_double_slash_mount_declaration_with_400(
    client: TestClient, fake_service: FakeSandboxService
) -> None:
    """挂载声明用 ``//`` 前缀绕敏感清单 → 400（同一条归一化口径）。"""
    fake_service.error = _mount_declaration_error("//etc:/data")
    response = client.post(
        "/api/sandboxes",
        json={
            "name": "demo",
            "image": "busybox:1.37",
            "mounts": ["//etc:/data"],
        },
    )
    assert response.status_code == 400
    assert "敏感清单" in response.json()["detail"]


def test_create_sandbox_rejects_non_string_file_element_with_400(
    client: TestClient,
) -> None:
    """files 列表里传非字符串 → 400（不落成 422：422 只服务缺镜像）。"""
    response = client.post(
        "/api/sandboxes",
        json={"name": "demo", "image": "busybox:1.37", "files": [123]},
    )
    assert response.status_code == 400
    assert "应为字符串" in response.json()["detail"]


def test_create_sandbox_rejects_file_container_path_conflicting_with_socket(
    client: TestClient, fake_service: FakeSandboxService, platform_home: Path
) -> None:
    """注入的容器内路径撞平台固定挂载的套接字路径 → 400。"""
    fake_service.error = _core_create_error(
        platform_home,
        files=("/tmp/demo/secret:/var/run/docker.sock",),
    )
    response = client.post(
        "/api/sandboxes",
        json={
            "name": "demo",
            "image": "busybox:1.37",
            "files": ["/tmp/demo/secret:/var/run/docker.sock"],
        },
    )
    assert response.status_code == 400
    assert "套接字" in response.json()["detail"]


def test_create_sandbox_rejects_file_container_path_conflicting_with_user_mount(
    client: TestClient,
    fake_service: FakeSandboxService,
    platform_home: Path,
    tmp_path: Path,
) -> None:
    """注入的容器内路径撞用户声明挂载的容器内路径 → 400。"""
    host = tmp_path / "data"
    host.mkdir()
    fake_service.error = _core_create_error(
        platform_home,
        files=(f"{host}/secret:/data",),
        mounts=(f"{host}:/data",),
    )
    response = client.post(
        "/api/sandboxes",
        json={
            "name": "demo",
            "image": "busybox:1.37",
            "mounts": [f"{host}:/data"],
            "files": [f"{host}/secret:/data"],
        },
    )
    assert response.status_code == 400
    assert "重复" in response.json()["detail"]


# ---------------------------------------------------------------- 挂载宿主路径的 ~ 展开
def test_create_sandbox_expands_home_prefix_in_mounts(
    client: TestClient,
    fake_service: FakeSandboxService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """挂载宿主路径的 ~ 与 ~/ 展开为服务运行用户的家目录。

    家目录口径锁死：把 HOME 指向固定假家目录，展开结果必须落在那里
    （不是当前登录用户的家目录，也不是容器内的家目录）。
    """
    fake_home = "/tmp/fake-service-home"
    monkeypatch.setenv("HOME", fake_home)
    client.post(
        "/api/sandboxes",
        json={"name": "demo", "image": "busybox:1.37", "mounts": ["~/data:/data", "~:/rootish"]},
    )
    request: CreateRequest = fake_service.calls[-1][1][0]
    assert request.mount_declarations == (f"{fake_home}/data:/data", f"{fake_home}:/rootish")


def test_create_sandbox_expands_home_prefix_with_surrounding_spaces(
    client: TestClient,
    fake_service: FakeSandboxService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """宿主路径段带前后空格：照样展开（与核心包先 strip 的口径一致）。"""
    fake_home = "/tmp/fake-service-home"
    monkeypatch.setenv("HOME", fake_home)
    client.post(
        "/api/sandboxes",
        json={"name": "demo", "image": "busybox:1.37", "mounts": ["  ~/data  :/data"]},
    )
    request: CreateRequest = fake_service.calls[-1][1][0]
    assert request.mount_declarations == (f"{fake_home}/data:/data",)


def test_create_sandbox_does_not_expand_container_path(
    client: TestClient, fake_service: FakeSandboxService
) -> None:
    """容器路径段里的 ~ 不展开：原样交给核心包。"""
    client.post(
        "/api/sandboxes",
        json={"name": "demo", "image": "busybox:1.37", "mounts": ["/tmp/demo:~/data"]},
    )
    request: CreateRequest = fake_service.calls[-1][1][0]
    assert request.mount_declarations == ("/tmp/demo:~/data",)


def test_create_sandbox_does_not_expand_other_user_prefix(
    client: TestClient, fake_service: FakeSandboxService
) -> None:
    """~other 形式不展开（原样交给核心包）。"""
    client.post(
        "/api/sandboxes",
        json={"name": "demo", "image": "busybox:1.37", "mounts": ["~other/data:/data"]},
    )
    request: CreateRequest = fake_service.calls[-1][1][0]
    assert request.mount_declarations == ("~other/data:/data",)


def test_create_sandbox_expanded_mount_host_is_absolute(
    client: TestClient,
    fake_service: FakeSandboxService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """展开后的宿主路径是绝对路径（进核心请求前已是完整路径）。"""
    monkeypatch.setenv("HOME", "/tmp/fake-service-home")
    client.post(
        "/api/sandboxes",
        json={"name": "demo", "image": "busybox:1.37", "mounts": ["~/data:/data:ro"]},
    )
    request: CreateRequest = fake_service.calls[-1][1][0]
    host = request.mount_declarations[0].split(":")[0]
    assert host.startswith("/")
    assert not host.startswith("~")
    assert request.mount_declarations[0].endswith(":/data:ro")


def test_create_sandbox_does_not_expand_env_command_or_workdir(
    client: TestClient, fake_service: FakeSandboxService
) -> None:
    """环境变量值、命令与工作目录一律不展开（展开会让用户难以预期内容被改写）。"""
    client.post(
        "/api/sandboxes",
        json={
            "name": "demo",
            "image": "busybox:1.37",
            "env": {"HOME": "~"},
            "command": "echo ~",
            "workdir": "~/work",
        },
    )
    request: CreateRequest = fake_service.calls[-1][1][0]
    assert request.env == {"HOME": "~"}
    assert request.command == ("echo", "~")
    assert request.workdir == "~/work"


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


def test_sandbox_detail_masks_environment_values(
    client: TestClient, fake_service: FakeSandboxService
) -> None:
    """详情里的环境变量只回键名，值固定脱敏。"""
    fake_service.metadata.env = {"TOKEN": "super-secret", "MODE": "debug"}
    response = client.get("/api/sandboxes/demo")
    assert response.status_code == 200
    assert response.json()["env"] == {"TOKEN": "***", "MODE": "***"}


def test_sandbox_detail_lists_injected_files(
    client: TestClient, fake_service: FakeSandboxService
) -> None:
    """详情：注入副本清单单列在 files（结构同 mounts）。"""
    fake_service.metadata.files = [
        MountSpec(
            "/home/sandbox-demo/.sandbox-files/0-secret.txt",
            "/run/secret",
            True,
            "file",
        )
    ]
    response = client.get("/api/sandboxes/demo")
    assert response.status_code == 200
    assert response.json()["files"] == [
        {
            "host_path": "/home/sandbox-demo/.sandbox-files/0-secret.txt",
            "container_path": "/run/secret",
            "read_only": True,
            "role": "file",
        }
    ]


def test_sandbox_detail_files_is_empty_list_by_default(client: TestClient) -> None:
    """没有注入声明时 files 照常返回空列表（不省略字段）。"""
    response = client.get("/api/sandboxes/demo")
    assert response.status_code == 200
    assert response.json()["files"] == []


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


def test_reclaim_plan_of_missing_sandbox_returns_404(
    client: TestClient, fake_service: FakeSandboxService
) -> None:
    """回收清单只对真实存在的沙箱有意义：不存在直接 404。"""
    fake_service.error = NotFoundError("沙箱不存在：ghost")
    response = client.get("/api/sandboxes/ghost/reclaim")
    assert response.status_code == 404
    assert response.json()["detail"] == "沙箱不存在：ghost"


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
    """服务自检：版本、数据根是否就绪；不回显宿主路径。"""
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["data_root_configured"] is True
    assert "platform_home" not in body
    assert "/var/lib" not in response.text

    # 响应字段集锁死：只给「状态 / 版本 / 数据根是否就绪」三样，
    # 不多不少（前端按这个形状读，多一个字段就会在前端被当成契约的一部分）。
    assert set(body) == {"status", "version", "data_root_configured"}


def test_root_path_returns_404(client: TestClient) -> None:
    """根路径 404：本服务是纯 API 服务，不托管前端（根路径没有页面）。"""
    response = client.get("/")
    assert response.status_code == 404
    assert "<html" not in response.text.lower()


def test_static_assets_return_404(client: TestClient) -> None:
    """静态资源路径 404：前端由独立静态源托管，后端不提供任何静态文件。"""
    response = client.get("/assets/x.js")
    assert response.status_code == 404


# ---------------------------------------------------------------- 错误映射
@pytest.mark.parametrize(
    ("error", "status_code", "detail"),
    [
        (ValidationError("沙箱名非法：'Bad Name'"), 400, "沙箱名非法：'Bad Name'"),
        (NotFoundError("沙箱不存在：demo"), 404, "沙箱不存在：demo"),
        (AlreadyExistsError("沙箱已存在：demo"), 409, "沙箱已存在：demo"),
        (LifecycleError("启动沙箱容器", "启动沙箱容器失败"), 500, "平台内部错误，请查看服务日志"),
    ],
)
def test_platform_errors_map_to_fixed_status_codes(
    fake_service: FakeSandboxService,
    platform_home: Path,
    error: Exception,
    status_code: int,
    detail: str,
) -> None:
    """错误映射固定：400 / 404 / 409 / 500；500 分支只回固定文案。"""
    fake_service.error = error
    app = create_app()
    app.dependency_overrides[get_service] = lambda: fake_service
    with TestClient(app, headers=auth_headers()) as client:
        response = client.get("/api/sandboxes/demo")
    assert response.status_code == status_code
    body = response.json()
    assert set(body) == {"detail"}
    assert body["detail"] == detail


def test_internal_error_detail_does_not_leak_host_paths(
    fake_service: FakeSandboxService, platform_home: Path
) -> None:
    """500 分支不回显异常原文：宿主路径与特权命令行只进日志。"""
    fake_service.error = RuntimeError("炸了 /var/lib/sandbox-platform sudo docker ps")
    app = create_app()
    app.dependency_overrides[get_service] = lambda: fake_service
    client = TestClient(app, headers=auth_headers(), raise_server_exceptions=False)
    response = client.get("/api/sandboxes/demo")
    assert response.status_code == 500
    body = response.json()
    assert body["detail"] == "平台内部错误，请查看服务日志"
    assert "/var/lib/sandbox-platform" not in response.text
    assert "sudo" not in response.text


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


# ---------------------------------------------------------------- 接口文档开关
def test_openapi_docs_are_disabled_by_default(client: TestClient) -> None:
    """无认证环境默认不公开接口清单。"""
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_openapi_docs_can_be_enabled_by_env(
    fake_service: FakeSandboxService,
    platform_home: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """显式设置环境变量才开放 /docs 与 /openapi.json。"""
    monkeypatch.setenv("SANDBOX_CONSOLE_DOCS", "1")
    app = create_app()
    app.dependency_overrides[get_service] = lambda: fake_service
    client = TestClient(app, headers=auth_headers())
    assert client.get("/openapi.json").status_code == 200
    assert client.get("/docs").status_code == 200


# ---------------------------------------------------------------- 生命周期钩子
def test_lifespan_prepares_data_dir_and_purges_leftover_sessions(
    platform_home: Path, fake_service: FakeSandboxService
) -> None:
    """启动钩子：准备平台数据目录，清理上次遗留的终端会话记录。"""
    sessions = platform_home / "terminal-sessions"
    sessions.mkdir(parents=True)
    (sessions / "stale-session.json").write_text("{}", encoding="utf-8")

    app = create_app()
    app.dependency_overrides[get_service] = lambda: fake_service
    with TestClient(app, headers=auth_headers()) as client:
        assert client.get("/api/health").status_code == 200

    assert (platform_home / "sandboxes").is_dir()
    assert (platform_home / "terminal-sessions").is_dir()
    assert not (sessions / "stale-session.json").exists()


# ---------------------------------------------------------------- 启动入口
def test_invalid_port_exits_with_code_2(monkeypatch: pytest.MonkeyPatch) -> None:
    """端口非法：打一行中文错误，退出码 2。"""
    from sandbox_console import __main__ as entry

    monkeypatch.setenv("SANDBOX_CONSOLE_PORT", "not-a-port")
    assert entry.main() == 2


def test_out_of_range_port_exits_with_code_2(monkeypatch: pytest.MonkeyPatch) -> None:
    """端口超出范围：退出码 2。"""
    from sandbox_console import __main__ as entry

    monkeypatch.setenv("SANDBOX_CONSOLE_PORT", "70000")
    assert entry.main() == 2


def test_non_loopback_host_warns(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """监听非回环地址时打醒目告警（口径：**已启用令牌认证**，但令牌是单一凭据）。"""
    from sandbox_console import __main__ as entry

    with caplog.at_level("WARNING"):
        entry.warn_if_not_loopback("0.0.0.0")
    assert any("不是回环地址" in record.message for record in caplog.records)
    # 新口径：告警文案说「已启用令牌认证」，不再宣称「服务不做认证」
    messages = "\n".join(record.message for record in caplog.records)
    assert "已启用令牌认证" in messages
    assert "不做认证" not in messages


def test_loopback_host_does_not_warn(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """回环地址不告警。"""
    from sandbox_console import __main__ as entry

    with caplog.at_level("WARNING"):
        entry.warn_if_not_loopback("127.0.0.1")
    assert caplog.records == []


def test_command_error_detail_does_not_leak_privileged_command_line(
    fake_service: FakeSandboxService, platform_home: Path
) -> None:
    """宿主命令失败（带特权命令行）：500 且不回显命令行原文。"""
    from sandbox_platform import CommandError

    fake_service.error = CommandError(
        ["sudo", "-u", "sandbox-demo", "docker", "ps"],
        1,
        "",
        "permission denied",
    )
    app = create_app()
    app.dependency_overrides[get_service] = lambda: fake_service
    client = TestClient(app, headers=auth_headers(), raise_server_exceptions=False)
    response = client.get("/api/sandboxes/demo")
    assert response.status_code == 500
    assert response.json()["detail"] == "平台内部错误，请查看服务日志"
    assert "docker" not in response.text
    assert "permission denied" not in response.text
