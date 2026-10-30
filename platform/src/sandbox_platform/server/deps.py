"""依赖注入：把核心包的平台配置与生命周期服务交给路由。

服务层不自己 new 核心对象：应用工厂把配置装到 ``app.state``，这里按需取出；
测试可以整体替换依赖，不必触碰宿主。
"""

from __future__ import annotations

from fastapi import Request
from sandbox_platform import PlatformConfig, SandboxService


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
