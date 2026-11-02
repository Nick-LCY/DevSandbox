"""宿主级文件注入测试（需要真实 root 权限）。

覆盖：注入文件在容器内可读且只读、原件零接触、目录递归复制、符号链接拒绝、
宿主路径不存在拒绝、停止→启动期间副本保留、删除沙箱后副本随家目录消失。

镜像一律用平台基础镜像 ``sandbox-platform/base:0.3.0``（宿主上没有就跳过），
不依赖任何个人镜像。测试数据全部落在 ``tmp_path``，测试自带清理。
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from sandbox_platform import (
    CreateRequest,
    SandboxService,
    UserContext,
    ValidationError,
)
from sandbox_platform.daemon import UserDaemon
from sandbox_platform.userspace import SystemUser, UserSpaceManager

pytestmark = pytest.mark.root

# 平台基础镜像：容器内需要 bash 与基础工具做读写断言
BASE_IMAGE = "sandbox-platform/base:0.3.0"


def _base_image() -> str:
    """取平台基础镜像；宿主上没有该镜像就跳过（不依赖个人镜像）。"""
    inspect = subprocess.run(
        ["docker", "image", "inspect", BASE_IMAGE],
        capture_output=True,
        check=False,
    )
    if inspect.returncode != 0:
        pytest.skip(f"宿主上没有镜像 {BASE_IMAGE}，跳过宿主级文件注入用例")
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


def _exists_as_user(daemon: UserDaemon, path: Path) -> bool:
    """以沙箱用户身份判断路径是否存在（暂存目录 0700，测试进程读不到）。"""
    return daemon.run_as_user(["test", "-e", str(path)], check=False).ok


def test_injected_file_readable_in_container_and_readonly(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """注入的 0600 文件在容器内可读，且写入失败（只读生效）。"""
    name = "sboxfile1"
    secret = tmp_path / "secret.txt"
    secret.write_text("机密内容", encoding="utf-8")
    secret.chmod(0o600)

    request = CreateRequest(
        name=name,
        image=_base_image(),
        files=(f"{secret}:/run/secret",),
    )
    result = service.create(request)
    metadata = result.metadata
    daemon = _daemon_for(service, metadata)
    try:
        # ① 容器内读得到副本内容
        inside = daemon.exec_in_container(
            metadata.container_name, ["cat", "/run/secret"]
        )
        assert inside.ok, inside.output
        assert inside.stdout.strip() == "机密内容"

        # ② 只读：写入失败
        write = daemon.exec_in_container(
            metadata.container_name,
            ["sh", "-c", "echo tampered > /run/secret"],
        )
        assert not write.ok
        assert "Read-only file system" in write.output

        # ③ 副本属主是沙箱用户，权限 0600
        staged = _staging_of(metadata) / "0-secret.txt"
        assert _exists_as_user(daemon, staged)
        info = daemon.run_as_user(["stat", "-c", "%U %a", str(staged)], check=False)
        assert info.ok, info.output
        owner, mode = info.stdout.split()
        assert owner == metadata.system_user
        assert mode == "600"

        # ④ 注入副本不进用户声明挂载清单（那是「平台不回收」的口径）
        assert metadata.mounts == []
        assert len(metadata.files) == 1
        assert metadata.files[0].read_only is True
        assert metadata.files[0].container_path == "/run/secret"
    finally:
        _cleanup(service, name)


def test_original_untouched_after_injection(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """注入过程对原件零接触：权限位、属主、内容、mtime 全不变。"""
    name = "sboxfile2"
    secret = tmp_path / "keep.txt"
    secret.write_text("原样保留", encoding="utf-8")
    secret.chmod(0o600)
    before = secret.stat()

    request = CreateRequest(
        name=name,
        image=_base_image(),
        files=(f"{secret}:/run/keep",),
    )
    service.create(request)
    try:
        after = secret.stat()
        assert after.st_mode == before.st_mode
        assert after.st_uid == before.st_uid
        assert after.st_gid == before.st_gid
        assert after.st_mtime == before.st_mtime
        assert secret.read_text(encoding="utf-8") == "原样保留"
    finally:
        _cleanup(service, name)


def test_injected_directory_copied_recursively(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """目录递归复制：嵌套文件在容器内可读。"""
    name = "sboxfile3"
    source = tmp_path / "bundle"
    nested = source / "inner"
    nested.mkdir(parents=True)
    (source / "top.txt").write_text("顶层", encoding="utf-8")
    (nested / "deep.txt").write_text("深层", encoding="utf-8")
    source.chmod(0o700)
    nested.chmod(0o700)

    request = CreateRequest(
        name=name,
        image=_base_image(),
        files=(f"{source}:/run/bundle",),
    )
    result = service.create(request)
    metadata = result.metadata
    daemon = _daemon_for(service, metadata)
    try:
        top = daemon.exec_in_container(
            metadata.container_name, ["cat", "/run/bundle/top.txt"]
        )
        assert top.ok, top.output
        assert top.stdout.strip() == "顶层"

        deep = daemon.exec_in_container(
            metadata.container_name, ["cat", "/run/bundle/inner/deep.txt"]
        )
        assert deep.ok, deep.output
        assert deep.stdout.strip() == "深层"
    finally:
        _cleanup(service, name)


def test_symlink_host_path_rejected(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """宿主路径是符号链接：直接拒绝，沙箱不创建。"""
    name = "sboxfile4"
    target = tmp_path / "real.txt"
    target.write_text("真实内容", encoding="utf-8")
    link = tmp_path / "link.txt"
    link.symlink_to(target)

    with pytest.raises(ValidationError) as excinfo:
        service.create(
            CreateRequest(
                name=name,
                image=_base_image(),
                files=(f"{link}:/run/link",),
            )
        )
    assert "符号链接" in str(excinfo.value)
    assert service.find(name) is None


def test_missing_host_path_rejected(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """宿主路径不存在：直接拒绝（平台不代为创建）。"""
    name = "sboxfile5"
    missing = tmp_path / "missing.txt"

    with pytest.raises(ValidationError) as excinfo:
        service.create(
            CreateRequest(
                name=name,
                image=_base_image(),
                files=(f"{missing}:/run/missing",),
            )
        )
    assert "不存在" in str(excinfo.value)
    assert service.find(name) is None


def test_staged_copy_survives_stop_start(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """停止 → 启动：副本保留，容器内仍可读。"""
    name = "sboxfile6"
    secret = tmp_path / "persist.txt"
    secret.write_text("跨启停", encoding="utf-8")
    secret.chmod(0o600)

    service.create(
        CreateRequest(
            name=name,
            image=_base_image(),
            files=(f"{secret}:/run/persist",),
        )
    )
    try:
        metadata = service.get(name)
        daemon = _daemon_for(service, metadata)
        staged = _staging_of(metadata) / "0-persist.txt"
        assert _exists_as_user(daemon, staged)

        service.stop(name)
        assert _exists_as_user(daemon, staged)

        restarted = service.start(name)
        daemon = _daemon_for(service, restarted)
        assert _exists_as_user(daemon, staged)

        inside = daemon.exec_in_container(
            restarted.container_name, ["cat", "/run/persist"]
        )
        assert inside.ok, inside.output
        assert inside.stdout.strip() == "跨启停"
    finally:
        _cleanup(service, name)


def test_staged_copy_removed_with_sandbox(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """删除沙箱：副本随家目录消失，原件仍在。"""
    name = "sboxfile7"
    secret = tmp_path / "gone.txt"
    secret.write_text("原件还在", encoding="utf-8")
    secret.chmod(0o600)

    result = service.create(
        CreateRequest(
            name=name,
            image=_base_image(),
            files=(f"{secret}:/run/gone",),
        )
    )
    metadata = result.metadata
    daemon = _daemon_for(service, metadata)
    staging = _staging_of(metadata)
    assert _exists_as_user(daemon, staging)

    service.delete(name)
    # 家目录连同暂存目录一起没了（副本与沙箱同寿）
    assert not Path(metadata.home).exists()
    assert not _exists_as_user(daemon, staging)
    assert secret.read_text(encoding="utf-8") == "原件还在"
    assert (secret.stat().st_mode & 0o777) == 0o600
    assert os.path.isfile(secret)
