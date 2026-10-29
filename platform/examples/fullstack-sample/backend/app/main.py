"""全栈示例后端。

对外提供：
  - 静态前端（构建产物）与 SPA 回落；
  - Logto OIDC 授权码登录（发起、换 token、当前用户、登出）；
  - 记录读写（Postgres 业务表）；
  - 附件上传下载（MinIO，走 S3 协议）。
"""

from __future__ import annotations

import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import auth, db, storage
from .config import get_settings
from .db import resolve_database

SESSION_COOKIE = "sample_session"

app = FastAPI(title="全栈示例后端", version="0.1.0")


# ---------------------------------------------------------------- 依赖
async def current_session(request: Request) -> auth.AppSession:
    """从会话 Cookie 里取当前会话（含用户信息与本次会话使用的数据库）。"""
    raw = request.cookies.get(SESSION_COOKIE)
    session = auth.read_session(auth.verify_session_cookie(raw))
    if session is None:
        raise HTTPException(status_code=401, detail="未登录")
    return session


async def database_for(
    request: Request,
    session: auth.AppSession = Depends(current_session),
) -> str:
    """本次请求使用的数据库名。

    会话在登录换 token 时记下当时选定的数据库，之后一律按会话走：
    端到端用例按 worker 独占一个数据库，浏览器后续的普通请求与文件下载
    都会落到同一个库里。
    """
    settings = get_settings()
    if session.database:
        return session.database
    return resolve_database(settings, request.headers.get(settings.db_header_name))


# ---------------------------------------------------------------- 生命周期
@app.on_event("startup")
async def on_startup() -> None:
    """启动时确保 MinIO 桶存在。"""
    try:
        storage.ensure_bucket()
    except Exception as error:  # pragma: no cover - 启动期失败不阻断进程
        print(f"[app] MinIO 桶检查失败（稍后由请求重试）：{error}")


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await db.close_pools()


# ---------------------------------------------------------------- 基础接口
@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    """健康检查：不碰数据库与对象存储，只证明进程活着。"""
    return {"status": "ok", "service": "fullstack-sample-backend"}


@app.get("/api/config")
async def api_config() -> dict[str, Any]:
    """前端启动时需要的少量配置。"""
    settings = get_settings()
    return {
        "appBaseUrl": settings.app_base_url,
        "redirectUri": auth.effective_redirect_uri(settings),
    }


# ---------------------------------------------------------------- 登录
@app.post("/api/auth/login")
async def api_login() -> dict[str, Any]:
    """发起登录：返回 Logto 授权地址，前端把浏览器导航过去。"""
    try:
        authorize_url = await auth.start_login()
    except auth.AuthError as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error
    return {"authorizeUrl": authorize_url}


@app.post("/api/auth/exchange")
async def api_exchange(
    payload: dict[str, Any],
    request: Request,
    x_sample_database: str | None = Header(default=None),
) -> JSONResponse:
    """回调换 token：校验 id_token 后建立应用会话。"""
    code = str(payload.get("code") or "")
    state = str(payload.get("state") or "")
    if not code or not state:
        raise HTTPException(status_code=400, detail="缺少 code 或 state")
    settings = get_settings()
    header_value = x_sample_database or request.headers.get(settings.db_header_name)
    database = resolve_database(settings, header_value) if header_value else None
    try:
        token, session = await auth.exchange_code(code, state, database=database)
    except auth.AuthError as error:
        raise HTTPException(status_code=error.status_code, detail=error.message) from error

    response = JSONResponse({"user": session.user.to_dict()})
    response.set_cookie(
        SESSION_COOKIE,
        auth.sign_session_cookie(token),
        httponly=True,
        samesite="lax",
        path="/",
        max_age=settings.session_ttl_seconds,
    )
    return response


@app.post("/api/auth/logout")
async def api_logout(request: Request) -> JSONResponse:
    """登出：销毁应用会话。"""
    raw = request.cookies.get(SESSION_COOKIE)
    auth.drop_session(auth.verify_session_cookie(raw))
    response = JSONResponse({"ok": True})
    response.delete_cookie(SESSION_COOKIE, path="/")
    return response


@app.get("/api/me")
async def api_me(request: Request) -> dict[str, Any]:
    """当前登录用户；未登录返回 user=null。"""
    raw = request.cookies.get(SESSION_COOKIE)
    session = auth.read_session(auth.verify_session_cookie(raw))
    return {"user": session.user.to_dict() if session else None}


# ---------------------------------------------------------------- 记录
def _record_to_dict(row: Any) -> dict[str, Any]:
    created_at = row["created_at"]
    return {
        "id": str(row["id"]),
        "title": row["title"],
        "content": row["content"],
        "ownerId": row["owner_id"],
        "ownerName": row["owner_name"],
        "objectKey": row["object_key"],
        "objectName": row["object_name"],
        "objectSize": int(row["object_size"]) if row["object_size"] is not None else None,
        "contentType": row["content_type"],
        "createdAt": created_at.isoformat() if isinstance(created_at, datetime) else None,
    }


@app.get("/api/records")
async def api_list_records(
    database: str = Depends(database_for),
    session: auth.AppSession = Depends(current_session),
) -> dict[str, Any]:
    """列出全部记录（按创建时间倒序）。"""
    rows = await db.fetch_all(
        database,
        """
        SELECT id, title, content, owner_id, owner_name,
               object_key, object_name, object_size, content_type, created_at
        FROM sample_records
        ORDER BY created_at DESC, id DESC
        """,
    )
    return {"records": [_record_to_dict(row) for row in rows]}


@app.post("/api/records")
async def api_create_record(
    title: str = Form(...),
    content: str = Form(default=""),
    file: UploadFile | None = File(default=None),
    database: str = Depends(database_for),
    session: auth.AppSession = Depends(current_session),
) -> dict[str, Any]:
    """新建一条记录；带附件时同时把文件传到 MinIO。"""
    user = session.user
    record_id = str(uuid.uuid4())
    object_key: str | None = None
    object_name: str | None = None
    object_size: int | None = None
    content_type: str | None = None

    if file is not None and file.filename:
        payload = await file.read()
        if payload:
            object_key = storage.build_object_key(record_id, file.filename)
            stored = storage.put_object(
                object_key, payload, file.content_type or "application/octet-stream"
            )
            object_name = file.filename
            object_size = stored.size
            content_type = stored.content_type

    await db.execute(
        database,
        """
        INSERT INTO sample_records
            (id, title, content, owner_id, owner_name,
             object_key, object_name, object_size, content_type)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        """,
        record_id,
        title,
        content,
        user.id,
        user.name,
        object_key,
        object_name,
        object_size,
        content_type,
    )
    row = await db.fetch_one(
        database,
        """
        SELECT id, title, content, owner_id, owner_name,
               object_key, object_name, object_size, content_type, created_at
        FROM sample_records WHERE id = $1
        """,
        record_id,
    )
    if row is None:
        raise HTTPException(status_code=500, detail="记录写入后读不回来")
    return {"record": _record_to_dict(row)}


@app.get("/api/records/{record_id}/file")
async def api_download_record_file(
    record_id: str,
    database: str = Depends(database_for),
    session: auth.AppSession = Depends(current_session),
) -> Response:
    """从 MinIO 下载附件（走 S3 协议真实取回字节）。"""
    row = await db.fetch_one(
        database,
        "SELECT object_key, object_name, content_type FROM sample_records WHERE id = $1",
        record_id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="记录不存在")
    if not row["object_key"]:
        raise HTTPException(status_code=404, detail="该记录没有附件")
    payload, content_type = storage.get_object(row["object_key"])
    filename = row["object_name"] or "file.bin"
    return Response(
        content=payload,
        media_type=row["content_type"] or content_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------- 静态前端
def _mount_frontend() -> None:
    """挂载前端构建产物；不存在时留一个占位页，保证根路径可用。"""
    dist = Path(get_settings().frontend_dist)
    if not dist.is_dir():
        @app.get("/")
        async def missing_frontend() -> JSONResponse:
            return JSONResponse(
                {"error": "前端构建产物不存在", "expected": str(dist)}, status_code=500
            )

        return

    app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str) -> Response:
        """SPA 回落：静态文件优先，其余路径一律回 index.html。"""
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="未知接口")
        candidate = (dist / full_path).resolve() if full_path else None
        if candidate is not None and candidate.is_file() and str(candidate).startswith(str(dist.resolve())):
            return FileResponse(candidate)
        return FileResponse(dist / "index.html")


_mount_frontend()
