"""宿主镜像枚举与镜像代理状态接口的测试。

宿主命令执行层在这里被整体桩掉：测试不触碰宿主（不列真实镜像、不起真实
容器、不读真实数据根），只验证两件事——核心包的新能力是否正确（字段、排序、
过滤、重启、CA 指纹比对），以及服务层把这些结果转成 HTTP 响应是否正确。
"""

from __future__ import annotations

import json
import shutil
import time
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
from sandbox_platform.proxy import (
    CA_CERT_FILENAME,
    PROXY_CA_MOUNT,
    PROXY_CACHE_MOUNT,
    CACHE_SIZE_TIMEOUT,
    RESTART_COMMAND_TIMEOUT,
)
from sandbox_console import create_app
from sandbox_platform.userspace import ca_bundle_path

# 测试专用代理端口（与生产实例 3128 隔离）
TEST_PROXY_PORT = 33128

SYSTEM_CA = "-----BEGIN CERTIFICATE-----\n系统根证书\n-----END CERTIFICATE-----\n"
PROXY_CA = "-----BEGIN CERTIFICATE-----\n代理根证书\n-----END CERTIFICATE-----\n"
PROXY_CA_V2 = "-----BEGIN CERTIFICATE-----\n新的代理根证书\n-----END CERTIFICATE-----\n"


class FakeTime:
    """假的时钟：健康轮询不落真实睡眠。

    只替换 ``sandbox_platform.proxy`` 里的模块引用（不是全局 ``time`` 模块），
    避免 monkeypatch 污染整个 pytest 进程。
    """

    def __init__(self, real: Any) -> None:
        self._real = real

    def monotonic(self) -> float:
        """真实单调时钟（轮询的截止时间计算需要真实推进）。"""
        return self._real.monotonic()

    def sleep(self, *_: Any) -> None:
        """不睡：轮询直接进入下一轮。"""
        return None


# ---------------------------------------------------------------- 假宿主
class FakeHost:
    """假的宿主命令执行器：模拟镜像枚举、代理容器与磁盘统计。

    只实现本任务用到的那几条命令；其余命令一律返回成功（不做事），
    避免测试因为无关命令失败。
    """

    def __init__(self) -> None:
        self.commands: list[list[str]] = []
        # 每条命令的超时（与 commands 一一对应）
        self.command_timeouts: list[int | None] = []
        # 镜像列表（``image ls`` 的每一行）
        self.images: list[dict[str, str]] = []
        # 镜像详情：镜像 ID → (体积字节, 创建时间)
        self.image_details: dict[str, tuple[int, str]] = {}
        # 批量 inspect 是否成功（失败时逐个重试）
        self.inspect_batch_ok = True
        self.container_exists = False
        self.container_running = False
        # 代理容器的绑定挂载（docker inspect --format {{json .Mounts}}）
        self.container_mounts: list[dict[str, str]] = []
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
        self.command_timeouts.append(timeout)
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
        if args[:2] == ["docker", "rm"]:
            return self._remove_container(args)
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
        if len(image_ids) > 1 and not self.inspect_batch_ok:
            # 批量调用失败：核心包应改为逐个重试
            return CommandResult(tuple(args), 1, "", "no such image")
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
            return CommandResult(tuple(args), 0, json.dumps(self.container_mounts), "")
        return CommandResult(tuple(args), 0, "", "")

    def _restart(self, args: list[str]) -> CommandResult:
        if not self.container_exists:
            return CommandResult(tuple(args), 1, "", "no such container")
        # 真实 docker restart 可能已经换掉了 CA，之后才报错
        if self.on_restart is not None:
            self.on_restart()
        if not self.restart_ok:
            return CommandResult(tuple(args), 1, "", "cannot stop container")
        self.container_running = True
        return CommandResult(tuple(args), 0, args[-1], "")

    def _run_container(self, args: list[str]) -> CommandResult:
        if not self.run_container_ok:
            return CommandResult(tuple(args), 1, "", "port is already allocated")
        self.container_exists = True
        self.container_running = True
        self.container_mounts = _mounts_from_run_args(args)
        return CommandResult(tuple(args), 0, "container-id", "")

    def _remove_container(self, args: list[str]) -> CommandResult:
        self.container_exists = False
        self.container_running = False
        self.container_mounts = []
        return CommandResult(tuple(args), 0, args[-1], "")

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


def _mounts_from_run_args(args: list[str]) -> list[dict[str, str]]:
    """从 ``docker run -v 源:目标`` 参数里解析出绑定挂载（与 docker 语义一致）。"""
    mounts: list[dict[str, str]] = []
    for index, item in enumerate(args):
        if item != "-v" or index + 1 >= len(args):
            continue
        source, _, destination = args[index + 1].partition(":")
        if destination:
            mounts.append({"Source": source, "Destination": destination})
    return mounts


def proxy_mounts(config: PlatformConfig) -> list[dict[str, str]]:
    """当前配置下代理容器应有的绑定挂载。"""
    return [
        {"Source": str(config.proxy_cache_dir), "Destination": PROXY_CACHE_MOUNT},
        {"Source": str(config.proxy_ca_dir), "Destination": PROXY_CA_MOUNT},
    ]


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
def stub_host(
    monkeypatch: pytest.MonkeyPatch, fake_host: FakeHost, proxy_config: PlatformConfig
) -> FakeHost:
    """把宿主命令执行层整体桩掉（核心包与用户管理的命令都在内）。"""
    monkeypatch.setattr("sandbox_platform.images.run", fake_host)
    monkeypatch.setattr("sandbox_platform.proxy.run", fake_host)
    monkeypatch.setattr("sandbox_platform.userspace.run", fake_host)
    # 健康轮询不落真实睡眠：只替换代理模块里的 time 引用，不动全局 time 模块
    monkeypatch.setattr("sandbox_platform.proxy.time", FakeTime(time))
    # 默认挂载与当前配置一致（重建路径只在挂载真的不一致时触发）
    fake_host.container_mounts = proxy_mounts(proxy_config)
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


def test_list_host_images_retries_one_by_one_when_batch_inspect_fails(
    proxy_config: PlatformConfig, stub_host: FakeHost
) -> None:
    """批量 inspect 失败：逐个重试，能拿到的详情照样给出来。"""
    stub_host.images = [
        {"Repository": "alpine", "Tag": "3.20", "ID": "sha256:aaa"},
        {"Repository": "busybox", "Tag": "1.37", "ID": "sha256:bbb"},
    ]
    stub_host.image_details = {"sha256:aaa": (1024, "2026-10-28T00:00:00Z")}
    stub_host.inspect_batch_ok = False

    images = ImageManager(proxy_config).list_host_images()

    assert [item.reference for item in images] == ["alpine:3.20", "busybox:1.37"]
    assert images[0].size_bytes == 1024
    assert images[1].size_bytes == 0
    inspect_calls = [
        command
        for command in stub_host.commands
        if command[:3] == ["docker", "image", "inspect"]
    ]
    # 批量一次 + 逐个两次
    assert len(inspect_calls) == 3
    assert len(inspect_calls[0]) > len(inspect_calls[1])


def test_list_host_images_skips_rows_without_image_id(
    proxy_config: PlatformConfig, stub_host: FakeHost
) -> None:
    """没有镜像 ID 的行不进列表（拿不到体积与创建时间）。"""
    stub_host.images = [
        {"Repository": "alpine", "Tag": "3.20", "ID": ""},
        {"Repository": "busybox", "Tag": "1.37", "ID": "sha256:bbb"},
    ]
    stub_host.image_details = {"sha256:bbb": (2048, "2026-10-29T00:00:00Z")}

    images = ImageManager(proxy_config).list_host_images()

    assert [item.reference for item in images] == ["busybox:1.37"]


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


def test_proxy_status_reports_container_exists_but_not_running(
    proxy_config: PlatformConfig,
    stub_host: FakeHost,
    proxy_manager: RegistryProxyManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """容器存在但未运行：状态如实回报「已存在但未运行」（与「容器不存在」区分）。"""
    stub_host.container_exists = True
    stub_host.container_running = False
    stub_host.probe_result = ProxyProbe(tcp=False, http=False, detail="连接被拒绝")
    monkeypatch.setattr(proxy_manager, "probe", lambda: stub_host.probe_result)

    status = proxy_manager.status()

    assert status.container.exists is True
    assert status.container.running is False
    assert status.healthy is False
    assert "未运行" in status.detail
    assert "连接被拒绝" in status.detail


def test_proxy_status_degrades_when_host_command_fails(
    proxy_config: PlatformConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """宿主命令失败：状态降级为不健康 + 明细，不抛异常（接口不会 500）。"""
    from sandbox_platform.command import CommandError

    def failing(argv, **kwargs):
        raise CommandError(tuple(str(item) for item in argv), 124, "", "命令超时")

    monkeypatch.setattr("sandbox_platform.proxy.run", failing)
    manager = RegistryProxyManager(proxy_config)

    status = manager.status()

    assert status.healthy is False
    assert status.tcp_ok is False
    assert "读取代理状态失败" in status.detail
    # 明细不回显宿主路径与特权命令行
    assert str(proxy_config.home) not in status.detail


def test_cache_size_command_is_protected_and_time_bounded(
    proxy_config: PlatformConfig, stub_host: FakeHost, proxy_manager: RegistryProxyManager
) -> None:
    """缓存占用统计：路径用 ``--`` 隔开，超时按 30 秒封顶（状态接口不等满默认超时）。"""
    proxy_config.proxy_cache_dir.mkdir(parents=True, exist_ok=True)
    stub_host.cache_size = 1024

    assert proxy_manager.cache_size_bytes() == 1024

    index = next(
        index for index, command in enumerate(stub_host.commands) if command[:1] == ["du"]
    )
    assert stub_host.commands[index][:3] == ["du", "-sb", "--"]
    assert stub_host.command_timeouts[index] == CACHE_SIZE_TIMEOUT


def test_http_probe_reports_truncated_response(
    proxy_config: PlatformConfig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """代理返回坏状态行：健康探测如实回报失败，不抛异常。"""
    import http.client

    manager = RegistryProxyManager(proxy_config)

    class _BoomOpener:
        def open(self, *args, **kwargs):
            raise http.client.BadStatusLine("")

    monkeypatch.setattr(manager, "_tcp_probe", lambda: (True, "可连接"))
    monkeypatch.setattr(
        "sandbox_platform.proxy.urllib.request.build_opener",
        lambda *args, **kwargs: _BoomOpener(),
    )

    probe = manager.probe()

    assert probe.healthy is False
    assert probe.http is False
    assert probe.detail


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


def test_restart_rebuilds_container_when_bind_mounts_mismatch(
    proxy_config: PlatformConfig,
    stub_host: FakeHost,
    proxy_manager: RegistryProxyManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """挂载与当前配置不一致：删除后按首次启动路径重建容器（不接着用旧挂载）。"""
    stub_host.container_exists = True
    stub_host.container_mounts = [
        {"Source": "/old/path", "Destination": PROXY_CACHE_MOUNT}
    ]
    monkeypatch.setattr(proxy_manager, "probe", lambda: stub_host.probe_result)

    assert proxy_manager.restart(timeout=5) is True

    assert any(command[:2] == ["docker", "rm"] for command in stub_host.commands)
    assert any(command[:2] == ["docker", "run"] for command in stub_host.commands)
    assert not any(command[:2] == ["docker", "restart"] for command in stub_host.commands)


def test_restart_command_timeout_follows_restart_timeout(
    proxy_config: PlatformConfig,
    stub_host: FakeHost,
    proxy_manager: RegistryProxyManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``docker restart`` 的超时跟 ``restart(timeout)`` 参数走（不再写死 120 秒）。"""
    stub_host.container_exists = True
    monkeypatch.setattr(proxy_manager, "probe", lambda: stub_host.probe_result)

    proxy_manager.restart(timeout=5)

    index = next(
        index
        for index, command in enumerate(stub_host.commands)
        if command[:2] == ["docker", "restart"]
    )
    assert stub_host.command_timeouts[index] == 5

    stub_host.commands.clear()
    stub_host.command_timeouts.clear()
    proxy_manager.restart(timeout=300)

    index = next(
        index
        for index, command in enumerate(stub_host.commands)
        if command[:2] == ["docker", "restart"]
    )
    assert stub_host.command_timeouts[index] == RESTART_COMMAND_TIMEOUT


def test_restart_reports_failure_when_host_command_raises(
    proxy_config: PlatformConfig,
    stub_host: FakeHost,
    proxy_manager: RegistryProxyManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """宿主命令超时（抛异常）：重启返回 False 并记原因，不让异常穿透到接口层。"""
    from sandbox_platform.command import CommandError

    def failing(argv, **kwargs):
        raise CommandError(tuple(str(item) for item in argv), 124, "", "命令超时")

    monkeypatch.setattr("sandbox_platform.proxy.run", failing)

    assert proxy_manager.restart(timeout=5) is False
    assert proxy_manager.last_error


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


def test_ca_digest_ignores_whitespace_differences(
    proxy_config: PlatformConfig, stub_host: FakeHost
) -> None:
    """CA 内容只有换行差异时指纹不变（不误报「CA 已变更」）。"""
    write_proxy_ca(proxy_config, PROXY_CA)
    manager = RegistryProxyManager(proxy_config)
    first = manager.ca_cert_digest()

    write_proxy_ca(proxy_config, PROXY_CA.replace("\n", "\r\n"))
    second = manager.ca_cert_digest()

    assert first != ""
    assert first == second


def test_restart_proxy_does_not_report_ca_change_when_ca_appeared(
    proxy_config: PlatformConfig, stub_host: FakeHost, monkeypatch: pytest.MonkeyPatch
) -> None:
    """重启前 CA 还没有（首次生成）：读不到不算「CA 已变更」。"""
    prepare_sandbox(proxy_config, stub_host)
    stub_host.container_exists = True

    def _create_ca() -> None:
        write_proxy_ca(proxy_config, PROXY_CA)

    stub_host.on_restart = _create_ca

    service = SandboxService(proxy_config)
    monkeypatch.setattr(service.proxy, "probe", lambda: stub_host.probe_result)

    result = service.restart_proxy(timeout=5)

    assert result.success is True
    assert result.ca_changed is False
    assert result.ca_reinstalled is False
    assert result.reinstalled_users == ()


def test_restart_proxy_reports_not_reinstalled_when_new_ca_unreadable(
    proxy_config: PlatformConfig, stub_host: FakeHost, monkeypatch: pytest.MonkeyPatch
) -> None:
    """CA 变了但新 CA 读不到：如实回报未重装，不把未修复报成已修复。"""
    from sandbox_platform import ProxyError

    prepare_sandbox(proxy_config, stub_host)
    ca_path = write_proxy_ca(proxy_config, PROXY_CA)
    stub_host.container_exists = True

    def _rotate_ca() -> None:
        ca_path.write_text(PROXY_CA_V2, encoding="utf-8")

    stub_host.on_restart = _rotate_ca

    service = SandboxService(proxy_config)
    monkeypatch.setattr(service.proxy, "probe", lambda: stub_host.probe_result)

    original_read = service.proxy.read_ca_certificate
    calls = {"count": 0}

    def _read_then_fail() -> str:
        calls["count"] += 1
        if calls["count"] >= 3:
            raise ProxyError("读不到代理 CA 证书")
        return original_read()

    monkeypatch.setattr(service.proxy, "read_ca_certificate", _read_then_fail)

    result = service.restart_proxy(timeout=5)

    assert result.success is True
    assert result.ca_changed is True
    assert result.ca_reinstalled is False
    assert result.reinstalled_users == ()
    assert "未能重装合并证书链" in result.message


def test_restart_proxy_reports_failed_users_and_keeps_going(
    proxy_config: PlatformConfig, stub_host: FakeHost, monkeypatch: pytest.MonkeyPatch
) -> None:
    """单个用户重装失败：记入 ``failed_users``，其余用户照常重装。"""
    prepare_sandbox(proxy_config, stub_host, name="demo")
    prepare_sandbox(proxy_config, stub_host, name="other")
    ca_path = write_proxy_ca(proxy_config, PROXY_CA)
    stub_host.container_exists = True

    def _rotate_ca() -> None:
        ca_path.write_text(PROXY_CA_V2, encoding="utf-8")

    stub_host.on_restart = _rotate_ca

    service = SandboxService(proxy_config)
    monkeypatch.setattr(service.proxy, "probe", lambda: stub_host.probe_result)

    original_install = service.proxy.install_ca_bundle

    def _install(user):
        if user.name == "sandbox-demo":
            raise RuntimeError("磁盘写不进去")
        return original_install(user)

    monkeypatch.setattr(service.proxy, "install_ca_bundle", _install)

    result = service.restart_proxy(timeout=5)

    assert result.ca_changed is True
    assert result.ca_reinstalled is False
    assert result.failed_users == ("sandbox-demo",)
    assert result.reinstalled_users == ("sandbox-other",)
    assert "1 个沙箱用户重装合并 CA 束失败" in result.message


def test_restart_proxy_reports_ca_state_when_restart_fails(
    proxy_config: PlatformConfig, stub_host: FakeHost, monkeypatch: pytest.MonkeyPatch
) -> None:
    """重启失败但 CA 已变更：失败分支也追加 CA 状态说明。"""
    prepare_sandbox(proxy_config, stub_host)
    ca_path = write_proxy_ca(proxy_config, PROXY_CA)
    stub_host.container_exists = True
    stub_host.restart_ok = False

    def _rotate_ca() -> None:
        ca_path.write_text(PROXY_CA_V2, encoding="utf-8")

    stub_host.on_restart = _rotate_ca

    service = SandboxService(proxy_config)
    monkeypatch.setattr(service.proxy, "probe", lambda: stub_host.probe_result)

    result = service.restart_proxy(timeout=5)

    assert result.success is False
    assert result.ca_changed is True
    assert "CA" in result.message
    assert "代理重启失败" in result.message


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
    # 代理容器的挂载与当前配置一致（避免走重建路径）
    stub_host.container_mounts = proxy_mounts(app.state.platform_config)
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


def test_proxy_status_endpoint_reports_unhealthy_without_error(
    api_client: TestClient, stub_host: FakeHost
) -> None:
    """代理没起来：状态接口仍回 200，如实回报不健康与明细（不是 4xx / 500）。"""
    stub_host.container_exists = False
    stub_host.probe_result = ProxyProbe(tcp=False, http=False, detail="连接被拒绝")

    response = api_client.get("/api/proxy/status")

    assert response.status_code == 200
    body = response.json()
    assert body["healthy"] is False
    assert body["tcp_ok"] is False
    assert body["ca_fetchable"] is False
    assert body["container"] == {"exists": False, "running": False}
    assert "代理容器不存在" in body["detail"]
    assert "连接被拒绝" in body["detail"]


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
    assert body["ca_reinstalled"] is True
    assert body["failed_users"] == []
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
