"""镜像缓存清单注入参数的推导：后端可达地址 + 受限令牌。

沙箱内的 ``cached-images`` 命令要知道「后端在哪、用哪把钥匙」，这两个值由
服务端在创建 / 启动沙箱时推导并以可选创建参数递给核心包（模板注入先例的
同款位置：服务端读自己的状态、以参数递核心包执行，核心包不知业务存在）：

- **可达地址**：新配置项 ``SANDBOX_CONSOLE_SANDBOX_URL`` 优先（部署形态确定
  时用配置钉死，如绑定在反代 / 指定网卡之后）；未配置走**宿主非回环 IPv4 +
  实际监听端口**自动探测兜底（沙箱容器到宿主后端实测只有宿主局域网地址
  一条路可达）；两者皆不可得 → 跳过地址项并打日志，**创建不失败**；
- **受限令牌**：每请求重读 02 的凭据文件 ``cache-images-token.json``
  （与 ``BearerAuthMiddleware`` 同一读径）——重写文件即完成轮换，下一次
  创建 / 启动递出的就是新值；文件缺失 / 损坏 → **跳过令牌项**并打日志
  （不注入空值：容器侧 ``cached-images`` 的三态判定里「env 缺失」是明确定义
  的失败态，注入空值反而制造出第四种说不清的状态），创建不失败；
- **两值不进 metadata**：都可随时重推导（URL 由配置 / 探测得出、令牌读
  凭据文件），每次创建 / 启动现推导、用完即弃。

注入是增益能力，任何一项推导失败都不抛错、不阻塞沙箱创建（与受限令牌
「缺失不阻断服务启动」同口径）。
"""

from __future__ import annotations

import ipaddress
import logging
import os
import socket
from dataclasses import dataclass, field
from pathlib import Path

from sandbox_platform import ConfigError, PlatformConfig

from .auth import cache_token_file_path, read_token_file
from .server_config import resolve_port

logger = logging.getLogger(__name__)

# 可达地址的显式配置项（服务端 os.environ 惯例读取处：模块内声明常量 + 调用时读）
ENV_SANDBOX_URL = "SANDBOX_CONSOLE_SANDBOX_URL"

# 探测路由源地址时连的探测端点：UDP connect 只查内核路由表，不发任何包，
# 地址与端口仅作路由查找目标（IANA 保留的示例地址段）
_PROBE_ADDRESS = ("192.0.2.1", 9)


@dataclass(frozen=True)
class ImageCacheInjection:
    """递给核心包的镜像缓存注入参数（两值都不进 metadata）。

    ``token`` 不进 ``repr``：日志、异常回溯、调试打印都不会带出令牌本体
    （对齐 ``TokenSource`` 先例）。任一项为 None 表示该项不可得、本次注入
    跳过（核心包对 None / 空值一律不注入）。
    """

    url: str | None = None
    token: str | None = field(default=None, repr=False)


def resolve_image_cache_injection(config: PlatformConfig) -> ImageCacheInjection | None:
    """推导当前应注入的两值（每请求重推导）。

    - 地址：配置项 ``SANDBOX_CONSOLE_SANDBOX_URL`` 优先，未配置走探测兜底；
    - 令牌：每请求读受限令牌凭据文件（缺失 / 损坏跳过令牌项，不抛错）。

    两值皆不可得时返回 ``None``（调用方按「不递参」处理，创建照常成功）。
    """
    url = _resolve_sandbox_url()
    token = _read_cache_token(cache_token_file_path(config))
    if url is None and not token:
        return None
    return ImageCacheInjection(url=url, token=token)


def _read_cache_token(path: Path) -> str | None:
    """读受限令牌凭据文件（**只读**：不生成、不落盘，与中间件同一读径）。"""
    token = read_token_file(path)
    if not token:
        logger.warning(
            "受限令牌凭据文件缺失或不可读，本次注入跳过令牌项（不阻塞沙箱创建，"
            "修复或重写文件后重启沙箱即生效）：%s",
            path,
        )
    return token


def _resolve_sandbox_url() -> str | None:
    """解析沙箱可达的后端地址：配置项优先，未配置走探测兜底。"""
    configured = os.environ.get(ENV_SANDBOX_URL, "").strip()
    if configured:
        logger.debug("镜像缓存注入使用配置的可达地址（%s）：%s", ENV_SANDBOX_URL, configured)
        return configured
    probed = probe_sandbox_url()
    if probed is None:
        logger.warning(
            "无法解析后端可达地址（未配置 %s，且未探测到宿主非回环 IPv4），"
            "本次注入跳过地址项（不阻塞沙箱创建）",
            ENV_SANDBOX_URL,
        )
        return None
    logger.debug("镜像缓存注入使用探测的可达地址：%s", probed)
    return probed


def probe_sandbox_url() -> str | None:
    """自动探测兜底：宿主非回环 IPv4 + 实际监听端口拼 ``http://``。

    监听端口取 ``resolve_port()``（``SANDBOX_CONSOLE_PORT`` / 缺省值）——
    那是 ``main()`` 拉起 HTTP 服务用的同一处配置，即「实际监听端口」。
    配置非法按「端口不可知」处理（返回 None 跳过注入，不把启动期配置错误
    放大成请求失败）。
    """
    ip = probe_host_lan_ipv4()
    if ip is None:
        return None
    try:
        port = resolve_port()
    except ConfigError as exc:
        logger.warning("监听端口配置非法，无法拼可达地址（跳过注入）：%s", exc)
        return None
    return f"http://{ip}:{port}"


def probe_host_lan_ipv4() -> str | None:
    """探测宿主的非回环 IPv4（沙箱容器可达宿主后端的那条路）。

    沙箱容器到宿主后端实测只有宿主局域网地址一条路可达，探测两步兜底：

    1. **路由表源地址**：UDP connect 外部探测端点（内核只查路由表，不发任何
       包），读本地套接字源地址——默认路由出口 IP，通常即宿主局域网地址；
    2. **按主机名解析 IPv4**（过滤回环）——路由表查不到时的降级。

    两步都落空返回 ``None``（调用方按「不可达地址」处理，跳过注入）。
    """
    return _route_source_ipv4() or _hostname_ipv4()


def _route_source_ipv4() -> str | None:
    """默认路由出口 IPv4（UDP connect 不发包，只查路由表）。"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(_PROBE_ADDRESS)
            ip = sock.getsockname()[0]
    except OSError:
        return None
    return ip if _usable_ipv4(ip) else None


def _hostname_ipv4() -> str | None:
    """按主机名解析 IPv4，回环等不可用地址跳过。"""
    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
    except OSError:
        return None
    for info in infos:
        ip = info[4][0]
        if _usable_ipv4(ip):
            return ip
    return None


def _usable_ipv4(ip: str) -> bool:
    """非回环、非未指定的 IPv4 才可用作可达地址。"""
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return (
        address.version == 4
        and not address.is_loopback
        and not address.is_unspecified
    )
