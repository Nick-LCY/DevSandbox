"""依赖注入：把核心包的平台配置与生命周期服务交给路由。

服务层不自己 new 核心对象：应用工厂把配置装到 ``app.state``，这里按需取出；
测试可以整体替换依赖，不必触碰宿主。
"""

from __future__ import annotations

from fastapi import Request, WebSocket
from sandbox_platform import (
    FileTransferManager,
    PlatformConfig,
    PortForwardManager,
    SandboxService,
)

from .auth import TicketStore
from .forwards import TunnelRegistry
from .templates import TemplateStore
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


def get_transfer_manager(request: Request) -> FileTransferManager:
    """取应用级的运行期文件传输编排入口（整个进程共用一个实例）。

    **不另建实例**：传输编排入口由生命周期服务持有（能力本体在核心包
    ``sandbox_platform.transfer``），服务端只取引用。测试用
    ``dependency_overrides`` 替换。
    """
    manager = getattr(request.app.state, "transfer_manager", None)
    if manager is None:
        service = get_service(request)
        manager = FileTransferManager(service=service)
        request.app.state.transfer_manager = manager
    return manager


def get_template_store(request: Request) -> TemplateStore:
    """取应用级模板库（整个进程共用一个实例）。"""
    store = getattr(request.app.state, "template_store", None)
    if store is None:
        store = TemplateStore(get_config(request))
        request.app.state.template_store = store
    return store


def get_terminal_manager(request: Request) -> TerminalSessionManager:
    """取应用级终端会话管理器（整个进程共用一个实例）。"""
    return _terminal_manager_of(request.app)


def get_ticket_store(request: Request) -> TicketStore:
    """取应用级票据存储（整个进程共用一个实例）。"""
    return _ticket_store_of(request.app)


def get_ticket_store_ws(websocket: WebSocket) -> TicketStore:
    """取应用级票据存储（WebSocket 入口用）。

    WebSocket 路由拿不到 HTTP 请求对象，只能从连接自己身上取应用状态。
    """
    return _ticket_store_of(websocket.app)


def get_forward_manager(request: Request) -> PortForwardManager:
    """取应用级端口转发编排入口（整个进程共用一个实例）。"""
    return _forward_manager_of(request.app)


def get_forward_manager_ws(websocket: WebSocket) -> PortForwardManager:
    """取应用级端口转发编排入口（WebSocket 入口用）。"""
    return _forward_manager_of(websocket.app)


def get_tunnel_registry_ws(websocket: WebSocket) -> TunnelRegistry:
    """取应用级活动隧道登记表（WebSocket 入口用）。

    只有隧道 WS 需要它（WS 路由拿不到 HTTP 请求对象，只能从连接自己身上
    取应用状态）——**不提供 Request 版**：REST 侧用不到活动隧道登记表。
    """
    return _tunnel_registry_of(websocket.app)


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


def _ticket_store_of(app) -> TicketStore:
    """按应用装配票据存储（没有就建一个并挂到应用状态上）。"""
    store = getattr(app.state, "ticket_store", None)
    if store is None:
        store = TicketStore()
        app.state.ticket_store = store
    return store


def _forward_manager_of(app) -> PortForwardManager:
    """按应用装配端口转发编排入口。

    **不另建实例**：转发编排入口由生命周期服务持有（它要在删沙箱时一并回收
    转发容器与记录），服务端只取引用。测试用 ``dependency_overrides`` 替换。
    """
    manager = getattr(app.state, "forward_manager", None)
    if manager is None:
        service = getattr(app.state, "sandbox_service", None)
        if service is None:
            config = getattr(app.state, "platform_config", None)
            if config is None:
                config = PlatformConfig.from_env()
                app.state.platform_config = config
            service = SandboxService(config)
            app.state.sandbox_service = service
        manager = service.forwards
        app.state.forward_manager = manager
    return manager


def _tunnel_registry_of(app) -> TunnelRegistry:
    """按应用装配活动隧道登记表（没有就建一个并挂到应用状态上）。"""
    registry = getattr(app.state, "tunnel_registry", None)
    if registry is None:
        registry = TunnelRegistry()
        app.state.tunnel_registry = registry
    return registry
