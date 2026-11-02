"""文件注入声明解析与暂存布局的单元测试。

纯单元：不碰宿主（不复制、不起容器），只验证声明解析的校验口径与暂存路径布局。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sandbox_platform import (
    FileSpec,
    ValidationError,
    parse_file_declaration,
    parse_file_declarations,
    staged_path,
    staging_root,
)


def test_parse_two_part_declaration(tmp_path: Path) -> None:
    """宿主路径:容器路径 形式可解析。"""
    spec = parse_file_declaration(f"{tmp_path}/key:/run/key")
    assert spec == FileSpec(host_path=f"{tmp_path}/key", container_path="/run/key")


def test_three_part_declaration_rejected(tmp_path: Path) -> None:
    """注入声明固定两段：第三段（读写标记）按格式非法拒绝。"""
    with pytest.raises(ValidationError) as excinfo:
        parse_file_declaration(f"{tmp_path}/key:/run/key:ro")
    assert "格式非法" in str(excinfo.value)


def test_relative_host_path_rejected() -> None:
    """宿主路径必须是绝对路径。"""
    with pytest.raises(ValidationError) as excinfo:
        parse_file_declaration("relative/path:/run/key")
    assert "绝对路径" in str(excinfo.value)


def test_relative_container_path_rejected(tmp_path: Path) -> None:
    """容器内路径必须是绝对路径。"""
    with pytest.raises(ValidationError) as excinfo:
        parse_file_declaration(f"{tmp_path}/key:run/key")
    assert "绝对路径" in str(excinfo.value)


def test_comma_in_host_path_rejected(tmp_path: Path) -> None:
    """宿主路径不得含逗号（Docker 挂载参数以逗号分段）。"""
    with pytest.raises(ValidationError) as excinfo:
        parse_file_declaration(f"{tmp_path}/a,b:/run/key")
    assert "逗号" in str(excinfo.value)


def test_comma_in_container_path_rejected(tmp_path: Path) -> None:
    """容器内路径不得含逗号。"""
    with pytest.raises(ValidationError) as excinfo:
        parse_file_declaration(f"{tmp_path}/key:/run/a,b")
    assert "逗号" in str(excinfo.value)


def test_sensitive_host_path_rejected() -> None:
    """命中宿主敏感清单的路径一律拒绝注入。"""
    with pytest.raises(ValidationError) as excinfo:
        parse_file_declaration("/etc/passwd:/run/passwd")
    message = str(excinfo.value)
    assert "敏感清单" in message
    assert "注入文件" in message


def test_extra_forbidden_host_path_rejected(tmp_path: Path) -> None:
    """调用方追加的敏感项（如平台数据根）同样拒绝注入。"""
    with pytest.raises(ValidationError) as excinfo:
        parse_file_declaration(
            f"{tmp_path}/data:/run/data",
            extra_forbidden=[tmp_path],
        )
    assert "敏感清单" in str(excinfo.value)


def test_duplicate_host_path_rejected(tmp_path: Path) -> None:
    """同一宿主路径不得声明两遍。"""
    with pytest.raises(ValidationError) as excinfo:
        parse_file_declarations(
            [f"{tmp_path}/key:/run/key", f"{tmp_path}/key:/run/other"]
        )
    assert "宿主路径重复声明" in str(excinfo.value)


def test_duplicate_container_path_rejected(tmp_path: Path) -> None:
    """同一容器内路径不得声明两遍。"""
    with pytest.raises(ValidationError) as excinfo:
        parse_file_declarations(
            [f"{tmp_path}/a:/run/key", f"{tmp_path}/b:/run/key"]
        )
    assert "容器内路径重复声明" in str(excinfo.value)


def test_empty_declaration_rejected() -> None:
    """空声明直接拒绝。"""
    with pytest.raises(ValidationError) as excinfo:
        parse_file_declaration("   ")
    assert "不能为空" in str(excinfo.value)


def test_multiple_declarations_parsed(tmp_path: Path) -> None:
    """多条声明按声明顺序解析。"""
    specs = parse_file_declarations(
        [f"{tmp_path}/a:/run/a", f"{tmp_path}/b:/run/b"]
    )
    assert [spec.container_path for spec in specs] == ["/run/a", "/run/b"]


def test_staged_path_layout(tmp_path: Path) -> None:
    """暂存布局：目录在沙箱用户家目录内，副本名带序号前缀。"""
    home = tmp_path / "home"
    assert staging_root(home) == home / ".sandbox-files"
    assert staged_path(home, 0, "/data/key") == home / ".sandbox-files" / "0-key"
    assert staged_path(home, 1, "/data/key") == home / ".sandbox-files" / "1-key"
    # 原件名取不到时兜底为 file
    assert staged_path(home, 2, "/") == home / ".sandbox-files" / "2-file"
