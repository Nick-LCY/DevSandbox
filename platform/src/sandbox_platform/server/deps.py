"""依赖注入：把核心包的平台配置与生命周期服务交给路由。

服务层不自己 new 核心对象：应用工厂把配置装到 ``app.state``，这里按需取出；
测试可以整体替换依赖，不必触碰宿主。
"""

from __future__ import annotations

from fastapi import Request, WebSocket
from sandbox_platform import PlatformConfig, SandboxService

from .terminal import TerminalSessionManager


def get_config(request: Request) -> PlatformConfig:
    """取应用级平台配置（缺省时按环境变量装配）。"""
    config = getattr(request.app.state, "platform_config", None)
    if config is None:
        config = PlatformConfig.from_env()
        request.app.state.platform_config = config
    return config


def get_service(request: Request) -> SandboxService:
    """取应用级生命周期服务（整个进程共用一个实例）。"""
    service = getattr(request.app.state, "sandbox_service", None)
    if service is None:
        service = SandboxService(get_config(request))
        request.app.state.sandbox_service = service
    return service


def get_terminal_manager(request: Request) -> TerminalSessionManager:
    """取应用级终端会话管理器（整个进程共用一个实例）。"""
    return _terminal_manager_of(request.app)


def get_terminal_manager_ws(websocket: WebSocket) -> TerminalSessionManager:
    """取应用级终端会话管理器（WebSocket 入口用）。

    WebSocket 路由拿不到 HTTP 请求对象，只能从连接自己身上取应用状态。
    """
    return _terminal_manager_of(websocket.app)


def _terminal_manager_of(app) -> TerminalSessionManager:
    """按应用装配终端会话管理器（没有就建一个并挂到应用状态上）。"""
    manager = getattr(app.state, "terminal_manager", None)
    if manager is None:
        config = getattr(app.state, "platform_config", None)
        if config is None:
            config = PlatformConfig.from_env()
            app.state.platform_config = config
        service = getattr(app.state, "sandbox_service", None)
        if service is None:
            service = SandboxService(config)
            app.state.sandbox_service = service
        manager = TerminalSessionManager(config, service)
        app.state.terminal_manager = manager
    return manager
