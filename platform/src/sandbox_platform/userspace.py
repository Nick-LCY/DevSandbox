"""沙箱专属系统用户与子 ID 段管理。

职责：

- 创建/回收沙箱专属 Linux 用户（平台创建，用户家目录随之创建）。
- 动态分配互不重叠的子 UID/GID 段，并登记到 ``/etc/subuid``、``/etc/subgid``。
- 写入免 root Docker 守护进程的 systemd 用户单元（含 ``Delegate=yes`` 与 ``--rootless``）。
- 开启 linger 保活，删除用户前先终止其用户级管理器会话。
"""

from __future__ import annotations

import errno
import fcntl
import logging
import os
import shutil
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from .command import run
from .config import PlatformConfig
from .errors import CommandError, SandboxError

logger = logging.getLogger(__name__)

SUBUID_FILE = Path("/etc/subuid")
SUBGID_FILE = Path("/etc/subgid")

DOCKER_UNIT_NAME = "docker.service"
DOCKERD_ROOTLESS_DEFAULT = "/usr/bin/dockerd-rootless.sh"

# 合并 CA 束在沙箱用户家目录里的相对路径（系统 CA 束 + 代理 CA）
CA_BUNDLE_RELPATH = Path(".config/sandbox-platform/registry-proxy-ca-bundle.crt")
# 代理环境变量的免代理名单：本地地址一律直连
PROXY_NO_PROXY = "localhost,127.0.0.1,::1"


def ca_bundle_path(user_home: str | Path) -> Path:
    """沙箱用户家目录里「合并 CA 束」的落盘路径。"""
    return Path(user_home) / CA_BUNDLE_RELPATH


@dataclass(frozen=True)
class SystemUser:
    """沙箱专属系统用户。"""

    name: str
    uid: int
    gid: int
    home: Path
    created: bool = False

    @property
    def runtime_dir(self) -> Path:
        """用户级 systemd 运行时目录。"""
        return Path(f"/run/user/{self.uid}")

    @property
    def socket_path(self) -> Path:
        """该用户免 root Docker 守护进程的套接字路径。"""
        return self.runtime_dir / "docker.sock"


@dataclass(frozen=True)
class SubIdRange:
    """一段子 UID/GID 映射区间。"""

    start: int
    length: int

    @property
    def end(self) -> int:
        """区间末尾（含）。"""
        return self.start + self.length - 1

    @property
    def spec(self) -> str:
        """``起点:长度`` 文本。"""
        return f"{self.start}:{self.length}"


class Privilege:
    """特权命令前缀包装。

    以 root 运行时直接执行；否则通过免密 ``sudo`` 执行。
    """

    def __init__(self, enabled: bool | None = None) -> None:
        if enabled is None:
            enabled = os.geteuid() != 0
        self.enabled = enabled

    def prefix(self) -> list[str]:
        """特权命令前缀。"""
        return ["sudo", "-n"] if self.enabled else []

    def wrap(self, argv: list[str] | tuple[str, ...]) -> list[str]:
        """给命令加上特权前缀。"""
        return [*self.prefix(), *[str(item) for item in argv]]


def pick_free_range(
    ranges: list[tuple[int, int]],
    base: int,
    length: int,
) -> int:
    """在给定区间集合里挑一段不重叠的空闲区间起点。

    参数
    ----
    ranges : 已占用区间列表，每项为 ``(起点, 长度)``
    base : 允许的最小起点
    length : 需要的区间长度
    """
    candidate = base
    ordered = sorted(ranges)
    while True:
        conflict: tuple[int, int] | None = None
        for start, span in ordered:
            if candidate < start + span and start < candidate + length:
                conflict = (start, span)
                break
        if conflict is None:
            return candidate
        candidate = conflict[0] + conflict[1]


class UserSpaceManager:
    """系统用户与子 ID 段的管理入口。"""

    def __init__(
        self,
        config: PlatformConfig | None = None,
        privilege: Privilege | None = None,
    ) -> None:
        self.config = config or PlatformConfig.from_env()
        self.privilege = privilege or Privilege()

    # ---------------------------------------------------------------- 读文件
    def _read_text(self, path: Path) -> str:
        try:
            return path.read_text(encoding="utf-8")
        except PermissionError:
            result = run(self.privilege.wrap(["cat", str(path)]), check=False)
            if not result.ok:
                return ""
            return result.stdout
        except FileNotFoundError:
            return ""

    def _write_text(self, path: Path, content: str) -> None:
        if not self.privilege.enabled:
            path.write_text(content, encoding="utf-8")
            return
        run(self.privilege.wrap(["tee", str(path)]), stdin_text=content, check=True)

    # ---------------------------------------------------------------- 用户
    def user_exists(self, name: str) -> bool:
        """用户是否存在。"""
        result = run(["id", "-u", name], check=False)
        return result.ok

    def lookup_user(self, name: str) -> SystemUser | None:
        """查询用户信息；不存在返回 ``None``。

        信息一律现查 ``getent passwd``：uid / gid / 家目录都取自当前系统，
        不接受调用方传进来的旧值（删除路径上的元数据不可信）。
        """
        result = run(["getent", "passwd", name], check=False)
        if not result.ok:
            return None
        first_line = result.stdout.strip().splitlines()
        if not first_line:
            return None
        fields = first_line[0].split(":")
        if len(fields) < 6:
            return None
        try:
            uid = int(fields[2])
            gid = int(fields[3])
        except ValueError:
            return None
        home = Path(fields[5]) if fields[5] else Path(f"/home/{name}")
        return SystemUser(name=name, uid=uid, gid=gid, home=home)

    def ensure_user(self, name: str) -> SystemUser:
        """确保用户存在（不存在则创建），返回用户信息。

        返回值里的 ``created`` 标记本次调用是否新建了用户：只有本次新建的用户
        才允许进回滚清单，否则回滚会误删用户本来就在用的账号。
        """
        existing = self.lookup_user(name)
        if existing is not None:
            logger.info("系统用户已存在：%s（uid=%s）", name, existing.uid)
            return existing
        logger.info("创建系统用户：%s", name)
        run(
            self.privilege.wrap(
                ["useradd", "--create-home", "--shell", "/bin/bash", name]
            ),
            check=True,
        )
        created = self.lookup_user(name)
        if created is None:  # pragma: no cover - useradd 成功但查不到属于异常宿主状态
            raise SandboxError(f"系统用户创建后仍查不到：{name}")
        return SystemUser(
            name=created.name,
            uid=created.uid,
            gid=created.gid,
            home=created.home,
            created=True,
        )

    # ---------------------------------------------------------------- 子 ID 段
    def read_subid_entries(self, user_name: str) -> dict[str, tuple[int, int]]:
        """读取某用户在子 UID/GID 文件中的登记段。"""
        entries: dict[str, tuple[int, int]] = {}
        for key, path in (("subuid", SUBUID_FILE), ("subgid", SUBGID_FILE)):
            for line in self._read_text(path).splitlines():
                fields = line.strip().split(":")
                if len(fields) != 3:
                    continue
                if fields[0] != user_name:
                    continue
                try:
                    entries[key] = (int(fields[1]), int(fields[2]))
                except ValueError:
                    continue
        return entries

    def all_allocated_ranges(self) -> list[tuple[int, int]]:
        """列出 ``/etc/subuid`` 与 ``/etc/subgid`` 中所有已占用区间。"""
        ranges: list[tuple[int, int]] = []
        for path in (SUBUID_FILE, SUBGID_FILE):
            for line in self._read_text(path).splitlines():
                fields = line.strip().split(":")
                if len(fields) != 3:
                    continue
                try:
                    ranges.append((int(fields[1]), int(fields[2])))
                except ValueError:
                    continue
        return ranges

    def allocate_subid_range(self, user_name: str) -> SubIdRange:
        """为用户分配（必要时登记）子 UID/GID 段。

        已存在合规登记时沿用原段，保证同一沙箱反复启停使用同一段。
        """
        self.config.lock_root.mkdir(parents=True, exist_ok=True)
        lock_path = self.config.lock_root / "subid.lock"
        with open(lock_path, "a+") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                return self._allocate_subid_range_locked(user_name)
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def _allocate_subid_range_locked(self, user_name: str) -> SubIdRange:
        entries = self.read_subid_entries(user_name)
        existing = entries.get("subuid")
        if existing is not None:
            start, length = existing
            if start >= self.config.subid_base and length >= self.config.subid_length:
                if entries.get("subgid") != existing:
                    self._write_subid_entry(SUBGID_FILE, user_name, start, length)
                logger.info("沿用已有子 ID 段：%s:%d", user_name, length)
                return SubIdRange(start=start, length=length)

        occupied = [
            item for item in self.all_allocated_ranges() if item != existing
        ]
        start = pick_free_range(occupied, self.config.subid_base, self.config.subid_length)
        length = self.config.subid_length
        self._write_subid_entry(SUBUID_FILE, user_name, start, length)
        self._write_subid_entry(SUBGID_FILE, user_name, start, length)
        logger.info("登记子 ID 段：%s %d:%d", user_name, start, length)
        return SubIdRange(start=start, length=length)

    def _write_subid_entry(self, path: Path, user_name: str, start: int, length: int) -> None:
        """写入（或替换）某用户在子 ID 文件中的条目，保留其他用户条目。"""
        lines = [
            line
            for line in self._read_text(path).splitlines()
            if line.strip() and not line.strip().startswith(f"{user_name}:")
        ]
        lines.append(f"{user_name}:{start}:{length}")
        content = "\n".join(lines) + "\n"
        if not self.privilege.enabled:
            path.write_text(content, encoding="utf-8")
            return
        run(self.privilege.wrap(["tee", str(path)]), stdin_text=content, check=True)

    def remove_subid_range(self, user_name: str) -> bool:
        """回收某用户在子 UID/GID 文件中的登记段。

        与分配路径共用 ``subid.lock``：读—改—写整段都在临界区内，
        避免与并发分配交叉导致刚分配的段被覆盖丢失。
        """
        self.config.lock_root.mkdir(parents=True, exist_ok=True)
        lock_path = self.config.lock_root / "subid.lock"
        with open(lock_path, "a+") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                return self._remove_subid_range_locked(user_name)
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def _remove_subid_range_locked(self, user_name: str) -> bool:
        """临界区内的回收实现（调用方必须已持有子 ID 段锁）。"""
        removed = False
        for path in (SUBUID_FILE, SUBGID_FILE):
            content = self._read_text(path)
            lines = [
                line
                for line in content.splitlines()
                if line.strip() and not line.strip().startswith(f"{user_name}:")
            ]
            if len(lines) == len([x for x in content.splitlines() if x.strip()]):
                continue
            removed = True
            new_content = ("\n".join(lines) + "\n") if lines else ""
            if not self.privilege.enabled:
                path.write_text(new_content, encoding="utf-8")
            else:
                run(self.privilege.wrap(["tee", str(path)]), stdin_text=new_content, check=True)
        return removed

    # ---------------------------------------------------------------- systemd 单元
    def unit_dir(self, user: SystemUser) -> Path:
        """用户级 systemd 单元目录。"""
        return user.home / ".config" / "systemd" / "user"

    def unit_path(self, user: SystemUser) -> Path:
        """用户级 Docker 守护进程单元文件路径。"""
        return self.unit_dir(user) / DOCKER_UNIT_NAME

    def dockerd_rootless_path(self) -> str:
        """免 root 守护进程启动脚本路径。"""
        found = shutil.which("dockerd-rootless.sh")
        return found or DOCKERD_ROOTLESS_DEFAULT

    def proxy_url(self) -> str:
        """沙箱守护进程访问统一镜像代理的 URL。

        默认 ``http://127.0.0.1:<port>``：dockerd-rootless.sh 默认启用 ``--detach-netns``，
        守护进程进程本身留在宿主网络命名空间（只有容器在 slirp4netns 命名空间里），
        因此守护进程要用宿主回环地址访问代理；slirp 网关 10.0.2.2 只在沙箱容器内可达。
        """
        return f"http://{self.config.proxy_address}:{self.config.proxy_port}"

    def render_unit(self, user: SystemUser) -> str:
        """渲染 systemd 用户单元内容。

        统一镜像代理（ADR 0008）：单元里注入代理环境变量，沙箱内 ``docker pull``
        自动经代理并命中缓存。``SSL_CERT_FILE`` 指向「系统 CA 束 + 代理 CA」的合并文件，
        非代理目标的 TLS 仍然可用。

        ``DOCKERD_ROOTLESS_ROOTLESSKIT_DETACH_NETNS=true`` 显式固定守护进程的网络命名空间
        位置（与 dockerd-rootless.sh 的默认值一致）：守护进程留在宿主网络命名空间，
        才能用回环地址访问代理，容器仍在 slirp4netns 命名空间里。
        """
        socket_path = user.socket_path
        proxy_url = self.proxy_url()
        return (
            "[Unit]\n"
            f"Description=Docker daemon (rootless) for {user.name}\n"
            "After=network.target\n"
            "\n"
            "[Service]\n"
            "Type=notify\n"
            "NotifyAccess=all\n"
            "Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n"
            f"Environment=HOME={user.home}\n"
            f"Environment=DOCKER_HOST=unix://{socket_path}\n"
            f"Environment=HTTPS_PROXY={proxy_url}\n"
            f"Environment=HTTP_PROXY={proxy_url}\n"
            f"Environment=NO_PROXY={PROXY_NO_PROXY}\n"
            f"Environment=SSL_CERT_FILE={ca_bundle_path(user.home)}\n"
            "Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_DETACH_NETNS=true\n"
            f"ExecStart={self.dockerd_rootless_path()} --rootless\n"
            "ExecReload=/bin/kill -s HUP $MAINPID\n"
            "TimeoutSec=0\n"
            "Restart=always\n"
            "RestartSec=2\n"
            "LimitNOFILE=infinity\n"
            "LimitNPROC=infinity\n"
            "LimitCORE=infinity\n"
            "TasksMax=infinity\n"
            "Delegate=yes\n"
            "KillMode=mixed\n"
            "\n"
            "[Install]\n"
            "WantedBy=default.target\n"
        )

    def write_docker_unit(self, user: SystemUser) -> Path:
        """写入用户级守护进程单元（目录与文件属主必须是该用户）。"""
        unit_dir = self.unit_dir(user)
        unit_path = self.unit_path(user)
        content = self.render_unit(user)
        self.config.temp_root.mkdir(parents=True, exist_ok=True)
        handle = tempfile.NamedTemporaryFile(  # noqa: SIM115 - 临时文件需 install 到用户目录
            "w", encoding="utf-8", dir=self.config.temp_root, prefix="unit-", suffix=".service",
            delete=False,
        )
        with handle:
            handle.write(content)
        temp_path = Path(handle.name)
        try:
            run(
                self.privilege.wrap(
                    [
                        "install",
                        "-d",
                        "-o",
                        user.name,
                        "-g",
                        user.name,
                        "-m",
                        "0755",
                        str(user.home / ".config"),
                        str(user.home / ".config" / "systemd"),
                        str(unit_dir),
                    ]
                ),
                check=True,
            )
            run(
                self.privilege.wrap(
                    ["install", "-o", user.name, "-g", user.name, "-m", "0644", str(temp_path), str(unit_path)]
                ),
                check=True,
            )
        finally:
            temp_path.unlink(missing_ok=True)
        logger.info("已写入用户级单元：%s", unit_path)
        return unit_path

    # ---------------------------------------------------------------- linger 与回收
    def enable_linger(self, user_name: str) -> bool:
        """开启 linger 保活（用户未登录时守护进程仍在）。"""
        result = run(self.privilege.wrap(["loginctl", "enable-linger", user_name]), check=False)
        if not result.ok:
            logger.warning("开启 linger 失败：%s", result.output)
            return False
        return True

    def disable_linger(self, user_name: str) -> bool:
        """关闭 linger 保活。"""
        result = run(self.privilege.wrap(["loginctl", "disable-linger", user_name]), check=False)
        return result.ok

    def linger_state(self, user_name: str) -> bool | None:
        """查 linger 是否开启；查不到（无 logind 等）返回 ``None``。"""
        result = run(
            self.privilege.wrap(
                ["loginctl", "show-user", user_name, "--property=Linger"]
            ),
            check=False,
        )
        if not result.ok:
            return None
        value = result.stdout.strip().split("=", 1)[-1].strip().lower()
        if value == "yes":
            return True
        if value == "no":
            return False
        return None

    def terminate_user(self, user_name: str, uid: int | None = None) -> bool:
        """终止用户会话与用户级 systemd 管理器（删用户前必须做）。

        返回 ``True`` 表示该用户的进程已全部退出；``False`` 表示仍有残留进程。
        常规终止超时后升级处置：先停用户级 systemd 管理器，再对残留进程强杀。
        """
        result = run(self.privilege.wrap(["loginctl", "terminate-user", user_name]), check=False)
        if not result.ok:
            logger.warning("终止用户 %s 的会话失败：%s", user_name, result.output)
        if self._wait_user_processes_gone(user_name, attempts=5):
            return True

        logger.warning("用户 %s 的进程未在 5 秒内退出，升级处置", user_name)
        if uid is None:
            uid = self.system_uid_of(user_name)
        if uid is not None:
            run(
                self.privilege.wrap(["systemctl", "stop", f"user@{uid}.service"]),
                check=False,
                timeout=60,
            )
        for pid in self._user_pids(user_name):
            run(self.privilege.wrap(["kill", "-9", str(pid)]), check=False)
        return self._wait_user_processes_gone(user_name, attempts=5)

    def _user_pids(self, user_name: str) -> list[int]:
        """取该用户名下正在运行的进程 PID。"""
        probe = run(["pgrep", "-u", user_name], check=False)
        if not probe.ok:
            return []
        pids: list[int] = []
        for item in probe.stdout.split():
            try:
                pids.append(int(item))
            except ValueError:
                continue
        return pids

    def _wait_user_processes_gone(self, user_name: str, attempts: int) -> bool:
        """等待该用户名的进程全部退出。"""
        for _ in range(attempts):
            if not self._user_pids(user_name):
                return True
            time.sleep(1)
        return not self._user_pids(user_name)

    def wait_for_runtime_gone(self, uid: int, timeout: int = 30) -> bool:
        """等待用户运行时目录被回收。

        删除用户后立刻重建同名用户（uid 复用）时，系统级 user@<uid>.service
        可能仍处于停止过程中，导致新的用户级守护进程拉不起来；这里等它收干净。
        """
        path = f"/run/user/{uid}"
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not run(self.privilege.wrap(["test", "-d", path]), check=False).ok:
                return True
            time.sleep(1)
        logger.warning("用户运行时目录未在 %s 秒内回收：%s", timeout, path)
        return False

    def remove_user(self, user: SystemUser, remove_home: bool = True) -> bool:
        """删除用户（先终止会话），并回收家目录。

        返回 ``True`` 表示用户与家目录都已回收；``False`` 表示用户已删但家目录保留
        （该用户仍有残留进程，删家目录会毁掉正在运行进程的工作目录）。
        """
        processes_cleared = self.terminate_user(user.name, uid=user.uid)
        result = run(self.privilege.wrap(["userdel", "-r", user.name]), check=False)
        if not result.ok:
            fallback = run(self.privilege.wrap(["userdel", user.name]), check=False)
            if not fallback.ok:
                raise CommandError(
                    ["userdel", user.name],
                    fallback.returncode,
                    fallback.stdout,
                    fallback.stderr,
                    message="删除系统用户失败",
                )
        self.wait_for_runtime_gone(user.uid)
        if not remove_home:
            return True
        try:
            home_exists = user.home.exists()
        except OSError:
            home_exists = True
        if not home_exists:
            return True
        if not processes_cleared:
            logger.error(
                "用户 %s 仍有残留进程，家目录保留未删：%s", user.name, user.home
            )
            return False
        try:
            shutil.rmtree(user.home)
        except OSError as exc:
            logger.error("删除家目录失败：%s（%s）", user.home, exc)
            return False
        return True

    # ---------------------------------------------------------------- 查询辅助
    def system_uid_of(self, user_name: str) -> int | None:
        """取用户 uid。"""
        user = self.lookup_user(user_name)
        return user.uid if user else None


def is_enoent(exc: OSError) -> bool:
    """判断异常是否为文件不存在。"""
    return exc.errno == errno.ENOENT
