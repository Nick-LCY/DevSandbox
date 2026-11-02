"""宿主级文件注入测试（需要真实 root 权限）。

覆盖：注入文件在容器内可读且只读、原件零接触（文件型与目录型原件）、目录递归
复制、符号链接拒绝（路径本身 / 目录内 / 悬空链接）、非常规文件（FIFO）拒绝、
宿主路径不存在拒绝、复制中途失败不留半截副本、停止→启动期间副本保留、
副本被清理后启动报错、删除沙箱后副本随家目录消失。

镜像一律用平台基础镜像 ``sandbox-platform/base:0.3.0``（宿主上没有就跳过），
不依赖任何个人镜像。测试数据全部落在 ``tmp_path``，测试自带清理。
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from sandbox_platform import (
    CommandError,
    CreateRequest,
    FileSpec,
    LifecycleError,
    SandboxService,
    UserContext,
    ValidationError,
)
from sandbox_platform import files as files_module
from sandbox_platform.command import CommandResult, run
from sandbox_platform.daemon import UserDaemon
from sandbox_platform.files import stage_file_copies, staging_root
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


def _snapshot(path: Path) -> dict[str, tuple[int, int, int, float, bytes]]:
    """原件的完整快照：相对路径 →（权限位, 属主, 属组, mtime, 内容）。"""
    items = sorted(path.rglob("*")) if path.is_dir() else [path]
    result: dict[str, tuple[int, int, int, float, bytes]] = {}
    for item in items:
        relative = item.relative_to(path) if path.is_dir() else Path(".")
        info = item.stat()
        content = item.read_bytes() if item.is_file() else b""
        result[str(relative)] = (
            info.st_mode,
            info.st_uid,
            info.st_gid,
            info.st_mtime,
            content,
        )
    return result


@pytest.mark.parametrize("kind", ["file", "directory"])
def test_original_untouched_after_injection(
    service: SandboxService, tmp_path: Path, require_root: None, kind: str
) -> None:
    """注入过程对原件零接触：权限位、属主、内容、mtime 全不变。

    文件型与目录型原件都覆盖：目录型还要看目录本身的权限与 mtime，
    以及里面的内容没被改动。
    """
    name = "sboxfile2f" if kind == "file" else "sboxfile2d"
    if kind == "file":
        original = tmp_path / "keep.txt"
        original.write_text("原样保留", encoding="utf-8")
        original.chmod(0o600)
    else:
        original = tmp_path / "keepdir"
        original.mkdir()
        (original / "inner.txt").write_text("目录内容", encoding="utf-8")
        original.chmod(0o700)
    before = original.stat()
    before_tree = _snapshot(original)

    request = CreateRequest(
        name=name,
        image=_base_image(),
        files=(f"{original}:/run/keep",),
    )
    service.create(request)
    try:
        after = original.stat()
        assert after.st_mode == before.st_mode
        assert after.st_uid == before.st_uid
        assert after.st_gid == before.st_gid
        assert after.st_mtime == before.st_mtime
        assert _snapshot(original) == before_tree
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


def test_nested_symlink_in_source_directory_rejected(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """目录里含符号链接：拒绝注入（既不跟随、也不复制链接本身）。"""
    name = "sboxfile8"
    source = tmp_path / "bundle"
    source.mkdir()
    (source / "real.txt").write_text("真实内容", encoding="utf-8")
    (source / "link.txt").symlink_to(source / "real.txt")
    source.chmod(0o700)

    with pytest.raises(ValidationError) as excinfo:
        service.create(
            CreateRequest(
                name=name,
                image=_base_image(),
                files=(f"{source}:/run/bundle",),
            )
        )
    assert "里有符号链接" in str(excinfo.value)
    assert service.find(name) is None


def test_stage_failure_cleans_half_baked_copies(
    service: SandboxService, tmp_path: Path, require_root: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """复制中途失败：暂存目录被清掉，不留半截副本在宿主上。"""
    home = tmp_path / "home"
    home.mkdir()
    user = SystemUser(
        name="sandbox-stagefail",
        uid=os.getuid(),
        gid=os.getgid(),
        home=home,
    )
    source = tmp_path / "half.txt"
    source.write_text("半成品", encoding="utf-8")
    real_run = files_module.run

    def fake_run(argv, **kwargs):
        argv = list(argv)
        if "cp" in argv:
            result = CommandResult(tuple(argv), 1, "", "cp: 复制失败（测试注入）")
            if kwargs.get("check"):
                result.raise_for_status()
            return result
        return real_run(argv, **kwargs)

    monkeypatch.setattr(files_module, "run", fake_run)
    with pytest.raises(CommandError):
        stage_file_copies(
            [FileSpec(host_path=str(source), container_path="/run/half")],
            user=user,
            privilege=service.privilege,
        )
    assert not staging_root(home).exists()


def test_start_fails_when_staged_copy_is_gone(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """暂存副本被清掉后启动：明确报错，不让 Docker 静默建空目录。"""
    name = "sboxfilea"
    secret = tmp_path / "vanish.txt"
    secret.write_text("会消失", encoding="utf-8")
    secret.chmod(0o600)

    service.create(
        CreateRequest(
            name=name,
            image=_base_image(),
            files=(f"{secret}:/run/vanish",),
        )
    )
    try:
        metadata = service.get(name)
        staging = _staging_of(metadata)
        assert _exists_as_user(_daemon_for(service, metadata), staging)
        # 手工删掉暂存目录（模拟家目录被清理）
        run(service.privilege.wrap(["rm", "-rf", str(staging)]), check=True)

        with pytest.raises(LifecycleError) as excinfo:
            service.start(name)
        assert "注入文件副本已不存在" in str(excinfo.value)
    finally:
        _cleanup(service, name)


def test_dangling_symlink_host_path_rejected(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """悬空符号链接：报「符号链接」，不误报成「不存在」。"""
    name = "sboxfileb"
    link = tmp_path / "dangling.txt"
    link.symlink_to(tmp_path / "not-there.txt")

    with pytest.raises(ValidationError) as excinfo:
        service.create(
            CreateRequest(
                name=name,
                image=_base_image(),
                files=(f"{link}:/run/dangling",),
            )
        )
    message = str(excinfo.value)
    assert "符号链接" in message
    assert "不存在" not in message


def test_source_directory_with_fifo_rejected(
    service: SandboxService, tmp_path: Path, require_root: None
) -> None:
    """目录里含 FIFO：拒绝注入（复制它会阻塞，容器里也没意义）。"""
    name = "sboxfilec"
    source = tmp_path / "withfifo"
    source.mkdir()
    (source / "ok.txt").write_text("正常文件", encoding="utf-8")
    os.mkfifo(source / "pipe")
    source.chmod(0o700)

    with pytest.raises(ValidationError) as excinfo:
        service.create(
            CreateRequest(
                name=name,
                image=_base_image(),
                files=(f"{source}:/run/withfifo",),
            )
        )
    assert "非常规文件" in str(excinfo.value)
    assert service.find(name) is None
