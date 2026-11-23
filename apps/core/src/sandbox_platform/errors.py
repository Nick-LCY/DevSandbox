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


class ImageNotFoundError(ImageError):
    """两条途径都拿不到该镜像。

    两种情形：宿主与沙箱守护进程都没有该镜像；镜像代理拉取失败且宿主也没有
    可注入的本地副本。

    属于用户侧错误（选错了镜像或镜像来源），与服务端故障区分开：
    服务层把它映射成 400 而不是 500。
    """


class ProxyError(SandboxError):
    """统一镜像代理不可用（拉起失败、健康检查不通过、CA 不可读等）。

    代理不可达时**不做降级直连**（用户已拍板）：调用方必须直接失败。
    """


class CacheScanError(SandboxError):
    """镜像代理缓存目录扫描失败（特权枚举 / 批量读失败或超时）。

    只覆盖「整场扫描跑不起来」的失败：单条缓存条目脏（文件名不合法、
    ``KEY:`` 头缺失、清单体不可解析）只让该条落榜、不让扫描失败。
    调用方（服务端）把它映射成 503，而不是静默回空清单。
    """


class LifecycleError(SandboxError):
    """生命周期步骤失败。"""

    def __init__(self, step: str, message: str, cause: Exception | None = None) -> None:
        self.step = step
        self.cause = cause
        super().__init__(f"步骤「{step}」失败：{message}")


class TransferError(SandboxError):
    """运行期文件传输操作失败。

    与 :class:`NotFoundError` / :class:`ValidationError` 区分：前两者是「对象不存在」
    与「入参非法」，本类是「传输本身跑不起来」——路径非法、父目录缺失、父目录不可写、
    挂载只读、目标是目录、目标不是普通文件、容器内命令失败等。

    属性
    ----
    reason : 失败分类码（见 ``transfer.REASON_*``）。服务端按它映射 HTTP 状态码，
        不必去解析异常文案。**分类码与场景对应、文案按场景取**：同一个分类码
        可能对应**两条场景文案**（如「目标是目录」在上传侧与下载侧措辞不同），
        所以**不能反推**「分类码 ⇄ 文案一一对应」；调用方只按分类码映射状态码。

    归属平台的业务异常都住在本模块：调用方（服务端）按异常类型映射 HTTP 状态码，
    不必知道传输模块的内部结构。
    """

    def __init__(self, message: str, *, reason: str = "") -> None:
        self.reason = reason
        super().__init__(message)


class SandboxConflictError(SandboxError):
    """同名沙箱的互斥操作冲突（被拒）。

    同一沙箱的 **refresh 与 start / stop / delete** 互斥（进程内 name lock
    + 同平台数据根的 per-name ``flock``）。冲突方**立即被拒**（非阻塞），
    不排队等待——等到了再执行会把「冲突」悄悄变成「串行」，用户看到的
    语义就错了。

    与 :class:`RefreshError` 分开：生命周期操作（启动 / 停止 / 删除）撞上
    并发时抛本类，刷新路径把它转译成 ``RefreshError``（``reason="conflict"``），
    这样服务端按刷新接口的分类码映射状态码即可。
    """

    #: 失败分类码（服务端按它映射状态码）
    reason = "conflict"


class RefreshError(SandboxError):
    """文件注入副本刷新失败（结构化分类码）。

    属性
    ----
    reason : 失败分类码（见 ``refresh.REASON_*``）。服务端按它映射 HTTP 状态码，
        不必去解析异常文案。
    hold_lock : 失败发生时**可能仍有写者在跑**（helper 超时 / 异常退出，
        它 fork 出来的写入子进程可能还活着）。调用方据此**不释放**同名锁——
        锁被释放就可能与仍在写入的副本并发。
    writer_token : 本次刷新的**操作令牌**（32 hex）：写了 ``hold_lock`` 时，
        调用方只凭它在 ``/proc`` 里等**本次执行**的写者收工，不会为别的
        沙箱的并发刷新阻塞，也不因它们把锁永久放弃。
    spool_root : 本次刷新专属的暂存目录（只在本次写者收工后清理）。

    这两个标记都是非敏感数据：令牌是随机串，暂存路径只在平台侧流转。
    锁一旦因写者长期不收工而放弃，就是**真实未知**的保底：锁保持到进程
    退出，暂存目录保留（写者可能仍在读）。

    分类码与固定文案的对应关系见 ``refresh`` 模块顶部的表格。
    """

    def __init__(
        self,
        message: str,
        *,
        reason: str = "",
        hold_lock: bool = False,
        writer_token: str = "",
        spool_root: str = "",
    ) -> None:
        self.reason = reason
        self.hold_lock = hold_lock
        self.writer_token = writer_token
        self.spool_root = spool_root
        super().__init__(message)


class ForwardError(SandboxError):
    """端口转发操作失败。

    与 :class:`NotFoundError` / :class:`ValidationError` 区分：前者是「对象不存在」，
    后者是「入参非法」，本类是「转发链路本身跑不起来」——沙箱已停止、沙箱网络不存在、
    镜像拉不到、容器起不来、容器名与现有非平台容器重名等。

    归属平台的业务异常都住在本模块：调用方（服务端）按异常类型映射 HTTP 状态码
    （冲突类错误），不必知道转发模块的内部结构。
    """
