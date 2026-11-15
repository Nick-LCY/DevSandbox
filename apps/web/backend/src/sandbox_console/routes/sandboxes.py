"""沙箱管理路由。

与一期命令行一一对应：创建 / 列表 / 详情 / 启动 / 停止 / 回收清单 / 删除。
路由只做编排与转译，生命周期逻辑一律调核心包的 ``SandboxService``。
"""

from __future__ import annotations

from dataclasses import replace

from fastapi import APIRouter, Depends
from sandbox_platform import CreateRequest, SandboxService

from ..deps import get_image_cache_injection, get_service
from ..injection import ImageCacheInjection
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


def _with_image_cache_injection(
    request: CreateRequest, injection: ImageCacheInjection | None
) -> CreateRequest:
    """把镜像缓存注入两值挂到核心包创建入参的可选字段上。

    模板注入先例的同款递参位置：服务端读自己的状态（地址由配置 / 探测得出、
    令牌读自己的凭据文件）、以参数递核心包执行，核心包不知业务存在。两值
    都可随时重推导，故**不进 metadata**——核心包按可选参数平台强制注入，
    ``metadata.env`` 只装用户声明值。两值皆不可得（``injection`` 为 None）
    时不递参，创建照常成功（与命令行路径同归缺 env 边角）。
    """
    if injection is None:
        return request
    return replace(
        request,
        image_cache_url=injection.url,
        image_cache_token=injection.token,
    )


@router.post(
    "",
    response_model=CreateSandboxResponse,
    status_code=201,
    summary="创建沙箱",
)
def create_sandbox(
    payload: CreateSandboxRequest,
    service: SandboxService = Depends(get_service),
    injection: ImageCacheInjection | None = Depends(get_image_cache_injection),
) -> CreateSandboxResponse:
    """创建沙箱（固定 7 步，任一步失败自动回滚）。

    镜像缓存注入两值（可达地址 + 受限令牌）随创建入参递给核心包：两值皆
    不可得时不递参、创建照常成功；任一项不可得只跳过那一项。
    """
    result = service.create(
        _with_image_cache_injection(payload.to_core_request(), injection)
    )
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
def start_sandbox(
    name: str,
    service: SandboxService = Depends(get_service),
    injection: ImageCacheInjection | None = Depends(get_image_cache_injection),
) -> SandboxDetail:
    """启动沙箱（复用同一用户、同一子 ID 段、同一守护进程）。

    启动（重启）路径同样递参：两值都可随时重推导，不进 metadata——缺 env
    的既有沙箱重启一次即补上注入（自愈口径），令牌轮换后重启一次即换新值。
    """
    metadata = service.start(
        name,
        image_cache_url=injection.url if injection else None,
        image_cache_token=injection.token if injection else None,
    )
    return SandboxDetail.from_metadata(metadata)


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
    """列出删除沙箱时平台会回收的资源（用户声明挂载的宿主目录不受影响）。

    沙箱不存在直接 404：回收清单只对真实存在的沙箱有意义。
    """
    service.get(name)
    return ReclaimPlanModel.from_plan(service.reclaim_plan(name))


@router.delete("/{name}", response_model=DeleteSandboxResponse, summary="删除沙箱")
def delete_sandbox(
    name: str, service: SandboxService = Depends(get_service)
) -> DeleteSandboxResponse:
    """删除沙箱（按固定回收清单回收，幂等）。"""
    return DeleteSandboxResponse.from_result(service.delete(name))
