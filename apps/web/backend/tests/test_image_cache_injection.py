"""镜像缓存清单注入管线（服务端递参）的单元测试。

覆盖三块（任务 03，镜像缓存清单轮）：

- **服务端递参（创建 + 启动两条路径）**：可达地址 + 受限令牌作为可选创建
  参数递核心包；两值不进 metadata（不混进用户声明的 env）；
- **可达地址解析三档**：``SANDBOX_CONSOLE_SANDBOX_URL`` 配置优先 → 宿主
  非回环 IPv4 + 实际监听端口探测兜底 → 皆不可得跳过且创建不失败；
- **令牌来源**：02 的凭据文件 ``cache-images-token.json``，每请求重读
  （重写文件即轮换）；缺失 / 损坏跳过令牌项，不阻塞创建。
"""

from __future__ import annotations

import ipaddress
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sandbox_platform import ConnectionInfo, CreateRequest, CreateResult, SandboxMetadata

from sandbox_console.app import create_app
from sandbox_console.auth import cache_token_file_path, write_token_file
from sandbox_console.deps import get_service
from sandbox_console.injection import (
    ENV_SANDBOX_URL,
    ImageCacheInjection,
    _usable_ipv4,
    probe_host_lan_ipv4,
    probe_sandbox_url,
    resolve_image_cache_injection,
)

CONFIGURED_URL = "http://cfg-host.example:9999"
TEST_TOKEN_FIRST = "sbxr_first_token_aaaaaaaaaaaa"
TEST_TOKEN_SECOND = "sbxr_second_token_bbbbbbbbbbbb"


# ---------------------------------------------------------------- 桩件
def make_metadata(name: str = "demo", env: dict[str, str] | None = None) -> SandboxMetadata:
    """构造一份沙箱元数据。"""
    return SandboxMetadata(
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
        state="running",
        env=dict(env or {}),
    )


class RecordingService:
    """记录 create / start 收到的实参（注入两值就挂在实参上）。"""

    def __init__(self) -> None:
        self.created: list[CreateRequest] = []
        self.started: list[tuple[str, str | None, str | None]] = []
        self.metadata = make_metadata()

    def create(self, request: CreateRequest) -> CreateResult:
        self.created.append(request)
        # 对齐核心包口径：metadata.env 只装用户声明值（注入两值不进来）
        self.metadata = make_metadata(env=dict(request.env))
        return CreateResult(
            metadata=self.metadata,
            connection=ConnectionInfo(
                socket_path="/run/user/1001/docker.sock",
                container_name="sandbox-demo",
                exec_command="exec sandbox-demo",
                docker_command="ps",
            ),
            steps=("创建专属用户", "登记子 UID/GID 段"),
        )

    def start(
        self,
        name: str,
        *,
        image_cache_url: str | None = None,
        image_cache_token: str | None = None,
    ) -> SandboxMetadata:
        self.started.append((name, image_cache_url, image_cache_token))
        return self.metadata

    def get(self, name: str) -> SandboxMetadata:
        return self.metadata


# ---------------------------------------------------------------- 夹具
@pytest.fixture(autouse=True)
def clean_url_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """清掉地址与端口两个环境变量：每个用例显式声明自己要的那一档。"""
    monkeypatch.delenv(ENV_SANDBOX_URL, raising=False)
    monkeypatch.delenv("SANDBOX_CONSOLE_PORT", raising=False)


@pytest.fixture
def recording_service() -> RecordingService:
    return RecordingService()


@pytest.fixture
def client(
    recording_service: RecordingService,
    platform_home: Path,
) -> TestClient:
    """测试客户端（生命周期服务已整体替换为记录桩）。"""
    app = create_app()
    app.dependency_overrides[get_service] = lambda: recording_service
    return TestClient(app, headers={"Authorization": "Bearer sbx_test_token_0123456789"})


@pytest.fixture
def probe_finding_host(monkeypatch: pytest.MonkeyPatch) -> str:
    """把探测两步都钉成固定返回值：模拟「宿主有非回环 IPv4」的环境。"""
    monkeypatch.setattr(
        "sandbox_console.injection._route_source_ipv4", lambda: "192.168.7.10"
    )
    monkeypatch.setattr(
        "sandbox_console.injection._hostname_ipv4", lambda: "10.0.0.5"
    )
    return "192.168.7.10"


def write_cache_token(platform_home: Path, config, token: str) -> Path:
    """往平台数据根写受限令牌凭据文件（复用 02 的原子写入，0600）。"""
    path = cache_token_file_path(config)
    write_token_file(path, token)
    return path


def last_create(recording_service: RecordingService) -> CreateRequest:
    assert recording_service.created, "创建接口没有被调用过"
    return recording_service.created[-1]


# ---------------------------------------------------------------- 服务端递参：创建 + 启动两路径
def test_create_passes_configured_url_and_token(
    client: TestClient,
    recording_service: RecordingService,
    platform_home: Path,
    config,
    monkeypatch: pytest.MonkeyPatch,
    probe_finding_host: str,
) -> None:
    """创建路径递参：配置地址优先（探测有结果也不盖配置）、令牌取凭据文件值。"""
    monkeypatch.setenv(ENV_SANDBOX_URL, CONFIGURED_URL)
    write_cache_token(platform_home, config, TEST_TOKEN_FIRST)

    response = client.post(
        "/api/sandboxes", json={"name": "demo", "image": "busybox:1.37"}
    )

    assert response.status_code == 201
    request = last_create(recording_service)
    assert request.image_cache_url == CONFIGURED_URL
    assert request.image_cache_url != f"http://{probe_finding_host}:8000"
    assert request.image_cache_token == TEST_TOKEN_FIRST


def test_start_passes_injection_params(
    client: TestClient,
    recording_service: RecordingService,
    platform_home: Path,
    config,
    monkeypatch: pytest.MonkeyPatch,
    probe_finding_host: str,
) -> None:
    """启动（重启）路径同样递参：两值现推导，不依赖创建时的值。"""
    monkeypatch.setenv(ENV_SANDBOX_URL, CONFIGURED_URL)
    write_cache_token(platform_home, config, TEST_TOKEN_FIRST)

    response = client.post("/api/sandboxes/demo/start")

    assert response.status_code == 200
    assert recording_service.started == [("demo", CONFIGURED_URL, TEST_TOKEN_FIRST)]


def test_start_without_anything_available_passes_none(
    client: TestClient,
    recording_service: RecordingService,
    platform_home: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """两值皆不可得：启动照常 200，两值按 None 递（缺 env 边角同归）。"""
    monkeypatch.setattr(
        "sandbox_console.injection._route_source_ipv4", lambda: None
    )
    monkeypatch.setattr("sandbox_console.injection._hostname_ipv4", lambda: None)

    response = client.post("/api/sandboxes/demo/start")

    assert response.status_code == 200
    assert recording_service.started == [("demo", None, None)]


# ---------------------------------------------------------------- 两值不进 metadata
def test_values_are_not_merged_into_user_env(
    client: TestClient,
    recording_service: RecordingService,
    platform_home: Path,
    config,
    monkeypatch: pytest.MonkeyPatch,
    probe_finding_host: str,
) -> None:
    """递参走 CreateRequest 独立字段：用户声明的 env 一个键都不多。"""
    monkeypatch.setenv(ENV_SANDBOX_URL, CONFIGURED_URL)
    write_cache_token(platform_home, config, TEST_TOKEN_FIRST)

    client.post(
        "/api/sandboxes",
        json={
            "name": "demo",
            "image": "busybox:1.37",
            "env": {"FOO": "bar"},
        },
    )

    request = last_create(recording_service)
    # metadata.env 的来源就是 request.env：两值不在其中 = 不进 metadata
    assert request.env == {"FOO": "bar"}

    detail = client.get("/api/sandboxes/demo").json()
    assert set(detail["env"]) == {"FOO"}


# ---------------------------------------------------------------- 可达地址解析三档
def test_url_probe_fallback_with_route_source(
    client: TestClient,
    recording_service: RecordingService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """配置未设 → 探测兜底（路由表源地址 + 环境变量里的实际监听端口）。"""
    monkeypatch.setattr(
        "sandbox_console.injection._route_source_ipv4", lambda: "192.168.7.10"
    )
    monkeypatch.setattr("sandbox_console.injection._hostname_ipv4", lambda: None)
    monkeypatch.setenv("SANDBOX_CONSOLE_PORT", "28799")

    response = client.post(
        "/api/sandboxes", json={"name": "demo", "image": "busybox:1.37"}
    )

    assert response.status_code == 201
    assert last_create(recording_service).image_cache_url == "http://192.168.7.10:28799"


def test_url_probe_fallback_with_hostname_and_default_port(
    client: TestClient,
    recording_service: RecordingService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """路由表查不到 → 按主机名解析兜底；端口环境变量未设取缺省 8000。"""
    monkeypatch.setattr(
        "sandbox_console.injection._route_source_ipv4", lambda: None
    )
    monkeypatch.setattr(
        "sandbox_console.injection._hostname_ipv4", lambda: "10.0.0.5"
    )

    response = client.post(
        "/api/sandboxes", json={"name": "demo", "image": "busybox:1.37"}
    )

    assert response.status_code == 201
    assert last_create(recording_service).image_cache_url == "http://10.0.0.5:8000"


def test_url_unavailable_skips_url_item_and_create_succeeds(
    client: TestClient,
    recording_service: RecordingService,
    platform_home: Path,
    config,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """皆不可得：跳过地址项（令牌项照递）、打日志、创建不失败。"""
    monkeypatch.setattr(
        "sandbox_console.injection._route_source_ipv4", lambda: None
    )
    monkeypatch.setattr("sandbox_console.injection._hostname_ipv4", lambda: None)
    write_cache_token(platform_home, config, TEST_TOKEN_FIRST)

    response = client.post(
        "/api/sandboxes", json={"name": "demo", "image": "busybox:1.37"}
    )

    assert response.status_code == 201
    request = last_create(recording_service)
    assert request.image_cache_url is None
    assert request.image_cache_token == TEST_TOKEN_FIRST


def test_both_unavailable_no_params_and_create_succeeds(
    client: TestClient,
    recording_service: RecordingService,
    platform_home: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """地址探测落空 + 凭据文件缺失：两值皆 None，创建照常 201（不阻塞）。"""
    monkeypatch.setattr(
        "sandbox_console.injection._route_source_ipv4", lambda: None
    )
    monkeypatch.setattr("sandbox_console.injection._hostname_ipv4", lambda: None)

    response = client.post(
        "/api/sandboxes", json={"name": "demo", "image": "busybox:1.37"}
    )

    assert response.status_code == 201
    request = last_create(recording_service)
    assert request.image_cache_url is None
    assert request.image_cache_token is None


# ---------------------------------------------------------------- 令牌来源与轮换
def test_token_file_missing_skips_token_only(
    client: TestClient,
    recording_service: RecordingService,
    monkeypatch: pytest.MonkeyPatch,
    probe_finding_host: str,
) -> None:
    """凭据文件缺失：跳过令牌项，地址项照递，创建不失败（不注入空值）。"""
    monkeypatch.setenv(ENV_SANDBOX_URL, CONFIGURED_URL)

    response = client.post(
        "/api/sandboxes", json={"name": "demo", "image": "busybox:1.37"}
    )

    assert response.status_code == 201
    request = last_create(recording_service)
    assert request.image_cache_url == CONFIGURED_URL
    assert request.image_cache_token is None


def test_broken_token_file_skips_token_only(
    client: TestClient,
    recording_service: RecordingService,
    platform_home: Path,
    config,
    monkeypatch: pytest.MonkeyPatch,
    probe_finding_host: str,
) -> None:
    """凭据文件损坏：与缺失同口径——跳过令牌项，不阻塞创建。"""
    monkeypatch.setenv(ENV_SANDBOX_URL, CONFIGURED_URL)
    cache_token_file_path(config).write_text("not-json", encoding="utf-8")

    response = client.post(
        "/api/sandboxes", json={"name": "demo", "image": "busybox:1.37"}
    )

    assert response.status_code == 201
    request = last_create(recording_service)
    assert request.image_cache_url == CONFIGURED_URL
    assert request.image_cache_token is None


def test_token_reread_per_request(
    client: TestClient,
    recording_service: RecordingService,
    platform_home: Path,
    config,
    monkeypatch: pytest.MonkeyPatch,
    probe_finding_host: str,
) -> None:
    """轮换（PRD 20 服务端半边）：重写凭据文件后下一次创建递出新值。"""
    monkeypatch.setenv(ENV_SANDBOX_URL, CONFIGURED_URL)
    write_cache_token(platform_home, config, TEST_TOKEN_FIRST)

    client.post("/api/sandboxes", json={"name": "demo", "image": "busybox:1.37"})
    assert last_create(recording_service).image_cache_token == TEST_TOKEN_FIRST

    write_cache_token(platform_home, config, TEST_TOKEN_SECOND)
    client.post("/api/sandboxes", json={"name": "demo", "image": "busybox:1.37"})
    assert last_create(recording_service).image_cache_token == TEST_TOKEN_SECOND


# ---------------------------------------------------------------- 解析器单元
def test_resolve_returns_none_when_both_unavailable(
    platform_home: Path,
    config,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """两值皆不可得 → 返回 None（调用方按不递参处理）。"""
    monkeypatch.setattr(
        "sandbox_console.injection._route_source_ipv4", lambda: None
    )
    monkeypatch.setattr("sandbox_console.injection._hostname_ipv4", lambda: None)

    assert resolve_image_cache_injection(config) is None


def test_resolve_configured_url_strips_whitespace(
    platform_home: Path,
    config,
    monkeypatch: pytest.MonkeyPatch,
    probe_finding_host: str,
) -> None:
    """配置值只做去首尾空白，不做更多加工（允许 https:// 反代地址）。"""
    monkeypatch.setenv(ENV_SANDBOX_URL, f"  {CONFIGURED_URL}  ")

    injection = resolve_image_cache_injection(config)

    assert injection is not None
    assert injection.url == CONFIGURED_URL


def test_probe_sandbox_url_none_when_no_ip_and_bad_port_env(
    platform_home: Path,
    config,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """探测到 IP 但端口配置非法：按端口不可知处理，返回 None 不抛错。"""
    monkeypatch.setattr(
        "sandbox_console.injection._route_source_ipv4", lambda: "192.168.7.10"
    )
    monkeypatch.setattr("sandbox_console.injection._hostname_ipv4", lambda: None)
    monkeypatch.setenv("SANDBOX_CONSOLE_PORT", "not-a-port")

    assert probe_sandbox_url() is None


def test_probe_host_lan_ipv4_filters_unusable(monkeypatch: pytest.MonkeyPatch) -> None:
    """探测链只认非回环、非链路本地的 IPv4：回环 / 未指定 / 链路本地 / 非法值一律跳过。"""
    assert _usable_ipv4("192.168.7.10") is True
    assert _usable_ipv4("127.0.1.1") is False
    assert _usable_ipv4("127.0.0.1") is False
    assert _usable_ipv4("0.0.0.0") is False
    assert _usable_ipv4("169.254.10.5") is False  # link-local
    assert _usable_ipv4("::1") is False
    assert _usable_ipv4("not-an-ip") is False
    # 两步都只回回环地址 → 探测结果为 None
    monkeypatch.setattr(
        "sandbox_console.injection._route_source_ipv4", lambda: None
    )
    monkeypatch.setattr(
        "sandbox_console.injection._hostname_ipv4", lambda: None
    )
    assert probe_host_lan_ipv4() is None


def test_probe_host_lan_ipv4_shape_is_none_or_valid_ipv4() -> None:
    """真探测（不 stub socket）⇒ 返回值形状恒定：None 或合法 IPv4 字符串。

    只锁形状契约、不断具体值：宿主局域网地址随机器 / 网络环境漂移，
    断具体值会让 CI 随机炸。
    """
    result = probe_host_lan_ipv4()
    assert result is None or ipaddress.ip_address(result).version == 4


def test_injection_repr_hides_token(platform_home: Path, config) -> None:
    """注入对象的 repr 不含令牌本体（对齐 TokenSource 先例）。"""
    injection = ImageCacheInjection(url=CONFIGURED_URL, token=TEST_TOKEN_FIRST)
    assert TEST_TOKEN_FIRST not in repr(injection)
    assert TEST_TOKEN_FIRST not in str(injection)
    assert injection.url == CONFIGURED_URL
