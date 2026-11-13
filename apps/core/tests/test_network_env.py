"""沙箱容器环境变量注入的单元测试。

平台在创建/重启沙箱容器时注入两类变量：
- ``SANDBOX_NETWORK``（**实际生效的网络名**）：默认 ``<沙箱名>-net``；
  用户创建时指定了自定义网络则取那个自定义值；
- locale（``LANG`` / ``LC_ALL`` = ``C.UTF-8``）：**平台强制层**，用户声明的
  同名变量被平台值覆盖（镜像 ENV 只是基础层，docker 的 ``-e`` 会覆盖它）。

覆盖口径：
- 默认网络与用户自定义网络两 Case；
- 创建与重启两条路径；
- 平台注入值优先于用户声明的同名变量；
- 平台注入值**不落 metadata**（``metadata.env`` 只装用户声明值）；
- 实现**不就地改写调用方传入的 env dict**。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sandbox_platform import CreateRequest, SandboxService, UserContext
from sandbox_platform import lifecycle as lifecycle_module
from sandbox_platform.command import CommandResult
from sandbox_platform.lifecycle import (
    SANDBOX_LANG_ENV,
    SANDBOX_LC_ALL_ENV,
    SANDBOX_LOCALE_VALUE,
    SANDBOX_NETWORK_ENV,
)
from sandbox_platform.userspace import SubIdRange, SystemUser

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

    # --- 探测类（签名对齐真守护进程，见 daemon.py）---
    def container_running(self, name: str) -> bool:
        """容器是否在运行（假实现：未登记的容器一律「不在运行」）。"""
        return name in self.running_containers

    def containers_on_network(self, network: str) -> list[str] | None:
        """网络上的容器名（假实现：返回登记的容器名列表；探测失败才返回 ``None``）。"""
        return list(self.network_containers)

    def can_access_path(self, path: str | Path) -> bool:
        """宿主路径对沙箱用户是否可读可穿过（假实现：一律可访问）。"""
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
def test_run_sandbox_container_injects_default_network(service: SandboxService) -> None:
    """默认网络：注入值就是实际生效的 ``<沙箱名>-net``。"""
    daemon = FakeDaemon()
    result = service._run_sandbox_container(
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
    assert result.ok is True
    assert _last_env(daemon)[SANDBOX_NETWORK_ENV] == "demo-net"
    # 传给 docker run 的网络参数与注入值必须一致（同一处来源）
    assert daemon.run_calls[-1]["network"] == "demo-net"


def test_run_sandbox_container_injects_custom_network(service: SandboxService) -> None:
    """用户自定义网络：注入值取自定义网络，不拼 ``<沙箱名>-net``。"""
    daemon = FakeDaemon()
    service._run_sandbox_container(
        daemon,
        container_name="sandbox-demo",
        image="busybox",
        mounts=[],
        network="shared-net",
        command=None,
        env={},
        workdir=None,
        name="demo",
    )
    assert _last_env(daemon)[SANDBOX_NETWORK_ENV] == "shared-net"
    assert _last_env(daemon)[SANDBOX_NETWORK_ENV] != "demo-net"


def test_platform_network_env_overrides_user_env(service: SandboxService) -> None:
    """用户声明了同名变量时，平台注入值优先。"""
    daemon = FakeDaemon()
    service._run_sandbox_container(
        daemon,
        container_name="sandbox-demo",
        image="busybox",
        mounts=[],
        network="demo-net",
        command=None,
        env={SANDBOX_NETWORK_ENV: "user-declared-net"},
        workdir=None,
        name="demo",
    )
    assert _last_env(daemon)[SANDBOX_NETWORK_ENV] == "demo-net"


def test_user_env_is_kept_alongside_platform_env(service: SandboxService) -> None:
    """平台注入是追加：用户声明的其它环境变量原样保留。"""
    daemon = FakeDaemon()
    service._run_sandbox_container(
        daemon,
        container_name="sandbox-demo",
        image="busybox",
        mounts=[],
        network="demo-net",
        command=None,
        env={"TOKEN": "abc"},
        workdir=None,
        name="demo",
    )
    env = _last_env(daemon)
    assert env["TOKEN"] == "abc"
    assert env[SANDBOX_NETWORK_ENV] == "demo-net"


def test_platform_locale_env_overrides_user_declared_locale(
    service: SandboxService,
) -> None:
    """locale 强制层：用户声明的 LANG / LC_ALL 被平台值覆盖，其余用户 env 保留。

    这是审查确认的真实缺陷：镜像 ENV 只是基础层，docker 的 ``-e`` 会覆盖它，
    且 ``LC_ALL`` 优先级高于 ``LANG``——用户声明任一条都能把容器内 locale
    打回非 UTF-8（中文输出可能间歇乱码）。
    """
    daemon = FakeDaemon()
    service._run_sandbox_container(
        daemon,
        container_name="sandbox-demo",
        image="busybox",
        mounts=[],
        network="demo-net",
        command=None,
        env={
            SANDBOX_LANG_ENV: "zh_CN.UTF-8",
            SANDBOX_LC_ALL_ENV: "zh_CN.UTF-8",
            "TOKEN": "abc",
        },
        workdir=None,
        name="demo",
    )
    env = _last_env(daemon)
    assert env[SANDBOX_LANG_ENV] == SANDBOX_LOCALE_VALUE
    assert env[SANDBOX_LC_ALL_ENV] == SANDBOX_LOCALE_VALUE
    assert env[SANDBOX_LANG_ENV] == "C.UTF-8"
    assert env[SANDBOX_LC_ALL_ENV] == "C.UTF-8"
    # 其它用户声明的环境变量原样保留
    assert env["TOKEN"] == "abc"


def test_platform_locale_env_injected_without_user_env(service: SandboxService) -> None:
    """用户没声明 locale 时，平台照样注入两条（与镜像 ENV 一致的取值）。"""
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
    assert env[SANDBOX_LANG_ENV] == SANDBOX_LOCALE_VALUE
    assert env[SANDBOX_LC_ALL_ENV] == SANDBOX_LOCALE_VALUE


def test_platform_env_does_not_mutate_caller_env(service: SandboxService) -> None:
    """实现不得就地改写调用方传入的 env dict（合并在副本上做）。"""
    daemon = FakeDaemon()
    caller_env = {"TOKEN": "abc"}
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
    )
    # 调用方的 dict 原样返回：没被塞进平台注入值，也没被改值
    assert caller_env == {"TOKEN": "abc"}
    # 注入值只出现在传给 docker run 的那份副本里
    injected = _last_env(daemon)
    assert injected[SANDBOX_NETWORK_ENV] == "demo-net"
    assert injected[SANDBOX_LANG_ENV] == SANDBOX_LOCALE_VALUE
    assert injected[SANDBOX_LC_ALL_ENV] == SANDBOX_LOCALE_VALUE


# ---------------------------------------------------------------- 创建路径
def test_create_path_injects_default_network(
    service: SandboxService, monkeypatch: pytest.MonkeyPatch
) -> None:
    """创建路径（默认网络）：容器 env 里有 ``SANDBOX_NETWORK=<沙箱名>-net``。"""
    daemon = FakeDaemon()
    _patch_host(service, daemon, monkeypatch)

    result = service.create(CreateRequest(name="demo", image="busybox"))

    assert _last_env(daemon)[SANDBOX_NETWORK_ENV] == "demo-net"
    assert result.metadata.network_name == "demo-net"


def test_create_path_injects_custom_network(
    service: SandboxService, monkeypatch: pytest.MonkeyPatch
) -> None:
    """创建路径（用户自定义网络）：注入值取自定义网络，绝不拼 ``<沙箱名>-net``。"""
    daemon = FakeDaemon()
    _patch_host(service, daemon, monkeypatch)

    result = service.create(
        CreateRequest(name="demo", image="busybox", network_name="shared-net")
    )

    assert _last_env(daemon)[SANDBOX_NETWORK_ENV] == "shared-net"
    assert result.metadata.network_name == "shared-net"
    assert result.metadata.network_owned is False
    # 平台注入值同样不落 metadata（自定义网络这条路径也不例外）
    assert result.metadata.env == {}
    assert SANDBOX_NETWORK_ENV not in result.metadata.env
    assert SANDBOX_LANG_ENV not in result.metadata.env
    assert SANDBOX_LC_ALL_ENV not in result.metadata.env


def test_create_path_locale_env_not_stored_in_metadata(
    service: SandboxService, monkeypatch: pytest.MonkeyPatch
) -> None:
    """创建路径：locale 强制值不落 metadata（metadata.env 只装用户声明值）。"""
    daemon = FakeDaemon()
    _patch_host(service, daemon, monkeypatch)

    result = service.create(
        CreateRequest(
            name="demo",
            image="busybox",
            env={SANDBOX_LANG_ENV: "zh_CN.UTF-8", "TOKEN": "abc"},
        )
    )

    # 容器里拿到的是平台强制值
    env = _last_env(daemon)
    assert env[SANDBOX_LANG_ENV] == SANDBOX_LOCALE_VALUE
    assert env[SANDBOX_LC_ALL_ENV] == SANDBOX_LOCALE_VALUE
    # metadata 只留用户声明的值（用户声明的 LANG 原样落盘，平台强制值不在其中）
    assert result.metadata.env == {SANDBOX_LANG_ENV: "zh_CN.UTF-8", "TOKEN": "abc"}
    assert result.metadata.env[SANDBOX_LANG_ENV] == "zh_CN.UTF-8"
    assert SANDBOX_LC_ALL_ENV not in result.metadata.env


def test_create_path_network_env_not_stored_in_metadata(
    service: SandboxService, monkeypatch: pytest.MonkeyPatch
) -> None:
    """平台注入值不进 metadata：``metadata.env`` 只装用户声明的值。"""
    daemon = FakeDaemon()
    _patch_host(service, daemon, monkeypatch)

    result = service.create(
        CreateRequest(name="demo", image="busybox", env={"TOKEN": "abc"})
    )

    assert result.metadata.env == {"TOKEN": "abc"}
    assert SANDBOX_NETWORK_ENV not in result.metadata.env
    # 落盘的元数据同样不含平台注入值
    assert SANDBOX_NETWORK_ENV not in service.get("demo").env


# ---------------------------------------------------------------- 重启路径
def test_start_path_injects_network_env(
    service: SandboxService, monkeypatch: pytest.MonkeyPatch
) -> None:
    """重启路径：容器 env 里有 ``SANDBOX_NETWORK``，值取元数据里的实际生效网络名。"""
    daemon = FakeDaemon()
    _patch_host(service, daemon, monkeypatch)
    service.create(CreateRequest(name="demo", image="busybox"))
    daemon.run_calls.clear()

    service.start("demo")

    assert _last_env(daemon)[SANDBOX_NETWORK_ENV] == "demo-net"


def test_start_path_injects_custom_network(
    service: SandboxService, monkeypatch: pytest.MonkeyPatch
) -> None:
    """重启路径（用户自定义网络）：注入值仍是那个自定义网络。"""
    daemon = FakeDaemon()
    _patch_host(service, daemon, monkeypatch)
    service.create(
        CreateRequest(name="demo", image="busybox", network_name="shared-net")
    )
    daemon.run_calls.clear()

    service.start("demo")

    assert _last_env(daemon)[SANDBOX_NETWORK_ENV] == "shared-net"


def test_start_path_network_env_not_stored_in_metadata(
    service: SandboxService, monkeypatch: pytest.MonkeyPatch
) -> None:
    """重启路径也不把平台注入值写进 metadata。"""
    daemon = FakeDaemon()
    _patch_host(service, daemon, monkeypatch)
    service.create(CreateRequest(name="demo", image="busybox"))
    daemon.run_calls.clear()

    service.start("demo")

    assert SANDBOX_NETWORK_ENV not in service.get("demo").env


def test_start_path_forces_locale_env(
    service: SandboxService, monkeypatch: pytest.MonkeyPatch
) -> None:
    """重启路径：locale 强制层照样生效（用户声明的 LANG 被平台值覆盖）。"""
    daemon = FakeDaemon()
    _patch_host(service, daemon, monkeypatch)
    service.create(
        CreateRequest(
            name="demo",
            image="busybox",
            env={SANDBOX_LANG_ENV: "zh_CN.UTF-8", SANDBOX_LC_ALL_ENV: "zh_CN.UTF-8"},
        )
    )
    daemon.run_calls.clear()

    service.start("demo")

    env = _last_env(daemon)
    assert env[SANDBOX_LANG_ENV] == SANDBOX_LOCALE_VALUE
    assert env[SANDBOX_LC_ALL_ENV] == SANDBOX_LOCALE_VALUE
