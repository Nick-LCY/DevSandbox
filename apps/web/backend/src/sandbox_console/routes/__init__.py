"""HTTP 路由集合：统一挂在 ``/api`` 前缀下。"""

from __future__ import annotations

from fastapi import APIRouter

from .auth import router as auth_router
from .forwards import router as forwards_router
from .health import router as health_router
from .images import router as images_router
from .proxy import router as proxy_router
from .sandboxes import router as sandboxes_router
from .templates import router as templates_router
from .terminal import router as terminal_router

api_router = APIRouter()
api_router.include_router(auth_router)
api_router.include_router(health_router)
api_router.include_router(sandboxes_router)
api_router.include_router(images_router)
api_router.include_router(proxy_router)
api_router.include_router(templates_router)
api_router.include_router(terminal_router)
api_router.include_router(forwards_router)

__all__ = ["api_router"]
