"""文件注入副本刷新的**定向**单元测试（不需要 root）。

覆盖口径（02 任务逐条对应）：

- **元数据**：注入声明记录落盘 / 读回一致；**旧样本**（没有 ``injections``
  字段）照样读得出且**无刷新条目**；未知字段宽容；坏条目被跳过；
  条目标识**稳定**；
- **定位**：只认**本实例**元数据里的条目标识（旧实例没有条目 ⇒ 无可刷
  对象；条目与 ``files`` 清单对不上 ⇒ 拒绝）；
- **状态**：容器没运行 ⇒ 拒绝；源缺失 ⇒ 预校验失败且**副本零改动**；
- **探测 fail closed**：系统用户表读不出来 ⇒ 拒绝刷新（不放行）；
- **失败分类**：helper 的分类码 ⇒ 结构化分类码与**固定中文文案**
  （``partial`` 必须含「可能部分更新」）；认不出来的返回按内部错误保守处理；
- **重试**：失败后修正源，**手动重试**可成功；
- **互斥**：跨进程（第二个进程持锁）刷新与生命周期操作被拒；进程内两次
  刷新不并发；未知 name 不落锁文件；锁文件常驻不参与清理。

刷新链路的**写入动作**由随包分发的 helper 真跑（不 mock）：源与副本都在
``tmp_path`` 里，helper 以当前账号身份写回——单文件的 inode、目录的镜像
语义、原件零接触都在这一层验。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from sandbox_platform import (
    InjectionRecord,
    MountSpec,
    Privilege,
    RefreshError,
    SandboxConflictError,
    SandboxMetadata,
    SandboxService,
    injection_entry_id,
)
from sandbox_platform import daemon as daemon_module
from sandbox_platform import files as files_module
from sandbox_platform import refresh as refresh_module
from sandbox_platform.command import CommandResult

#: 容器内目标路径（测试里固定一个）
CONTAINER_PATH = "/run/injected"

#: 跨进程持锁的小脚本：拿到排他锁后往 stdout 报一声，然后一直等着
_HOLD_LOCK_SCRIPT = """
import fcntl
import os
import sys
import time

path = sys.argv[1]
fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
sys.stdout.write("locked\\n")
sys.stdout.flush()
time.sleep(120)
"""


# ---------------------------------------------------------------- 夹具
def _current_user_name() -> str:
    """当前账号的系统用户名（写入身份即当前账号）。"""
    import pwd

    return pwd.getpwuid(os.getuid()).pw_name


def _plain_privilege(service: SandboxService) -> None:
    """把服务切到「不套 sudo」的通道。

    单元测试不该依赖免密 sudo：helper 以当前账号身份跑，写入目标也在
    ``tmp_path`` 里（属主就是当前账号）。特权通道本身由 root 用例覆盖。
    """
    plain = Privilege(enabled=False)
    service.privilege = plain
    service.refreshes.privilege = plain
    service.refreshes.userspace.privilege = plain
    service.locker.privilege = plain


def _fake_running_container(monkeypatch: pytest.MonkeyPatch) -> None:
    """把「容器是否在运行」固定为「在运行」（不真起容器）。"""
    monkeypatch.setattr(
        daemon_module.UserDaemon, "container_running", lambda self, name: True
    )


def _write_metadata(
    service: SandboxService,
    name: str,
    *,
    source: Path,
    staged: Path,
    kind: str = "file",
    home: Path,
    container_path: str = CONTAINER_PATH,
) -> SandboxMetadata:
    """写一份带注入声明记录的沙箱元数据（模拟创建路径的产物）。"""
    info = os.stat(staged)
    record = InjectionRecord(
        entry_id=injection_entry_id(0, str(source), str(staged), container_path),
        source_path=str(source),
        staged_path=str(staged),
        container_path=container_path,
        kind=kind,
        dev=info.st_dev,
        ino=info.st_ino,
    )
    metadata = SandboxMetadata(
        name=name,
        system_user=_current_user_name(),
        uid=os.getuid(),
        gid=os.getgid(),
        home=str(home),
        subid_start=100000,
        subid_length=65536,
        image="example.invalid/base:latest",
        socket_path=f"/run/user/{os.getuid()}/docker.sock",
        socket_mount_path="/var/run/docker.sock",
        container_name=f"sandbox-{name}",
        container_id="container-id-placeholder",
        network_name=f"{name}-net",
        unit_path=str(home / "docker.service"),
        files=[
            MountSpec(
                host_path=str(staged),
                container_path=container_path,
                read_only=True,
                role="file",
            )
        ],
        injections=[record],
    )
    service.store.save(metadata)
    return metadata


# ---------------------------------------------------------------- 元数据
def test_injection_records_survive_save_and_load(
    service: SandboxService, tmp_path: Path
) -> None:
    """注入声明记录落盘后读回一致（additive，既有字段不受影响）。"""
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    metadata = _write_metadata(
        service, "metaok", source=source, staged=staged, home=tmp_path
    )

    loaded = service.get("metaok")
    assert loaded.injections == metadata.injections
    record = loaded.injections[0]
    assert record.source_path == str(source)
    assert record.staged_path == str(staged)
    assert record.container_path == CONTAINER_PATH
    assert record.kind == "file"
    assert record.dev == os.stat(staged).st_dev
    assert record.ino == os.stat(staged).st_ino
    # 原 `files` 语义不变
    assert [item.host_path for item in loaded.files] == [str(staged)]
    assert loaded.files[0].read_only is True


def test_old_metadata_without_injections_loads_empty(
    service: SandboxService, tmp_path: Path
) -> None:
    """**旧样本**（没有 ``injections`` 字段）照样读得出，且**无刷新条目**。"""
    service.store.sandbox_dir("oldsample").mkdir(parents=True, exist_ok=True)
    payload = {
        "name": "oldsample",
        "system_user": "sandbox-oldsample",
        "uid": 1001,
        "gid": 1001,
        "home": "/home/sandbox-oldsample",
        "subid_start": 100000,
        "subid_length": 65536,
        "image": "example.invalid/base:latest",
        "socket_path": "/run/user/1001/docker.sock",
        "socket_mount_path": "/var/run/docker.sock",
        "container_name": "sandbox-oldsample",
        "container_id": "cid",
        "network_name": "oldsample-net",
        "unit_path": "/home/sandbox-oldsample/docker.service",
        "mounts": [],
        "files": [],
    }
    (service.store.path_for("oldsample")).write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )

    loaded = service.get("oldsample")
    assert loaded.injections == []
    assert loaded.files == []


def test_unknown_metadata_fields_are_tolerated(
    service: SandboxService, tmp_path: Path
) -> None:
    """未知字段（含未知的注入条目字段）宽容：读得出来。"""
    service.store.sandbox_dir("future").mkdir(parents=True, exist_ok=True)
    payload = {
        "name": "future",
        "system_user": "sandbox-future",
        "uid": 1001,
        "gid": 1001,
        "home": "/home/sandbox-future",
        "subid_start": 100000,
        "subid_length": 65536,
        "image": "example.invalid/base:latest",
        "socket_path": "/run/user/1001/docker.sock",
        "socket_mount_path": "/var/run/docker.sock",
        "container_name": "sandbox-future",
        "container_id": "cid",
        "network_name": "future-net",
        "unit_path": "/home/sandbox-future/docker.service",
        "未来字段": {"随便": 1},
        "injections": [
            {
                "entry_id": "inj-0-abc",
                "source_path": "/tmp/a",
                "staged_path": "/tmp/b",
                "container_path": "/run/a",
                "kind": "file",
                "dev": 1,
                "ino": 2,
                "未来字段": 3,
            },
            {"entry_id": "坏的条目"},
            {"entry_id": "种类不对", "kind": "socket"},
        ],
    }
    (service.store.path_for("future")).write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )

    loaded = service.get("future")
    assert len(loaded.injections) == 1
    assert loaded.injections[0].entry_id == "inj-0-abc"


def test_injection_entry_id_is_stable() -> None:
    """条目标识稳定：同一组输入恒等，不同条目必不同。"""
    first = injection_entry_id(0, "/src/a", "/staged/a", "/run/a")
    again = injection_entry_id(0, "/src/a", "/staged/a", "/run/a")
    other = injection_entry_id(1, "/src/a", "/staged/a", "/run/a")
    assert first == again
    assert first != other


# ---------------------------------------------------------------- 定位与状态
def test_refresh_unknown_entry_rejected(
    service: SandboxService, tmp_path: Path
) -> None:
    """条目不存在：拒绝（结构化分类码 ``not_found``）。"""
    _plain_privilege(service)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    _write_metadata(service, "unknown", source=source, staged=staged, home=tmp_path)

    with pytest.raises(RefreshError) as excinfo:
        service.refresh_injection("unknown", "inj-0-不是这个")
    assert excinfo.value.reason == refresh_module.REASON_NOT_FOUND


def test_refresh_old_instance_without_entries_rejected(
    service: SandboxService, tmp_path: Path
) -> None:
    """旧实例没有注入条目 ⇒ 无可刷对象（不迁移、不补录）。"""
    _plain_privilege(service)
    service.store.sandbox_dir("legacy").mkdir(parents=True, exist_ok=True)
    (service.store.path_for("legacy")).write_text(
        json.dumps(
            {
                "name": "legacy",
                "system_user": "sandbox-legacy",
                "uid": 1001,
                "gid": 1001,
                "home": str(tmp_path),
                "subid_start": 100000,
                "subid_length": 65536,
                "image": "example.invalid/base:latest",
                "socket_path": "/run/user/1001/docker.sock",
                "socket_mount_path": "/var/run/docker.sock",
                "container_name": "sandbox-legacy",
                "container_id": "cid",
                "network_name": "legacy-net",
                "unit_path": "/tmp/docker.service",
                "mounts": [],
                "files": [],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    with pytest.raises(RefreshError) as excinfo:
        service.refresh_injection("legacy", "inj-0-随便")
    assert excinfo.value.reason == refresh_module.REASON_NOT_FOUND


def test_refresh_requires_running_container(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """容器没运行：拒绝刷新（不做自动启动）。"""
    _plain_privilege(service)
    monkeypatch.setattr(
        daemon_module.UserDaemon, "container_running", lambda self, name: False
    )
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    metadata = _write_metadata(
        service, "stopped", source=source, staged=staged, home=tmp_path
    )

    with pytest.raises(RefreshError) as excinfo:
        service.refresh_injection("stopped", metadata.injections[0].entry_id)
    assert excinfo.value.reason == refresh_module.REASON_PRECHECK
    assert "未运行" in str(excinfo.value)


def test_refresh_rejects_entry_not_matching_files(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """条目与 ``files`` 清单对不上：拒绝（副本路径不是平台记的那一份）。"""
    _plain_privilege(service)
    _fake_running_container(monkeypatch)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    metadata = _write_metadata(
        service, "mismatch", source=source, staged=staged, home=tmp_path
    )
    # 篡改副本路径（模拟元数据被改过）
    metadata.injections = [
        InjectionRecord(
            entry_id=metadata.injections[0].entry_id,
            source_path=metadata.injections[0].source_path,
            staged_path=str(tmp_path / "别的副本"),
            container_path=CONTAINER_PATH,
            kind="file",
            dev=1,
            ino=2,
        )
    ]
    service.store.save(metadata)

    with pytest.raises(RefreshError) as excinfo:
        service.refresh_injection("mismatch", metadata.injections[0].entry_id)
    assert excinfo.value.reason == refresh_module.REASON_NOT_FOUND


def test_refresh_rejects_path_as_entry_id(
    service: SandboxService, tmp_path: Path
) -> None:
    """入口只认条目标识：拿路径当标识用 ⇒ 认不出来（不是越权写入的口子）。"""
    _plain_privilege(service)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    _write_metadata(service, "noentry", source=source, staged=staged, home=tmp_path)

    with pytest.raises(RefreshError) as excinfo:
        service.refresh_injection("noentry", str(source))
    assert excinfo.value.reason == refresh_module.REASON_NOT_FOUND


# ---------------------------------------------------------------- 探测 fail closed
def test_refresh_fails_closed_when_passwd_unreadable(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """系统用户表读不出来 ⇒ **拒绝**刷新（fail closed，不放行）。

    创建路径的老口径是「探测失败只记日志并放行」，那是既有行为、本轮不改；
    刷新是显式写动作，判不出来就拒绝。
    """
    _plain_privilege(service)
    _fake_running_container(monkeypatch)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    metadata = _write_metadata(
        service, "failclosed", source=source, staged=staged, home=tmp_path
    )

    real_run = files_module.run

    def fake_run(argv, **kwargs):
        args = [str(item) for item in argv]
        if args[:1] == ["getent"]:
            return CommandResult(tuple(argv), 2, "", "getent: 失败（测试注入）")
        return real_run(argv, **kwargs)

    monkeypatch.setattr(files_module, "run", fake_run)

    with pytest.raises(RefreshError) as excinfo:
        service.refresh_injection("failclosed", metadata.injections[0].entry_id)
    assert excinfo.value.reason == refresh_module.REASON_PRECHECK
    # 副本一个字节都没动
    assert staged.read_text(encoding="utf-8") == "y"


# ---------------------------------------------------------------- 刷新本体
def test_refresh_single_file_updates_content_keeps_inode(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """单文件刷新：内容变新、**inode 不变**（挂载身份不变）、原件零接触。"""
    _plain_privilege(service)
    _fake_running_container(monkeypatch)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("旧内容\n", encoding="utf-8")
    staged.write_text("旧内容\n", encoding="utf-8")
    metadata = _write_metadata(
        service, "onefile", source=source, staged=staged, home=tmp_path
    )

    before_inode = os.stat(staged)
    source.write_text("新内容\n", encoding="utf-8")
    # 原件快照：刷新**前后**必须一模一样（平台不碰原件）
    source_before = os.stat(source)

    result = service.refresh_injection("onefile", metadata.injections[0].entry_id)
    assert result.entry_id == metadata.injections[0].entry_id
    assert result.kind == "file"
    assert staged.read_text(encoding="utf-8") == "新内容\n"
    after_inode = os.stat(staged)
    assert (after_inode.st_dev, after_inode.st_ino) == (
        before_inode.st_dev,
        before_inode.st_ino,
    )
    # 原件零接触：权限位、属主、大小、mtime 全不变
    source_after = os.stat(source)
    assert (source_after.st_mode, source_after.st_uid, source_after.st_gid) == (
        source_before.st_mode,
        source_before.st_uid,
        source_before.st_gid,
    )
    assert source_after.st_size == source_before.st_size
    assert source_after.st_mtime_ns == source_before.st_mtime_ns
    assert source.read_text(encoding="utf-8") == "新内容\n"


def test_refresh_directory_mirrors_add_update_delete(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """目录刷新：新增 / 更新 / 删除过时项，**真实空目录保留**。"""
    _plain_privilege(service)
    _fake_running_container(monkeypatch)
    source = tmp_path / "src"
    staged = tmp_path / "staged"
    (source / "sub").mkdir(parents=True)
    (source / "keep.txt").write_text("新 keep\n", encoding="utf-8")
    (source / "new.txt").write_text("新增\n", encoding="utf-8")
    (source / "sub" / "deep.txt").write_text("深层\n", encoding="utf-8")
    (source / "empty").mkdir()
    staged.mkdir()
    (staged / "keep.txt").write_text("旧 keep\n", encoding="utf-8")
    (staged / "gone.txt").write_text("该删\n", encoding="utf-8")
    (staged / "sub").mkdir()
    (staged / "sub" / "stale.txt").write_text("也该删\n", encoding="utf-8")
    (staged / "empty").mkdir()
    (staged / "empty" / "old.txt").write_text("空目录里的旧物\n", encoding="utf-8")

    metadata = _write_metadata(
        service,
        "onedir",
        source=source,
        staged=staged,
        kind="directory",
        home=tmp_path,
    )
    service.refresh_injection("onedir", metadata.injections[0].entry_id)

    assert (staged / "keep.txt").read_text(encoding="utf-8") == "新 keep\n"
    assert (staged / "new.txt").read_text(encoding="utf-8") == "新增\n"
    assert (staged / "sub" / "deep.txt").read_text(encoding="utf-8") == "深层\n"
    assert not (staged / "gone.txt").exists()
    assert not (staged / "sub" / "stale.txt").exists()
    # 源里真实存在的空目录：本身保留（内容被清空）
    assert (staged / "empty").is_dir()
    assert list((staged / "empty").iterdir()) == []


def test_refresh_missing_source_fails_without_touching_copy(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """源缺失：刷新失败、**副本不被清空**（预校验失败 ⇒ 零改动）。"""
    _plain_privilege(service)
    _fake_running_container(monkeypatch)
    source = tmp_path / "src"
    staged = tmp_path / "staged"
    source.mkdir()
    (source / "a.txt").write_text("内容\n", encoding="utf-8")
    staged.mkdir()
    (staged / "a.txt").write_text("内容\n", encoding="utf-8")

    metadata = _write_metadata(
        service,
        "missingsrc",
        source=source,
        staged=staged,
        kind="directory",
        home=tmp_path,
    )
    # 源整个没了
    shutil.rmtree(source)

    with pytest.raises(RefreshError) as excinfo:
        service.refresh_injection("missingsrc", metadata.injections[0].entry_id)
    assert excinfo.value.reason == refresh_module.REASON_PRECHECK
    assert (staged / "a.txt").read_text(encoding="utf-8") == "内容\n"


def test_refresh_retry_after_failure_succeeds(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """失败后修正源，**手动重试**可成功（平台不自动重试）。"""
    _plain_privilege(service)
    _fake_running_container(monkeypatch)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    staged.write_text("旧\n", encoding="utf-8")
    metadata = _write_metadata(
        service, "retrycase", source=source, staged=staged, home=tmp_path
    )

    # 源还不存在 ⇒ 预校验失败
    with pytest.raises(RefreshError) as excinfo:
        service.refresh_injection("retrycase", metadata.injections[0].entry_id)
    assert excinfo.value.reason == refresh_module.REASON_PRECHECK
    assert staged.read_text(encoding="utf-8") == "旧\n"

    # 修正源后手动重试
    source.write_text("新\n", encoding="utf-8")
    service.refresh_injection("retrycase", metadata.injections[0].entry_id)
    assert staged.read_text(encoding="utf-8") == "新\n"


def test_refresh_rejects_kind_change(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """注入根类型改变（文件 ↔ 目录）：拒绝刷新，副本不动。"""
    _plain_privilege(service)
    _fake_running_container(monkeypatch)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    metadata = _write_metadata(
        service, "kindchange", source=source, staged=staged, home=tmp_path
    )

    # 源从文件变成目录
    source.unlink()
    source.mkdir()
    (source / "inner").write_text("z", encoding="utf-8")

    with pytest.raises(RefreshError) as excinfo:
        service.refresh_injection("kindchange", metadata.injections[0].entry_id)
    assert excinfo.value.reason == refresh_module.REASON_PRECHECK
    assert staged.read_text(encoding="utf-8") == "y"


# ---------------------------------------------------------------- 失败分类
def _stub_helper_output(
    monkeypatch: pytest.MonkeyPatch, stdout: str, returncode: int
) -> None:
    """把 helper 的输出与退出码换掉（分类与文案口径的验证）。"""

    def fake_run(argv, **kwargs):
        return CommandResult(tuple(argv), returncode, stdout, "")

    monkeypatch.setattr(refresh_module, "run", fake_run)


def test_helper_source_unsafe_maps_to_precheck(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """helper 报 ``SOURCE_UNSAFE`` ⇒ 预校验失败（副本零改动）。"""
    _plain_privilege(service)
    _fake_running_container(monkeypatch)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    metadata = _write_metadata(
        service, "unsafe", source=source, staged=staged, home=tmp_path
    )
    _stub_helper_output(
        monkeypatch, '{"code":"SOURCE_UNSAFE","reason":"source_missing"}\n', 10
    )

    with pytest.raises(RefreshError) as excinfo:
        service.refresh_injection("unsafe", metadata.injections[0].entry_id)
    assert excinfo.value.reason == refresh_module.REASON_PRECHECK
    assert "可能部分更新" not in str(excinfo.value)


def test_helper_destination_unsafe_maps_to_precheck(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """helper 报 ``DESTINATION_UNSAFE`` ⇒ 预校验失败（副本零改动）。"""
    _plain_privilege(service)
    _fake_running_container(monkeypatch)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    metadata = _write_metadata(
        service, "destunsafe", source=source, staged=staged, home=tmp_path
    )
    _stub_helper_output(
        monkeypatch,
        '{"code":"DESTINATION_UNSAFE","reason":"target_identity_mismatch"}\n',
        20,
    )

    with pytest.raises(RefreshError) as excinfo:
        service.refresh_injection("destunsafe", metadata.injections[0].entry_id)
    assert excinfo.value.reason == refresh_module.REASON_PRECHECK


def test_helper_partial_maps_to_partial_with_fixed_wording(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """helper 报 ``PARTIAL`` ⇒ 「**可能部分更新**」（不回滚、不续跑）。"""
    _plain_privilege(service)
    _fake_running_container(monkeypatch)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    metadata = _write_metadata(
        service, "partial", source=source, staged=staged, home=tmp_path
    )
    _stub_helper_output(monkeypatch, '{"code":"PARTIAL","reason":"write_failed"}\n', 30)

    with pytest.raises(RefreshError) as excinfo:
        service.refresh_injection("partial", metadata.injections[0].entry_id)
    assert excinfo.value.reason == refresh_module.REASON_PARTIAL
    assert "可能部分更新" in str(excinfo.value)


def test_helper_unknown_output_is_internal(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """helper 的输出认不出来 ⇒ 内部错误（保守按可能部分更新报）。"""
    _plain_privilege(service)
    _fake_running_container(monkeypatch)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    metadata = _write_metadata(
        service, "garbage", source=source, staged=staged, home=tmp_path
    )
    _stub_helper_output(monkeypatch, "这不是 JSON\n", 0)

    with pytest.raises(RefreshError) as excinfo:
        service.refresh_injection("garbage", metadata.injections[0].entry_id)
    assert excinfo.value.reason == refresh_module.REASON_INTERNAL
    assert "可能部分更新" in str(excinfo.value)


def test_helper_exit_code_mismatch_is_internal(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """分类码与退出码对不上 ⇒ 内部错误（不猜）。"""
    _plain_privilege(service)
    _fake_running_container(monkeypatch)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    metadata = _write_metadata(
        service, "mismatchcode", source=source, staged=staged, home=tmp_path
    )
    _stub_helper_output(monkeypatch, '{"code":"OK"}\n', 30)

    with pytest.raises(RefreshError) as excinfo:
        service.refresh_injection("mismatchcode", metadata.injections[0].entry_id)
    assert excinfo.value.reason == refresh_module.REASON_INTERNAL


def test_helper_timeout_is_partial_and_keeps_lock(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """helper 超时 ⇒ 保守按「可能部分更新」报，且**不放锁**。"""
    _plain_privilege(service)
    _fake_running_container(monkeypatch)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    metadata = _write_metadata(
        service, "timeout", source=source, staged=staged, home=tmp_path
    )

    from sandbox_platform.errors import CommandError

    def fake_run(argv, **kwargs):
        raise CommandError(tuple(argv), 124, "", "超时", message="命令超时（900 秒）")

    monkeypatch.setattr(refresh_module, "run", fake_run)
    # 写者收尾等待：直接判「已收干净」，避免测试等满 60 秒
    monkeypatch.setattr(
        "sandbox_platform.lifecycle.wait_for_helper_writers",
        lambda helper, token, timeout=None: True,
    )

    with pytest.raises(RefreshError) as excinfo:
        service.refresh_injection("timeout", metadata.injections[0].entry_id)
    assert excinfo.value.reason == refresh_module.REASON_PARTIAL
    assert "可能部分更新" in str(excinfo.value)


# ---------------------------------------------------------------- 互斥
def test_refresh_conflicts_with_other_process_holding_lock(
    service: SandboxService, tmp_path: Path
) -> None:
    """**跨进程**互斥：另一个进程持锁时，刷新被拒（不排队）。"""
    _plain_privilege(service)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    metadata = _write_metadata(
        service, "xproc", source=source, staged=staged, home=tmp_path
    )

    lock_path = service.locker.lock_path("xproc")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    holder = subprocess.Popen(
        [sys.executable, "-c", _HOLD_LOCK_SCRIPT, str(lock_path)],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert holder.stdout is not None
        line = holder.stdout.readline()
        assert line.strip() == "locked"
        with pytest.raises(RefreshError) as excinfo:
            service.refresh_injection("xproc", metadata.injections[0].entry_id)
        assert excinfo.value.reason == refresh_module.REASON_CONFLICT
    finally:
        holder.kill()
        holder.wait(timeout=10)


def test_lifecycle_conflicts_with_other_process_holding_lock(
    service: SandboxService, tmp_path: Path
) -> None:
    """跨进程互斥对生命周期同样生效：持锁时停止沙箱被拒。"""
    _plain_privilege(service)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    _write_metadata(service, "xproc2", source=source, staged=staged, home=tmp_path)

    lock_path = service.locker.lock_path("xproc2")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    holder = subprocess.Popen(
        [sys.executable, "-c", _HOLD_LOCK_SCRIPT, str(lock_path)],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert holder.stdout is not None
        assert holder.stdout.readline().strip() == "locked"
        with pytest.raises(SandboxConflictError):
            service.stop("xproc2")
    finally:
        holder.kill()
        holder.wait(timeout=10)


def test_two_refreshes_in_one_process_do_not_run_concurrently(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """同一沙箱的两次刷新不并发：第二个**立即被拒**（不等第一个做完）。"""
    _plain_privilege(service)
    _fake_running_container(monkeypatch)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    metadata = _write_metadata(
        service, "twice", source=source, staged=staged, home=tmp_path
    )

    errors: list[BaseException] = []
    started = threading.Event()
    release = threading.Event()

    def slow_helper(argv, **kwargs):
        started.set()
        release.wait(timeout=30)
        return CommandResult(tuple(argv), 0, '{"code":"OK"}\n', "")

    monkeypatch.setattr(refresh_module, "run", slow_helper)

    def first() -> None:
        try:
            service.refresh_injection("twice", metadata.injections[0].entry_id)
        except BaseException as exc:  # noqa: BLE001 - 测试收集异常
            errors.append(exc)

    worker = threading.Thread(target=first)
    worker.start()
    assert started.wait(timeout=30)
    try:
        with pytest.raises(RefreshError) as excinfo:
            service.refresh_injection("twice", metadata.injections[0].entry_id)
        assert excinfo.value.reason == refresh_module.REASON_CONFLICT
    finally:
        release.set()
        worker.join(timeout=30)
    assert not errors


def test_unknown_name_does_not_create_lock_file(
    service: SandboxService, tmp_path: Path
) -> None:
    """未知 name 不落锁文件（锁目录不能随任意名字无界增长）。"""
    _plain_privilege(service)
    with pytest.raises(RefreshError):
        service.refresh_injection("nosuchsandbox", "inj-0-随便")
    lock_dir = service.config.lock_root / "sandbox"
    assert not lock_dir.exists() or not list(lock_dir.glob("nosuchsandbox.lock"))


def test_lock_file_is_persistent_and_not_world_writable(
    service: SandboxService, tmp_path: Path
) -> None:
    """锁文件**常驻**（不参与清理，避免换 inode 换锁）且**不放宽到 0666**。"""
    _plain_privilege(service)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    metadata = _write_metadata(
        service, "persist", source=source, staged=staged, home=tmp_path
    )

    with service._sandbox_lock("persist"):
        pass
    lock_path = service.locker.lock_path("persist")
    assert lock_path.is_file()
    mode = lock_path.stat().st_mode & 0o777
    assert mode == 0o644
    # 释放后文件仍在（常驻）
    assert lock_path.exists()
    # 同一把锁还能再拿（同一个 inode，没有换锁）
    with service._sandbox_lock("persist"):
        pass
    assert lock_path.exists()
    assert metadata.injections


def test_lock_is_released_after_refresh(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """刷新结束后锁被释放：同名操作随后可以正常进行。"""
    _plain_privilege(service)
    _fake_running_container(monkeypatch)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("新\n", encoding="utf-8")
    staged.write_text("旧\n", encoding="utf-8")
    metadata = _write_metadata(
        service, "release", source=source, staged=staged, home=tmp_path
    )
    service.refresh_injection("release", metadata.injections[0].entry_id)

    with service._sandbox_lock("release"):
        pass


def test_lock_file_opened_readonly_when_not_writable(
    service: SandboxService, tmp_path: Path
) -> None:
    """锁文件对当前账号**不可写**时也能加锁。

    平台有两个身份：普通控制台账号与 root 命令行——谁先建锁文件谁就是属主，
    另一个身份可能只能**只读**打开。``flock`` 不要求写权限，只读 fd 一样能
    加排他锁：这条路径必须通。
    """
    import fcntl

    _plain_privilege(service)
    path = service.locker.lock_path("readonly")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("", encoding="utf-8")
    path.chmod(0o444)
    fd = service.locker._open_lock_fd("readonly")
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    finally:
        os.close(fd)


def test_refresh_does_not_wait_for_conflicting_operation(
    service: SandboxService, tmp_path: Path
) -> None:
    """冲突**立即**被拒：不等持锁方结束（不排队）。"""
    _plain_privilege(service)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    metadata = _write_metadata(
        service, "nowait", source=source, staged=staged, home=tmp_path
    )

    holder = service._sandbox_lock("nowait")
    holder.__enter__()
    try:
        started = time.monotonic()
        with pytest.raises(RefreshError):
            service.refresh_injection("nowait", metadata.injections[0].entry_id)
        assert time.monotonic() - started < 5
    finally:
        holder.__exit__(None, None, None)


# ---------------------------------------------------------------- 写者收尾的作用域
#: 伪造「本次执行的写者」：cmdline 与原 helper 完全同形（脚本实参 + 令牌），
#: 但只睡觉不写盘——用来钉住 /proc 识别的作用域，不碰真实沙箱。
_FAKE_WRITER_SCRIPT = "import time; time.sleep(60)"


def _spawn_fake_writer(helper_path_obj: Path, token: str) -> subprocess.Popen:
    """起一个 cmdline 形如 ``python -I <helper> --job-id <token>`` 的假写者。"""
    return subprocess.Popen(
        [
            sys.executable,
            "-c",
            _FAKE_WRITER_SCRIPT,
            str(helper_path_obj),
            refresh_module.JOB_ID_FLAG,
            token,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _stop(process: subprocess.Popen) -> None:
    process.kill()
    process.wait(timeout=10)


def test_live_helper_pids_is_scoped_to_this_execution() -> None:
    """A / B 两个并发刷新各认各的写者：不串、不误认「只带令牌」的进程。"""
    helper = refresh_module.helper_path()
    token_a = refresh_module.new_job_id()
    token_b = refresh_module.new_job_id()
    writer_a = _spawn_fake_writer(helper, token_a)
    writer_b = _spawn_fake_writer(helper, token_b)
    # 只带令牌、不带 helper 脚本实参：不是本次 helper 的写者，不得误认
    impostor = subprocess.Popen(
        [sys.executable, "-c", _FAKE_WRITER_SCRIPT, refresh_module.JOB_ID_FLAG, token_a],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        pids_a = refresh_module.live_helper_pids(helper, token_a)
        pids_b = refresh_module.live_helper_pids(helper, token_b)
        assert writer_a.pid in pids_a
        assert writer_a.pid not in pids_b
        assert writer_b.pid in pids_b
        assert writer_b.pid not in pids_a
        assert impostor.pid not in pids_a
        assert impostor.pid not in pids_b
    finally:
        _stop(writer_a)
        _stop(writer_b)
        _stop(impostor)


def test_wait_tracks_only_own_writer() -> None:
    """B 的写者还在，不阻塞 A；A 自己的写者还在，A 一定判「未收工」。"""
    helper = refresh_module.helper_path()
    token_a = refresh_module.new_job_id()
    token_b = refresh_module.new_job_id()
    writer_b = _spawn_fake_writer(helper, token_b)
    try:
        started = time.monotonic()
        assert refresh_module.wait_for_helper_writers(helper, token_a, timeout=2) is True
        assert time.monotonic() - started < 1.5
    finally:
        _stop(writer_b)

    writer_a = _spawn_fake_writer(helper, token_a)
    try:
        assert refresh_module.wait_for_helper_writers(helper, token_a, timeout=0.3) is False
    finally:
        _stop(writer_a)


def _timeout_run(monkeypatch: pytest.MonkeyPatch) -> None:
    from sandbox_platform.errors import CommandError

    def fake_run(argv, **kwargs):
        raise CommandError(tuple(argv), 124, "", "超时", message="命令超时（900 秒）")

    monkeypatch.setattr(refresh_module, "run", fake_run)


def test_settle_ignores_other_sandbox_writer_and_cleans_spool(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """B 的写者仍在：A 只等自己的令牌 ⇒ 正常放锁，并清理 A 的暂存。"""
    _plain_privilege(service)
    _fake_running_container(monkeypatch)
    _timeout_run(monkeypatch)
    token_a = refresh_module.new_job_id()
    monkeypatch.setattr(refresh_module, "new_job_id", lambda: token_a)
    writer_b = _spawn_fake_writer(refresh_module.helper_path(), refresh_module.new_job_id())
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    metadata = _write_metadata(
        service, "scopea", source=source, staged=staged, home=tmp_path
    )
    try:
        with pytest.raises(RefreshError) as excinfo:
            service.refresh_injection("scopea", metadata.injections[0].entry_id)
        error = excinfo.value
        assert error.hold_lock is True
        assert error.writer_token == token_a
        # 本次没有真实写者：锁已释放（能再次拿到），暂存已清理
        assert not Path(error.spool_root).exists()
        with service.locker.acquire("scopea"):
            pass
    finally:
        _stop(writer_b)


def test_settle_keeps_lock_and_spool_while_own_writer_alive(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """自己的写者仍在：锁被放弃（不放并发写），暂存保留（写者可能仍在读）。"""
    _plain_privilege(service)
    _fake_running_container(monkeypatch)
    _timeout_run(monkeypatch)
    token_a = refresh_module.new_job_id()
    monkeypatch.setattr(refresh_module, "new_job_id", lambda: token_a)
    monkeypatch.setattr(refresh_module, "HELPER_WRITER_SETTLE_TIMEOUT", 0.3)
    writer_a = _spawn_fake_writer(refresh_module.helper_path(), token_a)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    metadata = _write_metadata(
        service, "scopeb", source=source, staged=staged, home=tmp_path
    )
    try:
        with pytest.raises(RefreshError) as excinfo:
            service.refresh_injection("scopeb", metadata.injections[0].entry_id)
        error = excinfo.value
        assert error.hold_lock is True
        assert Path(error.spool_root).is_dir()
        with pytest.raises(SandboxConflictError):
            with service.locker.acquire("scopeb"):
                pass
    finally:
        _stop(writer_a)


def test_helper_argv_carries_only_job_id_and_payload_stays_stdin(
    service: SandboxService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """helper argv 只有令牌：没有源 / 副本路径；载荷（含路径）只在 stdin。"""
    _plain_privilege(service)
    _fake_running_container(monkeypatch)
    source = tmp_path / "src.txt"
    staged = tmp_path / "staged.txt"
    source.write_text("x", encoding="utf-8")
    staged.write_text("y", encoding="utf-8")
    metadata = _write_metadata(
        service, "argvscope", source=source, staged=staged, home=tmp_path
    )
    seen: dict[str, object] = {}

    def capture_run(argv, **kwargs):
        seen["argv"] = [str(item) for item in argv]
        seen["stdin"] = kwargs.get("stdin_text", "")
        return CommandResult(tuple(argv), 0, '{"code":"OK"}\n', "")

    monkeypatch.setattr(refresh_module, "run", capture_run)
    service.refresh_injection("argvscope", metadata.injections[0].entry_id)

    argv = seen["argv"]
    assert argv[:3] == [
        sys.executable,
        "-I",
        str(refresh_module.helper_path()),
    ]
    assert argv[3] == refresh_module.JOB_ID_FLAG
    token = argv[4]
    assert len(token) == 32
    assert all(char in "0123456789abcdef" for char in token)
    assert len(argv) == 5, f"argv 只应带一个令牌：{argv!r}"
    # 路径一概不进命令行，只在 stdin 的 JSON 里
    assert str(source) not in " ".join(argv)
    assert str(staged) not in " ".join(argv)
    payload = json.loads(seen["stdin"])
    assert payload["source_path"] == str(source)
    assert payload["staged_path"] == str(staged)
