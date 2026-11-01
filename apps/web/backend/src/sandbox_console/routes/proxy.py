"""镜像代理状态与重启路由。

设置页展示代理的运行状态、健康状态、缓存占用与证书就绪状态，并支持重启。
平台**不提供**任何清理代理缓存的入口：缓存只增不减，页面只展示占用大小。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sandbox_platform import SandboxService

from ..deps import get_service
from ..schemas import ProxyRestartModel, ProxyStatusModel

router = APIRouter(prefix="/proxy", tags=["镜像代理"])


@router.get("/status", response_model=ProxyStatusModel, summary="镜像代理状态")
def proxy_status(
    service: SandboxService = Depends(get_service),
) -> ProxyStatusModel:
    """代理状态：容器运行状态、健康状态、缓存占用、证书就绪、访问地址。

    代理不可达不是接口错误：状态接口如实回报「不健康」与明细。
    """
    return ProxyStatusModel.from_core(service.proxy_status())


@router.post("/restart", response_model=ProxyRestartModel, summary="重启镜像代理")
def restart_proxy(
    service: SandboxService = Depends(get_service),
) -> ProxyRestartModel:
    """重启代理容器并轮询到健康；代理不可达时直接失败，**不降级直连**。

    重启后比对代理 CA 指纹：指纹变了会自动为已有沙箱用户重装合并 CA 束，
    并在响应里回传 ``ca_changed``。重启未成功时接口仍返回 200，
    由 ``restarted`` 字段说明结果（原因看服务日志，不回显宿主路径）。
    """
    result = service.restart_proxy()
    return ProxyRestartModel.from_core(service.proxy_status(), result)
