"""连接层准入：访问令牌、一次性票据、跨源放行。

三块内容，配套 [[architecture/decisions/0013-三期定位改定与认证重启.md|ADR 0013]] 第 3、4 节：

- **访问令牌**（长期凭据）：环境变量 ``SANDBOX_CONSOLE_TOKEN`` 注入优先（且不落盘）；
  未注入时在平台数据根生成并落盘（``console-token.json``，权限 0600，原子写入）。
  令牌比对一律走 ``hmac.compare_digest``（常量时间），源码里不出现对令牌的
  ``==`` / ``in`` 比较。
- **一次性票据**（短期凭据）：浏览器发起的 WebSocket 不能设自定义头，
  先用 Bearer 换一张 30 秒有效、用过即废的票据，再以 ``?ticket=`` 带上。
  票据只活在进程内存里，过期判定用单调时钟（不受系统时间调整影响）。
- **跨源放行**（2026-11-03 用户决策）：**CORS 放行任意来源**，WebSocket 握手的
  ``Origin`` **不再校验**。理由：``Origin`` 不是安全边界（同源判定基于可伪造的
  ``Host`` 头，可被 DNS rebinding 绕过），真正的准入边界是**令牌与票据**。
- **WebSocket 准入**（fail-closed）：中间件对 WS scope 默认**拒握手**；只有显式
  登记的 WS 路由才放行——终端 WS 登记在豁免清单里（票据闸在路由侧），
  隧道 WS 登记在 Bearer 清单里（中间件校验 ``Authorization: Bearer``，
  桌面端 Rust 客户端能设请求头，不必绕票据）。两份清单都没登记的 WS 路由
  一律拒握手：新增 WS 路由而忘了写鉴权时，默认被拒，不是裸奔。

服务**不会在没有令牌的状态下对外提供接口**：令牌解析失败就让服务起不来。
**请求期不兜底生成令牌**：令牌只在启动路径（生命周期钩子）解析一次；请求期只读，
取不到就按认证失败（401）处理，绝不在请求路径上悄悄生成并落盘。
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import secrets
import stat
import time
from dataclasses import dataclass, field
from pathlib import Path

from sandbox_platform import PlatformConfig
from sandbox_platform.metadata import utc_now
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------- 令牌来源
# 令牌来源的环境变量：注入优先，且**不落盘**
TOKEN_ENV_VAR = "SANDBOX_CONSOLE_TOKEN"
# 令牌文件名（落在平台数据根下）
TOKEN_FILENAME = "console-token.json"
# 自动生成的令牌前缀：便于人工一眼认出令牌来源
TOKEN_PREFIX = "sbx_"
# 自动生成的令牌随机部分字节数
TOKEN_SECRET_BYTES = 32
# 令牌文件权限：只有属主可读写
TOKEN_FILE_MODE = 0o600
# 注入令牌的最小长度：太短的令牌熵不足，容易被猜中（只告警，不拒绝启动）
TOKEN_MIN_LENGTH = 16

# ---------------------------------------------------------------- 票据
# 票据有效期（秒）：一次性、过期即废
TICKET_TTL_SECONDS = 30
# 票据前缀：与长期令牌区分开（票据不是令牌，别混用）
TICKET_PREFIX = "sbxt_"
# 票据随机部分字节数
TICKET_SECRET_BYTES = 24

# ---------------------------------------------------------------- 跨源放行
# CORS 的放行口径：**任意来源**（2026-11-03 用户决策）。
#
# 口径变更的由来：来源白名单（含 WebSocket 的 Origin 门禁）并不是安全边界——
# 同源判定基于请求的 ``Host`` 头，可被 DNS rebinding 绕过；而真正的准入边界
# 是**令牌与票据**（见 ``BearerAuthMiddleware`` 与 ``TicketStore``）。
# 取消之后跨源访问只剩「必须拿得到令牌」这一道闸。
#
# ``allow_credentials`` 保持 False：本服务不用 Cookie 认证（凭据是显式的
# ``Authorization`` 头），所以响应里的 ``Access-Control-Allow-Origin: *``
# 不会与「带凭据的跨源请求」冲突（浏览器的凭据模式默认就是 same-origin）。
# 允许的方法
# 注意：这份清单是**显式白名单**，新增接口用到了新方法（PUT / PATCH 等）时，
# 必须同步改这里，否则浏览器预检直接被拒（三期任务 05 新增 `/api/forwards`
# 之后若引入新方法/新头，同样要回来改这份清单与下一行）。
CORS_ALLOWED_METHODS = ("GET", "POST", "DELETE", "OPTIONS")
# 允许的请求头：认证头与 JSON 请求体
# 同上：新增接口用到新请求头时（如 `X-Forward-*`），必须同步改这份清单。
CORS_ALLOWED_HEADERS = ("Authorization", "Content-Type")
# 允许脚本读取的响应头：下载接口用 `Content-Disposition` 给出文件名；只读读取
# （预览）用 `X-File-*` 三件套给出二进制标记 / 总字节数 / 截断声明。
# 跨源时浏览器默认不把非安全列表头暴露给 JS，不登记这里前端就解析不到。
CORS_EXPOSED_HEADERS = (
    "Content-Disposition",
    "X-File-Binary",
    "X-File-Size",
    "X-File-Truncated",
)

# ---------------------------------------------------------------- WebSocket 豁免清单
# 中间件对 WebSocket scope **默认拒绝**（fail-closed）：只有这里显式登记的
# WS 路由才放行到路由层，由路由自己再做票据校验。
#
# 新增 WS 路由要改两处：① 在这里登记路径；② 在路由里自己完成鉴权。
# 漏了① → 默认被拒（不是裸奔）；漏了② → 登记了但没鉴权（所以登记与鉴权要一起改）。
WEBSOCKET_EXEMPT_PATHS = ("/api/terminal/sessions",)

# ---------------------------------------------------------------- WebSocket Bearer 清单
# 走 **Bearer 令牌**的 WS 路由（桌面端 Rust 客户端能设自定义头，不必绕票据）：
# 中间件在**握手之前**校验 ``Authorization: Bearer``，通过才放行到路由层，
# 不通过就拒握手（与未登记路由同款：accept 之前拒）。
#
# 两份清单的分工（缺一不可）：
#
# - 豁免清单（``WEBSOCKET_EXEMPT_PATHS``）：中间件**不校验**，鉴权由路由自己做
#   ——浏览器侧的终端 WS 走一次性票据（浏览器不能设自定义头）；
# - Bearer 清单（``WEBSOCKET_BEARER_PATHS``）：中间件**校验 Bearer**，
#   路由再核一次（纵深防御）。
#
# **两份清单都没登记的 WS 路由：一律拒握手**（fail-closed 默认）——
# 新增 WS 路由而忘了登记时，默认被拒，不是裸奔；登记了却漏写路由内鉴权时，
# 至少还有中间件这道 Bearer 闸。
WEBSOCKET_BEARER_PATHS = ("/api/forward/tunnel",)

# ---------------------------------------------------------------- 认证失败口径
# 缺失与错误**不区分**：同一句文案、同一状态码，不给攻击者区分两种情况的线索
AUTH_FAILED_DETAIL = "访问令牌无效或缺失"
# 认证失败时回的挑战头：提示客户端走 Bearer
AUTH_CHALLENGE_HEADERS = {"WWW-Authenticate": "Bearer"}
# 拒握手时的关闭码（策略违规：未鉴权 / 票据无效）。
# 注意口径：**握手在 accept 之前就被拒**，生产环境（uvicorn）对客户端表现为
# HTTP 403 拒绝响应，关闭码不送达；TestClient 下表现为
# ``WebSocketDisconnect(1008)``——那是测试语义，不是线上协议。
CLOSE_CODE_UNAUTHORIZED = 1008


@dataclass(frozen=True)
class TokenSource:
    """访问令牌的来源。

    ``describe()`` 给启动日志用：**只说来源与路径，不含令牌本体**。
    ``repr`` 同样不带令牌本体（``repr=False``）：异常回溯、调试日志里
    随手打印 dataclass 也不会把令牌带出去。
    """

    token: str = field(repr=False)
    path: Path | None
    injected: bool

    def describe(self) -> str:
        """一句话描述来源（不含令牌本体）。"""
        if self.injected:
            return f"环境变量 {TOKEN_ENV_VAR} 注入（未落盘）"
        return str(self.path)


# ---------------------------------------------------------------- 令牌：生成与落盘
def generate_token() -> str:
    """生成一个新的访问令牌。"""
    return f"{TOKEN_PREFIX}{secrets.token_urlsafe(TOKEN_SECRET_BYTES)}"


def token_file_path(config: PlatformConfig) -> Path:
    """令牌文件路径：``<平台数据根>/console-token.json``。"""
    return config.home / TOKEN_FILENAME


def _ensure_token_file_mode(path: Path) -> None:
    """令牌文件权限位不是 0600 时收紧（并打 WARNING）。

    令牌文件是长期凭据：权限放宽等于把它交给同机的其它用户。文件不存在
    （首次启动）时什么都不做。
    """
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
    except OSError:
        return
    if mode == TOKEN_FILE_MODE:
        return
    try:
        os.chmod(path, TOKEN_FILE_MODE)
    except OSError as exc:
        logger.warning("令牌文件权限位收紧失败（%s，当前 %o）：%s", path, mode, exc)
        return
    logger.warning("令牌文件权限位不是 0600（当前 %o），已收紧：%s", mode, path)


def read_token_file(path: Path) -> str | None:
    """读令牌文件（**只读**：不生成、不落盘）。

    文件不存在、读不出来或内容损坏时返回空值（调用方按「没有令牌」处理）。
    文件存在但权限位不是 0600 时先收紧并打 WARNING。
    """
    _ensure_token_file_mode(path)
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    token = payload.get("token")
    if not isinstance(token, str):
        return None
    token = token.strip()
    if not token:
        return None
    return token


def write_token_file(path: Path, token: str) -> None:
    """原子写令牌文件（权限 0600）。

    写临时文件 → 改权限 → 原子替换：进程中断不留半截文件，权限位也不受
    进程 umask 影响。临时文件名带随机串（``secrets``）并用 ``O_EXCL`` 独占创建：
    并发写同一个令牌文件时不会互相覆盖（也不会踩到别人的临时文件）。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(
        {"token": token, "created_at": utc_now()},
        ensure_ascii=False,
        indent=2,
    )
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}-{secrets.token_hex(8)}")
    handle = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, TOKEN_FILE_MODE)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(tmp, TOKEN_FILE_MODE)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _warn_if_injected_token_too_short(token: str) -> None:
    """注入的令牌过短时告警（不拒绝启动；文案不含令牌本体）。"""
    if len(token) >= TOKEN_MIN_LENGTH:
        return
    logger.warning(
        "环境变量注入的访问令牌长度只有 %d 个字符（建议不少于 %d 个字符）："
        "熵不足容易被猜中",
        len(token),
        TOKEN_MIN_LENGTH,
    )


def read_token(config: PlatformConfig) -> TokenSource | None:
    """**只读**解析当前生效的访问令牌（不生成、不落盘）。

    口径与 ``resolve_token`` 的前两步一致：环境变量注入优先，其次既有令牌文件；
    两者都没有时返回空值（调用方按「没有令牌」处理）。
    """
    injected = os.environ.get(TOKEN_ENV_VAR, "").strip()
    if injected:
        return TokenSource(token=injected, path=None, injected=True)
    path = token_file_path(config)
    existing = read_token_file(path)
    if existing:
        return TokenSource(token=existing, path=path, injected=False)
    return None


def resolve_token(config: PlatformConfig) -> TokenSource:
    """按固定口径解析当前生效的访问令牌（**启动路径**：可生成、可落盘）。

    口径（ADR 0013 第 3 节）：

    1. 环境变量 ``SANDBOX_CONSOLE_TOKEN`` 注入优先，且**不落盘**；
    2. 否则读平台数据根下的令牌文件；
    3. 文件没有就生成一个并原子落盘（0600）；文件在但读不出来（损坏）
       时同样重新生成，并打一条 WARNING（只说路径，不说内容）。
    """
    source = read_token(config)
    if source is not None:
        if source.injected:
            _warn_if_injected_token_too_short(source.token)
        return source
    path = token_file_path(config)
    if path.exists():
        logger.warning("令牌文件损坏或不可读，已重新生成：%s", path)
    token = generate_token()
    write_token_file(path, token)
    return TokenSource(token=token, path=path, injected=False)


def token_matches(candidate: str, expected: str) -> bool:
    """常量时间比对令牌。

    一律走 ``hmac.compare_digest``：源码里不出现对令牌的 ``==`` / ``in`` 比较。
    """
    return hmac.compare_digest(
        candidate.encode("utf-8"),
        expected.encode("utf-8"),
    )


def extract_bearer(header: str | None) -> str | None:
    """从 ``Authorization`` 头里取 Bearer 令牌。

    头缺失、不是 ``Bearer`` _scheme_、或令牌为空时返回空值。
    """
    if not header:
        return None
    scheme, _, credentials = header.partition(" ")
    if scheme.lower() != "bearer":
        return None
    token = credentials.strip()
    if not token:
        return None
    return token


def bearer_authorized(headers: Headers, app) -> bool:
    """校验 ``Authorization: Bearer`` 令牌（HTTP 与 WebSocket 共用一条判定）。

    缺失与错误**不区分**：一律按「未通过」处理（调用方据此回 401 或拒握手）。
    比对走 :func:`token_matches`（常量时间）。
    """
    candidate = extract_bearer(headers.get("authorization"))
    expected = console_token(app)
    if not candidate or not expected:
        return False
    return token_matches(candidate, expected)


def console_token(app) -> str | None:
    """取应用当前生效的访问令牌（**只读**：不生成、不落盘）。

    正常路径：生命周期钩子启动时已解析并挂在 ``app.state`` 上。
    回退路径：应用还没跑生命周期钩子时按同一口径**只读**解析（环境变量注入值
    或既有令牌文件）。取不到时打一条 ERROR 日志并返回空值（调用方按「拒绝」
    处理，回 401）——请求路径上**绝不**现场生成令牌并落盘。
    """
    if app is None:
        return None
    token = getattr(app.state, "console_token", None)
    if isinstance(token, str) and token:
        return token
    config = getattr(app.state, "platform_config", None)
    if config is None:
        logger.error("访问令牌未初始化：应用状态里没有平台配置，拒绝放行")
        return None
    source = read_token(config)
    if source is None:
        logger.error(
            "访问令牌未初始化：既没有 %s 注入，也没有可读的令牌文件，拒绝放行",
            TOKEN_ENV_VAR,
        )
        return None
    app.state.console_token = source.token
    return source.token


# ---------------------------------------------------------------- 票据
class TicketStore:
    """一次性票据存储（进程内存态）。

    票据 30 秒过期、用过即废：``consume`` 命中即从存储里摘掉，第二次拿同一张
    票据来换连接必然失败。过期判定走单调时钟（``time.monotonic``），不受系统
    时间调整影响。

    **前提：仅限事件循环单线程使用。** 存储是进程内的普通字典，没有加锁，
    假定签发与消费都发生在同一个事件循环线程里（FastAPI 的同步路由跑在线程池
    线程中，所以签发票据的接口是 ``async def``——见 ``routes/auth.py``）。
    """

    def __init__(self, ttl_seconds: float = TICKET_TTL_SECONDS) -> None:
        self._ttl = ttl_seconds
        self._tickets: dict[str, float] = {}

    @property
    def ttl_seconds(self) -> float:
        """票据有效期（秒）。"""
        return self._ttl

    def issue(self) -> str:
        """签发一张新票据。"""
        self._purge_expired()
        ticket = f"{TICKET_PREFIX}{secrets.token_urlsafe(TICKET_SECRET_BYTES)}"
        self._tickets[ticket] = time.monotonic() + self._ttl
        return ticket

    def consume(self, ticket: str) -> bool:
        """校验并立即作废一张票据。

        票据不存在、已用过或已过期都返回 ``False``；命中即从存储里摘掉
        （一次性）。票据本身不是长期令牌，比对走字典精确查找，不做常量时间比较。
        """
        if not ticket:
            return False
        expiry = self._tickets.pop(ticket, None)
        if expiry is None:
            return False
        return time.monotonic() <= expiry

    def _purge_expired(self) -> None:
        """清掉已过期的票据（不让存储无限增长）。"""
        now = time.monotonic()
        for ticket, expiry in list(self._tickets.items()):
            if now > expiry:
                self._tickets.pop(ticket, None)


# ---------------------------------------------------------------- 认证中间件
def is_api_path(path: str, prefix: str) -> bool:
    """路径是否落在 API 前缀下。

    ``/api`` 与 ``/api/...`` 都算；``/apixxx`` 不算（前缀按路径段切）。
    """
    if path == prefix:
        return True
    return path.startswith(prefix + "/")


def route_path(scope: Scope) -> str:
    """路由路径：剥掉 ASGI 的 ``root_path`` 前缀（与 Starlette 的路由匹配口径一致）。

    ``root_path`` 是 ASGI 挂载前缀（如 ``/console``）：它不进路由匹配，
    所以准入判定也要用剥掉前缀的路径——否则服务挂在子路径下时，
    ``/api`` 前缀会漏判（接口裸奔）。
    """
    path = scope.get("path", "")
    root_path = scope.get("root_path", "") or ""
    if not root_path or not path.startswith(root_path):
        return path
    if path == root_path:
        return ""
    if path[len(root_path)] == "/":
        return path[len(root_path) :]
    return path


class BearerAuthMiddleware:
    """``/api`` 前缀的 Bearer 令牌认证中间件。

    - **只拦 ``/api`` 前缀**：根路径等非 ``/api`` 路径（``/``、``/docs``、
      ``/openapi.json``）不拦——本服务不再托管静态资源。
    - ``/api/health`` **不豁免**：401 也是健康口径的一部分，前端靠它区分
      「后端不可达」与「令牌无效」。
    - **WebSocket scope 默认拒绝**（fail-closed）：``websocket_exempt_paths``
      里的 WS 路由（终端 WS，票据闸在路由里）放行到路由层；
      ``websocket_bearer_paths`` 里的 WS 路由（隧道 WS）由**中间件校验
      Bearer**，通过才放行；**两份清单都没登记的 WS 路由一律拒握手**
      （将来新增 WS 路由而忘了登记鉴权时，默认被拒，不是裸奔）。
    - 缺失与错误不区分：同一句文案、同一状态码；不回显令牌，也不把令牌写进日志。
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        api_prefix: str = "/api",
        websocket_exempt_paths: tuple[str, ...] = (),
        websocket_bearer_paths: tuple[str, ...] = (),
    ) -> None:
        self.app = app
        self.api_prefix = api_prefix
        self.websocket_exempt_paths = tuple(websocket_exempt_paths)
        self.websocket_bearer_paths = tuple(websocket_bearer_paths)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        scope_type = scope.get("type")
        if scope_type == "websocket":
            await self._handle_websocket(scope, receive, send)
            return
        if scope_type != "http":
            await self.app(scope, receive, send)
            return
        if not is_api_path(route_path(scope), self.api_prefix):
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        if not bearer_authorized(headers, scope.get("app")):
            response = JSONResponse(
                status_code=401,
                content={"detail": AUTH_FAILED_DETAIL},
                headers=AUTH_CHALLENGE_HEADERS,
            )
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)

    async def _handle_websocket(self, scope: Scope, receive: Receive, send: Send) -> None:
        """WebSocket scope 的准入：按登记的鉴权方式放行，其余一律拒握手。

        三种口径：

        1. 豁免清单里的路径 → 放行到路由层（路由自己校验票据）；
        2. Bearer 清单里的路径 → **中间件校验 Bearer**，通过才放行；
        3. 两份清单都没登记 → 拒握手（fail-closed 默认）。

        拒握手的方式与路由层的拒握手一致：**在 accept 之前**发关闭消息。
        生产环境（uvicorn）对客户端表现为 HTTP 403 拒绝响应（关闭码不送达），
        TestClient 下表现为 ``WebSocketDisconnect(1008)``——那是测试语义。
        """
        path = route_path(scope)
        if any(is_api_path(path, prefix) for prefix in self.websocket_exempt_paths):
            await self.app(scope, receive, send)
            return
        if any(is_api_path(path, prefix) for prefix in self.websocket_bearer_paths):
            headers = Headers(scope=scope)
            if bearer_authorized(headers, scope.get("app")):
                await self.app(scope, receive, send)
                return
            logger.warning("WebSocket 握手的 Bearer 令牌无效或缺失：%s", path)
        else:
            logger.warning("未登记的 WebSocket 路由被拒握手（fail-closed）：%s", path)
        await send(
            {
                "type": "websocket.close",
                "code": CLOSE_CODE_UNAUTHORIZED,
                "reason": "",
            }
        )
