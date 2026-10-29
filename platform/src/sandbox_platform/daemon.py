"""以沙箱用户身份操作 systemd 用户单元与免 root Docker 守护进程。

所有宿主交互都收敛在这里，上层编排只调用本模块的方法。
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path

from .command import CommandResult, run
from .mounts import MountSpec, mounts_to_docker_args
from .userspace import Privilege

logger = logging.getLogger(__name__)

LABEL_NAME = "sandbox.platform/name"
LABEL_ROLE = "sandbox.platform/role"
LABEL_MANAGED = "sandbox.platform/managed"

ROLE_SANDBOX = "sandbox"
ROLE_DEPENDENCY = "dependency"

DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


@dataclass(frozen=True)
class UserContext:
    """沙箱用户在宿主上的身份上下文。"""

    user: str
    uid: int
    gid: int
    home: Path

    @property
    def runtime_dir(self) -> Path:
        """用户级 systemd 运行时目录。"""
        return Path(f"/run/user/{self.uid}")

    @property
    def socket_path(self) -> Path:
        """免 root Docker 守护进程套接字。"""
        return self.runtime_dir / "docker.sock"

    def env(self) -> dict[str, str]:
        """以该用户执行命令时的环境变量。"""
        return {
            "HOME": str(self.home),
            "USER": self.user,
            "LOGNAME": self.user,
            "XDG_RUNTIME_DIR": str(self.runtime_dir),
            "XDG_CONFIG_HOME": str(self.home / ".config"),
            "DOCKER_HOST": f"unix://{self.socket_path}",
            "PATH": DEFAULT_PATH,
        }


class UserDaemon:
    """沙箱用户的 systemd 用户单元与免 root Docker 守护进程操作入口。"""

    def __init__(self, context: UserContext, privilege: Privilege | None = None) -> None:
        self.context = context
        self.privilege = privilege or Privilege()

    # ---------------------------------------------------------------- 命令执行
    def user_argv(self, argv: list[str] | tuple[str, ...]) -> list[str]:
        """构造「以沙箱用户身份执行」的完整命令行。"""
        env_args: list[str] = []
        for key, value in self.context.env().items():
            env_args.extend([f"{key}={value}"])
        return [
            *self.privilege.prefix(),
            "-u",
            self.context.user,
            "env",
            "-i",
            *env_args,
            *[str(item) for item in argv],
        ]

    def run_as_user(
        self,
        argv: list[str] | tuple[str, ...],
        *,
        check: bool = False,
        timeout: int | None = 300,
    ) -> CommandResult:
        """以沙箱用户身份执行命令。"""
        return run(self.user_argv(argv), check=check, timeout=timeout)

    def systemctl(
        self,
        args: list[str] | tuple[str, ...],
        *,
        check: bool = False,
        timeout: int | None = 120,
    ) -> CommandResult:
        """执行用户级 systemctl 命令。"""
        return self.run_as_user(["systemctl", "--user", *args], check=check, timeout=timeout)

    def docker(
        self,
        args: list[str] | tuple[str, ...],
        *,
        check: bool = False,
        timeout: int | None = 600,
    ) -> CommandResult:
        """执行面向该用户守护进程的 docker 命令。"""
        return self.run_as_user(["docker", *args], check=check, timeout=timeout)

    # ---------------------------------------------------------------- 守护进程状态
    def is_active(self) -> bool:
        """守护进程单元是否处于 active 状态。"""
        result = self.systemctl(["is-active", "--quiet", "docker.service"], check=False)
        return result.ok

    def is_enabled(self) -> bool:
        """守护进程单元是否已 enable。"""
        result = self.systemctl(["is-enabled", "docker.service"], check=False)
        return result.ok

    def socket_ready(self) -> bool:
        """套接字是否已就绪。"""
        result = self.run_as_user(["test", "-S", str(self.context.socket_path)], check=False)
        return result.ok

    def wait_for_runtime_dir(self, timeout: int = 60) -> bool:
        """等待用户级 systemd 运行时目录就绪（用户级管理器已启动）。"""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = run(
                self.privilege.wrap(["test", "-d", str(self.context.runtime_dir)]), check=False
            )
            if result.ok:
                return True
            time.sleep(1)
        return False

    def ensure_user_manager(self, timeout: int = 120) -> CommandResult:
        """确保系统级 user@<uid>.service 已启动。

        沙箱用户刚创建时，用户级管理器可能还没被拉起；直接从系统级显式启动，
        可规避 uid 复用（刚删掉同 uid 用户就重建）时的启动竞态。

        启动一律加 ``--no-block``：systemd 的 ``start`` 默认会阻塞到单元
        进入 active，用户级管理器启动慢时会把调用方挂住；真正的就绪判定
        交给 :meth:`wait_for_runtime_dir` 与 :meth:`wait_for_socket`。
        """
        unit = f"user@{self.context.uid}.service"
        return run(
            self.privilege.wrap(["systemctl", "start", "--no-block", unit]),
            check=False,
            timeout=timeout,
        )

    def systemctl_retry(
        self,
        args: list[str] | tuple[str, ...],
        *,
        attempts: int = 5,
        delay: float = 1.0,
        timeout: int | None = 120,
    ) -> CommandResult:
        """反复尝试用户级 systemctl，直到成功或用尽次数。"""
        result = self.systemctl(args, check=False, timeout=timeout)
        for _ in range(attempts - 1):
            if result.ok:
                break
            time.sleep(delay)
            result = self.systemctl(args, check=False, timeout=timeout)
        return result

    def wait_for_socket(self, timeout: int = 90) -> bool:
        """等待守护进程套接字出现。"""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.socket_ready():
                return True
            time.sleep(1)
        return False

    def daemon_reload(self) -> CommandResult:
        """让用户级 systemd 重新读取单元。"""
        return self.systemctl(["daemon-reload"], check=False)

    def enable_daemon(self) -> CommandResult:
        """启用守护进程单元（开机自启）。"""
        return self.systemctl(["enable", "docker.service"], check=False)

    def disable_daemon(self) -> CommandResult:
        """禁用守护进程单元。"""
        return self.systemctl(["disable", "docker.service"], check=False)

    def start_daemon(self) -> CommandResult:
        """启动守护进程（不阻塞等待就绪）。"""
        return self.systemctl(["start", "--no-block", "docker.service"], check=False)

    def stop_daemon(self) -> CommandResult:
        """停止守护进程。"""
        return self.systemctl(["stop", "docker.service"], check=False)

    def restart_daemon(self) -> CommandResult:
        """重启守护进程。"""
        return self.systemctl(["restart", "docker.service"], check=False)

    # ---------------------------------------------------------------- 镜像
    def image_exists(self, image: str) -> bool:
        """守护进程里是否已有该镜像。"""
        return self.docker(["image", "inspect", image], check=False).ok

    def pull_image(self, image: str, timeout: int = 900) -> CommandResult:
        """由守护进程直接拉取镜像。"""
        return self.docker(["pull", image], check=False, timeout=timeout)

    def load_image(self, tar_path: str | Path, timeout: int = 600) -> CommandResult:
        """把离线镜像包导入守护进程。"""
        return self.docker(["load", "-i", str(tar_path)], check=False, timeout=timeout)

    def image_id(self, image: str) -> str | None:
        """取镜像 ID。"""
        result = self.docker(["image", "inspect", "--format", "{{.Id}}", image], check=False)
        if not result.ok:
            return None
        return result.stdout.strip() or None

    # ---------------------------------------------------------------- 容器
    def container_exists(self, name: str) -> bool:
        """容器是否存在。"""
        return self.docker(["inspect", name], check=False).ok

    def container_id(self, name: str) -> str | None:
        """容器 ID。"""
        result = self.docker(["inspect", "--format", "{{.Id}}", name], check=False)
        if not result.ok:
            return None
        return result.stdout.strip() or None

    def container_running(self, name: str) -> bool:
        """容器是否在运行。"""
        result = self.docker(["inspect", "--format", "{{.State.Running}}", name], check=False)
        return result.ok and result.stdout.strip() == "true"

    def list_containers(self, all_containers: bool = True) -> list[dict[str, str]]:
        """列出守护进程管理的容器。"""
        args = ["ps"]
        if all_containers:
            args.append("-a")
        args.extend(["--format", "{{json .}}"])
        result = self.docker(args, check=False)
        if not result.ok:
            return []
        containers: list[dict[str, str]] = []
        for line in result.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                containers.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return containers

    def containers_on_network(self, network: str) -> list[str] | None:
        """列出挂在指定网络上的容器名。

        探测失败（网络不存在、守护进程不可达等）返回 ``None``，与「确实没有容器」
        区分开：调用方据此判断清单是否完整。
        """
        result = self.docker(
            ["network", "inspect", "--format", "{{range .Containers}}{{.Name}} {{end}}", network],
            check=False,
        )
        if not result.ok:
            return None
        return [item for item in result.stdout.split() if item]

    def run_container(
        self,
        *,
        name: str,
        image: str,
        mounts: list[MountSpec],
        network: str | None = None,
        command: tuple[str, ...] | None = None,
        env: dict[str, str] | None = None,
        labels: dict[str, str] | None = None,
        workdir: str | None = None,
    ) -> CommandResult:
        """启动一个容器（沙箱容器）。

        固定带 ``-i``：保持标准输入打开，镜像入口脚本里的交互式 shell
        （平台基础镜像的 ``exec bash -i``）才不会因标准输入关闭而立即退出。
        """
        args: list[str] = ["run", "-d", "-i", "--name", name]
        if network:
            args.extend(["--network", network])
        for key, value in (labels or {}).items():
            args.extend(["--label", f"{key}={value}"])
        for key, value in (env or {}).items():
            args.extend(["-e", f"{key}={value}"])
        if workdir:
            args.extend(["--workdir", workdir])
        args.extend(mounts_to_docker_args(mounts))
        if command:
            # 覆盖镜像默认入口：命令参数必须跟在镜像名之后
            args.append("--entrypoint")
            args.append("")
        args.append(image)
        if command:
            args.extend(command)
        return self.docker(args, check=False, timeout=600)

    def stop_container(self, name: str, timeout: int = 120) -> CommandResult:
        """停止容器。"""
        return self.docker(["stop", name], check=False, timeout=timeout)

    def start_container(self, name: str, timeout: int = 120) -> CommandResult:
        """启动已存在的容器。"""
        return self.docker(["start", name], check=False, timeout=timeout)

    def remove_container(self, name: str, force: bool = True) -> CommandResult:
        """删除容器。"""
        args = ["rm"]
        if force:
            args.append("-f")
        args.append(name)
        return self.docker(args, check=False, timeout=120)

    def exec_in_container(
        self,
        name: str,
        argv: list[str] | tuple[str, ...],
        *,
        check: bool = False,
        timeout: int = 120,
    ) -> CommandResult:
        """在容器内执行命令。"""
        return self.docker(["exec", name, *argv], check=check, timeout=timeout)

    def can_access_path(self, path: str | Path) -> bool:
        """该用户能否穿过并读取指定宿主路径。

        免 root 守护进程以沙箱用户身份运行，用户声明的宿主路径若对沙箱用户不可见，
        容器启动会直接失败；这里提前判定，给出可读的错误提示。
        """
        readable = self.run_as_user(["test", "-r", str(path)], check=False, timeout=30)
        if not readable.ok:
            return False
        traversable = self.run_as_user(["test", "-x", str(path)], check=False, timeout=30)
        return traversable.ok

    # ---------------------------------------------------------------- 网络
    def network_exists(self, name: str) -> bool:
        """网络是否存在。"""
        return self.docker(["network", "inspect", name], check=False).ok

    def create_network(self, name: str) -> CommandResult:
        """创建网桥网络。"""
        return self.docker(["network", "create", name], check=False)

    def remove_network(self, name: str) -> CommandResult:
        """删除网络。"""
        return self.docker(["network", "rm", name], check=False)

    def connect_network(self, name: str, network: str) -> CommandResult:
        """把容器接入网络。"""
        return self.docker(["network", "connect", network, name], check=False)
