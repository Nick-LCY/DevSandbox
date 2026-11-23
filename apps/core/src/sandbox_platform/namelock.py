"""同名沙箱的**跨进程**互斥锁（平台数据根的 per-name ``flock``）。

**为什么进程内锁不够**：平台有两个入口（控制台服务与命令行），它们是
**两个进程**，各有一把自己的进程内锁。进程内锁只能挡住同进程内的并发，
挡不住「控制台正在刷新、命令行同时删除这个沙箱」。

**锁文件落在平台数据根**（``<平台数据根>/locks/sandbox/<沙箱名>.lock``）：
锁必须与「这个平台的这份数据」同域——锁在沙箱用户可控的路径下，用户能
删掉锁文件再自己加一把，锁就形同虚设；锁在系统临时目录里，两个平台
数据根（测试环境与生产环境）会互相阻塞。

**三条口径**：

1. **非阻塞、冲突即拒**：拿不到锁立刻抛 :class:`SandboxConflictError`，
   **不排队**。排队会把「冲突」悄悄变成「串行」——用户点两次刷新，第二
   次等到第一个做完再执行，看起来像成功，实际语义已经错了。
2. **锁文件常驻、不参与清理**：锁文件**永不删除**。删了再重建就是**换 inode**，
   换 inode 那一刻两把锁各锁各的，互斥就破了（老锁还锁着旧 inode，新锁是
   新 inode）。宁可让 ``locks/sandbox/`` 下的文件随沙箱名越积越多。
3. **不放宽到 0666**：锁文件是 **0644**（只读可开、他人不可写），锁目录是
   **0755**。为什么不是 0600：平台有两个身份——普通控制台账号与 root 命令
   行——**两边都要能打开同一把锁**。谁先建的文件就是谁的属主，0600 的话
   root CLI 先建过之后，普通控制台账号就再也打不开这把锁（跨进程互斥直接
   失效）。0644 是「不放宽到 0666」前提下能同时满足两个身份的最宽口径：
   文件里没有任何内容，锁目录也只有平台账号能增删。
"""

from __future__ import annotations

import errno
import fcntl
import logging
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .command import run
from .config import PlatformConfig
from .errors import ConfigError, SandboxConflictError
from .userspace import Privilege

logger = logging.getLogger(__name__)

#: 锁冲突的固定文案（服务端按分类码映射状态码，文案固定）
MSG_CONFLICT = "该沙箱正在执行其它操作，请稍后重试"

#: 锁文件权限：0644（只读可开、他人不可写）
LOCK_FILE_MODE = 0o644
#: 锁目录权限：0755（别的账号要能穿过它打开里面的锁文件）
LOCK_DIR_MODE = 0o755

#: 被「放弃」的锁的文件描述符：故意不关——关了就等于释放了锁。
#: 放在模块级列表里是为了防止被 GC 回收掉（fd 被关 = 锁被释放）。
_LEAKED_LOCK_FDS: list[int] = []


class NameLockHandle:
    """一次加锁的句柄。"""

    def __init__(self, fd: int | None = None, *, name: str = "") -> None:
        self._fd = fd
        self._name = name
        self._abandoned = False

    @property
    def abandoned(self) -> bool:
        """这把锁是不是被「放弃」了（保持加锁状态直到进程退出）。"""
        return self._abandoned

    def abandon(self) -> None:
        """放弃这把锁：**不解锁、不关 fd**，锁保持到进程退出。

        只在「可能仍有写者在跑」时用（例如刷新用的 helper 超时，它 fork
        出来的写入子进程可能还活着）。此时释放锁 = 放另一个进程进来与
        仍在写入的副本并发——宁可把锁攥住（后续同名操作被拒），也不能
        放并发写。
        """
        if self._fd is None:
            return
        _LEAKED_LOCK_FDS.append(self._fd)
        self._fd = None
        self._abandoned = True
        logger.error(
            "沙箱 %s 的锁被放弃：可能仍有写者在跑，锁保持到进程退出", self._name
        )

    def release(self) -> None:
        """释放锁（正常路径）。已被放弃的锁不动。"""
        if self._fd is None:
            return
        fd, self._fd = self._fd, None
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError as exc:  # pragma: no cover - 释放失败只记日志
            logger.warning("释放沙箱 %s 的锁失败：%s", self._name, exc)
        finally:
            os.close(fd)


class NameLocker:
    """按沙箱名加锁（跨进程 ``flock``）。"""

    def __init__(
        self,
        config: PlatformConfig | None = None,
        privilege: Privilege | None = None,
    ) -> None:
        self.config = config or PlatformConfig.from_env()
        self.privilege = privilege or Privilege()
        self.directory = self.config.lock_root / "sandbox"

    def lock_path(self, name: str) -> Path:
        """某个沙箱名的锁文件路径。"""
        return self.directory / f"{name}.lock"

    @contextmanager
    def acquire(self, name: str) -> Iterator[NameLockHandle]:
        """拿同名沙箱的锁；拿不到**立即**抛 :class:`SandboxConflictError`。

        调用方负责「未知 name 不落锁文件」这条：名字不存在时不该凭空造一个
        锁文件（那会让锁目录随任意名字无界增长）。
        """
        fd = self._open_lock_fd(name)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            os.close(fd)
            raise SandboxConflictError(MSG_CONFLICT) from exc
        handle = NameLockHandle(fd, name=name)
        try:
            yield handle
        finally:
            handle.release()

    # ---------------------------------------------------------------- 内部
    def _ensure_directory(self) -> None:
        """确保锁目录存在（属主是**当前平台账号**，不抢成 root 的）。"""
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            os.chmod(self.directory, LOCK_DIR_MODE)
        except OSError:
            # 当前账号建不了（目录是别的账号建的、且不可写）：用特权通道补，
            # 但**不带 -o/-g**——不把已有目录的属主抢过来（抢了会让平台
            # 账号之后建不了锁文件）。
            run(
                self.privilege.wrap(
                    ["install", "-d", "-m", f"{LOCK_DIR_MODE:04o}", str(self.directory)]
                ),
                check=False,
            )

    def _open_lock_fd(self, name: str) -> int:
        """打开锁文件（可加 ``flock`` 的 fd）。

        打开方式按「谁都能开」来：先试读写创建，权限不够就退回**只读**
        打开——``flock`` 不要求写权限，只读 fd 一样能加排他锁。
        """
        path = self.lock_path(name)
        self._ensure_directory()
        try:
            fd = os.open(path, os.O_RDWR | os.O_CREAT, LOCK_FILE_MODE)
        except OSError as exc:
            if exc.errno not in (errno.EACCES, errno.EPERM):
                raise ConfigError(f"无法打开沙箱锁文件：{path}（{exc}）") from exc
            return self._open_lock_readonly(path)
        try:
            # 抹掉 umask 的影响：锁文件必须是 0644，别的账号才打不开
            os.fchmod(fd, LOCK_FILE_MODE)
        except OSError:  # pragma: no cover - 不是属主时 chmod 失败（忽略）
            pass
        return fd

    def _open_lock_readonly(self, path: Path) -> int:
        """只读打开锁文件；连只读都打不开就用特权通道把锁文件补出来。"""
        try:
            return os.open(path, os.O_RDONLY)
        except FileNotFoundError:
            pass
        except OSError as exc:
            if exc.errno not in (errno.EACCES, errno.EPERM):
                raise ConfigError(f"无法打开沙箱锁文件：{path}（{exc}）") from exc
        self._provision_lock_file(path)
        try:
            return os.open(path, os.O_RDONLY)
        except OSError as exc:
            raise ConfigError(f"无法打开沙箱锁文件：{path}（{exc}）") from exc

    def _provision_lock_file(self, path: Path) -> None:
        """用特权通道把锁文件补出来（0644，任何账号随后都能只读打开）。"""
        result = run(
            self.privilege.wrap(
                ["install", "-m", f"{LOCK_FILE_MODE:04o}", "/dev/null", str(path)]
            ),
            check=False,
        )
        if not result.ok:
            logger.error("创建沙箱锁文件失败：%s（%s）", path, result.output.strip())
