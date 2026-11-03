"""以沙箱用户身份操作 systemd 用户单元与免 root Docker 守护进程。

所有宿主交互都收敛在这里，上层编排只调用本模块的方法。

伪终端部分（网页终端用）：宿主侧分配一个伪终端承载容器内的交互式 shell，
容器内进程拿到真实 TTY，宿主侧通过主端文件描述符收发字节。
"""

from __future__ import annotations

import errno
import fcntl
import json
import logging
import os
import re
import shutil
import signal
import struct
import subprocess
import sys
import termios
import threading
import time
import tty
from dataclasses import dataclass
from pathlib import Path

from .command import CommandResult, run
from .errors import ValidationError
from .mounts import MountSpec, mounts_to_docker_args
from .userspace import Privilege

logger = logging.getLogger(__name__)

LABEL_NAME = "sandbox.platform/name"
LABEL_ROLE = "sandbox.platform/role"
LABEL_MANAGED = "sandbox.platform/managed"

ROLE_SANDBOX = "sandbox"
ROLE_DEPENDENCY = "dependency"

DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# ---------------------------------------------------------------- 伪终端常量
# 伪终端默认窗口大小
PTY_DEFAULT_COLS = 80
PTY_DEFAULT_ROWS = 24
# 会话标记：注入容器内进程的环境变量名。该值同时出现在宿主侧 exec 进程的命令行里，
# 服务重启后据此判断「记录里的进程号是不是本次会话留下的」，避免误杀被复用的进程号。
PTY_SESSION_ENV = "SANDBOX_TERMINAL_SESSION"

# 会话标识的合法形态：进容器内命令构造前必须过这一关（标识会拼进 shell 脚本）
PTY_SESSION_ID_PATTERN = re.compile(r"[A-Za-z0-9_.-]{1,64}")

# 容器内 shell 探测结果的进程内缓存（按容器名）：每次建会话都探测一次会多一次 exec
_SHELL_CACHE: dict[str, str] = {}
_SHELL_CACHE_LOCK = threading.Lock()

# 伪终端启动引导：子进程先拿到伪终端从端的控制终端身份，再 exec 真正的命令。
# 为什么必须有控制终端：容器客户端靠终端的 SIGWINCH 感知窗口大小变化，
# 没有控制终端就收不到这个信号，容器内 TTY 的尺寸永远停在初始值。
# 引导放在一个全新解释器里跑（不继承父进程的锁），避免在多线程进程里 fork 后执行
# Python 代码的死锁风险。
PTY_BOOTSTRAP = (
    "import fcntl, os, sys, termios\n"
    "fcntl.ioctl(0, termios.TIOCSCTTY, 0)\n"
    "os.execv(sys.argv[1], sys.argv[1:])\n"
)


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
        """构造「以沙箱用户身份执行」的完整命令行。

        身份切换前缀按运行身份分两种，行为等价：

        - 非 root：``sudo -n -u <用户> env -i …``；
        - 进程本身是 root（控制台服务以 root 跑）：``setpriv --reuid <uid>
          --regid <gid> --clear-groups env -i …``。

        root 分支不能省掉前缀：``sudo`` 未必存在，省掉后 ``-u <用户>``
        会被当成外层命令的参数，产出非法命令行。
        """
        env_args: list[str] = []
        for key, value in self.context.env().items():
            env_args.extend([f"{key}={value}"])
        return [
            *self.privilege.user_prefix(
                self.context.user, self.context.uid, self.context.gid
            ),
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

    def container_labels(self, name: str) -> dict[str, str]:
        """取容器标签（取不到返回空字典）。"""
        result = self.docker(
            ["inspect", "--format", "{{json .Config.Labels}}", name], check=False
        )
        if not result.ok:
            return {}
        try:
            data = json.loads(result.stdout.strip() or "{}")
        except json.JSONDecodeError:
            return {}
        if not isinstance(data, dict):
            return {}
        return {str(key): str(value) for key, value in data.items()}

    def container_names_by_label(self, label: str) -> list[str]:
        """按标签过滤列出容器名（枚举平台自建资源用）。

        ``label`` 是过滤表达式（``key`` 或 ``key=value``）；探测失败返回空列表。
        """
        result = self.docker(
            ["ps", "-a", "--filter", f"label={label}", "--format", "{{.Names}}"],
            check=False,
        )
        if not result.ok:
            return []
        return [line.strip() for line in result.stdout.splitlines() if line.strip()]

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

    def kill_container(self, name: str, timeout: int = 120) -> CommandResult:
        """强制停止容器（不等宽限期）。

        ``docker stop`` 默认等 10 秒宽限期等容器自己退：转发容器的 PID 1 是
        busybox 的 ``tail -f /dev/null``，不处理 SIGTERM，每次停止都要白等
        10 秒并占着容器名。这里直接发 SIGKILL：转发容器只提供 socat 二进制，
        没有需要保存的状态。
        """
        return self.docker(["kill", name], check=False, timeout=timeout)

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

    def spawn_stream(self, argv: list[str] | tuple[str, ...]) -> "subprocess.Popen[bytes]":
        """以沙箱用户身份起一个流式子进程（管道收发字节）。

        与 :meth:`exec_pty` 的区别是**不给伪终端**：走普通管道，字节原样进出
        （端口转发的字节泵场景：``docker exec -i`` 的 stdin/stdout 直接搬字节）。

        命令行必须自带程序名（``docker`` 等）：:meth:`user_argv` 只加身份前缀，
        只给子命令的话宿主侧会去执行一个同名的程序（不存在）。

        子进程**自带新会话**（``start_new_session=True``）：它自己就是进程组组长，
        关闭字节泵时按进程组整体回收——``sudo`` 前缀下的 docker 客户端与它拉起
        的孙进程一并收掉，不留孤儿。
        """
        command = [str(item) for item in self.user_argv(argv)]
        return subprocess.Popen(  # noqa: S603 - 参数全部来自平台内部构造，不经 shell
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            start_new_session=True,
        )

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

    # ---------------------------------------------------------------- 伪终端
    def container_shell(self, name: str) -> str:
        """探测容器内可用的交互式 shell。

        优先用 bash（有历史与行编辑），容器内没有 bash 时退回 sh。
        探测结果按容器名在进程内缓存：建会话时不必每次都多跑一次 exec。
        """
        with _SHELL_CACHE_LOCK:
            cached = _SHELL_CACHE.get(name)
        if cached is not None:
            return cached
        result = self.exec_in_container(name, ["sh", "-c", "command -v bash"], check=False, timeout=30)
        shell = "bash" if (result.ok and result.stdout.strip()) else "sh"
        with _SHELL_CACHE_LOCK:
            _SHELL_CACHE[name] = shell
        return shell

    def exec_pty(
        self,
        argv: list[str] | tuple[str, ...],
        *,
        cols: int = PTY_DEFAULT_COLS,
        rows: int = PTY_DEFAULT_ROWS,
        marker: str | None = None,
    ) -> "PtyProcess":
        """以沙箱用户身份在伪终端里执行命令。

        执行身份、环境变量与权限前缀复用 :meth:`user_argv`：与既有宿主命令
        完全一致，只把「收集输出」换成「挂一个伪终端」。

        ``marker`` 是会话标识：伪终端句柄终止前会拿它复核命令行，防止进程号
        被复用后误杀无关进程。
        """
        return spawn_pty(self.user_argv(argv), cols=cols, rows=rows, marker=marker)

    def exec_pty_shell(
        self,
        container: str,
        *,
        session_id: str,
        cols: int = PTY_DEFAULT_COLS,
        rows: int = PTY_DEFAULT_ROWS,
        shell: str = "bash",
    ) -> "PtyProcess":
        """在容器内起一个带真实 TTY 的交互式 shell。

        宿主侧分配伪终端承载：容器内进程拿到真实 TTY（行编辑、全屏程序可用），
        宿主侧通过主端文件描述符收发字节。会话标识以环境变量形式注入容器内进程，
        同时出现在宿主侧 exec 进程的命令行里（服务重启后据此清理遗留进程）。

        命令行必须带上 ``docker`` 程序名：``exec_pty`` 走的是 ``user_argv``，
        只给子命令的话宿主侧会去执行一个叫 ``exec`` 的程序（不存在）。
        """
        argv = [
            "docker",
            "exec",
            "-it",
            "--env",
            f"{PTY_SESSION_ENV}={session_id}",
            container,
            shell,
            "-i",
        ]
        return self.exec_pty(argv, cols=cols, rows=rows, marker=session_id)

    def kill_container_session(self, container: str, session_id: str) -> bool:
        """在容器内按会话标识终止本次会话留下的进程。

        宿主侧的 exec 客户端退出**不会**带走容器内的 shell：客户端与容器内的
        进程是两段生命周期，客户端断了容器里的 shell 还在跑，服务重启后容器里
        会堆积无主 shell。这里按注入的环境标识在容器内找进程并收掉。

        容器已被删除时静默跳过（返回 ``False``，不算失败）。
        """
        script = container_session_kill_script(session_id)
        if not self.container_exists(container):
            logger.info("容器 %s 已不存在，跳过容器内会话清理", container)
            return False
        result = self.exec_in_container(container, ["sh", "-c", script], check=False, timeout=30)
        if not result.ok:
            logger.info(
                "在容器 %s 内终止会话进程失败（忽略）：%s",
                container,
                result.stderr.strip()[:200],
            )
            return False
        return True


# ---------------------------------------------------------------- 伪终端实现
class PtyProcess:
    """宿主侧伪终端的进程句柄。

    ``master_fd`` 是伪终端主端文件描述符：宿主侧所有输入写进它、所有输出从它读出。
    进程与伪终端同生共死——主端关闭后，容器内的交互式进程也会收到挂断。

    主端是非阻塞的：写入侧永不因为「容器内进程不读输入」而卡死（详见
    :func:`spawn_pty`）。
    """

    def __init__(
        self,
        pid: int,
        master_fd: int,
        process: "subprocess.Popen[bytes]",
        marker: str | None = None,
    ) -> None:
        self.pid = pid
        self.master_fd = master_fd
        self._process = process
        self._marker = marker
        self._closed = False
        self._terminated = False

    def read(self, size: int = 65536) -> bytes:
        """读一段输出；进程结束返回空字节。

        主端是非阻塞的：暂时没有数据时抛 ``BlockingIOError``（调用方应等到
        「可读」事件后再读），进程结束返回空字节。
        """
        try:
            return os.read(self.master_fd, size)
        except BlockingIOError:
            # 主端非阻塞：暂时没数据，交给调用方等下一次可读事件
            raise
        except OSError as exc:
            # 从端全部关闭后，主端读会返回 EIO（等价于 EOF）
            if exc.errno in (errno.EIO, errno.EBADF):
                return b""
            raise

    def write(self, data: bytes) -> int:
        """写入输入字节，返回实际写入长度。

        主端非阻塞：内核输入缓冲满时抛 ``BlockingIOError``，此时**一个字节都
        没写进去**，返回 0 让调用方保留待写数据、等下一次可写事件。
        """
        if not data:
            return 0
        try:
            return os.write(self.master_fd, data)
        except BlockingIOError:
            # 输入缓冲满：一个字节都没写，调用方保留数据重试
            return 0
        except OSError as exc:
            if exc.errno in (errno.EIO, errno.EBADF, errno.EPIPE):
                return 0
            raise

    def resize(self, cols: int, rows: int) -> None:
        """设置窗口大小（行数、列数）。"""
        set_pty_winsize(self.master_fd, cols, rows)

    def winsize(self) -> tuple[int, int]:
        """取当前窗口大小（行数、列数）。"""
        return get_pty_winsize(self.master_fd)

    def poll(self) -> int | None:
        """取退出码；进程仍在跑返回 ``None``。"""
        return self._process.poll()

    def is_alive(self) -> bool:
        """进程是否还活着。

        自有子进程用 ``os.waitpid(pid, os.WNOHANG)`` 判活（非阻塞回收一次）：
        收不到退出状态就说明还活着。``Popen.poll()`` 内部做的正是这件事。
        """
        return self._process.poll() is None

    def wait(self, timeout: float | None = None) -> int | None:
        """等待进程退出并返回退出码；超时返回 ``None``。"""
        try:
            return self._process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            return None

    def terminate(self) -> bool:
        """终止进程（连同整个进程组）；幂等。

        终止前先确认这个进程号还指着「自己的子进程」：子进程退出后进程号会被
        系统复用，此时再按进程号发信号会误杀无关进程组。有会话标识时还会拿
        标识复核命令行。
        """
        if self._terminated:
            return True
        if not self.is_alive():
            # 自己的子进程已经退出并被回收：进程号随时可能被复用，不再发信号
            self._terminated = True
            return True
        ok = terminate_pty_process(self.pid, self._marker)
        self._terminated = True
        return ok

    def close(self) -> None:
        """关闭主端文件描述符（幂等）。"""
        if self._closed:
            return
        self._closed = True
        try:
            os.close(self.master_fd)
        except OSError:
            pass


def set_pty_winsize(fd: int, cols: int, rows: int) -> None:
    """设置伪终端窗口大小。"""
    packed = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)


def get_pty_winsize(fd: int) -> tuple[int, int]:
    """取伪终端窗口大小（行数、列数）。"""
    packed = fcntl.ioctl(fd, termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0))
    rows, cols, _, _ = struct.unpack("HHHH", packed)
    return rows, cols


def set_pty_raw(fd: int) -> None:
    """把伪终端设为 raw 模式。

    宿主侧只做字节搬运，不做行编辑：回显、规范化、信号处理全部关掉，
    字节原样送到容器内进程那里，由容器内的 TTY 负责行编辑与 Ctrl-C。
    """
    mode = termios.tcgetattr(fd)
    tty.cfmakeraw(mode)
    termios.tcsetattr(fd, termios.TCSANOW, mode)


def spawn_pty(
    argv: list[str] | tuple[str, ...],
    *,
    cols: int = PTY_DEFAULT_COLS,
    rows: int = PTY_DEFAULT_ROWS,
    env: dict[str, str] | None = None,
    marker: str | None = None,
) -> PtyProcess:
    """在宿主伪终端里起一个进程，返回进程句柄与主端文件描述符。

    子进程自带新会话（``setsid``）并把伪终端从端设为自己的控制终端：
    窗口大小变化时内核会给前台进程组发 SIGWINCH，容器客户端据此把新尺寸
    转发到容器内的 TTY。

    **主端是非阻塞的**：写输入时内核缓冲一满就返回，而不是把调用方挂住。
    阻塞式主端会造出双向死锁——用户粘贴大文本时写入侧卡在 ``write`` 上不再
    读输出，输出写满后容器内的 shell 卡在写 stdout，两边互等，Ctrl-C 都送不进去。
    调用方要按「可写事件」重试没写完的字节。

    ``marker`` 是会话标识：句柄终止前拿它复核命令行，避免进程号被复用后误杀。
    """
    argv = [str(item) for item in argv]
    if not argv:
        raise ValueError("命令不能为空")
    program = shutil.which(argv[0])
    if program is None:
        raise FileNotFoundError(f"命令不存在：{argv[0]}")
    command = [program, *argv[1:]]
    bootstrap = sys.executable
    if not bootstrap:
        # 没有引导进程就拿不到控制终端：容器内窗口大小永远同步不上。
        # 这里直接报错，不静默降级成「能跑但窗口大小不跟随」的半残状态。
        raise RuntimeError("Python 解释器路径不可用，无法给伪终端子进程设置控制终端")
    # 经引导进程拿控制终端：exec 之后进程号不变，命令行仍是真正的命令
    command = [bootstrap, "-c", PTY_BOOTSTRAP, *command]
    master_fd, slave_fd = os.openpty()
    try:
        set_pty_winsize(master_fd, cols, rows)
        set_pty_raw(master_fd)
        # 主端非阻塞：输入写不进去时立即返回，绝不把调用方挂死在 write 上
        os.set_blocking(master_fd, False)
        process = subprocess.Popen(  # noqa: S603 - 参数全部来自平台内部构造，不经 shell
            command,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            start_new_session=True,
            close_fds=True,
            env=env,
        )
    except BaseException:
        os.close(master_fd)
        os.close(slave_fd)
        raise
    os.close(slave_fd)
    return PtyProcess(process.pid, master_fd, process, marker=marker)


def process_cmdline(pid: int) -> str | None:
    """取进程的完整命令行文本。

    进程不存在返回 ``None``；存在但取不到命令行（内核线程、僵尸进程）返回空串。
    """
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except FileNotFoundError:
        return None
    except ProcessLookupError:
        return None
    except OSError:
        return ""
    return raw.replace(b"\x00", b" ").decode("utf-8", errors="replace").strip()


def _stat_fields(pid: int) -> list[str] | None:
    """读 ``/proc/<pid>/stat`` 里「进程名之后」的那段字段。

    进程名（``comm``）可能含空格与括号，只能从最后一个右括号之后切。
    进程不存在返回 ``None``。
    """
    try:
        text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8", errors="replace")
    except (FileNotFoundError, ProcessLookupError):
        return None
    except OSError:
        return None
    try:
        return text[text.rindex(")") + 1 :].split()
    except ValueError:
        return None


def process_state(pid: int) -> str | None:
    """取进程状态字符；进程不存在返回 ``None``。

    ``Z`` 表示僵尸（已经死了，只是还没被父进程回收）。
    """
    fields = _stat_fields(pid)
    if not fields:
        return None
    return fields[0]


def process_identity(pid: int) -> tuple[int, int] | None:
    """取进程的身份指纹：``(进程组号, 启动时刻)``。

    启动时刻（``/proc/<pid>/stat`` 第 22 字段，开机后的时钟滴答）能唯一标识
    一次进程生命周期：进程号被复用时，新进程的启动时刻必然不同。拿它做
    「杀前复核」，就能识别「进程号已被复用」这种最危险的误杀场景。
    """
    fields = _stat_fields(pid)
    if not fields or len(fields) < 20:
        return None
    try:
        return int(fields[2]), int(fields[19])
    except ValueError:
        return None


def _read_cmdline(pid: int) -> str | None:
    """读进程命令行，并区分「暂时读不到」与「确实死了」。

    - 返回 ``None``：进程不存在；
    - 返回空串：进程确实死了（僵尸、内核线程）；
    - 返回非空：命令行文本。

    进程正在 exec 切换时命令行会短暂为空：这时进程明明活着，不能当成死进程，
    所以空串时再看一眼进程状态，活着就稍等重读。
    """
    for _ in range(5):
        cmdline = process_cmdline(pid)
        if cmdline:
            return cmdline
        state = process_state(pid)
        if state is None:
            return None
        if state == "Z":
            # 僵尸：进程早就死了，只等父进程回收
            return ""
        time.sleep(0.05)
    return process_cmdline(pid)


def pid_alive(pid: int) -> bool:
    """进程号是否还指向一个活着的进程（僵尸算活着，僵尸已被回收算没了）。"""
    if pid <= 1:
        return False
    return process_state(pid) is not None


def _open_pidfd(pid: int) -> int | None:
    """打开进程的文件描述符句柄：拿住「这个进程」的身份。

    有了 pidfd，即便进程号之后被复用，我们手里的句柄仍然指着原来那个进程。
    打不开（进程已退出、权限不足、内核不支持）时返回 ``None``，调用方退化为
    「命令行 + 身份指纹」双重复核——指纹里的启动时刻同样能识别进程号复用。
    """
    opener = getattr(os, "pidfd_open", None)
    if opener is None:
        # 解释器没编译这个接口（部分发行版自带构建如此）：退化为指纹复核
        return None
    try:
        return opener(pid)
    except ProcessLookupError:
        return None
    except OSError as exc:
        logger.info("无法为进程 %s 打开 pidfd（%s），退化为命令行与身份复核", pid, exc)
        return None


def _signal_target(
    pid: int, pgid: int, group: bool, sig: int, pidfd: int | None
) -> bool:
    """给进程（或它的进程组）发信号；成功返回 ``True``。"""
    if group:
        # 进程组：组长必须还是同一个进程，否则进程组号可能已被别的组复用
        if process_identity(pid) is None:
            logger.info("进程组组长 %s 已消失，跳过杀组", pid)
            return False
        try:
            os.killpg(pgid, sig)
            return True
        except OSError as exc:
            logger.warning("终止进程组 %s 失败：%s", pgid, exc)
            return False
    if pidfd is not None:
        sender = getattr(signal, "pidfd_send_signal", None)
        if sender is not None:
            try:
                sender(pidfd, sig)
                return True
            except OSError:
                # 内核不支持 pidfd 发信号或句柄已失效：退回到按进程号发
                pass
    try:
        os.kill(pid, sig)
        return True
    except OSError as exc:
        logger.warning("终止进程 %s 失败：%s", pid, exc)
        return False


def terminate_pty_process(
    pid: int,
    marker: str | None = None,
    *,
    grace: float = 3.0,
) -> bool:
    """按进程号终止遗留的伪终端进程。

    三道防线，依次收紧：

    1. 命令行含 ``marker``（会话标识）才终止——进程号会被系统复用，误杀无关
       进程的后果比留下一个僵尸严重得多；
    2. 先用 ``pidfd`` 拿住进程身份，再拿「进程组号 + 启动时刻」当身份指纹；
    3. 真正发信号前再复核一次命令行与身份指纹——这中间进程可能刚好退出、
       进程号被复用，指纹不一致就放弃。

    命令行为空（进程已是僵尸）时立即返回：不必再等宽限期，更不该对僵尸发
    无效的强杀信号。

    返回是否真的终止了进程。
    """
    if pid <= 1:
        return False
    cmdline = _read_cmdline(pid)
    if cmdline is None:
        # 进程已经不存在
        return False
    if not cmdline:
        # 命令行为空 = 已经是僵尸（或内核线程）：进程早就死了
        return True
    if marker and marker not in cmdline:
        logger.info("进程 %s 的命令行不含会话标记，跳过终止", pid)
        return False

    identity = process_identity(pid)
    pidfd = _open_pidfd(pid)
    try:
        # 拿住身份后复核一次：进程可能刚好退出，进程号被别的进程复用
        cmdline = _read_cmdline(pid)
        if cmdline is None:
            return False
        if not cmdline:
            return True
        if marker and marker not in cmdline:
            logger.info("进程 %s 的命令行已变化，跳过终止", pid)
            return False
        if identity is not None and process_identity(pid) != identity:
            logger.info("进程 %s 的身份指纹已变化（进程号被复用），跳过终止", pid)
            return False

        pgid = identity[0] if identity is not None else None
        if pgid is None:
            try:
                pgid = os.getpgid(pid)
            except OSError:
                return False
        group = pgid == pid

        if not _signal_target(pid, pgid, group, signal.SIGTERM, pidfd):
            return False

        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            state = process_state(pid)
            if state is None or state == "Z":
                return True
            time.sleep(0.1)

        # 宽限期到：再复核一次身份与命令行，确认还是同一个进程才强杀
        cmdline = _read_cmdline(pid)
        if cmdline is None or not cmdline:
            return True
        if marker and marker not in cmdline:
            return False
        if identity is not None and process_identity(pid) != identity:
            return False
        _signal_target(pid, pgid, group, signal.SIGKILL, pidfd)
        return True
    finally:
        if pidfd is not None:
            try:
                os.close(pidfd)
            except OSError:
                pass


def container_session_kill_script(session_id: str) -> str:
    """构造「在容器内按会话标识终止进程」的 shell 脚本。

    容器内 shell 的**命令行**里没有会话标识（标识注在环境变量里），所以按
    ``/proc/<pid>/environ`` 匹配：环境变量会被子进程继承，标识因此覆盖整棵
    进程树，而不是只杀掉最外层的 shell。

    会话标识会拼进脚本，先过白名单校验再拼：非法标识直接报错，不进命令。
    """
    if not PTY_SESSION_ID_PATTERN.fullmatch(session_id):
        raise ValidationError(f"会话标识非法，无法在容器内终止进程：{session_id!r}")
    marker = f"{PTY_SESSION_ENV}={session_id}"
    scan = (
        'for e in /proc/[0-9]*/environ; do '
        '[ -r "$e" ] || continue; '
        'p=${e#/proc/}; p=${p%/environ}; '
        'if tr "\\0" "\\n" 2>/dev/null < "$e" | grep -Fqx "' + marker + '"; then '
        'kill -@SIG@ "$p" 2>/dev/null; fi; done'
    )
    return (
        scan.replace("@SIG@", "TERM")
        + "; sleep 1; "
        + scan.replace("@SIG@", "KILL")
    )
