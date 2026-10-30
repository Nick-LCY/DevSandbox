"""服务自检路由。"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sandbox_platform import SandboxService, __version__

from ..deps import get_service
from ..schemas import HealthResponse

router = APIRouter(tags=["服务"])


@router.get("/health", response_model=HealthResponse, summary="服务自检")
def health(service: SandboxService = Depends(get_service)) -> HealthResponse:
    """服务是否在跑、版本、平台数据根。

    代理是否健康由二期任务 02 的代理状态接口提供，本接口不重复探测宿主。
    """
    return HealthResponse(
        status="ok",
        version=__version__,
        platform_home=str(service.config.home),
    )
