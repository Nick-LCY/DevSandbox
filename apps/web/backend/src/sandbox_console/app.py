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
from .templates import ensure_builtin_templates, prepare_templates_dir
from .terminal import TerminalSessionManager

logger = logging.getLogger(__name__)

API_PREFIX = "/api"

# 服务端包所在目录：apps/web/backend/src/sandbox_console/app.py
#   parents[0] = sandbox_console（包目录）
#   parents[1] = src
#   parents[2] = backend
BACKEND_DIR = Path(__file__).resolve().parents[2]
# 网页控制台前端与后端同在 apps/web/ 下：apps/web/frontend
WEB_DIR = BACKEND_DIR.parent
# 前端构建产物默认位置：apps/web/frontend/dist
FRONTEND_DIST_DIR = WEB_DIR / "frontend" / "dist"

# 前端构建产物目录覆盖（默认 apps/web/frontend/dist）
ENV_CONSOLE_DIST = "SANDBOX_CONSOLE_DIST"
# 接口文档开关：默认关闭（无认证环境不公开接口清单），显式开启才暴露
ENV_CONSOLE_DOCS = "SANDBOX_CONSOLE_DOCS"

TRUTHY_VALUES = ("1", "true", "yes", "on")


def default_console_dist_dir() -> Path:
    """前端构建产物目录的默认位置。

    固定为同工作区里的 ``apps/web/frontend/dist``：前端与后端同在
    ``apps/web/`` 下（后端在 ``backend/``、前端在 ``frontend/``）。
    """
    return FRONTEND_DIST_DIR


def console_dist_dir() -> Path:
    """前端构建产物目录。

    默认取 ``apps/web/frontend/dist``（前端是二期任务 04 的产物，
    二进制安装时用环境变量 ``SANDBOX_CONSOLE_DIST`` 指到实际位置）。
    """
    raw = os.environ.get(ENV_CONSOLE_DIST, "").strip()
    if raw:
        return Path(raw)
    return default_console_dist_dir()


def docs_enabled() -> bool:
    """是否开放运行时接口文档（``/docs`` 与 ``/openapi.json``）。

    默认关闭：服务不做认证，公开接口清单等于给攻击者一份地图。
    需要时用 ``SANDBOX_CONSOLE_DOCS=1`` 显式开启。
    """
    return os.environ.get(ENV_CONSOLE_DOCS, "").strip().lower() in TRUTHY_VALUES


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

    # 模板库目录与内置模板种子：准备失败只记日志，不阻断服务启动
    try:
        prepare_templates_dir(config)
        injected = ensure_builtin_templates(config)
    except Exception as exc:
        # 兜底放宽到 Exception：种子注入的任何意外都不该把服务拖挂
        logger.warning("模板库准备失败（不阻断服务启动）：%s", exc)
        injected = []
    if injected:
        logger.info("已注入内置模板：%s", "、".join(injected))

    # 终端会话管理器整个进程共用一个：伪终端与容器内进程都活在它身上
    service = getattr(app.state, "sandbox_service", None)
    if service is None:
        service = SandboxService(config)
        app.state.sandbox_service = service

    # 清理上次遗留的会话：宿主侧的 exec 进程按会话标识终止，容器内残留的
    # shell 按同一个标识在容器里收掉（杀宿主侧客户端收不掉容器内进程）
    removed = purge_leftover_sessions(
        config, container_killer=_container_session_killer(service)
    )
    logger.info("已清理上次遗留的终端会话记录：%d 条", len(removed))

    manager = TerminalSessionManager(config, service)
    app.state.terminal_manager = manager
    try:
        yield
    finally:
        # 服务重启则会话全部失效：容器内进程一并收掉
        manager.close_all()


def _container_session_killer(service: SandboxService):
    """构造「在容器内按会话标识终止残留进程」的清理回调。"""

    def killer(sandbox_name: str, container_name: str, session_id: str) -> None:
        try:
            daemon = service.daemon_for(sandbox_name)
        except Exception as exc:
            logger.info("沙箱 %s 已不可用，跳过容器内会话清理：%s", sandbox_name, exc)
            return
        daemon.kill_container_session(container_name, session_id)

    return killer


def create_app(config: PlatformConfig | None = None) -> FastAPI:
    """构造应用。

    参数
    ----
    config : 平台配置，缺省按环境变量装配

    生命周期服务不在这里注入：路由通过依赖注入取整个进程共用的实例，
    测试用 ``dependency_overrides`` 替换。
    """
    docs_on = docs_enabled()
    app = FastAPI(
        title="沙箱平台控制台服务",
        version=__version__,
        lifespan=lifespan,
        docs_url="/docs" if docs_on else None,
        redoc_url="/redoc" if docs_on else None,
        openapi_url="/openapi.json" if docs_on else None,
    )
    app.state.platform_config = config or PlatformConfig.from_env()
    install_exception_handlers(app)
    app.include_router(api_router, prefix=API_PREFIX)
    _mount_console(app)
    return app


def _mount_console(app: FastAPI) -> None:
    """挂载前端构建产物；目录不存在时跳过并记日志，不报错。"""
    dist = console_dist_dir()
    if not dist.is_dir():
        app.state.console_mounted = False
        logger.warning(
            "未挂载前端：目录不存在（%s）。请设置 %s 指向前端构建产物目录",
            dist,
            ENV_CONSOLE_DIST,
        )
        return
    app.mount("/", StaticFiles(directory=str(dist), html=True), name="console")
    app.state.console_mounted = True
    logger.info("已挂载前端静态目录：%s", dist)
