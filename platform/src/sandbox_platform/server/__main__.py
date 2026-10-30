"""服务启动入口：``uv run python -m sandbox_platform.server``。

监听地址默认 ``127.0.0.1:8000``，可用环境变量 ``SANDBOX_CONSOLE_HOST`` /
``SANDBOX_CONSOLE_PORT`` 覆盖。服务以宿主特权身份运行：进程本身是 root 时
直接执行，否则走核心包的免密提权前缀（见 ``Privilege``），与一期命令行的
权限要求一致。
"""

from __future__ import annotations

import logging
import os

import uvicorn
from sandbox_platform import ConfigError

from .app import create_app

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

    服务不做认证也不做多用户隔离，暴露到公网等于把宿主特权接口敞开；
    认证不在本期范围，这是最低成本的止损手段。
    """
    if is_loopback(host):
        return
    logger.warning(
        "监听地址不是回环地址（%s）：本服务不做认证也不做多用户隔离，"
        "只能在可信内网使用，严禁暴露到公网",
        host,
    )


def main() -> int:
    """启动 HTTP 服务。"""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s：%(message)s",
    )
    try:
        host = resolve_host()
        port = resolve_port()
    except ConfigError as exc:
        logger.error("启动失败：%s", exc)
        return 2
    warn_if_not_loopback(host)
    logger.info("控制台服务启动：监听 %s:%s", host, port)
    uvicorn.run(create_app(), host=host, port=port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
