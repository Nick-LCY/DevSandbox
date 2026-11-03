"""连接层准入测试：令牌三态、票据、CORS 放行口径、WebSocket 鉴权。

覆盖三块：

- **访问令牌**：缺 / 错 / 对三态；令牌文件的生成、权限与落盘口径；启动日志只打路径。
- **一次性票据**：受 Bearer 保护、30 秒过期、用过即废。
- **跨源放行**：CORS 任意来源放行（预检与实际请求）、预检免令牌；WebSocket 握手的
  ``Origin`` **不再校验**（任意来源 + 有效票据即连上），握手仍由票据把门。

分层契约（服务层不直接碰宿主）由 ``test_source_contract.py`` 统一检测，
本文件不重复。
"""

from __future__ import annotations

import ast
import asyncio
import json
import logging
import os
import stat
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sandbox_platform import ConfigError, PlatformConfig
from starlette.middleware.cors import SAFELISTED_HEADERS
from starlette.websockets import WebSocket, WebSocketDisconnect
from sandbox_console import create_app
from sandbox_console.auth import (
    AUTH_FAILED_DETAIL,
    CLOSE_CODE_UNAUTHORIZED,
    CORS_ALLOWED_HEADERS,
    CORS_ALLOWED_METHODS,
    TICKET_TTL_SECONDS,
    TOKEN_ENV_VAR,
    TOKEN_FILENAME,
    TOKEN_MIN_LENGTH,
    WEBSOCKET_BEARER_PATHS,
    WEBSOCKET_EXEMPT_PATHS,
    BearerAuthMiddleware,
    TicketStore,
    TokenSource,
    is_api_path,
    read_token_file,
    resolve_token,
)
from sandbox_console.deps import get_service

from conftest import TEST_TOKEN, auth_headers

# 服务端源码目录（令牌比较契约用）
BACKEND_SRC = Path(__file__).resolve().parents[1] / "src" / "sandbox_console"


class StubService:
    """只够 ``/api/health`` 用的假生命周期服务（不碰宿主）。"""

    def __init__(self, config: PlatformConfig) -> None:
        self.config = config


@pytest.fixture
def auth_client(
    platform_home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    """带认证的测试客户端（生命周期服务整体桩掉）。"""
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    app = create_app()
    app.dependency_overrides[get_service] = lambda: StubService(PlatformConfig.from_env())
    with TestClient(app, headers=auth_headers()) as client:
        yield client


def issue_ticket(client: TestClient) -> str:
    """换一张一次性票据。"""
    response = client.post("/api/auth/ticket")
    assert response.status_code == 200
    return response.json()["ticket"]


# ---------------------------------------------------------------- 令牌三态
def test_api_without_token_returns_401(auth_client: TestClient) -> None:
    """不带令牌访问 /api：401 + 固定中文文案。"""
    response = auth_client.get("/api/health", headers={"Authorization": ""})
    assert response.status_code == 401
    body = response.json()
    assert body == {"detail": AUTH_FAILED_DETAIL}
    assert body["detail"] == "访问令牌无效或缺失"


def test_api_with_wrong_token_returns_401(auth_client: TestClient) -> None:
    """令牌错误：与缺失同义（同一句文案、同一状态码）。"""
    response = auth_client.get("/api/health", headers=auth_headers("sbx_wrong_token"))
    assert response.status_code == 401
    assert response.json() == {"detail": AUTH_FAILED_DETAIL}


def test_api_with_correct_token_returns_200(auth_client: TestClient) -> None:
    """令牌正确：正常放行。"""
    response = auth_client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_health_is_not_exempt_from_auth(auth_client: TestClient) -> None:
    """/api/health 不豁免：没令牌同样 401。

    401 也是健康口径的一部分：前端靠它区分「后端不可达」与「令牌无效」。
    """
    response = auth_client.get("/api/health", headers={"Authorization": ""})
    assert response.status_code == 401


def test_auth_failure_does_not_echo_the_token(auth_client: TestClient) -> None:
    """认证失败不回显令牌（响应体里没有客户端发来的值）。"""
    response = auth_client.get("/api/health", headers=auth_headers("sbx_guess_me"))
    assert response.status_code == 401
    assert "sbx_guess_me" not in response.text


def test_static_assets_are_not_blocked_by_auth(
    platform_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """静态资源不拦：网页本体（/）没令牌也能拿到。"""
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html>console</html>", encoding="utf-8")
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(dist))
    app = create_app()
    with TestClient(app) as client:
        response = client.get("/")
    assert response.status_code == 200
    assert "console" in response.text


def test_openapi_docs_are_not_blocked_by_auth(
    platform_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """/docs 与 /openapi.json 不拦（是否开放由 SANDBOX_CONSOLE_DOCS 决定）。"""
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    monkeypatch.setenv("SANDBOX_CONSOLE_DOCS", "1")
    app = create_app()
    with TestClient(app) as client:
        assert client.get("/openapi.json").status_code == 200
        assert client.get("/docs").status_code == 200


# ---------------------------------------------------------------- 令牌来源与落盘
def test_token_is_generated_into_data_root_when_not_injected(
    platform_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """未注入令牌时自动生成并落平台数据根（0600），前缀 sbx_。"""
    monkeypatch.delenv(TOKEN_ENV_VAR, raising=False)
    config = PlatformConfig.from_env()

    source = resolve_token(config)

    path = platform_home / TOKEN_FILENAME
    assert path.is_file()
    assert source.path == path
    assert source.injected is False
    assert source.token.startswith("sbx_")
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert read_token_file(path) == source.token


def test_generated_token_is_stable_across_restarts(
    platform_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """令牌文件已存在时沿用：不重新生成（重启不变）。"""
    monkeypatch.delenv(TOKEN_ENV_VAR, raising=False)
    config = PlatformConfig.from_env()
    first = resolve_token(config).token
    second = resolve_token(config).token
    assert first == second


def test_injected_token_is_not_written_to_disk(
    platform_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """环境变量注入的令牌不落盘（文件压根不生成）。"""
    monkeypatch.setenv(TOKEN_ENV_VAR, "sbx_injected_token")
    config = PlatformConfig.from_env()

    source = resolve_token(config)

    assert source.token == "sbx_injected_token"
    assert source.injected is True
    assert source.path is None
    assert not (platform_home / TOKEN_FILENAME).exists()


def test_startup_log_shows_token_path_but_not_token(
    platform_home: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """启动日志只出现令牌文件路径，不出现令牌本体。"""
    monkeypatch.delenv(TOKEN_ENV_VAR, raising=False)
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(platform_home / "no-console-dist"))
    app = create_app()
    with caplog.at_level(logging.INFO):
        with TestClient(app) as client:
            client.get("/api/health", headers=auth_headers("sbx_guess_me"))
    token = read_token_file(platform_home / TOKEN_FILENAME)
    assert token
    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert TOKEN_FILENAME in messages
    assert token not in messages


def test_token_file_permissions_are_tightened_when_read(
    platform_home: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """令牌文件权限位不是 0600 时：读的时候收紧成 0600，并打 WARNING。"""
    monkeypatch.delenv(TOKEN_ENV_VAR, raising=False)
    config = PlatformConfig.from_env()
    path = platform_home / TOKEN_FILENAME
    path.write_text(json.dumps({"token": "sbx_wide_perms"}), encoding="utf-8")
    path.chmod(0o644)

    with caplog.at_level(logging.WARNING):
        source = resolve_token(config)

    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert source.token == "sbx_wide_perms"
    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert "0600" in messages
    assert "sbx_wide_perms" not in messages


def test_corrupted_token_file_is_regenerated_with_a_warning(
    platform_home: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """令牌文件损坏：静默重新生成（不报错），并打一条 WARNING（不含文件内容）。"""
    monkeypatch.delenv(TOKEN_ENV_VAR, raising=False)
    config = PlatformConfig.from_env()
    path = platform_home / TOKEN_FILENAME
    path.write_text("this-is-not-json", encoding="utf-8")

    with caplog.at_level(logging.WARNING):
        source = resolve_token(config)

    assert source.token.startswith("sbx_")
    assert read_token_file(path) == source.token
    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert "令牌文件" in messages
    assert "重新生成" in messages
    assert "this-is-not-json" not in messages


def test_short_injected_token_warns_but_still_resolves(
    platform_home: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """注入的令牌太短：打 WARNING（不拒绝启动），文案不含令牌本体。"""
    monkeypatch.setenv(TOKEN_ENV_VAR, "short")
    config = PlatformConfig.from_env()

    with caplog.at_level(logging.WARNING):
        source = resolve_token(config)

    assert source.token == "short"
    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert "令牌" in messages
    assert "short" not in messages
    assert TOKEN_MIN_LENGTH == 16


def test_request_time_fallback_never_generates_or_writes_a_token(
    platform_home: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """请求期的回退路径**只读**：取不到令牌就报 ERROR + 401，不现场生成、不落盘。"""
    monkeypatch.delenv(TOKEN_ENV_VAR, raising=False)
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    app = create_app()
    # 不进生命周期钩子（不进 ``with TestClient(app)``）：模拟令牌未初始化的场景
    client = TestClient(app)

    with caplog.at_level(logging.ERROR):
        response = client.get("/api/health", headers=auth_headers("sbx_whatever"))

    assert response.status_code == 401
    assert response.json() == {"detail": AUTH_FAILED_DETAIL}
    assert not (platform_home / TOKEN_FILENAME).exists()
    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert "访问令牌未初始化" in messages


def test_token_source_repr_does_not_leak_the_token() -> None:
    """TokenSource 的 repr 不带令牌本体（防调试输出泄露）。"""
    source = TokenSource(
        token="sbx_secret_value", path=Path("/tmp/console-token.json"), injected=False
    )
    assert "sbx_secret_value" not in repr(source)
    assert "sbx_secret_value" not in str(source)
    assert "sbx_secret_value" not in source.describe()


@pytest.mark.skipif(os.geteuid() == 0, reason="root 能绕过目录权限位")
def test_unwritable_data_root_fails_startup_without_leaving_leftovers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """数据根指向不可写目录：服务启动失败（ConfigError），且不留半成品令牌文件。"""
    monkeypatch.delenv(TOKEN_ENV_VAR, raising=False)
    readonly = tmp_path / "readonly"
    readonly.mkdir()
    readonly.chmod(0o500)
    home = readonly / "platform-home"
    monkeypatch.setenv("SANDBOX_PLATFORM_HOME", str(home))
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    app = create_app()
    try:
        with pytest.raises(ConfigError):
            with TestClient(app):
                pass
        assert not home.exists()
        assert list(readonly.iterdir()) == []
    finally:
        readonly.chmod(0o700)


# ---------------------------------------------------------------- 票据
def test_ticket_endpoint_requires_a_valid_token(auth_client: TestClient) -> None:
    """票据接口本身受 Bearer 保护：没令牌换不到票据。"""
    response = auth_client.post("/api/auth/ticket", headers={"Authorization": ""})
    assert response.status_code == 401
    assert response.json() == {"detail": AUTH_FAILED_DETAIL}


def test_ticket_response_shape(auth_client: TestClient) -> None:
    """票据响应：ticket + expires_in（30 秒）。"""
    response = auth_client.post("/api/auth/ticket")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"ticket", "expires_in"}
    assert body["expires_in"] == TICKET_TTL_SECONDS
    assert body["expires_in"] == 30
    assert body["ticket"]


def test_ticket_is_single_use(auth_client: TestClient) -> None:
    """票据用过即废：同一张票据第二次换不到连接。"""
    ticket = issue_ticket(auth_client)
    with auth_client.websocket_connect(f"/api/terminal/sessions/x?ticket={ticket}") as ws:
        assert ws.receive_json()["type"] == "error"
    with pytest.raises(WebSocketDisconnect):
        with auth_client.websocket_connect(f"/api/terminal/sessions/x?ticket={ticket}"):
            pass


def test_ticket_store_consumes_once() -> None:
    """票据存储：同一张票据只能消费一次。"""
    store = TicketStore()
    ticket = store.issue()
    assert store.consume(ticket) is True
    assert store.consume(ticket) is False


def test_ticket_expires() -> None:
    """票据过期后失效（过期判定走单调时钟）。"""
    store = TicketStore(ttl_seconds=0.05)
    ticket = store.issue()
    time.sleep(0.1)
    assert store.consume(ticket) is False


def test_default_ticket_ttl_is_30_seconds() -> None:
    """默认票据有效期 30 秒。"""
    assert TICKET_TTL_SECONDS == 30
    assert TicketStore().ttl_seconds == 30


# ---------------------------------------------------------------- WebSocket 鉴权
def test_websocket_without_ticket_is_rejected(auth_client: TestClient) -> None:
    """终端 WS 不带票据：握手被拒（1008），不 accept。

    口径提醒：握手在 accept 之前被拒，**生产环境（uvicorn）对客户端表现为
    HTTP 403 拒绝响应，关闭码不送达**；这里的 ``WebSocketDisconnect(1008)``
    是 TestClient 的测试语义，不是线上协议。
    """
    with pytest.raises(WebSocketDisconnect) as failure:
        with auth_client.websocket_connect("/api/terminal/sessions/x"):
            pass
    assert failure.value.code == 1008


def test_websocket_with_wrong_ticket_is_rejected(auth_client: TestClient) -> None:
    """终端 WS 带错票据：握手被拒（1008）。

    口径同上：accept 之前被拒，生产环境（uvicorn）表现为 HTTP 403，
    TestClient 下才是 ``WebSocketDisconnect(1008)``。
    """
    with pytest.raises(WebSocketDisconnect) as failure:
        with auth_client.websocket_connect("/api/terminal/sessions/x?ticket=not-a-ticket"):
            pass
    assert failure.value.code == 1008


def test_websocket_with_valid_ticket_is_accepted(auth_client: TestClient) -> None:
    """终端 WS 带有效票据：握手通过（会话不存在时按既有口径回错误帧）。"""
    ticket = issue_ticket(auth_client)
    with auth_client.websocket_connect(f"/api/terminal/sessions/x?ticket={ticket}") as ws:
        message = ws.receive_json()
        assert message["type"] == "error"
        assert "终端会话" in message["message"]


def test_websocket_accepts_any_origin_with_a_valid_ticket(auth_client: TestClient) -> None:
    """Origin 门禁已取消（2026-11-03 用户决策）：任意 Origin + 有效票据 → 连上。

    口径提醒：``Origin`` 不是安全边界（同源判定基于可伪造的 ``Host`` 头），
    真正的准入边界是票据（这里换来的短期凭据）。
    """
    ticket = issue_ticket(auth_client)
    with auth_client.websocket_connect(
        f"/api/terminal/sessions/x?ticket={ticket}",
        headers={"Origin": "http://evil.example"},
    ) as ws:
        assert ws.receive_json()["type"] == "error"


def test_websocket_accepts_missing_origin_with_a_valid_ticket(auth_client: TestClient) -> None:
    """不带 Origin（非浏览器客户端）：一样连上（凭据照常校验）。"""
    ticket = issue_ticket(auth_client)
    with auth_client.websocket_connect(f"/api/terminal/sessions/x?ticket={ticket}") as ws:
        assert ws.receive_json()["type"] == "error"


def test_websocket_rejects_any_origin_without_a_valid_ticket(auth_client: TestClient) -> None:
    """Origin 放开了，票据仍是硬闸：无效票据 + 任意 Origin → 握手被拒（1008）。

    口径同上：accept 之前被拒，生产环境（uvicorn）表现为 HTTP 403，
    TestClient 下才是 ``WebSocketDisconnect(1008)``。
    """
    with pytest.raises(WebSocketDisconnect) as failure:
        with auth_client.websocket_connect(
            "/api/terminal/sessions/x?ticket=not-a-ticket",
            headers={"Origin": "http://evil.example"},
        ):
            pass
    assert failure.value.code == 1008


def test_unregistered_websocket_route_is_rejected_by_default(
    platform_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """中间件对 WebSocket 是 fail-closed：没登记的 WS 路由一律拒握手。

    新增一个**裸奔**的测试用 WS 路由（自己不校验票据），
    验证它被令牌闸在 accept 之前就拒掉——将来新增 WS 路由漏写鉴权时，
    默认是被拒，而不是裸奔。
    """
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    app = create_app()

    @app.websocket("/api/not-registered/ws")
    async def _bare_websocket(websocket: WebSocket) -> None:
        # 故意不鉴权：这条路由就是用来验证中间件的 fail-closed 行为
        await websocket.accept()
        await websocket.send_text("裸奔")

    with TestClient(app, headers=auth_headers()) as client:
        with pytest.raises(WebSocketDisconnect) as failure:
            with client.websocket_connect("/api/not-registered/ws"):
                pass
    assert failure.value.code == CLOSE_CODE_UNAUTHORIZED


def test_registered_websocket_route_is_exempt_from_the_middleware(
    platform_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """登记在豁免清单里的 WS 路由（终端 WS）能过中间件：鉴权由路由自己做。"""
    monkeypatch.setenv("SANDBOX_CONSOLE_DIST", str(tmp_path / "no-console-dist"))
    app = create_app()
    assert "/api/terminal/sessions" in WEBSOCKET_EXEMPT_PATHS

    with TestClient(app, headers=auth_headers()) as client:
        # 没有票据：终端 WS 路由自己拒（同样是 accept 之前）
        with pytest.raises(WebSocketDisconnect) as failure:
            with client.websocket_connect("/api/terminal/sessions/x"):
                pass
    assert failure.value.code == CLOSE_CODE_UNAUTHORIZED


# ---------------------------------------------------------------- CORS
# CORS 口径（2026-11-03 用户决策）：**任意来源放行**，响应头是
# ``Access-Control-Allow-Origin: *``。
#
# 说明：任务 02 的完成标准里「响应里没有 ``Access-Control-Allow-Origin: *``」
# 一条已被本次决策推翻——白名单不是安全边界，真正的准入边界是令牌与票据。
# 下面几条用例把新口径钉死：任意来源放行、且响应头就是通配符。
@pytest.mark.parametrize(
    "origin",
    [
        "http://tauri.localhost",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://evil.example",
    ],
)
def test_cors_preflight_allows_any_origin(auth_client: TestClient, origin: str) -> None:
    """预检请求：任意来源放行（含此前被拒的来源），且回的是通配符。"""
    response = auth_client.options(
        "/api/sandboxes",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "*"


def test_cors_actual_request_from_any_origin(auth_client: TestClient) -> None:
    """实际请求：任意来源都拿到 allow-origin 头。"""
    response = auth_client.get("/api/health", headers={"Origin": "http://localhost:5173"})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "*"


def test_cors_actual_request_from_previously_rejected_origin(auth_client: TestClient) -> None:
    """实际请求：此前被白名单拒掉的来源，现在照样放行。"""
    response = auth_client.get("/api/health", headers={"Origin": "http://evil.example"})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "*"


def test_cors_emits_wildcard_allow_origin(auth_client: TestClient) -> None:
    """响应头就是 ``Access-Control-Allow-Origin: *``（新口径，不再回避通配符）。

    旧口径（白名单）要求「任何来源都拿不到 ``*``」，已被 2026-11-03 的用户决策
    推翻：来源不是安全边界，令牌与票据才是。
    """
    for origin in ("http://tauri.localhost", "http://evil.example"):
        response = auth_client.get("/api/health", headers={"Origin": origin})
        assert response.headers.get("access-control-allow-origin") == "*"


def test_cors_headers_are_present_on_auth_failure(auth_client: TestClient) -> None:
    """认证失败的响应也带跨源放行头：浏览器才读得到失败原因。

    跨源放行中间件在外层，它给**所有**响应补头（包括内层令牌闸回的 401）。
    """
    response = auth_client.get(
        "/api/health",
        headers={"Origin": "http://tauri.localhost", "Authorization": ""},
    )
    assert response.status_code == 401
    assert response.headers["access-control-allow-origin"] == "*"
    assert response.json() == {"detail": AUTH_FAILED_DETAIL}


def test_cors_preflight_does_not_require_token(auth_client: TestClient) -> None:
    """预检请求不带 Authorization 头也不该被令牌闸拦下。"""
    response = auth_client.options(
        "/api/sandboxes",
        headers={
            "Origin": "http://tauri.localhost",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert response.status_code == 200


def test_cors_method_and_header_allowlists_are_unchanged(auth_client: TestClient) -> None:
    """方法与请求头的白名单不变（放行来源放宽了，但这两项没动）。

    **双向断言**：一是把清单的**字面值**钉死（配置里改了方法 / 头，这条用例红），
    二是把**响应头**与清单对齐（两边都断言成相等的集合，而不是单向的「包含」——
    少一个（浏览器预检被拒，接口在浏览器里直接调不通）或多一个（多出来的方法 /
    请求头没被人审过）都要能看出来）。
    """
    # 一、清单的字面值（改配置即红）。
    assert set(CORS_ALLOWED_METHODS) == {"GET", "POST", "DELETE", "OPTIONS"}
    assert set(CORS_ALLOWED_HEADERS) == {"Authorization", "Content-Type"}

    response = auth_client.options(
        "/api/sandboxes",
        headers={
            "Origin": "http://evil.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert response.status_code == 200
    # 二、响应头与清单**完全相等**（不多不少）。
    allowed_methods = {
        item.strip()
        for item in response.headers["access-control-allow-methods"].split(",")
        if item.strip()
    }
    assert allowed_methods == set(CORS_ALLOWED_METHODS)
    # 请求头：Starlette 的 CORS 中间件会把 **CORS 安全列表头**
    # （Accept / Accept-Language / Content-Language / Content-Type）并进响应头，
    # 所以期望值 = 配置清单 ∪ 安全列表头；同样要求不多不少。
    allowed_headers = {
        item.strip().lower()
        for item in response.headers["access-control-allow-headers"].split(",")
        if item.strip()
    }
    assert allowed_headers == {item.lower() for item in CORS_ALLOWED_HEADERS} | {
        item.lower() for item in SAFELISTED_HEADERS
    }


# ---------------------------------------------------------------- 路径前缀边界
@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("/api", True),
        ("/api/", True),
        ("/api/health", True),
        ("/api/terminal/sessions", True),
        ("/apixxx", False),
        ("/apixxx/health", False),
        ("//api", False),
        ("//api/health", False),
        ("/assets/index.js", False),
        ("/", False),
    ],
)
def test_is_api_path_boundaries(path: str, expected: bool) -> None:
    """API 前缀按**路径段**切：``/api`` 与 ``/api/...`` 算，``/apixxx`` 与 ``//api`` 不算。"""
    assert is_api_path(path, "/api") is expected


# ---------------------------------------------------------------- 中间件（ASGI 层）
def _run_middleware(
    scope: dict,
    *,
    websocket_exempt_paths: tuple[str, ...] = (),
    websocket_bearer_paths: tuple[str, ...] = (),
    app: object | None = None,
) -> tuple[list[str], list[dict]]:
    """把中间件跑一遍：返回（到达下游的路径列表, 发出的消息列表）。"""
    reached: list[str] = []
    sent: list[dict] = []

    async def downstream(inner_scope, receive, send):
        reached.append(inner_scope.get("path", ""))

    async def send(message):
        sent.append(message)

    async def receive():
        return {"type": "http.request"}

    middleware = BearerAuthMiddleware(
        downstream,
        api_prefix="/api",
        websocket_exempt_paths=websocket_exempt_paths,
        websocket_bearer_paths=websocket_bearer_paths,
    )
    if app is not None:
        # 中间件从 scope 里取应用状态（令牌在 app.state 上）
        scope = {**scope, "app": app}
    asyncio.run(middleware(scope, receive, send))
    return reached, sent


def _stub_app(token: str) -> SimpleNamespace:
    """带令牌的假应用（中间件只从 ``app.state`` 取当前令牌）。"""
    return SimpleNamespace(state=SimpleNamespace(console_token=token))


def _bearer_websocket_scope(path: str, token: str) -> dict:
    """构造一个带 Bearer 头的 WebSocket scope。"""
    return {
        "type": "websocket",
        "path": path,
        "headers": [(b"authorization", f"Bearer {token}".encode())],
    }


def test_bearer_websocket_scope_with_a_valid_token_reaches_the_route() -> None:
    """Bearer 清单里的 WS 路由（隧道 WS）+ **有效令牌**：放行到路由层。"""
    reached, sent = _run_middleware(
        _bearer_websocket_scope("/api/forward/tunnel/a1b2c3d4e5f6", TEST_TOKEN),
        websocket_bearer_paths=WEBSOCKET_BEARER_PATHS,
        app=_stub_app(TEST_TOKEN),
    )
    assert reached == ["/api/forward/tunnel/a1b2c3d4e5f6"]
    assert sent == []


def test_bearer_websocket_scope_with_an_invalid_token_is_closed_with_1008() -> None:
    """Bearer 清单里的 WS 路由 + **无效令牌**：握手被拒（1008），不进路由层。"""
    reached, sent = _run_middleware(
        _bearer_websocket_scope("/api/forward/tunnel/a1b2c3d4e5f6", "sbx_wrong_token"),
        websocket_bearer_paths=WEBSOCKET_BEARER_PATHS,
        app=_stub_app(TEST_TOKEN),
    )
    assert reached == []
    assert sent == [
        {"type": "websocket.close", "code": CLOSE_CODE_UNAUTHORIZED, "reason": ""}
    ]


def test_api_prefix_check_ignores_the_asgi_root_path() -> None:
    """ASGI ``root_path`` 前缀不参与准入判定：挂在子路径下也不能漏掉鉴权。"""
    reached, sent = _run_middleware(
        {
            "type": "http",
            "path": "/console/api/health",
            "root_path": "/console",
            "headers": [],
        }
    )
    assert reached == []
    assert sent[0]["status"] == 401


def test_websocket_scope_is_denied_without_an_exemption() -> None:
    """未豁免的 WS scope：中间件直接拒握手（fail-closed，不进路由层）。"""
    reached, sent = _run_middleware({"type": "websocket", "path": "/api/whatever", "headers": []})
    assert reached == []
    assert sent == [
        {"type": "websocket.close", "code": CLOSE_CODE_UNAUTHORIZED, "reason": ""}
    ]


def test_exempt_websocket_scope_reaches_the_route() -> None:
    """豁免清单里的 WS scope：放行到路由层（路由自己再鉴权）。"""
    reached, sent = _run_middleware(
        {"type": "websocket", "path": "/api/terminal/sessions/abc", "headers": []},
        websocket_exempt_paths=WEBSOCKET_EXEMPT_PATHS,
    )
    assert reached == ["/api/terminal/sessions/abc"]
    assert sent == []


# ---------------------------------------------------------------- 令牌比较契约
# 令牌**取值**的名字：这些变量的值就是令牌本身（或它的候选值）。
# 对它们做 ``==`` / ``!=`` / ``in`` 比较，就是绕开常量时间比定的破口。
TOKEN_VALUE_NAMES = frozenset(
    {"token", "expected", "candidate", "credentials", "existing", "injected", "source"}
)
# 跨文件扫描时收紧：``injected`` / ``source`` 在别的模块里指别的东西
# （模板注入列表等），只在 auth.py 里按「令牌取值」算。
TOKEN_VALUE_NAMES_CROSS_MODULE = frozenset(
    {"token", "expected", "candidate", "credentials"}
)


def _mentions_token_value(node: ast.AST, names: frozenset[str]) -> bool:
    """比较的任一侧是否涉及令牌**取值**。

    只认「取值」：``TOKEN_FILE_MODE`` 这类常量名里也带 token 字样，但拿它
    做相等比较与令牌安全无关（那是权限位口径）。
    """
    for child in ast.walk(node):
        if isinstance(child, ast.Name) and child.id in names:
            return True
        if isinstance(child, ast.Attribute) and child.attr == "token":
            return True
    return False


def _token_compare_offenders(
    path: Path, names: frozenset[str] = TOKEN_VALUE_NAMES_CROSS_MODULE
) -> list[str]:
    """源码里对令牌取值做 ``==`` / ``!=`` / ``in`` 比较的位置。"""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    offenders: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Compare):
            continue
        if not any(
            isinstance(op, (ast.Eq, ast.NotEq, ast.In, ast.NotIn)) for op in node.ops
        ):
            continue
        if _mentions_token_value(node, names):
            offenders.append(f"{path.name}:{node.lineno}")
    return offenders


def _find_function(tree: ast.AST, name: str) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
    """按名字找函数定义（找不到返回空值）。"""
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            return node
    return None


def test_token_comparisons_never_use_equality_or_membership() -> None:
    """令牌比较一律走 hmac.compare_digest：源码里没有对令牌取值的 == / in 比较。"""
    offenders: list[str] = []
    for path in sorted(BACKEND_SRC.rglob("*.py")):
        offenders.extend(_token_compare_offenders(path))
    assert offenders == []


def test_auth_module_compares_token_values_only_inside_token_matches() -> None:
    """白名单式契约：auth.py 里对令牌取值的比较只允许出现在 token_matches 内。

    结构性断言（不是搜字符串）：解析全文 AST，把 ``token_matches`` 的函数体
    标成白名单，其余任何涉及令牌取值的 ``==`` / ``!=`` / ``in`` 比较都算破口。
    """
    tree = ast.parse((BACKEND_SRC / "auth.py").read_text(encoding="utf-8"))
    matcher = _find_function(tree, "token_matches")
    assert matcher is not None, "auth.py 必须保留 token_matches（常量时间比定的唯一入口）"
    allowed = {id(node) for node in ast.walk(matcher) if isinstance(node, ast.Compare)}
    offenders: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Compare):
            continue
        if not any(
            isinstance(op, (ast.Eq, ast.NotEq, ast.In, ast.NotIn)) for op in node.ops
        ):
            continue
        if id(node) in allowed:
            continue
        if _mentions_token_value(node, TOKEN_VALUE_NAMES):
            offenders.append(f"auth.py:{node.lineno}")
    assert offenders == []


def test_token_matches_calls_compare_digest_structurally() -> None:
    """令牌比对走常量时间函数：AST 上确认 token_matches 里调用了 hmac.compare_digest。"""
    tree = ast.parse((BACKEND_SRC / "auth.py").read_text(encoding="utf-8"))
    matcher = _find_function(tree, "token_matches")
    assert matcher is not None
    calls = [node for node in ast.walk(matcher) if isinstance(node, ast.Call)]
    digest_calls = [
        call
        for call in calls
        if isinstance(call.func, ast.Attribute) and call.func.attr == "compare_digest"
    ]
    assert digest_calls, "token_matches 里必须有 compare_digest 调用"
    for call in digest_calls:
        owner = call.func.value
        assert isinstance(owner, ast.Name) and owner.id == "hmac"
