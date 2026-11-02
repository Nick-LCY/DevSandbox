"""元数据存储的单元测试。"""

from __future__ import annotations

from pathlib import Path

import pytest

from sandbox_platform import MetadataStore, MountSpec, SandboxMetadata
from sandbox_platform.metadata import STATE_RUNNING, STATE_STOPPED


def _metadata(name: str = "demo") -> SandboxMetadata:
    return SandboxMetadata(
        name=name,
        system_user=f"sandbox-{name}",
        uid=1001,
        gid=1001,
        home=f"/home/sandbox-{name}",
        subid_start=165536,
        subid_length=65536,
        image="busybox",
        socket_path="/run/user/1001/docker.sock",
        socket_mount_path="/var/run/docker.sock",
        container_name=f"sandbox-{name}",
        container_id="abc123def456",
        network_name=f"{name}-net",
        unit_path=f"/home/sandbox-{name}/.config/systemd/user/docker.service",
        state=STATE_RUNNING,
        mounts=[MountSpec("/tmp/external", "/data", True)],
    )


def test_store_writes_into_redirected_home(config, platform_home: Path) -> None:
    """元数据落在 SANDBOX_PLATFORM_HOME 重定向的目录下。"""
    store = MetadataStore(config)
    store.save(_metadata())
    path = store.path_for("demo")
    assert path.is_file()
    assert platform_home in path.parents


def test_round_trip_preserves_fields(config) -> None:
    """存取往返字段一致。"""
    store = MetadataStore(config)
    original = _metadata()
    store.save(original)
    loaded = store.load("demo")
    assert loaded is not None
    assert loaded.name == original.name
    assert loaded.system_user == original.system_user
    assert loaded.subid_start == original.subid_start
    assert loaded.image == original.image
    assert loaded.state == STATE_RUNNING
    assert len(loaded.mounts) == 1
    assert loaded.mounts[0].host_path == "/tmp/external"
    assert loaded.mounts[0].read_only is True


def test_load_missing_returns_none(config) -> None:
    """不存在的沙箱返回 None。"""
    assert MetadataStore(config).load("nope") is None


def test_list_all_sorted_by_name(config) -> None:
    """列表按名称排序。"""
    store = MetadataStore(config)
    store.save(_metadata("beta"))
    store.save(_metadata("alpha"))
    assert [item.name for item in store.list_all()] == ["alpha", "beta"]


def test_delete_removes_metadata(config) -> None:
    """删除后元数据不存在。"""
    store = MetadataStore(config)
    store.save(_metadata())
    assert store.delete("demo") is True
    assert store.exists("demo") is False
    assert store.delete("demo") is False


def test_state_label_mapping(config) -> None:
    """状态标签映射为中文。"""
    metadata = _metadata()
    metadata.state = STATE_STOPPED
    assert metadata.state_label == "已停止"
    metadata.state = STATE_RUNNING
    assert metadata.state_label == "运行中"


def test_mount_summary_text(config) -> None:
    """挂载清单文本可读。"""
    assert _metadata().mount_summary == "/tmp/external → /data（只读）"


def test_old_metadata_without_files_key_loads_with_empty_files() -> None:
    """旧元数据（没有 files 键）反序列化后 files 是空列表。"""
    payload = _metadata().to_dict()
    payload.pop("files")
    restored = SandboxMetadata.from_dict(payload)
    assert restored.files == []


def test_metadata_files_round_trip_preserves_role() -> None:
    """注入副本清单存取往返：角色与只读标记不丢。"""
    original = _metadata()
    original.files = [
        MountSpec("/home/sandbox-demo/.sandbox-files/0-secret", "/run/secret", True, "file")
    ]
    restored = SandboxMetadata.from_dict(original.to_dict())
    assert len(restored.files) == 1
    assert restored.files[0].role == "file"
    assert restored.files[0].read_only is True
    assert restored.files[0].container_path == "/run/secret"


def test_broken_metadata_file_is_ignored(config) -> None:
    """损坏的元数据文件不会让列表整体失败。"""
    store = MetadataStore(config)
    store.save(_metadata("good"))
    broken_dir = config.sandbox_dir("broken")
    broken_dir.mkdir(parents=True, exist_ok=True)
    (broken_dir / "metadata.json").write_text("{不是合法 JSON", encoding="utf-8")
    assert [item.name for item in store.list_all()] == ["good"]


def test_save_is_atomic_overwrite(config) -> None:
    """重复保存覆盖同一文件且不残留临时文件。"""
    store = MetadataStore(config)
    store.save(_metadata())
    metadata = _metadata()
    metadata.state = STATE_STOPPED
    store.save(metadata)
    assert store.load("demo").state == STATE_STOPPED
    leftovers = list(store.sandbox_dir("demo").glob(".metadata-*"))
    assert leftovers == []


@pytest.mark.parametrize("bad_name", ["", "Bad", "有中文", "-leading", "a" * 25])
def test_invalid_sandbox_names_rejected(bad_name: str) -> None:
    """非法沙箱名被拒绝。"""
    from sandbox_platform import ValidationError, validate_sandbox_name

    with pytest.raises(ValidationError):
        validate_sandbox_name(bad_name)


def test_valid_sandbox_names_accepted() -> None:
    """合法沙箱名被接受。"""
    from sandbox_platform import validate_sandbox_name

    assert validate_sandbox_name("demo-1") == "demo-1"
    assert validate_sandbox_name("a") == "a"
