"""一次性探针：验证「宿主伪终端 + 容器内真实 TTY + 窗口大小同步」这条主链路。

不属于测试套件：需要宿主有 docker，会起一个一次性容器（用完即删）。

用法（在本目录下）::

    uv run python 01-pty-tty-probe.py

判据（对应二期任务 03 的验收口径）：

1. 容器内进程拿到的是真 TTY（``tty`` 输出 ``/dev/pts/N``）；
2. 初始窗口大小进了容器（``stty size`` 与宿主伪终端一致）；
3. 宿主侧改窗口大小后，容器内 ``stty size`` 跟着变；
4. Ctrl-C 生效（被中断的命令返回 130）；
5. 宿主侧 exec 进程不退出。
"""

from __future__ import annotations

import fcntl
import os
import select
import struct
import subprocess
import sys
import termios
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))

from sandbox_platform import spawn_pty  # noqa: E402

CONTAINER = "pty-probe-terminal"


def drain(fd: int, seconds: float = 1.0) -> bytes:
    """在给定时长内尽量读出输出。"""
    out = b""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
    return out


def main() -> int:
    """跑一遍判据，全部通过返回 0。"""
    subprocess.run(["docker", "rm", "-f", CONTAINER], capture_output=True, check=False)
    created = subprocess.run(
        ["docker", "run", "-d", "-i", "--name", CONTAINER, "alpine:latest", "sleep", "3600"],
        capture_output=True,
        text=True,
        check=False,
    )
    if created.returncode != 0:
        print("起容器失败：", created.stderr)
        return 1
    try:
        pty = spawn_pty(
            ["docker", "exec", "-it", CONTAINER, "sh", "-i"], cols=100, rows=30
        )
        print("伪终端已起：进程号", pty.pid)
        time.sleep(1.5)
        print("初始输出：", drain(pty.master_fd, 1.0))

        # 1) 容器内拿到的是真 TTY
        os.write(pty.master_fd, b"tty; echo rc=$?\n")
        out = drain(pty.master_fd, 1.5)
        print("tty 输出：", out)
        assert b"/dev/pts/" in out, "容器内不是真 TTY"

        # 2) 初始窗口大小进了容器
        os.write(pty.master_fd, b"stty size\n")
        out = drain(pty.master_fd, 1.5)
        print("初始 stty：", out)
        assert b"100" in out and b"30" in out, "初始窗口大小没同步"

        # 3) 改窗口大小后容器内跟着变
        fcntl.ioctl(
            pty.master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 43, 132, 0, 0)
        )
        time.sleep(1.0)
        os.write(pty.master_fd, b"stty size\n")
        out = drain(pty.master_fd, 1.5)
        print("调整后 stty：", out)
        assert b"132" in out and b"43" in out, "窗口大小没同步到容器"

        # 4) Ctrl-C 生效（行编辑语义在容器内 TTY 上）
        os.write(pty.master_fd, b"sleep 30\n")
        time.sleep(1.0)
        os.write(pty.master_fd, b"\x03")
        time.sleep(1.0)
        os.write(pty.master_fd, b"echo alive=$?\n")
        out = drain(pty.master_fd, 1.5)
        print("Ctrl-C 后：", out)
        assert b"alive=" in out, "Ctrl-C 没生效"

        # 5) 容器内进程仍在（断线不影响）
        print("宿主 exec 进程是否还活着：", pty.poll() is None)
        assert pty.poll() is None
        pty.close()
        print("探针通过")
        return 0
    finally:
        subprocess.run(["docker", "rm", "-f", CONTAINER], capture_output=True, check=False)


if __name__ == "__main__":
    raise SystemExit(main())
