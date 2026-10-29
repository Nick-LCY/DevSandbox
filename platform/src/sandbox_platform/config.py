"""平台配置。

所有可调参数集中在这里，取值优先级：显式传参 > 环境变量 > 默认值。
数据根目录由环境变量 ``SANDBOX_PLATFORM_HOME`` 重定向，默认 ``/var/lib/sandbox-platform``。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, replace
from pathlib import Path

from .errors import ConfigError

DEFAULT_HOME = "/var/lib/sandbox-platform"
DEFAULT_IMAGE = "sandbox-platform/sandbox-default"
DEFAULT_SOCKET_MOUNT = "/var/run/docker.sock"
DEFAULT_OFFLINE_IMAGE_DIR = "/opt/deps/images"

ENV_HOME = "SANDBOX_PLATFORM_HOME"
ENV_USER_PREFIX = "SANDBOX_PLATFORM_USER_PREFIX"
ENV_SUBID_BASE = "SANDBOX_PLATFORM_SUBID_BASE"
ENV_SUBID_LENGTH = "SANDBOX_PLATFORM_SUBID_LENGTH"
ENV_OFFLINE_IMAGE_DIR = "SANDBOX_PLATFORM_OFFLINE_IMAGE_DIR"
ENV_IMAGE = "SANDBOX_PLATFORM_IMAGE"
ENV_SOCKET_MOUNT = "SANDBOX_PLATFORM_SOCKET_MOUNT"

MIN_SUBID_BASE = 100000
MIN_SUBID_LENGTH = 65536


def _env_int(env: dict[str, str], key: str, default: int) -> int:
    raw = env.get(key)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw.strip())
    except ValueError as exc:  # pragma: no cover - 环境变量由外部注入
        raise ConfigError(f"环境变量 {key} 取值非法：{raw!r}，应为整数") from exc


@dataclass(frozen=True)
class PlatformConfig:
    """平台运行期配置快照。"""

    home: Path = Path(DEFAULT_HOME)
    user_prefix: str = "sandbox"
    subid_base: int = MIN_SUBID_BASE
    subid_length: int = MIN_SUBID_LENGTH
    offline_image_dir: Path = Path(DEFAULT_OFFLINE_IMAGE_DIR)
    default_image: str = DEFAULT_IMAGE
    socket_mount_path: str = DEFAULT_SOCKET_MOUNT

    # ---------------------------------------------------------------- 构造
    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> PlatformConfig:
        """按环境变量装配配置。"""
        env = dict(os.environ if env is None else env)
        home = Path(env.get(ENV_HOME, "").strip() or DEFAULT_HOME)
        prefix = env.get(ENV_USER_PREFIX, "").strip() or "sandbox"
        offline_dir = Path(env.get(ENV_OFFLINE_IMAGE_DIR, "").strip() or DEFAULT_OFFLINE_IMAGE_DIR)
        image = env.get(ENV_IMAGE, "").strip() or DEFAULT_IMAGE
        socket_mount = env.get(ENV_SOCKET_MOUNT, "").strip() or DEFAULT_SOCKET_MOUNT
        config = cls(
            home=home,
            user_prefix=prefix,
            subid_base=_env_int(env, ENV_SUBID_BASE, MIN_SUBID_BASE),
            subid_length=_env_int(env, ENV_SUBID_LENGTH, MIN_SUBID_LENGTH),
            offline_image_dir=offline_dir,
            default_image=image,
            socket_mount_path=socket_mount,
        )
        config.validate()
        return config

    def with_overrides(self, **kwargs: object) -> PlatformConfig:
        """返回覆盖部分字段后的新配置。"""
        return replace(self, **kwargs)  # type: ignore[arg-type]

    def validate(self) -> None:
        """校验配置取值是否自洽。"""
        if not str(self.home).startswith("/"):
            raise ConfigError(f"数据根目录必须是绝对路径：{self.home}")
        if self.subid_base < MIN_SUBID_BASE:
            raise ConfigError(f"子 ID 段起点不得小于 {MIN_SUBID_BASE}：{self.subid_base}")
        if self.subid_length < MIN_SUBID_LENGTH:
            raise ConfigError(f"子 ID 段长度不得小于 {MIN_SUBID_LENGTH}：{self.subid_length}")
        if not self.socket_mount_path.startswith("/"):
            raise ConfigError(f"套接字容器内路径必须是绝对路径：{self.socket_mount_path}")
        if not self.default_image.strip():
            raise ConfigError("默认镜像名不能为空")

    # ---------------------------------------------------------------- 路径
    @property
    def sandbox_root(self) -> Path:
        """沙箱元数据根目录。"""
        return self.home / "sandboxes"

    @property
    def lock_root(self) -> Path:
        """锁文件目录（子 ID 段分配等临界区使用）。"""
        return self.home / "locks"

    @property
    def temp_root(self) -> Path:
        """平台临时文件目录（镜像离线包中转等）。"""
        return self.home / "tmp"

    def sandbox_dir(self, name: str) -> Path:
        """单个沙箱的工作目录。"""
        return self.sandbox_root / name

    def metadata_path(self, name: str) -> Path:
        """单个沙箱的元数据文件路径。"""
        return self.sandbox_dir(name) / "metadata.json"

    def system_user_name(self, sandbox_name: str) -> str:
        """沙箱对应的系统用户名。"""
        return f"{self.user_prefix}-{sandbox_name}"

    def ensure_directories(self) -> None:
        """创建平台数据目录（幂等）。"""
        for path in (self.home, self.sandbox_root, self.lock_root, self.temp_root):
            path.mkdir(parents=True, exist_ok=True)
