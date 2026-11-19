"""终端路由：新建会话、列出会话、删除会话、WebSocket 附着。

协议固定（与前端约定一致）：

- 客户端二进制帧 = 终端输入字节；
- 客户端文本帧 = ``{"type":"attach","cols":..,"rows":..}``（**第一个控制帧**，
  报自己的窗口大小）/ ``{"type":"resize","cols":..,"rows":..}``；
- 服务端二进制帧 = 终端输出字节；
- 服务端文本帧 = ``hello`` / ``snapshot`` / ``exit`` / ``error``。

**附着时序（新协议）**：

1. 服务端登记附着 → 回 ``hello``（带当前会话尺寸）；
2. 服务端起输入泵，**等客户端的 attach 帧**（带客户端自己的窗口大小）；
3. 客户端尺寸 ≠ 会话尺寸 ⇒ 服务端先把会话（伪终端 + 终端模拟器）改成
   客户端的尺寸，再等输出静默一小会儿（容器内的程序重绘完）；
4. 服务端取**现场快照**：有终端模拟器时是一份 VT 恢复流（画面 + 光标 +
   模式），按 48 KiB **原文**分片、base64 装在 ``snapshot`` 文本帧里下发
   （base64 后约 64 KiB，不越中间代理的单帧上限）；
5. 之后接实时流（二进制帧）。

**旧客户端兼容**：不发 attach 帧 ⇒ 服务端等 ``ATTACH_SIZE_TIMEOUT`` 秒后
判定为旧客户端，照旧按环形缓冲把历史输出当二进制帧分片下发（不发 snapshot
帧）。旧前端因此只是「少一份现场快照」，功能不崩。

**attach 迟到**：等待窗口只有 1 秒，网络慢 / 页面刚挂载就被挂起时 attach
可能晚到。此时主流程已经按旧客户端起了流（环形缓冲回放），迟到的 attach
**不能被静默丢弃**——丢弃的话新前端拿到的是历史回放（探测被新实例再答一
遍，乱码复发）且毫不知情。处理：按该尺寸 resize → 等输出静默 → 从模拟器
取一次快照 → 按 base64 分片**补发** snapshot 帧（**不新开流**：沿用原流，
两条流会把同一块输出投递两遍）。
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time

from fastapi import APIRouter, Depends, WebSocket
from sandbox_platform import NotFoundError
from starlette.concurrency import run_in_threadpool
from starlette.websockets import WebSocketDisconnect, WebSocketDisconnected

from ..auth import CLOSE_CODE_UNAUTHORIZED, TicketStore
from ..deps import get_terminal_manager, get_terminal_manager_ws, get_ticket_store_ws
from ..schemas import (
    TerminalSessionCreateRequest,
    TerminalSessionDeleteResponse,
    TerminalSessionModel,
    TerminalSessionResponse,
)
from ..terminal import (
    ATTACH_SIZE_TIMEOUT,
    FRAME_DATA,
    FRAME_ERROR,
    FRAME_EXIT,
    FRAME_SNAPSHOT,
    QUIET_MAX_WAIT_SECONDS,
    QUIET_WINDOW_SECONDS,
    RING_REPLAY_CHUNK,
    SNAPSHOT_CHUNK,
    TerminalSession,
    TerminalSnapshot,
    TerminalStream,
    is_valid_session_id,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/terminal", tags=["终端"])

# 会话不存在时关闭连接的状态码（策略违规：客户端拿着一个失效的会话标识）
CLOSE_CODE_UNKNOWN_SESSION = 1008

# 会话不存在时的固定文案：不回显用户输入的会话标识（那是任意文本）
SESSION_NOT_FOUND_DETAIL = "终端会话不存在或已失效"

# 窗口大小的取值范围（attach 与 resize 共用一套校验）
MIN_TERMINAL_SIZE = 1
MAX_TERMINAL_SIZE = 1000


def _valid_size(cols: object, rows: object) -> bool:
    """窗口大小参数是否合法（1~1000 的整数；``bool`` 不算整数）。"""
    return (
        isinstance(cols, int)
        and isinstance(rows, int)
        and not isinstance(cols, bool)
        and not isinstance(rows, bool)
        and MIN_TERMINAL_SIZE <= cols <= MAX_TERMINAL_SIZE
        and MIN_TERMINAL_SIZE <= rows <= MAX_TERMINAL_SIZE
    )


class _AttachHandshake:
    """attach 帧的等待器：客户端报来的窗口尺寸（或超时 / 断开）。

    **只认第一帧**：后来的 attach 帧不改判定（客户端重连后重发 attach 是
    正常现象，但尺寸判定以握手期间的第一帧为准）。

    **迟到的 attach 也认**：握手窗口（1 秒）内没等到 attach 时，主流程已经
    按旧客户端起了流；此后才到的第一帧 attach 由 ``wait_late`` 等到，走
    「补发快照」分支（不能静默丢弃——丢了新前端就只拿到历史回放）。
    """

    def __init__(self) -> None:
        self._event = asyncio.Event()
        self._finished = asyncio.Event()
        self._received = False
        self._disconnected = False
        self.cols: int | None = None
        self.rows: int | None = None

    def accept(self, cols: int, rows: int) -> None:
        """登记客户端尺寸。"""
        if self._received:
            return
        self._received = True
        self.cols = cols
        self.rows = rows
        self._event.set()

    def mark_disconnected(self) -> None:
        """客户端在握手期间就走了。"""
        self._disconnected = True
        self._finished.set()

    @property
    def received(self) -> bool:
        """有没有收到 attach 帧。"""
        return self._received

    @property
    def disconnected(self) -> bool:
        """客户端是不是在握手期间断了。"""
        return self._disconnected

    async def wait(self, timeout: float) -> bool:
        """等 attach 帧；等到返回 ``True``，超时或断开返回 ``False``。"""
        waiter = asyncio.ensure_future(self._event.wait())
        finisher = asyncio.ensure_future(self._finished.wait())
        try:
            await asyncio.wait(
                {waiter, finisher},
                timeout=timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            waiter.cancel()
            finisher.cancel()
        return self._received

    async def wait_late(self) -> tuple[int, int] | None:
        """等**迟到的** attach 帧（主流程已按旧客户端起流之后才到的那一帧）。

        一直等到连接结束（调用方在连接收尾时取消本任务）：客户端什么时候
        想补发 attach 是它的事，迟到的 attach 不能被静默丢弃。
        """
        await self._event.wait()
        if self.cols is None or self.rows is None:
            return None
        return (self.cols, self.rows)


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

    运行中的会话先走完整关闭流程（终止宿主伪终端、按会话标识清掉容器内残留
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
    """附着到已有终端会话：先回放现场快照再接实时流。

    握手先过一道闸：``?ticket=`` 是一次性票据（浏览器 WebSocket 不能带自定义头，
    票据是用 Bearer 换来的短期凭据；校验即作废）。不过就拒握手（**不 accept**，
    关闭码 1008）。

    **不再校验 ``Origin``**（2026-11-03 用户决策）：``Origin`` 不是安全边界
    （同源判定基于可伪造的 ``Host`` 头），真正的准入边界是令牌与票据。

    口径提醒：握手在 ``accept`` 之前被拒时，**生产环境（uvicorn）对客户端表现为
    HTTP 403 拒绝响应，关闭码不送达**；``TestClient`` 下表现为
    ``WebSocketDisconnect(1008)``——那是测试语义，不是线上协议。
    """
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
    stream: TerminalStream | None = None
    # 先登记附着再发首帧：登记在前，断开时才有对称的「减一次」可做。
    # 反过来（先发首帧后登记）时，首帧发送失败会走 finally 里的断开流程，
    # 把没登记过的连接数减掉，后续连接的计数就全错位了。
    attached = False
    # 发帧的串行锁：实时流与「迟到 attach 的补发快照」可能同时发帧，
    # 两条路径共用一个 socket ⇒ 发帧必须串行（否则帧可能交错/损坏）。
    send_lock = asyncio.Lock()
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
        # 握手：等客户端的 attach 帧（它报自己的窗口大小）。
        # **输入泵必须先起**：attach 帧就是从输入泵里进来的。
        handshake = _AttachHandshake()
        input_task = asyncio.create_task(
            _pump_input(websocket, session, handshake, send_lock)
        )
        await handshake.wait(ATTACH_SIZE_TIMEOUT)
        if handshake.disconnected and not handshake.received:
            # 客户端在握手期间就走了：没什么可发的，直接收尾
            return
        # 旧客户端（不发 attach）：走环形缓冲回放路径，不发 snapshot 帧
        legacy = not handshake.received
        if not legacy:
            cols = handshake.cols
            rows = handshake.rows
            if cols is not None and rows is not None:
                if (cols, rows) != (session.record.cols, session.record.rows):
                    # 先把会话（伪终端 + 终端模拟器）改成客户端的尺寸
                    session.resize(cols, rows)
                    # 再等输出落定：容器内的程序重绘完，快照才是完整画面
                    await _wait_until_quiet(session)
        # 取快照要在**线程池**里跑：快照格式化是 CPU 活儿（导一份 VT 恢复流），
        # 放事件循环线程里会把整个服务卡住。
        stream, snapshot = await run_in_threadpool(session.open_stream, force_ring=legacy)
        await _dispatch_snapshot(websocket, session, snapshot, send_lock)
        output_task = asyncio.create_task(_pump_output(websocket, stream, send_lock))
        # 迟到 attach 的补发：**只在旧客户端路径**建这条分支。握手窗口内已收到
        # attach 的新客户端，现场已经在上面发过了；再建一条会把它再补发一遍
        # （同一份快照发两遍，前端重放两次），所以按 ``legacy`` 收口。
        late_task = (
            asyncio.create_task(
                _serve_late_attach(websocket, session, handshake, send_lock)
            )
            if legacy
            else None
        )
        watching = {output_task, input_task}
        if late_task is not None:
            watching.add(late_task)
        while True:
            done, pending = await asyncio.wait(
                watching, return_when=asyncio.FIRST_COMPLETED
            )
            for task in done:
                if task.cancelled():
                    continue
                failure = task.exception()
                if failure is not None:
                    logger.warning(
                        "终端会话 %s 的桥接任务异常：%s", session.session_id, failure
                    )
            # 迟到 attach 的补发完成是**中途事件**：快照补完，实时流照旧继续
            # （不能像输出/输入任务收尾那样把连接拆掉）。
            if late_task is not None and done == {late_task}:
                watching = pending
                if not watching:
                    break
                continue
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            break
        if output_task.done() and not output_task.cancelled() and session.exited:
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
        if stream is not None:
            session.close_stream(stream)
        if attached:
            session.detach()
        try:
            await websocket.close()
        except Exception:
            # 关闭失败（连接已断、事件循环在关）不影响会话收尾
            pass


async def _wait_until_quiet(session: TerminalSession) -> None:
    """等容器内输出的静默窗口落定（改尺寸后的重绘完再取快照）。

    轮询 ``idle_seconds()``：连续 ``QUIET_WINDOW_SECONDS`` 秒没有新输出就
    认为重绘完了。**上限 ``QUIET_MAX_WAIT_SECONDS``**：到点强制继续（程序一直
    在吐输出时不能把快照卡住）。
    """
    deadline = time.monotonic() + QUIET_MAX_WAIT_SECONDS
    while time.monotonic() < deadline:
        if session.idle_seconds() >= QUIET_WINDOW_SECONDS:
            return
        await asyncio.sleep(0.02)


async def _dispatch_snapshot(
    websocket: WebSocket,
    session: TerminalSession,
    snapshot: TerminalSnapshot,
    send_lock: asyncio.Lock,
) -> None:
    """下发现场：模拟器恢复流走 snapshot 帧，回放走二进制帧。

    两条路径都记一条 INFO（kind、字节数、分片数、格式化耗时、是否回退）：
    快照路径的耗时与体量是排查「附着慢 / 帧太大」的第一手数据。
    """
    if snapshot.kind == "emulator":
        chunks = await _send_snapshot(websocket, snapshot, send_lock)
        logger.info(
            "终端会话 %s 下发快照：kind=%s，%d 字节，%d 片，格式化 %.1f 毫秒，回退=%s",
            session.session_id,
            snapshot.kind,
            len(snapshot.payload),
            chunks,
            snapshot.format_ms,
            False,
        )
        return
    # 回放按块切：整段历史一次发出可能超过中间代理的单帧上限
    payload = snapshot.payload
    chunks = 0
    # 整段回放**一次持锁**发完：片与片之间不夹实时输出帧（夹进去的话前端
    # 会先看到「后发生的输出」再看到「历史」，顺序就乱了）。
    async with send_lock:
        for offset in range(0, len(payload), RING_REPLAY_CHUNK):
            await websocket.send_bytes(payload[offset : offset + RING_REPLAY_CHUNK])
            chunks += 1
    logger.info(
        "终端会话 %s 下发现场：kind=%s，%d 字节，%d 片，格式化 %.1f 毫秒，回退=%s",
        session.session_id,
        snapshot.kind,
        len(payload),
        chunks,
        snapshot.format_ms,
        True,
    )


async def _send_snapshot(
    websocket: WebSocket,
    snapshot: TerminalSnapshot,
    send_lock: asyncio.Lock,
) -> int:
    """把模拟器导出的 VT 恢复流分片发给客户端，返回分片数。

    分片按 **48 KiB 原文**切，每片 base64 后装进一个文本帧：
    ``{"type":"snapshot","part":i,"parts":n,"data":"<base64>","cols":..,"rows":..,"pwd":..}``
    （base64 后约 64 KiB，不越中间代理的单帧上限）。

    ``cols`` / ``rows`` 是这份快照的几何（客户端据此把终端调成同尺寸再重放），
    ``pwd`` 是最近一条 OSC 1337 载荷（可空）。
    """
    payload = snapshot.payload
    total = max(1, (len(payload) + SNAPSHOT_CHUNK - 1) // SNAPSHOT_CHUNK)
    # 一份快照的**整串分片一次持锁**发完：片与片之间不夹实时输出帧。
    # 迟到 attach 的补发与实时流在同一个 socket 上跑，夹进去的输出帧会在
    # 前端「补齐分片后 reset」时被丢掉；不夹就只是「稍晚几毫秒」，不丢字节。
    async with send_lock:
        for index in range(total):
            piece = payload[index * SNAPSHOT_CHUNK : (index + 1) * SNAPSHOT_CHUNK]
            await websocket.send_text(
                json.dumps(
                    {
                        "type": FRAME_SNAPSHOT,
                        "part": index,
                        "parts": total,
                        "data": base64.b64encode(piece).decode("ascii"),
                        "cols": snapshot.cols,
                        "rows": snapshot.rows,
                        "pwd": snapshot.pwd,
                    },
                    ensure_ascii=False,
                )
            )
    return total


async def _serve_late_attach(
    websocket: WebSocket,
    session: TerminalSession,
    handshake: _AttachHandshake,
    send_lock: asyncio.Lock,
) -> None:
    """迟到的 attach 帧：按该尺寸补发一份快照（**不新开流**）。

    **为什么要有这条分支**：attach 的等待窗口只有 1 秒；网络慢 / 页面刚
    挂载就被挂起时，attach 可能晚到。主流程已经按「旧客户端」起了流
    （环形缓冲回放），此时再来的 attach 帧如果不处理，新前端拿到的是
    **历史回放**——探测被新实例再答一遍（乱码复发），且前端毫不知情。

    **处理**：按该尺寸 resize → 等输出静默（容器内的程序重绘完）→ 从模拟器
    取一次快照 → 按 base64 分片补发 snapshot 帧。前端对「迟到快照」天然
    兼容（decode → resize → reset → write 是幂等恢复）。

    **不开新流**：沿用主流程那条流（两条流会把同一块输出投递两遍）。快照
    只读模拟器、不登记流、也不动流的 ``start_seq``：历史回放（序号 ≤
    ``start_seq``）与实时块（序号 > ``start_seq``）的投递区间原样不变，
    不重不漏。
    """
    size = await handshake.wait_late()
    if size is None:
        return
    cols, rows = size
    logger.info(
        "终端会话 %s 收到迟到的 attach 帧（%d×%d），补发快照",
        session.session_id,
        cols,
        rows,
    )
    if (cols, rows) != (session.record.cols, session.record.rows):
        session.resize(cols, rows)
    # 等输出落定：容器内的程序重绘完，补发的快照才是完整画面
    await _wait_until_quiet(session)
    # 快照格式化是 CPU 活儿 ⇒ 放线程池（别阻塞事件循环）
    snapshot = await run_in_threadpool(session.snapshot)
    if snapshot is None:
        # 模拟器本来就不在（本机装不上 pyghostty）或已被作废：这是正常的
        # 降级路径——历史回放已经发过了，没有可补发的现场，不必告警。
        logger.info(
            "终端会话 %s 的模拟器不可用，迟到的 attach 沿用已回放的历史",
            session.session_id,
        )
        return
    chunks = await _send_snapshot(websocket, snapshot, send_lock)
    logger.info(
        "终端会话 %s 补发快照：kind=%s，%d 字节，%d 片，格式化 %.1f 毫秒，回退=%s",
        session.session_id,
        snapshot.kind,
        len(snapshot.payload),
        chunks,
        snapshot.format_ms,
        False,
    )


async def _pump_output(
    websocket: WebSocket,
    stream: TerminalStream,
    send_lock: asyncio.Lock,
) -> None:
    """把容器内输出持续推给浏览器。"""
    while True:
        frame = await stream.queue.get()
        if frame.kind == FRAME_EXIT:
            # 容器内进程已退出
            return
        if frame.kind == FRAME_ERROR:
            async with send_lock:
                await websocket.send_text(
                    json.dumps({"type": "error", "message": frame.message}, ensure_ascii=False)
                )
            continue
        if frame.kind == FRAME_DATA:
            async with send_lock:
                await websocket.send_bytes(frame.payload)


async def _pump_input(
    websocket: WebSocket,
    session: TerminalSession,
    handshake: _AttachHandshake,
    send_lock: asyncio.Lock,
) -> None:
    """接收浏览器输入：二进制帧是终端输入，文本帧是握手与控制指令。"""
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            handshake.mark_disconnected()
            return
        data = message.get("bytes")
        if data:
            session.write(data)
            continue
        text = message.get("text")
        if text is None:
            continue
        await _handle_control(websocket, session, text, handshake, send_lock)


async def _handle_control(
    websocket: WebSocket,
    session: TerminalSession,
    text: str,
    handshake: _AttachHandshake | None = None,
    send_lock: asyncio.Lock | None = None,
) -> None:
    """处理浏览器发来的文本控制帧。"""
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        await _send_error(websocket, "终端指令不是合法 JSON", send_lock)
        return
    if not isinstance(payload, dict):
        await _send_error(websocket, "终端指令格式非法", send_lock)
        return
    kind = payload.get("type")
    if kind == "attach":
        # 握手帧：客户端报自己的窗口大小（**必须是第一个控制帧**）。
        cols = payload.get("cols")
        rows = payload.get("rows")
        if not _valid_size(cols, rows):
            await _send_error(websocket, "窗口大小参数非法", send_lock)
            return
        if handshake is not None:
            handshake.accept(cols, rows)
        return
    if kind == "resize":
        cols = payload.get("cols")
        rows = payload.get("rows")
        if not _valid_size(cols, rows):
            await _send_error(websocket, "窗口大小参数非法", send_lock)
            return
        session.resize(cols, rows)
        return
    await _send_error(websocket, f"无法识别的终端指令：{kind}", send_lock)


async def _send_error(
    websocket: WebSocket,
    message: str,
    send_lock: asyncio.Lock | None = None,
) -> None:
    """给浏览器回一条错误帧。"""
    if send_lock is None:
        await websocket.send_text(
            json.dumps({"type": "error", "message": message}, ensure_ascii=False)
        )
        return
    async with send_lock:
        await websocket.send_text(
            json.dumps({"type": "error", "message": message}, ensure_ascii=False)
        )
