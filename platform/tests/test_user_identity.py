"""以沙箱用户身份执行命令的命令行构造测试。

两条路径：

- 非 root（命令行常规用法）：``sudo -n -u <用户> env -i …``；
- 进程本身是 root（控制台服务以 root 跑）：``setpriv --reuid <uid>
  --regid <gid> --clear-groups env -i …``。

root 分支必须自带提权前缀：root 环境下 ``sudo`` 未必存在，
省掉前缀后 ``-u <用户>`` 会被外层命令当成自己的参数，产出非法命令行。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from sandbox_platform import PlatformConfig, Privilege, SandboxMetadata, SandboxService
from sandbox_platform.command import run
from sandbox_platform.daemon import UserContext, UserDaemon


def _context(user: str = "sandbox-demo", uid: int = 1001, gid: int = 1001) -> UserContext:
    """沙箱用户上下文。"""
    return UserContext(user=user, uid=uid, gid=gid, home=Path(f"/home/{user}"))


def _metadata() -> SandboxMetadata:
    """一份沙箱元数据（只用于连接提示的组装）。"""
    return SandboxMetadata(
        name="demo",
        system_user="sandbox-demo",
        uid=1001,
        gid=1001,
        home="/home/sandbox-demo",
        subid_start=100000,
        subid_length=65536,
        image="busybox:1.37",
        socket_path="/run/user/1001/docker.sock",
        socket_mount_path="/var/run/docker.sock",
        container_name="sandbox-demo",
        container_id="0123456789abcdef",
        network_name="demo-net",
        unit_path="/home/sandbox-demo/.config/systemd/user/docker.service",
    )


# ---------------------------------------------------------------- 非 root 分支
def test_non_root_user_argv_keeps_passwordless_sudo_form() -> None:
    """非 root：命令行是 ``sudo -n -u <用户> env -i …``（与一期逐字一致）。"""
    daemon = UserDaemon(_context(), Privilege(enabled=True))

    argv = daemon.user_argv(["docker", "ps"])

    assert argv[:6] == ["sudo", "-n", "-u", "sandbox-demo", "env", "-i"]
    assert argv[-2:] == ["docker", "ps"]
    assert "HOME=/home/sandbox-demo" in argv
    assert "DOCKER_HOST=unix:///run/user/1001/docker.sock" in argv


def test_non_root_user_argv_has_no_setpriv() -> None:
    """非 root 分支不出现 setpriv（命令行行为零变化）。"""
    daemon = UserDaemon(_context(), Privilege(enabled=True))

    argv = daemon.user_argv(["docker", "ps"])

    assert "setpriv" not in argv


# ---------------------------------------------------------------- root 分支
def test_root_user_argv_switches_identity_with_setpriv() -> None:
    """root：命令行是 ``setpriv --reuid … --regid … --clear-groups env -i …``。"""
    daemon = UserDaemon(_context(), Privilege(enabled=False))

    argv = daemon.user_argv(["docker", "ps"])

    assert argv[:8] == [
        "setpriv",
        "--reuid",
        "1001",
        "--regid",
        "1001",
        "--clear-groups",
        "env",
        "-i",
    ]
    assert "-u" not in argv, "root 分支不能再把 -u 交给外层命令"
    assert argv[-2:] == ["docker", "ps"]


def test_root_user_argv_keeps_environment_and_target() -> None:
    """root 分支同样带全量环境变量与目标命令。"""
    daemon = UserDaemon(_context(), Privilege(enabled=False))

    argv = daemon.user_argv(["systemctl", "--user", "is-active", "docker.service"])

    assert "HOME=/home/sandbox-demo" in argv
    assert "USER=sandbox-demo" in argv
    assert "XDG_RUNTIME_DIR=/run/user/1001" in argv
    assert "DOCKER_HOST=unix:///run/user/1001/docker.sock" in argv
    assert argv[-4:] == ["systemctl", "--user", "is-active", "docker.service"]


def test_privilege_user_prefix_matches_execution_identity() -> None:
    """身份切换前缀：非 root 走 sudo，root 走 setpriv。"""
    assert Privilege(enabled=True).user_prefix("demo", 1001, 1001) == [
        "sudo",
        "-n",
        "-u",
        "demo",
    ]
    assert Privilege(enabled=False).user_prefix("demo", 1001, 1001) == [
        "setpriv",
        "--reuid",
        "1001",
        "--regid",
        "1001",
        "--clear-groups",
    ]


def test_privilege_user_prefix_text_keeps_sudo_form_for_hints() -> None:
    """提示文本：非 root 仍是 ``sudo -u <用户>``（不带 -n），root 改成 setpriv。"""
    assert Privilege(enabled=True).user_prefix_text("demo", 1001, 1001) == "sudo -u demo"
    assert (
        Privilege(enabled=False).user_prefix_text("demo", 1001, 1001)
        == "setpriv --reuid 1001 --regid 1001 --clear-groups"
    )


def test_connection_hint_follows_privilege_mode(config: PlatformConfig) -> None:
    """连接提示里的身份切换前缀与实际执行同源（root 服务不再提示 sudo）。"""
    root_service = SandboxService(config, Privilege(enabled=False))
    user_service = SandboxService(config, Privilege(enabled=True))

    root_hint = root_service._connection_info(
        _metadata(), UserDaemon(_context(), Privilege(enabled=False))
    ).exec_command
    user_hint = user_service._connection_info(
        _metadata(), UserDaemon(_context(), Privilege(enabled=True))
    ).exec_command

    assert root_hint.startswith("setpriv --reuid 1001 --regid 1001 --clear-groups env ")
    assert user_hint.startswith("sudo -u sandbox-demo env ")


# ---------------------------------------------------------------- 实跑验证
@pytest.mark.root
def test_root_branch_argv_really_switches_identity(require_root: None) -> None:
    """实跑：root 分支的命令行能执行，且确实切到了目标用户。

    本机不是 root 时借免密 sudo 扮演 root，验证命令行本身可用。
    """
    daemon = UserDaemon(_context("nobody", 65534, 65534), Privilege(enabled=False))

    argv = daemon.user_argv(["id", "-u"])
    result = run(["sudo", "-n", *argv], check=False, timeout=60)

    assert result.ok, result.output
    assert result.stdout.strip() == "65534"


@pytest.mark.root
def test_non_root_branch_argv_still_runs_as_target_user(require_root: None) -> None:
    """实跑：非 root 分支（免密 sudo）行为不变，仍然以目标用户身份执行。"""
    daemon = UserDaemon(_context("nobody", 65534, 65534), Privilege(enabled=True))

    argv = daemon.user_argv(["id", "-u"])
    result = run(argv, check=False, timeout=60)

    assert result.ok, result.output
    assert result.stdout.strip() == "65534"
