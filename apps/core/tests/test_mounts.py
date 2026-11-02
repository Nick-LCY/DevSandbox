"""挂载声明解析与校验的单元测试。"""

from __future__ import annotations

from pathlib import Path

import pytest

from sandbox_platform import (
    MountSpec,
    ValidationError,
    mounts_to_docker_args,
    parse_mount_declaration,
    parse_mounts,
    socket_mount,
)


def test_parse_two_part_declaration(tmp_path: Path) -> None:
    """宿主路径:容器路径 形式可解析。"""
    host = tmp_path / "data"
    host.mkdir()
    spec = parse_mount_declaration(f"{host}:/data")
    assert spec.host_path == str(host)
    assert spec.container_path == "/data"
    assert spec.read_only is False


def test_parse_readonly_declaration(tmp_path: Path) -> None:
    """ro 标记被识别为只读。"""
    host = tmp_path / "data"
    host.mkdir()
    spec = parse_mount_declaration(f"{host}:/data:ro")
    assert spec.read_only is True
    assert spec.bind_spec.endswith(":ro")


def test_relative_host_path_rejected(tmp_path: Path) -> None:
    """宿主路径必须是绝对路径。"""
    with pytest.raises(ValidationError):
        parse_mount_declaration("relative/path:/data")


def test_relative_container_path_rejected(tmp_path: Path) -> None:
    """容器内路径必须是绝对路径。"""
    host = tmp_path / "data"
    host.mkdir()
    with pytest.raises(ValidationError):
        parse_mount_declaration(f"{host}:data")


def test_missing_host_path_rejected(tmp_path: Path) -> None:
    """宿主路径不存在时报错——平台不代为创建。"""
    with pytest.raises(ValidationError):
        parse_mount_declaration(f"{tmp_path / 'missing'}:/data")


def test_unknown_mode_rejected(tmp_path: Path) -> None:
    """只支持 ro / rw 标记。"""
    host = tmp_path / "data"
    host.mkdir()
    with pytest.raises(ValidationError):
        parse_mount_declaration(f"{host}:/data:zz")


def test_too_many_parts_rejected(tmp_path: Path) -> None:
    """声明最多三段。"""
    host = tmp_path / "data"
    host.mkdir()
    with pytest.raises(ValidationError):
        parse_mount_declaration(f"{host}:/data:ro:extra")


def test_duplicate_container_path_rejected(tmp_path: Path) -> None:
    """同一容器内路径不能重复声明。"""
    first = tmp_path / "a"
    second = tmp_path / "b"
    first.mkdir()
    second.mkdir()
    with pytest.raises(ValidationError):
        parse_mounts([f"{first}:/data", f"{second}:/data"])


def test_multiple_mounts_parsed(tmp_path: Path) -> None:
    """多条挂载按声明顺序解析。"""
    first = tmp_path / "a"
    second = tmp_path / "b"
    first.mkdir()
    second.mkdir()
    specs = parse_mounts([f"{first}:/data", f"{second}:/creds:ro"])
    assert [spec.container_path for spec in specs] == ["/data", "/creds"]
    assert [spec.read_only for spec in specs] == [False, True]


def test_docker_args_use_bind_mount_syntax(tmp_path: Path) -> None:
    """生成的 docker 参数是 bind 挂载写法。"""
    host = tmp_path / "data"
    host.mkdir()
    spec = parse_mount_declaration(f"{host}:/data:ro")
    args = spec.to_docker_args()
    assert args[0] == "--mount"
    assert "type=bind" in args[1]
    assert f"src={host}" in args[1]
    assert "dst=/data" in args[1]
    assert "readonly" in args[1]


def test_mounts_to_docker_args_concatenates(tmp_path: Path) -> None:
    """多条挂载拼成一段参数。"""
    host = tmp_path / "data"
    host.mkdir()
    specs = parse_mounts([f"{host}:/data"])
    args = mounts_to_docker_args(specs)
    assert len(args) == 2
    assert args[0] == "--mount"


def test_socket_mount_is_fixed_role() -> None:
    """套接字挂载标记为固定角色。"""
    spec = socket_mount("/run/user/1001/docker.sock", "/var/run/docker.sock")
    assert spec.role == "socket"
    assert spec.container_path == "/var/run/docker.sock"
    assert spec.read_only is False


def test_user_mount_role_default() -> None:
    """用户声明挂载默认角色为 user。"""
    assert MountSpec("/tmp", "/data").role == "user"


def test_sensitive_host_path_bypassed_by_dotdot_rejected() -> None:
    """``..`` 绕不过敏感清单：先归一化再比对。

    ``/tmp/../etc`` 词法上不在 ``/etc`` 之下，未归一化就会漏掉它。
    """
    with pytest.raises(ValidationError) as excinfo:
        parse_mount_declaration("/tmp/../etc:/data")
    assert "敏感清单" in str(excinfo.value)


def test_sensitive_host_file_bypassed_by_dotdot_rejected() -> None:
    """宿主敏感文件同样绕不过 ``..``。"""
    with pytest.raises(ValidationError) as excinfo:
        parse_mount_declaration("/tmp/../var/run/docker.sock:/data")
    assert "敏感清单" in str(excinfo.value)
