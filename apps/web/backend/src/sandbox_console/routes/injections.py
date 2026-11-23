"""注入副本刷新路由：按**已保存的条目标识**刷新一条注入的托管副本。

**入参只有条目标识**：宿主源路径 / 托管副本路径 / 容器目标路径**一律不接受**
——路径一律由服务端从该沙箱的**实例元数据**里查得（不查模板、不接受调用方
给路径），因此本接口**不构成越权写入**。

**四条硬口径**：

1. **拒绝查询参数**：带任何查询参数一律 400（杜绝「借 query 夹带路径」）。
2. **拒绝非空请求体**：请求体**流式**读，**首个非空块即拒**（不无界读 body：
   整个 body 缓冲进内存是上传通道踩过的坑，这里不重复）。
3. **阻塞动作不进事件循环**：刷新要跑特权 helper（可能分钟级），走**既有线程池**
   （``run_in_threadpool``，与端口转发轮同一模式）——async 路由里**绝不**直接调。
4. **成功 204 无内容**：只回状态码，不回正文、不回路径清单、不回文件内容。

**能力本体在核心包**（``sandbox_platform.refresh`` 与
``SandboxService.refresh_injection``）：条目定位、源重校验、helper 调用、失败
分类都在核心包里，本模块只做**入参闸门 + 编排 + 转译**。

**失败语义**（按核心包的失败分类码映射状态码，见 ``errors.py`` 的刷新映射表）：
预校验类 400（**副本零改动**）、条目不存在 404、并发冲突 409、写入阶段类 500
（**可能部分更新**）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sandbox_platform import SandboxService
from starlette.concurrency import run_in_threadpool

from ..deps import get_service

router = APIRouter(tags=["注入副本刷新"])

#: 刷新端点路径（挂在 ``/api`` 前缀下 ⇒ **自动受 Bearer 令牌中间件保护**）
REFRESH_PATH = "/sandboxes/{name}/injections/{entry_id}/refresh"

#: 带查询参数时的固定提示（400）
QUERY_REJECTED_DETAIL = "刷新接口不接受查询参数：只按条目标识定位，路径一律由服务端查得"
#: 请求体非空时的固定提示（400）
BODY_REJECTED_DETAIL = "刷新接口不接受请求体：只按条目标识定位，路径一律由服务端查得"


@router.post(
    REFRESH_PATH,
    status_code=204,
    summary="刷新一条注入的托管副本（运行中沙箱，不停机）",
)
async def refresh_sandbox_injection(
    name: str,
    entry_id: str,
    request: Request,
    service: SandboxService = Depends(get_service),
) -> Response:
    """刷新某一条注入的托管副本。

    - **只按条目标识定位**（``entry_id``）：源 / 副本 / 容器目标一律从**实例
      元数据**查得；宿主源路径、托管副本路径、容器目标路径**一律不接受**；
    - **旧实例没有条目** ⇒ 无可刷对象（404，不迁移、不补录、不反查模板）；
    - **互斥**：与该沙箱的启动 / 停止 / 删除互斥，冲突**立即被拒**（409，不排队）；
    - **不停机**：不重建容器、不重挂载，终端与 agent 会话不受影响。

    成功 **204 无内容**；失败按核心包的**失败分类码**映射状态码。
    """
    _reject_query_params(request)
    await _reject_non_empty_body(request)
    # 阻塞刷新（特权 helper，可能分钟级）走线程池：**绝不占着事件循环**。
    await run_in_threadpool(service.refresh_injection, name, entry_id)
    return Response(status_code=204)


# ---------------------------------------------------------------- 入参闸门
def _reject_query_params(request: Request) -> None:
    """带**任何**查询参数一律 400。

    查询参数是「夹带路径」的口子（``?source_path=…`` / ``?container_path=…``）：
    一律拒绝，不静默忽略——静默忽略会让调用方以为路径生效了。
    """
    if request.query_params:
        raise HTTPException(status_code=400, detail=QUERY_REJECTED_DETAIL)


async def _reject_non_empty_body(request: Request) -> None:
    """请求体**非空**一律 400。

    **流式**读，**首个非空块即拒**：不把整个 body 缓冲进内存（上传通道踩过
    「200 MiB body 让进程 RSS 涨十倍」的坑），也不无界读。
    """
    async for chunk in request.stream():
        if chunk:
            raise HTTPException(status_code=400, detail=BODY_REJECTED_DETAIL)
