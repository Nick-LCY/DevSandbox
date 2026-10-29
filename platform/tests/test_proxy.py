"""统一镜像代理的单元测试（不触碰宿主特权资源）。"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest

from sandbox_platform import (
    LifecycleError,
    PlatformConfig,
    ProxyProbe,
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
        if "State.Running" in template:
            return CommandResult(tuple(args), 0, "true" if container["running"] else "false", "")
        return CommandResult(tuple(args), 0, "", "")

    def _run(self, args: list[str]) -> CommandResult:
        name = args[args.index("--name") + 1]
        mounts = []
        for item in args:
            if item.startswith("/") and ":" in item:
                source, destination = item.split(":", 1)
                if destination.startswith("/"):
                    mounts.append((source, destination))
        self.containers[name] = {"running": True, "mounts": mounts}
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
