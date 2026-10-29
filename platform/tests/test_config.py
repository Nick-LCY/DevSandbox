"""平台配置的单元测试。"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from sandbox_platform import ConfigError, PlatformConfig


def test_default_home_is_var_lib() -> None:
    """数据根目录默认 /var/lib/sandbox-platform。"""
    config = PlatformConfig.from_env({})
    assert config.home == Path("/var/lib/sandbox-platform")


def test_home_redirected_by_env(tmp_path: Path) -> None:
    """环境变量可重定向数据根目录。"""
    config = PlatformConfig.from_env({"SANDBOX_PLATFORM_HOME": str(tmp_path / "elsewhere")})
    assert config.home == tmp_path / "elsewhere"


def test_subid_parameters_from_env() -> None:
    """子 ID 段参数可由环境变量调整。"""
    config = PlatformConfig.from_env(
        {
            "SANDBOX_PLATFORM_SUBID_BASE": "200000",
            "SANDBOX_PLATFORM_SUBID_LENGTH": "131072",
        }
    )
    assert config.subid_base == 200000
    assert config.subid_length == 131072


def test_invalid_subid_base_rejected() -> None:
    """子 ID 段起点低于下限时报错。"""
    with pytest.raises(ConfigError):
        PlatformConfig.from_env({"SANDBOX_PLATFORM_SUBID_BASE": "1000"})


def test_invalid_subid_length_rejected() -> None:
    """子 ID 段长度低于下限时报错。"""
    with pytest.raises(ConfigError):
        PlatformConfig.from_env({"SANDBOX_PLATFORM_SUBID_LENGTH": "16"})


def test_non_integer_env_rejected() -> None:
    """非整数值报错。"""
    with pytest.raises(ConfigError):
        PlatformConfig.from_env({"SANDBOX_PLATFORM_SUBID_BASE": "abc"})


def test_default_image_and_socket_mount() -> None:
    """默认镜像与套接字容器内路径符合契约。"""
    config = PlatformConfig.from_env({})
    assert config.default_image == "sandbox-platform/sandbox-default"
    assert config.socket_mount_path == "/var/run/docker.sock"


def test_system_user_name_derivation() -> None:
    """系统用户名由前缀与沙箱名拼出。"""
    config = PlatformConfig.from_env({"SANDBOX_PLATFORM_USER_PREFIX": "sbx"})
    assert config.system_user_name("demo") == "sbx-demo"


def test_metadata_path_layout(tmp_path: Path) -> None:
    """元数据路径位于沙箱根目录下。"""
    config = PlatformConfig.from_env({"SANDBOX_PLATFORM_HOME": str(tmp_path)})
    path = config.metadata_path("demo")
    assert path == tmp_path / "sandboxes" / "demo" / "metadata.json"


def test_ensure_directories_creates_layout(tmp_path: Path) -> None:
    """目录装配是幂等的。"""
    config = PlatformConfig.from_env({"SANDBOX_PLATFORM_HOME": str(tmp_path / "home")})
    config.ensure_directories()
    config.ensure_directories()
    for name in ("sandboxes", "locks", "tmp"):
        assert (config.home / name).is_dir()


def test_from_env_reads_process_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """未显式传 env 时读取进程环境。"""
    monkeypatch.setenv("SANDBOX_PLATFORM_HOME", str(tmp_path / "proc"))
    assert PlatformConfig.from_env().home == tmp_path / "proc"
    assert os.environ["SANDBOX_PLATFORM_HOME"] == str(tmp_path / "proc")
