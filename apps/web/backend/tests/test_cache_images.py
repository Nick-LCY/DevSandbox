"""镜像缓存清单端点与受限令牌的测试。

覆盖四块（对齐 PRD 验收 8~15）：

- **鉴权矩阵**（PRD 12）：完整令牌对新端点与既有 API 照旧；受限令牌仅
  ``GET /api/proxy/cache/images`` 放行，对其余路径与非 GET 方法一律 401。
- **两格式与校验**（PRD 9/10/11）：json / text 缺省与显式、422、text 与
  json 共享同一份扫描结果（同一生成时间戳）。
- **TTL 与失败语义**（PRD 14/15）：可注入时钟 + 伪扫描器钉 60 秒与 503。
- **凭据文件与轮换**（PRD 13 / PRD 20 服务端半边）：正常 / 已存在 / 缺失 /
  损坏四情形；运行中重写凭据文件旧令牌立即 401、新令牌生效（无需重启）。

宿主不进场：扫描器用伪扫描器注入（依赖 ``dependency_overrides``），时钟可
注入（``FakeClock``），数据根重定向到临时目录（conftest 的 ``platform_home``）。
"""

from __future__ import annotations

import logging
import stat
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from sandbox_console import create_app
from sandbox_console.auth import (
    AUTH_FAILED_DETAIL,
    CACHE_IMAGES_METHOD,
    CACHE_IMAGES_PATH,
    CACHE_TOKEN_FILENAME,
    CACHE_TOKEN_PREFIX,
    CLOSE_CODE_UNAUTHORIZED,
    TOKEN_FILENAME,
    cache_token_file_path,
    read_token_file,
    restricted_access_allowed,
    write_token_file,
)
from sandbox_console.cache_images import (
    CACHE_IMAGES_TTL_SECONDS,
    CacheImagesCache,
    render_cache_images_text,
)
from sandbox_console.deps import get_cache_images_cache
from sandbox_platform import (
    CacheScanError,
    CacheScanResult,
    CachedImage,
    PlatformConfig,
)

from conftest import TEST_TOKEN, auth_headers

# 测试专用受限令牌（已知值：预写凭据文件，供鉴权矩阵使用）
RESTRICTED_TOKEN = "sbxr_test_restricted_token_0123456789"

DIGEST_A = "sha256:" + "a" * 64
DIGEST_B = "sha256:" + "b" * 64
DIGEST_C = "sha256:" + "c" * 64


# ---------------------------------------------------------------- 伪扫描器与时钟
def make_image(
    repo: str = "library/postgres",
    tags: tuple[str, ...] = ("16",),
    digest: str = DIGEST_A,
    size: int = 123,
    cached_at: str = "2026-11-14T01:00:00+00:00",
) -> CachedImage:
    """构造一条清单条目。"""
    return CachedImage(
        repo=repo,
        tags=tuple(tags),
        digest=digest,
        total_size_bytes=size,
        cached_at=cached_at,
    )


def make_result(
    generated_at: str = "2026-11-15T00:00:00+00:00",
    images: tuple[CachedImage, ...] = (),
) -> CacheScanResult:
    """构造一次扫描结果。"""
    return CacheScanResult(
        generated_at=generated_at,
        images=tuple(images),
        total_files=7,
        blob_files=5,
        skipped_files=1,
    )


class FakeClock:
    """假时钟：手动推进（钉 TTL 边界，不落真实睡眠）。"""

    def __init__(self, now: float = 0.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeScanner:
    """伪扫描器：计数扫描调用，按预设返回结果或抛错。

    ``results`` 有多个时按序弹出（每次扫描结果不同，钉「过期后重扫时间戳
    更新」）；只有一个或为空时每次返回同一份。
    """

    def __init__(
        self,
        results: list[CacheScanResult] | None = None,
        error: Exception | None = None,
    ) -> None:
        self.calls = 0
        self.results = list(results) if results else [make_result()]
        self.error = error

    def scan(self, now: float | None = None) -> CacheScanResult:
        self.calls += 1
        if self.error is not None:
            raise self.error
        if len(self.results) > 1:
            return self.results.pop(0)
        return self.results[0]


class FlakyScanner:
    """先失败后成功的伪扫描器（钉「失败不入缓存、下一次请求重试」）。"""

    def __init__(self, error: Exception, result: CacheScanResult) -> None:
        self.calls = 0
        self._error = error
        self._result = result

    def scan(self, now: float | None = None) -> CacheScanResult:
        self.calls += 1
        if self.calls == 1:
            raise self._error
        return self._result


# ---------------------------------------------------------------- 装配辅助
def write_cache_token(home: Path, token: str) -> Path:
    """往（临时）数据根预写受限凭据文件（复用原子写先例，0600）。"""
    path = home / CACHE_TOKEN_FILENAME
    write_token_file(path, token)
    return path


def build_client(
    platform_home: Path,
    cache: CacheImagesCache | None = None,
    token: str | None = TEST_TOKEN,
) -> TestClient:
    """测试客户端（ ``cache`` 注入伪扫描器缓存；``token=None`` 则不带认证头）。"""
    app = create_app()
    if cache is not None:
        app.dependency_overrides[get_cache_images_cache] = lambda: cache
    headers = auth_headers(token) if token else None
    return TestClient(app, headers=headers)


def restricted_cache(**kwargs: Any) -> CacheImagesCache:
    """按参数装配的缓存实例（整个测试共用一个实例——json/text 共享的钉子）。"""
    clock = kwargs.pop("clock", FakeClock())
    scanner = kwargs.pop("scanner", FakeScanner())
    return CacheImagesCache(lambda: scanner, clock=clock, **kwargs)


@pytest.fixture
def restricted_token(platform_home: Path) -> str:
    """预写受限凭据文件（已知值），启动时沿用不覆盖。"""
    write_cache_token(platform_home, RESTRICTED_TOKEN)
    return RESTRICTED_TOKEN


# ---------------------------------------------------------------- 鉴权矩阵（PRD 12）
def test_full_token_keeps_working_on_new_endpoint_and_existing_api(
    platform_home: Path, restricted_token: str
) -> None:
    """完整令牌对新端点与既有 API 一切照旧 200（现状不变的钉子）。"""
    cache = restricted_cache()
    with build_client(platform_home, cache=cache) as client:
        assert client.get(CACHE_IMAGES_PATH).status_code == 200
        assert client.get("/api/health").status_code == 200


def test_restricted_token_only_allowed_on_cache_images_get(
    platform_home: Path, restricted_token: str
) -> None:
    """受限令牌仅 GET /api/proxy/cache/images 200；其余路径与非 GET 一律 401。

    逐格（PRD 12）：GET /api/proxy/status、GET /api/sandboxes、GET /api/health
    与对新端点 POST、POST /api/auth/ticket（换票据是全权能力）全部 401。
    """
    cache = restricted_cache()
    headers = auth_headers(RESTRICTED_TOKEN)
    with build_client(platform_home, cache=cache) as client:
        assert client.get(CACHE_IMAGES_PATH, headers=headers).status_code == 200
        assert client.get("/api/proxy/status", headers=headers).status_code == 401
        assert client.get("/api/sandboxes", headers=headers).status_code == 401
        assert client.get("/api/health", headers=headers).status_code == 401
        assert client.post(CACHE_IMAGES_PATH, headers=headers).status_code == 401
        assert client.post("/api/auth/ticket", headers=headers).status_code == 401


def test_restricted_token_cannot_open_tunnel_websocket(
    platform_home: Path, restricted_token: str
) -> None:
    """受限令牌打不开隧道 WS：握手在 accept 之前被拒（1008）。"""
    with build_client(platform_home) as client:
        with pytest.raises(WebSocketDisconnect) as excinfo:
            with client.websocket_connect(
                "/api/forward/tunnel/abc", headers=auth_headers(RESTRICTED_TOKEN)
            ):
                pass
    assert excinfo.value.code == CLOSE_CODE_UNAUTHORIZED


@pytest.mark.parametrize(
    "path,method,expected",
    [
        (CACHE_IMAGES_PATH, CACHE_IMAGES_METHOD, True),
        (CACHE_IMAGES_PATH, "POST", False),
        (CACHE_IMAGES_PATH, "HEAD", False),
        (CACHE_IMAGES_PATH + "/", "GET", False),
        (CACHE_IMAGES_PATH + "/extra", "GET", False),
        ("/api/proxy/status", "GET", False),
        ("/api/auth/ticket", "POST", False),
    ],
    ids=["get-exact", "post", "head", "trailing-slash", "subpath", "other-path", "ticket"],
)
def test_restricted_access_gate_is_route_and_method_bounded(
    path: str, method: str, expected: bool
) -> None:
    """限界判定按路由 + 方法双钉：全等比对，变体路径与非 GET 都不放行。"""
    assert restricted_access_allowed(path, method) is expected


# ---------------------------------------------------------------- 401 负例（PRD 8）
@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": ""},
        {"Authorization": f"Bearer {TEST_TOKEN}_wrong"},
        {"Authorization": "Bearer sbxr_wrong_restricted_token_value"},
    ],
    ids=["no-credentials", "empty", "wrong-full-token", "wrong-restricted-token"],
)
def test_401_negatives_fixed_message_without_leaking_paths(
    platform_home: Path,
    restricted_token: str,
    headers: dict[str, str],
) -> None:
    """401 负例四格：固定中文文案，不泄露宿主路径与凭据文件名，不回显令牌。

    客户端不带默认认证头（默认头会与逐请求头合并，钉不住「无凭据」格）。
    """
    with build_client(platform_home, token=None) as client:
        response = client.get(CACHE_IMAGES_PATH, headers=headers)
    assert response.status_code == 401
    assert response.json() == {"detail": AUTH_FAILED_DETAIL}
    body = response.text
    assert str(platform_home) not in body
    assert CACHE_TOKEN_FILENAME not in body
    assert TOKEN_FILENAME not in body
    assert "sbxr_wrong_restricted_token_value" not in body


# ---------------------------------------------------------------- 两格式与 422（PRD 9/10/11）
def test_json_format_default_and_explicit(
    platform_home: Path, restricted_token: str
) -> None:
    """json（缺省同显式）：生成时间戳 + 清单数组，Content-Type: application/json。"""
    result = make_result(images=(make_image(),))
    cache = restricted_cache(scanner=FakeScanner(results=[result]))
    with build_client(platform_home, cache=cache) as client:
        responses = [
            client.get(CACHE_IMAGES_PATH),
            client.get(CACHE_IMAGES_PATH + "?format=json"),
        ]
    for response in responses:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/json")
    payload = responses[1].json()
    assert payload["generated_at"] == "2026-11-15T00:00:00+00:00"
    (image,) = payload["images"]
    # 字段同验收 5：仓库 / 标签列表 / digest / 总大小 / 缓存时间
    assert image["repo"] == "library/postgres"
    assert image["tags"] == ["16"]
    assert image["digest"] == DIGEST_A
    assert image["total_size_bytes"] == 123
    assert image["cached_at"] == "2026-11-14T01:00:00+00:00"


def test_text_format_is_prerendered_plain_text(
    platform_home: Path, restricted_token: str
) -> None:
    """text：预渲染文本（text/plain），表头 + 逐行条目 + 生成时间 + 防误读说明。"""
    result = make_result(images=(make_image(),))
    cache = restricted_cache(scanner=FakeScanner(results=[result]))
    headers = auth_headers(RESTRICTED_TOKEN)
    with build_client(platform_home, cache=cache) as client:
        response = client.get(CACHE_IMAGES_PATH + "?format=text", headers=headers)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    text = response.text
    assert "镜像缓存清单" in text  # 表头
    assert "生成时间：2026-11-15T00:00:00+00:00" in text  # 生成时间
    assert "仓库：library/postgres" in text  # 逐行条目
    assert "标签：16" in text
    assert f"摘要：{DIGEST_A}" in text
    assert "链大小：123 字节" in text
    assert "缓存时间：2026-11-14T01:00:00+00:00" in text
    # 防误读说明在场（表头/尾注）
    assert "不可把各条链大小求和" in text
    assert "后者标签列表为空" in text


@pytest.mark.parametrize("value", ["xml", "", "JSON", "json "])
def test_format_invalid_value_returns_422(
    platform_home: Path, restricted_token: str, value: str
) -> None:
    """format 非法值 → 422（大小写敏感、空串也非法）。"""
    cache = restricted_cache()
    with build_client(platform_home, cache=cache) as client:
        response = client.get(CACHE_IMAGES_PATH + f"?format={value}")
    assert response.status_code == 422
    assert "format" in response.json()["detail"]


# ---------------------------------------------------------------- TTL（PRD 14）
def test_ttl_constant_is_pinned_to_60_seconds() -> None:
    """TTL 钉值 60 秒：常量被改动时测试先红。"""
    assert CACHE_IMAGES_TTL_SECONDS == 60.0


def test_ttl_reuses_result_within_window_and_rescans_after_expiry() -> None:
    """TTL 内复用同一份结果；过期（恰好 60 秒，``< ttl`` 严格口径）后重扫。"""
    clock = FakeClock()
    scanner = FakeScanner(
        results=[make_result("T1"), make_result("T2")],
    )
    cache = CacheImagesCache(lambda: scanner, clock=clock)
    first = cache.get()
    assert first.generated_at == "T1"
    assert scanner.calls == 1
    assert cache.get() is first  # TTL 内：复用
    clock.advance(59.9)
    assert cache.get() is first  # 59.9 秒：仍新鲜
    assert scanner.calls == 1
    clock.advance(0.1)  # 恰好 60 秒：过期
    second = cache.get()
    assert scanner.calls == 2
    assert second.generated_at == "T2"  # 重扫时间戳更新


def test_json_and_text_share_one_scan_result(
    platform_home: Path, restricted_token: str
) -> None:
    """json 与 text 共享同一份扫描结果：同一生成时间戳，TTL 内只扫一次。"""
    clock = FakeClock()
    scanner = FakeScanner(
        results=[make_result("2026-11-15T00:00:00+00:00"), make_result("T2")],
    )
    cache = CacheImagesCache(lambda: scanner, clock=clock)
    headers = auth_headers(RESTRICTED_TOKEN)
    with build_client(platform_home, cache=cache) as client:
        payload = client.get(CACHE_IMAGES_PATH).json()
        text = client.get(CACHE_IMAGES_PATH + "?format=text", headers=headers).text
        assert scanner.calls == 1
        assert f"生成时间：{payload['generated_at']}" in text
        clock.advance(60)
        renewed = client.get(CACHE_IMAGES_PATH).json()
    assert scanner.calls == 2
    assert renewed["generated_at"] == "T2"


# ---------------------------------------------------------------- 失败语义（PRD 15）
def test_scan_failure_maps_to_503_with_fixed_message(
    platform_home: Path, restricted_token: str
) -> None:
    """特权读失败/超时 → 503 + 固定文案；异常原文（路径/命令）不进响应体。"""
    error = CacheScanError(
        "批量读取缓存文件失败：sudo cat /var/lib/sandbox-platform/registry-proxy/cache/... 失败"
    )
    cache = restricted_cache(scanner=FakeScanner(error=error))
    headers = auth_headers(RESTRICTED_TOKEN)
    with build_client(platform_home, cache=cache) as client:
        json_response = client.get(CACHE_IMAGES_PATH)
        text_response = client.get(CACHE_IMAGES_PATH + "?format=text", headers=headers)
    for response in (json_response, text_response):
        assert response.status_code == 503
        assert str(platform_home) not in response.text
        assert "registry-proxy" not in response.text
        assert "sudo" not in response.text
    assert json_response.json() == {"detail": "镜像缓存清单不可用（缓存扫描失败或超时），请稍后重试"}


def test_failure_is_not_cached_next_request_retries(
    platform_home: Path, restricted_token: str
) -> None:
    """失败不入缓存：下一次请求立即重试（成功后 200，绝不静默回空清单）。"""
    scanner = FlakyScanner(
        error=CacheScanError("特权读超时"), result=make_result("T-recovered")
    )
    cache = CacheImagesCache(lambda: scanner, clock=FakeClock())
    with build_client(platform_home, cache=cache) as client:
        assert client.get(CACHE_IMAGES_PATH).status_code == 503
        response = client.get(CACHE_IMAGES_PATH)
    assert response.status_code == 200
    assert response.json()["generated_at"] == "T-recovered"
    assert scanner.calls == 2


# ---------------------------------------------------------------- 凭据文件四情形（PRD 13）
def test_cache_token_file_lives_in_data_root_not_registry_proxy(
    config: PlatformConfig,
) -> None:
    """凭据文件钉名落平台数据根，绝不在 registry-proxy/ 子树（root 排除区）。"""
    path = cache_token_file_path(config)
    assert path.parent == config.home
    assert path.name == CACHE_TOKEN_FILENAME
    assert "registry-proxy" not in path.parts


def test_missing_token_file_is_generated_at_startup(platform_home: Path) -> None:
    """缺失：启动生成（0600、sbxr_ 前缀），生成的令牌对受限读径生效。"""
    assert not (platform_home / CACHE_TOKEN_FILENAME).exists()
    with build_client(platform_home):  # 生命周期钩子：ensure_cache_token 在启动路径执行
        pass
    path = platform_home / CACHE_TOKEN_FILENAME
    assert path.is_file()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    token = read_token_file(path)
    assert token
    assert token.startswith(CACHE_TOKEN_PREFIX)
    # 生成的令牌对受限读径生效（文件重启后沿用）
    with build_client(platform_home) as client:
        assert client.get(
            CACHE_IMAGES_PATH, headers=auth_headers(token)
        ).status_code == 200


def test_existing_token_file_is_not_overwritten(platform_home: Path) -> None:
    """已存在：启动幂等——沿用既有凭据，不覆盖（重启不变）。"""
    path = write_cache_token(platform_home, RESTRICTED_TOKEN)
    with build_client(platform_home):  # 启动一次：幂等口径在生命周期钩子里验证
        pass
    assert read_token_file(path) == RESTRICTED_TOKEN


def test_corrupted_token_file_does_not_block_startup(
    platform_home: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """损坏：WARNING + 服务照常启动 + 受限读径 401 + 原文件不被改写。"""
    path = platform_home / CACHE_TOKEN_FILENAME
    corrupted = "{ 这不是 JSON"
    path.write_text(corrupted, encoding="utf-8")
    app = create_app()
    with caplog.at_level(logging.WARNING):
        with TestClient(app, headers=auth_headers()) as client:
            # 服务照常启动（主令牌能力不受影响）
            assert client.get("/api/health").status_code == 200
            # 受限读径一律 401（无论拿什么令牌来）
            assert client.get(
                CACHE_IMAGES_PATH, headers=auth_headers(RESTRICTED_TOKEN)
            ).status_code == 401
    assert "受限令牌" in caplog.text
    assert path.read_text(encoding="utf-8") == corrupted  # 不覆盖（不静默轮换）


# ---------------------------------------------------------------- 轮换（PRD 20 服务端半边）
def test_token_rotation_takes_effect_without_restart(
    platform_home: Path, restricted_token: str
) -> None:
    """运行中重写凭据文件：旧令牌立即 401、新令牌生效，无需重启；主令牌照旧。"""
    cache = restricted_cache()
    old_headers = auth_headers(RESTRICTED_TOKEN)
    new_token = "sbxr_rotated_token_abcdefghijklmnopqrstuv"
    with build_client(platform_home, cache=cache) as client:
        assert client.get(CACHE_IMAGES_PATH, headers=old_headers).status_code == 200
        # 轮换 = 重写凭据文件
        write_cache_token(platform_home, new_token)
        assert client.get(CACHE_IMAGES_PATH, headers=old_headers).status_code == 401
        assert client.get(
            CACHE_IMAGES_PATH, headers=auth_headers(new_token)
        ).status_code == 200
        # 主令牌行为完全不变
        assert client.get(CACHE_IMAGES_PATH).status_code == 200


# ---------------------------------------------------------------- text 渲染单元
def test_render_text_shows_index_and_platform_manifest_as_two_rows() -> None:
    """同一镜像的 index 条目与平台 manifest 条目分两行（后者无标签）+ 注记在场。"""
    result = make_result(
        images=(
            make_image(repo="library/nginx", tags=("stable",), digest=DIGEST_B),
            make_image(repo="library/nginx", tags=(), digest=DIGEST_C),
        )
    )
    text = render_cache_images_text(result)
    assert text.count("仓库：library/nginx") == 2
    assert "（无标签）" in text
    assert f"摘要：{DIGEST_B}" in text
    assert f"摘要：{DIGEST_C}" in text
    assert "后者标签列表为空" in text


def test_render_text_empty_list_is_explicit_not_misleading() -> None:
    """空清单给明确空态文案（不让 bash 把「没有输出」误读成「没有缓存」）。"""
    text = render_cache_images_text(make_result(images=()))
    assert "没有已完整缓存的镜像" in text
    assert "生成时间：" in text
    assert "不可把各条链大小求和" in text
