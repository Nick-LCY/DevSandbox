"""宿主命令执行封装。

核心模块不直接打印任何内容，命令输出全部以返回值形式交给调用方。
"""

from __future__ import annotations

import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .errors import CommandError

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 300


@dataclass(frozen=True)
class CommandResult:
    """一次命令执行的结果。"""

    argv: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        """退出码是否为 0。"""
        return self.returncode == 0

    @property
    def output(self) -> str:
        """标准输出与标准错误合并文本。"""
        parts = [part for part in (self.stdout.strip(), self.stderr.strip()) if part]
        return "\n".join(parts)

    def raise_for_status(self) -> CommandResult:
        """退出码非 0 时抛出 :class:`CommandError`。"""
        if not self.ok:
            raise CommandError(self.argv, self.returncode, self.stdout, self.stderr)
        return self


def run(
    argv: list[str] | tuple[str, ...],
    *,
    env: dict[str, str] | None = None,
    check: bool = False,
    timeout: int | None = DEFAULT_TIMEOUT,
    cwd: str | Path | None = None,
    stdin_text: str | None = None,
) -> CommandResult:
    """执行一条宿主命令并收集输出。

    参数
    ----
    argv : 命令与参数
    env : 完整环境变量；为 ``None`` 时继承当前进程环境
    check : 为真时失败抛 :class:`CommandError`
    timeout : 超时秒数；``None`` 表示不限制
    stdin_text : 标准输入文本
    """
    argv = tuple(str(item) for item in argv)
    logger.debug("执行命令：%s", " ".join(argv))
    try:
        completed = subprocess.run(
            argv,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(cwd) if cwd is not None else None,
            input=stdin_text,
            check=False,
        )
    except FileNotFoundError as exc:
        raise CommandError(argv, 127, "", str(exc), message=f"命令不存在：{argv[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise CommandError(argv, 124, "", str(exc), message=f"命令超时（{timeout} 秒）") from exc
    result = CommandResult(argv, completed.returncode, completed.stdout, completed.stderr)
    if check:
        result.raise_for_status()
    return result
