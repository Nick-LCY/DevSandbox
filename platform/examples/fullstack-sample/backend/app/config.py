"""运行期配置。

全部配置一律走环境变量，默认值全部指向沙箱网内的容器名（不使用本机回环地址）。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return default if value is None or value.strip() == "" else value.strip()


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw.strip())
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    """后端运行期配置快照。"""

    # ---------------------------------------------------------------- 数据库
    database_url: str = field(
        default_factory=lambda: _env(
            "DATABASE_URL", "postgres://postgres:postgres@postgres:5432/sample_app"
        )
    )
    # 端到端用例按 worker 独占一个数据库，用请求头告知后端切到哪个库。
    db_header_enabled: bool = field(
        default_factory=lambda: _env_bool("SAMPLE_DB_HEADER_ENABLED", False)
    )
    db_header_name: str = field(
        default_factory=lambda: _env("SAMPLE_DB_HEADER_NAME", "x-sample-database")
    )

    # ---------------------------------------------------------------- 对象存储
    minio_endpoint: str = field(default_factory=lambda: _env("MINIO_ENDPOINT", "minio:9000"))
    minio_access_key: str = field(
        default_factory=lambda: _env("MINIO_ACCESS_KEY", "sampleaccess")
    )
    minio_secret_key: str = field(
        default_factory=lambda: _env("MINIO_SECRET_KEY", "samplesecret123")
    )
    minio_bucket: str = field(default_factory=lambda: _env("MINIO_BUCKET", "sample-records"))
    minio_secure: bool = field(default_factory=lambda: _env_bool("MINIO_SECURE", False))
    minio_region: str = field(default_factory=lambda: _env("MINIO_REGION", "us-east-1"))

    # ---------------------------------------------------------------- 身份认证
    logto_endpoint: str = field(default_factory=lambda: _env("LOGTO_ENDPOINT", "http://logto:3001"))
    logto_client_id: str = field(default_factory=lambda: _env("LOGTO_CLIENT_ID", ""))
    logto_client_secret: str = field(default_factory=lambda: _env("LOGTO_CLIENT_SECRET", ""))
    # 浏览器侧回调地址：浏览器把 http:// 导航升级成 https://，所以登记 https。
    app_base_url: str = field(default_factory=lambda: _env("APP_BASE_URL", "https://app:8000"))
    redirect_uri: str = field(default_factory=lambda: _env("LOGTO_REDIRECT_URI", ""))
    session_secret: str = field(
        default_factory=lambda: _env("SESSION_SECRET", "sample-session-secret-change-me")
    )
    session_ttl_seconds: int = field(default_factory=lambda: _env_int("SESSION_TTL_SECONDS", 3600))

    # ---------------------------------------------------------------- 静态资源
    frontend_dist: str = field(
        default_factory=lambda: _env("FRONTEND_DIST", "/opt/sample/frontend/dist")
    )
    # 明文端口（uvicorn）与对外端口（双协议代理监听）。
    internal_port: int = field(default_factory=lambda: _env_int("INTERNAL_PORT", 8001))
    public_port: int = field(default_factory=lambda: _env_int("PUBLIC_PORT", 8000))


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """取配置快照（进程内缓存）。"""
    return Settings()


def oidc_issuer(settings: Settings | None = None) -> str:
    """OIDC issuer：Logto 的 OpenID 配置根地址。"""
    conf = settings or get_settings()
    return f"{conf.logto_endpoint.rstrip('/')}/oidc"


def effective_redirect_uri(settings: Settings | None = None) -> str:
    """实际使用的回调地址。"""
    conf = settings or get_settings()
    if conf.redirect_uri:
        return conf.redirect_uri
    return f"{conf.app_base_url.rstrip('/')}/auth/callback"
