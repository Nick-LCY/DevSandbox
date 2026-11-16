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
    filter_tag_only,
    format_cached_time,
    format_size_decimal,
    render_cache_images_tag_only_table,
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
        (CACHE_IMAGES_PATH, "get", False),
        (CACHE_IMAGES_PATH, "POST", False),
        (CACHE_IMAGES_PATH, "HEAD", False),
        (CACHE_IMAGES_PATH + "/", "GET", False),
        (CACHE_IMAGES_PATH + "/extra", "GET", False),
        ("/api/proxy/status", "GET", False),
        ("/api/auth/ticket", "POST", False),
    ],
    ids=[
        "get-exact",
        "get-lowercase",
        "post",
        "head",
        "trailing-slash",
        "subpath",
        "other-path",
        "ticket",
    ],
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
    assert "不可求和当缓存占用" in text
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
    assert "当前没有拉取过的镜像" in text
    assert "生成时间：" in text
    assert "不可求和当缓存占用" in text


def test_render_text_header_uses_scheme_c_wording() -> None:
    """表头按方案 C 口径措辞（拉过就算：manifest 在缓存即条目）。

    旧口径「仅收录已完整缓存的镜像」是**保守口径**的遗留：方案 C 下不做
    blob 完整性拦截，表头继续自称「已完整缓存」就是**假话**（清单里可能有
    blob 未落缓存的条目）。
    """
    text = render_cache_images_text(make_result(images=(make_image(),)))
    assert text.startswith("镜像缓存清单（收录拉取过的镜像：manifest 在缓存即条目）")
    assert "仅收录已完整缓存的镜像" not in text
    assert "已完整缓存" not in text


def test_render_text_size_note_uses_declared_bytes_wording() -> None:
    """SIZE 尾注改为「声明字节数」措辞（2026-11-16 用户拍板），旧措辞退役。

    方案 C 下 ``total_size_bytes`` 是**声明链字节**（manifest 文档声明的
    config + layers），不再是「拉取该条所需链字节」——尾注必须同步改口径，
    否则 bash 侧会把声明值误读成实际下载量。

    尾注还要说清 SIZE **可能是部分值**：子 manifest 不在缓存或不可信时，
    SIZE 只含已可计算部分（index 声明的子 manifest 文档字节），可能偏小。
    """
    text = render_cache_images_text(make_result(images=(make_image(),)))
    assert (
        "说明：total_size_bytes（链大小）为该镜像链的声明字节数，"
        "条目间共享 blob，不可求和当缓存占用。"
        "SIZE 可能是部分值——子 manifest 不在缓存或不可信时仅含已可计算部分，"
        "可能偏小。"
    ) in text
    # 旧措辞整体退役
    assert "拉取该条目所需链" not in text
    assert "不可把各条链大小求和" not in text
    # 另一则尾注（「两行现象」）不变
    assert (
        "注记：同一镜像可能出现「index 条目 + 平台 manifest 条目」两行，"
        "后者标签列表为空。"
    ) in text


# ---------------------------------------------------------------- tags=only：装配层过滤
@pytest.mark.parametrize("format_param", ["", "&format=json", "&format=text"], ids=["default-json", "explicit-json", "explicit-text"])
def test_filter_tag_only_keeps_tagged_entries_and_scan_counts(
    platform_home: Path, restricted_token: str, format_param: str
) -> None:
    """tags=only 只留标签非空的条目；扫描三计数与生成时间戳原样保留。"""
    result = make_result(
        images=(
            make_image(repo="library/python", tags=("3.11-slim", "3.12-slim"), digest=DIGEST_A),
            make_image(repo="library/nginx", tags=(), digest=DIGEST_B),
        )
    )
    cache = restricted_cache(scanner=FakeScanner(results=[result]))
    headers = auth_headers(RESTRICTED_TOKEN)
    with build_client(platform_home, cache=cache) as client:
        response = client.get(
            CACHE_IMAGES_PATH + f"?tags=only{format_param}", headers=headers
        )
    assert response.status_code == 200
    if "format=text" in format_param:
        # text + tags=only 渲染表格，逐行见下一节单测；这里钉过滤语义与
        # 0.4.2 输出清理的端点级否定钉（无轻表头行、无尾注行）。
        assert "仓库：" not in response.text
        assert "清单生成时间" not in response.text
        assert "SIZE 为拉取该条所需链字节" not in response.text
        assert response.text.splitlines()[0].startswith("IMAGE")
        return
    payload = response.json()
    assert len(payload["images"]) == 1
    assert payload["images"][0]["repo"] == "library/python"
    assert payload["images"][0]["tags"] == ["3.11-slim", "3.12-slim"]
    assert payload["generated_at"] == "2026-11-15T00:00:00+00:00"
    assert payload["total_files"] == 7
    assert payload["blob_files"] == 5
    assert payload["skipped_files"] == 1


def test_filter_tag_only_all_tagless_yields_empty_view() -> None:
    """全无标签：过滤后视图为空（纯函数级，json 侧空数组、不报错）。"""
    result = make_result(images=(make_image(repo="library/nginx", tags=()),))
    filtered = filter_tag_only(result)
    assert filtered.images == ()
    assert filtered.generated_at == result.generated_at
    assert filtered.total_files == result.total_files


def test_tagless_entries_stay_in_default_view(
    platform_home: Path, restricted_token: str
) -> None:
    """无标签条目：默认视图照旧在场、tags=only 被滤除（端点级双向钉子）。

    同一扫描结果两次请求共享缓存：默认视图里无标签行原样在场（1 条），
    ``tags=only`` 视图里被滤空（json ``images == []``）——过滤只发生在
    tags=only 视图，不触碰默认视图与扫描结果本身。
    """
    result = make_result(images=(make_image(repo="library/nginx", tags=()),))
    cache = restricted_cache(scanner=FakeScanner(results=[result]))
    headers = auth_headers(RESTRICTED_TOKEN)
    with build_client(platform_home, cache=cache) as client:
        default_view = client.get(CACHE_IMAGES_PATH, headers=headers)
        only_view = client.get(CACHE_IMAGES_PATH + "?tags=only", headers=headers)
    assert default_view.status_code == 200
    assert only_view.status_code == 200
    assert [image["repo"] for image in default_view.json()["images"]] == [
        "library/nginx"
    ]
    assert only_view.json()["images"] == []


# ---------------------------------------------------------------- tags=only：422（仿 format 路径）
@pytest.mark.parametrize("value", ["all", "", "ONLY", "only "], ids=["wordy", "empty", "uppercase", "trailing-space"])
def test_tags_invalid_value_returns_422_with_fixed_message(
    platform_home: Path, restricted_token: str, value: str
) -> None:
    """tags 非法值（非 only）→ 422 + 固定文案，仿 format 的手动判定路径。"""
    cache = restricted_cache()
    with build_client(platform_home, cache=cache) as client:
        response = client.get(CACHE_IMAGES_PATH + f"?tags={value}")
    assert response.status_code == 422
    assert response.json() == {"detail": "tags 取值非法（只支持 only）"}


def test_invalid_format_beats_invalid_tags_422_message(
    platform_home: Path, restricted_token: str
) -> None:
    """两个参数都非法时先判 format（参数顺序固定，文案可预期）。"""
    cache = restricted_cache()
    with build_client(platform_home, cache=cache) as client:
        response = client.get(CACHE_IMAGES_PATH + "?format=xml&tags=all")
    assert response.status_code == 422
    assert "format" in response.json()["detail"]


# ---------------------------------------------------------------- 十进制人读 SIZE（仿 docker，console 二进制不动）
@pytest.mark.parametrize(
    "size,expected",
    [
        (0, "0B"),
        (933, "933B"),
        (999, "999B"),
        (1000, "1kB"),
        (1001, "1kB"),
        (5800, "5.8kB"),
        (999_949, "999.9kB"),
        # 满 千进位边界：999_950 起四舍五入满 1000 即滚动升单元（999.999kB
        # 渲染 1MB，与 docker 习惯一致），999_949 舍入仍是 999.9kB。
        (999_950, "1MB"),
        (999_999, "1MB"),
        (63943288, "63.9MB"),
        (45628174, "45.6MB"),
        (116101621, "116.1MB"),
        (1161016210, "1.2GB"),
        (2_227_229_000_000, "2.2TB"),
    ],
)
def test_format_size_decimal_is_1000_based(
    size: int, expected: str
) -> None:
    """十进制 1000 进制仿 docker：1 位小数、整数不带小数点（B/kB/MB/GB/TB）。"""
    assert format_size_decimal(size) == expected


# ---------------------------------------------------------------- CACHED TIME：UTC 口径渲染
@pytest.mark.parametrize(
    "cached_at,expected",
    [
        ("2026-11-06T15:35:14Z", "2026-11-06 15:35:14"),
        ("2026-11-06T15:35:14+00:00", "2026-11-06 15:35:14"),
        ("2026-11-06T23:35:14+09:00", "2026-11-06 14:35:14"),
        ("2026-11-06T15:35:14", "2026-11-06 15:35:14"),
    ],
    ids=["z-suffix", "utc-offset", "non-utc-normalized", "naive-as-is"],
)
def test_format_cached_time_renders_utc_wall_clock(
    cached_at: str, expected: str
) -> None:
    """cached_at → YYYY-MM-DD HH:mm:ss（UTC 墙钟，不落本地时区）。"""
    assert format_cached_time(cached_at) == expected


def test_format_cached_time_garbage_passthrough() -> None:
    """脏数据原样返回（解析失败不炸渲染）。"""
    assert format_cached_time("not-a-timestamp") == "not-a-timestamp"


# ---------------------------------------------------------------- tags=only 表格渲染（纯函数）
def make_tagged_result() -> CacheScanResult:
    """构造一份带标签/无标签混合的扫描结果（表格渲染共用）。"""
    return make_result(
        generated_at="2026-11-15T13:20:22Z",
        images=(
            make_image(
                repo="library/python",
                tags=("3.12-slim", "3.11-slim"),
                digest=DIGEST_A,
                size=45_628_174,
                cached_at="2026-11-06T15:34:48Z",
            ),
            make_image(
                repo="astral-sh/uv",
                tags=("0.13.7",),
                digest="sha256:" + "9" * 64,
                size=19_347_931,
                cached_at="2026-11-06T15:35:14Z",
            ),
            make_image(repo="library/nginx", tags=(), digest=DIGEST_B),
        ),
    )


def test_render_tag_only_table_expands_tags_and_repeats_columns() -> None:
    """多标签展开为多行，ID/SIZE/TIME 逐行重复；无标签条目不进表格。"""
    text = render_cache_images_tag_only_table(filter_tag_only(make_tagged_result()))
    lines = text.splitlines()
    # python 3.11-slim / 3.12-slim 两行，ID/SIZE/TIME 与同一份展开
    python_rows = [line for line in lines if line.startswith("library/python:")]
    assert len(python_rows) == 2
    assert all(
        row.split()[1] == "aaaaaaaaaaaa" and row.split()[2] == "45.6MB" for row in python_rows
    )
    assert not any(line.startswith("library/nginx") for line in lines)


def test_render_tag_only_table_row_order_is_repo_then_tag() -> None:
    """行按 repo、tag 排序（构造序故意乱序）保证稳定输出。"""
    text = render_cache_images_tag_only_table(filter_tag_only(make_tagged_result()))
    rows = [line.split()[0] for line in text.splitlines()[1:]]  # 首行是列头
    assert rows == sorted(rows)
    assert rows == ["astral-sh/uv:0.13.7", "library/python:3.11-slim", "library/python:3.12-slim"]


def test_render_tag_only_table_has_no_light_header_or_footer_note() -> None:
    """仅表体（0.4.2 输出清理）：无轻表头行、无 SIZE 防误读尾注行。

    输出 = 列头行 + 数据行：首行是列头、末行是数据行；轻表头（条目/行数
    计数 + 清单生成时间）与尾注整行 0 命中（生成时间在 json ``generated_at``
    与缺省 text 仍有承载，防误读口径承载在 API 文档第 17 章）。
    """
    text = render_cache_images_tag_only_table(filter_tag_only(make_tagged_result()))
    lines = text.splitlines()
    assert not any(line.startswith("已缓存镜像") for line in lines)
    assert "清单生成时间" not in text
    assert "SIZE 为拉取该条所需链字节" not in text
    assert lines[0].startswith("IMAGE")  # 首行 = 列头行
    assert lines[-1].startswith("library/python:")  # 末行 = 数据行
    # 默认 text 的「两行现象」注在 tag-only 视图不适用，不再渲染。
    assert "后者标签列表为空" not in text


def test_render_tag_only_table_column_alignment_is_ljust_two_spaces() -> None:
    """列宽按批内最长值（含列表头）ljust 对齐，列间两空格，行尾不留空白。"""
    text = render_cache_images_tag_only_table(filter_tag_only(make_tagged_result()))
    lines = text.splitlines()
    header = lines[0]  # 仅表体：首行即列头行（无轻表头）
    assert header.split() == ["IMAGE", "ID", "SIZE", "CACHED", "TIME"]
    # 列分隔是两空格、列内 ljust 填充；数据行与表头行都行尾无空白。
    assert header == header.rstrip()
    assert "  IMAGE" not in header  # 首列顶格
    for line in lines[1:]:
        assert line == line.rstrip()
    # IMAGE 列宽 = 最长镜像名（含表头 5）：短值右侧填充到同宽再接两空格。
    image_col_width = max(
        len("IMAGE"),
        len("astral-sh/uv:0.13.7"),
        len("library/python:3.11-slim"),
        len("library/python:3.12-slim"),
    )
    first_data = lines[2]
    assert first_data[image_col_width : image_col_width + 2] == "  "


def test_render_tag_only_table_rebuild_byte_exact() -> None:
    """逐字节重建比对：整份输出 = 列头行 + 数据行（仅表体），各列 ljust 到

    批内最宽（含列表头）+ 两空格相连，行尾不留空白。
    """
    filtered = filter_tag_only(make_tagged_result())
    text = render_cache_images_tag_only_table(filtered)
    lines = text.splitlines()
    # 仅表体：重建目标就是整份输出（列头行 + 数据行，无轻表头与尾注）。
    rendered = sorted(
        (
            f"{image.repo}:{tag}",
            image.digest.removeprefix("sha256:")[:12],
            format_size_decimal(image.total_size_bytes),
            format_cached_time(image.cached_at),
        )
        for image in filtered.images
        for tag in image.tags
    )
    columns = list(zip(*rendered, strict=True))
    titles = ("IMAGE", "ID", "SIZE", "CACHED TIME")
    widths = [
        max(len(title), max(len(cell) for cell in column))
        for title, column in zip(titles, columns, strict=True)
    ]
    expected_lines = [
        "  ".join(
            title.ljust(width) for title, width in zip(titles, widths, strict=True)
        ).rstrip()
    ] + [
        "  ".join(
            cell.ljust(width) for cell, width in zip(row, widths, strict=True)
        ).rstrip()
        for row in rendered
    ]
    assert lines == expected_lines


def test_render_tag_only_table_id_is_first_12_hex_chars() -> None:
    """ID = digest 去 sha256: 前缀后的前 12 位十六进制。"""
    text = render_cache_images_tag_only_table(filter_tag_only(make_tagged_result()))
    assert "aaaaaaaaaaaa" in text  # DIGEST_A 前 12 位
    assert "999999999999" in text  # 9*64 前 12 位
    assert "sha256:" not in text


def test_render_tag_only_table_empty_list_renders_only_column_header() -> None:
    """空清单 → 仅列头行（docker images 同款语义：空输出仍带列头）。

    bash 侧不会拿到空串；「明确空态文案」由缺省 text 承载，tag-only 视图
    保持纯表格形态（无计数行、无空态括号文案、无尾注）。
    """
    result = make_result(
        generated_at="2026-11-15T13:20:22Z",
        images=(make_image(repo="library/nginx", tags=(), digest=DIGEST_B),),
    )
    text = render_cache_images_tag_only_table(filter_tag_only(result))
    assert text == "IMAGE  ID  SIZE  CACHED TIME\n"  # 整份输出 = 列头行
    assert "已缓存镜像" not in text
    assert "清单生成时间" not in text
    assert "（当前没有带标签的已缓存镜像）" not in text
    assert "SIZE 为拉取该条所需链字节" not in text


def test_render_tag_only_table_size_and_time_formats() -> None:
    """SIZE 十进制人读、CACHED TIME 去 T/Z 改空格分隔（表格观感口径）。"""
    text = render_cache_images_tag_only_table(filter_tag_only(make_tagged_result()))
    assert "19.3MB" in text
    assert "45.6MB" in text
    assert "2026-11-06 15:35:14" in text
    assert "2026-11-06T15:35:14Z" not in text.splitlines()[1]  # 首条数据行无 ISO 原文


# ---------------------------------------------------------------- 默认视图零改动回归（tags 缺席）
def test_default_text_render_unchanged_without_table_markers() -> None:
    """不带 tags 参数：默认 text 仍是原逐行条目布局，表格标记不泄漏。"""
    result = make_tagged_result()
    text = render_cache_images_text(result)
    assert "仓库：astral-sh/uv" in text
    assert "标签：3.12-slim、3.11-slim" in text  # 默认 text 保留构造序（不排序）
    assert "链大小：45628174 字节" in text
    assert "IMAGE" not in text
    assert "CACHED TIME" not in text
    assert "清单生成时间" not in text
    # 两则尾注维持不变
    assert "不可求和当缓存占用" in text
    assert "后者标签列表为空" in text
