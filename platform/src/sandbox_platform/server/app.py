"""应用工厂：装配路由、错误映射、前端静态目录与生命周期钩子。"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from sandbox_platform import ConfigError, PlatformConfig, SandboxService, __version__

from .errors import install_exception_handlers
from .routes import api_router
from .sessions import prepare_sessions_dir, purge_leftover_sessions

logger = logging.getLogger(__name__)

API_PREFIX = "/api"

# 前端构建产物目录覆盖（默认 <项目目录>/console/dist）
ENV_CONSOLE_DIST = "SANDBOX_CONSOLE_DIST"


def console_dist_dir() -> Path:
    """前端构建产物目录。

    默认取项目目录下的 ``console/dist``（前端是二期任务 04 的产物，
    二进制安装时用环境变量 ``SANDBOX_CONSOLE_DIST`` 指到实际位置）。
    """
    raw = os.environ.get(ENV_CONSOLE_DIST, "").strip()
    if raw:
        return Path(raw)
    return Path(__file__).resolve().parents[3] / "console" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """服务生命周期钩子：准备数据目录，清理上次遗留的终端会话记录。"""
    config: PlatformConfig = app.state.platform_config
    try:
        config.ensure_directories()
    except OSError as exc:
        raise ConfigError(
            f"平台数据目录不可写：{config.home}（{exc}）。"
            "请以 root 运行控制面，或用 SANDBOX_PLATFORM_HOME 指向可写目录"
        ) from exc
    logger.info("平台数据目录已就绪：%s", config.home)

    prepare_sessions_dir(config)
    removed = purge_leftover_sessions(config)
    logger.info("已清理上次遗留的终端会话记录：%d 条", len(removed))
    yield


def create_app(
    config: PlatformConfig | None = None,
    service: SandboxService | None = None,
) -> FastAPI:
    """构造应用。

    参数
    ----
    config : 平台配置，缺省按环境变量装配
    service : 生命周期服务，缺省首次请求时创建（整个进程共用一个实例）
    """
    app = FastAPI(
        title="沙箱平台控制台服务",
        version=__version__,
        lifespan=lifespan,
    )
    app.state.platform_config = config or PlatformConfig.from_env()
    if service is not None:
        app.state.sandbox_service = service
    install_exception_handlers(app)
    app.include_router(api_router, prefix=API_PREFIX)
    _mount_console(app)
    return app


def _mount_console(app: FastAPI) -> None:
    """挂载前端构建产物；目录不存在时跳过并记日志，不报错。"""
    dist = console_dist_dir()
    if not dist.is_dir():
        logger.info("前端构建产物目录不存在，跳过静态托管：%s", dist)
        return
    app.mount("/", StaticFiles(directory=str(dist), html=True), name="console")
    logger.info("已挂载前端静态目录：%s", dist)
