"""离线镜像包识别与加载路径的单元测试。"""

from __future__ import annotations

import io
import json
import tarfile
from pathlib import Path

import pytest

from sandbox_platform import ImageManager, OfflineImagePackage


def _make_image_archive(path: Path, repo_tags: list[str]) -> None:
    """构造一个 docker save 风格的归档。"""
    manifest = [{"Config": "config.json", "RepoTags": repo_tags, "Layers": ["layer.tar"]}]
    payload = json.dumps(manifest).encode("utf-8")
    with tarfile.open(path, "w") as archive:
        info = tarfile.TarInfo("manifest.json")
        info.size = len(payload)
        archive.addfile(info, io.BytesIO(payload))


@pytest.fixture
def offline_dir(tmp_path: Path) -> Path:
    """离线包目录。"""
    directory = tmp_path / "offline-images"
    directory.mkdir()
    return directory


def test_detect_offline_packages_reads_repo_tags(offline_dir: Path, config) -> None:
    """离线包的镜像名来自归档内的 manifest.json。"""
    _make_image_archive(offline_dir / "postgres.tar", ["postgres:16"])
    manager = ImageManager(config)
    packages = manager.detect_offline_packages(offline_dir)
    assert len(packages) == 1
    assert packages[0].image == "postgres:16"
    assert packages[0].repo_tags == ("postgres:16",)


def test_detect_offline_packages_ignores_other_files(offline_dir: Path, config) -> None:
    """非归档文件被忽略。"""
    (offline_dir / "readme.txt").write_text("不是镜像包", encoding="utf-8")
    manager = ImageManager(config)
    assert manager.detect_offline_packages(offline_dir) == []


def test_detect_offline_packages_missing_directory(tmp_path: Path, config) -> None:
    """目录不存在时返回空列表。"""
    manager = ImageManager(config)
    assert manager.detect_offline_packages(tmp_path / "nope") == []


def test_find_offline_package_by_tag(offline_dir: Path, config) -> None:
    """按镜像名查找离线包。"""
    _make_image_archive(offline_dir / "minio.tar", ["minio/minio:RELEASE.2024-01-01"])
    manager = ImageManager(config)
    package = manager.find_offline_package("minio/minio:RELEASE.2024-01-01", offline_dir)
    assert package is not None
    assert package.path.name == "minio.tar"


def test_find_offline_package_missing(offline_dir: Path, config) -> None:
    """找不到时返回 None。"""
    manager = ImageManager(config)
    assert manager.find_offline_package("redis:7", offline_dir) is None


def test_broken_archive_is_skipped(offline_dir: Path, config) -> None:
    """损坏的归档不会让扫描崩溃。"""
    (offline_dir / "broken.tar").write_bytes(b"not a tar file")
    manager = ImageManager(config)
    assert manager.detect_offline_packages(offline_dir) == []


def test_manifest_file_lists_packages(offline_dir: Path, config) -> None:
    """清单文件 images.list 优先于归档内容识别（与基础镜像同格式）。"""
    _make_image_archive(offline_dir / "postgres.tar", ["postgres:16"])
    (offline_dir / "images.list").write_text(
        "postgres:16.15-alpine3.24 postgres.tar\n", encoding="utf-8"
    )
    manager = ImageManager(config)
    packages = manager.detect_offline_packages(offline_dir)
    assert len(packages) == 1
    assert packages[0].image == "postgres:16.15-alpine3.24"
    assert packages[0].path.name == "postgres.tar"


def test_manifest_and_archive_scan_combined(offline_dir: Path, config) -> None:
    """清单里的包与目录里未被清单覆盖的归档都能识别。"""
    _make_image_archive(offline_dir / "listed.tar", ["listed:1"])
    _make_image_archive(offline_dir / "loose.tar", ["loose:2"])
    (offline_dir / "images.list").write_text("listed:1 listed.tar\n", encoding="utf-8")
    manager = ImageManager(config)
    images = {package.image for package in manager.detect_offline_packages(offline_dir)}
    assert images == {"listed:1", "loose:2"}


def test_offline_package_dataclass_defaults() -> None:
    """离线包数据类默认值合理。"""
    package = OfflineImagePackage(image="busybox", path=Path("/tmp/busybox.tar"))
    assert package.repo_tags == ()
    assert package.size == 0
