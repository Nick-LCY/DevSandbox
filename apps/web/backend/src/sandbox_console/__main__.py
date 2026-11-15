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

本服务只提供 ``/api``；网页控制台由 Cloudflare Workers 独立托管。
"""

from __future__ import annotations

import logging

import uvicorn
from sandbox_platform import ConfigError

from .app import create_app
from .server_config import resolve_host, resolve_port, warn_if_not_loopback

logger = logging.getLogger(__name__)

# 监听配置（地址 / 端口 / 回环判定与告警）住在 ``server_config.py``：注入管线
# 需要在请求路径上重推导「实际监听端口」，而入口模块被包内导入会成环
# （``__main__`` → ``app`` → 路由 → 注入 → ``__main__``），这里只导入使用。


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
