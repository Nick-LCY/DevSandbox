"""服务监听配置：地址、端口与回环判定（环境变量惯例读取处）。

从 ``__main__.py`` 拆出来的原因：注入管线（镜像缓存清单轮任务 03）需要在
**请求路径**上重推导「实际监听端口」来拼沙箱可达地址，而入口模块在包内互相
导入会成环（``__main__`` → ``app`` → 路由 → 注入 → ``__main__``）。监听配置
本来就该住在普通模块里，入口薄壳只负责拉起服务。

所有取值都在**调用时**读环境变量（不缓存模块级状态）：测试改环境变量立即
生效，服务重启前统一在 ``main()`` 里解析一次。

- 监听地址默认 ``127.0.0.1``，用环境变量 ``SANDBOX_CONSOLE_HOST`` 覆盖；
- 监听端口默认 ``8000``，用环境变量 ``SANDBOX_CONSOLE_PORT`` 覆盖；
- 端口取值非法或超范围抛 :class:`ConfigError`（启动路径直接失败；请求路径
  的调用方按「端口不可知」处理，不把启动期配置错误放大成请求失败）。
"""

from __future__ import annotations

import logging
import os

from sandbox_platform import ConfigError

logger = logging.getLogger(__name__)

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
ENV_HOST = "SANDBOX_CONSOLE_HOST"
ENV_PORT = "SANDBOX_CONSOLE_PORT"
MIN_PORT = 1
MAX_PORT = 65535

LOOPBACK_HOSTS = ("localhost", "::1")


def resolve_host() -> str:
    """监听地址（默认只绑回环）。"""
    return os.environ.get(ENV_HOST, "").strip() or DEFAULT_HOST


def resolve_port() -> int:
    """监听端口。"""
    raw = os.environ.get(ENV_PORT, "").strip()
    if not raw:
        return DEFAULT_PORT
    try:
        port = int(raw)
    except ValueError as exc:
        raise ConfigError(f"环境变量 {ENV_PORT} 取值非法：{raw!r}，应为整数") from exc
    if not MIN_PORT <= port <= MAX_PORT:
        raise ConfigError(
            f"环境变量 {ENV_PORT} 取值非法：{port}（应为 {MIN_PORT}~{MAX_PORT}）"
        )
    return port


def is_loopback(host: str) -> bool:
    """监听地址是否回环地址。"""
    if host in LOOPBACK_HOSTS:
        return True
    return host.startswith("127.")


def warn_if_not_loopback(host: str) -> None:
    """非回环地址时打醒目告警。

    认证已经是硬门槛（全部 ``/api`` 受令牌保护，含终端 WebSocket），
    但令牌是**单一凭据**：拿到令牌即拿到平台的全部能力，不做账号隔离、
    不做分级与吊销。网络边界是第二层防线，不是第一层。
    """
    if is_loopback(host):
        return
    logger.warning(
        "监听地址不是回环地址（%s）：本服务已启用令牌认证（全部 /api 受令牌保护），"
        "但令牌是单一凭据，拿到它即拥有平台的全部能力；"
        "仍不得暴露到公网，且务必把令牌文件（0600）交给可信的人",
        host,
    )
