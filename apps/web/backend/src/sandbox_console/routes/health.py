"""服务自检路由。"""

from __future__ import annotations

import os

from fastapi import APIRouter, Depends, Request
from sandbox_platform import SandboxService, __version__

from ..deps import get_service
from ..schemas import HealthResponse

router = APIRouter(tags=["服务"])


@router.get("/health", response_model=HealthResponse, summary="服务自检")
def health(request: Request, service: SandboxService = Depends(get_service)) -> HealthResponse:
    """服务是否在跑、版本、数据根是否就绪、前端是否挂载。

    平台数据根的绝对路径不回显（宿主路径属敏感信息），只给「是否就绪」；
    代理是否健康由二期任务 02 的代理状态接口提供，本接口不重复探测宿主。
    """
    home = service.config.home
    data_root_configured = home.is_dir() and os.access(home, os.W_OK)
    console_mounted = bool(getattr(request.app.state, "console_mounted", False))
    return HealthResponse(
        status="ok",
        version=__version__,
        data_root_configured=data_root_configured,
        console_mounted=console_mounted,
    )
