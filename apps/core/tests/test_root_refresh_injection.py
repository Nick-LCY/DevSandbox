"""宿主级注入副本刷新测试（需要真实 root 权限与免密 sudo）。

在**真实的免 root 沙箱**上验刷新通道的硬口径：

- 单文件刷新：容器内读到**新内容**、**inode 不变**（挂载身份不变）、
  容器内**仍只读**、副本仍 **0600 / 属主是沙箱用户**、宿主**原件零接触**；
- 目录刷新：**递归镜像**（新增 / 更新 / 删除过时项）、**真实空目录保留**；
- 源缺失：刷新失败且**副本不清空**（预校验失败 ⇒ 零改动）；
- 修正源后**手动重试**可成功；
- **不停机**：容器 id / StartedAt 不变、容器内**独立运行的进程**不断、
  其它注入条目与普通挂载不受影响；
- 刷新入口的拒绝口径：未知条目 / 停机沙箱 / 类型改变。

镜像一律用平台基础镜像 ``sandbox-platform/base:0.3.0``（宿主上没有就跳过），
不依赖任何个人镜像。测试数据全部落在 ``tmp_path``，测试自带清理。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from sandbox_platform import (
    CreateRequest,
    RefreshError,
    SandboxService,
    UserContext,
)
from sandbox_platform.command import run
from sandbox_platform.daemon import UserDaemon
from sandbox_platform.userspace import SystemUser, UserSpaceManager

pytestmark = pytest.mark.root

#: 平台基础镜像：容器内需要 bash 与基础工具做读写断言
BASE_IMAGE = "sandbox-platform/base:0.3.0"


def _base_image() -> str:
    """取平台基础镜像；宿主上没有该镜像就跳过（不依赖个人镜像）。"""
    inspect = subprocess.run(
        ["docker", "image", "inspect", BASE_IMAGE],
        capture_output=True,
        check=False,
    )
    if inspect.returncode != 0:
        pytest.skip(f"宿主上没有镜像 {BASE_IMAGE}，跳过宿主级刷新用例")
    return BASE_IMAGE


def _daemon_for(service: SandboxService, metadata) -> UserDaemon:
    """按元数据构造守护进程操作入口。"""
    context = UserContext(
        user=metadata.system_user,
        uid=metadata.uid,
        gid=metadata.gid,
        home=Path(metadata.home),
    )
    return UserDaemon(context, service.privilege)


def _cleanup(service: SandboxService, name: str) -> None:
    """测试自清理：删除沙箱并兜底删除系统用户。"""
    try:
        service.delete(name)
    except Exception:  # noqa: BLE001,S110 - 清理兜底：失败也不阻断后续回收
        pass
    metadata = service.find(name)
    if metadata is not None:
        manager = UserSpaceManager(service.config, service.privilege)
        manager.remove_subid_range(metadata.system_user)
        user = SystemUser(
            name=metadata.system_user,
            uid=metadata.uid,
            gid=metadata.gid,
            home=Path(metadata.home),
        )
        if manager.user_exists(user.name):
            manager.remove_user(user)


def _staging_of(metadata) -> Path:
    """该沙箱的注入副本暂存目录。"""
    return Path(metadata.home) / ".sandbox-files"


def _identity(service: SandboxService, path: Path) -> tuple[int, int]:
    """取副本根的 ``(st_dev, st_ino)``（走特权通道：暂存目录 0700）。"""
    result = run(
        service.privilege.wrap(["stat", "-c", "%d %i", "--", str(path)]),
        check=False,
    )
    assert result.ok, result.output
    dev, ino = result.stdout.split()
    return int(dev), int(ino)


def _owner_mode(service: SandboxService, path: Path) -> tuple[str, str]:
    """取副本的属主与权限位（走特权通道）。"""
    result = run(
        service.privilege.wrap(["stat", "-c", "%U %a", "--", str(path)]),
        check=False,
    )
    assert result.ok, result.output
    owner, mode = result.stdout.split()
    return owner, mode


def _container_identity(daemon: UserDaemon, container: str) -> tuple[str, str]:
    """取容器的 ``(id, StartedAt)``。"""
    result = daemon.docker(
        ["inspect", "--format", "{{.Id}} {{.State.StartedAt}}", container],
        check=False,
    )
    assert result.ok, result.output
    parts = result.stdout.split()
    assert len(parts) == 2, result.stdout
    return parts[0], parts[1]


def _read_in_container(daemon: UserDaemon, container: str, path: str) -> str:
    """在容器内读一个文件的内容。"""
    result = daemon.exec_in_container(container, ["cat", path])
    assert result.ok, result.output
    return result.stdout


def _read_staged(service: SandboxService, path: Path) -> str:
    """读托管副本的内容（走特权通道：暂存目录 0700，属主是沙箱用户）。"""
    result = run(service.privilege.wrap(["cat", "--", str(path)]), check=False)
    assert result.ok, result.output
    return result.stdout


def _staged_exists(service: SandboxService, path: Path) -> bool:
    """托管副本里的某个成员还在不在（走特权通道）。"""
    return run(service.privilege.wrap(["test", "-e", str(path)]), check=False).ok


def _staged_entries(service: SandboxService, path: Path) -> list[str]:
    """列托管副本目录下的直接子项名（走特权通道）。"""
    result = run(service.privilege.wrap(["ls", "-A", str(path)]), check=False)
    assert result.ok, result.output
    return [item for item in result.stdout.split("\n") if item]


# ---------------------------------------------------------------- 单文件
def test_refresh_file_updates_content_without_recreating_container(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """单文件刷新：内容变新、inode 不变、容器不重建、原件零接触、只读仍生效。"""
    name = "sboxref1"
    source = tmp_path / "secret.txt"
    source.write_text("旧内容\n", encoding="utf-8")
    source.chmod(0o600)

    result = service.create(
        CreateRequest(
            name=name,
            image=_base_image(),
            files=(f"{source}:/run/secret",),
        )
    )
    metadata = result.metadata
    daemon = _daemon_for(service, metadata)
    try:
        # 注入声明记录：实例事实（源路径 / 副本 / 容器目标 / 种类 / 副本身份）
        assert len(metadata.injections) == 1
        record = metadata.injections[0]
        assert record.source_path == str(source)
        assert record.staged_path == str(Path(metadata.files[0].host_path))
        assert record.container_path == "/run/secret"
        assert record.kind == "file"
        staged = Path(record.staged_path)
        assert _identity(service, staged) == (record.dev, record.ino)

        # 容器内独立跑一个进程：刷新期间它不能断
        started = daemon.docker(["exec", "-d", metadata.container_name, "sleep", "600"])
        assert started.ok, started.output

        before_identity = _container_identity(daemon, metadata.container_name)
        before_inode = _identity(service, staged)

        # 换掉宿主原件的内容（模拟凭证轮换）
        source.write_text("新内容\n", encoding="utf-8")
        # 原件快照：刷新**前后**必须一模一样（平台不碰原件）
        source_stat_before = source.stat()

        service.refresh_injection(name, record.entry_id)

        # ① 容器内读到新内容
        assert _read_in_container(daemon, metadata.container_name, "/run/secret") == "新内容\n"
        # ② 容器没重建：id 与 StartedAt 都不变
        assert _container_identity(daemon, metadata.container_name) == before_identity
        # ③ 副本 inode 不变（挂载身份不变）
        assert _identity(service, staged) == before_inode
        # ④ 副本仍属沙箱用户、文件 0600
        owner, mode = _owner_mode(service, staged)
        assert owner == metadata.system_user
        assert mode == "600"
        # ⑤ 容器内仍只读
        write = daemon.exec_in_container(
            metadata.container_name, ["sh", "-c", "echo tampered > /run/secret"]
        )
        assert not write.ok
        assert "Read-only file system" in write.output
        # ⑥ 宿主原件零接触（权限位、属主、大小、mtime 全不变）
        source_stat_after = source.stat()
        assert (source_stat_after.st_mode, source_stat_after.st_uid, source_stat_after.st_gid) == (
            source_stat_before.st_mode,
            source_stat_before.st_uid,
            source_stat_before.st_gid,
        )
        assert source_stat_after.st_mtime_ns == source_stat_before.st_mtime_ns
        # ⑦ 容器内独立运行的进程还活着
        alive = daemon.exec_in_container(
            metadata.container_name, ["pgrep", "-f", "sleep 600"]
        )
        assert alive.ok, alive.output
    finally:
        _cleanup(service, name)


# ---------------------------------------------------------------- 目录
def test_refresh_directory_mirrors_add_update_delete(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """目录刷新：递归镜像（增 / 改 / 删）、真实空目录保留、容器不重建。"""
    name = "sboxref2"
    source = tmp_path / "bundle"
    (source / "sub").mkdir(parents=True)
    (source / "keep.txt").write_text("旧 keep\n", encoding="utf-8")
    (source / "sub" / "deep.txt").write_text("旧 deep\n", encoding="utf-8")
    # 这两个成员在刷新时从**源**里消失 ⇒ 刷新后必须从**副本**里消失
    (source / "sub" / "stale.txt").write_text("待删除\n", encoding="utf-8")
    (source / "empty").mkdir()
    (source / "empty" / "old.txt").write_text("空目录里的旧物\n", encoding="utf-8")
    source.chmod(0o755)

    result = service.create(
        CreateRequest(
            name=name,
            image=_base_image(),
            files=(f"{source}:/run/bundle",),
        )
    )
    metadata = result.metadata
    daemon = _daemon_for(service, metadata)
    try:
        record = metadata.injections[0]
        assert record.kind == "directory"
        staged = Path(record.staged_path)
        before_identity = _container_identity(daemon, metadata.container_name)

        # 源侧变化：新增 / 更新 / 删除 / 空目录
        (source / "new.txt").write_text("新增\n", encoding="utf-8")
        (source / "keep.txt").write_text("新 keep\n", encoding="utf-8")
        (source / "sub" / "deep.txt").write_text("新 deep\n", encoding="utf-8")
        # 源里已不存在的成员：刷新后必须从副本里删掉
        (source / "sub" / "stale.txt").unlink()
        (source / "empty" / "old.txt").unlink()

        service.refresh_injection(name, record.entry_id)

        # ① 容器内读到新内容（新增 / 更新）
        assert _read_in_container(daemon, metadata.container_name, "/run/bundle/new.txt") == "新增\n"
        assert (
            _read_in_container(daemon, metadata.container_name, "/run/bundle/keep.txt")
            == "新 keep\n"
        )
        assert (
            _read_in_container(daemon, metadata.container_name, "/run/bundle/sub/deep.txt")
            == "新 deep\n"
        )
        # ② 镜像删除：源里已不存在的成员从副本删除
        assert not _staged_exists(service, staged / "sub" / "stale.txt")
        # ③ 源里真实存在的空目录：本身保留（内容被清空）
        assert _staged_entries(service, staged / "empty") == []
        assert _staged_exists(service, staged / "empty")
        # ④ 容器没重建
        assert _container_identity(daemon, metadata.container_name) == before_identity
        # ⑤ 副本仍属沙箱用户、目录 0700
        owner, mode = _owner_mode(service, staged)
        assert owner == metadata.system_user
        assert mode == "700"
    finally:
        _cleanup(service, name)


# ---------------------------------------------------------------- 失败与重试
def test_refresh_missing_source_leaves_copy_intact(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """源缺失：刷新失败、**副本不清空**；修正源后手动重试可成功。"""
    name = "sboxref3"
    source = tmp_path / "bundle"
    source.mkdir()
    (source / "a.txt").write_text("内容\n", encoding="utf-8")

    result = service.create(
        CreateRequest(
            name=name,
            image=_base_image(),
            files=(f"{source}:/run/bundle",),
        )
    )
    metadata = result.metadata
    daemon = _daemon_for(service, metadata)
    try:
        record = metadata.injections[0]
        staged = Path(record.staged_path)

        # 源整个没了
        (source / "a.txt").unlink()
        source.rmdir()

        with pytest.raises(RefreshError) as excinfo:
            service.refresh_injection(name, record.entry_id)
        assert excinfo.value.reason == "precheck"
        # 副本一个字节都没动
        assert _read_staged(service, staged / "a.txt") == "内容\n"
        assert _read_in_container(daemon, metadata.container_name, "/run/bundle/a.txt") == "内容\n"

        # 修正源后手动重试
        source.mkdir()
        (source / "a.txt").write_text("修好的内容\n", encoding="utf-8")
        service.refresh_injection(name, record.entry_id)
        assert _read_staged(service, staged / "a.txt") == "修好的内容\n"
        assert (
            _read_in_container(daemon, metadata.container_name, "/run/bundle/a.txt")
            == "修好的内容\n"
        )
    finally:
        _cleanup(service, name)


def test_refresh_rejects_unknown_entry_and_stopped_sandbox(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """拒绝口径：未知条目 ⇒ 不存在；沙箱停机 ⇒ 预校验失败（不做自动启动）。"""
    name = "sboxref4"
    source = tmp_path / "secret.txt"
    source.write_text("内容\n", encoding="utf-8")

    result = service.create(
        CreateRequest(
            name=name,
            image=_base_image(),
            files=(f"{source}:/run/secret",),
        )
    )
    metadata = result.metadata
    try:
        with pytest.raises(RefreshError) as excinfo:
            service.refresh_injection(name, "inj-0-不是这个")
        assert excinfo.value.reason == "not_found"

        service.stop(name)
        with pytest.raises(RefreshError) as excinfo:
            service.refresh_injection(name, metadata.injections[0].entry_id)
        assert excinfo.value.reason == "precheck"
    finally:
        _cleanup(service, name)


def test_refresh_does_not_touch_other_injections(
    service: SandboxService, tmp_path: Path, external_dir: Path, require_root: None
) -> None:
    """刷新一条注入：其它注入条目与普通挂载**不受影响**。"""
    name = "sboxref5"
    first = tmp_path / "one.txt"
    second = tmp_path / "two.txt"
    first.write_text("一\n", encoding="utf-8")
    second.write_text("二\n", encoding="utf-8")
    # 普通挂载放在**沙箱用户能穿过**的目录里（/tmp 下的 0777 目录）
    external = external_dir
    (external / "keep.txt").write_text("挂载内容\n", encoding="utf-8")

    result = service.create(
        CreateRequest(
            name=name,
            image=_base_image(),
            files=(f"{first}:/run/one", f"{second}:/run/two"),
            mount_declarations=(f"{external}:/mnt/external",),
        )
    )
    metadata = result.metadata
    daemon = _daemon_for(service, metadata)
    try:
        assert len(metadata.injections) == 2
        target = next(
            item for item in metadata.injections if item.container_path == "/run/one"
        )
        other = next(
            item for item in metadata.injections if item.container_path == "/run/two"
        )
        other_staged = Path(other.staged_path)
        other_before = _read_staged(service, other_staged)

        first.write_text("一（更新）\n", encoding="utf-8")
        service.refresh_injection(name, target.entry_id)

        assert _read_in_container(daemon, metadata.container_name, "/run/one") == "一（更新）\n"
        # 其它注入条目不动
        assert _read_staged(service, other_staged) == other_before
        # 普通挂载不动
        assert (
            _read_in_container(daemon, metadata.container_name, "/mnt/external/keep.txt")
            == "挂载内容\n"
        )
    finally:
        _cleanup(service, name)


def test_refresh_rejects_kind_change(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """注入根类型改变（文件 ↔ 目录）：拒绝刷新，副本未被改动。"""
    name = "sboxref6"
    source = tmp_path / "secret.txt"
    source.write_text("内容\n", encoding="utf-8")

    result = service.create(
        CreateRequest(
            name=name,
            image=_base_image(),
            files=(f"{source}:/run/secret",),
        )
    )
    metadata = result.metadata
    try:
        record = metadata.injections[0]
        staged = Path(record.staged_path)
        before = _read_staged(service, staged)

        # 源从文件变成目录
        source.unlink()
        source.mkdir()
        (source / "inner.txt").write_text("换形态\n", encoding="utf-8")

        with pytest.raises(RefreshError) as excinfo:
            service.refresh_injection(name, record.entry_id)
        assert excinfo.value.reason == "precheck"
        assert _read_staged(service, staged) == before
    finally:
        _cleanup(service, name)
