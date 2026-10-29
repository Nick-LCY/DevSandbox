"""Logto OIDC 授权码登录。

流程（前端跳 Logto 登录页 → 回调 → 后端校验 id_token → 返回用户信息）：

1. ``POST /api/auth/login``：后端建一个登录会话（state / code_verifier / nonce），
   返回 Logto 授权地址；前端把浏览器导航过去，浏览器停在 Logto 的真实登录页。
2. Logto 登录成功后 302 回 ``redirect_uri?code=...&state=...``。
3. ``POST /api/auth/exchange``：后端用 code_verifier 换 token，
   拉 Logto 的 JWKS 校验 id_token 签名与声明，再建自己的会话并返回用户信息。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
import jwt
from jwt import PyJWK

from .config import Settings, effective_redirect_uri, get_settings, oidc_issuer

# 登录会话：state → 登录上下文
_login_sessions: dict[str, dict[str, Any]] = {}
# 应用会话：token → 用户信息
_user_sessions: dict[str, dict[str, Any]] = {}

_JWKS_CACHE: dict[str, Any] = {"fetched_at": 0.0, "keys": {}}
_JWKS_TTL_SECONDS = 300.0


@dataclass
class UserInfo:
    """前端看到的用户信息。"""

    id: str
    name: str
    email: str | None = None
    username: str | None = None
    picture: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "email": self.email,
            "username": self.username,
            "picture": self.picture,
        }


@dataclass
class AppSession:
    """应用会话：用户信息 + 本次会话使用的数据库名。"""

    user: UserInfo
    database: str | None = None


@dataclass
class LoginSession:
    """一次登录的上下文。"""

    state: str
    code_verifier: str
    nonce: str
    created_at: float = field(default_factory=time.time)


class AuthError(Exception):
    """认证失败。"""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


# ---------------------------------------------------------------- 基础工具
def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _pkce_pair() -> tuple[str, str]:
    """生成 (code_verifier, code_challenge)。"""
    verifier = _b64url(secrets.token_bytes(48))
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


def _prune_expired(now: float) -> None:
    """清掉过期会话。"""
    for state, session in list(_login_sessions.items()):
        if now - float(session["created_at"]) > 900:
            _login_sessions.pop(state, None)
    for token, session in list(_user_sessions.items()):
        if now - float(session["created_at"]) > 86400:
            _user_sessions.pop(token, None)


# ---------------------------------------------------------------- 授权码流程
async def start_login(settings: Settings | None = None) -> str:
    """建登录会话，返回 Logto 授权地址。"""
    conf = settings or get_settings()
    if not conf.logto_client_id:
        raise AuthError("后端未配置 Logto 客户端（LOGTO_CLIENT_ID 为空）", status_code=500)

    _prune_expired(time.time())
    verifier, challenge = _pkce_pair()
    state = _b64url(secrets.token_bytes(24))
    nonce = _b64url(secrets.token_bytes(16))
    session = LoginSession(state=state, code_verifier=verifier, nonce=nonce)
    _login_sessions[state] = {
        "state": session.state,
        "code_verifier": session.code_verifier,
        "nonce": session.nonce,
        "created_at": session.created_at,
    }

    params = {
        "client_id": conf.logto_client_id,
        "response_type": "code",
        "redirect_uri": effective_redirect_uri(conf),
        "scope": "openid profile email",
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    query = "&".join(f"{key}={_url_quote(value)}" for key, value in params.items())
    return f"{conf.logto_endpoint.rstrip('/')}/oidc/auth?{query}"


def _url_quote(value: str) -> str:
    from urllib.parse import quote

    return quote(value, safe="")


async def exchange_code(
    code: str,
    state: str,
    database: str | None = None,
    settings: Settings | None = None,
) -> tuple[str, AppSession]:
    """用授权码换 token、校验 id_token，返回（会话令牌, 会话）。"""
    conf = settings or get_settings()
    login_session = _login_sessions.pop(state, None)
    if login_session is None:
        raise AuthError("登录会话不存在或已过期，请重新发起登录", status_code=400)

    token_payload = await _exchange_authorization_code(code, login_session, conf)
    id_token = token_payload.get("id_token")
    if not id_token:
        raise AuthError("Logto 没有返回 id_token", status_code=502)

    claims = await verify_id_token(id_token, login_session["nonce"], conf)

    user = UserInfo(
        id=str(claims.get("sub", "")),
        name=str(claims.get("name") or claims.get("preferred_username") or claims.get("sub", "")),
        email=claims.get("email"),
        username=claims.get("preferred_username"),
        picture=claims.get("picture"),
    )
    token = _b64url(secrets.token_bytes(32))
    _user_sessions[token] = {
        "user": user.to_dict(),
        "database": database,
        "created_at": time.time(),
    }
    return token, AppSession(user=user, database=database)


async def _exchange_authorization_code(
    code: str, login_session: dict[str, Any], settings: Settings
) -> dict[str, Any]:
    """走 token 端点换 token（客户端密钥用 client_secret_basic 传）。"""
    endpoint = f"{settings.logto_endpoint.rstrip('/')}/oidc/token"
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": effective_redirect_uri(settings),
        "code_verifier": login_session["code_verifier"],
    }
    auth = (settings.logto_client_id, settings.logto_client_secret)
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(endpoint, data=data, auth=auth)
    if response.status_code != 200:
        raise AuthError(
            f"Logto token 端点返回 {response.status_code}：{response.text[:200]}",
            status_code=502,
        )
    return response.json()


async def _jwks(settings: Settings) -> dict[str, Any]:
    """取 JWKS（带缓存）。"""
    now = time.time()
    if now - float(_JWKS_CACHE["fetched_at"]) < _JWKS_TTL_SECONDS:
        return _JWKS_CACHE["keys"]
    url = f"{oidc_issuer(settings)}/jwks"
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.get(url)
    response.raise_for_status()
    keys = {key["kid"]: key for key in response.json().get("keys", []) if key.get("kid")}
    _JWKS_CACHE["fetched_at"] = now
    _JWKS_CACHE["keys"] = keys
    return keys


async def verify_id_token(
    id_token: str, nonce: str, settings: Settings | None = None
) -> dict[str, Any]:
    """校验 id_token：签名、issuer、audience、有效期、nonce。"""
    conf = settings or get_settings()
    try:
        header = jwt.get_unverified_header(id_token)
    except jwt.PyJWTError as error:
        raise AuthError(f"id_token 头部解析失败：{error}", status_code=502) from error

    kid = header.get("kid")
    keys = await _jwks(conf)
    jwk = keys.get(kid) if kid else None
    if jwk is None:
        raise AuthError(f"Logto 的 JWKS 里找不到 kid={kid}", status_code=502)

    algorithm = header.get("alg", "RS256")
    try:
        key = PyJWK.from_dict(jwk, algorithm=algorithm).key
        claims = jwt.decode(
            id_token,
            key,
            algorithms=[algorithm],
            audience=conf.logto_client_id,
            issuer=oidc_issuer(conf),
            options={"require": ["exp", "iat", "sub", "aud", "iss"]},
        )
    except jwt.PyJWTError as error:
        raise AuthError(f"id_token 校验失败：{error}", status_code=401) from error

    if claims.get("nonce") != nonce:
        raise AuthError("id_token 的 nonce 与登录会话不一致", status_code=401)
    return claims


# ---------------------------------------------------------------- 应用会话
def create_session(user: UserInfo, database: str | None = None) -> str:
    """建应用会话。"""
    token = _b64url(secrets.token_bytes(32))
    _user_sessions[token] = {
        "user": user.to_dict(),
        "database": database,
        "created_at": time.time(),
    }
    return token


def read_session(token: str | None) -> AppSession | None:
    """读应用会话。"""
    if not token:
        return None
    session = _user_sessions.get(token)
    if session is None:
        return None
    if time.time() - float(session["created_at"]) > 86400:
        _user_sessions.pop(token, None)
        return None
    data = session["user"]
    user = UserInfo(
        id=data["id"],
        name=data["name"],
        email=data.get("email"),
        username=data.get("username"),
        picture=data.get("picture"),
    )
    return AppSession(user=user, database=session.get("database"))


def drop_session(token: str | None) -> None:
    """销毁应用会话。"""
    if token:
        _user_sessions.pop(token, None)


def sign_session_cookie(token: str, settings: Settings | None = None) -> str:
    """生成带签名的会话 Cookie 值。"""
    conf = settings or get_settings()
    signature = hmac.new(
        conf.session_secret.encode("utf-8"), token.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return f"{token}.{signature}"


def verify_session_cookie(value: str | None, settings: Settings | None = None) -> str | None:
    """校验会话 Cookie，返回原始令牌。"""
    if not value or "." not in value:
        return None
    token, _, signature = value.rpartition(".")
    conf = settings or get_settings()
    expected = hmac.new(
        conf.session_secret.encode("utf-8"), token.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, signature):
        return None
    return token


def debug_dump() -> str:  # pragma: no cover - 仅排查用
    """把当前会话状态打成 JSON（排查用）。"""
    return json.dumps(
        {
            "login_sessions": len(_login_sessions),
            "user_sessions": len(_user_sessions),
        },
        ensure_ascii=False,
    )
