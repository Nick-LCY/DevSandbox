"""镜像可用性保障的单元测试：本地已有 → 宿主导出注入 → 交给代理拉取。

离线包机制已废弃（ADR 0008），平台不再维护任何离线镜像包。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sandbox_platform import ImageManager, PlatformConfig
from sandbox_platform.command import CommandResult


class FakeDaemon:
    """假的沙箱守护进程：记录镜像操作。"""

    def __init__(self, images: tuple[str, ...] = (), load_ok: bool = True) -> None:
        self.images = set(images)
        self.load_ok = load_ok
        self.loaded: list[Path] = []

    def image_exists(self, image: str) -> bool:
        return image in self.images

    def load_image(self, tar_path: str | Path, timeout: int = 600) -> CommandResult:
        self.loaded.append(Path(tar_path))
        if self.load_ok:
            self.images.add("loaded")
        return CommandResult(("docker", "load"), 0 if self.load_ok else 1, "", "")


@pytest.fixture
def manager(config: PlatformConfig) -> ImageManager:
    """镜像管理器实例。"""
    return ImageManager(config)


def test_image_already_in_daemon_is_reused(manager: ImageManager) -> None:
    """沙箱守护进程里已有该镜像时直接用。"""
    daemon = FakeDaemon(images=("busybox:1.37",))
    assert manager.ensure_image("busybox:1.37", daemon) == "present"
    assert daemon.loaded == []


def test_public_image_is_left_to_the_proxy(manager: ImageManager, monkeypatch) -> None:
    """仓库里存在的镜像不由平台代拉，交给沙箱守护进程经代理拉取。"""
    daemon = FakeDaemon()
    monkeypatch.setattr(manager, "host_image_exists", lambda image: True)
    assert manager.ensure_image("busybox:1.37", daemon) == "remote"
    assert daemon.loaded == []


def test_platform_local_image_is_injected_from_host(manager: PlatformConfig, monkeypatch) -> None:
    """平台自建镜像（只在宿主构建）由宿主导出后注入沙箱守护进程。"""
    daemon = FakeDaemon()
    monkeypatch.setattr(manager, "host_image_exists", lambda image: True)
    monkeypatch.setattr(manager, "inject_from_host", lambda image, d: "injected")
    source = manager.ensure_image("sandbox-platform/base:0.2.0", daemon)
    assert source == "injected"


def test_injection_failure_falls_back_to_remote(manager: ImageManager, monkeypatch) -> None:
    """宿主镜像注入失败时不阻断，退回「交给守护进程经代理拉取」。"""
    from sandbox_platform import ImageError

    daemon = FakeDaemon()
    monkeypatch.setattr(manager, "host_image_exists", lambda image: True)

    def _boom(image: str, d) -> str:
        raise ImageError("导出失败")

    monkeypatch.setattr(manager, "inject_from_host", _boom)
    assert manager.ensure_image("sandbox-platform/base:0.2.0", daemon) == "remote"


def test_is_platform_local_matches_prefixes(manager: ImageManager) -> None:
    """平台自建命名空间判定。"""
    assert manager.is_platform_local("sandbox-platform/base:0.2.0") is True
    assert manager.is_platform_local("busybox:1.37") is False


def test_local_image_prefixes_are_configurable(tmp_path: Path) -> None:
    """平台自建镜像前缀可由环境变量调整。"""
    config = PlatformConfig.from_env(
        {"SANDBOX_PLATFORM_LOCAL_IMAGE_PREFIXES": "my-registry/ other/"}
    )
    manager = ImageManager(config)
    assert manager.is_platform_local("my-registry/app:1.0") is True
    assert manager.is_platform_local("other/app:1.0") is True
    assert manager.is_platform_local("sandbox-platform/base:0.2.0") is False
