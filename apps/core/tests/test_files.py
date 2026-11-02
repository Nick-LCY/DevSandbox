"""文件注入声明解析与暂存布局的单元测试。

纯单元：不碰宿主（不复制、不起容器），只验证声明解析的校验口径与暂存路径布局。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sandbox_platform import (
    FileSpec,
    SandboxHomeScope,
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


def test_sensitive_host_path_bypassed_by_dotdot_rejected() -> None:
    """``..`` 绕不过敏感清单：先归一化再比对。

    ``/tmp/../etc/passwd`` 词法上不在 ``/etc`` 之下，未归一化就会漏掉它。
    """
    with pytest.raises(ValidationError) as excinfo:
        parse_file_declaration("/tmp/../etc/passwd:/run/x")
    assert "敏感清单" in str(excinfo.value)


def test_dotdot_in_host_path_is_normalized() -> None:
    """归一化后的宿主路径才是真正拿去复制的路径。"""
    spec = parse_file_declaration("/tmp/./data/../data/secret:/run/secret")
    assert spec.host_path == "/tmp/data/secret"


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


# ---------------------------------------------------------------- 注入源的可见范围
def test_source_inside_other_sandbox_home_rejected(tmp_path: Path) -> None:
    """注入源落在其他沙箱用户家目录内：拒绝。"""
    home_root = tmp_path / "home"
    (home_root / "sandbox-victim").mkdir(parents=True)
    scope = SandboxHomeScope(user_prefix="sandbox", home_root=home_root)
    with pytest.raises(ValidationError) as excinfo:
        parse_file_declaration(
            f"{home_root}/sandbox-victim/.ssh/id_rsa:/run/key",
            home_scope=scope,
        )
    message = str(excinfo.value)
    assert "其他沙箱用户家目录" in message
    assert "不允许注入" in message


def test_source_is_other_sandbox_home_itself_rejected(tmp_path: Path) -> None:
    """家目录本身也是「其他沙箱用户家目录」：一样拒绝。"""
    home_root = tmp_path / "home"
    (home_root / "sandbox-victim").mkdir(parents=True)
    scope = SandboxHomeScope(user_prefix="sandbox", home_root=home_root)
    with pytest.raises(ValidationError) as excinfo:
        parse_file_declaration(f"{home_root}/sandbox-victim:/run/home", home_scope=scope)
    assert "其他沙箱用户家目录" in str(excinfo.value)


def test_source_inside_other_sandbox_home_rejected_after_normalization(
    tmp_path: Path,
) -> None:
    """归一化之后才判定：``..`` 绕不过家目录范围限制。"""
    home_root = tmp_path / "home"
    (home_root / "sandbox-victim").mkdir(parents=True)
    scope = SandboxHomeScope(user_prefix="sandbox", home_root=home_root)
    with pytest.raises(ValidationError) as excinfo:
        parse_file_declaration(
            f"{home_root}/sandbox-other/../sandbox-victim/key:/run/key",
            home_scope=scope,
        )
    assert "其他沙箱用户家目录" in str(excinfo.value)


def test_own_sandbox_home_is_allowed(tmp_path: Path) -> None:
    """本次创建流程自己新建的家目录不算「其他沙箱用户家目录」。"""
    home_root = tmp_path / "home"
    own = home_root / "sandbox-demo"
    own.mkdir(parents=True)
    scope = SandboxHomeScope(
        user_prefix="sandbox",
        home_root=home_root,
        exclude_home=own,
    )
    spec = parse_file_declaration(f"{own}/data:/run/data", home_scope=scope)
    assert spec.host_path == f"{own}/data"


def test_source_outside_sandbox_homes_allowed(tmp_path: Path) -> None:
    """家目录范围之外的路径照常允许。"""
    home_root = tmp_path / "home"
    home_root.mkdir()
    scope = SandboxHomeScope(user_prefix="sandbox", home_root=home_root)
    spec = parse_file_declaration(f"{tmp_path}/data:/run/data", home_scope=scope)
    assert spec.host_path == f"{tmp_path}/data"


def test_home_scope_without_prefix_match_is_allowed(tmp_path: Path) -> None:
    """不是平台沙箱用户的家目录（名字不带前缀）：不受范围限制。"""
    home_root = tmp_path / "home"
    (home_root / "someone").mkdir(parents=True)
    scope = SandboxHomeScope(user_prefix="sandbox", home_root=home_root)
    spec = parse_file_declaration(f"{home_root}/someone/data:/run/data", home_scope=scope)
    assert spec.host_path == f"{home_root}/someone/data"
