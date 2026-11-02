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
    UserDaemon,
    ValidationError,
)
from sandbox_platform.lifecycle import CREATE_STEP_NAMES


def _install_fake_passwd(
    monkeypatch: pytest.MonkeyPatch,
    entries: dict[str, str],
) -> None:
    """把系统用户表换成假数据（``用户名 -> 家目录``）。

    只接管 ``getent passwd`` 与 ``test -d`` 两条命令，其余命令照常执行。
    """
    from sandbox_platform import files as files_module
    from sandbox_platform.command import CommandResult

    real_run = files_module.run

    def fake_run(argv, **kwargs):
        args = [str(item) for item in argv]
        if args[:1] == ["sudo"]:
            args = args[2:]
        if args[:1] == ["getent"]:
            stdout = "".join(
                f"{name}:x:1001:1001:x:{home}:/bin/bash\n"
                for name, home in entries.items()
            )
            return CommandResult(tuple(argv), 0, stdout, "")
        if args[:2] == ["test", "-d"]:
            ok = Path(args[2]).is_dir()
            return CommandResult(tuple(argv), 0 if ok else 1, "", "")
        return real_run(argv, **kwargs)

    monkeypatch.setattr(files_module, "run", fake_run)


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
        service.create(CreateRequest(name="demo", image="busybox"))


def test_create_rejects_socket_path_conflict(service: SandboxService, tmp_path: Path) -> None:
    """用户不能重复声明平台固定挂载的套接字路径。"""
    host = tmp_path / "data"
    host.mkdir()
    with pytest.raises(ValidationError):
        service.create(
            CreateRequest(
                name="demo",
                image="busybox",
                mount_declarations=(f"{host}:/var/run/docker.sock",),
            )
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
    """创建入参的镜像来源默认 auto。"""
    assert CreateRequest(name="demo", image="busybox").image_source == "auto"


def test_create_request_requires_image() -> None:
    """镜像必填：默认镜像已退役，创建入参不再有镜像兜底。"""
    with pytest.raises(TypeError):
        CreateRequest(name="demo")  # type: ignore[call-arg]


def test_create_rejects_missing_image(service: SandboxService) -> None:
    """缺镜像直接报错（默认镜像已退役），且不落任何宿主副作用。"""
    with pytest.raises(ValidationError) as excinfo:
        service.create(CreateRequest(name="demo", image=""))
    assert "必须显式指定沙箱镜像" in str(excinfo.value)
    assert not service.store.exists("demo")


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
        service.create(CreateRequest(name="demo", image="busybox", image_source="proxy"))


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
            service.create(CreateRequest(name="demo", image="busybox"))
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
        service.create(CreateRequest(name="demo", image="busybox"))
    assert not service._name_claim_path("demo").exists()


def test_delete_releases_the_name_claim(service: SandboxService) -> None:
    """删除沙箱后名字重新可用：占位文件被回收。"""
    service.store.save(_metadata("demo"))
    claim = service._name_claim_path("demo")
    claim.parent.mkdir(parents=True, exist_ok=True)
    claim.write_text("12345\n", encoding="utf-8")

    service.delete("demo")

    assert not claim.exists()


# ---------------------------------------------------------------- 文件注入声明的容器内路径
def test_create_rejects_file_container_path_conflicting_with_socket(
    service: SandboxService, tmp_path: Path
) -> None:
    """注入的容器内路径撞平台固定挂载的套接字路径：拒绝，不落任何宿主副作用。"""
    host = tmp_path / "data"
    host.mkdir()
    with pytest.raises(ValidationError) as excinfo:
        service.create(
            CreateRequest(
                name="demo",
                image="busybox",
                files=(f"{host}:/var/run/docker.sock",),
            )
        )
    assert "套接字" in str(excinfo.value)


def test_create_rejects_file_container_path_conflicting_with_user_mount(
    service: SandboxService, tmp_path: Path
) -> None:
    """注入的容器内路径撞用户声明挂载的容器内路径：拒绝。"""
    host = tmp_path / "data"
    host.mkdir()
    with pytest.raises(ValidationError) as excinfo:
        service.create(
            CreateRequest(
                name="demo",
                image="busybox",
                mount_declarations=(f"{host}:/data",),
                files=(f"{host}:/data",),
            )
        )
    assert "重复" in str(excinfo.value)


def test_create_rejects_file_source_inside_other_sandbox_home(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """注入源落在其他沙箱用户家目录内：创建直接拒绝。

    注入源由平台以特权身份读取：家目录里是别的沙箱账号的家，
    平台不能替别人把文件复制进来。
    """
    fake_home = tmp_path / "home"
    victim = fake_home / "sandbox-victim"
    victim.mkdir(parents=True)
    _install_fake_passwd(monkeypatch, {"sandbox-victim": str(victim)})

    with pytest.raises(ValidationError) as excinfo:
        service.create(
            CreateRequest(
                name="demo",
                image="busybox",
                files=(f"{victim}/key:/run/key",),
            )
        )
    assert "沙箱用户家目录" in str(excinfo.value)


def test_create_rejects_file_source_inside_own_sandbox_home(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """注入源落在本次目标沙箱自己的家目录内：创建直接拒绝，容器不创建。

    口径统一：**没有**「本次新建家目录放行」这条例外。干跑与实跑走同一套
    判定，所以拒绝发生在建用户、起容器之前。
    """
    home = tmp_path / "home" / "sandbox-demo"
    home.mkdir(parents=True)
    (home / "key").write_text("k", encoding="utf-8")
    _install_fake_passwd(monkeypatch, {"sandbox-demo": str(home)})

    def refuse(*args, **kwargs):
        raise AssertionError("容器不该被创建")

    monkeypatch.setattr(UserDaemon, "run_container", refuse)

    with pytest.raises(ValidationError) as excinfo:
        service.create(
            CreateRequest(
                name="demo",
                image="busybox",
                files=(f"{home}/key:/run/key",),
            )
        )
    assert "沙箱用户家目录" in str(excinfo.value)
    assert service.find("demo") is None
    assert not service._name_claim_path("demo").exists()
