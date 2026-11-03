"""端口转发编排（转发容器起停 / 转发记录读写 / 遗留清理）。

机制依据：ADR 0014（第二次修订，决策 C）——**链路两点化、后端宿主零端口**。

- 转发容器是**平台自建资源**：由**沙箱自己的免 root 守护进程**启动，接入沙箱
  网络；**不发布任何端口**（启动参数里没有 ``-p``），容器主进程**常驻空转**、
  不在容器内做任何 TCP 监听。``socat`` 二进制由镜像提供，**专供 exec 字节泵使用**。
- 字节通道的唯一路径是 exec 字节泵：
  ``docker exec -i <转发容器> socat - TCP:<沙箱容器>:<端口>``（在沙箱守护进程下
  执行）。宿主特权交互全部收敛在本模块，调用方只负责拼参数与搬字节。
- 转发记录落 ``<平台数据根>/forwards/<id>.json``（权限 0600，原子替换），字段：
  ``id`` / ``sandbox`` / ``container_port`` / ``state`` / ``host_pid`` /
  ``created_at`` / ``updated_at``——**没有 ``host_port``**：宿主侧不再有平台分配的
  转发端口。
- 生命周期语义（与 ADR 0014 第 7 节一致）：建立幂等；停止 = 删容器 + 删记录；
  沙箱停止 → 转发容器一并停止（记录保留）；沙箱启动 → **不自动重建**（隧道建立时
  幂等重建）；沙箱删除 → 转发容器与记录纳入回收；服务重启 → 清理上次遗留。

**标签命名空间（本模块用 ``sandbox-platform.*``，既有沙箱容器用
``sandbox.platform/*``）**：两套并存，枚举平台自建资源时**不能只按其中一套来**，
否则会漏掉另一套的容器（沙箱容器按 ``sandbox.platform/role=sandbox`` 枚举，
转发容器按 ``sandbox-platform.role=forward`` 枚举）。
"""

from __future__ import annotations

import json
import logging
import os
import re
import signal
import subprocess
import tempfile
import threading
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol

from .config import MAX_PORT, MIN_PORT, PlatformConfig
from .daemon import UserDaemon, pid_alive
from .errors import ForwardError, NotFoundError, SandboxError, ValidationError
from .images import ImageManager
from .metadata import SandboxMetadata, utc_now
from .userspace import Privilege

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------- 平台标签
# 转发容器的平台标签：用于枚举与回收（ADR 0014 第 2 节）。
LABEL_FORWARD_ROLE = "sandbox-platform.role"
LABEL_FORWARD_ID = "sandbox-platform.forward.id"
LABEL_FORWARD_SANDBOX = "sandbox-platform.forward.sandbox"
ROLE_FORWARD = "forward"

# ---------------------------------------------------------------- 容器规格
# 转发镜像的 ENTRYPOINT 是 socat：必须显式覆盖 entrypoint 起一个常驻空转进程。
# 空转命令用 busybox 自带的 tail（不依赖 httpd 之类的额外工具），进程常驻不退出、
# 也不在容器内监听任何端口——转发容器的存在意义是「socat 二进制 + 沙箱网络内的
# 一等公民」（exec 字节泵的落点）。
FORWARD_ENTRYPOINT = "/bin/sh"
FORWARD_IDLE_COMMAND: tuple[str, ...] = ("-c", "exec tail -f /dev/null")
# 生命周期由平台显式管理，不让 Docker 兜底重启
FORWARD_RESTART_POLICY = "no"

# ---------------------------------------------------------------- 状态与标识
FORWARD_STATE_RUNNING = "running"
FORWARD_STATE_STOPPED = "stopped"

# 转发标识：uuid 短码（12 位十六进制）。只允许小写十六进制，
# 记录文件名由它拼出，必须挡住路径分隔符。
FORWARD_ID_LENGTH = 12
FORWARD_ID_PATTERN = re.compile(r"[0-9a-f]{8,32}")

# ---------------------------------------------------------------- 字节泵 stderr
# exec 的失败原因（镜像拉不到、容器起不来等）**只在 stderr 里**。
# stderr 管道缓冲有限（通常 64KB）：**没人排空时写满就把子进程卡死**——
# 隧道表现为「静默 hang」（既没有字节，也没有任何报错，客户端只看到连接被关）。
# 字节泵因此起一个**后台守护线程**持续排空 stderr，只保留**尾部**
# （最后 8KB，见 :attr:`BytePump.stderr_tail`）供调用方排查。
STDERR_TAIL_BYTES = 8192
# 排空线程每次读的块大小
STDERR_READ_CHUNK = 4096

# ---------------------------------------------------------------- 容器探测三态
# 「容器存不存在」不能只用布尔值表达：守护进程不可达时探测同样拿不到容器，
# 当成「不存在」就会把没删掉的容器说成已删除（记录也跟着删掉，容器成孤儿）。
PROBE_EXISTS = "exists"
PROBE_MISSING = "missing"
PROBE_FAILED = "failed"


def probe_container(daemon: UserDaemon, name: str) -> str:
    """探测容器是否存在，返回三态之一。

    - :data:`PROBE_EXISTS`：容器在；
    - :data:`PROBE_MISSING`：守护进程答了「没有这个容器」；
    - :data:`PROBE_FAILED`：探测本身失败（守护进程不可达、命令超时等）。

    判定口径：``docker ps`` **成功退出**才算探测成功；非零退出码说明守护进程
    没答上话，不能当成「容器不存在」。
    """
    try:
        result = daemon.docker(
            ["ps", "-a", "--filter", f"name={name}", "--format", "{{.Names}}"],
            check=False,
        )
    except Exception as exc:  # pragma: no cover - 宿主命令异常（超时等）
        logger.warning("探测容器 %s 失败：%s", name, exc)
        return PROBE_FAILED
    if not result.ok:
        logger.warning(
            "探测容器 %s 失败（沙箱守护进程不可达？）：%s", name, result.output.strip()
        )
        return PROBE_FAILED
    names = {line.strip() for line in result.stdout.splitlines() if line.strip()}
    return PROBE_EXISTS if name in names else PROBE_MISSING


def _owned_by_other_instance(host_pid: int) -> bool:
    """这条记录是不是另一个仍在运行的服务实例建的。

    判据同终端会话表（``sessions.py``）：记录的 ``host_pid`` 不是本进程，
    且那个进程号还活着——那个实例正在用这些转发，误清会打断别人的隧道。
    """
    if not host_pid or host_pid == os.getpid():
        return False
    return pid_alive(host_pid)


# ---------------------------------------------------------------- 入参校验
def validate_forward_id(forward_id: str) -> str:
    """校验转发标识（会拼进记录文件路径，必须挡住路径分隔符）。"""
    if not forward_id or not FORWARD_ID_PATTERN.fullmatch(forward_id):
        raise ValidationError(f"转发标识非法：{forward_id!r}")
    return forward_id


def validate_container_port(port: int) -> int:
    """校验容器端口（转发只针对用户显式指定的单个端口）。"""
    if isinstance(port, bool) or not isinstance(port, int):
        raise ValidationError(f"容器端口非法：{port!r}（应为整数）")
    if not MIN_PORT <= port <= MAX_PORT:
        raise ValidationError(f"容器端口非法：{port}（应为 {MIN_PORT}~{MAX_PORT}）")
    return port


def new_forward_id() -> str:
    """生成新的转发标识（uuid 短码）。"""
    return uuid.uuid4().hex[:FORWARD_ID_LENGTH]


# ---------------------------------------------------------------- 数据类
@dataclass
class ForwardRecord:
    """单条端口转发记录。

    **没有宿主端口字段**：链路两点化后后端宿主不持有任何转发端口
    （用户机本机端口由桌面端持有，不进平台记录）。

    ``host_pid`` 是建这条记录的服务进程号：清理遗留转发时用它判断
    「这条记录是不是另一个仍活着的服务实例的」（与终端会话表同款语义）。
    """

    id: str
    sandbox: str
    container_port: int
    state: str = FORWARD_STATE_RUNNING
    host_pid: int = 0
    created_at: str = field(default_factory=utc_now)
    updated_at: str = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        """转为可 JSON 序列化的字典。"""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ForwardRecord:
        """从字典还原（缺字段按默认值补齐）。

        **标识与端口都要校验**：两者都会进容器名与文件路径，非法值必须当
        「损坏记录」处理（整批枚举时跳过并告警），不能流到删除路径上去。
        """
        if not isinstance(data, dict):
            raise ValidationError("转发记录内容非法：应为 JSON 对象")
        known = set(cls.__dataclass_fields__)
        payload = {key: value for key, value in data.items() if key in known}
        payload.setdefault("id", "")
        payload.setdefault("sandbox", "")
        payload.setdefault("container_port", 0)
        payload.setdefault("state", FORWARD_STATE_RUNNING)
        payload.setdefault("host_pid", 0)
        try:
            payload["host_pid"] = int(payload["host_pid"] or 0)
        except (TypeError, ValueError):
            payload["host_pid"] = 0
        record = cls(**payload)
        validate_forward_id(record.id)
        validate_container_port(record.container_port)
        return record

    def touch(self) -> None:
        """刷新更新时间戳。"""
        self.updated_at = utc_now()


@dataclass(frozen=True)
class ForwardOpResult:
    """转发操作结果（回收清单式）。

    ``removed`` 是确实处理掉的条目，``failed`` 是尝试过但没成功的条目
    （带原因，如实上报，不吞掉）。
    """

    removed: tuple[str, ...] = ()
    failed: tuple[str, ...] = ()


class BytePump:
    """字节泵进程句柄（一条 TCP 连接对应一个 exec 进程）。

    连接断开时调用 :meth:`close`：**立即回收**该 exec 进程，不留僵尸进程。
    回收按**进程组**做：exec 客户端（``sudo`` 前缀下的 docker）拉起的孙进程
    一并收掉，不留孤儿。

    **stderr 排空**：exec 的失败原因只在 stderr 里，而 stderr 管道缓冲有限
    （通常 64KB）——没人排空时写满就把子进程卡死，隧道表现为「静默 hang」。
    因此字节泵起一个**后台守护线程**持续排空 stderr，只保留**尾部**
    （最后 8KB，见 :attr:`stderr_tail`）供调用方排查。
    """

    def __init__(self, process: "subprocess.Popen[bytes]", forward_id: str = "") -> None:
        self.process = process
        self.forward_id = forward_id
        self._closed = False
        # 进程组号在建进程时就记下：字节泵退出后进程号会被系统复用，
        # 到回收时再取可能拿到别人的进程组
        self._pgid = self._current_pgid()
        # stderr 排空：后台守护线程持续读走 stderr，只保留尾部
        self._stderr_tail = bytearray()
        self._stderr_lock = threading.Lock()
        self._stderr_thread: threading.Thread | None = None
        self._start_stderr_drain()

    def _current_pgid(self) -> int | None:
        """取当前进程组号（取不到返回 ``None``）。"""
        try:
            return os.getpgid(self.process.pid)
        except OSError:
            return None

    # ---------------------------------------------------------------- stderr 排空
    def _start_stderr_drain(self) -> None:
        """起后台守护线程排空 stderr（没有 stderr 就不起线程）。"""
        stream = self.process.stderr
        if stream is None:
            return
        thread = threading.Thread(
            target=self._drain_stderr,
            args=(stream,),
            name=f"byte-pump-stderr-{self.process.pid}",
            daemon=True,
        )
        self._stderr_thread = thread
        thread.start()

    def _drain_stderr(self, stream: Any) -> None:
        """持续读走 stderr（守护线程）：读到 EOF 即退出。

        线程是**守护线程**：即便异常残留也不挡进程退出。流由本线程自己关
        （别在 :meth:`close` 里抢着关：读线程正阻塞在读上，抢关会让内核把
        阻塞的读留在一个已复用的 fd 上）。
        """
        try:
            while True:
                chunk = self._read_stderr_chunk(stream)
                if not chunk:
                    break
                self._append_stderr_tail(chunk)
        except (OSError, ValueError):
            # 流被关掉（收尾路径）：正常退出
            pass
        except Exception:  # pragma: no cover - 读出错不影响主流程
            logger.debug(
                "字节泵 %s 的 stderr 排空线程异常退出", self.forward_id, exc_info=True
            )
        finally:
            try:
                stream.close()
            except OSError:
                pass

    @staticmethod
    def _read_stderr_chunk(stream: Any) -> bytes:
        """读一段 stderr。

        有 ``read1`` 就用它（**不等满缓冲**：``BufferedReader.read(n)`` 会等到
        n 字节或 EOF 才返回，尾部会迟到）；没有就退回 ``read``。
        """
        read1 = getattr(stream, "read1", None)
        if read1 is not None:
            return read1(STDERR_READ_CHUNK)
        return stream.read(STDERR_READ_CHUNK)

    def _append_stderr_tail(self, chunk: bytes) -> None:
        """把 stderr 片段并进尾部缓冲（只留最后 :data:`STDERR_TAIL_BYTES` 字节）。"""
        with self._stderr_lock:
            self._stderr_tail.extend(chunk)
            overflow = len(self._stderr_tail) - STDERR_TAIL_BYTES
            if overflow > 0:
                del self._stderr_tail[:overflow]

    @property
    def stderr_tail(self) -> str:
        """stderr 尾部（最后 8KB，解码后；非法字节用替代符）。

        **只给排查用**：里面有容器客户端原文与宿主绝对路径，调用方**只进日志**，
        不回显到客户端。
        """
        with self._stderr_lock:
            data = bytes(self._stderr_tail)
        return data.decode("utf-8", errors="replace")

    @property
    def stderr_drain_alive(self) -> bool:
        """stderr 排空线程是否还在跑（:meth:`close` 之后应当退出）。"""
        thread = self._stderr_thread
        return thread is not None and thread.is_alive()

    def _join_stderr_drain(self, timeout: float = 2.0) -> None:
        """等排空线程退出（最多 timeout 秒；没退出只告警，不挡收尾）。"""
        thread = self._stderr_thread
        if thread is None:
            return
        thread.join(timeout)
        if thread.is_alive():  # pragma: no cover - 进程赖着不退时的兜底
            logger.warning("字节泵 %s 的 stderr 排空线程未退出", self.forward_id)

    # ---------------------------------------------------------------- 读写
    def write(self, data: bytes) -> int:
        """往字节泵写字节，返回实际写入长度。"""
        if self._closed or self.process.stdin is None:
            return 0
        return self.process.stdin.write(data)

    def read(self, size: int = 65536) -> bytes:
        """从字节泵读字节；对端关闭后返回空字节。"""
        if self._closed or self.process.stdout is None:
            return b""
        chunk = self.process.stdout.read(size)
        return chunk or b""

    @property
    def alive(self) -> bool:
        """字节泵进程是否还在跑。"""
        return self.process.poll() is None

    def __enter__(self) -> BytePump:
        """上下文管理器入口（退出时自动回收进程）。"""
        return self

    def __exit__(self, *exc_info: object) -> None:
        """上下文管理器出口：异常也要回收进程。"""
        self.close()

    def close(self) -> None:
        """立即回收字节泵进程（连同整个进程组；幂等）。"""
        if self._closed:
            return
        self._closed = True
        for stream in (self.process.stdin, self.process.stdout):
            if stream is None:
                continue
            try:
                stream.close()
            except OSError:
                pass
        # stderr 由排空线程自己关（见 :meth:`_drain_stderr` 的说明）
        self._reap_process_group()
        self._join_stderr_drain()

    def _reap_process_group(self) -> None:
        """按进程组回收字节泵进程。

        进程组组长就是字节泵自己（``start_new_session=True``）：先给整组发
        SIGTERM（``sudo`` 前缀下的 docker 客户端与它拉起的孙进程一并收到），
        超时再整组 SIGKILL。拿不到独立进程组时退回只杀自己。
        """
        if self.process.poll() is not None:
            return
        pgid = self._pgid
        try:
            own_pgid = os.getpgid(0)
        except OSError:  # pragma: no cover - 取不到自身进程组
            own_pgid = None
        if pgid is None or pgid == own_pgid:
            # 没有独立进程组：绝不能按组杀（会连自己一起杀掉）
            self.process.terminate()
        else:
            self._signal_group(pgid, signal.SIGTERM)
        try:
            self.process.wait(timeout=3)
            return
        except subprocess.TimeoutExpired:
            pass
        if pgid is None or pgid == own_pgid:
            self.process.kill()
        else:
            self._signal_group(pgid, signal.SIGKILL)
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:  # pragma: no cover - 强杀后仍不退出
            logger.warning("字节泵进程 %s 未能退出", self.process.pid)

    @staticmethod
    def _signal_group(pgid: int, sig: int) -> None:
        """给进程组发信号（失败只记日志）。"""
        try:
            os.killpg(pgid, sig)
        except OSError as exc:
            logger.warning("终止字节泵进程组 %s 失败：%s", pgid, exc)


class SandboxRuntime(Protocol):
    """转发编排依赖的沙箱侧能力（由生命周期服务实现）。

    核心包内部用协议描述依赖方向：转发编排不认识界面层，也不直接碰宿主命令，
    只经沙箱的免 root 守护进程操作容器。

    **标签命名空间**：转发容器用 ``sandbox-platform.*``（连字符），既有沙箱容器
    用 ``sandbox.platform/*``（斜杠）——两套并存。枚举平台自建资源时两套都要看，
    只按一套枚举会漏掉另一套的容器。
    """

    def get(self, name: str) -> SandboxMetadata:
        """取沙箱元数据（不存在抛 ``NotFoundError``）。"""
        ...

    def daemon_for(self, name: str) -> UserDaemon:
        """取沙箱对应的守护进程操作入口。"""
        ...

    def list(self) -> list[SandboxMetadata]:
        """列出全部沙箱。"""
        ...


# ---------------------------------------------------------------- 记录仓库
class ForwardStore:
    """转发记录仓库：``<平台数据根>/forwards/<id>.json``。

    写入走**原子替换**（临时文件 + ``os.replace``），文件权限固定 0600。

    **单进程口径**：记录目录由单个服务实例独占。同一进程内的并发访问由
    :class:`PortForwardManager` 的锁串行化；**跨进程并发不在本期的假设范围内**
    （跨实例的遗留清理按 ``host_pid`` 判归属，见 :meth:`PortForwardManager.purge_leftover`）。
    """

    def __init__(self, config: PlatformConfig) -> None:
        self.config = config

    @property
    def root(self) -> Path:
        """转发记录根目录。"""
        return self.config.forward_root

    def path_for(self, forward_id: str) -> Path:
        """单条转发记录的文件路径。"""
        return self.root / f"{validate_forward_id(forward_id)}.json"

    def _ensure_root(self) -> Path:
        """准备记录目录（幂等；目录权限收紧到 0700）。"""
        root = self.root
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(root, 0o700)
        except OSError:  # pragma: no cover - 目录权限收紧失败不影响记录读写
            logger.warning("收紧转发记录目录权限失败：%s", root)
        return root

    def save(self, record: ForwardRecord) -> Path:
        """写入转发记录（原子替换，权限 0600）。"""
        validate_forward_id(record.id)
        directory = self._ensure_root()
        target = directory / f"{record.id}.json"
        payload = json.dumps(record.to_dict(), ensure_ascii=False, indent=2, sort_keys=True)
        handle = tempfile.NamedTemporaryFile(  # noqa: SIM115 - 临时文件需手动改权限后原子替换
            "w", encoding="utf-8", dir=directory, prefix=".forward-", suffix=".tmp", delete=False
        )
        try:
            with handle:
                handle.write(payload)
                handle.write("\n")
            os.chmod(handle.name, 0o600)
            os.replace(handle.name, target)
        except BaseException:
            Path(handle.name).unlink(missing_ok=True)
            raise
        return target

    def load(self, forward_id: str) -> ForwardRecord | None:
        """读取转发记录；不存在返回 ``None``，文件损坏抛 ``ValidationError``。"""
        path = self.path_for(forward_id)
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValidationError(f"转发记录文件损坏：{path}") from exc
        if not isinstance(data, dict):
            raise ValidationError(f"转发记录文件损坏：{path}")
        try:
            return ForwardRecord.from_dict(data)
        except ValidationError as exc:
            raise ValidationError(f"转发记录文件损坏：{path}（{exc}）") from exc

    def list_all(self) -> list[ForwardRecord]:
        """列出全部转发记录（损坏的文件跳过，不让一条坏记录拖垮整批）。

        跳过三种坏记录：JSON 解析失败、**内容不是 JSON 对象**（合法 JSON 但
        结构不对）、标识或端口非法。三种都只记告警，不抛异常。
        """
        if not self.root.is_dir():
            return []
        result: list[ForwardRecord] = []
        for path in sorted(self.root.glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as exc:
                logger.warning("跳过损坏的转发记录文件：%s（%s）", path, exc)
                continue
            if not isinstance(data, dict):
                logger.warning("跳过损坏的转发记录文件（内容不是 JSON 对象）：%s", path)
                continue
            try:
                record = ForwardRecord.from_dict(data)
            except (ValidationError, TypeError, ValueError) as exc:
                logger.warning("跳过损坏的转发记录文件：%s（%s）", path, exc)
                continue
            result.append(record)
        return result

    def list_for_sandbox(self, sandbox: str) -> list[ForwardRecord]:
        """列出某个沙箱的全部转发记录。"""
        return [record for record in self.list_all() if record.sandbox == sandbox]

    def find_by_sandbox_port(self, sandbox: str, container_port: int) -> ForwardRecord | None:
        """按「沙箱 + 容器端口」找记录（幂等建立的依据）。"""
        for record in self.list_all():
            if record.sandbox == sandbox and record.container_port == container_port:
                return record
        return None

    def delete(self, forward_id: str) -> bool:
        """删除转发记录；返回是否确实删掉了东西。"""
        path = self.path_for(forward_id)
        try:
            path.unlink()
        except FileNotFoundError:
            return False
        except OSError as exc:
            logger.error("删除转发记录失败：%s（%s）", path, exc)
            return False
        return True

    def record_files(self) -> list[Path]:
        """列出记录目录下的全部记录文件（含损坏的）。"""
        if not self.root.is_dir():
            return []
        return sorted(self.root.glob("*.json"))

    def temp_files(self) -> list[Path]:
        """列出写入过程残留的临时文件（``.forward-*.tmp``）。"""
        if not self.root.is_dir():
            return []
        return sorted(self.root.glob(".forward-*.tmp"))


# ---------------------------------------------------------------- 编排入口
class PortForwardManager:
    """端口转发编排入口。

    能力本体全在本类：转发容器起停、转发记录读写、生命周期联动与遗留清理。
    命令行与服务端都只是它的一层壳。
    """

    def __init__(
        self,
        config: PlatformConfig | None = None,
        privilege: Privilege | None = None,
        service: SandboxRuntime | None = None,
    ) -> None:
        self.config = config or PlatformConfig.from_env()
        self.privilege = privilege or Privilege()
        self.service = service
        self.store = ForwardStore(self.config)
        self.images = ImageManager(self.config, self.privilege)
        # 单进程假设：同一进程内的并发调用由这把锁串行化（跨进程并发不在本期
        # 假设范围内——平台数据根由单个服务实例独占）
        self._lock = threading.RLock()

    # ---------------------------------------------------------------- 命名与构造
    def container_name(self, sandbox: str, container_port: int) -> str:
        """转发容器名：``<沙箱名>-fwd-<容器端口>``。"""
        return self.config.forward_container_template.format(
            sandbox=sandbox, port=container_port
        )

    def container_labels(self, record: ForwardRecord) -> dict[str, str]:
        """转发容器的平台标签（枚举与回收用）。"""
        return {
            LABEL_FORWARD_ROLE: ROLE_FORWARD,
            LABEL_FORWARD_ID: record.id,
            LABEL_FORWARD_SANDBOX: record.sandbox,
        }

    def run_args(self, record: ForwardRecord, *, network: str) -> list[str]:
        """构造转发容器的启动参数（``docker run`` 子命令形式）。

        规格（ADR 0014 第 2 节，决策 C）：

        - **不发布任何端口**：参数里没有 ``-p`` / ``--publish``；
        - ``--restart=no``：生命周期由平台显式管理；
        - **显式覆盖 entrypoint**：转发镜像的 ENTRYPOINT 是 ``socat``，不覆盖
          就会把 socat 当成监听命令跑起来；覆盖后跑常驻空转命令
          （``sh -c 'exec tail -f /dev/null'``），容器**不监听**任何端口。
        """
        args = [
            "run",
            "-d",
            "--name",
            self.container_name(record.sandbox, record.container_port),
            "--network",
            network,
            f"--restart={FORWARD_RESTART_POLICY}",
        ]
        for key, value in self.container_labels(record).items():
            args.extend(["--label", f"{key}={value}"])
        args.extend(["--entrypoint", FORWARD_ENTRYPOINT])
        args.append(self.config.forward_image)
        args.extend(FORWARD_IDLE_COMMAND)
        return args

    def exec_command(self, record: ForwardRecord) -> list[str]:
        """构造字节泵的 exec 命令（完整命令行，首元素是 ``docker``）。

        形如 ``docker exec -i <转发容器> socat - TCP:<沙箱容器>:<端口>``：
        在沙箱的免 root 守护进程下执行，转发容器里的 ``socat`` 把字节桥到
        沙箱容器的目标端口。**宿主侧不监听任何端口**，这是本期唯一的字节通道。
        """
        metadata = self._sandbox_metadata(record.sandbox)
        return [
            "docker",
            "exec",
            "-i",
            self.container_name(record.sandbox, record.container_port),
            "socat",
            "-",
            f"TCP:{metadata.container_name}:{record.container_port}",
        ]

    # ---------------------------------------------------------------- 查询
    def find(self, forward_id: str) -> ForwardRecord | None:
        """取转发记录；不存在返回 ``None``。"""
        return self.store.load(forward_id)

    def get(self, forward_id: str) -> ForwardRecord:
        """取转发记录；不存在抛 :class:`NotFoundError`。"""
        record = self.store.load(forward_id)
        if record is None:
            raise NotFoundError(f"端口转发不存在：{forward_id}")
        return record

    def list(self, sandbox: str | None = None) -> list[ForwardRecord]:
        """列出转发记录（可按沙箱过滤）。"""
        records = self.store.list_all()
        if sandbox is None:
            return records
        return [record for record in records if record.sandbox == sandbox]

    # ---------------------------------------------------------------- 建立
    def create(self, sandbox: str, container_port: int) -> ForwardRecord:
        """建立端口转发（**幂等**）。

        同一沙箱同一容器端口已有转发时**复用既有记录与容器**，不重复起容器；
        记录在但容器缺失（沙箱停止过）时按记录幂等重建容器。

        并发保护：同一进程内的并发调用由管理器串行化（单进程假设）。
        """
        with self._lock:
            metadata = self._sandbox_metadata(sandbox)
            port = validate_container_port(container_port)
            daemon = self._daemon(sandbox)
            self._require_sandbox_running(metadata, daemon)

            existing = self.store.find_by_sandbox_port(sandbox, port)
            if existing is not None:
                self._ensure_container(metadata, existing, daemon)
                existing.state = FORWARD_STATE_RUNNING
                self._claim_ownership(existing)
                existing.touch()
                self.store.save(existing)
                return existing

            record = ForwardRecord(
                id=new_forward_id(),
                sandbox=sandbox,
                container_port=port,
                state=FORWARD_STATE_RUNNING,
                host_pid=os.getpid(),
            )
            self._ensure_container(metadata, record, daemon)
            self.store.save(record)
            return record

    def open_byte_pump(self, record: ForwardRecord) -> BytePump:
        """起一条字节泵（一条 TCP 连接一个 exec 进程）。

        隧道建立时调用：转发容器缺失则**幂等重建**（沙箱停止后不自动重建，
        隧道建立时才补上），随后在沙箱守护进程下起 exec 字节泵进程。
        连接断开时调用方必须 :meth:`BytePump.close` 立即回收该进程。
        """
        with self._lock:
            metadata = self._sandbox_metadata(record.sandbox)
            daemon = self._daemon(record.sandbox)
            self._require_sandbox_running(metadata, daemon)
            self._ensure_container(metadata, record, daemon)
            record.state = FORWARD_STATE_RUNNING
            self._claim_ownership(record)
            record.touch()
            self.store.save(record)
            process = daemon.spawn_stream(self.exec_command(record))
            return BytePump(process=process, forward_id=record.id)

    # ---------------------------------------------------------------- 停止与回收
    def stop(self, forward_id: str) -> ForwardOpResult:
        """停止转发：删转发容器 + 删记录。

        容器**删不掉就不删记录**：记录是转发容器唯一的收口凭据，先删记录
        会把容器留成没人认领的孤儿。
        """
        with self._lock:
            record = self.get(forward_id)
            removed: list[str] = []
            failed: list[str] = []
            name = self.container_name(record.sandbox, record.container_port)
            daemon = self._daemon_or_none(record.sandbox)
            gone = self._remove_forward_container(daemon, name, removed, failed)
            if gone:
                if self.store.delete(record.id):
                    removed.append(f"转发记录 {record.id}")
                else:
                    failed.append(f"转发记录 {record.id} 删除失败")
            else:
                failed.append(
                    f"转发记录 {record.id} 保留（转发容器未确认删除，稍后重试）"
                )
            return ForwardOpResult(removed=tuple(removed), failed=tuple(failed))

    def stop_for_sandbox(self, sandbox: str) -> ForwardOpResult:
        """沙箱停止联动：该沙箱的转发容器一并停止，**记录保留**。"""
        with self._lock:
            removed: list[str] = []
            failed: list[str] = []
            daemon = self._daemon_or_none(sandbox)
            for record in self.store.list_for_sandbox(sandbox):
                name = self.container_name(record.sandbox, record.container_port)
                if daemon is not None:
                    state = probe_container(daemon, name)
                    if state == PROBE_FAILED:
                        failed.append(f"转发容器 {name} 探测失败（沙箱守护进程不可达？）")
                    elif state == PROBE_EXISTS:
                        # docker kill：转发容器的 PID 1 是 busybox tail，不响应
                        # SIGTERM，docker stop 会白等 10 秒宽限期还占着容器名
                        result = daemon.kill_container(name)
                        if result.ok:
                            removed.append(f"转发容器 {name} 已停止")
                        else:
                            failed.append(f"转发容器 {name} 停止失败：{result.output.strip()}")
                record.state = FORWARD_STATE_STOPPED
                record.touch()
                try:
                    self.store.save(record)
                except (OSError, ValidationError) as exc:
                    failed.append(f"转发记录 {record.id} 保存失败：{exc}")
            return ForwardOpResult(removed=tuple(removed), failed=tuple(failed))

    def reclaim_for_sandbox(self, sandbox: str) -> ForwardOpResult:
        """沙箱删除联动：转发容器与转发记录一并回收（平台自建资源）。

        容器删不掉时**保留记录**并如实报进 ``failed``：记录是收口凭据，
        先删记录会把容器留成孤儿。
        """
        with self._lock:
            removed: list[str] = []
            failed: list[str] = []
            daemon = self._daemon_or_none(sandbox)
            for record in self.store.list_for_sandbox(sandbox):
                name = self.container_name(record.sandbox, record.container_port)
                gone = self._remove_forward_container(daemon, name, removed, failed)
                if gone:
                    if self.store.delete(record.id):
                        removed.append(f"转发记录 {record.id}")
                    else:
                        failed.append(f"转发记录 {record.id} 删除失败")
                else:
                    failed.append(
                        f"转发记录 {record.id} 保留（转发容器未确认删除，稍后重试）"
                    )
            return ForwardOpResult(removed=tuple(removed), failed=tuple(failed))

    def purge_leftover(self) -> ForwardOpResult:
        """清理上次遗留的转发容器与记录（服务重启时调用）。

        语义对齐终端会话的「服务重启即丢」：**全部转发会话不跨服务重启存活**。
        转发容器按平台标签枚举（各沙箱守护进程下），转发记录整目录清空。

        **跨实例保护**（同终端会话表 ``purge_leftover_sessions``）：记录里带着
        建它的服务进程号（``host_pid``）；属于**另一个仍活着的服务实例**的转发
        记录与对应容器**不动**——那个实例正在用这些转发，误清会打断别人的隧道。
        """
        with self._lock:
            removed: list[str] = []
            failed: list[str] = []

            records = self.store.list_all()
            protected_ids = {
                record.id for record in records if _owned_by_other_instance(record.host_pid)
            }

            for metadata in self._sandbox_list():
                daemon = self._daemon_or_none(metadata.name)
                if daemon is None:
                    continue
                for name in daemon.container_names_by_label(
                    f"{LABEL_FORWARD_ROLE}={ROLE_FORWARD}"
                ):
                    labels = daemon.container_labels(name)
                    if labels.get(LABEL_FORWARD_ID) in protected_ids:
                        logger.info(
                            "转发容器 %s 属于另一个仍在运行的服务实例，跳过清理", name
                        )
                        continue
                    result = daemon.remove_container(name)
                    if result.ok:
                        removed.append(f"转发容器 {name}")
                    else:
                        failed.append(f"转发容器 {name} 删除失败：{result.output.strip()}")

            for path in self.store.record_files():
                if path.stem in protected_ids:
                    logger.info(
                        "转发记录 %s 属于另一个仍在运行的服务实例，跳过清理", path.stem
                    )
                    continue
                try:
                    path.unlink()
                except OSError as exc:
                    failed.append(f"转发记录 {path.stem} 删除失败：{exc}")
                    continue
                removed.append(f"转发记录 {path.stem}")

            # 写入过程残留的临时文件（进程被强杀时可能留下）：一并清掉
            for path in self.store.temp_files():
                try:
                    path.unlink()
                except OSError as exc:  # pragma: no cover - 残留文件删除失败不影响清理
                    failed.append(f"转发临时文件 {path.name} 删除失败：{exc}")
                    continue
                removed.append(f"转发临时文件 {path.name}")

            return ForwardOpResult(removed=tuple(removed), failed=tuple(failed))

    # ---------------------------------------------------------------- 内部辅助
    def _claim_ownership(self, record: ForwardRecord) -> None:
        """记录归属：建它的服务实例（进程号）。

        归属进程还活着就不是本实例的——不抢（抢了会让别人的清理把本实例在用的
        转发删掉）；归属进程没了（服务重启过）才由本实例接管。
        """
        if _owned_by_other_instance(record.host_pid):
            return
        record.host_pid = os.getpid()

    def _remove_forward_container(
        self,
        daemon: UserDaemon | None,
        name: str,
        removed: list[str],
        failed: list[str],
    ) -> bool:
        """删转发容器；返回**是否确认已删掉**。

        删不掉（或探测失败、没法确认）时返回 ``False``：调用方据此**保留记录**。
        """
        if daemon is None:
            # 沙箱（连同它的守护进程）已经不在了：容器随之消失
            return True
        state = probe_container(daemon, name)
        if state == PROBE_FAILED:
            failed.append(f"转发容器 {name} 探测失败（沙箱守护进程不可达？），不确认已删除")
            return False
        if state == PROBE_MISSING:
            return True
        # docker rm -f：转发容器的 PID 1 是 busybox tail，不响应 SIGTERM，
        # docker stop 会白等 10 秒宽限期还占着容器名，直接强删
        result = daemon.remove_container(name)
        if result.ok:
            removed.append(f"转发容器 {name}")
            return True
        failed.append(f"转发容器 {name} 删除失败：{result.output.strip()}")
        return False

    def _sandbox_metadata(self, sandbox: str) -> SandboxMetadata:
        """取沙箱元数据（沙箱不存在抛 :class:`NotFoundError`）。"""
        if self.service is None:
            raise ForwardError("转发编排未装配沙箱侧能力，无法访问沙箱")
        return self.service.get(sandbox)

    def _daemon(self, sandbox: str) -> UserDaemon:
        """取沙箱对应的守护进程操作入口。"""
        if self.service is None:
            raise ForwardError("转发编排未装配沙箱侧能力，无法访问沙箱")
        return self.service.daemon_for(sandbox)

    def _daemon_or_none(self, sandbox: str) -> UserDaemon | None:
        """取守护进程入口；沙箱已不存在（或未装配）时返回 ``None``。"""
        try:
            return self._daemon(sandbox)
        except (NotFoundError, ForwardError):
            return None

    def _sandbox_list(self) -> list[SandboxMetadata]:
        """列出沙箱（未装配沙箱侧能力时返回空列表）。"""
        if self.service is None:
            return []
        try:
            return self.service.list()
        except SandboxError as exc:
            logger.warning("枚举沙箱失败（跳过转发容器清理）：%s", exc)
            return []

    def _require_sandbox_running(
        self, metadata: SandboxMetadata, daemon: UserDaemon
    ) -> None:
        """要求沙箱容器在跑：沙箱已停止时转发链路不成立。"""
        try:
            running = daemon.container_running(metadata.container_name)
        except Exception as exc:  # pragma: no cover - 宿主命令异常（超时等）
            raise ForwardError(
                f"探测沙箱容器状态失败：{metadata.container_name}（{exc}）"
            ) from exc
        if not running:
            raise ForwardError(
                f"沙箱已停止，无法建立端口转发：{metadata.name}"
                "（请先启动沙箱）"
            )

    def _ensure_container(
        self, metadata: SandboxMetadata, record: ForwardRecord, daemon: UserDaemon
    ) -> None:
        """确保转发容器存在且在跑（幂等重建）。

        同名容器的处置口径：

        - 标签里的转发标识与记录一致 → 就是本条转发的容器，必要时拉起来；
        - 标签里的转发标识对不上，但带 ``sandbox-platform.role=forward``
          （**平台自建**）→ 上次中断留下的遗留容器，删掉重建（Docker 不允许
          改容器标签，标签必须与记录一致）；
        - **不带平台标签** → 是用户自己在沙箱守护进程下建的同名容器，
          **平台不删**：抛 :class:`ForwardError`（容器名冲突）。
        """
        name = self.container_name(record.sandbox, record.container_port)
        state = probe_container(daemon, name)
        if state == PROBE_FAILED:
            raise ForwardError(f"探测转发容器 {name} 失败（沙箱守护进程不可达？）")
        if state == PROBE_EXISTS:
            labels = daemon.container_labels(name)
            if labels.get(LABEL_FORWARD_ID) == record.id:
                if daemon.container_running(name):
                    return
                result = daemon.start_container(name)
                if not result.ok:
                    raise ForwardError(
                        f"启动转发容器失败：{name}（{result.output.strip()}）"
                    )
                return
            if labels.get(LABEL_FORWARD_ROLE) == ROLE_FORWARD:
                logger.info("转发容器 %s 的转发标识与记录不一致，按遗留处理并重建", name)
                result = daemon.remove_container(name)
                if not result.ok:
                    raise ForwardError(
                        f"删除遗留转发容器失败：{name}（{result.output.strip()}）"
                    )
            else:
                raise ForwardError(
                    f"容器名 {name} 已被占用：与现有非平台容器重名"
                    "（该容器不是平台自建的转发容器，平台不会删除它）；"
                    "请换一个沙箱或端口，或自行处理同名容器"
                )
        self._start_container(metadata, record, daemon)

    def _start_container(
        self, metadata: SandboxMetadata, record: ForwardRecord, daemon: UserDaemon
    ) -> None:
        """起转发容器（镜像经统一镜像代理在沙箱守护进程内拉取）。"""
        image = self.config.forward_image
        self.images.ensure_image(image, daemon)
        network = metadata.network_name
        if not daemon.network_exists(network):
            raise ForwardError(
                f"沙箱 {record.sandbox} 的网络不存在，无法建立端口转发：{network}"
            )
        result = daemon.docker(
            self.run_args(record, network=network), check=False, timeout=600
        )
        if not result.ok:
            raise ForwardError(f"启动转发容器失败：{result.output.strip()}")
