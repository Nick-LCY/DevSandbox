"""服务启动入口：``uv run python -m sandbox_platform.server``。

监听地址默认 ``127.0.0.1:8000``，可用环境变量 ``SANDBOX_CONSOLE_HOST`` /
``SANDBOX_CONSOLE_PORT`` 覆盖。服务以宿主特权身份运行：进程本身是 root 时
直接执行，否则走免密 ``sudo``，与一期命令行的权限要求一致。
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


def main() -> int:
    """启动 HTTP 服务。"""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s：%(message)s",
    )
    host = resolve_host()
    port = resolve_port()
    logger.info("控制台服务启动：监听 %s:%s", host, port)
    uvicorn.run(create_app(), host=host, port=port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
