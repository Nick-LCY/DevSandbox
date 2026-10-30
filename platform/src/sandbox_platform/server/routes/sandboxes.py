"""沙箱管理路由。

与一期命令行一一对应：创建 / 列表 / 详情 / 启动 / 停止 / 回收清单 / 删除。
路由只做编排与转译，生命周期逻辑一律调核心包的 ``SandboxService``。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sandbox_platform import SandboxService

from ..deps import get_service
from ..schemas import (
    CreateSandboxRequest,
    CreateSandboxResponse,
    DeleteSandboxResponse,
    ReclaimPlanModel,
    SandboxDetail,
    SandboxSummary,
    StopSandboxRequest,
)

router = APIRouter(prefix="/sandboxes", tags=["沙箱"])


@router.post("", response_model=CreateSandboxResponse, summary="创建沙箱")
def create_sandbox(
    payload: CreateSandboxRequest,
    service: SandboxService = Depends(get_service),
) -> CreateSandboxResponse:
    """创建沙箱（固定 7 步，任一步失败自动回滚）。"""
    result = service.create(payload.to_core_request())
    return CreateSandboxResponse.from_result(result)


@router.get("", response_model=list[SandboxSummary], summary="列出全部沙箱（含停止态）")
def list_sandboxes(
    service: SandboxService = Depends(get_service),
) -> list[SandboxSummary]:
    """列出全部沙箱，字段为名字 / 状态 / 镜像 / 创建时间。"""
    return [SandboxSummary.from_metadata(metadata) for metadata in service.list()]


@router.get("/{name}", response_model=SandboxDetail, summary="沙箱详情")
def get_sandbox(name: str, service: SandboxService = Depends(get_service)) -> SandboxDetail:
    """取单个沙箱的详情。"""
    return SandboxDetail.from_metadata(service.get(name))


@router.post("/{name}/start", response_model=SandboxDetail, summary="启动沙箱")
def start_sandbox(name: str, service: SandboxService = Depends(get_service)) -> SandboxDetail:
    """启动沙箱（复用同一用户、同一子 ID 段、同一守护进程）。"""
    return SandboxDetail.from_metadata(service.start(name))


@router.post("/{name}/stop", response_model=SandboxDetail, summary="停止沙箱")
def stop_sandbox(
    name: str,
    payload: StopSandboxRequest | None = None,
    service: SandboxService = Depends(get_service),
) -> SandboxDetail:
    """停止沙箱（依赖容器是否一并停止由 ``stop_dependencies`` 控制，默认停）。"""
    stop_dependencies = True if payload is None else payload.stop_dependencies
    metadata = service.stop(name, stop_dependencies=stop_dependencies)
    return SandboxDetail.from_metadata(metadata)


@router.get("/{name}/reclaim", response_model=ReclaimPlanModel, summary="删除前的回收清单")
def reclaim_plan(name: str, service: SandboxService = Depends(get_service)) -> ReclaimPlanModel:
    """列出删除沙箱时平台会回收的资源（用户声明挂载的宿主目录不受影响）。"""
    return ReclaimPlanModel.from_plan(service.reclaim_plan(name))


@router.delete("/{name}", response_model=DeleteSandboxResponse, summary="删除沙箱")
def delete_sandbox(
    name: str, service: SandboxService = Depends(get_service)
) -> DeleteSandboxResponse:
    """删除沙箱（按固定回收清单回收，幂等）。"""
    return DeleteSandboxResponse.from_result(service.delete(name))
