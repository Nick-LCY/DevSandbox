"""注入副本刷新服务端接口测试：刷新端点 + 详情回显。

全部在临时目录里跑，不碰真实平台数据根，也不碰宿主沙箱与容器：

- 生命周期服务整体替换成假实现（``dependency_overrides``），只提供路由需要的
  那几个方法（**能力本体在核心包** ``sandbox_platform.refresh``，不在服务端）；
- 假实现按需抛核心包的 ``RefreshError``（带 ``reason`` 分类码），验证服务端
  **只按分类码映射状态码**、且**不外泄异常原文**。

覆盖的正例与负例：204（成功、**无内容**）/ 200（详情 additive 字段、既有
``files`` 等字段零回归）/ 400（**带查询参数**、**非空请求体**、**路径字段**、
预校验失败）/ 401（无令牌、错令牌、**只读缓存令牌**）/ 404（未知沙箱、未知
条目、旧实例无条目）/ 409（互斥冲突、生命周期碰锁）/ 500（写入阶段失败：
**可能部分更新**原样回显）。
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sandbox_platform import (
    InjectionRecord,
    MountSpec,
    RefreshError,
    SandboxConflictError,
    SandboxMetadata,
)
from sandbox_platform.refresh import (
    MSG_CONFLICT,
    MSG_ENTRY_NOT_FOUND,
    MSG_INTERNAL,
    MSG_PARTIAL,
    MSG_PRECHECK,
    MSG_SANDBOX_NOT_RUNNING,
    REASON_CONFLICT,
    REASON_INTERNAL,
    REASON_NOT_FOUND,
    REASON_PARTIAL,
    REASON_PRECHECK,
)
from sandbox_console import create_app
from sandbox_console.auth import cache_token_file_path
from sandbox_console.deps import get_service

from conftest import auth_headers

# 刷新端点（挂在 /api 前缀下 ⇒ 自动受 Bearer 令牌中间件保护）
REFRESH_URL = "/api/sandboxes/demo/injections/inj-0-aaaabbbbcccc/refresh"
DETAIL_URL = "/api/sandboxes/demo"

# 一条注入声明的实例事实（源 / 副本 / 容器目标 / 种类 / 副本身份）
ENTRY_ID = "inj-0-aaaabbbbcccc"
SOURCE_PATH = "/srv/secrets/id_ed25519"
STAGED_PATH = "/home/sandbox-demo/.sandbox-files/0/id_ed25519"
CONTAINER_PATH = "/run/secrets/id_ed25519"


# ---------------------------------------------------------------- 夹具与假件
def make_metadata(
    name: str = "demo",
    state: str = "running",
    *,
    with_injection: bool = True,
) -> SandboxMetadata:
    """构造一份沙箱元数据（带一条注入声明与对应的只读副本挂载）。"""
    metadata = SandboxMetadata(
        name=name,
        system_user=f"sandbox-{name}",
        uid=1001,
        gid=1001,
        home=f"/home/sandbox-{name}",
        subid_start=100000,
        subid_length=65536,
        image="busybox:1.37",
        socket_path="/run/user/1001/docker.sock",
        socket_mount_path="/var/run/docker.sock",
        container_name=f"sandbox-{name}",
        container_id="0123456789abcdef",
        network_name=f"{name}-net",
        unit_path=f"/home/sandbox-{name}/.config/systemd/user/docker.service",
        state=state,
        created_at="2026-10-29T01:00:00+00:00",
        updated_at="2026-10-29T01:00:00+00:00",
    )
    if not with_injection:
        # 旧实例：没有注入声明（缺省空列表）
        return metadata
    metadata.files = [
        MountSpec(
            host_path=STAGED_PATH,
            container_path=CONTAINER_PATH,
            read_only=True,
            role="file",
        )
    ]
    metadata.injections = [
        InjectionRecord(
            entry_id=ENTRY_ID,
            source_path=SOURCE_PATH,
            staged_path=STAGED_PATH,
            container_path=CONTAINER_PATH,
            kind="file",
            dev=987654,
            ino=87654321,
        )
    ]
    return metadata


class FakeSandboxService:
    """假的生命周期服务：只提供本文件用到的几个方法。"""

    def __init__(self) -> None:
        self.metadata = make_metadata()
        self.refresh_error: Exception | None = None
        self.stop_error: Exception | None = None
        self.refresh_calls: list[tuple[str, str]] = []
        self.refresh_threads: list[int] = []

    def get(self, name: str) -> SandboxMetadata:
        return self.metadata

    def stop(self, name: str, stop_dependencies: bool = True) -> SandboxMetadata:
        if self.stop_error is not None:
            raise self.stop_error
        return self.metadata

    def refresh_injection(self, name: str, entry_id: str) -> Any:
        """假的刷新入口：只记录调用（**能力本体在核心包**）。"""
        self.refresh_calls.append((name, entry_id))
        self.refresh_threads.append(threading.get_ident())
        if self.refresh_error is not None:
            raise self.refresh_error
        return None


def make_app(service: FakeSandboxService) -> FastAPI:
    """装配应用（生命周期服务整体替换）。"""
    app = create_app()
    app.dependency_overrides[get_service] = lambda: service
    return app


@pytest.fixture
def service() -> FakeSandboxService:
    return FakeSandboxService()


@pytest.fixture
def loop_threads() -> list[int]:
    """记录事件循环线程的标识（中间件在事件循环里跑）。"""
    return []


@pytest.fixture
def client(
    service: FakeSandboxService,
    platform_home: Path,
    loop_threads: list[int],
):
    """测试客户端（生命周期服务整体替换）。"""
    app = make_app(service)

    @app.middleware("http")
    async def _capture_loop_thread(request, call_next):
        loop_threads.append(threading.get_ident())
        return await call_next(request)

    with TestClient(app, headers=auth_headers()) as http_client:
        yield http_client


# ---------------------------------------------------------------- 鉴权
def test_refresh_requires_a_full_token(
    service: FakeSandboxService, platform_home: Path
) -> None:
    """无令牌 / 错令牌：一律 401（**不另写鉴权分支**，靠 /api 中间件）。"""
    app = make_app(service)
    with TestClient(app) as http_client:
        assert http_client.post(REFRESH_URL).status_code == 401
        wrong = http_client.post(
            REFRESH_URL, headers={"Authorization": "Bearer wrong-token"}
        )
        assert wrong.status_code == 401
    # 两次都没走到编排层（鉴权在中间件层就拦住了）
    assert service.refresh_calls == []


def test_readonly_cache_token_cannot_refresh(
    client: TestClient, service: FakeSandboxService, config
) -> None:
    """只读缓存令牌（``sbxr_``）：**不能**刷新（该令牌只放行一条只读读径）。"""
    payload = json.loads(cache_token_file_path(config).read_text(encoding="utf-8"))
    response = client.post(
        REFRESH_URL, headers={"Authorization": f"Bearer {payload['token']}"}
    )
    assert response.status_code == 401
    assert service.refresh_calls == []


# ---------------------------------------------------------------- 成功
def test_refresh_returns_204_without_content(
    client: TestClient, service: FakeSandboxService
) -> None:
    """成功：**204 无内容**（不回正文、不回路径清单）。"""
    response = client.post(REFRESH_URL)
    assert response.status_code == 204
    assert response.content == b""
    assert service.refresh_calls == [("demo", ENTRY_ID)]


def test_refresh_accepts_an_empty_body(
    client: TestClient, service: FakeSandboxService
) -> None:
    """空请求体：正常放行（204）——只有**非空** body 才被拒。"""
    response = client.post(REFRESH_URL, content=b"")
    assert response.status_code == 204
    assert service.refresh_calls == [("demo", ENTRY_ID)]


def test_refresh_runs_off_the_event_loop(
    client: TestClient, service: FakeSandboxService, loop_threads: list[int]
) -> None:
    """阻塞刷新**不进事件循环**：跑在既有线程池里（async 路由不直接调）。"""
    assert client.post(REFRESH_URL).status_code == 204
    assert service.refresh_threads
    assert service.refresh_threads[0] not in loop_threads


# ---------------------------------------------------------------- 入参闸门
def test_refresh_rejects_any_query_param(
    client: TestClient, service: FakeSandboxService
) -> None:
    """带查询参数：一律 400（杜绝「借 query 夹带路径」），**且不触达刷新**。"""
    response = client.post(f"{REFRESH_URL}?source_path=/etc/passwd")
    assert response.status_code == 400
    assert "查询参数" in response.json()["detail"]
    assert service.refresh_calls == []


def test_refresh_rejects_a_non_empty_body(
    client: TestClient, service: FakeSandboxService
) -> None:
    """非空请求体：一律 400（**流式**读，首个非空块即拒），**且不触达刷新**。"""
    response = client.post(
        REFRESH_URL,
        json={"source_path": "/etc/passwd"},
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 400
    assert "请求体" in response.json()["detail"]
    assert service.refresh_calls == []


def test_refresh_rejects_path_fields_in_the_body(
    client: TestClient, service: FakeSandboxService
) -> None:
    """请求体里夹带**路径字段**（源 / 副本 / 容器目标）：一律 400。"""
    for payload in (
        {"source_path": "/etc/passwd"},
        {"staged_path": "/home/sandbox-demo/.sandbox-files/0/x"},
        {"container_path": "/run/secrets/x"},
        {"path": "/etc/shadow"},
    ):
        response = client.post(REFRESH_URL, json=payload)
        assert response.status_code == 400, payload
    assert service.refresh_calls == []


def test_refresh_rejects_a_whitespace_only_body(
    client: TestClient, service: FakeSandboxService
) -> None:
    """只有空白字符的 body 也算**非空**：一律 400。"""
    response = client.post(REFRESH_URL, content=b"   ")
    assert response.status_code == 400
    assert service.refresh_calls == []


# ---------------------------------------------------------------- 失败分类
def test_refresh_unknown_sandbox_or_entry_returns_404(
    client: TestClient, service: FakeSandboxService
) -> None:
    """条目不存在 / 沙箱不存在（旧实例无条目）：404 + 明确中文文案。"""
    service.refresh_error = RefreshError(MSG_ENTRY_NOT_FOUND, reason=REASON_NOT_FOUND)
    response = client.post(REFRESH_URL)
    assert response.status_code == 404
    assert response.json()["detail"] == MSG_ENTRY_NOT_FOUND


def test_refresh_old_instance_without_entries_returns_404(
    client: TestClient, service: FakeSandboxService
) -> None:
    """旧实例（没有注入条目）：无可刷对象 ⇒ 404（不迁移、不补录）。"""
    service.metadata = make_metadata(with_injection=False)
    service.refresh_error = RefreshError(MSG_ENTRY_NOT_FOUND, reason=REASON_NOT_FOUND)
    response = client.post(REFRESH_URL)
    assert response.status_code == 404
    assert response.json()["detail"] == MSG_ENTRY_NOT_FOUND


def test_refresh_precheck_returns_400(
    client: TestClient, service: FakeSandboxService
) -> None:
    """预校验类失败（副本零改动）：400 + 明确文案（源被拒 / 未运行 / 类型改变）。"""
    service.refresh_error = RefreshError(MSG_PRECHECK, reason=REASON_PRECHECK)
    response = client.post(REFRESH_URL)
    assert response.status_code == 400
    assert response.json()["detail"] == MSG_PRECHECK

    service.refresh_error = RefreshError(
        MSG_SANDBOX_NOT_RUNNING, reason=REASON_PRECHECK
    )
    response = client.post(REFRESH_URL)
    assert response.status_code == 400
    assert response.json()["detail"] == MSG_SANDBOX_NOT_RUNNING


def test_refresh_conflict_returns_409(
    client: TestClient, service: FakeSandboxService
) -> None:
    """互斥冲突（刷新与启停删互斥，被拒不排队）：409。"""
    service.refresh_error = RefreshError(MSG_CONFLICT, reason=REASON_CONFLICT)
    response = client.post(REFRESH_URL)
    assert response.status_code == 409
    assert response.json()["detail"] == MSG_CONFLICT


def test_lifecycle_conflict_returns_409(
    client: TestClient, service: FakeSandboxService
) -> None:
    """生命周期操作碰锁（``SandboxConflictError``）：**409**（既有管理面口径）。"""
    service.stop_error = SandboxConflictError(MSG_CONFLICT)
    response = client.post("/api/sandboxes/demo/stop")
    assert response.status_code == 409
    assert response.json()["detail"] == MSG_CONFLICT


def test_refresh_partial_returns_500_with_partial_wording(
    client: TestClient, service: FakeSandboxService
) -> None:
    """写入阶段失败：500 + **原样「可能部分更新」**（不回滚、不续跑）。"""
    service.refresh_error = RefreshError(MSG_PARTIAL, reason=REASON_PARTIAL)
    response = client.post(REFRESH_URL)
    assert response.status_code == 500
    detail = response.json()["detail"]
    assert "可能部分更新" in detail
    assert detail == MSG_PARTIAL


def test_refresh_internal_returns_500(
    client: TestClient, service: FakeSandboxService
) -> None:
    """平台内部异常：500 + 固定文案（副本状态未知，保守按可能部分更新报）。"""
    service.refresh_error = RefreshError(MSG_INTERNAL, reason=REASON_INTERNAL)
    response = client.post(REFRESH_URL)
    assert response.status_code == 500
    detail = response.json()["detail"]
    assert "可能部分更新" in detail
    assert detail == MSG_INTERNAL


def test_refresh_error_text_outside_the_whitelist_is_replaced(
    client: TestClient, service: FakeSandboxService
) -> None:
    """白名单外的异常原文**不外泄**（宿主路径 / 正文一律不进门面）。"""
    service.refresh_error = RefreshError(
        "刷新失败：/root/.ssh/id_ed25519 的正文片段", reason=REASON_PARTIAL
    )
    response = client.post(REFRESH_URL)
    assert response.status_code == 500
    detail = response.json()["detail"]
    assert "/root/.ssh" not in detail
    assert detail == MSG_PARTIAL


# ---------------------------------------------------------------- 详情回显
def test_detail_adds_injections_without_touching_existing_fields(
    client: TestClient,
) -> None:
    """详情**新增** ``injections``（additive）：既有字段零回归。"""
    response = client.get(DETAIL_URL)
    assert response.status_code == 200
    body = response.json()
    # 既有字段原样
    assert body["name"] == "demo"
    assert body["state"] == "running"
    assert body["files"] == [
        {
            "host_path": STAGED_PATH,
            "container_path": CONTAINER_PATH,
            "read_only": True,
            "role": "file",
        }
    ]
    # 新增字段
    assert body["injections"] == [
        {
            "entry_id": ENTRY_ID,
            "source_path": SOURCE_PATH,
            "container_path": CONTAINER_PATH,
            "kind": "file",
            "read_only": True,
            "can_refresh": True,
        }
    ]


def test_detail_injections_expose_metadata_only(
    client: TestClient,
) -> None:
    """注入条目**只暴露元数据**：无托管副本内部路径、无 inode、无正文。

    托管副本路径仍出现在**既有的** ``files`` 字段里（那是既有语义，本轮
    **零回归**）；本条只保证 ``injections`` 里的每条**不重复暴露**它。
    """
    body = client.get(DETAIL_URL).json()
    entry = body["injections"][0]
    assert set(entry) == {
        "entry_id",
        "source_path",
        "container_path",
        "kind",
        "read_only",
        "can_refresh",
    }
    raw = json.dumps(entry, ensure_ascii=False)
    assert STAGED_PATH not in raw
    assert "staged_path" not in raw
    assert "87654321" not in raw  # 副本的 inode
    assert "987654" not in raw  # 副本的 st_dev


def test_detail_old_instance_has_empty_injections(
    client: TestClient, service: FakeSandboxService
) -> None:
    """旧实例：该字段为空列表（无刷新条目），其余字段照旧。"""
    service.metadata = make_metadata(with_injection=False)
    body = client.get(DETAIL_URL).json()
    assert body["injections"] == []
    assert body["files"] == []


def test_detail_stopped_sandbox_entries_are_not_refreshable(
    client: TestClient, service: FakeSandboxService
) -> None:
    """沙箱未运行：条目的 ``can_refresh`` 为 false（刷不动就不给入口）。"""
    service.metadata = make_metadata(state="stopped")
    body = client.get(DETAIL_URL).json()
    assert body["injections"][0]["can_refresh"] is False
