"""终端路由：新建会话、列出会话、删除会话、WebSocket 附着。

协议固定（与前端约定一致）：

- 客户端二进制帧 = 终端输入字节；客户端文本帧 = ``{"type":"resize","cols":..,"rows":..}``；
- 服务端二进制帧 = 终端输出字节；服务端文本帧 = ``hello`` / ``exit`` / ``error``。
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Depends, WebSocket
from sandbox_platform import NotFoundError
from starlette.concurrency import run_in_threadpool
from starlette.websockets import WebSocketDisconnect, WebSocketDisconnected

from ..auth import CLOSE_CODE_UNAUTHORIZED, TicketStore, origin_allowed
from ..deps import get_terminal_manager, get_terminal_manager_ws, get_ticket_store_ws
from ..schemas import (
    TerminalSessionCreateRequest,
    TerminalSessionDeleteResponse,
    TerminalSessionModel,
    TerminalSessionResponse,
)
from ..terminal import (
    FRAME_DATA,
    FRAME_ERROR,
    FRAME_EXIT,
    SNAPSHOT_CHUNK,
    TerminalSession,
    TerminalStream,
    is_valid_session_id,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/terminal", tags=["终端"])

# 会话不存在时关闭连接的状态码（策略违规：客户端拿着一个失效的会话标识）
CLOSE_CODE_UNKNOWN_SESSION = 1008

# 会话不存在时的固定文案：不回显用户输入的会话标识（那是任意文本）
SESSION_NOT_FOUND_DETAIL = "终端会话不存在或已失效"


@router.post(
    "/sessions",
    response_model=TerminalSessionResponse,
    status_code=201,
    summary="新建终端会话",
)
async def create_terminal_session(
    payload: TerminalSessionCreateRequest,
    manager=Depends(get_terminal_manager),
) -> TerminalSessionResponse:
    """在沙箱容器内起一个带真实 TTY 的交互式 shell，返回会话标识与初始窗口大小。"""
    session = await manager.create(
        payload.sandbox,
        cols=payload.cols,
        rows=payload.rows,
    )
    return TerminalSessionResponse.from_session(session)


@router.get("/sessions", response_model=list[TerminalSessionModel], summary="列出终端会话")
def list_terminal_sessions(
    sandbox: str | None = None,
    manager=Depends(get_terminal_manager),
) -> list[TerminalSessionModel]:
    """列出会话；给了沙箱名则只列该沙箱的会话。"""
    return [
        TerminalSessionModel.from_record(record)
        for record in manager.list_records(sandbox)
    ]


@router.delete(
    "/sessions/{session_id}",
    response_model=TerminalSessionDeleteResponse,
    summary="删除终端会话",
)
async def delete_terminal_session(
    session_id: str,
    manager=Depends(get_terminal_manager),
) -> TerminalSessionDeleteResponse:
    """删除一个终端会话。

    运行中的会话先走完整关闭流程（终止宿主伪终端、按会话标识收掉容器内残留
    进程、状态落盘），再删掉记录；已退出的会话不重复终止进程，但仍走一次收尾
    （回收伪终端文件描述符、顺带清一次容器内可能残留的进程树），再删记录。

    还连着的浏览器会收到退出帧并断开（走的是进程自然退出的同一条路径）。
    关闭流程中途出错时照样删记录，响应里 ``closed`` 为 ``false``
    （记录已删，但关闭流程未走完）。会话不存在回 404。
    """
    if not is_valid_session_id(session_id):
        # 非法标识按「不存在」处理：错误文案里不回显用户输入
        raise NotFoundError(SESSION_NOT_FOUND_DETAIL)
    removal = await run_in_threadpool(manager.remove_session, session_id)
    if removal is None:
        raise NotFoundError(SESSION_NOT_FOUND_DETAIL)
    return TerminalSessionDeleteResponse.from_removal(removal)


@router.websocket("/sessions/{session_id}")
async def attach_terminal_session(
    websocket: WebSocket,
    session_id: str,
    manager=Depends(get_terminal_manager_ws),
    tickets: TicketStore = Depends(get_ticket_store_ws),
) -> None:
    """附着到已有终端会话：先回放缓冲再接实时流。

    握手先过两道闸，任一不过都拒握手（**不 accept**，关闭码 1008）：

    1. ``Origin`` 在放行清单内（同源、白名单来源放行，其余拒绝）；
    2. ``?ticket=`` 是一次性票据（浏览器 WebSocket 不能带自定义头，票据是用
       Bearer 换来的短期凭据；校验即作废）。

    口径提醒：握手在 ``accept`` 之前被拒时，**生产环境（uvicorn）对客户端表现为
    HTTP 403 拒绝响应，关闭码不送达**；``TestClient`` 下表现为
    ``WebSocketDisconnect(1008)``——那是测试语义，不是线上协议。
    """
    if not origin_allowed(
        websocket.headers.get("origin"),
        websocket.headers.get("host"),
        websocket.scope.get("scheme"),
    ):
        await websocket.close(code=CLOSE_CODE_UNAUTHORIZED)
        return
    if not tickets.consume(websocket.query_params.get("ticket", "")):
        await websocket.close(code=CLOSE_CODE_UNAUTHORIZED)
        return
    await websocket.accept()
    session = manager.get(session_id)
    if session is None:
        await websocket.send_text(
            json.dumps(
                {"type": "error", "message": "终端会话不存在或已失效，请新建会话"},
                ensure_ascii=False,
            )
        )
        await websocket.close(code=CLOSE_CODE_UNKNOWN_SESSION)
        return
    await _serve_session(websocket, session)


# ---------------------------------------------------------------- 会话桥接
async def _serve_session(websocket: WebSocket, session: TerminalSession) -> None:
    """一个浏览器连接在会话上的完整桥接过程。"""
    stream, snapshot = session.open_stream()
    # 先登记附着再发首帧：登记在前，断开时才有对称的「减一次」可做。
    # 反过来（先发首帧后登记）时，首帧发送失败会走 finally 里的断开流程，
    # 把没登记过的连接数减掉，后续连接的计数就全错位了。
    attached = False
    try:
        session.attach()
        attached = True
        await websocket.send_text(
            json.dumps(
                {
                    "type": "hello",
                    "session_id": session.session_id,
                    "sandbox": session.record.sandbox_name,
                    "cols": session.record.cols,
                    "rows": session.record.rows,
                },
                ensure_ascii=False,
            )
        )
        # 回放按块切：整段历史一次发出可能超过中间代理的单帧上限
        for offset in range(0, len(snapshot), SNAPSHOT_CHUNK):
            await websocket.send_bytes(snapshot[offset : offset + SNAPSHOT_CHUNK])
        output_task = asyncio.create_task(_pump_output(websocket, stream))
        input_task = asyncio.create_task(_pump_input(websocket, session))
        done, pending = await asyncio.wait(
            {output_task, input_task}, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            failure = task.exception()
            if failure is not None:
                logger.warning(
                    "终端会话 %s 的桥接任务异常：%s", session.session_id, failure
                )
        if output_task in done and session.exited:
            await websocket.send_text(
                json.dumps(
                    {"type": "exit", "code": session.exit_code, "reason": session.exit_reason},
                    ensure_ascii=False,
                )
            )
    except (WebSocketDisconnect, WebSocketDisconnected):
        logger.debug("终端会话 %s 的浏览器连接已断开", session.session_id)
    except Exception as exc:
        # 兜底：任何未预期异常都走正常清理流程，不让连接以 1011 收场
        logger.warning(
            "终端会话 %s 的桥接异常：%s", session.session_id, exc, exc_info=True
        )
    finally:
        session.close_stream(stream)
        if attached:
            session.detach()
        try:
            await websocket.close()
        except Exception:
            # 关闭失败（连接已断、事件循环在关）不影响会话收尾
            pass


async def _pump_output(websocket: WebSocket, stream: TerminalStream) -> None:
    """把容器内输出持续推给浏览器。"""
    while True:
        frame = await stream.queue.get()
        if frame.kind == FRAME_EXIT:
            # 容器内进程已退出
            return
        if frame.kind == FRAME_ERROR:
            await websocket.send_text(
                json.dumps({"type": "error", "message": frame.message}, ensure_ascii=False)
            )
            continue
        if frame.kind == FRAME_DATA:
            await websocket.send_bytes(frame.payload)


async def _pump_input(websocket: WebSocket, session: TerminalSession) -> None:
    """接收浏览器输入：二进制帧是终端输入，文本帧是窗口大小等控制指令。"""
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return
        data = message.get("bytes")
        if data:
            session.write(data)
            continue
        text = message.get("text")
        if text is None:
            continue
        await _handle_control(websocket, session, text)


async def _handle_control(websocket: WebSocket, session: TerminalSession, text: str) -> None:
    """处理浏览器发来的文本控制帧。"""
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        await _send_error(websocket, "终端指令不是合法 JSON")
        return
    if not isinstance(payload, dict):
        await _send_error(websocket, "终端指令格式非法")
        return
    kind = payload.get("type")
    if kind == "resize":
        cols = payload.get("cols")
        rows = payload.get("rows")
        if (
            not isinstance(cols, int)
            or not isinstance(rows, int)
            or isinstance(cols, bool)
            or isinstance(rows, bool)
            or cols <= 0
            or rows <= 0
            or cols > 1000
            or rows > 1000
        ):
            await _send_error(websocket, "窗口大小参数非法")
            return
        session.resize(cols, rows)
        return
    await _send_error(websocket, f"无法识别的终端指令：{kind}")


async def _send_error(websocket: WebSocket, message: str) -> None:
    """给浏览器回一条错误帧。"""
    await websocket.send_text(
        json.dumps({"type": "error", "message": message}, ensure_ascii=False)
    )
