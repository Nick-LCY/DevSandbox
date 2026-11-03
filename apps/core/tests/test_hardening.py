"""安全加固的回归测试。

覆盖审查结论里的关键修复点：名字穿越、元数据不可信、并发锁、回收清单、
敏感路径拒绝、命名白名单、返回码如实上报等。
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from sandbox_platform import (
    CreateRequest,
    MetadataStore,
    SandboxMetadata,
    SandboxService,
    ValidationError,
)
from sandbox_platform.command import CommandResult, run
from sandbox_platform.daemon import UserContext, UserDaemon
from sandbox_platform.errors import CommandError, LifecycleError
from sandbox_platform.lifecycle import (
    validate_env_pairs,
    validate_image_name,
    validate_network_name,
    validate_sandbox_name,
)
from sandbox_platform.mounts import parse_mount_declaration, parse_mounts
from sandbox_platform.userspace import Privilege, SystemUser, UserSpaceManager

# ---------------------------------------------------------------- 名字穿越
TRAVERSAL_NAMES = [
    "../evil",
    "..",
    "a/../../b",
    "/etc/passwd",
    "demo/../other",
    "demo\x00evil",
]


@pytest.mark.parametrize("bad_name", TRAVERSAL_NAMES)
def test_all_entry_points_reject_path_traversal(service: SandboxService, bad_name: str) -> None:
    """六个入口一律拒绝带路径分隔符的沙箱名。"""
    with pytest.raises(ValidationError):
        service.find(bad_name)
    with pytest.raises(ValidationError):
        service.get(bad_name)
    with pytest.raises(ValidationError):
        service.reclaim_plan(bad_name)
    with pytest.raises(ValidationError):
        service.delete(bad_name)
    with pytest.raises(ValidationError):
        service.start(bad_name)
    with pytest.raises(ValidationError):
        service.stop(bad_name)


def test_metadata_store_rejects_traversal(config) -> None:
    """元数据目录兜底断言：沙箱名不得含路径分隔符。"""
    store = MetadataStore(config)
    with pytest.raises(ValidationError):
        store.sandbox_dir("../evil")
    with pytest.raises(ValidationError):
        store.path_for("../evil")


def test_sandbox_name_validation_uses_full_match() -> None:
    """名字校验整串匹配：前后多一个字符都不放过。"""
    assert validate_sandbox_name("demo-1") == "demo-1"
    for bad in ("demo\n", " demo", "demo ", "demo/1", "DEMO"):
        with pytest.raises(ValidationError):
            validate_sandbox_name(bad)


# ---------------------------------------------------------------- 挂载校验
def test_mount_path_with_comma_rejected(tmp_path: Path) -> None:
    """路径含逗号一律拒绝（Docker 挂载参数以逗号分段）。"""
    host = tmp_path / "data"
    host.mkdir()
    with pytest.raises(ValidationError):
        parse_mount_declaration(f"{host}:/data,ro")
    with pytest.raises(ValidationError):
        parse_mount_declaration(f"{host},x:/data")


@pytest.mark.parametrize(
    "sensitive",
    ["/etc", "/etc/passwd", "/proc", "/proc/self", "/sys", "/dev", "/boot", "/root"],
)
def test_sensitive_host_paths_rejected(sensitive: str) -> None:
    """宿主敏感目录一律拒绝挂载。"""
    if not Path(sensitive).exists():
        pytest.skip(f"宿主上不存在 {sensitive}")
    with pytest.raises(ValidationError):
        parse_mount_declaration(f"{sensitive}:/data")


def test_host_docker_socket_rejected() -> None:
    """宿主 Docker 套接字不得挂进沙箱。"""
    with pytest.raises(ValidationError):
        parse_mount_declaration("/var/run/docker.sock:/data")


def test_platform_data_root_rejected(config, tmp_path: Path) -> None:
    """平台数据根目录不得被挂进沙箱。"""
    with pytest.raises(ValidationError):
        parse_mounts([f"{config.home}:/data"], extra_forbidden=[config.home])


def test_normal_mount_still_allowed(tmp_path: Path) -> None:
    """普通宿主目录不受影响。"""
    host = tmp_path / "data"
    host.mkdir()
    spec = parse_mount_declaration(f"{host}:/data:ro")
    assert spec.host_path == str(host)
    assert spec.read_only is True


# ---------------------------------------------------------------- 命名白名单
@pytest.mark.parametrize("bad_key", ["1BAD", "BAD-KEY", "BAD KEY", "", "A=B"])
def test_env_key_whitelist(bad_key: str) -> None:
    """环境变量键名只允许字母、数字与下划线。"""
    with pytest.raises(ValidationError):
        validate_env_pairs({bad_key: "v"})


def test_env_key_whitelist_accepts_normal_keys() -> None:
    """常规键名放行。"""
    assert validate_env_pairs({"PATH": "/bin", "_X1": "v"}) == {"PATH": "/bin", "_X1": "v"}


@pytest.mark.parametrize("bad_image", ["bad image", "img;rm -rf /", "-leading", "img$(x)"])
def test_image_name_charset(bad_image: str) -> None:
    """镜像名只允许安全字符集。"""
    with pytest.raises(ValidationError):
        validate_image_name(bad_image)


def test_image_name_accepts_normal_references() -> None:
    """常规镜像引用放行。"""
    assert validate_image_name("python:3.12-alpine")
    assert validate_image_name("docker:29.6.2-cli")


@pytest.mark.parametrize("bad_network", ["net work", "net;x", "-net", "net/x"])
def test_network_name_charset(bad_network: str) -> None:
    """网络名只允许安全字符集。"""
    with pytest.raises(ValidationError):
        validate_network_name(bad_network)


# ---------------------------------------------------------------- 元数据
def test_metadata_file_permissions_are_0600(config) -> None:
    """元数据文件权限 0600，不对其他用户开放。"""
    store = MetadataStore(config)
    path = store.save(_demo_metadata())
    mode = stat.S_IMODE(os.stat(path).st_mode)
    assert mode == 0o600


def test_metadata_network_owned_round_trip(config) -> None:
    """network_owned 标记存取往返一致。"""
    store = MetadataStore(config)
    metadata = _demo_metadata()
    metadata.network_owned = False
    store.save(metadata)
    assert store.load("demo").network_owned is False


# ---------------------------------------------------------------- 回收清单
def test_reclaim_plan_includes_live_scanned_containers(service: SandboxService) -> None:
    """删除前的清单并入实时扫描到的依赖容器。"""
    service.store.save(_demo_metadata())
    service._scan_network_containers = lambda metadata: ["dep-live"]  # type: ignore[method-assign]
    plan = service.reclaim_plan("demo")
    joined = " ".join(plan.items)
    assert "dep-live" in joined
    assert plan.incomplete is False


def test_reclaim_plan_marks_incomplete_when_probe_fails(service: SandboxService) -> None:
    """实时探测失败时保留旧列表并标注清单可能不完整。"""
    metadata = _demo_metadata()
    metadata.dependency_containers = ["dep-known"]
    service.store.save(metadata)
    service._scan_network_containers = lambda meta: None  # type: ignore[method-assign]
    plan = service.reclaim_plan("demo")
    joined = " ".join(plan.items)
    assert "dep-known" in joined
    assert "可能不完整" in joined
    assert plan.incomplete is True


def test_user_specified_network_is_not_reclaimed(service: SandboxService) -> None:
    """用户指定的网络只接入不回收，平台自建的网络才回收。"""
    metadata = _demo_metadata()
    metadata.network_owned = False
    assert service._network_reclaimable(metadata) is False
    metadata.network_owned = True
    assert service._network_reclaimable(metadata) is True

    metadata.network_name = "someone-elses-net"
    metadata.network_owned = True
    assert service._network_reclaimable(metadata) is False


def test_user_specified_network_marked_in_plan(service: SandboxService) -> None:
    """清单里标明用户指定的网络平台不回收。"""
    metadata = _demo_metadata()
    metadata.network_owned = False
    service.store.save(metadata)
    service._scan_network_containers = lambda meta: None  # type: ignore[method-assign]
    plan = service.reclaim_plan("demo")
    joined = " ".join(plan.items)
    assert "平台不回收" in joined


# ---------------------------------------------------------------- 假实现
class FakeDaemon:
    """记录调用的假守护进程。"""

    def __init__(self, containers: list[str] | None = None, networks: list[str] | None = None):
        self.containers = containers or []
        self.networks = networks or []
        self.calls: list[tuple[str, str]] = []
        self.remove_container_ok = True
        self.remove_network_ok = True

    def containers_on_network(self, network: str) -> list[str] | None:
        self.calls.append(("containers_on_network", network))
        if self.networks is None:
            return None
        return list(self.containers)

    def container_exists(self, name: str) -> bool:
        return name in self.containers

    def container_names_by_label(self, label: str) -> list[str]:
        """按标签过滤列容器名。

        假守护进程不记标签信息：没有平台标签的容器（转发容器等）自然不在结果里。
        """
        self.calls.append(("container_names_by_label", label))
        return []

    def remove_container(self, name: str) -> CommandResult:
        self.calls.append(("remove_container", name))
        if not self.remove_container_ok:
            return CommandResult(("docker", "rm", name), 1, "", "boom")
        self.containers = [item for item in self.containers if item != name]
        return CommandResult(("docker", "rm", name), 0, "", "")

    def network_exists(self, name: str) -> bool:
        return name in self.networks

    def remove_network(self, name: str) -> CommandResult:
        self.calls.append(("remove_network", name))
        if not self.remove_network_ok:
            return CommandResult(("docker", "network", "rm", name), 1, "", "boom")
        self.networks = [item for item in self.networks if item != name]
        return CommandResult(("docker", "network", "rm", name), 0, "", "")

    def disable_daemon(self) -> CommandResult:
        self.calls.append(("disable_daemon", "docker.service"))
        return CommandResult(("systemctl",), 0, "", "")

    def stop_daemon(self) -> CommandResult:
        self.calls.append(("stop_daemon", "docker.service"))
        return CommandResult(("systemctl",), 0, "", "")

    def is_enabled(self) -> bool:
        return False

    def is_active(self) -> bool:
        return False


class FakeUserSpace:
    """假用户空间管理：只记录调用，不碰宿主。"""

    def __init__(self, exists: bool = True):
        self.exists = exists
        self.calls: list[str] = []
        self.removed_users: list[SystemUser] = []
        self.home_removed = False

    def user_exists(self, name: str) -> bool:
        self.calls.append(f"user_exists:{name}")
        return self.exists

    def lookup_user(self, name: str) -> SystemUser | None:
        if not self.exists:
            return None
        return SystemUser(name=name, uid=4242, gid=4242, home=Path("/nonexistent/home"))

    def remove_user(self, user: SystemUser, remove_home: bool = True) -> bool:
        self.calls.append(f"remove_user:{user.name}")
        self.removed_users.append(user)
        self.exists = False
        return True

    def unit_path(self, user: SystemUser) -> Path:
        return user.home / ".config" / "systemd" / "user" / "docker.service"

    def disable_linger(self, user_name: str) -> bool:
        self.calls.append(f"disable_linger:{user_name}")
        return True

    def linger_state(self, user_name: str) -> bool | None:
        return False

    def read_subid_entries(self, user_name: str) -> dict[str, tuple[int, int]]:
        return {}

    def remove_subid_range(self, user_name: str) -> bool:
        self.calls.append(f"remove_subid_range:{user_name}")
        return False


def _patch_delete(service: SandboxService, daemon: FakeDaemon, userspace: FakeUserSpace) -> None:
    """把删除路径依赖的宿主交互换成假实现。"""
    service.userspace = userspace  # type: ignore[assignment]
    service._daemon_for_user = lambda user: daemon  # type: ignore[method-assign]
    service._remove_unit_files = lambda unit_path: True  # type: ignore[method-assign]


def test_delete_does_not_remove_user_specified_network(service: SandboxService) -> None:
    """删除沙箱时，用户指定的网络不被回收。"""
    metadata = _demo_metadata()
    metadata.network_owned = False
    service.store.save(metadata)
    daemon = FakeDaemon(containers=["sandbox-demo"], networks=["demo-net"])
    _patch_delete(service, daemon, FakeUserSpace())
    result = service.delete("demo")
    assert ("remove_network", "demo-net") not in daemon.calls
    assert result.existed is True


def test_delete_removes_platform_owned_network(service: SandboxService) -> None:
    """删除沙箱时，平台自建的网络被回收。"""
    metadata = _demo_metadata()
    metadata.network_owned = True
    service.store.save(metadata)
    daemon = FakeDaemon(containers=["sandbox-demo"], networks=["demo-net"])
    _patch_delete(service, daemon, FakeUserSpace())
    service.delete("demo")
    assert ("remove_network", "demo-net") in daemon.calls


def test_delete_reports_failed_items(service: SandboxService) -> None:
    """删除结果逐项检查返回码，失败项如实上报。"""
    metadata = _demo_metadata()
    service.store.save(metadata)
    daemon = FakeDaemon(containers=["sandbox-demo"], networks=["demo-net"])
    daemon.remove_container_ok = False
    _patch_delete(service, daemon, FakeUserSpace())
    result = service.delete("demo")
    assert any("容器 sandbox-demo 删除失败" in item for item in result.failed)
    assert not any("容器 sandbox-demo" in item for item in result.removed)


def test_delete_uses_live_user_info_not_metadata(service: SandboxService) -> None:
    """删除路径用现查到的用户信息，不信元数据里的 uid 与家目录。"""
    metadata = _demo_metadata()
    metadata.uid = 999999
    metadata.home = "/tmp/attacker-home"
    service.store.save(metadata)
    daemon = FakeDaemon(containers=[], networks=[])
    userspace = FakeUserSpace()
    _patch_delete(service, daemon, userspace)
    service.delete("demo")
    # 删用户时用的是现查到的 uid 与家目录，不是元数据里写的
    assert len(userspace.removed_users) == 1
    removed = userspace.removed_users[0]
    assert removed.uid == 4242
    assert str(removed.home) == "/nonexistent/home"


def test_delete_refuses_invalid_system_user_name(service: SandboxService) -> None:
    """元数据里的系统用户名非法时，拒绝用它执行特权命令。"""
    metadata = _demo_metadata()
    metadata.system_user = "evil; rm -rf /"
    service.store.save(metadata)
    daemon = FakeDaemon(containers=["sandbox-demo"], networks=["demo-net"])
    userspace = FakeUserSpace()
    _patch_delete(service, daemon, userspace)
    result = service.delete("demo")
    assert userspace.calls == []
    assert any("名字非法" in item for item in result.failed)


# ---------------------------------------------------------------- 回滚
def test_rollback_keeps_preexisting_user(service: SandboxService, monkeypatch) -> None:
    """回滚不删既有用户：只有本次新建的用户才进回滚清单。"""
    calls: list[str] = []

    class Userspace:
        def ensure_user(self, name: str) -> SystemUser:
            calls.append(f"ensure_user:{name}")
            return SystemUser(name=name, uid=1001, gid=1001, home=Path("/home/x"), created=False)

        def allocate_subid_range(self, name: str):
            raise RuntimeError("故意失败，触发回滚")

        def user_exists(self, name: str) -> bool:
            return True

        def remove_user(self, user, remove_home: bool = True) -> bool:
            calls.append(f"remove_user:{user.name}")
            return True

    service.userspace = Userspace()  # type: ignore[assignment]
    monkeypatch.setattr(service, "_ensure_data_directories", lambda: None)
    with pytest.raises(LifecycleError):
        service.create(CreateRequest(name="demo", image="busybox"))
    assert "ensure_user:sandbox-demo" in calls
    assert not any(item.startswith("remove_user:") for item in calls)


def test_rollback_removes_newly_created_user(service: SandboxService, monkeypatch) -> None:
    """本次新建的用户失败后要回滚删除。"""
    calls: list[str] = []

    class Userspace:
        def ensure_user(self, name: str) -> SystemUser:
            calls.append(f"ensure_user:{name}")
            return SystemUser(name=name, uid=1001, gid=1001, home=Path("/home/x"), created=True)

        def allocate_subid_range(self, name: str):
            raise RuntimeError("故意失败，触发回滚")

        def user_exists(self, name: str) -> bool:
            return True

        def remove_user(self, user, remove_home: bool = True) -> bool:
            calls.append(f"remove_user:{user.name}")
            return True

    service.userspace = Userspace()  # type: ignore[assignment]
    monkeypatch.setattr(service, "_ensure_data_directories", lambda: None)
    with pytest.raises(LifecycleError):
        service.create(CreateRequest(name="demo", image="busybox"))
    assert "remove_user:sandbox-demo" in calls


def test_ensure_user_marks_created_flag(monkeypatch) -> None:
    """ensure_user 返回本次是否新建。"""
    manager = UserSpaceManager()
    monkeypatch.setattr(
        manager,
        "lookup_user",
        lambda name: SystemUser(name=name, uid=1001, gid=1001, home=Path("/home/x")),
    )
    assert manager.ensure_user("sandbox-demo").created is False

    monkeypatch.setattr(manager, "lookup_user", lambda name: None)
    monkeypatch.setattr(
        "sandbox_platform.userspace.run",
        lambda argv, **kwargs: CommandResult(tuple(argv), 0, "", ""),
    )
    monkeypatch.setattr(
        manager,
        "lookup_user",
        lambda name: SystemUser(name=name, uid=1002, gid=1002, home=Path("/home/y")),
    )
    # 第一次查不到（走创建），创建后查得到
    calls = {"count": 0}

    def fake_lookup(name: str) -> SystemUser | None:
        calls["count"] += 1
        if calls["count"] == 1:
            return None
        return SystemUser(name=name, uid=1002, gid=1002, home=Path("/home/y"))

    monkeypatch.setattr(manager, "lookup_user", fake_lookup)
    assert manager.ensure_user("sandbox-demo").created is True


# ---------------------------------------------------------------- 用户与子 ID 段
def test_terminate_user_reports_processes_remaining(monkeypatch) -> None:
    """terminate_user 返回真实结果：进程没清空就返回 False。"""
    manager = UserSpaceManager()
    monkeypatch.setattr(manager, "_user_pids", lambda name: [4242])
    monkeypatch.setattr(manager, "_wait_user_processes_gone", lambda name, attempts: False)
    recorded: list[list[str]] = []

    def fake_run(argv, **kwargs):
        recorded.append(list(argv))
        return CommandResult(tuple(argv), 0, "", "")

    monkeypatch.setattr("sandbox_platform.userspace.run", fake_run)
    assert manager.terminate_user("sandbox-demo", uid=1001) is False
    # 升级处置：先停用户级管理器，再强杀残留进程
    assert any(item[-2:] == ["stop", "user@1001.service"] for item in recorded)
    assert any(item[-2:] == ["-9", "4242"] for item in recorded)


def test_remove_user_keeps_home_when_processes_remain(monkeypatch, tmp_path: Path) -> None:
    """进程未清空时不删家目录，并如实返回未完全回收。"""
    manager = UserSpaceManager()
    home = tmp_path / "home"
    home.mkdir()
    (home / "keep.txt").write_text("keep", encoding="utf-8")
    user = SystemUser(name="sandbox-demo", uid=1001, gid=1001, home=home)
    monkeypatch.setattr(manager, "terminate_user", lambda name, uid=None: False)
    monkeypatch.setattr(manager, "wait_for_runtime_gone", lambda uid, timeout=30: True)
    monkeypatch.setattr(
        "sandbox_platform.userspace.run",
        lambda argv, **kwargs: CommandResult(tuple(argv), 0, "", ""),
    )
    assert manager.remove_user(user) is False
    assert home.exists(), "进程未清空时家目录必须保留"


def test_remove_subid_range_takes_lock(config, monkeypatch) -> None:
    """子 ID 段回收必须走子 ID 段锁（与分配路径同一把锁）。"""
    manager = UserSpaceManager(config, Privilege(enabled=False))
    locks: list[str] = []

    import fcntl as fcntl_module

    original = fcntl_module.flock

    def fake_flock(fd, operation):
        locks.append(operation)
        return original(fd, operation)

    monkeypatch.setattr("sandbox_platform.userspace.fcntl.flock", fake_flock)
    monkeypatch.setattr(manager, "_read_text", lambda path: "")
    manager.remove_subid_range("sandbox-demo")
    assert fcntl_module.LOCK_EX in locks


# ---------------------------------------------------------------- 守护进程
def test_containers_on_network_returns_none_on_probe_failure(monkeypatch) -> None:
    """探测失败用 None 表达，与「确实没有容器」区分开。"""
    daemon = UserDaemon(UserContext(user="u", uid=1, gid=1, home=Path("/home/u")))
    monkeypatch.setattr(
        daemon,
        "docker",
        lambda args, **kwargs: CommandResult(tuple(args), 1, "", "network not found"),
    )
    assert daemon.containers_on_network("demo-net") is None


def test_containers_on_network_returns_empty_list_on_success(monkeypatch) -> None:
    """探测成功但没有容器时返回空列表。"""
    daemon = UserDaemon(UserContext(user="u", uid=1, gid=1, home=Path("/home/u")))
    monkeypatch.setattr(
        daemon,
        "docker",
        lambda args, **kwargs: CommandResult(tuple(args), 0, "", ""),
    )
    assert daemon.containers_on_network("demo-net") == []


def test_start_daemon_uses_no_block(monkeypatch) -> None:
    """启动守护进程用 --no-block，避免阻塞在 systemd 的 start 上。"""
    daemon = UserDaemon(UserContext(user="u", uid=1, gid=1, home=Path("/home/u")))
    recorded: list[list[str]] = []

    def fake_systemctl(args, **kwargs):
        recorded.append(list(args))
        return CommandResult(tuple(args), 0, "", "")

    monkeypatch.setattr(daemon, "systemctl", fake_systemctl)
    daemon.start_daemon()
    assert recorded == [["start", "--no-block", "docker.service"]]


def test_systemctl_retry_attempts_are_five(monkeypatch) -> None:
    """systemctl_retry 默认最多试 5 次。"""
    daemon = UserDaemon(UserContext(user="u", uid=1, gid=1, home=Path("/home/u")))
    attempts: list[int] = []

    def fake_systemctl(args, **kwargs):
        attempts.append(1)
        return CommandResult(tuple(args), 1, "", "fail")

    monkeypatch.setattr(daemon, "systemctl", fake_systemctl)
    monkeypatch.setattr("sandbox_platform.daemon.time.sleep", lambda seconds: None)
    daemon.systemctl_retry(["enable", "docker.service"])
    assert len(attempts) == 5


def test_ensure_user_manager_uses_no_block(monkeypatch) -> None:
    """系统级用户管理器启动同样不阻塞。"""
    daemon = UserDaemon(UserContext(user="u", uid=1001, gid=1, home=Path("/home/u")))
    recorded: list[list[str]] = []

    def fake_run(argv, **kwargs):
        recorded.append(list(argv))
        return CommandResult(tuple(argv), 0, "", "")

    monkeypatch.setattr("sandbox_platform.daemon.run", fake_run)
    daemon.ensure_user_manager()
    assert len(recorded) == 1
    assert recorded[0][-3:] == ["start", "--no-block", "user@1001.service"]


# ---------------------------------------------------------------- 命令轨迹
def test_command_error_message_quotes_arguments() -> None:
    """异常消息里的命令行用 shell 引号形式，含空格的参数不会被读错。"""
    error = CommandError(["rm", "-f", "/tmp/a b"], 1, "", "boom")
    assert "'/tmp/a b'" in str(error)


def test_command_trace_uses_shell_quoting(caplog) -> None:
    """命令轨迹日志用 shell 引号形式。"""
    import logging

    with caplog.at_level(logging.DEBUG, logger="sandbox_platform.command"):
        run(["echo", "a b"], check=False)
    assert any("'a b'" in record.getMessage() for record in caplog.records)


# ---------------------------------------------------------------- 辅助
def _demo_metadata() -> SandboxMetadata:
    return SandboxMetadata(
        name="demo",
        system_user="sandbox-demo",
        uid=1001,
        gid=1001,
        home="/home/sandbox-demo",
        subid_start=165536,
        subid_length=65536,
        image="busybox",
        socket_path="/run/user/1001/docker.sock",
        socket_mount_path="/var/run/docker.sock",
        container_name="sandbox-demo",
        container_id="abc123",
        network_name="demo-net",
        unit_path="/home/sandbox-demo/.config/systemd/user/docker.service",
    )
