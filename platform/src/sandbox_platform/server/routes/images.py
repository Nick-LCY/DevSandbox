"""宿主本地镜像枚举路由。

创建页的下拉选项来自宿主本地镜像的实时枚举：含用户自己本地构建、
任何仓库都没有的镜像。平台不做远程拉取，也不提供镜像清单缓存。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sandbox_platform import SandboxService

from ..deps import get_service
from ..schemas import HostImageModel

router = APIRouter(prefix="/images", tags=["镜像"])


@router.get("", response_model=list[HostImageModel], summary="枚举宿主本地镜像")
def list_images(
    service: SandboxService = Depends(get_service),
) -> list[HostImageModel]:
    """列出宿主本地镜像，字段为镜像引用 / 镜像 ID / 体积 / 创建时间。

    悬空镜像不进列表；结果按镜像引用排序。
    """
    return [HostImageModel.from_core(image) for image in service.list_host_images()]
