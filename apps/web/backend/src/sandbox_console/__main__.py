"""服务启动入口：``/opt/sandbox-platform/apps/.venv/bin/python -m sandbox_console``。

上面是快照部署的启动方式，与 systemd 单元 ``sandbox-console.service`` 的
``ExecStart`` 逐字一致（直调快照 venv 里的解释器：不依赖 uv、不回落源码
仓库）；开发态可用 ``uv run --project apps/web/backend python -m sandbox_console``。

监听地址默认 ``127.0.0.1:8000``，可用环境变量 ``SANDBOX_CONSOLE_HOST`` /
``SANDBOX_CONSOLE_PORT`` 覆盖。服务以宿主特权身份运行：进程本身是 root 时
直接执行，否则走核心包的免密提权前缀（见 ``Privilege``），与一期命令行的
权限要求一致。

全部 ``/api``（含终端 WebSocket）受访问令牌保护：令牌由环境变量
``SANDBOX_CONSOLE_TOKEN`` 注入，或由服务在平台数据根生成
（``console-token.json``，权限 0600）。启动日志只打令牌来源与路径，不打令牌本体。
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
