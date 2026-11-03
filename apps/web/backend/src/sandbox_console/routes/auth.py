"""认证路由：签发一次性票据。

浏览器发起的 WebSocket 不能设自定义头（``WebSocket`` API 不支持），
终端握手改走一次性票据：先用 Bearer 换一张 30 秒有效、用过即废的票据，
再以 ``?ticket=`` 带上。

**不把长期令牌放进 URL**：URL 会进访问日志与中间代理日志。桌面壳的 Rust
客户端可以设请求头，走 ``Authorization: Bearer`` 直接连，不经票据。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import TICKET_TTL_SECONDS, TicketStore
from ..deps import get_ticket_store
from ..schemas import AuthTicketResponse

router = APIRouter(prefix="/auth", tags=["认证"])


@router.post("/ticket", response_model=AuthTicketResponse, summary="签发一次性票据")
async def issue_ticket(store: TicketStore = Depends(get_ticket_store)) -> AuthTicketResponse:
    """签发一张一次性票据。

    本接口本身受 Bearer 令牌保护（与其它 ``/api`` 同一道闸）：没令牌的人
    换不到票据，也就连不上终端。

    **必须是 ``async def``**：票据存储是进程内的普通字典，没有加锁，
    只保证在事件循环单线程里使用。写成同步函数会被 FastAPI 丢到线程池里跑，
    签发就跑到别的线程上去了（见 ``auth.TicketStore`` 的类注释）。
    """
    return AuthTicketResponse(ticket=store.issue(), expires_in=TICKET_TTL_SECONDS)
