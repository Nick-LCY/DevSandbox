"""镜像可用性保障的单元测试：先经镜像代理拉取，失败再回退宿主副本注入。

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
        pull_ok: bool = True,
        pull_detail: str = "拉取失败",
    ) -> None:
        self.images = set(images)
        self.load_ok = load_ok
        self.loaded_as = loaded_as
        self.pull_ok = pull_ok
        self.pull_detail = pull_detail
        self.loaded: list[Path] = []
        self.pulled: list[str] = []

    def image_exists(self, image: str) -> bool:
        return image in self.images

    def pull_image(self, image: str, timeout: int = 900) -> CommandResult:
        self.pulled.append(image)
        if self.pull_ok:
            self.images.add(image)
            return CommandResult(("docker", "pull", image), 0, "拉取成功", "")
        return CommandResult(("docker", "pull", image), 1, "", self.pull_detail)

    def load_image(self, tar_path: str | Path, timeout: int = 600) -> CommandResult:
        self.loaded.append(Path(tar_path))
        if self.load_ok:
            self.images.add(self.loaded_as)
        return CommandResult(("docker", "load"), 0 if self.load_ok else 1, "", "")


@pytest.fixture
def manager(config: PlatformConfig) -> ImageManager:
    """镜像管理器实例。"""
    return ImageManager(config)


# ---------------------------------------------------------------- 保证可用：auto 链条
def test_image_already_in_daemon_is_reused(manager: ImageManager) -> None:
    """沙箱守护进程里已有该镜像时直接用（不拉取、不注入）。"""
    daemon = FakeDaemon(images=("busybox:1.37",))
    assert manager.ensure_image("busybox:1.37", daemon) == "present"
    assert daemon.pulled == []
    assert daemon.loaded == []


def test_auto_pulls_via_proxy_when_host_lacks_image(manager: ImageManager, monkeypatch) -> None:
    """代理拉取命中：镜像交给沙箱守护进程经统一镜像代理拉取，不由宿主导入。"""
    daemon = FakeDaemon(pull_ok=True)
    monkeypatch.setattr(manager, "host_image_exists", lambda image: False)
    assert manager.ensure_image("busybox:1.37", daemon) == "remote"
    assert daemon.pulled == ["busybox:1.37"]
    assert daemon.loaded == []


def test_auto_injects_from_host_when_proxy_pull_fails(manager: ImageManager, monkeypatch) -> None:
    """代理拉取失败且宿主本地有该镜像：回退宿主导出注入。"""
    daemon = FakeDaemon(pull_ok=False)
    monkeypatch.setattr(manager, "host_image_exists", lambda image: True)
    injected: list[str] = []
    monkeypatch.setattr(
        manager, "inject_from_host", lambda image, d: injected.append(image) or "injected"
    )
    assert manager.ensure_image("my-local/app:dev", daemon) == "injected"
    assert daemon.pulled == ["my-local/app:dev"]
    assert injected == ["my-local/app:dev"]


def test_auto_fails_when_proxy_pull_fails_and_host_lacks_image(
    manager: ImageManager, monkeypatch
) -> None:
    """代理拉取失败且宿主也没有该镜像：直接报错（不降级直连外网）。"""
    from sandbox_platform import ImageNotFoundError

    daemon = FakeDaemon(pull_ok=False)
    monkeypatch.setattr(manager, "host_image_exists", lambda image: False)
    with pytest.raises(ImageNotFoundError):
        manager.ensure_image("busybox:1.37", daemon)
    assert daemon.loaded == []


def test_auto_reports_both_routes_when_pull_and_injection_fail(
    manager: ImageManager, monkeypatch
) -> None:
    """代理拉取与宿主注入都失败：报错文案说明两种途径均失败。"""
    from sandbox_platform import ImageNotFoundError

    daemon = FakeDaemon(pull_ok=False)
    monkeypatch.setattr(manager, "host_image_exists", lambda image: True)

    def _boom(image: str, d) -> str:
        from sandbox_platform import ImageError

        raise ImageError("导出失败")

    monkeypatch.setattr(manager, "inject_from_host", _boom)
    with pytest.raises(ImageNotFoundError) as excinfo:
        manager.ensure_image("my-local/app:dev", daemon)
    message = str(excinfo.value)
    assert "代理拉取失败" in message
    assert "注入也失败" in message


def test_image_prefix_no_longer_decides_source(manager: ImageManager, monkeypatch) -> None:
    """前缀机制已下线：带不带平台前缀都先走代理，代理拉不到才回退宿主注入。"""
    daemon = FakeDaemon(pull_ok=False)
    monkeypatch.setattr(manager, "host_image_exists", lambda image: True)
    monkeypatch.setattr(manager, "inject_from_host", lambda image, d: "injected")
    assert manager.ensure_image("my-registry/app:1.0", daemon) == "injected"
    assert manager.ensure_image("sandbox-platform/base:0.2.0", daemon) == "injected"


# ---------------------------------------------------------------- 镜像来源开关
def test_auto_source_prefers_proxy_over_host_injection(manager: ImageManager, monkeypatch) -> None:
    """auto：宿主本地有该镜像也先走代理（不注入），避免绕过代理缓存。"""
    daemon = FakeDaemon(pull_ok=True)
    monkeypatch.setattr(manager, "host_image_exists", lambda image: True)
    monkeypatch.setattr(manager, "inject_from_host", lambda image, d: "injected")
    assert manager.ensure_image_from_source("busybox:1.37", daemon) == "remote"
    assert daemon.loaded == []


def test_auto_source_falls_back_to_host_injection(manager: ImageManager, monkeypatch) -> None:
    """auto：代理拉取失败且宿主本地有该镜像时回退宿主导出注入。"""
    daemon = FakeDaemon(pull_ok=False)
    monkeypatch.setattr(manager, "host_image_exists", lambda image: True)
    monkeypatch.setattr(manager, "inject_from_host", lambda image, d: "injected")
    assert manager.ensure_image_from_source("my-local/app:dev", daemon) == "injected"


def test_auto_source_fails_when_both_routes_fail(manager: ImageManager, monkeypatch) -> None:
    """auto：代理拉取失败且宿主没有该镜像时直接报错。"""
    from sandbox_platform import ImageNotFoundError

    daemon = FakeDaemon(pull_ok=False)
    monkeypatch.setattr(manager, "host_image_exists", lambda image: False)
    with pytest.raises(ImageNotFoundError):
        manager.ensure_image_from_source("busybox:1.37", daemon)


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
    assert daemon.pulled == []


def test_host_source_fails_when_host_lacks_image(manager: ImageManager, monkeypatch) -> None:
    """host：宿主没有该镜像直接报错，不退回镜像代理拉取。"""
    from sandbox_platform import ImageError

    daemon = FakeDaemon()
    monkeypatch.setattr(manager, "host_image_exists", lambda image: False)
    with pytest.raises(ImageError):
        manager.ensure_image_from_source("my-local/app:dev", daemon, "host")
    assert daemon.loaded == []
    assert daemon.pulled == []


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
