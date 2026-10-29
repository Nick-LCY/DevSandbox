"""平台配置。

所有可调参数集中在这里，取值优先级：显式传参 > 环境变量 > 默认值。
数据根目录由环境变量 ``SANDBOX_PLATFORM_HOME`` 重定向，默认 ``/var/lib/sandbox-platform``。

统一镜像代理（``rpardini/docker-registry-proxy``）的相关参数也在本文件集中：
代理镜像、监听端口、沙箱侧访问代理用的网关地址、被缓存的镜像仓库清单、
以及合并 CA 束所用的系统 CA 束路径。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, replace
from pathlib import Path

from .errors import ConfigError

DEFAULT_HOME = "/var/lib/sandbox-platform"
DEFAULT_IMAGE = "sandbox-platform/sandbox-default"
DEFAULT_SOCKET_MOUNT = "/var/run/docker.sock"

# 统一镜像代理：镜像 tag 钉在 0.8.0（上游稳定版，多架构；digest 见 RESULTS.md）
DEFAULT_PROXY_IMAGE = "rpardini/docker-registry-proxy:0.8.0"
# 代理在宿主回环上的监听端口
DEFAULT_PROXY_PORT = 3128
# 沙箱免 root 守护进程访问代理用的地址。
# 默认 127.0.0.1：dockerd-rootless.sh 默认启用 --detach-netns，守护进程进程本身
# 留在宿主网络命名空间（只有容器在 slirp4netns 命名空间里），
# 所以守护进程访问代理要用宿主回环地址。slirp 网关 10.0.2.2 只在沙箱容器内可达。
DEFAULT_PROXY_ADDRESS = "127.0.0.1"
# 被代理拦截并缓存的镜像仓库清单（docker.io 由代理内部内置处理）
DEFAULT_PROXY_REGISTRIES = ("docker.io", "ghcr.io", "quay.io", "gcr.io", "registry.k8s.io")
# 宿主系统 CA 束（与代理 CA 合并成单个文件后注入沙箱守护进程）
DEFAULT_SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt"
# 平台自建镜像的命名前缀：这类镜像只在宿主构建、不存在于任何仓库，由宿主导出注入
DEFAULT_LOCAL_IMAGE_PREFIXES = ("sandbox-platform/",)

ENV_HOME = "SANDBOX_PLATFORM_HOME"
ENV_USER_PREFIX = "SANDBOX_PLATFORM_USER_PREFIX"
ENV_SUBID_BASE = "SANDBOX_PLATFORM_SUBID_BASE"
ENV_SUBID_LENGTH = "SANDBOX_PLATFORM_SUBID_LENGTH"
ENV_IMAGE = "SANDBOX_PLATFORM_IMAGE"
ENV_SOCKET_MOUNT = "SANDBOX_PLATFORM_SOCKET_MOUNT"
ENV_PROXY_IMAGE = "SANDBOX_PLATFORM_PROXY_IMAGE"
ENV_PROXY_PORT = "SANDBOX_PLATFORM_PROXY_PORT"
ENV_PROXY_ADDRESS = "SANDBOX_PLATFORM_PROXY_ADDRESS"
ENV_PROXY_REGISTRIES = "SANDBOX_PLATFORM_PROXY_REGISTRIES"
ENV_SYSTEM_CA_BUNDLE = "SANDBOX_PLATFORM_SYSTEM_CA_BUNDLE"
ENV_LOCAL_IMAGE_PREFIXES = "SANDBOX_PLATFORM_LOCAL_IMAGE_PREFIXES"

MIN_SUBID_BASE = 100000
MIN_SUBID_LENGTH = 65536
MIN_PORT = 1
MAX_PORT = 65535


def _env_int(env: dict[str, str], key: str, default: int) -> int:
    raw = env.get(key)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw.strip())
    except ValueError as exc:  # pragma: no cover - 环境变量由外部注入
        raise ConfigError(f"环境变量 {key} 取值非法：{raw!r}，应为整数") from exc


def _env_list(env: dict[str, str], key: str, default: tuple[str, ...]) -> tuple[str, ...]:
    """解析空格分隔的列表型环境变量。"""
    raw = env.get(key)
    if raw is None or raw.strip() == "":
        return default
    items = tuple(item for item in raw.split() if item)
    if not items:
        raise ConfigError(f"环境变量 {key} 取值非法：{raw!r}，至少要有一个条目")
    return items


@dataclass(frozen=True)
class PlatformConfig:
    """平台运行期配置快照。"""

    home: Path = Path(DEFAULT_HOME)
    user_prefix: str = "sandbox"
    subid_base: int = MIN_SUBID_BASE
    subid_length: int = MIN_SUBID_LENGTH
    default_image: str = DEFAULT_IMAGE
    socket_mount_path: str = DEFAULT_SOCKET_MOUNT
    proxy_image: str = DEFAULT_PROXY_IMAGE
    proxy_port: int = DEFAULT_PROXY_PORT
    proxy_address: str = DEFAULT_PROXY_ADDRESS
    proxy_registries: tuple[str, ...] = DEFAULT_PROXY_REGISTRIES
    system_ca_bundle: Path = Path(DEFAULT_SYSTEM_CA_BUNDLE)
    local_image_prefixes: tuple[str, ...] = DEFAULT_LOCAL_IMAGE_PREFIXES

    # ---------------------------------------------------------------- 构造
    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> PlatformConfig:
        """按环境变量装配配置。"""
        env = dict(os.environ if env is None else env)
        home = Path(env.get(ENV_HOME, "").strip() or DEFAULT_HOME)
        prefix = env.get(ENV_USER_PREFIX, "").strip() or "sandbox"
        image = env.get(ENV_IMAGE, "").strip() or DEFAULT_IMAGE
        socket_mount = env.get(ENV_SOCKET_MOUNT, "").strip() or DEFAULT_SOCKET_MOUNT
        proxy_image = env.get(ENV_PROXY_IMAGE, "").strip() or DEFAULT_PROXY_IMAGE
        proxy_address = env.get(ENV_PROXY_ADDRESS, "").strip() or DEFAULT_PROXY_ADDRESS
        system_ca = env.get(ENV_SYSTEM_CA_BUNDLE, "").strip() or DEFAULT_SYSTEM_CA_BUNDLE
        config = cls(
            home=home,
            user_prefix=prefix,
            subid_base=_env_int(env, ENV_SUBID_BASE, MIN_SUBID_BASE),
            subid_length=_env_int(env, ENV_SUBID_LENGTH, MIN_SUBID_LENGTH),
            default_image=image,
            socket_mount_path=socket_mount,
            proxy_image=proxy_image,
            proxy_port=_env_int(env, ENV_PROXY_PORT, DEFAULT_PROXY_PORT),
            proxy_address=proxy_address,
            proxy_registries=_env_list(env, ENV_PROXY_REGISTRIES, DEFAULT_PROXY_REGISTRIES),
            system_ca_bundle=Path(system_ca),
            local_image_prefixes=_env_list(
                env, ENV_LOCAL_IMAGE_PREFIXES, DEFAULT_LOCAL_IMAGE_PREFIXES
            ),
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
        if not self.proxy_image.strip():
            raise ConfigError("代理镜像名不能为空")
        if not MIN_PORT <= self.proxy_port <= MAX_PORT:
            raise ConfigError(f"代理端口非法：{self.proxy_port}（应为 {MIN_PORT}~{MAX_PORT}）")
        if not self.proxy_address.strip():
            raise ConfigError("代理地址不能为空")
        if not self.proxy_registries:
            raise ConfigError("代理的镜像仓库清单不能为空")
        if not str(self.system_ca_bundle).startswith("/"):
            raise ConfigError(f"系统 CA 束路径必须是绝对路径：{self.system_ca_bundle}")

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
        """平台临时文件目录（镜像注入中转等）。"""
        return self.home / "tmp"

    @property
    def proxy_root(self) -> Path:
        """统一镜像代理的数据根目录（缓存与 CA 都在其下）。"""
        return self.home / "registry-proxy"

    @property
    def proxy_cache_dir(self) -> Path:
        """代理的镜像层缓存目录（对应容器内 ``/docker_mirror_cache``）。"""
        return self.proxy_root / "cache"

    @property
    def proxy_ca_dir(self) -> Path:
        """代理的 CA 目录（对应容器内 ``/ca``）。"""
        return self.proxy_root / "ca"

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
