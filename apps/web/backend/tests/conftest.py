"""服务端测试夹具：平台数据目录全部重定向到临时目录。

与服务端包同目录（``apps/web/backend/tests/``）。核心包与服务端是两个独立的
uv 工作区成员，测试目录互不共享，夹具各写各的：这里只保留服务端测试真正用到的
两个（``platform_home`` 与 ``config``），其余宿主级夹具留在核心包测试目录。

认证（三期任务 02）：全部 ``/api`` 受 Bearer 令牌保护，测试里统一用
``TEST_TOKEN`` 这一个注入令牌，并给测试客户端挂上 ``Authorization`` 头。
令牌走环境变量注入（不落盘），测试不会往平台数据根里写令牌文件。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from sandbox_platform import PlatformConfig

# 测试专用的镜像代理端口（与生产实例 3128 隔离）
TEST_PROXY_PORT = 33128

# 测试专用的访问令牌（环境变量注入，三期任务 02 起全部 /api 都要带它）
TEST_TOKEN = "sbx_test_token_0123456789"


@pytest.fixture(autouse=True)
def console_token(monkeypatch: pytest.MonkeyPatch) -> str:
    """把访问令牌以环境变量注入（测试期间不生成令牌文件）。"""
    monkeypatch.setenv("SANDBOX_CONSOLE_TOKEN", TEST_TOKEN)
    return TEST_TOKEN


def auth_headers(token: str = TEST_TOKEN) -> dict[str, str]:
    """带 Bearer 令牌的请求头（测试客户端与 WS 握手共用）。"""
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def platform_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """把平台数据根目录重定向到临时目录。

    放在 /tmp 下且全局可读：平台会往这里写镜像中转归档，
    免 root 守护进程以沙箱用户身份运行，必须能穿过该目录。

    同时把镜像代理端口改到测试专用端口：测试期间的代理容器与生产实例
    （端口 3128）互不干扰，容器名也因端口后缀而不同。
    """
    home = Path(tempfile.mkdtemp(prefix="sandbox-platform-home-", dir="/tmp"))
    home.chmod(0o755)
    monkeypatch.setenv("SANDBOX_PLATFORM_HOME", str(home))
    monkeypatch.setenv("SANDBOX_PLATFORM_PROXY_PORT", str(TEST_PROXY_PORT))
    try:
        yield home
    finally:
        _remove_test_proxy(home)
        shutil.rmtree(home, ignore_errors=True)


def _remove_test_proxy(home: Path) -> None:
    """测试自清理：删除测试期间的代理容器（只删端口后缀的那个实例）。"""
    if not shutil.which("docker"):
        return
    name = f"sandbox-platform-registry-proxy-{TEST_PROXY_PORT}"
    subprocess.run(
        ["docker", "rm", "-f", name],
        capture_output=True,
        check=False,
    )


@pytest.fixture
def config(platform_home: Path) -> PlatformConfig:
    """按环境变量装配的平台配置。"""
    return PlatformConfig.from_env(os.environ)
