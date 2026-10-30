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
import json
import logging
from dataclasses import dataclass

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


@dataclass(frozen=True)
class HostImage:
    """宿主本地镜像的一项（供创建页下拉选择）。

    ``reference`` 是 ``仓库:标签`` 形式的镜像引用；``size_bytes`` 是镜像体积
    （字节）；``created_at`` 是镜像创建时间（RFC 3339 文本，取不到时为空串）。
    """

    reference: str
    image_id: str
    size_bytes: int = 0
    created_at: str = ""


class ImageManager:
    """镜像查找与宿主镜像注入。"""

    def __init__(
        self,
        config: PlatformConfig | None = None,
        privilege: Privilege | None = None,
    ) -> None:
        self.config = config or PlatformConfig.from_env()
        self.privilege = privilege or Privilege()

    # ---------------------------------------------------------------- 宿主镜像枚举
    def list_host_images(self) -> list[HostImage]:
        """实时枚举宿主 root 守护进程里的本地镜像。

        含用户自己本地构建、任何仓库都没有的镜像。悬空镜像（``<none>:<none>``）
        不进可选列表；结果按镜像引用排序。
        """
        rows = self._list_host_image_rows()
        details = self._inspect_host_images(rows)
        images: list[HostImage] = []
        for reference, image_id in rows:
            size_bytes, created_at = details.get(image_id, (0, ""))
            images.append(
                HostImage(
                    reference=reference,
                    image_id=image_id,
                    size_bytes=size_bytes,
                    created_at=created_at,
                )
            )
        images.sort(key=lambda item: item.reference)
        return images

    def _list_host_image_rows(self) -> list[tuple[str, str]]:
        """列出宿主镜像的 ``(镜像引用, 镜像 ID)``，悬空镜像已剔除。"""
        result = run(
            self.privilege.wrap(
                ["docker", "image", "ls", "--no-trunc", "--format", "{{json .}}"]
            ),
            check=False,
        )
        if not result.ok:
            raise ImageError(f"枚举宿主镜像失败：{result.output.strip()}")
        rows: list[tuple[str, str]] = []
        for line in result.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                logger.warning("跳过无法解析的镜像行：%s", line)
                continue
            if not isinstance(data, dict):
                continue
            repository = str(data.get("Repository") or "").strip()
            tag = str(data.get("Tag") or "").strip()
            if not repository or not tag or repository == "<none>" or tag == "<none>":
                # 悬空镜像（中间层、被删标签的残留）不可选
                continue
            rows.append((f"{repository}:{tag}", str(data.get("ID") or "").strip()))
        return rows

    def _inspect_host_images(self, rows: list[tuple[str, str]]) -> dict[str, tuple[int, str]]:
        """取镜像的体积（字节）与创建时间，按镜像 ID 索引。

        ``image ls`` 的体积是人读文本（如 ``1.2GB``），字节数只能从
        ``image inspect`` 的 ``Size`` 字段拿。
        """
        image_ids = list(dict.fromkeys(image_id for _, image_id in rows if image_id))
        if not image_ids:
            return {}
        template = "{{.Id}}\t{{.Size}}\t{{.Created}}"
        result = run(
            self.privilege.wrap(["docker", "image", "inspect", "--format", template, *image_ids]),
            check=False,
        )
        if result.ok:
            return self._parse_inspect_lines(result.stdout)
        # 批量失败（可能有镜像刚被删）：逐个重试，拿到多少算多少
        logger.warning("批量读取镜像详情失败，改为逐个读取：%s", result.output.strip())
        details: dict[str, tuple[int, str]] = {}
        for image_id in image_ids:
            one = run(
                self.privilege.wrap(
                    ["docker", "image", "inspect", "--format", template, image_id]
                ),
                check=False,
            )
            if one.ok:
                details.update(self._parse_inspect_lines(one.stdout))
        return details

    @staticmethod
    def _parse_inspect_lines(text: str) -> dict[str, tuple[int, str]]:
        """解析 ``image inspect`` 的行：``镜像 ID\\t体积\\t创建时间``。"""
        details: dict[str, tuple[int, str]] = {}
        for line in text.splitlines():
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            try:
                size_bytes = int(parts[1].strip())
            except ValueError:
                size_bytes = 0
            details[parts[0].strip()] = (size_bytes, parts[2].strip())
        return details

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
