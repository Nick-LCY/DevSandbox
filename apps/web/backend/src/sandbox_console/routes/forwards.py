"""端口转发路由：转发管理 REST（列表 / 建立 / 停止）+ 隧道 WebSocket。

两条路由族：

- **转发管理 REST**（``/api/forwards``）：建转发、列转发、停转发。能力本体在
  核心包（``sandbox_platform.forwarding``），这里只做入参校验、编排调用与
  结果转译。
- **隧道 WebSocket**（``/api/forward/tunnel/{forward_id}``）：用户机与沙箱之间
  的字节通道。**一条 WebSocket 对一条 TCP 连接**（本期不做多路复用）。
  服务端在沙箱守护进程下起一个 **exec 字节泵**，把它的 stdin/stdout 与本连接
  做双向搬运；连接断开即回收该字节泵进程（不留僵尸进程）。

**后端宿主零端口**：服务端不监听任何转发用端口，也不连宿主回环端口——
字节通道只有字节泵这一条。
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Depends, WebSocket
from fastapi.responses import JSONResponse
from sandbox_platform import (
    BytePump,
    ForwardRecord,
    ImageNotFoundError,
    NotFoundError,
    PortForwardManager,
    SandboxError,
    ValidationError,
    validate_forward_id,
)
from starlette.concurrency import run_in_threadpool
from starlette.websockets import WebSocketDisconnect, WebSocketDisconnected

from ..auth import CLOSE_CODE_UNAUTHORIZED, bearer_authorized
from ..deps import (
    get_forward_manager,
    get_forward_manager_ws,
    get_tunnel_registry_ws,
)
from ..errors import classify_forward_error, forward_tunnel_error_detail
from ..forwards import (
    PUMP_FAILED_MESSAGE,
    READ_CHUNK,
    TUNNEL_CLOSE_NORMAL,
    TUNNEL_CLOSE_POLICY,
    TUNNEL_CLOSE_PUMP_ERROR,
    TunnelHandle,
    TunnelRegistry,
    pump_failure_reason,
    pump_read,
    pump_write,
)
from ..schemas import ForwardCreateRequest, ForwardDeleteResponse, ForwardModel

logger = logging.getLogger(__name__)

router = APIRouter(tags=["端口转发"])

# 转发不存在（或标识非法）时的固定文案：不回显用户输入的标识
FORWARD_NOT_FOUND_DETAIL = "端口转发不存在或已失效"

# 帧类型（文本控制帧）
FRAME_HELLO = "hello"
FRAME_ERROR = "error"


# ---------------------------------------------------------------- 转发管理 REST
@router.get(
    "/forwards",
    response_model=list[ForwardModel],
    summary="列出端口转发",
)
def list_forwards(
    sandbox: str | None = None,
    manager: PortForwardManager = Depends(get_forward_manager),
) -> list[ForwardModel]:
    """列出发起中的转发（**裸数组**）；给了沙箱名则只列该沙箱的。"""
    return [ForwardModel.from_record(record) for record in manager.list(sandbox)]


@router.post(
    "/forwards",
    response_model=ForwardModel,
    status_code=201,
    summary="建立端口转发",
)
async def create_forward(
    payload: ForwardCreateRequest,
    manager: PortForwardManager = Depends(get_forward_manager),
) -> ForwardModel | JSONResponse:
    """建立转发：转发容器 + 转发记录。

    **幂等**：同一沙箱同一容器端口已有转发时复用既有转发（不重复起容器）。
    沙箱不存在 → 404；端口非法 → 400；沙箱已停止 / 容器名冲突 → 409；
    镜像拉不到 → 503（转发链路暂不可用，不是入参错误）。
    """
    try:
        record = await run_in_threadpool(manager.create, payload.sandbox, payload.port)
    except ImageNotFoundError as exc:
        # 转发链路的镜像拉不到：语义是「转发服务暂不可用」（503），
        # 不是请求参数错误（400 只留给真正的入参非法）。
        # 响应只给固定文案，核心异常原文（拉取失败详情）只进日志。
        status_code, detail = classify_forward_error(exc)
        logger.error(
            "建立端口转发（沙箱 %s）失败[forward-image]：%s",
            payload.sandbox,
            exc,
            exc_info=exc,
        )
        return JSONResponse(status_code=status_code, content={"detail": detail})
    return ForwardModel.from_record(record)


@router.delete(
    "/forwards/{forward_id}",
    response_model=ForwardDeleteResponse,
    summary="停止端口转发",
)
async def delete_forward(
    forward_id: str,
    manager: PortForwardManager = Depends(get_forward_manager),
) -> ForwardDeleteResponse:
    """停止转发：删转发容器 + 删记录（**没有「释放端口」动作**：宿主侧无端口）。

    转发不存在（或标识非法）→ 404（不回显用户输入的标识）。
    转发记录损坏 → 404 + 固定文案（**不回显宿主绝对路径**）。
    """
    if not _is_valid_forward_id(forward_id):
        raise NotFoundError(FORWARD_NOT_FOUND_DETAIL)
    try:
        result = await run_in_threadpool(manager.stop, forward_id)
    except NotFoundError as exc:
        # 不回显用户输入的标识（统一成一句固定文案）
        logger.info("停止端口转发 %s 失败：%s", forward_id, exc)
        raise NotFoundError(FORWARD_NOT_FOUND_DETAIL) from exc
    except ValidationError as exc:
        # 记录损坏：全局 ValidationError 处理会把宿主绝对路径回显（400 + 路径），
        # 这里收敛成固定文案，不回显路径。
        logger.info("停止端口转发 %s 失败（记录损坏）：%s", forward_id, exc)
        raise NotFoundError(FORWARD_NOT_FOUND_DETAIL) from exc
    return ForwardDeleteResponse(
        id=forward_id,
        removed=list(result.removed),
        failed=list(result.failed),
    )


# ---------------------------------------------------------------- 隧道 WebSocket
@router.websocket("/forward/tunnel/{forward_id}")
async def open_forward_tunnel(
    websocket: WebSocket,
    forward_id: str,
    manager: PortForwardManager = Depends(get_forward_manager_ws),
    registry: TunnelRegistry = Depends(get_tunnel_registry_ws),
) -> None:
    """隧道：把转发上的字节接到本连接（一条 WS 对一条 TCP 连接）。

    握手准入走 **Bearer 令牌**（桌面端 Rust 客户端能设请求头，不必绕票据）：
    中间件已校验过一道，这里再核一次（纵深防御），不通过就拒握手（1008）。

    转发不存在 → 错误帧 + 关闭码 1008；转发已停止（沙箱停过）→ 错误帧 +
    关闭码 1008。**沙箱重启过的不算「已停止」**：核心包会在隧道建立时幂等
    重建转发容器，隧道照常可用。

    任一侧 EOF / 断开 → 收泵（回收字节泵进程）+ 关掉另一侧。
    字节泵异常结束（exec 失败，失败原因只在 stderr 里）→ **原因帧** + 1011
    （原文只进日志）。
    """
    if not bearer_authorized(websocket.headers, websocket.app):
        await websocket.close(code=CLOSE_CODE_UNAUTHORIZED)
        return
    await websocket.accept()

    try:
        record = await _load_forward(manager, forward_id)
    except SandboxError as exc:
        # 记录损坏（校验异常）等：收敛成错误帧 + 1008（不回显宿主路径）
        logger.info("转发 %s 的记录读不出来：%s", forward_id, exc)
        await _send_control(
            websocket, {"type": FRAME_ERROR, "message": forward_tunnel_error_detail(exc)}
        )
        await websocket.close(code=TUNNEL_CLOSE_POLICY)
        return
    if record is None:
        await _send_control(websocket, {"type": FRAME_ERROR, "message": FORWARD_NOT_FOUND_DETAIL})
        await websocket.close(code=TUNNEL_CLOSE_POLICY)
        return

    try:
        pump = await run_in_threadpool(manager.open_byte_pump, record)
    except SandboxError as exc:
        # 沙箱已停止 / 容器名冲突 / 网络没了 / 沙箱已删 / 记录损坏……：
        # 链路本身不成立，按策略违规收敛。**错误帧只给固定文案**
        # （与 REST 同一口径），核心异常原文只进日志。
        logger.info("转发 %s 的字节泵起不来：%s", forward_id, exc)
        await _send_control(
            websocket, {"type": FRAME_ERROR, "message": forward_tunnel_error_detail(exc)}
        )
        await websocket.close(code=TUNNEL_CLOSE_POLICY)
        return

    handle = await registry.register(record.id, websocket, pump)
    if not handle.accepted:
        # 服务正在退出：登记表已关过一轮，连接已被按 1001 关掉（泵已回收）
        return
    close_code = TUNNEL_CLOSE_NORMAL
    try:
        await _send_control(
            websocket,
            {
                "type": FRAME_HELLO,
                "forward_id": record.id,
                "sandbox": record.sandbox,
                "container_port": record.container_port,
            },
        )
        to_pump = asyncio.create_task(_pump_to_pump(websocket, pump))
        from_pump = asyncio.create_task(_pump_from_pump(websocket, pump, handle))
        try:
            done, pending = await asyncio.wait(
                {to_pump, from_pump}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            for task in done:
                if task.cancelled():
                    continue
                failure = task.exception()
                if failure is not None:
                    logger.warning(
                        "转发隧道 %s 的桥接任务异常：%s", handle.tunnel_id, failure
                    )
                elif task is from_pump and task.result():
                    # 字节泵异常结束（exec 失败）：已发原因帧，按 1011 关
                    close_code = TUNNEL_CLOSE_PUMP_ERROR
        finally:
            # 无论怎么收场，两个搬运任务都要收掉（不留在后台读字节泵）
            for task in (to_pump, from_pump):
                task.cancel()
            await asyncio.gather(to_pump, from_pump, return_exceptions=True)
    except (WebSocketDisconnect, WebSocketDisconnected):
        logger.debug("转发隧道 %s 的连接已断开", handle.tunnel_id)
    except Exception as exc:
        logger.warning("转发隧道 %s 的桥接异常：%s", handle.tunnel_id, exc, exc_info=True)
    finally:
        # 连接断开即回收字节泵进程：按进程组回收，不留僵尸 exec 进程
        handle.close_pump()
        registry.unregister(handle)
        try:
            await websocket.close(code=close_code)
        except Exception:
            # 关闭失败（连接已断、事件循环在关）不影响收尾
            pass


# ---------------------------------------------------------------- 隧道桥接
async def _pump_to_pump(websocket: WebSocket, pump: BytePump) -> None:
    """把客户端的二进制帧写进字节泵（文本帧走控制通道）。"""
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return
        data = message.get("bytes")
        if data:
            written = await pump_write(pump, data)
            if written < len(data):
                # 字节泵写不动了（多半是它已经退出）：收敛
                logger.info("字节泵只写进了 %d/%d 字节，隧道收敛", written, len(data))
                return
            continue
        text = message.get("text")
        if text is not None:
            await _handle_control(websocket, text)


async def _pump_from_pump(websocket: WebSocket, pump: BytePump, handle: TunnelHandle) -> bool:
    """把字节泵的输出持续推给客户端（读到 EOF 即收敛）。

    返回 ``True`` 表示**字节泵异常结束**（exec 失败）：失败原因只在 stderr 里，
    这里把尾部取出来**只进日志**，并给客户端发一条**固定文案**的原因帧
    （不回显容器客户端原文）。
    """
    while True:
        chunk = await pump_read(pump, READ_CHUNK)
        if not chunk:
            # 字节泵那头关了（EOF）：关掉另一侧
            reason = await pump_failure_reason(pump)
            if reason:
                logger.error(
                    "转发隧道 %s 的字节泵异常结束[forward-pump-failed]（stderr 尾部）：%s",
                    handle.tunnel_id,
                    reason,
                )
                try:
                    await _send_control(
                        websocket, {"type": FRAME_ERROR, "message": PUMP_FAILED_MESSAGE}
                    )
                except Exception:  # pragma: no cover - 连接已断时忽略
                    logger.debug("转发隧道 %s 发原因帧失败（连接多半已断）", handle.tunnel_id)
                return True
            return False
        await websocket.send_bytes(chunk)


async def _handle_control(websocket: WebSocket, text: str) -> None:
    """处理客户端发来的文本控制帧。"""
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        await _send_control(
            websocket, {"type": FRAME_ERROR, "message": "隧道指令不是合法 JSON"}
        )
        return
    if not isinstance(payload, dict):
        await _send_control(websocket, {"type": FRAME_ERROR, "message": "隧道指令格式非法"})
        return
    kind = payload.get("type")
    if kind == FRAME_HELLO:
        # 客户端握手：回一条 hello（服务端在 accept 后已经先回过一条）
        await _send_control(websocket, {"type": FRAME_HELLO})
        return
    if kind == FRAME_ERROR:
        # 客户端自报的隧道错误：记日志，不回帧
        logger.info("客户端报告转发隧道错误：%s", payload.get("message"))
        return
    await _send_control(
        websocket, {"type": FRAME_ERROR, "message": f"无法识别的隧道指令：{kind}"}
    )


async def _send_control(websocket: WebSocket, payload: dict) -> None:
    """给客户端回一条文本控制帧。"""
    await websocket.send_text(json.dumps(payload, ensure_ascii=False))


# ---------------------------------------------------------------- 辅助
def _is_valid_forward_id(forward_id: str) -> bool:
    """转发标识是否合法（非法值按「不存在」处理，不回显用户输入）。"""
    try:
        validate_forward_id(forward_id)
    except ValidationError:
        return False
    return True


async def _load_forward(
    manager: PortForwardManager, forward_id: str
) -> ForwardRecord | None:
    """按标识取转发记录；不存在或标识非法返回 ``None``。"""
    if not _is_valid_forward_id(forward_id):
        return None
    return await run_in_threadpool(manager.find, forward_id)
