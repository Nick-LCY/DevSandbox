"""镜像可用性保障：本地已有、离线包加载、在线拉取三条路径。

离线包指 ``docker save`` 导出的镜像归档（``.tar`` / ``.tar.gz`` / ``.tgz``）。
平台在离线包目录里按归档内的 ``manifest.json`` 识别镜像名，加载到目标守护进程。
"""

from __future__ import annotations

import json
import logging
import tarfile
from dataclasses import dataclass
from pathlib import Path

from .command import run
from .config import PlatformConfig
from .daemon import UserDaemon
from .errors import ImageError
from .userspace import Privilege

logger = logging.getLogger(__name__)

PACKAGE_SUFFIXES = (".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tar.xz")

# 离线包清单文件名（与平台基础镜像的 /opt/deps/images/images.list 同格式）
MANIFEST_NAME = "images.list"

SOURCE_PRESENT = "present"
SOURCE_OFFLINE = "offline"
SOURCE_PULLED = "pulled"
SOURCE_INJECTED = "injected"


@dataclass(frozen=True)
class OfflineImagePackage:
    """一个离线镜像包。"""

    image: str
    path: Path
    repo_tags: tuple[str, ...] = ()

    @property
    def size(self) -> int:
        """归档字节数。"""
        try:
            return self.path.stat().st_size
        except OSError:
            return 0


class ImageManager:
    """镜像查找、离线包识别与加载。"""

    def __init__(
        self,
        config: PlatformConfig | None = None,
        privilege: Privilege | None = None,
    ) -> None:
        self.config = config or PlatformConfig.from_env()
        self.privilege = privilege or Privilege()

    # ---------------------------------------------------------------- 离线包
    def detect_offline_packages(self, directory: Path | None = None) -> list[OfflineImagePackage]:
        """扫描目录里的离线镜像包。

        优先读清单文件 ``images.list``（每行 ``<镜像引用> <包文件名>``，
        与平台基础镜像的离线包目录同格式）；清单里没有的归档再从归档内的
        ``manifest.json`` 识别镜像名。
        """
        target = Path(directory) if directory is not None else self.config.offline_image_dir
        if not target.is_dir():
            return []
        packages: list[OfflineImagePackage] = []
        listed_files: set[str] = set()
        manifest_path = target / MANIFEST_NAME
        if manifest_path.is_file():
            for line in manifest_path.read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                fields = stripped.split()
                if len(fields) != 2:
                    continue
                image, filename = fields
                path = target / filename
                if not path.is_file():
                    continue
                listed_files.add(path.name)
                packages.append(
                    OfflineImagePackage(image=image, path=path, repo_tags=(image,))
                )
        for path in sorted(target.iterdir()):
            if not path.is_file() or path.name in listed_files or path.name == MANIFEST_NAME:
                continue
            lowered = path.name.lower()
            if not any(lowered.endswith(suffix) for suffix in PACKAGE_SUFFIXES):
                continue
            repo_tags = self._read_repo_tags(path)
            if not repo_tags:
                continue
            packages.append(
                OfflineImagePackage(image=repo_tags[0], path=path, repo_tags=repo_tags)
            )
        return packages

    @staticmethod
    def _read_repo_tags(path: Path) -> tuple[str, ...]:
        """从 ``docker save`` 归档的 ``manifest.json`` 里读镜像标签。"""
        try:
            with tarfile.open(path, "r:*") as archive:
                member = None
                for candidate in archive.getmembers():
                    if candidate.name.lstrip("./") == "manifest.json":
                        member = candidate
                        break
                if member is None:
                    return ()
                handle = archive.extractfile(member)
                if handle is None:
                    return ()
                payload = json.loads(handle.read().decode("utf-8"))
        except (tarfile.TarError, OSError, json.JSONDecodeError, UnicodeDecodeError):
            return ()
        tags: list[str] = []
        for item in payload if isinstance(payload, list) else []:
            for tag in item.get("RepoTags") or []:
                if tag and tag not in tags:
                    tags.append(tag)
        return tuple(tags)

    def find_offline_package(
        self, image: str, directory: Path | None = None
    ) -> OfflineImagePackage | None:
        """按镜像名找离线包。"""
        for package in self.detect_offline_packages(directory):
            if image in package.repo_tags or package.image == image:
                return package
        return None

    def load_offline_package(self, package: OfflineImagePackage, daemon: UserDaemon) -> bool:
        """把离线包加载进目标守护进程。"""
        logger.info("加载离线镜像包：%s（%s）", package.image, package.path)
        result = daemon.load_image(package.path)
        if not result.ok:
            logger.warning("离线包加载失败：%s", result.output)
            return False
        return daemon.image_exists(package.image)

    # ---------------------------------------------------------------- 保证可用
    def ensure_image(self, image: str, daemon: UserDaemon) -> str:
        """确保目标守护进程里可用该镜像，返回来源标记。

        顺序：本地已有 → 离线包加载 → 宿主本地镜像注入 → 守护进程直拉 → 宿主拉取后注入。
        """
        if daemon.image_exists(image):
            return SOURCE_PRESENT

        package = self.find_offline_package(image)
        if package is not None and self.load_offline_package(package, daemon):
            return SOURCE_OFFLINE

        if self.host_image_exists(image):
            logger.info("宿主已有镜像 %s，导出后注入沙箱守护进程", image)
            try:
                return self._inject_from_host(image, daemon)
            except ImageError as exc:
                logger.warning("宿主镜像注入失败，转走拉取路径：%s", exc)

        logger.info("守护进程直接拉取镜像 %s", image)
        pulled = daemon.pull_image(image)
        if pulled.ok and daemon.image_exists(image):
            return SOURCE_PULLED

        logger.info("直拉失败，改由宿主 root 守护进程拉取后离线注入")
        host_pull = run(self.privilege.wrap(["docker", "pull", image]), check=False, timeout=900)
        if not host_pull.ok:
            raise ImageError(
                f"镜像 {image} 不可用：守护进程直拉与宿主拉取均失败。"
                f"直拉输出：{pulled.output.strip()}；宿主拉取输出：{host_pull.output.strip()}"
            )
        return self._inject_from_host(image, daemon)

    def host_image_exists(self, image: str) -> bool:
        """宿主 root 守护进程里是否已有该镜像（平台自建镜像走这条路）。"""
        return run(self.privilege.wrap(["docker", "image", "inspect", image]), check=False).ok

    def _inject_from_host(self, image: str, daemon: UserDaemon) -> str:
        """把宿主守护进程里的镜像导出后注入沙箱守护进程。"""
        self.config.temp_root.mkdir(parents=True, exist_ok=True)
        tar_path = self.config.temp_root / f"inject-{image.replace('/', '_').replace(':', '_')}.tar"
        try:
            save = run(
                self.privilege.wrap(["docker", "save", "-o", str(tar_path), image]),
                check=False,
                timeout=1800,
            )
            if not save.ok:
                raise ImageError(f"导出镜像 {image} 失败：{save.output.strip()}")
            # 归档由宿主 root 导出，需要放开读权限，沙箱用户才能导入
            run(self.privilege.wrap(["chmod", "0644", str(tar_path)]), check=False)
            loaded = daemon.load_image(tar_path)
            if not loaded.ok or not daemon.image_exists(image):
                raise ImageError(f"镜像 {image} 注入守护进程失败：{loaded.output.strip()}")
            return SOURCE_INJECTED
        finally:
            tar_path.unlink(missing_ok=True)
