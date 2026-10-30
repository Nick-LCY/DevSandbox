"""HTTP 路由集合：统一挂在 ``/api`` 前缀下。"""

from __future__ import annotations

from fastapi import APIRouter

from .health import router as health_router
from .images import router as images_router
from .proxy import router as proxy_router
from .sandboxes import router as sandboxes_router

api_router = APIRouter()
api_router.include_router(health_router)
api_router.include_router(sandboxes_router)
api_router.include_router(images_router)
api_router.include_router(proxy_router)

__all__ = ["api_router"]
