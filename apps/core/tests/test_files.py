"""文件注入声明解析与暂存布局的单元测试。

纯单元：不碰宿主（不复制、不起容器），只验证声明解析的校验口径与暂存路径布局。
系统用户表（``getent passwd``）在需要时被换成假数据，不读真宿主。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sandbox_platform import (
    FileSpec,
    Privilege,
    SandboxHomeScope,
    ValidationError,
    parse_file_declaration,
    parse_file_declarations,
    probe_host_path,
    staged_path,
    staging_root,
)


def _install_fake_passwd(
    monkeypatch: pytest.MonkeyPatch,
    entries: dict[str, str],
) -> None:
    """把系统用户表换成假数据（``用户名 -> 家目录``）。

    只接管 ``getent passwd`` 与 ``test -d`` 两条命令，其余命令照常执行。
    """
    from sandbox_platform import files as files_module
    from sandbox_platform.command import CommandResult

    real_run = files_module.run

    def fake_run(argv, **kwargs):
        args = [str(item) for item in argv]
        if args[:1] == ["sudo"]:
            args = args[2:]
        if args[:1] == ["getent"]:
            stdout = "".join(
                f"{name}:x:1001:1001:x:{home}:/bin/bash\n"
                for name, home in entries.items()
            )
            return CommandResult(tuple(argv), 0, stdout, "")
        if args[:2] == ["test", "-d"]:
            ok = Path(args[2]).is_dir()
            return CommandResult(tuple(argv), 0 if ok else 1, "", "")
        return real_run(argv, **kwargs)

    monkeypatch.setattr(files_module, "run", fake_run)


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


def test_sensitive_host_path_bypassed_by_double_slash_rejected() -> None:
    """``//`` 前缀绕不过敏感清单。

    ``os.path.normpath`` 按 POSIX 规则把**恰好两个**前导斜杠原样留着，
    ``pathlib`` 又把 ``//etc`` 当成独立根，于是 ``//etc/shadow`` 能绕开
    按 ``/etc`` 根的清单比对。归一化时必须把前导多斜杠压平。
    """
    with pytest.raises(ValidationError) as excinfo:
        parse_file_declaration("//etc/shadow:/run/x")
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
def test_source_inside_sandbox_home_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """注入源落在沙箱用户家目录内：拒绝。"""
    home_root = tmp_path / "home"
    victim = home_root / "sandbox-victim"
    victim.mkdir(parents=True)
    _install_fake_passwd(monkeypatch, {"sandbox-victim": str(victim)})
    scope = SandboxHomeScope(user_prefix="sandbox")
    with pytest.raises(ValidationError) as excinfo:
        parse_file_declaration(
            f"{victim}/.ssh/id_rsa:/run/key",
            home_scope=scope,
        )
    message = str(excinfo.value)
    assert "沙箱用户家目录" in message
    assert "不允许注入" in message


def test_source_is_sandbox_home_itself_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """家目录本身也是受限家目录：一样拒绝。"""
    home_root = tmp_path / "home"
    victim = home_root / "sandbox-victim"
    victim.mkdir(parents=True)
    _install_fake_passwd(monkeypatch, {"sandbox-victim": str(victim)})
    scope = SandboxHomeScope(user_prefix="sandbox")
    with pytest.raises(ValidationError) as excinfo:
        parse_file_declaration(f"{victim}:/run/home", home_scope=scope)
    assert "沙箱用户家目录" in str(excinfo.value)


def test_source_inside_sandbox_home_rejected_after_normalization(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """归一化之后才判定：``..`` 绕不过家目录范围限制。"""
    home_root = tmp_path / "home"
    victim = home_root / "sandbox-victim"
    victim.mkdir(parents=True)
    _install_fake_passwd(monkeypatch, {"sandbox-victim": str(victim)})
    scope = SandboxHomeScope(user_prefix="sandbox")
    with pytest.raises(ValidationError) as excinfo:
        parse_file_declaration(
            f"{home_root}/sandbox-other/../sandbox-victim/key:/run/key",
            home_scope=scope,
        )
    assert "沙箱用户家目录" in str(excinfo.value)


def test_own_sandbox_home_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """本次目标沙箱自己的家目录同样受限：一律拒绝。

    口径拍板：**没有**「本次新建家目录放行」这条例外——干跑与实跑走同一套
    判定，注入源不得落在任何沙箱用户家目录内。
    """
    home_root = tmp_path / "home"
    own = home_root / "sandbox-demo"
    own.mkdir(parents=True)
    _install_fake_passwd(monkeypatch, {"sandbox-demo": str(own)})
    scope = SandboxHomeScope(user_prefix="sandbox")
    with pytest.raises(ValidationError) as excinfo:
        parse_file_declaration(f"{own}/data:/run/data", home_scope=scope)
    message = str(excinfo.value)
    assert "沙箱用户家目录" in message
    assert "不允许注入" in message


def test_sandbox_home_outside_default_home_root_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """家目录不在 ``/home`` 下（宿主自定义家目录根）：一样拦得住。

    受限家目录集合经 ``getent passwd`` 枚举，不再扫 ``/home`` 固定根。
    """
    home_root = tmp_path / "srv" / "homes"
    victim = home_root / "sandbox-victim"
    victim.mkdir(parents=True)
    _install_fake_passwd(monkeypatch, {"sandbox-victim": str(victim)})
    scope = SandboxHomeScope(user_prefix="sandbox")
    with pytest.raises(ValidationError) as excinfo:
        parse_file_declaration(f"{victim}/key:/run/key", home_scope=scope)
    assert "沙箱用户家目录" in str(excinfo.value)


def test_stale_sandbox_home_entry_is_ignored(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """用户条目残留但家目录已删：不算受限家目录。"""
    _install_fake_passwd(monkeypatch, {"sandbox-gone": str(tmp_path / "gone")})
    scope = SandboxHomeScope(user_prefix="sandbox")
    spec = parse_file_declaration(f"{tmp_path}/data:/run/data", home_scope=scope)
    assert spec.host_path == f"{tmp_path}/data"


def test_source_outside_sandbox_homes_allowed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """家目录范围之外的路径照常允许。"""
    _install_fake_passwd(monkeypatch, {})
    scope = SandboxHomeScope(user_prefix="sandbox")
    spec = parse_file_declaration(f"{tmp_path}/data:/run/data", home_scope=scope)
    assert spec.host_path == f"{tmp_path}/data"


def test_home_scope_without_prefix_match_is_allowed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """不是平台沙箱用户的家目录（名字不带前缀）：不受范围限制。"""
    someone = tmp_path / "home" / "someone"
    someone.mkdir(parents=True)
    _install_fake_passwd(monkeypatch, {"someone": str(someone)})
    scope = SandboxHomeScope(user_prefix="sandbox")
    spec = parse_file_declaration(f"{someone}/data:/run/data", home_scope=scope)
    assert spec.host_path == f"{someone}/data"


# ---------------------------------------------------------------- 符号链接解析后的复核
def test_symlinked_segment_resolving_into_forbidden_rejected(tmp_path: Path) -> None:
    """中间路径段是符号链接：按解析后的真实路径复核受限范围。

    ``/tmp/link/secret``（``link`` 指向受限目录）词法上完全看不出问题，
    只有 ``readlink -f`` 解析出的真实路径才看得穿。
    """
    restricted = tmp_path / "restricted"
    restricted.mkdir()
    (restricted / "secret.txt").write_text("s", encoding="utf-8")
    link = tmp_path / "link"
    link.symlink_to(restricted)

    with pytest.raises(ValidationError) as excinfo:
        probe_host_path(
            Privilege(enabled=False),
            str(link / "secret.txt"),
            extra_forbidden=[restricted],
        )
    message = str(excinfo.value)
    assert "经符号链接解析后落在受限范围" in message
    assert str(restricted / "secret.txt") in message
    assert str(link / "secret.txt") in message


def test_symlinked_segment_resolving_into_sandbox_home_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """符号链接指向沙箱用户家目录：一样拒绝。"""
    home = tmp_path / "homes" / "sandbox-demo"
    home.mkdir(parents=True)
    (home / "key").write_text("k", encoding="utf-8")
    link = tmp_path / "link"
    link.symlink_to(home)
    _install_fake_passwd(monkeypatch, {"sandbox-demo": str(home)})

    with pytest.raises(ValidationError) as excinfo:
        probe_host_path(
            Privilege(enabled=False),
            str(link / "key"),
            home_scope=SandboxHomeScope(user_prefix="sandbox"),
        )
    assert "经符号链接解析后落在受限范围" in str(excinfo.value)


def test_symlinked_segment_to_allowed_target_passes(tmp_path: Path) -> None:
    """符号链接指向不在受限范围内的位置：正常通过。"""
    target = tmp_path / "data"
    target.mkdir()
    (target / "file.txt").write_text("x", encoding="utf-8")
    link = tmp_path / "link"
    link.symlink_to(target)

    kind = probe_host_path(Privilege(enabled=False), str(link / "file.txt"))
    assert kind == "f"
