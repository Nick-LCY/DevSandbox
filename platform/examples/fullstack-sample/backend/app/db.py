"""Postgres 访问层。

每个数据库一条连接池。端到端用例按 worker 独占一个数据库，
用请求头告知本次请求使用哪个库，池按库名惰性创建。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from urllib.parse import urlsplit, urlunsplit

import asyncpg

from .config import Settings, get_settings

# 库名 → 连接池
_pools: dict[str, asyncpg.Pool] = {}


def _url_for_database(base_url: str, database: str) -> str:
    """把连接串里的库名换成另一个，其余部分保持不变。"""
    parts = urlsplit(base_url)
    return urlunsplit((parts.scheme, parts.netloc, f"/{database}", parts.query, parts.fragment))


async def _get_pool(database: str, settings: Settings) -> asyncpg.Pool:
    pool = _pools.get(database)
    if pool is None:
        pool = await asyncpg.create_pool(
            dsn=_url_for_database(settings.database_url, database),
            # min_size 取 0：用例库用完就被销毁，池不保留常驻连接，
            # 免得后台重建连接时撞上“库已不存在”。
            min_size=0,
            max_size=5,
            command_timeout=15,
        )
        _pools[database] = pool
    return pool


async def close_pools() -> None:
    """关闭全部连接池（进程退出时调用）。"""
    for pool in list(_pools.values()):
        await pool.close()
    _pools.clear()


def resolve_database(settings: Settings, header_value: str | None) -> str:
    """按请求头决定本次请求使用哪个数据库。"""
    default_name = urlsplit(settings.database_url).path.lstrip("/") or "sample_app"
    if not settings.db_header_enabled:
        return default_name
    if not header_value:
        return default_name
    # 只允许普通库名，避免拼接出非法连接串。
    candidate = header_value.strip()
    if not candidate or not all(char.isalnum() or char in "_-" for char in candidate):
        return default_name
    return candidate


@asynccontextmanager
async def acquire(database: str) -> AsyncIterator[asyncpg.Connection]:
    """取一条连接。"""
    settings = get_settings()
    pool = await _get_pool(database, settings)
    async with pool.acquire() as connection:
        yield connection


async def fetch_all(database: str, query: str, *args: object) -> list[asyncpg.Record]:
    """查多行。"""
    async with acquire(database) as connection:
        return await connection.fetch(query, *args)


async def fetch_one(database: str, query: str, *args: object) -> asyncpg.Record | None:
    """查一行。"""
    async with acquire(database) as connection:
        return await connection.fetchrow(query, *args)


async def execute(database: str, query: str, *args: object) -> str:
    """执行写语句，返回状态字符串。"""
    async with acquire(database) as connection:
        return await connection.execute(query, *args)
