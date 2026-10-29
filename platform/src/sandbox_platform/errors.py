"""控制面异常类型。

核心模块统一用异常表达失败，命令行薄壳负责把异常翻译成退出码与提示文案。
"""

from __future__ import annotations

import shlex


class SandboxError(Exception):
    """沙箱平台所有业务异常的基类。"""


class ConfigError(SandboxError):
    """平台配置非法（环境变量取值不合法等）。"""


class ValidationError(SandboxError):
    """用户输入非法（沙箱名、挂载声明、镜像名等）。"""


class NotFoundError(SandboxError):
    """沙箱不存在。"""


class AlreadyExistsError(SandboxError):
    """沙箱已存在。"""


class CommandError(SandboxError):
    """宿主命令执行失败。

    属性
    ----
    argv : 命令行
    returncode : 退出码
    stdout / stderr : 输出
    """

    def __init__(
        self,
        argv: list[str] | tuple[str, ...],
        returncode: int,
        stdout: str = "",
        stderr: str = "",
        message: str | None = None,
    ) -> None:
        self.argv = tuple(argv)
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        detail = message or stderr.strip() or stdout.strip() or f"退出码 {returncode}"
        super().__init__(f"命令执行失败（{returncode}）：{shlex.join(self.argv)} — {detail}")


class ImageError(SandboxError):
    """镜像不可用（本地无镜像且拉取失败）。"""


class ProxyError(SandboxError):
    """统一镜像代理不可用（拉起失败、健康检查不通过、CA 不可读等）。

    代理不可达时**不做降级直连**（用户已拍板）：调用方必须直接失败。
    """


class LifecycleError(SandboxError):
    """生命周期步骤失败。"""

    def __init__(self, step: str, message: str, cause: Exception | None = None) -> None:
        self.step = step
        self.cause = cause
        super().__init__(f"步骤「{step}」失败：{message}")
