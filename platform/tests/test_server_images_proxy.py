"""宿主镜像枚举与镜像代理状态接口的测试。

宿主命令执行层在这里被整体桩掉：测试不触碰宿主（不列真实镜像、不起真实
容器、不读真实数据根），只验证两件事——核心包的新能力是否正确（字段、排序、
过滤、重启、CA 指纹比对），以及服务层把这些结果转成 HTTP 响应是否正确。
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sandbox_platform import (
    HostImage,
    ImageManager,
    PlatformConfig,
    ProxyProbe,
    RegistryProxyManager,
    SandboxMetadata,
    SandboxService,
)
from sandbox_platform.command import CommandResult
from sandbox_platform.metadata import MetadataStore
from sandbox_platform.proxy import CA_CERT_FILENAME
from sandbox_platform.server import create_app
from sandbox_platform.userspace import ca_bundle_path

# 测试专用代理端口（与生产实例 3128 隔离）
TEST_PROXY_PORT = 33128

SYSTEM_CA = "-----BEGIN CERTIFICATE-----\n系统根证书\n-----END CERTIFICATE-----\n"
PROXY_CA = "-----BEGIN CERTIFICATE-----\n代理根证书\n-----END CERTIFICATE-----\n"
PROXY_CA_V2 = "-----BEGIN CERTIFICATE-----\n新的代理根证书\n-----END CERTIFICATE-----\n"


# ---------------------------------------------------------------- 假宿主
class FakeHost:
    """假的宿主命令执行器：模拟镜像枚举、代理容器与磁盘统计。

    只实现本任务用到的那几条命令；其余命令一律返回成功（不做事），
    避免测试因为无关命令失败。
    """

    def __init__(self) -> None:
        self.commands: list[list[str]] = []
        # 镜像列表（``image ls`` 的每一行）
        self.images: list[dict[str, str]] = []
        # 镜像详情：镜像 ID → (体积字节, 创建时间)
        self.image_details: dict[str, tuple[int, str]] = {}
        self.container_exists = False
        self.container_running = False
        self.restart_ok = True
        self.run_container_ok = True
        self.pull_ok = True
        self.cache_size = 0
        self.probe_result = ProxyProbe(tcp=True, http=True, detail="CA 证书可取")
        # 系统用户（``getent passwd`` 的返回）：用户名 → (uid, gid, 家目录)
        self.users: dict[str, tuple[int, int, str]] = {}
        # 重启时触发的回调（用来模拟代理重新生成了 CA）
        self.on_restart: Any = None

    def __call__(self, argv, *, env=None, check=False, timeout=None, cwd=None, stdin_text=None):
        args = [str(item) for item in argv]
        # 去掉特权前缀（sudo -n），只关心真实命令
        while args[:1] == ["sudo"]:
            args = args[2:]
        self.commands.append(args)
        if args[:3] == ["docker", "image", "ls"]:
            return self._image_ls(args)
        if args[:3] == ["docker", "image", "inspect"]:
            return self._image_inspect(args)
        if args[:2] == ["docker", "inspect"]:
            return self._container_inspect(args)
        if args[:2] == ["docker", "restart"]:
            return self._restart(args)
        if args[:2] == ["docker", "run"]:
            return self._run_container(args)
        if args[:2] == ["docker", "pull"]:
            return self._pull(args)
        if args[:1] == ["du"]:
            return self._du(args)
        if args[:1] == ["install"]:
            return self._install(args)
        if args[:1] == ["chmod"]:
            return CommandResult(tuple(args), 0, "", "")
        if args[:1] == ["cat"]:
            return self._cat(args)
        if args[:2] == ["getent", "passwd"]:
            return self._getent(args)
        if args[:2] == ["id", "-u"]:
            name = args[2]
            if name in self.users:
                return CommandResult(tuple(args), 0, str(self.users[name][0]), "")
            return CommandResult(tuple(args), 1, "", "no such user")
        return CommandResult(tuple(args), 0, "", "")

    # ------------------------------------------------------------ 各条命令
    def _image_ls(self, args: list[str]) -> CommandResult:
        payload = "\n".join(json.dumps(row, ensure_ascii=False) for row in self.images)
        return CommandResult(tuple(args), 0, payload, "")

    def _image_inspect(self, args: list[str]) -> CommandResult:
        image_ids = args[args.index("--format") + 2 :] if "--format" in args else []
        lines: list[str] = []
        missing = False
        for image_id in image_ids:
            detail = self.image_details.get(image_id)
            if detail is None:
                missing = True
                continue
            lines.append(f"{image_id}\t{detail[0]}\t{detail[1]}")
        if missing:
            return CommandResult(tuple(args), 1, "", "no such image")
        return CommandResult(tuple(args), 0, "\n".join(lines), "")

    def _container_inspect(self, args: list[str]) -> CommandResult:
        if not self.container_exists:
            return CommandResult(tuple(args), 1, "", "no such object")
        template = args[args.index("--format") + 1] if "--format" in args else ""
        if "State.Running" in template:
            value = "true" if self.container_running else "false"
            return CommandResult(tuple(args), 0, value, "")
        if "Mounts" in template:
            return CommandResult(tuple(args), 0, "[]", "")
        return CommandResult(tuple(args), 0, "", "")

    def _restart(self, args: list[str]) -> CommandResult:
        if not self.container_exists:
            return CommandResult(tuple(args), 1, "", "no such container")
        if not self.restart_ok:
            return CommandResult(tuple(args), 1, "", "cannot stop container")
        self.container_running = True
        if self.on_restart is not None:
            self.on_restart()
        return CommandResult(tuple(args), 0, args[-1], "")

    def _run_container(self, args: list[str]) -> CommandResult:
        if not self.run_container_ok:
            return CommandResult(tuple(args), 1, "", "port is already allocated")
        self.container_exists = True
        self.container_running = True
        return CommandResult(tuple(args), 0, "container-id", "")

    def _pull(self, args: list[str]) -> CommandResult:
        if not self.pull_ok:
            return CommandResult(tuple(args), 1, "", "pull access denied")
        return CommandResult(tuple(args), 0, "pulled", "")

    def _du(self, args: list[str]) -> CommandResult:
        target = Path(args[-1])
        if not target.exists():
            return CommandResult(tuple(args), 1, "", "No such file or directory")
        return CommandResult(tuple(args), 0, f"{self.cache_size}\t{target}", "")

    def _install(self, args: list[str]) -> CommandResult:
        paths: list[str] = []
        is_dir = "-d" in args
        index = 1
        while index < len(args):
            item = args[index]
            if item in ("-o", "-g", "-m"):
                index += 2
                continue
            if item.startswith("-"):
                index += 1
                continue
            paths.append(item)
            index += 1
        if is_dir:
            for path in paths:
                Path(path).mkdir(parents=True, exist_ok=True)
            return CommandResult(tuple(args), 0, "", "")
        if len(paths) < 2:
            return CommandResult(tuple(args), 1, "", "install: missing target file operand")
        source, target = paths[-2], paths[-1]
        Path(target).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        return CommandResult(tuple(args), 0, "", "")

    def _cat(self, args: list[str]) -> CommandResult:
        try:
            content = Path(args[-1]).read_text(encoding="utf-8")
        except OSError as exc:
            return CommandResult(tuple(args), 1, "", str(exc))
        return CommandResult(tuple(args), 0, content, "")

    def _getent(self, args: list[str]) -> CommandResult:
        name = args[2]
        user = self.users.get(name)
        if user is None:
            return CommandResult(tuple(args), 2, "", "not found")
        uid, gid, home = user
        return CommandResult(tuple(args), 0, f"{name}:x:{uid}:{gid}::{home}:/bin/bash\n", "")


# ---------------------------------------------------------------- 夹具
@pytest.fixture
def proxy_config(tmp_path: Path) -> PlatformConfig:
    """带独立数据根、系统 CA 束与测试代理端口的配置（不碰真实数据根）。"""
    home = tmp_path / "home"
    home.mkdir()
    system_ca = tmp_path / "system-ca.crt"
    system_ca.write_text(SYSTEM_CA, encoding="utf-8")
    return PlatformConfig.from_env(
        {
            "SANDBOX_PLATFORM_HOME": str(home),
            "SANDBOX_PLATFORM_SYSTEM_CA_BUNDLE": str(system_ca),
            "SANDBOX_PLATFORM_PROXY_PORT": str(TEST_PROXY_PORT),
        }
    )


@pytest.fixture
def fake_host() -> FakeHost:
    """假的宿主命令执行器。"""
    return FakeHost()


@pytest.fixture
def stub_host(monkeypatch: pytest.MonkeyPatch, fake_host: FakeHost) -> FakeHost:
    """把宿主命令执行层整体桩掉（核心包与用户管理的命令都在内）。"""
    monkeypatch.setattr("sandbox_platform.images.run", fake_host)
    monkeypatch.setattr("sandbox_platform.proxy.run", fake_host)
    monkeypatch.setattr("sandbox_platform.userspace.run", fake_host)
    # 健康轮询不落真实睡眠
    monkeypatch.setattr("sandbox_platform.proxy.time.sleep", lambda *_: None)
    return fake_host


@pytest.fixture
def proxy_manager(proxy_config: PlatformConfig) -> RegistryProxyManager:
    """代理管理器实例。"""
    return RegistryProxyManager(proxy_config)


def write_proxy_ca(config: PlatformConfig, content: str = PROXY_CA) -> Path:
    """在数据根里写一份代理 CA 证书。"""
    config.proxy_ca_dir.mkdir(parents=True, exist_ok=True)
    path = config.proxy_ca_dir / CA_CERT_FILENAME
    path.write_text(content, encoding="utf-8")
    return path


def make_metadata(name: str = "demo") -> SandboxMetadata:
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
    )


def prepare_sandbox(config: PlatformConfig, fake_host: FakeHost, name: str = "demo") -> Path:
    """登记一个沙箱（用户信息由 ``getent`` 桩件提供）。"""
    home = config.home / f"home-{name}"
    home.mkdir(parents=True, exist_ok=True)
    fake_host.users[f"sandbox-{name}"] = (1001, 1001, str(home))
    MetadataStore(config).save(make_metadata(name))
    return home


# ---------------------------------------------------------------- 镜像枚举
def test_list_host_images_returns_fields_sorted_by_reference(
    proxy_config: PlatformConfig, stub_host: FakeHost
) -> None:
    """镜像枚举：字段齐全（引用 / ID / 体积 / 创建时间），按镜像引用排序。"""
    stub_host.images = [
        {"Repository": "busybox", "Tag": "1.37", "ID": "sha256:bbb"},
        {"Repository": "alpine", "Tag": "3.20", "ID": "sha256:aaa"},
    ]
    stub_host.image_details = {
        "sha256:aaa": (1024, "2026-10-28T00:00:00Z"),
        "sha256:bbb": (2048, "2026-10-29T00:00:00Z"),
    }

    images = ImageManager(proxy_config).list_host_images()

    assert [item.reference for item in images] == ["alpine:3.20", "busybox:1.37"]
    first = images[0]
    assert isinstance(first, HostImage)
    assert first.image_id == "sha256:aaa"
    assert first.size_bytes == 1024
    assert first.created_at == "2026-10-28T00:00:00Z"


def test_list_host_images_skips_dangling_images(
    proxy_config: PlatformConfig, stub_host: FakeHost
) -> None:
    """悬空镜像（``<none>:<none>``）不进可选列表。"""
    stub_host.images = [
        {"Repository": "<none>", "Tag": "<none>", "ID": "sha256:dead"},
        {"Repository": "alpine", "Tag": "3.20", "ID": "sha256:aaa"},
        {"Repository": "<none>", "Tag": "latest", "ID": "sha256:dead"},
    ]
    stub_host.image_details = {"sha256:aaa": (1024, "2026-10-28T00:00:00Z")}

    images = ImageManager(proxy_config).list_host_images()

    assert [item.reference for item in images] == ["alpine:3.20"]


def test_list_host_images_reports_command_failure(
    proxy_config: PlatformConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """宿主命令失败时明确报错（不静默返回空列表）。"""
    from sandbox_platform import ImageError

    def failing(argv, **kwargs):
        return CommandResult(tuple(str(item) for item in argv), 1, "", "daemon unreachable")

    monkeypatch.setattr("sandbox_platform.images.run", failing)
    with pytest.raises(ImageError):
        ImageManager(proxy_config).list_host_images()


# ---------------------------------------------------------------- 代理状态
def test_proxy_status_reports_container_health_cache_and_certificate(
    proxy_config: PlatformConfig,
    stub_host: FakeHost,
    proxy_manager: RegistryProxyManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """代理状态：容器运行状态、健康明细、缓存占用、证书就绪、访问地址。"""
    write_proxy_ca(proxy_config)
    proxy_config.proxy_cache_dir.mkdir(parents=True, exist_ok=True)
    stub_host.container_exists = True
    stub_host.container_running = True
    stub_host.cache_size = 4096
    monkeypatch.setattr(proxy_manager, "probe", lambda: stub_host.probe_result)

    status = proxy_manager.status()

    assert status.container.exists is True
    assert status.container.running is True
    assert status.healthy is True
    assert status.tcp_ok is True
    assert status.ca_fetchable is True
    assert status.detail == "CA 证书可取"
    assert status.cache_size_bytes == 4096
    assert status.certificate_ready is True
    assert status.proxy_url == f"http://127.0.0.1:{TEST_PROXY_PORT}"


def test_proxy_status_reports_unhealthy_and_missing_certificate(
    proxy_config: PlatformConfig,
    stub_host: FakeHost,
    proxy_manager: RegistryProxyManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """代理没起来不是异常：如实回报不健康、证书未就绪、缓存占用为 0。"""
    stub_host.container_exists = False
    stub_host.container_running = False
    stub_host.probe_result = ProxyProbe(tcp=False, http=False, detail="连接被拒绝")
    monkeypatch.setattr(proxy_manager, "probe", lambda: stub_host.probe_result)

    status = proxy_manager.status()

    assert status.container.exists is False
    assert status.container.running is False
    assert status.healthy is False
    assert status.tcp_ok is False
    assert status.ca_fetchable is False
    assert status.certificate_ready is False
    assert status.cache_size_bytes == 0


def test_cache_size_bytes_is_zero_when_cache_dir_missing(
    proxy_config: PlatformConfig, stub_host: FakeHost, proxy_manager: RegistryProxyManager
) -> None:
    """缓存目录不存在时占用为 0（不报错）。"""
    assert proxy_manager.cache_size_bytes() == 0


# ---------------------------------------------------------------- 代理重启
def test_restart_existing_container_waits_until_healthy(
    proxy_config: PlatformConfig,
    stub_host: FakeHost,
    proxy_manager: RegistryProxyManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """重启：容器存在则重启，轮询到健康后才返回成功。"""
    stub_host.container_exists = True
    stub_host.container_running = False
    monkeypatch.setattr(proxy_manager, "probe", lambda: stub_host.probe_result)

    assert proxy_manager.restart(timeout=5) is True

    assert any(command[:2] == ["docker", "restart"] for command in stub_host.commands)
    assert stub_host.container_running is True
    assert proxy_manager.last_error == ""


def test_restart_starts_container_when_missing(
    proxy_config: PlatformConfig,
    stub_host: FakeHost,
    proxy_manager: RegistryProxyManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """重启：容器不存在则先拉起再探活。"""
    stub_host.container_exists = False
    monkeypatch.setattr(proxy_manager, "probe", lambda: stub_host.probe_result)

    assert proxy_manager.restart(timeout=5) is True

    assert any(command[:2] == ["docker", "run"] for command in stub_host.commands)
    assert stub_host.container_exists is True


def test_restart_failure_reports_reason_without_fallback(
    proxy_config: PlatformConfig,
    stub_host: FakeHost,
    proxy_manager: RegistryProxyManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """重启失败：返回 False 并给出原因，不降级直连（不另起一条通路）。"""
    stub_host.container_exists = True
    stub_host.restart_ok = False
    monkeypatch.setattr(proxy_manager, "probe", lambda: stub_host.probe_result)

    assert proxy_manager.restart(timeout=5) is False

    assert proxy_manager.last_error
    assert not any(command[:2] == ["docker", "pull"] for command in stub_host.commands)


# ---------------------------------------------------------------- CA 指纹比对
def test_restart_proxy_reinstalls_ca_bundle_when_ca_digest_changes(
    proxy_config: PlatformConfig, stub_host: FakeHost, monkeypatch: pytest.MonkeyPatch
) -> None:
    """CA 指纹变化：自动为已有沙箱用户重装合并 CA 束，并把事实回传调用方。"""
    home = prepare_sandbox(proxy_config, stub_host)
    ca_path = write_proxy_ca(proxy_config, PROXY_CA)

    service = SandboxService(proxy_config)
    stub_host.container_exists = True
    monkeypatch.setattr(service.proxy, "probe", lambda: stub_host.probe_result)

    # 重启时代理重新生成了 CA
    def _rotate_ca() -> None:
        ca_path.write_text(PROXY_CA_V2, encoding="utf-8")

    stub_host.on_restart = _rotate_ca

    result = service.restart_proxy(timeout=5)

    assert result.success is True
    assert result.ca_changed is True
    assert result.reinstalled_users == ("sandbox-demo",)
    bundle = ca_bundle_path(home)
    assert bundle.is_file()
    assert "新的代理根证书" in bundle.read_text(encoding="utf-8")


def test_restart_proxy_does_not_reinstall_ca_when_ca_digest_unchanged(
    proxy_config: PlatformConfig, stub_host: FakeHost, monkeypatch: pytest.MonkeyPatch
) -> None:
    """CA 指纹没变：不重装合并 CA 束。"""
    home = prepare_sandbox(proxy_config, stub_host)
    write_proxy_ca(proxy_config, PROXY_CA)

    service = SandboxService(proxy_config)
    stub_host.container_exists = True
    monkeypatch.setattr(service.proxy, "probe", lambda: stub_host.probe_result)

    result = service.restart_proxy(timeout=5)

    assert result.success is True
    assert result.ca_changed is False
    assert result.reinstalled_users == ()
    assert not ca_bundle_path(home).exists()


# ---------------------------------------------------------------- HTTP 接口
@pytest.fixture
def api_client(
    platform_home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    stub_host: FakeHost,
) -> TestClient:
    """接口测试客户端：平台数据根指向临时目录，宿主命令层已桩掉。"""
    monkeypatch.setenv("SANDBOX_PLATFORM_PROXY_PORT", str(TEST_PROXY_PORT))
    system_ca = tmp_path / "system-ca.crt"
    system_ca.write_text(SYSTEM_CA, encoding="utf-8")
    monkeypatch.setenv("SANDBOX_PLATFORM_SYSTEM_CA_BUNDLE", str(system_ca))
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))

    app = create_app()
    service = SandboxService(app.state.platform_config)
    app.state.sandbox_service = service
    # 健康探测不落真实网络
    monkeypatch.setattr(service.proxy, "probe", lambda: stub_host.probe_result)
    return TestClient(app)


def test_images_endpoint_returns_host_images(
    api_client: TestClient, stub_host: FakeHost
) -> None:
    """``GET /api/images``：返回宿主本地镜像，字段为引用 / ID / 体积 / 创建时间。"""
    stub_host.images = [{"Repository": "alpine", "Tag": "3.20", "ID": "sha256:aaa"}]
    stub_host.image_details = {"sha256:aaa": (1024, "2026-10-28T00:00:00Z")}

    response = api_client.get("/api/images")

    assert response.status_code == 200
    body = response.json()
    assert body == [
        {
            "reference": "alpine:3.20",
            "image_id": "sha256:aaa",
            "size_bytes": 1024,
            "created_at": "2026-10-28T00:00:00Z",
        }
    ]


def test_proxy_status_endpoint_returns_status_fields(
    api_client: TestClient, stub_host: FakeHost, platform_home: Path
) -> None:
    """``GET /api/proxy/status``：容器状态、健康状态、缓存占用、证书就绪、地址。"""
    stub_host.container_exists = True
    stub_host.container_running = True
    stub_host.cache_size = 2048
    proxy_root = platform_home / "registry-proxy"
    (proxy_root / "cache").mkdir(parents=True, exist_ok=True)
    (proxy_root / "ca").mkdir(parents=True, exist_ok=True)
    (proxy_root / "ca" / CA_CERT_FILENAME).write_text(PROXY_CA, encoding="utf-8")

    response = api_client.get("/api/proxy/status")

    assert response.status_code == 200
    body = response.json()
    assert body["container"] == {"exists": True, "running": True}
    assert body["healthy"] is True
    assert body["tcp_ok"] is True
    assert body["ca_fetchable"] is True
    assert body["cache_size_bytes"] == 2048
    assert body["certificate_ready"] is True
    assert body["proxy_url"] == f"http://127.0.0.1:{TEST_PROXY_PORT}"


def test_proxy_restart_endpoint_reports_ca_change(
    api_client: TestClient, stub_host: FakeHost, platform_home: Path
) -> None:
    """``POST /api/proxy/restart``：返回状态字段 + ``ca_changed``。"""
    stub_host.container_exists = True
    ca_dir = platform_home / "registry-proxy" / "ca"
    ca_dir.mkdir(parents=True, exist_ok=True)
    (ca_dir / CA_CERT_FILENAME).write_text(PROXY_CA, encoding="utf-8")

    def _rotate_ca() -> None:
        (ca_dir / CA_CERT_FILENAME).write_text(PROXY_CA_V2, encoding="utf-8")

    stub_host.on_restart = _rotate_ca

    response = api_client.post("/api/proxy/restart")

    assert response.status_code == 200
    body = response.json()
    assert body["restarted"] is True
    assert body["ca_changed"] is True
    assert "CA" in body["message"]
    assert body["container"]["running"] is True
    assert body["proxy_url"] == f"http://127.0.0.1:{TEST_PROXY_PORT}"


def test_proxy_restart_endpoint_reports_failure_without_leaking_details(
    api_client: TestClient, stub_host: FakeHost
) -> None:
    """重启失败：如实回报未成功，不回显宿主命令原文。"""
    stub_host.container_exists = True
    stub_host.restart_ok = False

    response = api_client.post("/api/proxy/restart")

    assert response.status_code == 200
    body = response.json()
    assert body["restarted"] is False
    assert "cannot stop container" not in response.text
    assert "/var/lib/sandbox-platform" not in response.text


def test_no_cache_cleanup_endpoint_is_exposed(api_client: TestClient) -> None:
    """不提供清理代理缓存的接口：只增不减现状维持。"""
    for path in ("/api/proxy/cache", "/api/proxy/cache/clear", "/api/proxy/purge"):
        assert api_client.delete(path).status_code == 404
        assert api_client.post(path).status_code == 404


def test_no_remote_image_pull_endpoint_is_exposed(api_client: TestClient) -> None:
    """不提供网页拉取镜像的接口：创建沙箱只从宿主本地镜像下拉选择。"""
    for path in ("/api/images/pull", "/api/images/push"):
        assert api_client.post(path, json={}).status_code == 404
