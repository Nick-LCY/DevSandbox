"""镜像代理状态、重启与缓存清单路由。

设置页展示代理的运行状态、健康状态、缓存占用与证书就绪状态，并支持重启。
平台**不提供**任何清理代理缓存的入口：缓存只增不减，页面只展示占用大小。

缓存清单（``GET /cache/images``）是唯一对外出口：console 设置抽屉用 json 格式，
沙箱内 ``cached-images`` 命令用 text 预渲染格式（基础镜像只有 curl 没有 jq，
禁止让 bash 解析 JSON）。鉴权双凭据：完整令牌照旧，受限令牌仅这一条 GET 放行。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Response
from sandbox_platform import CacheScanError, SandboxService

from ..cache_images import CacheImagesCache, render_cache_images_text
from ..deps import get_cache_images_cache, get_service
from ..errors import STATUS_SERVICE_UNAVAILABLE, STATUS_UNPROCESSABLE
from ..schemas import ProxyRestartModel, ProxyStatusModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/proxy", tags=["镜像代理"])

# 503 固定文案：特权读失败或超时的原文（宿主路径、特权命令行）只进日志
CACHE_SCAN_FAILED_DETAIL = "镜像缓存清单不可用（缓存扫描失败或超时），请稍后重试"
# 422 固定文案：format 非法值
CACHE_FORMAT_INVALID_DETAIL = "format 取值非法（只支持 json 或 text）"


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


@router.get("/cache/images", summary="镜像缓存清单")
def cache_images(
    format: str = "json",
    cache: CacheImagesCache = Depends(get_cache_images_cache),
) -> Response:
    """已完整缓存的镜像清单（``?format=json|text``，缺省 json）。

    - **json**：生成时间戳 + 清单数组（仓库 / 标签列表 / 摘要 / 总大小 /
      缓存时间），``Content-Type: application/json``；
    - **text**：预渲染文本（``text/plain``）——表头 + 逐行条目 + 生成时间，
      bash（``cached-images``）直接输出可读；
    - 两种格式共享同一份扫描结果（同一生成时间戳），TTL 内存缓存钉 60 秒；
    - ``format`` 非法值 → 422；特权读失败或超时 → **503 + 固定文案**，
      **绝不静默回空清单**（空清单会误导「没有缓存」）。

    鉴权：完整令牌照旧；受限令牌仅本端点 GET 放行（中间件双凭据限界）。
    """
    # format 非法值必须 422：不能用 Literal / pattern 让框架校验——请求体
    # 校验处理器把缺字段以外的校验失败统一映射成 400，这里手动判定钉 422。
    if format not in ("json", "text"):
        raise HTTPException(
            status_code=STATUS_UNPROCESSABLE,
            detail=CACHE_FORMAT_INVALID_DETAIL,
        )
    try:
        result = cache.get()
    except CacheScanError as exc:
        # 异常原文（宿主路径、特权命令输出）只进日志；响应只给固定文案。
        logger.error("镜像缓存清单扫描失败[cache-scan]：%s", exc, exc_info=exc)
        raise HTTPException(
            status_code=STATUS_SERVICE_UNAVAILABLE,
            detail=CACHE_SCAN_FAILED_DETAIL,
        ) from exc
    if format == "text":
        return Response(content=render_cache_images_text(result), media_type="text/plain")
    return result.to_payload()
