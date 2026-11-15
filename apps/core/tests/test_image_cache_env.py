"""镜像缓存清单注入（``SANDBOX_IMAGE_CACHE_URL`` / ``SANDBOX_IMAGE_CACHE_TOKEN``）
的单元测试。

平台在创建 / 重启沙箱容器时由服务端递参、``_run_sandbox_container`` 平台强制
注入这两个 env（镜像缓存清单轮任务 03，与 ``SANDBOX_NETWORK`` / locale 同款口径）：

- 值由服务端递进来（URL 由服务端配置 / 探测得出、令牌从服务端凭据文件读出），
  核心包不做解析与兜底：递进来（非空）就注入，没递 / 空值就跳过（不注入空值）；
- **平台值优先**：用户声明的同名变量被平台值覆盖；
- **不进 metadata**：``metadata.env`` 只装用户声明值；
- **创建与重启两条路径覆盖**：同一注入点（``_run_sandbox_container``）；
- 实现**不就地改写调用方传入的 env dict**。

已知边角（行为钉住）：命令行路径不递参 → 沙箱缺这对 env（现状行为）；
console 对该沙箱执行一次「停止 → 启动」即自愈（启动路径递参重装配注入）。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sandbox_platform import CreateRequest, SandboxService, UserContext
from sandbox_platform import lifecycle as lifecycle_module
from sandbox_platform.command import CommandResult
from sandbox_platform.lifecycle import (
    SANDBOX_IMAGE_CACHE_TOKEN_ENV,
    SANDBOX_IMAGE_CACHE_URL_ENV,
    SANDBOX_NETWORK_ENV,
)
from sandbox_platform.userspace import SubIdRange, SystemUser

TEST_URL = "http://192.168.7.10:28799"
TEST_TOKEN = "sbxr_test_token_0123456789"


# ---------------------------------------------------------------- 假实现
class FakeDaemon:
    """记录 ``run_container`` 调用的假守护进程。"""

    def __init__(self, context: UserContext | None = None):
        self.context = context or UserContext(
            user="sandbox-demo",
            uid=1001,
            gid=1001,
            home=Path("/home/sandbox-demo"),
        )
        self.run_calls: list[dict] = []
        self.networks: list[str] = []
        self.running_containers: list[str] = []
        self.network_containers: list[str] = []

    # --- 创建/启动路径用到的宿主交互 ---
    def wait_for_runtime_dir(self, timeout: int = 60) -> bool:
        return True

    def ensure_user_manager(self, timeout: int = 120) -> CommandResult:
        return CommandResult(("systemctl",), 0, "", "")

    def systemctl_retry(self, args, **kwargs) -> CommandResult:
        return CommandResult(tuple(args), 0, "", "")

    def wait_for_socket(self, timeout: int = 90) -> bool:
        return True

    def is_active(self) -> bool:
        return True

    def network_exists(self, name: str) -> bool:
        return name in self.networks

    def create_network(self, name: str) -> CommandResult:
        self.networks.append(name)
        return CommandResult(("docker", "network", "create", name), 0, "", "")

    def container_exists(self, name: str) -> bool:
        return False

    def remove_container(self, name: str) -> CommandResult:
        return CommandResult(("docker", "rm", name), 0, "", "")

    def container_id(self, name: str) -> str | None:
        return "cafefeed"

    def container_running(self, name: str) -> bool:
        return name in self.running_containers

    def containers_on_network(self, network: str) -> list[str] | None:
        return list(self.network_containers)

    def can_access_path(self, path: str | Path) -> bool:
        return True

    def run_container(self, **kwargs) -> CommandResult:
        self.run_calls.append(kwargs)
        return CommandResult(("docker", "run"), 0, "", "")


class FakeUserSpace:
    """假用户空间管理：只记录调用，不碰宿主。"""

    def __init__(self, user: SystemUser):
        self.user = user

    def ensure_user(self, name: str) -> SystemUser:
        return self.user

    def lookup_user(self, name: str) -> SystemUser | None:
        return self.user

    def allocate_subid_range(self, user_name: str) -> SubIdRange:
        return SubIdRange(start=165536, length=65536)

    def write_docker_unit(self, user: SystemUser) -> Path:
        return self.user.home / ".config/systemd/user/docker.service"

    def unit_path(self, user: SystemUser) -> Path:
        return self.user.home / ".config/systemd/user/docker.service"

    def enable_linger(self, user_name: str) -> bool:
        return True


def _patch_host(
    service: SandboxService,
    daemon: FakeDaemon,
    monkeypatch: pytest.MonkeyPatch,
) -> FakeUserSpace:
    """把创建/启动路径上的宿主交互换成假实现。"""
    user = SystemUser(
        name="sandbox-demo",
        uid=1001,
        gid=1001,
        home=Path("/home/sandbox-demo"),
        created=True,
    )
    userspace = FakeUserSpace(user)
    service.userspace = userspace  # type: ignore[assignment]
    monkeypatch.setattr(
        lifecycle_module, "UserDaemon", lambda context, privilege=None: daemon
    )
    monkeypatch.setattr(service, "_ensure_proxy_running", lambda step: None)
    monkeypatch.setattr(service, "_ensure_proxy_ready", lambda step, user: None)
    monkeypatch.setattr(service, "_install_ca_bundle", lambda step, user: None)
    monkeypatch.setattr(service, "_ensure_data_directories", lambda: None)
    monkeypatch.setattr(
        service.images, "ensure_image_from_source", lambda *args, **kwargs: None
    )
    return userspace


def _last_env(daemon: FakeDaemon) -> dict[str, str]:
    """取最近一次 ``run_container`` 传下去的 env。"""
    assert daemon.run_calls, "容器没有被启动过"
    return dict(daemon.run_calls[-1]["env"])


# ---------------------------------------------------------------- 注入点本体
def test_run_sandbox_container_injects_image_cache_envs(
    service: SandboxService,
) -> None:
    """两值都递进来：容器 env 里有这两个键，取值就是递进来的值。"""
    daemon = FakeDaemon()
    service._run_sandbox_container(
        daemon,
        container_name="sandbox-demo",
        image="busybox",
        mounts=[],
        network="demo-net",
        command=None,
        env={},
        workdir=None,
        name="demo",
        image_cache_url=TEST_URL,
        image_cache_token=TEST_TOKEN,
    )
    env = _last_env(daemon)
    assert env[SANDBOX_IMAGE_CACHE_URL_ENV] == TEST_URL
    assert env[SANDBOX_IMAGE_CACHE_TOKEN_ENV] == TEST_TOKEN


def test_run_sandbox_container_skips_missing_values(service: SandboxService) -> None:
    """没递参（缺省 None）：两个键都不在场（跳过注入，不注入空值）。"""
    daemon = FakeDaemon()
    service._run_sandbox_container(
        daemon,
        container_name="sandbox-demo",
        image="busybox",
        mounts=[],
        network="demo-net",
        command=None,
        env={},
        workdir=None,
        name="demo",
    )
    env = _last_env(daemon)
    assert SANDBOX_IMAGE_CACHE_URL_ENV not in env
    assert SANDBOX_IMAGE_CACHE_TOKEN_ENV not in env


def test_run_sandbox_container_skips_empty_values(service: SandboxService) -> None:
    """递进来的是空串：按缺失处理（不注入空值）。"""
    daemon = FakeDaemon()
    service._run_sandbox_container(
        daemon,
        container_name="sandbox-demo",
        image="busybox",
        mounts=[],
        network="demo-net",
        command=None,
        env={},
        workdir=None,
        name="demo",
        image_cache_url="",
        image_cache_token="",
    )
    env = _last_env(daemon)
    assert SANDBOX_IMAGE_CACHE_URL_ENV not in env
    assert SANDBOX_IMAGE_CACHE_TOKEN_ENV not in env


def test_run_sandbox_container_injects_values_independently(
    service: SandboxService,
) -> None:
    """只递了一个值：那个注入、另一个跳过（两值各自独立判定）。"""
    daemon = FakeDaemon()
    service._run_sandbox_container(
        daemon,
        container_name="sandbox-demo",
        image="busybox",
        mounts=[],
        network="demo-net",
        command=None,
        env={},
        workdir=None,
        name="demo",
        image_cache_url=TEST_URL,
    )
    env = _last_env(daemon)
    assert env[SANDBOX_IMAGE_CACHE_URL_ENV] == TEST_URL
    assert SANDBOX_IMAGE_CACHE_TOKEN_ENV not in env


def test_image_cache_env_overrides_user_env(service: SandboxService) -> None:
    """平台值优先：用户声明的同名变量被平台值覆盖，其余用户 env 原样保留。"""
    daemon = FakeDaemon()
    service._run_sandbox_container(
        daemon,
        container_name="sandbox-demo",
        image="busybox",
        mounts=[],
        network="demo-net",
        command=None,
        env={
            SANDBOX_IMAGE_CACHE_URL_ENV: "http://user-declared:1",
            SANDBOX_IMAGE_CACHE_TOKEN_ENV: "sbxr_user_declared",
            "TOKEN": "abc",
        },
        workdir=None,
        name="demo",
        image_cache_url=TEST_URL,
        image_cache_token=TEST_TOKEN,
    )
    env = _last_env(daemon)
    assert env[SANDBOX_IMAGE_CACHE_URL_ENV] == TEST_URL
    assert env[SANDBOX_IMAGE_CACHE_TOKEN_ENV] == TEST_TOKEN
    assert env[SANDBOX_IMAGE_CACHE_URL_ENV] != "http://user-declared:1"
    assert env[SANDBOX_IMAGE_CACHE_TOKEN_ENV] != "sbxr_user_declared"
    # 其它用户声明的环境变量原样保留
    assert env["TOKEN"] == "abc"


def test_image_cache_env_does_not_mutate_caller_env(service: SandboxService) -> None:
    """实现不得就地改写调用方传入的 env dict（合并在副本上做）。"""
    daemon = FakeDaemon()
    caller_env = {SANDBOX_IMAGE_CACHE_URL_ENV: "http://user-declared:1"}
    service._run_sandbox_container(
        daemon,
        container_name="sandbox-demo",
        image="busybox",
        mounts=[],
        network="demo-net",
        command=None,
        env=caller_env,
        workdir=None,
        name="demo",
        image_cache_url=TEST_URL,
        image_cache_token=TEST_TOKEN,
    )
    assert caller_env == {SANDBOX_IMAGE_CACHE_URL_ENV: "http://user-declared:1"}
    assert _last_env(daemon)[SANDBOX_IMAGE_CACHE_URL_ENV] == TEST_URL


# ---------------------------------------------------------------- 创建路径
def test_create_path_injects_image_cache_envs(
    service: SandboxService, monkeypatch: pytest.MonkeyPatch
) -> None:
    """创建路径：服务端递参 → 容器 env 里有这两个键；两值不进 metadata。"""
    daemon = FakeDaemon()
    _patch_host(service, daemon, monkeypatch)

    result = service.create(
        CreateRequest(
            name="demo",
            image="busybox",
            env={"TOKEN": "abc"},
            image_cache_url=TEST_URL,
            image_cache_token=TEST_TOKEN,
        )
    )

    env = _last_env(daemon)
    assert env[SANDBOX_IMAGE_CACHE_URL_ENV] == TEST_URL
    assert env[SANDBOX_IMAGE_CACHE_TOKEN_ENV] == TEST_TOKEN
    assert env["TOKEN"] == "abc"
    # 两值不进 metadata：metadata.env 只装用户声明值（含网络注入同款口径）
    assert result.metadata.env == {"TOKEN": "abc"}
    assert SANDBOX_IMAGE_CACHE_URL_ENV not in result.metadata.env
    assert SANDBOX_IMAGE_CACHE_TOKEN_ENV not in result.metadata.env
    assert SANDBOX_NETWORK_ENV not in result.metadata.env
    # 落盘的元数据同样不含平台注入值
    persisted = service.get("demo").env
    assert SANDBOX_IMAGE_CACHE_URL_ENV not in persisted
    assert SANDBOX_IMAGE_CACHE_TOKEN_ENV not in persisted


def test_create_path_without_params_leaves_envs_absent(
    service: SandboxService, monkeypatch: pytest.MonkeyPatch
) -> None:
    """创建路径不递参（命令行现状）：两个键都不在场——已知边角，行为钉住。"""
    daemon = FakeDaemon()
    _patch_host(service, daemon, monkeypatch)

    service.create(CreateRequest(name="demo", image="busybox"))

    env = _last_env(daemon)
    assert SANDBOX_IMAGE_CACHE_URL_ENV not in env
    assert SANDBOX_IMAGE_CACHE_TOKEN_ENV not in env


def test_create_path_partial_params(service: SandboxService, monkeypatch: pytest.MonkeyPatch) -> None:
    """创建路径只递 URL（令牌文件缺失时的服务端形态）：URL 注入、令牌跳过。"""
    daemon = FakeDaemon()
    _patch_host(service, daemon, monkeypatch)

    result = service.create(
        CreateRequest(name="demo", image="busybox", image_cache_url=TEST_URL)
    )

    env = _last_env(daemon)
    assert env[SANDBOX_IMAGE_CACHE_URL_ENV] == TEST_URL
    assert SANDBOX_IMAGE_CACHE_TOKEN_ENV not in env
    assert result.metadata.env == {}


# ---------------------------------------------------------------- 重启路径（自愈口径）
def test_start_path_injects_image_cache_envs(
    service: SandboxService, monkeypatch: pytest.MonkeyPatch
) -> None:
    """重启路径递参：缺 env 的既有沙箱「停止 → 启动」一次后 env 在场（自愈）。"""
    daemon = FakeDaemon()
    _patch_host(service, daemon, monkeypatch)
    # 创建时不递参（命令行创建的现状：沙箱缺这对 env）
    service.create(CreateRequest(name="demo", image="busybox", env={"TOKEN": "abc"}))
    daemon.run_calls.clear()
    assert SANDBOX_IMAGE_CACHE_URL_ENV not in service.get("demo").env

    service.start(
        "demo", image_cache_url=TEST_URL, image_cache_token=TEST_TOKEN
    )

    env = _last_env(daemon)
    assert env[SANDBOX_IMAGE_CACHE_URL_ENV] == TEST_URL
    assert env[SANDBOX_IMAGE_CACHE_TOKEN_ENV] == TEST_TOKEN
    assert env["TOKEN"] == "abc"
    # 重启路径同样不把平台注入值写进 metadata
    assert service.get("demo").env == {"TOKEN": "abc"}


def test_start_path_without_params_leaves_envs_absent(
    service: SandboxService, monkeypatch: pytest.MonkeyPatch
) -> None:
    """重启路径不递参（命令行直接 start 的现状）：两个键都不在场——边角另一半。"""
    daemon = FakeDaemon()
    _patch_host(service, daemon, monkeypatch)
    service.create(
        CreateRequest(
            name="demo",
            image="busybox",
            image_cache_url=TEST_URL,
            image_cache_token=TEST_TOKEN,
        )
    )
    daemon.run_calls.clear()

    service.start("demo")

    env = _last_env(daemon)
    assert SANDBOX_IMAGE_CACHE_URL_ENV not in env
    assert SANDBOX_IMAGE_CACHE_TOKEN_ENV not in env
