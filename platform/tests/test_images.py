"""镜像可用性保障的单元测试：本地已有 → 宿主导出注入 → 交给代理拉取。

离线包机制已废弃（ADR 0008），平台不再维护任何离线镜像包。
镜像前缀机制已下线：判定只看「宿主本地有没有这个镜像」。
二期新增镜像来源开关：``auto``（默认）与 ``host``（强制从宿主注入）。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sandbox_platform import ImageManager, PlatformConfig, image_digest
from sandbox_platform.command import CommandResult


class FakeDaemon:
    """假的沙箱守护进程：记录镜像操作。"""

    def __init__(
        self,
        images: tuple[str, ...] = (),
        load_ok: bool = True,
        loaded_as: str = "loaded",
    ) -> None:
        self.images = set(images)
        self.load_ok = load_ok
        self.loaded_as = loaded_as
        self.loaded: list[Path] = []

    def image_exists(self, image: str) -> bool:
        return image in self.images

    def load_image(self, tar_path: str | Path, timeout: int = 600) -> CommandResult:
        self.loaded.append(Path(tar_path))
        if self.load_ok:
            self.images.add(self.loaded_as)
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
    """宿主本地没有的镜像不由平台代拉，交给沙箱守护进程经代理拉取。"""
    daemon = FakeDaemon()
    monkeypatch.setattr(manager, "host_image_exists", lambda image: False)
    assert manager.ensure_image("busybox:1.37", daemon) == "remote"
    assert daemon.loaded == []


def test_host_local_image_is_injected_from_host(manager: ImageManager, monkeypatch) -> None:
    """宿主本地已有的镜像由宿主导出后注入沙箱守护进程（不看命名前缀）。"""
    daemon = FakeDaemon()
    monkeypatch.setattr(manager, "host_image_exists", lambda image: True)
    monkeypatch.setattr(manager, "inject_from_host", lambda image, d: "injected")
    source = manager.ensure_image("sandbox-platform/base:0.2.0", daemon)
    assert source == "injected"


def test_image_prefix_no_longer_decides_source(manager: ImageManager, monkeypatch) -> None:
    """前缀机制已下线：带不带平台前缀都只看宿主本地有没有。"""
    daemon = FakeDaemon()
    monkeypatch.setattr(manager, "host_image_exists", lambda image: True)
    monkeypatch.setattr(manager, "inject_from_host", lambda image, d: "injected")
    assert manager.ensure_image("my-registry/app:1.0", daemon) == "injected"
    assert manager.ensure_image("sandbox-platform/base:0.2.0", daemon) == "injected"


def test_injection_failure_falls_back_to_remote(manager: ImageManager, monkeypatch) -> None:
    """宿主镜像注入失败时不阻断，退回「交给守护进程经代理拉取」。"""
    from sandbox_platform import ImageError

    daemon = FakeDaemon()
    monkeypatch.setattr(manager, "host_image_exists", lambda image: True)

    def _boom(image: str, d) -> str:
        raise ImageError("导出失败")

    monkeypatch.setattr(manager, "inject_from_host", _boom)
    assert manager.ensure_image("sandbox-platform/base:0.2.0", daemon) == "remote"


# ---------------------------------------------------------------- 镜像来源开关
def test_auto_source_injects_when_host_has_image(manager: ImageManager, monkeypatch) -> None:
    """默认 auto：宿主本地有该镜像则宿主导出注入。"""
    daemon = FakeDaemon()
    monkeypatch.setattr(manager, "host_image_exists", lambda image: True)
    monkeypatch.setattr(manager, "inject_from_host", lambda image, d: "injected")
    assert manager.ensure_image_from_source("busybox:1.37", daemon) == "injected"
    assert daemon.loaded == []


def test_auto_source_falls_back_to_proxy_when_host_lacks_image(
    manager: ImageManager, monkeypatch
) -> None:
    """默认 auto：宿主本地没有该镜像则交由沙箱守护进程经镜像代理拉取。"""
    daemon = FakeDaemon()
    monkeypatch.setattr(manager, "host_image_exists", lambda image: False)
    assert manager.ensure_image_from_source("busybox:1.37", daemon) == "remote"
    assert daemon.loaded == []


def test_host_source_injects_from_host(manager: ImageManager, monkeypatch) -> None:
    """host：强制从宿主导出注入沙箱守护进程（不经镜像代理）。"""
    daemon = FakeDaemon()
    monkeypatch.setattr(manager, "host_image_exists", lambda image: True)
    injected: list[str] = []
    monkeypatch.setattr(
        manager, "inject_from_host", lambda image, d: injected.append(image) or "injected"
    )
    assert manager.ensure_image_from_source("my-local/app:dev", daemon, "host") == "injected"
    assert injected == ["my-local/app:dev"]


def test_host_source_fails_when_host_lacks_image(manager: ImageManager, monkeypatch) -> None:
    """host：宿主没有该镜像直接报错，不退回镜像代理拉取。"""
    from sandbox_platform import ImageError

    daemon = FakeDaemon()
    monkeypatch.setattr(manager, "host_image_exists", lambda image: False)
    with pytest.raises(ImageError):
        manager.ensure_image_from_source("my-local/app:dev", daemon, "host")
    assert daemon.loaded == []


def test_host_source_skips_redundant_injection(manager: ImageManager, monkeypatch) -> None:
    """host：沙箱守护进程里已有该镜像时不重复导出注入。"""
    daemon = FakeDaemon(images=("my-local/app:dev",))
    monkeypatch.setattr(manager, "host_image_exists", lambda image: True)
    monkeypatch.setattr(manager, "inject_from_host", lambda image, d: "injected")
    assert manager.ensure_image_from_source("my-local/app:dev", daemon, "host") == "present"
    assert daemon.loaded == []


def test_invalid_image_source_is_rejected(manager: ImageManager, monkeypatch) -> None:
    """非法来源不静默降级成 auto，直接报错。"""
    from sandbox_platform import ValidationError

    daemon = FakeDaemon()
    monkeypatch.setattr(manager, "host_image_exists", lambda image: True)
    with pytest.raises(ValidationError):
        manager.ensure_image_from_source("my-local/app:dev", daemon, "proxy")


# ---------------------------------------------------------------- 启动路径的判定
def test_start_path_uses_daemon_image_when_host_copy_is_gone(
    manager: ImageManager, monkeypatch
) -> None:
    """启动路径：守护进程里已有镜像就直接用（宿主镜像已删也能启动）。"""
    daemon = FakeDaemon(images=("my-local/app:dev",))
    monkeypatch.setattr(manager, "host_image_exists", lambda image: False)
    source = manager.ensure_image_from_source(
        "my-local/app:dev", daemon, "host", require_host_image=False
    )
    assert source == "present"
    assert daemon.loaded == []


def test_start_path_injects_from_host_when_daemon_lacks_image(
    manager: ImageManager, monkeypatch
) -> None:
    """启动路径：守护进程里没有镜像时，宿主副本作为注入源。"""
    daemon = FakeDaemon()
    monkeypatch.setattr(manager, "host_image_exists", lambda image: True)
    monkeypatch.setattr(manager, "inject_from_host", lambda image, d: "injected")
    source = manager.ensure_image_from_source(
        "my-local/app:dev", daemon, "host", require_host_image=False
    )
    assert source == "injected"


def test_start_path_fails_when_neither_side_has_image(
    manager: ImageManager, monkeypatch
) -> None:
    """启动路径：宿主与守护进程都没有镜像时报错（不退回代理拉取）。"""
    from sandbox_platform import ImageNotFoundError

    daemon = FakeDaemon()
    monkeypatch.setattr(manager, "host_image_exists", lambda image: False)
    with pytest.raises(ImageNotFoundError):
        manager.ensure_image_from_source(
            "my-local/app:dev", daemon, "host", require_host_image=False
        )


# ---------------------------------------------------------------- 注入中转文件名
def test_injection_tar_name_does_not_collide(manager: ImageManager, monkeypatch) -> None:
    """注入中转归档按镜像引用摘要命名：``a/b:1`` 与 ``a_b:1`` 不撞名。"""
    saved: list[Path] = []

    def fake_run(argv, **kwargs) -> CommandResult:
        if "save" in argv:
            saved.append(Path(argv[argv.index("-o") + 1]))
        return CommandResult(tuple(argv), 0, "", "")

    monkeypatch.setattr("sandbox_platform.images.run", fake_run)

    first = FakeDaemon(loaded_as="a/b:1")
    manager.inject_from_host("a/b:1", first)
    second = FakeDaemon(loaded_as="a_b:1")
    manager.inject_from_host("a_b:1", second)

    assert len(saved) == 2
    assert saved[0].name != saved[1].name
    assert saved[0].name.startswith("inject-")
    assert saved[0].name.endswith(".tar")
    assert saved[0].name == f"inject-{image_digest('a/b:1')}.tar"
