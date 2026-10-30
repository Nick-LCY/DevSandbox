"""生命周期编排的单元测试（不依赖宿主特权资源）。"""

from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest

from sandbox_platform import (
    RECLAIM_UNTOUCHED_NOTE,
    ConnectionInfo,
    CreateRequest,
    CreateResult,
    MetadataStore,
    MountSpec,
    NotFoundError,
    SandboxMetadata,
    SandboxService,
    ValidationError,
)
from sandbox_platform.lifecycle import CREATE_STEP_NAMES


def _metadata(name: str = "demo") -> SandboxMetadata:
    return SandboxMetadata(
        name=name,
        system_user=f"sandbox-{name}",
        uid=1001,
        gid=1001,
        home=f"/home/sandbox-{name}",
        subid_start=165536,
        subid_length=65536,
        image="busybox",
        socket_path="/run/user/1001/docker.sock",
        socket_mount_path="/var/run/docker.sock",
        container_name=f"sandbox-{name}",
        container_id="abc123def456",
        network_name=f"{name}-net",
        unit_path=f"/home/sandbox-{name}/.config/systemd/user/docker.service",
        mounts=[MountSpec("/tmp/external", "/data", True)],
    )


def test_create_flow_has_seven_fixed_steps() -> None:
    """创建流程固定 7 步。"""
    assert len(CREATE_STEP_NAMES) == 7
    assert CREATE_STEP_NAMES[0] == "创建专属用户"
    assert CREATE_STEP_NAMES[-1] == "输出连接方式与命令提示"


def test_reclaim_note_literal() -> None:
    """回收提示含字面量「用户挂载的宿主机目录不受影响」。"""
    assert RECLAIM_UNTOUCHED_NOTE == "用户挂载的宿主机目录不受影响"


def test_reclaim_plan_lists_platform_resources(service: SandboxService) -> None:
    """回收清单覆盖平台创建的资源。"""
    service.store.save(_metadata())
    plan = service.reclaim_plan("demo")
    joined = " ".join(plan.items)
    assert "沙箱容器 sandbox-demo" in joined
    assert "systemd 用户单元" in joined
    assert "系统用户 sandbox-demo" in joined
    assert "子 UID/GID 段 165536:65536" in joined
    assert "平台元数据" in joined
    assert plan.untouched_note == RECLAIM_UNTOUCHED_NOTE


def test_reclaim_plan_of_missing_sandbox_is_empty(service: SandboxService) -> None:
    """不存在的沙箱回收清单为空但仍带提示。"""
    plan = service.reclaim_plan("ghost")
    assert plan.items == ()
    assert plan.untouched_note == RECLAIM_UNTOUCHED_NOTE


def test_delete_of_missing_sandbox_is_not_an_error(service: SandboxService) -> None:
    """重复删除返回明确的「不存在」结果且不报错。"""
    result = service.delete("ghost")
    assert result.existed is False
    assert result.removed == ()
    assert result.name == "ghost"


def test_get_missing_sandbox_raises(service: SandboxService) -> None:
    """取不存在的沙箱抛 NotFoundError。"""
    with pytest.raises(NotFoundError):
        service.get("ghost")


def test_create_rejects_duplicate(service: SandboxService) -> None:
    """同名沙箱不能重复创建。"""
    from sandbox_platform import AlreadyExistsError

    service.store.save(_metadata())
    with pytest.raises(AlreadyExistsError):
        service.create(CreateRequest(name="demo"))


def test_create_rejects_socket_path_conflict(service: SandboxService, tmp_path: Path) -> None:
    """用户不能重复声明平台固定挂载的套接字路径。"""
    host = tmp_path / "data"
    host.mkdir()
    with pytest.raises(ValidationError):
        service.create(
            CreateRequest(name="demo", mount_declarations=(f"{host}:/var/run/docker.sock",))
        )


def test_list_returns_metadata_objects(service: SandboxService) -> None:
    """列表返回元数据对象而非字典。"""
    service.store.save(_metadata())
    result = service.list()
    assert all(isinstance(item, SandboxMetadata) for item in result)


def test_metadata_store_is_reachable_from_service(service: SandboxService) -> None:
    """服务内部使用同一套元数据仓库。"""
    assert isinstance(service.store, MetadataStore)


def test_create_request_image_source_defaults_to_auto() -> None:
    """创建入参的镜像来源默认 auto（一期行为，命令行不传该字段）。"""
    assert CreateRequest(name="demo").image_source == "auto"


def test_invalid_image_source_is_rejected() -> None:
    """镜像来源只允许 auto / host。"""
    from sandbox_platform import validate_image_source

    assert validate_image_source("auto") == "auto"
    assert validate_image_source("host") == "host"
    with pytest.raises(ValidationError):
        validate_image_source("proxy")


def test_create_rejects_invalid_image_source(service: SandboxService) -> None:
    """非法镜像来源在动宿主之前就被拒绝。"""
    with pytest.raises(ValidationError):
        service.create(CreateRequest(name="demo", image_source="proxy"))


def test_service_constructible_without_cli(config) -> None:
    """核心模块可在无命令行环境下直接构造与调用。"""
    service = SandboxService(config)
    assert service.list() == []
    assert service.find("nothing") is None


# ---------------------------------------------------------------- 同名并发
def test_name_claim_is_atomic(service: SandboxService) -> None:
    """占位文件是原子的：并发占用同一个沙箱名只有一个能占住。"""
    from sandbox_platform import AlreadyExistsError

    claimed = threading.Event()
    release = threading.Event()
    outcomes: list[str] = []

    def worker() -> None:
        try:
            with service._name_claim("demo"):
                outcomes.append("claimed")
                claimed.set()
                release.wait(timeout=10)
        except AlreadyExistsError:
            outcomes.append("busy")

    first = threading.Thread(target=worker)
    first.start()
    assert claimed.wait(timeout=10)
    second = threading.Thread(target=worker)
    second.start()
    second.join(timeout=10)
    release.set()
    first.join(timeout=10)

    assert sorted(outcomes) == ["busy", "claimed"]


def test_concurrent_create_of_same_name_is_serialized(
    service: SandboxService, monkeypatch: pytest.MonkeyPatch
) -> None:
    """同名并发创建串行化：第二个请求不并行进入创建流程，只拿到「已存在」。"""
    from sandbox_platform import AlreadyExistsError

    entered: list[str] = []
    inside = threading.Event()
    release = threading.Event()
    guard = threading.Lock()
    outcomes: list[str] = []

    def fake_create(request: CreateRequest, name: str, system_user_name: str) -> CreateResult:
        with guard:
            entered.append(name)
        inside.set()
        release.wait(timeout=10)
        service.store.save(_metadata(name))
        return CreateResult(
            metadata=_metadata(name),
            connection=ConnectionInfo(
                socket_path="/run/user/1001/docker.sock",
                container_name=f"sandbox-{name}",
                exec_command="docker exec -it sandbox-demo bash",
                docker_command="docker ps",
            ),
            steps=CREATE_STEP_NAMES,
        )

    monkeypatch.setattr(service, "_create_locked", fake_create)

    def worker() -> None:
        try:
            service.create(CreateRequest(name="demo"))
            outcomes.append("created")
        except AlreadyExistsError:
            outcomes.append("exists")

    first = threading.Thread(target=worker)
    first.start()
    assert inside.wait(timeout=10)
    second = threading.Thread(target=worker)
    second.start()
    time.sleep(0.3)
    release.set()
    first.join(timeout=10)
    second.join(timeout=10)

    assert entered == ["demo"]
    assert sorted(outcomes) == ["created", "exists"]


def test_failed_create_releases_the_name_claim(
    service: SandboxService, monkeypatch: pytest.MonkeyPatch
) -> None:
    """创建失败时占位文件被回收：名字重新可用，不留残留。"""
    from sandbox_platform import LifecycleError

    def boom(request: CreateRequest, name: str, system_user_name: str) -> CreateResult:
        raise LifecycleError("创建专属用户", "故意失败")

    monkeypatch.setattr(service, "_create_locked", boom)
    with pytest.raises(LifecycleError):
        service.create(CreateRequest(name="demo"))
    assert not service._name_claim_path("demo").exists()


def test_delete_releases_the_name_claim(service: SandboxService) -> None:
    """删除沙箱后名字重新可用：占位文件被回收。"""
    service.store.save(_metadata("demo"))
    claim = service._name_claim_path("demo")
    claim.parent.mkdir(parents=True, exist_ok=True)
    claim.write_text("12345\n", encoding="utf-8")

    service.delete("demo")

    assert not claim.exists()
