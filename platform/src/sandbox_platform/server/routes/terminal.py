"""终端路由：新建会话、列出会话、WebSocket 附着。

协议固定（与前端约定一致）：

- 客户端二进制帧 = 终端输入字节；客户端文本帧 = ``{"type":"resize","cols":..,"rows":..}``；
- 服务端二进制帧 = 终端输出字节；服务端文本帧 = ``hello`` / ``exit`` / ``error``。
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Depends, WebSocket
from starlette.websockets import WebSocketDisconnect, WebSocketDisconnected

from ..deps import get_terminal_manager, get_terminal_manager_ws
from ..schemas import (
    TerminalSessionCreateRequest,
    TerminalSessionModel,
    TerminalSessionResponse,
)
from ..terminal import TerminalSession, TerminalStream

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/terminal", tags=["终端"])

# 会话不存在时关闭连接的状态码（策略违规：客户端拿着一个失效的会话标识）
CLOSE_CODE_UNKNOWN_SESSION = 1008


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


@router.websocket("/sessions/{session_id}")
async def attach_terminal_session(
    websocket: WebSocket,
    session_id: str,
    manager=Depends(get_terminal_manager_ws),
) -> None:
    """附着到已有终端会话：先回放缓冲再接实时流。"""
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
    try:
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
        if snapshot:
            await websocket.send_bytes(snapshot)
        session.attach()
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
                    {"type": "exit", "code": session.exit_code},
                    ensure_ascii=False,
                )
            )
    except (WebSocketDisconnect, WebSocketDisconnected):
        logger.debug("终端会话 %s 的浏览器连接已断开", session.session_id)
    finally:
        session.close_stream(stream)
        session.detach()
        try:
            await websocket.close()
        except (WebSocketDisconnect, WebSocketDisconnected, RuntimeError):
            pass


async def _pump_output(websocket: WebSocket, stream: TerminalStream) -> None:
    """把容器内输出持续推给浏览器。"""
    while True:
        chunk = await stream.queue.get()
        if chunk is None:
            # 容器内进程已退出
            return
        await websocket.send_bytes(chunk)


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
