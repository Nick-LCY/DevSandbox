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
import shutil
import signal
import struct
import subprocess
import sys
import termios
import time
import tty
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

# ---------------------------------------------------------------- 伪终端常量
# 伪终端默认窗口大小
PTY_DEFAULT_COLS = 80
PTY_DEFAULT_ROWS = 24
# 会话标记：注入容器内进程的环境变量名。该值同时出现在宿主侧 exec 进程的命令行里，
# 服务重启后据此判断「记录里的进程号是不是本次会话留下的」，避免误杀被复用的进程号。
PTY_SESSION_ENV = "SANDBOX_TERMINAL_SESSION"

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

    # ---------------------------------------------------------------- 伪终端
    def container_shell(self, name: str) -> str:
        """探测容器内可用的交互式 shell。

        优先用 bash（有历史与行编辑），容器内没有 bash 时退回 sh。
        """
        result = self.exec_in_container(name, ["sh", "-c", "command -v bash"], check=False, timeout=30)
        if result.ok and result.stdout.strip():
            return "bash"
        return "sh"

    def exec_pty(
        self,
        argv: list[str] | tuple[str, ...],
        *,
        cols: int = PTY_DEFAULT_COLS,
        rows: int = PTY_DEFAULT_ROWS,
    ) -> "PtyProcess":
        """以沙箱用户身份在伪终端里执行命令。

        执行身份、环境变量与权限前缀复用 :meth:`user_argv`：与既有宿主命令
        完全一致，只把「收集输出」换成「挂一个伪终端」。
        """
        return spawn_pty(self.user_argv(argv), cols=cols, rows=rows)

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
        """
        argv = [
            "exec",
            "-it",
            "--env",
            f"{PTY_SESSION_ENV}={session_id}",
            container,
            shell,
            "-i",
        ]
        return self.exec_pty(argv, cols=cols, rows=rows)


# ---------------------------------------------------------------- 伪终端实现
class PtyProcess:
    """宿主侧伪终端的进程句柄。

    ``master_fd`` 是伪终端主端文件描述符：宿主侧所有输入写进它、所有输出从它读出。
    进程与伪终端同生共死——主端关闭后，容器内的交互式进程也会收到挂断。
    """

    def __init__(self, pid: int, master_fd: int, process: "subprocess.Popen[bytes]") -> None:
        self.pid = pid
        self.master_fd = master_fd
        self._process = process
        self._closed = False

    def read(self, size: int = 65536) -> bytes:
        """读一段输出；进程结束返回空字节。"""
        try:
            return os.read(self.master_fd, size)
        except OSError as exc:
            # 从端全部关闭后，主端读会返回 EIO（等价于 EOF）
            if exc.errno in (errno.EIO, errno.EBADF):
                return b""
            raise

    def write(self, data: bytes) -> int:
        """写入输入字节，返回实际写入长度。"""
        if not data:
            return 0
        try:
            return os.write(self.master_fd, data)
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

    def wait(self, timeout: float | None = None) -> int | None:
        """等待进程退出并返回退出码；超时返回 ``None``。"""
        try:
            return self._process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            return None

    def terminate(self) -> bool:
        """终止进程（连同整个进程组）。"""
        return terminate_pty_process(self.pid)

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
) -> PtyProcess:
    """在宿主伪终端里起一个进程，返回进程句柄与主端文件描述符。

    子进程自带新会话（``setsid``）并把伪终端从端设为自己的控制终端：
    窗口大小变化时内核会给前台进程组发 SIGWINCH，容器客户端据此把新尺寸
    转发到容器内的 TTY。
    """
    argv = [str(item) for item in argv]
    if not argv:
        raise ValueError("命令不能为空")
    program = shutil.which(argv[0])
    if program is None:
        raise FileNotFoundError(f"命令不存在：{argv[0]}")
    command = [program, *argv[1:]]
    bootstrap = sys.executable
    if bootstrap:
        # 经引导进程拿控制终端：exec 之后进程号不变，命令行仍是真正的命令
        command = [bootstrap, "-c", PTY_BOOTSTRAP, *command]
    master_fd, slave_fd = os.openpty()
    try:
        set_pty_winsize(master_fd, cols, rows)
        set_pty_raw(master_fd)
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
    return PtyProcess(process.pid, master_fd, process)


def process_cmdline(pid: int) -> str | None:
    """取进程的完整命令行文本。

    进程不存在返回 ``None``；存在但取不到命令行（内核线程等）返回空串。
    """
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except FileNotFoundError:
        return None
    except OSError:
        return ""
    return raw.replace(b"\x00", b" ").decode("utf-8", errors="replace").strip()


def terminate_pty_process(
    pid: int,
    marker: str | None = None,
    *,
    grace: float = 3.0,
) -> bool:
    """按进程号终止遗留的伪终端进程。

    只有当该进程的命令行含 ``marker``（会话标识）时才终止：进程号会被系统
    复用，误杀无关进程的后果比留下一个僵尸严重得多。返回是否真的终止了进程。
    """
    if pid <= 1:
        return False
    cmdline = process_cmdline(pid)
    if cmdline is None:
        return False
    if marker and marker not in cmdline:
        logger.info("进程 %s 的命令行不含会话标记，跳过终止", pid)
        return False
    try:
        pgid = os.getpgid(pid)
    except OSError:
        return False
    try:
        if pgid == pid:
            os.killpg(pgid, signal.SIGTERM)
        else:
            os.kill(pid, signal.SIGTERM)
    except OSError as exc:
        logger.warning("终止遗留进程 %s 失败：%s", pid, exc)
        return False
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        if process_cmdline(pid) is None:
            return True
        time.sleep(0.1)
    try:
        if pgid == pid:
            os.killpg(pgid, signal.SIGKILL)
        else:
            os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    return True
