"""统一镜像代理的单元测试（不触碰宿主特权资源）。"""

from __future__ import annotations

import json
import logging
import os
import shutil
from pathlib import Path

import pytest

from sandbox_platform import (
    CommandError,
    LifecycleError,
    PlatformConfig,
    ProxyProbe,
    ProxyError,
    RegistryProxyManager,
    SystemUser,
    UserSpaceManager,
)
from sandbox_platform.command import CommandResult
from sandbox_platform.proxy import (
    CA_CERT_FILENAME,
    PROXY_CA_MOUNT,
    PROXY_CACHE_MOUNT,
    ca_bundle_path,
    proxy_container_name,
)

SYSTEM_CA = "-----BEGIN CERTIFICATE-----\n系统根证书\n-----END CERTIFICATE-----\n"
PROXY_CA = "-----BEGIN CERTIFICATE-----\n代理根证书\n-----END CERTIFICATE-----\n"


class FakeDocker:
    """假的 docker 命令执行器：维护容器状态，并按 install 语义落盘。"""

    def __init__(self) -> None:
        self.commands: list[list[str]] = []
        self.containers: dict[str, dict] = {}

    def __call__(self, argv, *, env=None, check=False, timeout=None, cwd=None, stdin_text=None):
        args = [str(item) for item in argv]
        # 去掉特权前缀（sudo -n），只关心真实命令
        while args[:1] == ["sudo"]:
            args = args[2:]
        self.commands.append(args)
        if args[:1] == ["install"]:
            self._apply_install(args)
            return CommandResult(tuple(args), 0, "", "")
        if "inspect" in args:
            return self._inspect(args)
        if "run" in args:
            return self._run(args)
        if "start" in args:
            name = args[-1]
            if name in self.containers:
                self.containers[name]["running"] = True
                return CommandResult(tuple(args), 0, "", "")
            return CommandResult(tuple(args), 1, "", "no such container")
        if "rm" in args:
            self.containers.pop(args[-1], None)
            return CommandResult(tuple(args), 0, "", "")
        return CommandResult(tuple(args), 0, "", "")

    # ------------------------------------------------------------ docker 语义
    def _inspect(self, args: list[str]) -> CommandResult:
        name = args[-1]
        container = self.containers.get(name)
        if container is None:
            return CommandResult(tuple(args), 1, "", "no such object")
        template = args[args.index("--format") + 1] if "--format" in args else ""
        if "Mounts" in template:
            mounts = [
                {"Source": source, "Destination": destination}
                for source, destination in container["mounts"]
            ]
            return CommandResult(tuple(args), 0, json.dumps(mounts), "")
        if "Config.Env" in template:
            return CommandResult(
                tuple(args), 0, json.dumps(container.get("env", [])), ""
            )
        if "State.Running" in template:
            return CommandResult(tuple(args), 0, "true" if container["running"] else "false", "")
        return CommandResult(tuple(args), 0, "", "")

    def _run(self, args: list[str]) -> CommandResult:
        name = args[args.index("--name") + 1]
        mounts = []
        env = []
        for index, item in enumerate(args):
            if item.startswith("/") and ":" in item:
                source, destination = item.split(":", 1)
                if destination.startswith("/"):
                    mounts.append((source, destination))
            if item == "-e" and index + 1 < len(args):
                env.append(args[index + 1])
        self.containers[name] = {"running": True, "mounts": mounts, "env": env}
        return CommandResult(tuple(args), 0, "container-id", "")

    def _apply_install(self, args: list[str]) -> None:
        mode = args[args.index("-m") + 1] if "-m" in args else "0644"
        if "-d" in args:
            Path(args[-1]).mkdir(parents=True, exist_ok=True)
            return
        source, target = args[-2], args[-1]
        Path(target).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        os.chmod(target, int(mode, 8))

    def has(self, needle: str) -> bool:
        """是否执行过包含指定子命令的命令。"""
        return any(needle in command for command in self.commands)

    def creations(self) -> list[list[str]]:
        """所有「创建容器」的命令。"""
        return [cmd for cmd in self.commands if cmd[:2] == ["docker", "run"]]


class RemoveFailsDocker(FakeDocker):
    """删容器必失败的假 docker（``docker rm -f`` 返回非零）。

    用于钉「重建路径上删除失败必须报错」：旧容器删不掉时不能继续往下走
    （否则 env 漂移被静默吞掉）。
    """

    def __call__(self, argv, *, env=None, check=False, timeout=None, cwd=None, stdin_text=None):
        args = [str(item) for item in argv]
        while args[:1] == ["sudo"]:
            args = args[2:]
        if args[:2] == ["docker", "rm"]:
            self.commands.append(args)
            return CommandResult(tuple(args), 1, "", "cannot remove container")
        return super().__call__(
            argv,
            env=env,
            check=check,
            timeout=timeout,
            cwd=cwd,
            stdin_text=stdin_text,
        )


@pytest.fixture
def proxy_home(tmp_path: Path) -> Path:
    """代理数据根目录（临时路径）。"""
    home = tmp_path / "proxy-home"
    home.mkdir()
    return home


@pytest.fixture
def proxy_config(tmp_path: Path, proxy_home: Path) -> PlatformConfig:
    """带独立数据根与系统 CA 束路径的配置。"""
    system_ca = tmp_path / "system-ca.crt"
    system_ca.write_text(SYSTEM_CA, encoding="utf-8")
    return PlatformConfig.from_env(
        {
            "SANDBOX_PLATFORM_HOME": str(proxy_home),
            "SANDBOX_PLATFORM_SYSTEM_CA_BUNDLE": str(system_ca),
        }
    )


@pytest.fixture
def manager(proxy_config: PlatformConfig) -> RegistryProxyManager:
    """代理管理器实例。"""
    return RegistryProxyManager(proxy_config)


def _sandbox_user(home: Path = Path("/home/sandbox-demo")) -> SystemUser:
    """沙箱用户样例。"""
    return SystemUser(name="sandbox-demo", uid=1001, gid=1001, home=home)


# ---------------------------------------------------------------- 单元模板
def test_unit_template_injects_proxy_environment() -> None:
    """守护进程单元注入代理三件套与合并 CA 束路径。"""
    manager = UserSpaceManager()
    unit = manager.render_unit(_sandbox_user())
    assert "Environment=HTTPS_PROXY=http://127.0.0.1:3128" in unit
    assert "Environment=HTTP_PROXY=http://127.0.0.1:3128" in unit
    assert "Environment=NO_PROXY=localhost,127.0.0.1,::1" in unit
    assert (
        "Environment=SSL_CERT_FILE=/home/sandbox-demo/.config/sandbox-platform/"
        "registry-proxy-ca-bundle.crt" in unit
    )


def test_unit_template_ssl_cert_file_matches_bundle_path() -> None:
    """单元里的 SSL_CERT_FILE 与合并 CA 束落盘路径同源。"""
    manager = UserSpaceManager()
    user = _sandbox_user()
    unit = manager.render_unit(user)
    assert f"Environment=SSL_CERT_FILE={ca_bundle_path(user.home)}" in unit


def test_unit_template_keeps_roothess_requirements() -> None:
    """单元仍保留免 root 守护进程的必要设置。"""
    manager = UserSpaceManager()
    unit = manager.render_unit(_sandbox_user())
    assert "Delegate=yes" in unit
    assert "--rootless" in unit
    assert "DOCKER_HOST=unix:///run/user/1001/docker.sock" in unit


def test_proxy_address_is_configurable() -> None:
    """代理地址可由环境变量改写（适配不同宿主网络布局）。"""
    config = PlatformConfig.from_env({"SANDBOX_PLATFORM_PROXY_ADDRESS": "10.0.2.2"})
    manager = UserSpaceManager(config)
    unit = manager.render_unit(_sandbox_user())
    assert "Environment=HTTPS_PROXY=http://10.0.2.2:3128" in unit


# ---------------------------------------------------------------- 名称与路径
def test_proxy_container_name_uses_port_suffix() -> None:
    """默认端口用固定名，其它端口加后缀避免抢端口。"""
    assert proxy_container_name(3128) == "sandbox-platform-registry-proxy"
    assert proxy_container_name(33128) == "sandbox-platform-registry-proxy-33128"


def test_proxy_paths_follow_platform_home(proxy_config: PlatformConfig) -> None:
    """缓存与 CA 目录跟随平台数据根重定向。"""
    assert proxy_config.proxy_root == proxy_config.home / "registry-proxy"
    assert proxy_config.proxy_cache_dir == proxy_config.home / "registry-proxy" / "cache"
    assert proxy_config.proxy_ca_dir == proxy_config.home / "registry-proxy" / "ca"


# ---------------------------------------------------------------- 幂等与健康
def test_ensure_running_is_idempotent(manager: RegistryProxyManager, monkeypatch) -> None:
    """重复调用 ensure_running 不会重复创建容器。"""
    fake = FakeDocker()
    monkeypatch.setattr("sandbox_platform.proxy.run", fake)
    monkeypatch.setattr(
        manager,
        "probe",
        lambda: ProxyProbe(tcp=True, http=True, detail="ok"),
    )
    monkeypatch.setattr(manager, "host_image_exists", lambda: True)

    assert manager.ensure_running(timeout=5) is True
    assert manager.ensure_running(timeout=5) is True

    assert len(fake.creations()) == 1, "代理容器被重复创建"


def test_ensure_running_mounts_cache_and_ca(manager: RegistryProxyManager, monkeypatch) -> None:
    """代理容器挂载缓存目录与 CA 目录，并注入 REGISTRIES。"""
    fake = FakeDocker()
    monkeypatch.setattr("sandbox_platform.proxy.run", fake)
    monkeypatch.setattr(
        manager,
        "probe",
        lambda: ProxyProbe(tcp=True, http=True, detail="ok"),
    )
    monkeypatch.setattr(manager, "host_image_exists", lambda: True)

    manager.ensure_running(timeout=5)
    created = " ".join(fake.creations()[0])
    assert PROXY_CACHE_MOUNT in created
    assert PROXY_CA_MOUNT in created
    assert "REGISTRIES=docker.io ghcr.io quay.io gcr.io registry.k8s.io" in created
    assert "127.0.0.1:3128:3128" in created


def test_ensure_running_rebuilds_container_with_stale_mounts(
    manager: RegistryProxyManager, monkeypatch
) -> None:
    """数据根被重定向后，旧的代理容器挂载不再匹配，必须重建。"""
    fake = FakeDocker()
    fake.containers[manager.container_name] = {
        "running": True,
        "mounts": [("/old/path", PROXY_CACHE_MOUNT)],
    }
    monkeypatch.setattr("sandbox_platform.proxy.run", fake)
    monkeypatch.setattr(
        manager,
        "probe",
        lambda: ProxyProbe(tcp=True, http=True, detail="ok"),
    )
    monkeypatch.setattr(manager, "host_image_exists", lambda: True)

    assert manager.ensure_running(timeout=5) is True
    assert len(fake.creations()) == 1
    created = " ".join(fake.creations()[0])
    assert str(manager.config.proxy_cache_dir) in created


def test_ensure_running_injects_manifest_ttl_env(
    manager: RegistryProxyManager, monkeypatch
) -> None:
    """代理容器启动 env 显式带 manifest 三层有效期（**全部 180d**）。"""
    fake = FakeDocker()
    monkeypatch.setattr("sandbox_platform.proxy.run", fake)
    monkeypatch.setattr(
        manager,
        "probe",
        lambda: ProxyProbe(tcp=True, http=True, detail="ok"),
    )
    monkeypatch.setattr(manager, "host_image_exists", lambda: True)

    manager.ensure_running(timeout=5)
    created = " ".join(fake.creations()[0])
    assert "ENABLE_MANIFEST_CACHE=true" in created
    assert "MANIFEST_CACHE_PRIMARY_TIME=180d" in created
    assert "MANIFEST_CACHE_SECONDARY_TIME=180d" in created
    assert "MANIFEST_CACHE_DEFAULT_TIME=180d" in created


def test_ensure_running_injects_cache_inactive_180d(
    manager: RegistryProxyManager, monkeypatch
) -> None:
    """代理容器启动 env 显式带 ``CACHE_INACTIVE=180d``（统一 180 天的回收侧）。

    入口脚本的 ``CACHE_INACTIVE`` 默认 60d（平台不传就是这个值）：不显式
    传 180d，nginx 会在 60 天回收长期未访问的条目——manifest 声明的 180d
    有效期就形同虚设。
    """
    fake = FakeDocker()
    monkeypatch.setattr("sandbox_platform.proxy.run", fake)
    monkeypatch.setattr(
        manager,
        "probe",
        lambda: ProxyProbe(tcp=True, http=True, detail="ok"),
    )
    monkeypatch.setattr(manager, "host_image_exists", lambda: True)

    manager.ensure_running(timeout=5)
    created = " ".join(fake.creations()[0])
    assert "CACHE_INACTIVE=180d" in created


def _stale_env_container(manager: RegistryProxyManager) -> dict:
    """一个 env 过期（SECONDARY 仍是 60d）的代理容器状态。"""
    return {
        "running": True,
        "mounts": [
            (str(manager.config.proxy_cache_dir), PROXY_CACHE_MOUNT),
            (str(manager.config.proxy_ca_dir), PROXY_CA_MOUNT),
        ],
        "env": [
            "ENABLE_MANIFEST_CACHE=true",
            "MANIFEST_CACHE_PRIMARY_TIME=10m",
            "MANIFEST_CACHE_SECONDARY_TIME=60d",
            "MANIFEST_CACHE_DEFAULT_TIME=1h",
        ],
    }


def test_ensure_running_rebuilds_container_with_stale_env(
    manager: RegistryProxyManager, monkeypatch
) -> None:
    """容器 env 与当前配置不一致（旧的 60d 分层）→ 删除后重建，新 env 生效。

    ``docker restart`` 不会换 env：想让新的有效期真正落到容器上，必须重建。
    """
    fake = FakeDocker()
    fake.containers[manager.container_name] = _stale_env_container(manager)
    monkeypatch.setattr("sandbox_platform.proxy.run", fake)
    monkeypatch.setattr(
        manager,
        "probe",
        lambda: ProxyProbe(tcp=True, http=True, detail="ok"),
    )
    monkeypatch.setattr(manager, "host_image_exists", lambda: True)

    assert manager.ensure_running(timeout=5) is True
    assert len(fake.creations()) == 1, "env 漂移必须重建容器"
    created = " ".join(fake.creations()[0])
    assert "MANIFEST_CACHE_SECONDARY_TIME=180d" in created


def test_restart_recreates_container_when_env_differs(
    manager: RegistryProxyManager, monkeypatch
) -> None:
    """重启接口遇 env 漂移 → 重建容器（而不是原地 restart 继续用旧 env）。"""
    fake = FakeDocker()
    fake.containers[manager.container_name] = _stale_env_container(manager)
    monkeypatch.setattr("sandbox_platform.proxy.run", fake)
    monkeypatch.setattr(
        manager,
        "probe",
        lambda: ProxyProbe(tcp=True, http=True, detail="ok"),
    )
    monkeypatch.setattr(manager, "host_image_exists", lambda: True)

    assert manager.restart(timeout=5) is True
    assert len(fake.creations()) == 1, "env 漂移时重启必须重建容器"
    created = " ".join(fake.creations()[0])
    assert "MANIFEST_CACHE_SECONDARY_TIME=180d" in created


def test_restart_reuses_container_when_env_matches(
    manager: RegistryProxyManager, monkeypatch
) -> None:
    """env 一致 → 原地 ``docker restart``（不重建容器）。"""
    fake = FakeDocker()
    fake.containers[manager.container_name] = {
        "running": True,
        "mounts": [
            (str(manager.config.proxy_cache_dir), PROXY_CACHE_MOUNT),
            (str(manager.config.proxy_ca_dir), PROXY_CA_MOUNT),
        ],
        "env": [
            "ENABLE_MANIFEST_CACHE=true",
            "MANIFEST_CACHE_PRIMARY_TIME=180d",
            "MANIFEST_CACHE_SECONDARY_TIME=180d",
            "MANIFEST_CACHE_DEFAULT_TIME=180d",
            "CACHE_INACTIVE=180d",
            f"REGISTRIES={' '.join(manager.config.proxy_registries)}",
        ],
    }
    monkeypatch.setattr("sandbox_platform.proxy.run", fake)
    monkeypatch.setattr(
        manager,
        "probe",
        lambda: ProxyProbe(tcp=True, http=True, detail="ok"),
    )
    monkeypatch.setattr(manager, "host_image_exists", lambda: True)

    assert manager.restart(timeout=5) is True
    assert fake.creations() == [], "env 一致时不该重建容器"
    assert any(cmd[:2] == ["docker", "restart"] for cmd in fake.commands), (
        "env 一致时走原地重启"
    )


def test_registries_order_does_not_count_as_env_drift(
    manager: RegistryProxyManager, monkeypatch
) -> None:
    """REGISTRIES 同集合不同书写顺序 → 不算 env 漂移（不重建容器）。

    ``REGISTRIES`` 是空格分隔的列表值：书写顺序不同是同一份配置，白白重建
    一个健康的容器（重建是破坏性操作：容器 id 与进程都换掉）。
    """
    fake = FakeDocker()
    fake.containers[manager.container_name] = {
        "running": True,
        "mounts": [
            (str(manager.config.proxy_cache_dir), PROXY_CACHE_MOUNT),
            (str(manager.config.proxy_ca_dir), PROXY_CA_MOUNT),
        ],
        "env": [
            "ENABLE_MANIFEST_CACHE=true",
            "MANIFEST_CACHE_PRIMARY_TIME=180d",
            "MANIFEST_CACHE_SECONDARY_TIME=180d",
            "MANIFEST_CACHE_DEFAULT_TIME=180d",
            "CACHE_INACTIVE=180d",
            f"REGISTRIES={' '.join(reversed(manager.config.proxy_registries))}",
        ],
    }
    monkeypatch.setattr("sandbox_platform.proxy.run", fake)
    monkeypatch.setattr(
        manager,
        "probe",
        lambda: ProxyProbe(tcp=True, http=True, detail="ok"),
    )
    monkeypatch.setattr(manager, "host_image_exists", lambda: True)

    assert manager.restart(timeout=5) is True
    assert fake.creations() == [], "同集合不同顺序不算 env 漂移"
    assert any(cmd[:2] == ["docker", "restart"] for cmd in fake.commands), (
        "env 实质一致时走原地重启"
    )


def test_env_probe_failure_is_treated_as_consistent(
    manager: RegistryProxyManager, monkeypatch, caplog
) -> None:
    """env 探测失败（命令超时抛异常）→ 视为一致：不删容器、不重建，但**打 warning**。

    取舍（docstring 承诺）：重建是破坏性操作，不能因一次探测失败就删容器；
    但 fail-open 必须**可观测**——静默的「视为一致」会让 env 漂移被吞掉。
    """
    def failing(argv, **kwargs):
        raise CommandError(tuple(str(item) for item in argv), 124, "", "命令超时")

    monkeypatch.setattr("sandbox_platform.proxy.run", failing)

    with caplog.at_level(logging.WARNING):
        assert manager._container_env_matches() is True

    assert "env 探测失败" in caplog.text
    assert manager.container_name in caplog.text


def test_env_probe_empty_output_is_treated_as_consistent_with_warning(
    manager: RegistryProxyManager, monkeypatch, caplog
) -> None:
    """env 探测输出为空 → 视为一致 + warning（同样不许静默）。"""
    def empty(argv, *, env=None, check=False, timeout=None, cwd=None, stdin_text=None):
        args = [str(item) for item in argv]
        while args[:1] == ["sudo"]:
            args = args[2:]
        return CommandResult(tuple(args), 0, "", "")

    monkeypatch.setattr("sandbox_platform.proxy.run", empty)

    with caplog.at_level(logging.WARNING):
        assert manager._container_env_matches() is True

    assert "env 探测输出为空" in caplog.text


def test_ensure_running_raises_when_container_removal_fails(
    manager: RegistryProxyManager, monkeypatch
) -> None:
    """env 漂移要重建、旧容器却删不掉 → **报错**（不静默吞掉漂移）。"""
    fake = RemoveFailsDocker()
    fake.containers[manager.container_name] = _stale_env_container(manager)
    monkeypatch.setattr("sandbox_platform.proxy.run", fake)
    monkeypatch.setattr(
        manager,
        "probe",
        lambda: ProxyProbe(tcp=True, http=True, detail="ok"),
    )
    monkeypatch.setattr(manager, "host_image_exists", lambda: True)

    with pytest.raises(ProxyError):
        manager.ensure_running(timeout=5)
    assert manager.last_error
    assert fake.creations() == [], "旧容器没删掉就不该建新的"


def test_restart_reports_failure_when_container_removal_fails(
    manager: RegistryProxyManager, monkeypatch
) -> None:
    """重启路径上删除失败 → 返回 False + 记原因（不让异常穿透到接口层）。"""
    fake = RemoveFailsDocker()
    fake.containers[manager.container_name] = _stale_env_container(manager)
    monkeypatch.setattr("sandbox_platform.proxy.run", fake)
    monkeypatch.setattr(
        manager,
        "probe",
        lambda: ProxyProbe(tcp=True, http=True, detail="ok"),
    )
    monkeypatch.setattr(manager, "host_image_exists", lambda: True)

    assert manager.restart(timeout=5) is False
    assert manager.last_error
    assert fake.creations() == [], "旧容器没删掉就不该建新的"


def test_probe_requires_tcp_and_http() -> None:
    """健康判定要求端口可连且能取到 CA。"""
    assert ProxyProbe(tcp=True, http=True, detail="").healthy is True
    assert ProxyProbe(tcp=True, http=False, detail="").healthy is False
    assert ProxyProbe(tcp=False, http=True, detail="").healthy is False


# ---------------------------------------------------------------- CA 合并与权限
def test_install_ca_bundle_merges_system_and_proxy_ca(
    manager: RegistryProxyManager, tmp_path: Path, monkeypatch
) -> None:
    """合并 CA 束同时包含系统根证书与代理根证书。"""
    monkeypatch.setattr("sandbox_platform.proxy.run", FakeDocker())
    manager.config.proxy_ca_dir.mkdir(parents=True, exist_ok=True)
    (manager.config.proxy_ca_dir / CA_CERT_FILENAME).write_text(PROXY_CA, encoding="utf-8")

    user = _sandbox_user(tmp_path / "home")
    target = manager.install_ca_bundle(user)
    content = target.read_text(encoding="utf-8")
    assert "系统根证书" in content
    assert "代理根证书" in content
    assert target == ca_bundle_path(user.home)


def test_install_ca_bundle_sets_owner_and_mode(
    manager: RegistryProxyManager, tmp_path: Path, monkeypatch
) -> None:
    """合并 CA 束属主是沙箱用户、权限 0644。"""
    fake = FakeDocker()
    monkeypatch.setattr("sandbox_platform.proxy.run", fake)
    manager.config.proxy_ca_dir.mkdir(parents=True, exist_ok=True)
    (manager.config.proxy_ca_dir / CA_CERT_FILENAME).write_text(PROXY_CA, encoding="utf-8")

    user = _sandbox_user(tmp_path / "home")
    target = manager.install_ca_bundle(user)
    install_commands = [cmd for cmd in fake.commands if "install" in cmd and "-o" in cmd]
    assert install_commands, "没有执行 install 命令"
    command = install_commands[-1]
    assert "-o" in command and "sandbox-demo" in command
    assert "-g" in command
    assert command[command.index("-m") + 1] == "0644"
    assert str(target) in command
    assert oct(target.stat().st_mode & 0o777) == "0o644"


def test_read_ca_certificate_reports_missing_file(manager: RegistryProxyManager) -> None:
    """代理 CA 不存在时给出明确异常（不做静默降级）。"""
    from sandbox_platform import ProxyError

    manager.config.proxy_ca_dir.mkdir(parents=True, exist_ok=True)
    with pytest.raises(ProxyError):
        manager.read_ca_certificate()


# ---------------------------------------------------------------- 创建流程
def test_create_fails_when_proxy_unavailable(service, monkeypatch) -> None:
    """代理不可达时创建直接失败，错误信息明确说明不降级直连。"""
    from sandbox_platform import CreateRequest

    monkeypatch.setattr(service.proxy, "ensure_running", lambda *a, **k: False)
    monkeypatch.setattr(
        service.proxy,
        "probe",
        lambda: ProxyProbe(tcp=False, http=False, detail="连接被拒绝"),
    )
    with pytest.raises(LifecycleError) as excinfo:
        service.create(CreateRequest(name="demo", image="busybox"))
    message = str(excinfo.value)
    assert "镜像代理未就绪" in message
    assert "不做降级直连" in message
    assert "连接被拒绝" in message
