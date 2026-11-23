"""文件注入副本刷新（运行中沙箱、**不停机**）。

**它是什么**：一条**显式触发**的通道——用户对**某一条**已保存的注入
（单文件或整目录）点一次「刷新副本」，平台把宿主源的**新内容**重新复制到
沙箱用户家目录里的**托管副本**上。容器不重建、不重挂载、不 ``docker cp``，
终端与 agent 会话不断。

**它不做什么**：不后台同步、不轮询、不批量刷新、不做备份、不回滚、
不承诺原子性；不提供「刷任意路径」的口子（只认**已保存的条目标识**）。

**机制地基**：写入动作全部交给随包分发的窄用途 helper
（``sandbox_platform/_refresh_helper.py``），经**既有 ``Privilege`` 通道**
以「**受信绝对路径 + ``python -I``**」调用。核心包这边只做四件事：

1. **定位**：按条目标识在**本实例的元数据**里找到那一条（不查模板、
   不接受调用方给路径）；
2. **复核**：源按创建时同档口径**重新校验**（本次是 **fail closed**：
   探测不出来就拒绝），目的必须与 ``files`` 清单里的那一份对得上；
3. **调用**：把「源 / 副本 / 种类 / 副本身份 / 写入身份 / 受限根清单」交给
   helper，由它降到沙箱用户身份去写；
4. **收口**：把 helper 的分类码翻译成**结构化错误**（见下表）。

**失败语义**（与 PRD 一致）：

- **预校验失败 / 枚举不全** ⇒ **副本一个字节都不动**；
- **进入写入阶段后失败** ⇒ 报「**可能部分更新**」，**不回滚**、不续跑，
  用户修正后**手动重试**；
- **helper 超时 / 异常退出** ⇒ 保守按「可能部分更新」处理（helper fork 出来
  的写入子进程可能还活着），并且**不释放同名锁**（见 ``namelock``）。
  每次刷新生成一个随机**操作令牌**，以 helper argv 里唯一的
  ``--job-id <32hex>`` 进入（JSON 载荷仍**只走 stdin**）：等待只追踪
  **本次执行**的写者（脚本实参 + 令牌精确匹配 ``/proc``），不同沙箱的
  并行刷新互不牵连；本次专属暂存目录**留到本次写者收工后**再清理。

**错误分类码**（服务端按分类码映射状态码，不解析文案）：

======================  ======  ==========================================
分类码（``reason``）   状态码  语义
======================  ======  ==========================================
``not_found``          404     条目不存在 / 沙箱不存在（旧实例没有条目）
``conflict``           409     同名沙箱的并发操作冲突（被拒，不排队）
``precheck``           400     预校验未通过（源不安全 / 目的不安全 /
                              容器未运行 / 根类型改变）：**副本零改动**
``partial``            500     进入写入阶段后失败：**可能部分更新**
``internal``           500     平台内部异常：副本状态未知（保守按可能
                              部分更新报）
======================  ======  ==========================================

**正文不外泄**：本模块只回**元数据**（源路径 / 副本路径 / 容器路径 /
种类），源字节只用于复制，异常文案与日志都不含正文。
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import shutil
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .command import CommandError, run
from .config import PlatformConfig
from .daemon import UserDaemon
from .errors import RefreshError, ValidationError
from .files import SandboxHomeScope, injection_kind_of, probe_refresh_source
from .metadata import InjectionRecord, SandboxMetadata
from .mounts import sensitive_host_paths
from .namelock import MSG_CONFLICT
from .userspace import Privilege, SystemUser, UserSpaceManager

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------- 失败分类码
#: 条目不存在（沙箱不存在、旧实例没有注入条目、条目与副本清单对不上）
REASON_NOT_FOUND = "not_found"
#: 同名沙箱的并发操作冲突
REASON_CONFLICT = "conflict"
#: 预校验未通过：副本零改动
REASON_PRECHECK = "precheck"
#: 进入写入阶段后失败：可能部分更新
REASON_PARTIAL = "partial"
#: 平台内部异常
REASON_INTERNAL = "internal"

# ---------------------------------------------------------------- 固定中文文案
#: 条目不存在
MSG_ENTRY_NOT_FOUND = "注入条目不存在：该沙箱没有可刷新的注入记录"
#: 条目与沙箱副本清单对不上（记录被改动过）
MSG_ENTRY_MISMATCH = "注入条目与沙箱副本记录不一致，无法刷新"
#: 并发冲突：文案从锁模块直接引入（同一把锁、同一句话，不各写一份）
__all__ = [
    "MSG_CONFLICT",
    "MSG_ENTRY_MISMATCH",
    "MSG_INTERNAL",
    "MSG_INTERNAL_UNSTARTED",
    "MSG_KIND_MISMATCH",
    "MSG_ENTRY_NOT_FOUND",
    "MSG_PARTIAL",
    "MSG_PRECHECK",
    "MSG_SANDBOX_NOT_RUNNING",
    "REASON_CONFLICT",
    "REASON_INTERNAL",
    "REASON_NOT_FOUND",
    "REASON_PARTIAL",
    "REASON_PRECHECK",
    "InjectionRefresher",
    "RefreshResult",
    "RefreshRuntime",
    "helper_path",
    "live_helper_pids",
    "new_job_id",
    "remove_spool_root",
    "wait_for_helper_writers",
]
#: 预校验未通过（源不安全 / 目的不安全 / 根类型改变）：副本零改动
MSG_PRECHECK = "刷新前置校验未通过，副本未改动"
#: 沙箱未运行
MSG_SANDBOX_NOT_RUNNING = "沙箱未运行，无法刷新副本"
#: 注入根类型改变（文件 ↔ 目录）
MSG_KIND_MISMATCH = "注入源的类型已改变，无法刷新副本"
#: 写入阶段失败：可能部分更新
MSG_PARTIAL = "刷新写入阶段失败，副本可能部分更新，请修正后重试"
#: 内部异常：保守按可能部分更新报
MSG_INTERNAL = "刷新执行异常，副本可能部分更新，请稍后重试"
#: 内部异常（刷新程序压根没起来）：副本确定没动
MSG_INTERNAL_UNSTARTED = "刷新执行异常：刷新程序不可用，副本未改动"

# ---------------------------------------------------------------- helper 契约
#: helper 的分类码 → 退出码（与 helper 的固定契约一致）
HELPER_EXIT_BY_CODE: dict[str, int] = {
    "OK": 0,
    "SOURCE_UNSAFE": 10,
    "DESTINATION_UNSAFE": 20,
    "PARTIAL": 30,
    "INTERNAL": 40,
}

#: helper 的等待上限（秒）。超时按「可能部分更新」保守处理。
HELPER_TIMEOUT = 900

#: helper 超时后，等它 fork 出来的写入子进程收工的等待上限（秒）
HELPER_WRITER_SETTLE_TIMEOUT = 60

#: 操作令牌标志（helper 唯一允许的 argv；令牌非敏感，只用于 /proc 识别）
JOB_ID_FLAG = "--job-id"

#: 本次刷新自己的暂存目录前缀（``mkdtemp`` 生成，删之前按它核对）
SPOOL_PREFIXES = ("refresh-spool-", "sandbox-refresh-spool-")


def new_job_id() -> str:
    """生成一次刷新的**操作令牌**（32 个小写十六进制字符）。

    令牌只做一件事：让 ``/proc`` 里的写者能按**本次执行**认出来（不同
    沙箱的并发刷新互不牵连）。它不含路径、不含正文，也不进 JSON 载荷——
    所有载荷仍然**只走 stdin**。
    """
    return secrets.token_hex(16)


def helper_path() -> Path:
    """随包分发的刷新 helper 的**绝对路径**。

    helper 与本模块同在包目录里（``sandbox_platform/_refresh_helper.py``），
    随 wheel 一起分发：不需要 ``/usr/local`` 安装、不新增 env 配置、
    不放宽 sudo 规则。
    """
    return Path(__file__).with_name("_refresh_helper.py")


# ---------------------------------------------------------------- 结果与依赖
@dataclass(frozen=True)
class RefreshResult:
    """一次刷新成功的结果（**只有元数据**，没有正文）。"""

    sandbox_name: str
    entry_id: str
    kind: str
    source_path: str
    staged_path: str
    container_path: str


class RefreshRuntime(Protocol):
    """刷新编排依赖的沙箱侧能力（由生命周期服务实现）。

    与 ``transfer.TransferRuntime`` 同款：核心包用协议描述依赖方向，
    刷新编排不认识界面层。
    """

    def get(self, name: str) -> SandboxMetadata:
        """取沙箱元数据（不存在抛 ``NotFoundError``）。"""
        ...

    def daemon_for(self, name: str) -> UserDaemon:
        """取沙箱对应的守护进程操作入口。"""
        ...


# ---------------------------------------------------------------- 编排
class InjectionRefresher:
    """注入副本刷新编排入口。

    能力本体全在本类：条目定位、状态复核、源重校验、helper 调用、错误收口。
    服务端（03 轮）只做编排与转译。
    """

    def __init__(
        self,
        config: PlatformConfig | None = None,
        privilege: Privilege | None = None,
        runtime: RefreshRuntime | None = None,
    ) -> None:
        self.config = config or PlatformConfig.from_env()
        self.privilege = privilege or Privilege()
        self.runtime = runtime
        self.userspace = UserSpaceManager(self.config, self.privilege)

    # ---------------------------------------------------------------- 入口
    def refresh(self, metadata: SandboxMetadata, entry_id: str) -> RefreshResult:
        """刷新某一条注入的托管副本。

        调用方（生命周期服务）必须已持有该沙箱的**同名锁**：刷新与
        start / stop / delete 互斥，同一沙箱的两次刷新也不并发。
        """
        record = self._find_entry(metadata, entry_id)
        self._check_matches_files(metadata, record)
        user = self._resolve_user(metadata)
        self._check_running(metadata)
        home_scope = SandboxHomeScope(
            user_prefix=self.config.user_prefix,
            privilege=self.privilege,
            strict=True,
        )
        kind = injection_kind_of(self._probe_source(record, home_scope))
        if kind != record.kind:
            logger.warning(
                "注入源类型已改变（记录 %s，实际 %s）：%s",
                record.kind,
                kind,
                record.source_path,
            )
            raise RefreshError(MSG_KIND_MISMATCH, reason=REASON_PRECHECK)
        self._run_helper(metadata, record, user, home_scope)
        return RefreshResult(
            sandbox_name=metadata.name,
            entry_id=record.entry_id,
            kind=record.kind,
            source_path=record.source_path,
            staged_path=record.staged_path,
            container_path=record.container_path,
        )

    # ---------------------------------------------------------------- 定位与复核
    def _find_entry(self, metadata: SandboxMetadata, entry_id: str) -> InjectionRecord:
        """按条目标识在**本实例元数据**里找那一条。

        旧实例没有 ``injections`` 记录 ⇒ **无可刷对象**（不迁移、不补录、
        不反查模板）。
        """
        for record in metadata.injections or []:
            if record.entry_id == entry_id:
                return record
        raise RefreshError(MSG_ENTRY_NOT_FOUND, reason=REASON_NOT_FOUND)

    def _check_matches_files(
        self, metadata: SandboxMetadata, record: InjectionRecord
    ) -> None:
        """条目必须与 ``files`` 清单里的那一份副本对得上。

        ``files`` 是既有的注入副本清单（语义不变）：托管副本路径与容器内
        路径必须与条目一致，否则这条记录不可信 —— 拒绝刷新。
        """
        for mount in metadata.files or []:
            if (
                mount.host_path == record.staged_path
                and mount.container_path == record.container_path
            ):
                return
        raise RefreshError(MSG_ENTRY_MISMATCH, reason=REASON_NOT_FOUND)

    def _resolve_user(self, metadata: SandboxMetadata) -> SystemUser:
        """现查沙箱系统用户（uid / gid 一律现查，不信元数据里的旧值）。"""
        user = self.userspace.lookup_user(metadata.system_user)
        if user is None:
            logger.error(
                "沙箱 %s 的系统用户在宿主上不存在：%s",
                metadata.name,
                metadata.system_user,
            )
            raise RefreshError(MSG_INTERNAL, reason=REASON_INTERNAL)
        return user

    def _check_running(self, metadata: SandboxMetadata) -> None:
        """只处理**运行中**的沙箱。

        停机沙箱没有「运行中的托管副本」可言（副本在，但容器不在）；刷新
        不做自动启动（那会重建容器、违背「不停机」）。
        """
        if self.runtime is None:
            raise RefreshError(MSG_INTERNAL, reason=REASON_INTERNAL)
        daemon = self.runtime.daemon_for(metadata.name)
        if not daemon.container_running(metadata.container_name):
            raise RefreshError(MSG_SANDBOX_NOT_RUNNING, reason=REASON_PRECHECK)

    def _probe_source(
        self, record: InjectionRecord, home_scope: SandboxHomeScope
    ) -> str:
        """对**实际源**重跑受限范围校验（fail closed），返回当前种类。"""
        try:
            return probe_refresh_source(
                self.privilege,
                record.source_path,
                extra_forbidden=[self.config.home],
                home_scope=home_scope,
            )
        except (ValidationError, CommandError) as exc:
            # 探测失败（含超时）⇒ 判不出来 ⇒ 拒绝刷新（fail closed）
            logger.warning(
                "刷新前置校验未通过（条目 %s）：%s",
                record.entry_id,
                exc,
            )
            raise RefreshError(MSG_PRECHECK, reason=REASON_PRECHECK) from exc

    # ---------------------------------------------------------------- helper 调用
    def _forbidden_roots(self, home_scope: SandboxHomeScope) -> tuple[str, ...]:
        """本次刷新的**完整受限根清单**。

        = 宿主敏感清单（固定清单 + 平台数据根）∪ **所有已存在的沙箱用户
        家目录**（含本次目标沙箱自己的家目录）。helper 拿这份清单逐项核对
        源与其树内成员。
        """
        roots = list(sensitive_host_paths([self.config.home]))
        for home in home_scope.homes():
            text = str(home)
            if text not in roots:
                roots.append(text)
        return tuple(roots)

    def _run_helper(
        self,
        metadata: SandboxMetadata,
        record: InjectionRecord,
        user: SystemUser,
        home_scope: SandboxHomeScope,
    ) -> None:
        """调用 helper 刷新副本，并把它的分类码收口成结构化错误。

        每次刷新生成一个随机**操作令牌**（只进 helper argv，不进载荷），
        失败且可能仍有写者时把它与本次专属暂存目录挂到 ``RefreshError`` 上：
        生命周期侧据此只等**本次执行**的写者（不同沙箱的并发刷新互不牵连）。
        暂存目录也留到写者收工后再删——写者还可能从里面读新内容。
        """
        spool_root = self._make_spool_root()
        job_id = new_job_id()
        try:
            self._invoke_helper(
                metadata, record, user, home_scope, spool_root, job_id
            )
        except RefreshError as exc:
            if exc.hold_lock:
                # 可能仍有**本次执行**的写者在跑：标记本次执行 + 暂存路径，
                # 由生命周期侧在本次写者收工后再解锁 / 清理。
                exc.writer_token = job_id
                exc.spool_root = str(spool_root)
            else:
                remove_spool_root(spool_root)
            raise
        except BaseException:
            # 意外异常：没进入「可能仍有写者」的判定，按旧口径清掉暂存
            remove_spool_root(spool_root)
            raise
        else:
            remove_spool_root(spool_root)

    def _invoke_helper(
        self,
        metadata: SandboxMetadata,
        record: InjectionRecord,
        user: SystemUser,
        home_scope: SandboxHomeScope,
        spool_root: Path,
        job_id: str,
    ) -> None:
        """真正跑 helper：载荷（含暂存根）**只走 stdin**，argv 只带令牌。"""
        try:
            forbidden = self._forbidden_roots(home_scope)
        except ValidationError as exc:
            logger.warning("无法取全受限根清单，拒绝刷新：%s", exc)
            raise RefreshError(MSG_PRECHECK, reason=REASON_PRECHECK) from exc
        payload = {
            "source_path": record.source_path,
            "staged_path": record.staged_path,
            "kind": record.kind,
            "staged_dev": record.dev,
            "staged_ino": record.ino,
            "uid": user.uid,
            "gid": user.gid,
            "forbidden_roots": list(forbidden),
            "spool_root": "",
        }
        spool_root_text = str(spool_root)
        payload["spool_root"] = spool_root_text
        helper = helper_path()
        # argv 里**只有**可选的 ``--job-id <32hex>`` 操作令牌（非敏感），
        # 载荷（源 / 副本 / 身份 / 受限根）一律只走 stdin。
        argv = self.privilege.wrap(
            [sys.executable, "-I", str(helper), JOB_ID_FLAG, job_id]
        )
        try:
            result = run(
                argv,
                stdin_text=json.dumps(payload, ensure_ascii=False),
                check=False,
                timeout=HELPER_TIMEOUT,
            )
        except CommandError as exc:
            self._raise_for_command_error(exc)
            raise  # pragma: no cover - _raise_for_command_error 一定抛
        except OSError as exc:
            # 宿主侧异常（起不来 / 管道断了）：helper 是否已经跑起来说不准
            # ⇒ 保守按可能部分更新报，并且**不释放同名锁**。
            logger.error("调用刷新 helper 失败：%s", exc)
            raise RefreshError(
                MSG_INTERNAL, reason=REASON_INTERNAL, hold_lock=True
            ) from exc
        self._raise_for_helper_result(metadata, record, result)

    def _raise_for_command_error(self, exc: CommandError) -> None:
        """``run`` 抛异常时（命令不存在 / 超时）收口成结构化错误。"""
        if exc.returncode == 124:
            # 超时：helper 父进程被杀了，但它 fork 出来的写入子进程**可能还活着**
            # ——保守按「可能部分更新」报，并且**不释放同名锁**（hold_lock）。
            logger.error("刷新 helper 超时，副本可能部分更新：%s", exc)
            raise RefreshError(
                MSG_PARTIAL, reason=REASON_PARTIAL, hold_lock=True
            ) from exc
        logger.error("刷新 helper 未能执行，副本未改动：%s", exc)
        raise RefreshError(MSG_INTERNAL_UNSTARTED, reason=REASON_INTERNAL) from exc

    def _raise_for_helper_result(self, metadata, record, result) -> None:
        """把 helper 的 stdout / 退出码翻译成结构化错误。"""
        body = self._parse_helper_output(result.stdout)
        code = body.get("code") if body else None
        reason = body.get("reason") if body else None
        expected = HELPER_EXIT_BY_CODE.get(code) if isinstance(code, str) else None
        if expected is None or result.returncode != expected:
            # 认不出来（stdout 不是预期的一行 JSON、分类码未知、退出码对不上）
            # ⇒ 保守按「可能部分更新」处理，不猜。
            # **异常退出**：helper 父进程可能被杀，它 fork 出来的写入子进程
            # 可能还活着 ⇒ 不释放同名锁（hold_lock）。
            logger.error(
                "刷新 helper 返回异常（沙箱 %s，条目 %s）：退出码 %s，分类 %r",
                metadata.name,
                record.entry_id,
                result.returncode,
                code,
            )
            raise RefreshError(
                MSG_INTERNAL, reason=REASON_INTERNAL, hold_lock=True
            )
        if code == "OK":
            return
        logger.warning(
            "刷新失败（沙箱 %s，条目 %s）：分类 %s，细分 %s",
            metadata.name,
            record.entry_id,
            code,
            reason,
        )
        if code in ("SOURCE_UNSAFE", "DESTINATION_UNSAFE"):
            # 预检与目的侧校验失败：目标零改动（helper 正常退出，没有残留写者）
            raise RefreshError(MSG_PRECHECK, reason=REASON_PRECHECK)
        if code == "PARTIAL":
            raise RefreshError(MSG_PARTIAL, reason=REASON_PARTIAL)
        # INTERNAL：helper 自己出了问题（参数 / 暂存 / 降权 / 意外）——写入子进程
        # 是否还在跑说不准 ⇒ 同样不放锁（等写者收工后再放）。
        raise RefreshError(MSG_INTERNAL, reason=REASON_INTERNAL, hold_lock=True)

    @staticmethod
    def _parse_helper_output(stdout: str) -> dict | None:
        """解析 helper 的 stdout（**恒为一行** JSON）；解析不出来返回 ``None``。"""
        text = (stdout or "").strip()
        if not text:
            return None
        first = text.splitlines()[0].strip()
        try:
            body = json.loads(first)
        except ValueError:
            return None
        if not isinstance(body, dict):
            return None
        return body

    # ---------------------------------------------------------------- 暂存
    def _make_spool_root(self) -> Path:
        """准备**平台私有**的暂存目录（helper 的匿名 spool 落在这里）。

        - 落在平台临时根（``<平台数据根>/tmp``）下的**专用子目录**，用完即删；
        - **由当前平台账号创建**（不是 root 建完留个 root 属主的目录）：
          root CLI 建出来的目录属主是 root，普通控制台账号之后就用不了；
        - 平台临时根不可写时退回系统临时目录（``mkdtemp`` 建的目录 0700，
          只有属主能进）。
        """
        base = self.config.temp_root
        try:
            base.mkdir(parents=True, exist_ok=True)
        except OSError:
            base = None
        if base is not None:
            try:
                return Path(tempfile.mkdtemp(prefix="refresh-spool-", dir=str(base)))
            except OSError:
                pass
        return Path(tempfile.mkdtemp(prefix="sandbox-refresh-spool-"))


# ---------------------------------------------------------------- 写者收尾
def remove_spool_root(spool_root: Path | str) -> bool:
    """删掉**本次刷新专属**的暂存目录；返回是否删掉了。

    只删「自己 ``mkdtemp`` 出来的那一份」：末段名字必须带刷新专用前缀、
    实际路径的末段与传入末段一致（末段不是符号链接 / 不指向别处）、并且
    确实是个目录。任何一条不满足就**不删**——宁可留下残留，也不误删
    与别的刷新 / 别的路径**共享**的目录。
    """
    path = Path(spool_root)
    if not path.name.startswith(SPOOL_PREFIXES):
        return False
    try:
        if Path(os.path.realpath(path)).name != path.name:
            return False
        if path.is_symlink() or not path.is_dir():
            return False
        shutil.rmtree(path, ignore_errors=True)
        return True
    except OSError:  # pragma: no cover - 极少数宿主侧竞态
        return False


def _cmdline_has_helper_job(
    cmdline: bytes, helper: bytes, token: bytes
) -> bool:
    """cmdline 是否是**本次执行**的 helper（脚本实参 + ``--job-id`` 令牌）。

    按 NUL 切成实参数组：脚本路径必须是**独立的一个实参**，紧跟着
    ``--job-id`` + 本次令牌。``fork`` 出来的写子进程继承同一份 cmdline，
    所以父 / 子一起被认出来；不同沙箱的刷新令牌不同，互不牵连。
    """
    args = [item for item in cmdline.split(b"\x00") if item]
    if helper not in args:
        return False
    flag = JOB_ID_FLAG.encode("utf-8")
    return any(
        args[index] == flag and args[index + 1] == token
        for index in range(len(args) - 1)
    )


def live_helper_pids(helper: Path | str, token: str) -> list[int]:
    """**本次执行**还活着的 helper 进程（含它 fork 出来的写入子进程）。

    精确匹配「脚本路径实参 + ``--job-id <token>``」：只看脚本路径会把
    **别的沙箱**正在跑的刷新（甚至别的进程）也算进来，导致本次刷新替
    别人等、甚至替别人把锁永远放弃。
    """
    marker = str(helper).encode("utf-8")
    wanted = token.encode("utf-8")
    pids: list[int] = []
    try:
        entries = os.listdir("/proc")
    except OSError:  # pragma: no cover - /proc 不可读（非常规宿主）
        return pids
    for entry in entries:
        if not entry.isdigit():
            continue
        pid = int(entry)
        if pid == os.getpid():
            continue
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as handle:
                cmdline = handle.read()
        except OSError:
            continue
        if _cmdline_has_helper_job(cmdline, marker, wanted):
            pids.append(pid)
    return pids


def wait_for_helper_writers(
    helper: Path | str, token: str, timeout: float | None = None
) -> bool:
    """等**本次执行**的写者收工；返回是否已收干净。

    收不干净就不能释放同名锁：锁一放，另一个进程就能进来与仍在写入的
    副本并发。只等本次令牌——别的沙箱的写者与本次无关，绝不让本次刷新
    为它阻塞、更不能因它把本次的锁永远放弃。
    """
    if timeout is None:
        timeout = HELPER_WRITER_SETTLE_TIMEOUT
    deadline = time.monotonic() + timeout
    while True:
        pids = live_helper_pids(helper, token)
        if not pids:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.2)
