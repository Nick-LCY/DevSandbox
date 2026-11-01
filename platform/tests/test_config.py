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


def test_socket_mount_default() -> None:
    """套接字容器内路径符合契约。"""
    config = PlatformConfig.from_env({})
    assert config.socket_mount_path == "/var/run/docker.sock"


def test_default_image_is_retired() -> None:
    """默认镜像已退役：配置里不再有默认镜像字段与环境变量口子。"""
    config = PlatformConfig.from_env({})
    assert not hasattr(config, "default_image")
    assert not hasattr(config, "local_image_prefixes")
    # 旧环境变量彻底失效：不再有兜底镜像，也不该被读进来
    config = PlatformConfig.from_env(
        {
            "SANDBOX_PLATFORM_IMAGE": "sandbox-platform/sandbox-default",
            "SANDBOX_PLATFORM_LOCAL_IMAGE_PREFIXES": "my-registry/",
        }
    )
    assert not hasattr(config, "default_image")
    assert not hasattr(config, "local_image_prefixes")


def test_proxy_defaults() -> None:
    """统一镜像代理的默认参数。"""
    config = PlatformConfig.from_env({})
    assert config.proxy_image == "rpardini/docker-registry-proxy:0.8.0"
    assert config.proxy_port == 3128
    assert config.proxy_address == "127.0.0.1"
    assert config.proxy_registries == (
        "docker.io",
        "ghcr.io",
        "quay.io",
        "gcr.io",
        "registry.k8s.io",
    )


def test_proxy_parameters_from_env() -> None:
    """代理参数可由环境变量调整。"""
    config = PlatformConfig.from_env(
        {
            "SANDBOX_PLATFORM_PROXY_IMAGE": "rpardini/docker-registry-proxy:0.9.0",
            "SANDBOX_PLATFORM_PROXY_PORT": "8080",
            "SANDBOX_PLATFORM_PROXY_ADDRESS": "10.0.2.2",
            "SANDBOX_PLATFORM_PROXY_REGISTRIES": "docker.io ghcr.io",
        }
    )
    assert config.proxy_image == "rpardini/docker-registry-proxy:0.9.0"
    assert config.proxy_port == 8080
    assert config.proxy_address == "10.0.2.2"
    assert config.proxy_registries == ("docker.io", "ghcr.io")


def test_invalid_proxy_port_rejected() -> None:
    """代理端口越界时报错。"""
    with pytest.raises(ConfigError):
        PlatformConfig.from_env({"SANDBOX_PLATFORM_PROXY_PORT": "70000"})


def test_blank_proxy_registries_falls_back_to_default() -> None:
    """代理仓库清单留空时回落到默认值（与其它环境变量一致）。"""
    config = PlatformConfig.from_env({"SANDBOX_PLATFORM_PROXY_REGISTRIES": "   "})
    assert "docker.io" in config.proxy_registries


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


def test_proxy_paths_follow_home(tmp_path: Path) -> None:
    """代理缓存与 CA 目录跟随平台数据根重定向。"""
    config = PlatformConfig.from_env({"SANDBOX_PLATFORM_HOME": str(tmp_path / "home")})
    assert config.proxy_root == tmp_path / "home" / "registry-proxy"
    assert config.proxy_cache_dir == tmp_path / "home" / "registry-proxy" / "cache"
    assert config.proxy_ca_dir == tmp_path / "home" / "registry-proxy" / "ca"


def test_from_env_reads_process_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """未显式传 env 时读取进程环境。"""
    monkeypatch.setenv("SANDBOX_PLATFORM_HOME", str(tmp_path / "proc"))
    assert PlatformConfig.from_env().home == tmp_path / "proc"
    assert os.environ["SANDBOX_PLATFORM_HOME"] == str(tmp_path / "proc")
