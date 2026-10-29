"""测试夹具：平台数据目录全部重定向到临时目录。"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from sandbox_platform import PlatformConfig, SandboxService

# 测试专用的镜像代理端口（与生产实例 3128 隔离）
TEST_PROXY_PORT = 33128


def _passwordless_sudo_available() -> bool:
    """宿主是否具备免密 sudo。"""
    if os.geteuid() == 0:
        return True
    if shutil.which("sudo") is None:
        return False
    return subprocess.run(["sudo", "-n", "true"], capture_output=True, check=False).returncode == 0


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


@pytest.fixture
def service(config: PlatformConfig) -> SandboxService:
    """生命周期服务实例。"""
    return SandboxService(config)


@pytest.fixture
def require_root() -> None:
    """需要真实 root 权限的测试前置条件。"""
    if not _passwordless_sudo_available():
        pytest.skip("需要 root 权限或免密 sudo 才能执行宿主级操作")


@pytest.fixture
def external_dir() -> Path:
    """用户声明挂载用的宿主目录。

    放在 /tmp 下且全局可读：免 root 守护进程以沙箱用户身份运行，
    必须能穿过并读取宿主路径，否则容器无法挂载。
    """
    path = Path(tempfile.mkdtemp(prefix="sandbox-platform-ext-", dir="/tmp"))
    path.chmod(0o777)
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)
