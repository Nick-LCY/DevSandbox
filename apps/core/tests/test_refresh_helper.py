"""文件注入副本刷新 helper 的定向单元测试。

被测对象是**随包分发的窄用途脚本** ``sandbox_platform/_refresh_helper.py``：
以「``sys.executable -I <绝对路径>``」调用（一项 JSON 元数据；**只认 stdin**
投递，argv 载荷一律拒绝），断言它的分类码、退出码与**落盘结果**。

覆盖口径（与 01 任务逐条对应）：

- **对象身份**：单文件原位覆盖保持 inode（挂载身份不变）；目录保留根；
- **成员不原位截断**：目录成员**换新 inode**（同目录排他临时文件 + 原子替换），
  共享 inode 的另一份副本**一个字节不动**；
- **增改删**：目录镜像的新增 / 更新 / 删除过时项；
- **空目录**：源里真实存在的空目录保留（本身不被删）；
- **源缺失 / 读失败**：分类为 ``SOURCE_UNSAFE``，**目标一个字节都不动**；
- **不完整不删**：源树枚举不全时**不执行镜像删除**；
- **符号链接 / 非常规文件**：源自身是符号链接、树内有符号链接、树内有 FIFO
  一律拒绝；
- **目的校验**：根身份 / 种类不符、目标是符号链接、目标是冒名硬链接 ⇒
  ``DESTINATION_UNSAFE``，目标零改动；
- **部分失败重试**：写入阶段失败报 ``PARTIAL``（可能部分更新），修正后
  **手动重试**可收敛；
- **协议收紧**：只认 stdin（argv 载荷拒绝）、uid / gid 不得为 0、受限根必须
  是绝对路径、暂存根由调用方建且必须私有。

测试全部落在 ``tmp_path`` 里，不碰真实沙箱、不碰宿主真实数据。
"""

from __future__ import annotations

import json
import os
import socket
import stat
import subprocess
import sys
from pathlib import Path

import pytest

import sandbox_platform

#: helper 的绝对路径（随包分发，调用方按此定位）
HELPER_PATH = Path(sandbox_platform.__file__).with_name("_refresh_helper.py")

#: 分类码 → 退出码（与 helper 的固定契约一致）
EXIT_BY_CODE = {
    "OK": 0,
    "SOURCE_UNSAFE": 10,
    "DESTINATION_UNSAFE": 20,
    "PARTIAL": 30,
    "INTERNAL": 40,
}


# ---------------------------------------------------------------- 调用夹具


def _invoke(
    request: dict,
    *,
    transport: str = "stdin",
    extra_argv: list[str] | None = None,
) -> tuple[int, dict]:
    """调用 helper，返回 ``(退出码, 结果 JSON)``。

    ``transport`` 决定 JSON 怎么投递：``stdin`` 走管道（既有 ``run`` 的
    ``stdin_text`` 口径）；``argv`` 作为**单个** argv 元素传入——**只用于
    断言 argv 载荷被拒绝**（helper 只认 stdin）。

    ``extra_argv`` 用于验证**唯一允许**的 argv：可选的 ``--job-id <32hex>``
    操作令牌（非敏感，仅供 ``/proc`` 识别本次执行）。
    """
    payload = json.dumps(request)
    argv = [sys.executable, "-I", str(HELPER_PATH)]
    if extra_argv is not None:
        argv.extend(extra_argv)
    if transport == "argv":
        argv.append(payload)
        result = subprocess.run(argv, capture_output=True, text=True, timeout=120)
    else:
        result = subprocess.run(
            argv, input=payload, capture_output=True, text=True, timeout=120
        )
    lines = result.stdout.splitlines()
    # stdout 恒为一行 JSON：正文与 traceback 一律不进 stdout
    assert len(lines) == 1, f"stdout 不是一行：{result.stdout!r} / {result.stderr!r}"
    body = json.loads(lines[0])
    assert result.stderr == "", f"stderr 应为空：{result.stderr!r}"
    return result.returncode, body


def _request(
    source: Path,
    staged: Path,
    kind: str,
    *,
    spool_root: Path,
    forbidden_roots: list[str] | None = None,
    create_spool: bool = True,
    **overrides: object,
) -> dict:
    """按目标当前身份构造一份请求。

    **暂存根由调用方创建**（helper 只验「私有实际目录」，不 mkdir、不 chmod）。
    """
    target_stat = os.stat(staged)
    if create_spool:
        spool_root.mkdir(parents=True, exist_ok=True)
        spool_root.chmod(0o700)
    payload: dict[str, object] = {
        "source_path": str(source),
        "staged_path": str(staged),
        "kind": kind,
        "staged_dev": target_stat.st_dev,
        "staged_ino": target_stat.st_ino,
        "uid": os.getuid(),
        "gid": os.getgid(),
        "forbidden_roots": forbidden_roots or [],
        "spool_root": str(spool_root),
    }
    payload.update(overrides)
    return payload


def _tree(root: Path) -> dict[str, str]:
    """目录快照：相对路径 → 内容（目录记 ``"<dir>"``）。"""
    snapshot: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        rel = str(path.relative_to(root))
        if path.is_symlink():
            snapshot[rel] = "<link>"
        elif path.is_dir():
            snapshot[rel] = "<dir>"
        else:
            snapshot[rel] = path.read_text(encoding="utf-8")
    return snapshot


# ---------------------------------------------------------------- 单文件：身份与内容


def test_single_file_refresh_keeps_inode_and_updates_content(tmp_path: Path) -> None:
    """单文件原位覆盖：内容变新，**inode 不变**（挂载身份不变）。"""
    source = tmp_path / "source.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("新内容\n", encoding="utf-8")
    staged.write_text("旧内容\n", encoding="utf-8")

    before = os.stat(staged)
    code, body = _invoke(
        _request(source, staged, "file", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["OK"]
    assert body == {"code": "OK"}
    after = os.stat(staged)
    assert (after.st_dev, after.st_ino) == (before.st_dev, before.st_ino)
    assert staged.read_text(encoding="utf-8") == "新内容\n"


def test_single_file_refresh_sets_owner_and_mode(tmp_path: Path) -> None:
    """刷新后副本仍是沙箱用户属主、文件 0600。"""
    source = tmp_path / "source.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    staged.chmod(0o644)

    code, _ = _invoke(_request(source, staged, "file", spool_root=tmp_path / "spool"))
    assert code == EXIT_BY_CODE["OK"]
    info = os.stat(staged)
    assert info.st_uid == os.getuid()
    assert info.st_gid == os.getgid()
    assert stat.S_IMODE(info.st_mode) == 0o600


def test_source_is_never_modified(tmp_path: Path) -> None:
    """宿主原件零接触：权限、属主、内容、mtime 全不变。"""
    source = tmp_path / "source.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("原件\n", encoding="utf-8")
    source.chmod(0o640)
    staged.write_text("旧\n", encoding="utf-8")

    before = os.stat(source)
    before_mtime = before.st_mtime_ns
    code, _ = _invoke(_request(source, staged, "file", spool_root=tmp_path / "spool"))
    assert code == EXIT_BY_CODE["OK"]
    after = os.stat(source)
    assert (after.st_mode, after.st_uid, after.st_gid) == (
        before.st_mode,
        before.st_uid,
        before.st_gid,
    )
    assert after.st_mtime_ns == before_mtime
    assert source.read_text(encoding="utf-8") == "原件\n"


# ---------------------------------------------------------------- 目录：镜像语义


def test_directory_mirror_adds_updates_deletes(tmp_path: Path) -> None:
    """目录镜像：新增 / 更新 / 删除过时项。"""
    source = tmp_path / "src"
    staged = tmp_path / "staged"
    (source / "sub").mkdir(parents=True)
    (source / "keep.txt").write_text("新 keep\n", encoding="utf-8")
    (source / "new.txt").write_text("新增\n", encoding="utf-8")
    (source / "sub" / "deep.txt").write_text("深层\n", encoding="utf-8")
    staged.mkdir()
    (staged / "keep.txt").write_text("旧 keep\n", encoding="utf-8")
    (staged / "gone.txt").write_text("该删\n", encoding="utf-8")
    (staged / "sub").mkdir()
    (staged / "sub" / "stale.txt").write_text("也该删\n", encoding="utf-8")

    code, body = _invoke(
        _request(source, staged, "directory", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["OK"]
    assert body == {"code": "OK"}
    assert _tree(staged) == {
        "keep.txt": "新 keep\n",
        "new.txt": "新增\n",
        "sub": "<dir>",
        "sub/deep.txt": "深层\n",
    }


def test_directory_mirror_keeps_root_identity(tmp_path: Path) -> None:
    """目录刷新保留挂载根本身（同一 inode）。"""
    source = tmp_path / "src"
    staged = tmp_path / "staged"
    source.mkdir()
    (source / "a.txt").write_text("a\n", encoding="utf-8")
    staged.mkdir()
    (staged / "a.txt").write_text("旧\n", encoding="utf-8")

    before = os.stat(staged)
    code, _ = _invoke(
        _request(source, staged, "directory", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["OK"]
    after = os.stat(staged)
    assert (after.st_dev, after.st_ino) == (before.st_dev, before.st_ino)
    assert stat.S_IMODE(after.st_mode) == 0o700


def test_empty_source_directory_is_success_and_clears_members(tmp_path: Path) -> None:
    """源目录为空：**成功**枚举（不是失败），副本成员被清空、根保留。"""
    source = tmp_path / "src"
    staged = tmp_path / "staged"
    source.mkdir()
    staged.mkdir()
    (staged / "old.txt").write_text("旧\n", encoding="utf-8")

    code, body = _invoke(
        _request(source, staged, "directory", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["OK"]
    assert body == {"code": "OK"}
    assert staged.is_dir()
    assert list(staged.iterdir()) == []


def test_real_empty_subdirectory_is_preserved(tmp_path: Path) -> None:
    """源里真实存在的空目录：副本对应目录**本身保留**，内容被清空。"""
    source = tmp_path / "src"
    staged = tmp_path / "staged"
    (source / "empty").mkdir(parents=True)
    staged.mkdir()
    (staged / "empty").mkdir()
    (staged / "empty" / "stale.txt").write_text("旧\n", encoding="utf-8")

    code, _ = _invoke(
        _request(source, staged, "directory", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["OK"]
    assert (staged / "empty").is_dir()
    assert list((staged / "empty").iterdir()) == []


def test_member_type_change_file_replaces_directory(tmp_path: Path) -> None:
    """成员类型变化（源是文件、副本是目录）：副本侧换成文件。"""
    source = tmp_path / "src"
    staged = tmp_path / "staged"
    source.mkdir()
    (source / "item").write_text("现在是文件\n", encoding="utf-8")
    staged.mkdir()
    (staged / "item").mkdir()
    (staged / "item" / "inner.txt").write_text("旧\n", encoding="utf-8")

    code, _ = _invoke(
        _request(source, staged, "directory", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["OK"]
    assert (staged / "item").is_file()
    assert (staged / "item").read_text(encoding="utf-8") == "现在是文件\n"


def test_member_type_change_directory_replaces_file(tmp_path: Path) -> None:
    """成员类型变化（源是目录、副本是文件）：副本侧换成目录。"""
    source = tmp_path / "src"
    staged = tmp_path / "staged"
    (source / "item").mkdir(parents=True)
    (source / "item" / "inner.txt").write_text("新\n", encoding="utf-8")
    staged.mkdir()
    (staged / "item").write_text("旧文件\n", encoding="utf-8")

    code, _ = _invoke(
        _request(source, staged, "directory", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["OK"]
    assert (staged / "item").is_dir()
    assert (staged / "item" / "inner.txt").read_text(encoding="utf-8") == "新\n"


# ---------------------------------------------------------------- 源侧拒绝：目标零改动


def test_missing_source_rejected_and_target_untouched(tmp_path: Path) -> None:
    """源缺失：报 ``SOURCE_UNSAFE``，**副本不动**。"""
    staged = tmp_path / "staged.txt"
    staged.write_text("旧内容\n", encoding="utf-8")

    code, body = _invoke(
        _request(tmp_path / "missing.txt", staged, "file", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["SOURCE_UNSAFE"]
    assert body["code"] == "SOURCE_UNSAFE"
    assert body["reason"] == "source_missing"
    assert staged.read_text(encoding="utf-8") == "旧内容\n"


@pytest.mark.skipif(os.geteuid() == 0, reason="root 不受文件权限位限制")
def test_unreadable_source_rejected_and_target_untouched(tmp_path: Path) -> None:
    """源读失败（权限不足）：报 ``SOURCE_UNSAFE``，副本不动。"""
    source = tmp_path / "source.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("读不到\n", encoding="utf-8")
    source.chmod(0o000)
    staged.write_text("旧内容\n", encoding="utf-8")

    try:
        code, body = _invoke(
            _request(source, staged, "file", spool_root=tmp_path / "spool")
        )
    finally:
        source.chmod(0o600)
    assert code == EXIT_BY_CODE["SOURCE_UNSAFE"]
    assert body["code"] == "SOURCE_UNSAFE"
    assert staged.read_text(encoding="utf-8") == "旧内容\n"


def test_source_symlink_rejected(tmp_path: Path) -> None:
    """源自身是符号链接：一律拒绝（不跟随、不复制链接）。"""
    real = tmp_path / "real.txt"
    real.write_text("真身\n", encoding="utf-8")
    link = tmp_path / "link.txt"
    link.symlink_to(real)
    staged = tmp_path / "staged.txt"
    staged.write_text("旧内容\n", encoding="utf-8")

    code, body = _invoke(
        _request(link, staged, "file", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["SOURCE_UNSAFE"]
    assert body["reason"] == "source_symlink"
    assert staged.read_text(encoding="utf-8") == "旧内容\n"


def test_symlink_inside_source_tree_rejected(tmp_path: Path) -> None:
    """源目录树内的符号链接：一律拒绝。"""
    source = tmp_path / "src"
    staged = tmp_path / "staged"
    source.mkdir()
    (source / "ok.txt").write_text("正常\n", encoding="utf-8")
    (source / "link.txt").symlink_to(tmp_path / "elsewhere.txt")
    staged.mkdir()
    (staged / "ok.txt").write_text("旧\n", encoding="utf-8")

    code, body = _invoke(
        _request(source, staged, "directory", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["SOURCE_UNSAFE"]
    assert body["reason"] == "source_symlink_in_tree"
    assert (staged / "ok.txt").read_text(encoding="utf-8") == "旧\n"


def test_special_file_inside_source_tree_rejected(tmp_path: Path) -> None:
    """源目录树内的非常规文件（FIFO）：一律拒绝。"""
    source = tmp_path / "src"
    staged = tmp_path / "staged"
    source.mkdir()
    (source / "ok.txt").write_text("正常\n", encoding="utf-8")
    os.mkfifo(source / "pipe")
    staged.mkdir()
    (staged / "ok.txt").write_text("旧\n", encoding="utf-8")

    code, body = _invoke(
        _request(source, staged, "directory", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["SOURCE_UNSAFE"]
    assert body["reason"] == "special_file_in_tree"
    assert (staged / "ok.txt").read_text(encoding="utf-8") == "旧\n"


def test_source_inside_forbidden_root_rejected(tmp_path: Path) -> None:
    """源落在受限根内：拒绝，副本不动。"""
    restricted = tmp_path / "restricted"
    restricted.mkdir()
    source = restricted / "secret.txt"
    source.write_text("机密\n", encoding="utf-8")
    staged = tmp_path / "staged.txt"
    staged.write_text("旧内容\n", encoding="utf-8")

    code, body = _invoke(
        _request(
            source,
            staged,
            "file",
            spool_root=tmp_path / "spool",
            forbidden_roots=[str(restricted)],
        )
    )
    assert code == EXIT_BY_CODE["SOURCE_UNSAFE"]
    assert body["reason"] == "restricted"
    assert staged.read_text(encoding="utf-8") == "旧内容\n"


def test_member_inside_forbidden_root_rejected(tmp_path: Path) -> None:
    """树内成员落在受限根内：整棵树拒绝，副本不动。"""
    source = tmp_path / "src"
    staged = tmp_path / "staged"
    (source / "inner").mkdir(parents=True)
    (source / "ok.txt").write_text("正常\n", encoding="utf-8")
    (source / "inner" / "secret.txt").write_text("机密\n", encoding="utf-8")
    staged.mkdir()
    (staged / "ok.txt").write_text("旧\n", encoding="utf-8")

    code, body = _invoke(
        _request(
            source,
            staged,
            "directory",
            spool_root=tmp_path / "spool",
            forbidden_roots=[str(source / "inner")],
        )
    )
    assert code == EXIT_BY_CODE["SOURCE_UNSAFE"]
    assert body["reason"] == "restricted"
    assert (staged / "ok.txt").read_text(encoding="utf-8") == "旧\n"


def test_source_kind_change_rejected(tmp_path: Path) -> None:
    """源类型与元数据不符（文件变目录）：拒绝，副本不动。"""
    source = tmp_path / "src"
    staged = tmp_path / "staged.txt"
    source.mkdir()
    (source / "inner.txt").write_text("x\n", encoding="utf-8")
    staged.write_text("旧内容\n", encoding="utf-8")

    code, body = _invoke(
        _request(source, staged, "file", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["SOURCE_UNSAFE"]
    assert body["reason"] == "source_kind_mismatch"
    assert staged.read_text(encoding="utf-8") == "旧内容\n"


def test_symlinked_ancestor_is_allowed(tmp_path: Path) -> None:
    """祖先路径是符号链接：允许（已校验安全的祖先路径解析）。"""
    real_dir = tmp_path / "real"
    real_dir.mkdir()
    source = real_dir / "source.txt"
    source.write_text("内容\n", encoding="utf-8")
    alias = tmp_path / "alias"
    alias.symlink_to(real_dir)
    staged = tmp_path / "staged.txt"
    staged.write_text("旧\n", encoding="utf-8")

    code, _ = _invoke(
        _request(alias / "source.txt", staged, "file", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["OK"]
    assert staged.read_text(encoding="utf-8") == "内容\n"


# ---------------------------------------------------------------- 目的侧校验：目标零改动


def test_target_identity_mismatch_rejected(tmp_path: Path) -> None:
    """目标身份与元数据不符（dev/ino 对不上）：拒绝，目标零改动。"""
    source = tmp_path / "source.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("新\n", encoding="utf-8")
    staged.write_text("旧\n", encoding="utf-8")

    code, body = _invoke(
        _request(
            source,
            staged,
            "file",
            spool_root=tmp_path / "spool",
            staged_ino=os.stat(staged).st_ino + 1,
        )
    )
    assert code == EXIT_BY_CODE["DESTINATION_UNSAFE"]
    assert body["reason"] == "target_identity_mismatch"
    assert staged.read_text(encoding="utf-8") == "旧\n"


def test_target_kind_mismatch_rejected(tmp_path: Path) -> None:
    """目标种类与元数据不符（声明文件、实际目录）：拒绝，目标零改动。"""
    source = tmp_path / "source.txt"
    staged = tmp_path / "staged"
    source.write_text("新\n", encoding="utf-8")
    staged.mkdir()
    (staged / "inner.txt").write_text("旧\n", encoding="utf-8")

    code, body = _invoke(
        _request(source, staged, "file", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["DESTINATION_UNSAFE"]
    assert body["reason"] == "target_kind_mismatch"
    assert (staged / "inner.txt").read_text(encoding="utf-8") == "旧\n"


def test_target_symlink_rejected(tmp_path: Path) -> None:
    """目标是符号链接：拒绝（不跟随、不写穿），目标零改动。"""
    source = tmp_path / "source.txt"
    real = tmp_path / "real.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("新\n", encoding="utf-8")
    real.write_text("旧\n", encoding="utf-8")
    staged.symlink_to(real)

    code, body = _invoke(
        _request(source, staged, "file", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["DESTINATION_UNSAFE"]
    assert body["reason"] == "target_symlink"
    assert real.read_text(encoding="utf-8") == "旧\n"


def test_target_hardlink_rejected(tmp_path: Path) -> None:
    """目标是冒名硬链接（nlink > 1）：拒绝，绝不写到另一份副本上。"""
    source = tmp_path / "source.txt"
    staged = tmp_path / "staged.txt"
    other = tmp_path / "other.txt"
    source.write_text("新\n", encoding="utf-8")
    staged.write_text("旧\n", encoding="utf-8")
    os.link(staged, other)

    code, body = _invoke(
        _request(source, staged, "file", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["DESTINATION_UNSAFE"]
    assert body["reason"] == "target_hardlinked"
    assert staged.read_text(encoding="utf-8") == "旧\n"
    assert other.read_text(encoding="utf-8") == "旧\n"


# ---------------------------------------------------------------- 不完整不删 / 部分失败


@pytest.mark.skipif(os.geteuid() == 0, reason="root 不受文件权限位限制")
def test_incomplete_enumeration_does_not_delete_members(tmp_path: Path) -> None:
    """源树枚举不全：报 ``SOURCE_UNSAFE``，**不执行镜像删除**。"""
    source = tmp_path / "src"
    staged = tmp_path / "staged"
    (source / "locked").mkdir(parents=True)
    (source / "ok.txt").write_text("正常\n", encoding="utf-8")
    (source / "locked").chmod(0o000)
    staged.mkdir()
    (staged / "ok.txt").write_text("旧\n", encoding="utf-8")
    (staged / "stale.txt").write_text("不该被删\n", encoding="utf-8")

    try:
        code, body = _invoke(
            _request(source, staged, "directory", spool_root=tmp_path / "spool")
        )
    finally:
        (source / "locked").chmod(0o700)
    assert code == EXIT_BY_CODE["SOURCE_UNSAFE"]
    assert body["reason"] == "source_incomplete"
    # 关键断言：枚举不全 ⇒ 一个成员都不删、内容都不改
    assert (staged / "stale.txt").read_text(encoding="utf-8") == "不该被删\n"
    assert (staged / "ok.txt").read_text(encoding="utf-8") == "旧\n"


@pytest.mark.skipif(os.geteuid() == 0, reason="root 不受文件权限位限制")
def test_partial_failure_reports_partial_and_retry_succeeds(tmp_path: Path) -> None:
    """写入阶段失败：报 ``PARTIAL``（可能部分更新），修正后重试可收敛。

    失败点：托管副本的**根目录**只读（0500）⇒ 轮到根目录里的成员时建不出
    临时文件（成员不原位截断，**只读文件本身挡不住写入**，挡路的是目录）。
    """
    source = tmp_path / "src"
    staged = tmp_path / "staged"
    source.mkdir()
    (source / "a-sub").mkdir()
    (source / "a-sub" / "x.txt").write_text("新 x\n", encoding="utf-8")
    (source / "z-root.txt").write_text("新 z\n", encoding="utf-8")
    staged.mkdir()
    (staged / "a-sub").mkdir()
    (staged / "a-sub" / "x.txt").write_text("旧 x\n", encoding="utf-8")
    (staged / "z-root.txt").write_text("旧 z\n", encoding="utf-8")
    (staged / "stale.txt").write_text("不该被删\n", encoding="utf-8")
    staged.chmod(0o500)

    try:
        code, body = _invoke(
            _request(source, staged, "directory", spool_root=tmp_path / "spool")
        )
    finally:
        staged.chmod(0o700)
    assert code == EXIT_BY_CODE["PARTIAL"]
    assert body["code"] == "PARTIAL"
    # 部分更新：排在前面的成员已写新内容（子目录可写）
    assert (staged / "a-sub" / "x.txt").read_text(encoding="utf-8") == "新 x\n"
    # 失败的成员**没被截断**（不原位写）：旧内容完好
    assert (staged / "z-root.txt").read_text(encoding="utf-8") == "旧 z\n"
    # 失败后不续跑：镜像删除阶段根本没开始
    assert (staged / "stale.txt").exists()
    # 临时产物不留残留（临时产物不是备份）
    leftovers = [
        item.name for item in staged.iterdir() if item.name.startswith(".refresh")
    ]
    assert leftovers == []

    # 修正后由用户手动重试：收敛到源的样子
    code, body = _invoke(
        _request(source, staged, "directory", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["OK"]
    assert (staged / "a-sub" / "x.txt").read_text(encoding="utf-8") == "新 x\n"
    assert (staged / "z-root.txt").read_text(encoding="utf-8") == "新 z\n"
    assert not (staged / "stale.txt").exists()


# ---------------------------------------------------------------- 协议细节


def test_no_spool_residue_after_refresh(tmp_path: Path) -> None:
    """私有暂存只存新内容：刷新后不留任何残留（匿名文件 + 无备份）。"""
    source = tmp_path / "src"
    staged = tmp_path / "staged"
    spool_root = tmp_path / "spool"
    source.mkdir()
    (source / "a.txt").write_text("内容\n", encoding="utf-8")
    staged.mkdir()
    (staged / "a.txt").write_text("旧\n", encoding="utf-8")

    code, _ = _invoke(_request(source, staged, "directory", spool_root=spool_root))
    assert code == EXIT_BY_CODE["OK"]
    assert spool_root.is_dir()
    assert list(spool_root.iterdir()) == []


def test_argv_payload_rejected(tmp_path: Path) -> None:
    """argv 载荷一律拒绝（载荷不进命令行）：内部错误，目标零改动。"""
    source = tmp_path / "source.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("新\n", encoding="utf-8")
    staged.write_text("旧\n", encoding="utf-8")
    request = _request(source, staged, "file", spool_root=tmp_path / "spool")

    code, body = _invoke(request, transport="argv")
    assert code == EXIT_BY_CODE["INTERNAL"]
    assert body["reason"] == "bad_arguments"
    assert staged.read_text(encoding="utf-8") == "旧\n"

    # stdin 是唯一入口：同一份请求走 stdin 就能成
    stdin_code, stdin_body = _invoke(request, transport="stdin")
    assert (stdin_code, stdin_body) == (EXIT_BY_CODE["OK"], {"code": "OK"})


def test_invalid_payload_rejected(tmp_path: Path) -> None:
    """请求不合法（缺字段）：归内部错误，目标零改动。"""
    staged = tmp_path / "staged.txt"
    staged.write_text("旧\n", encoding="utf-8")
    code, body = _invoke(
        {
            "source_path": str(tmp_path / "src.txt"),
            "staged_path": str(staged),
            "kind": "file",
        }
    )
    assert code == EXIT_BY_CODE["INTERNAL"]
    assert body["code"] == "INTERNAL"
    assert staged.read_text(encoding="utf-8") == "旧\n"


def test_unknown_kind_rejected(tmp_path: Path) -> None:
    """未知的条目类型：归内部错误。"""
    source = tmp_path / "source.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("新\n", encoding="utf-8")
    staged.write_text("旧\n", encoding="utf-8")
    code, body = _invoke(
        _request(source, staged, "socket", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["INTERNAL"]
    assert body["code"] == "INTERNAL"


def test_result_line_never_leaks_paths_or_content(tmp_path: Path) -> None:
    """结果行只含分类码与细分码：不带路径、不带正文。"""
    source = tmp_path / "secret-name.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("机密内容\n", encoding="utf-8")
    staged.write_text("旧\n", encoding="utf-8")
    code, body = _invoke(
        _request(source, staged, "file", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["OK"]
    assert body == {"code": "OK"}
    assert "secret-name" not in json.dumps(body)
    assert "机密内容" not in json.dumps(body)


# ---------------------------------------------------------------- 成员不原位截断


def test_directory_member_refresh_replaces_inode_and_spares_twin(
    tmp_path: Path,
) -> None:
    """目录成员**不原位截断**：成员换新 inode，共享 inode 的另一份不动。"""
    source = tmp_path / "src"
    staged = tmp_path / "staged"
    source.mkdir()
    (source / "a.txt").write_text("新内容\n", encoding="utf-8")
    staged.mkdir()
    (staged / "a.txt").write_text("旧内容\n", encoding="utf-8")
    # 副本之外的另一份硬链接（共享 inode）：刷新**不许**改到它
    twin = tmp_path / "twin.txt"
    os.link(staged / "a.txt", twin)
    before = os.stat(staged / "a.txt")
    assert before.st_nlink == 2

    code, body = _invoke(
        _request(source, staged, "directory", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["OK"]
    assert body == {"code": "OK"}
    after = os.stat(staged / "a.txt")
    assert (staged / "a.txt").read_text(encoding="utf-8") == "新内容\n"
    # 成员拿到的是**新 inode**（原位截断共享 inode 的路已经堵死）
    assert after.st_ino != before.st_ino
    assert after.st_nlink == 1
    # 共享 inode 的另一份**一个字节都没动**
    assert twin.read_text(encoding="utf-8") == "旧内容\n"
    assert os.stat(twin).st_nlink == 1


def test_special_members_do_not_block_probe(tmp_path: Path) -> None:
    """非常规成员（套接字 / FIFO）：探测只 ``stat`` 不打开 ⇒ 不卡住。"""
    source = tmp_path / "src"
    staged = tmp_path / "staged"
    source.mkdir()
    (source / "a.txt").write_text("新\n", encoding="utf-8")
    staged.mkdir()
    (staged / "a.txt").write_text("旧\n", encoding="utf-8")
    sock_path = staged / "sock"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.bind(str(sock_path))
    os.mkfifo(staged / "pipe")

    code, body = _invoke(
        _request(source, staged, "directory", spool_root=tmp_path / "spool")
    )
    assert code == EXIT_BY_CODE["OK"]
    assert body == {"code": "OK"}
    assert (staged / "a.txt").read_text(encoding="utf-8") == "新\n"
    assert not sock_path.exists()
    assert not (staged / "pipe").exists()


# ---------------------------------------------------------------- 协议收紧


def test_uid_zero_rejected(tmp_path: Path) -> None:
    """uid=0（等于没降权）：拒绝，目标零改动。"""
    source = tmp_path / "source.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("新\n", encoding="utf-8")
    staged.write_text("旧\n", encoding="utf-8")
    code, body = _invoke(
        _request(source, staged, "file", spool_root=tmp_path / "spool", uid=0)
    )
    assert code == EXIT_BY_CODE["INTERNAL"]
    assert body["reason"] == "bad_payload"
    assert staged.read_text(encoding="utf-8") == "旧\n"


def test_gid_zero_rejected(tmp_path: Path) -> None:
    """gid=0：拒绝，目标零改动。"""
    source = tmp_path / "source.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("新\n", encoding="utf-8")
    staged.write_text("旧\n", encoding="utf-8")
    code, body = _invoke(
        _request(source, staged, "file", spool_root=tmp_path / "spool", gid=0)
    )
    assert code == EXIT_BY_CODE["INTERNAL"]
    assert body["reason"] == "bad_payload"
    assert staged.read_text(encoding="utf-8") == "旧\n"


def test_relative_forbidden_root_rejected(tmp_path: Path) -> None:
    """受限根是相对路径：拒绝（会随工作目录漂移）。"""
    source = tmp_path / "source.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("新\n", encoding="utf-8")
    staged.write_text("旧\n", encoding="utf-8")
    code, body = _invoke(
        _request(
            source,
            staged,
            "file",
            spool_root=tmp_path / "spool",
            forbidden_roots=["relative/root"],
        )
    )
    assert code == EXIT_BY_CODE["INTERNAL"]
    assert body["reason"] == "bad_payload"
    assert staged.read_text(encoding="utf-8") == "旧\n"


def test_forbidden_root_alias_symlink_rejected(tmp_path: Path) -> None:
    """受限根给的是符号链接别名：**实际根**对照 ⇒ 照样拒绝。"""
    real = tmp_path / "real"
    (real / "secret").mkdir(parents=True)
    source = real / "secret" / "s.txt"
    source.write_text("机密\n", encoding="utf-8")
    alias = tmp_path / "alias"
    alias.symlink_to(real)
    staged = tmp_path / "staged.txt"
    staged.write_text("旧\n", encoding="utf-8")

    code, body = _invoke(
        _request(
            source,
            staged,
            "file",
            spool_root=tmp_path / "spool",
            forbidden_roots=[str(alias)],
        )
    )
    assert code == EXIT_BY_CODE["SOURCE_UNSAFE"]
    assert body["reason"] == "restricted"
    assert staged.read_text(encoding="utf-8") == "旧\n"


def test_spool_root_missing_is_not_created_by_helper(tmp_path: Path) -> None:
    """暂存根**由调用方创建**：helper 不 mkdir，缺了就报内部错误。"""
    source = tmp_path / "source.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("新\n", encoding="utf-8")
    staged.write_text("旧\n", encoding="utf-8")
    spool_root = tmp_path / "spool"
    request = _request(
        source, staged, "file", spool_root=spool_root, create_spool=False
    )
    code, body = _invoke(request)
    assert code == EXIT_BY_CODE["INTERNAL"]
    assert body["reason"] == "spool_missing"
    # helper 没有替调用方把暂存根建出来
    assert not spool_root.exists()
    assert staged.read_text(encoding="utf-8") == "旧\n"


def test_non_private_spool_root_rejected(tmp_path: Path) -> None:
    """暂存根不私有（组 / 其它用户可进）：拒绝，不碰调用方的路径。"""
    source = tmp_path / "source.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("新\n", encoding="utf-8")
    staged.write_text("旧\n", encoding="utf-8")
    spool_root = tmp_path / "spool"
    request = _request(source, staged, "file", spool_root=spool_root)
    spool_root.chmod(0o755)

    code, body = _invoke(request)
    assert code == EXIT_BY_CODE["INTERNAL"]
    assert body["reason"] == "spool_not_private"
    # helper 不 chmod 调用方的路径
    assert stat.S_IMODE(os.stat(spool_root).st_mode) == 0o755
    assert staged.read_text(encoding="utf-8") == "旧\n"


# ---------------------------------------------------------------- 操作令牌


def test_job_id_flag_is_optional_and_keeps_stdin_contract(tmp_path: Path) -> None:
    """可选的 ``--job-id <32hex>`` 不改变请求语义：载荷仍只走 stdin。"""
    source = tmp_path / "source.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("新\n", encoding="utf-8")
    staged.write_text("旧\n", encoding="utf-8")
    token = "0123456789abcdef0123456789abcdef"
    request = _request(source, staged, "file", spool_root=tmp_path / "spool")

    code, body = _invoke(request, extra_argv=["--job-id", token])
    assert (code, body) == (EXIT_BY_CODE["OK"], {"code": "OK"})
    assert staged.read_text(encoding="utf-8") == "新\n"
    # 令牌只做进程识别，不从结果行外泄
    assert token not in json.dumps(body)


@pytest.mark.parametrize(
    "extra_argv",
    [
        ["--job-id", "/tmp/not-a-token"],  # 任何路径 / 非令牌参数都拒绝
        ["--job-id", "0123456789ABCDEF0123456789ABCDEF"],  # 大写不合契约
        ["--job-id", "0123456789abcdef"],  # 长度不对
        ["--job-id"],  # 缺令牌值
        ["--job-id", "0123456789abcdef0123456789abcdef", "--other"],  # 多余参数
        ["--source", "/tmp/x"],  # 未知标志（路径不入 argv）
    ],
)
def test_job_id_rejects_paths_and_malformed_flags(
    tmp_path: Path, extra_argv: list[str]
) -> None:
    """argv 只允许一个合法令牌：路径 / 畸形标志一律 ``bad_arguments``。"""
    source = tmp_path / "source.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("新\n", encoding="utf-8")
    staged.write_text("旧\n", encoding="utf-8")
    request = _request(source, staged, "file", spool_root=tmp_path / "spool")

    code, body = _invoke(request, extra_argv=extra_argv)
    assert code == EXIT_BY_CODE["INTERNAL"]
    assert body["reason"] == "bad_arguments"
    assert staged.read_text(encoding="utf-8") == "旧\n"
    # 错误行同样不含路径
    assert str(source) not in json.dumps(body)
