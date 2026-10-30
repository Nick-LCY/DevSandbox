"""镜像可用性保障：本地已有、宿主导出注入、交给代理拉取三条路径。

统一镜像代理（ADR 0008）落地后，平台不再维护任何离线镜像包：

1. 沙箱守护进程里已有该镜像 → 直接用；
2. **平台自建镜像**（只在宿主构建出来、不存在于任何仓库）→ 宿主导出后注入；
3. 其余镜像（仓库里存在的）→ 交给沙箱守护进程自己拉，拉取自动经统一镜像代理，
   命中代理缓存；平台不代拉、不预置离线包。

代理不可达时拉取直接失败，不降级直连。
"""

from __future__ import annotations

import hashlib
import logging

from .command import run
from .config import PlatformConfig
from .daemon import UserDaemon
from .errors import ImageError, ImageNotFoundError, ValidationError
from .userspace import Privilege

logger = logging.getLogger(__name__)

SOURCE_PRESENT = "present"
SOURCE_INJECTED = "injected"
SOURCE_REMOTE = "remote"

# 镜像来源（创建入参 ``CreateRequest.image_source`` 的取值）：
# auto —— 一期行为：守护进程已有 → 平台自建镜像由宿主导出注入 → 其余经镜像代理拉取
# host —— 强制从宿主导出注入：宿主没有该镜像直接报错，**不经镜像代理拉取**
IMAGE_SOURCE_AUTO = "auto"
IMAGE_SOURCE_HOST = "host"
IMAGE_SOURCE_CHOICES = (IMAGE_SOURCE_AUTO, IMAGE_SOURCE_HOST)


def image_digest(image: str) -> str:
    """镜像引用的摘要（sha256 前 16 位）。

    注入中转归档的文件名用它：按字符替换分隔符会让 ``a/b:1`` 与 ``a_b:1``
    落到同一个文件名上，互相覆盖。
    """
    return hashlib.sha256(image.encode("utf-8")).hexdigest()[:16]


class ImageManager:
    """镜像查找与宿主镜像注入。"""

    def __init__(
        self,
        config: PlatformConfig | None = None,
        privilege: Privilege | None = None,
    ) -> None:
        self.config = config or PlatformConfig.from_env()
        self.privilege = privilege or Privilege()

    # ---------------------------------------------------------------- 保证可用
    def ensure_image(self, image: str, daemon: UserDaemon) -> str:
        """确保目标守护进程里可用该镜像，返回来源标记。

        链条：沙箱守护进程已有 → 平台自建镜像由宿主导出注入 → 其余交给沙箱守护进程
        经统一镜像代理拉取（代理不可达时直接失败，不降级直连）。
        """
        if daemon.image_exists(image):
            return SOURCE_PRESENT

        if self.is_platform_local(image) and self.host_image_exists(image):
            logger.info("宿主已有平台自建镜像 %s，导出后注入沙箱守护进程", image)
            try:
                return self.inject_from_host(image, daemon)
            except ImageError as exc:
                logger.warning("宿主镜像注入失败，交由沙箱守护进程自行拉取：%s", exc)

        logger.info("镜像 %s 交由沙箱守护进程经统一镜像代理拉取", image)
        return SOURCE_REMOTE

    def ensure_image_from_source(
        self,
        image: str,
        daemon: UserDaemon,
        source: str = IMAGE_SOURCE_AUTO,
        *,
        require_host_image: bool = True,
    ) -> str:
        """按镜像来源准备镜像，返回来源标记。

        ``auto``（默认，一期行为）：链条同 :meth:`ensure_image`。

        ``host``（强制从宿主注入），判定分两种路径：

        - ``require_host_image=True``（创建路径）：宿主必须有该镜像，否则直接报错，
          **不经镜像代理拉取**；
        - ``require_host_image=False``（启动路径）：沙箱守护进程里已有该镜像就直接用
          （宿主镜像已删、守护进程还在时仍能启动），宿主镜像只在守护进程缺失时
          作为注入源。

        非法来源直接抛 :class:`ValidationError`，不静默降级成 ``auto``。
        """
        if source == IMAGE_SOURCE_AUTO:
            return self.ensure_image(image, daemon)
        if source != IMAGE_SOURCE_HOST:
            raise ValidationError(
                f"镜像来源非法：{source!r}，只允许 {' / '.join(IMAGE_SOURCE_CHOICES)}"
            )

        if not require_host_image and daemon.image_exists(image):
            logger.info("沙箱守护进程已有镜像 %s，直接使用", image)
            return SOURCE_PRESENT
        if not self.host_image_exists(image):
            raise ImageNotFoundError(
                f"宿主上没有镜像 {image}：强制从宿主注入模式要求该镜像存在于宿主，"
                "平台不经镜像代理拉取（改用 auto 模式可让沙箱守护进程经代理拉取）"
            )
        if daemon.image_exists(image):
            logger.info("沙箱守护进程已有镜像 %s，跳过重复注入", image)
            return SOURCE_PRESENT
        logger.info("按强制从宿主注入模式准备镜像 %s", image)
        return self.inject_from_host(image, daemon)

    def is_platform_local(self, image: str) -> bool:
        """镜像是否属于平台自建命名空间（只在宿主构建，不存在于任何仓库）。"""
        return any(image.startswith(prefix) for prefix in self.config.local_image_prefixes)

    def host_image_exists(self, image: str) -> bool:
        """宿主 root 守护进程里是否已有该镜像。"""
        return run(self.privilege.wrap(["docker", "image", "inspect", image]), check=False).ok

    def inject_from_host(self, image: str, daemon: UserDaemon) -> str:
        """把宿主守护进程里的镜像导出后注入沙箱守护进程。"""
        self.config.temp_root.mkdir(parents=True, exist_ok=True)
        tar_path = self.config.temp_root / f"inject-{image_digest(image)}.tar"
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
