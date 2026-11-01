"""用户与子 ID 段管理的单元测试（不触碰宿主机特权资源）。"""

from __future__ import annotations

from pathlib import Path

import pytest

from sandbox_platform import SystemUser, UserSpaceManager
from sandbox_platform.userspace import pick_free_range


def test_pick_free_range_without_occupied() -> None:
    """没有占用区间时返回基点。"""
    assert pick_free_range([], 100000, 65536) == 100000


def test_pick_free_range_skips_overlap() -> None:
    """与已占用区间重叠时跳到占用区间末尾。"""
    assert pick_free_range([(100000, 65536)], 100000, 65536) == 165536


def test_pick_free_range_skips_multiple() -> None:
    """多个占用区间都能跳过。"""
    occupied = [(100000, 65536), (165536, 65536)]
    assert pick_free_range(occupied, 100000, 65536) == 231072


def test_pick_free_range_keeps_non_overlapping_before() -> None:
    """落在占用区间之前的区间仍可用。"""
    assert pick_free_range([(165536, 65536)], 100000, 65536) == 100000


def test_pick_free_range_never_overlaps() -> None:
    """分配结果与任何已占用区间都不重叠。"""
    occupied = [(100000, 65536), (200000, 65536)]
    start = pick_free_range(occupied, 100000, 65536)
    for other_start, other_length in occupied:
        assert not (start < other_start + other_length and other_start < start + 65536)


def test_render_unit_contains_required_settings() -> None:
    """用户单元含 Delegate=yes 与 --rootless。"""
    manager = UserSpaceManager()
    user = SystemUser(name="sandbox-demo", uid=1001, gid=1001, home=Path("/home/sandbox-demo"))
    unit = manager.render_unit(user)
    assert "Delegate=yes" in unit
    assert "--rootless" in unit
    assert "dockerd-rootless.sh" in unit
    assert "DOCKER_HOST=unix:///run/user/1001/docker.sock" in unit
    assert "Environment=HOME=/home/sandbox-demo" in unit


def test_unit_paths_under_user_home() -> None:
    """单元文件落在用户家目录内。"""
    manager = UserSpaceManager()
    user = SystemUser(name="sandbox-demo", uid=1001, gid=1001, home=Path("/home/sandbox-demo"))
    assert manager.unit_path(user) == Path(
        "/home/sandbox-demo/.config/systemd/user/docker.service"
    )


def test_system_user_runtime_paths() -> None:
    """用户上下文派生路径正确。"""
    user = SystemUser(name="sandbox-demo", uid=1001, gid=1001, home=Path("/home/sandbox-demo"))
    assert user.runtime_dir == Path("/run/user/1001")
    assert user.socket_path == Path("/run/user/1001/docker.sock")


@pytest.mark.parametrize("name", ["sandbox-demo", "sandbox-1"])
def test_subid_entry_parsing(name: str) -> None:
    """子 ID 段条目可从宿主文件解析（只读）。"""
    manager = UserSpaceManager()
    entries = manager.read_subid_entries(name)
    assert isinstance(entries, dict)
