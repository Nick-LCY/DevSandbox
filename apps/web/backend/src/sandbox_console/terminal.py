"""终端会话管理：伪终端承载、输出环形缓冲与断线重连。

一个终端会话 = 容器内一个带真实 TTY 的交互式进程 + 宿主侧一个伪终端。
浏览器断开时进程不退出，输出继续写进环形缓冲；重连同一会话标识时先回放缓冲
再接实时流，终端现场不丢。

会话的宿主侧资源（伪终端、容器内进程）活在服务进程内存里，伪终端本身由核心包
的伪终端入口分配；本模块只做编排：起会话、收字节、喂缓冲、登记会话表。

两条贯穿全局的约束：

- **写侧永不阻塞**：伪终端主端是非阻塞的，I/O 线程只在「可写事件」里写，写不
  进去就留着字节下次再写。阻塞式写入会造出双向死锁——用户粘贴大文本时写入侧
  卡住不再读输出，输出写满后容器内的 shell 卡在写 stdout，两边互等。
- **落盘走合并写**：会话表的写入集中在后台线程，窗口大小抖动这类高频变更在
  合并窗口内只写一次，事件循环线程不做文件 I/O。
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import secrets
import select
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from sandbox_platform import (
    PlatformConfig,
    PtyProcess,
    SandboxService,
    ValidationError,
)
from sandbox_platform.metadata import utc_now
from starlette.concurrency import run_in_threadpool

from .sessions import (
    SESSION_EXIT_REASON_CLOSED_BY_USER,
    SESSION_EXIT_REASON_EXITED,
    SESSION_EXIT_REASON_RECLAIMED,
    SESSION_EXIT_REASON_SHUTDOWN,
    SESSION_STATE_EXITED,
    SESSION_STATE_RUNNING,
    TerminalSessionRecord,
    TerminalSessionTable,
    new_session_record,
)

logger = logging.getLogger(__name__)

# 默认窗口大小
DEFAULT_COLS = 80
DEFAULT_ROWS = 24
# 输出环形缓冲上限（字节）：断线期间最多保留这么多输出，重连时回放
DEFAULT_RING_SIZE = 256 * 1024
# 单个浏览器连接的实时队列上限（块）
DEFAULT_QUEUE_SIZE = 128
# 单次读取的字节数
READ_CHUNK = 65536
# 单次写入伪终端的字节上限：写太多会长时间占住 I/O 线程，也让「可写事件」更细
WRITE_CHUNK = 4096
# 待发输入的上限（字节）：容器内进程不读时不让缓冲无限涨
MAX_PENDING_INPUT = 1024 * 1024
# 唤醒管道：写入侧通知 I/O 线程有活干（管道满时忽略，不阻塞调用方）
WAKE_TOKEN = b"\x01"

# 回放快照的单帧上限（字节）：一帧太长会被中间代理截断
SNAPSHOT_CHUNK = 64 * 1024

# ---------------------------------------------------------------- 会话数量与回收
# 全部会话的总数上限
DEFAULT_MAX_SESSIONS = 20
# 单个沙箱的会话数上限
DEFAULT_MAX_SESSIONS_PER_SANDBOX = 5
# 无附着会话的空闲回收时长（秒）
DEFAULT_IDLE_TIMEOUT = 30 * 60
# 空闲回收的巡检间隔（秒）
DEFAULT_IDLE_SWEEP_INTERVAL = 30
# 落盘合并窗口（秒）：窗口内的多次变更合并成一次落盘
SAVE_DEBOUNCE = 0.5

# 上限与回收时长的环境变量（可覆盖默认值）
ENV_MAX_SESSIONS = "SANDBOX_TERMINAL_MAX_SESSIONS"
ENV_MAX_SESSIONS_PER_SANDBOX = "SANDBOX_TERMINAL_MAX_SESSIONS_PER_SANDBOX"
ENV_IDLE_TIMEOUT = "SANDBOX_TERMINAL_IDLE_TIMEOUT"

# ---------------------------------------------------------------- 帧类型
# 输出字节
FRAME_DATA = "data"
# 提示帧（例：输入被截断）
FRAME_ERROR = "error"
# 结束标记（容器内进程已退出）
FRAME_EXIT = "exit"


def new_session_id() -> str:
    """生成会话标识（十六进制随机串，可直接当文件名用）。"""
    return secrets.token_hex(8)


# 会话标识的格式：16 位十六进制（``secrets.token_hex(8)`` 的输出）。
# 路由据此挡掉非法标识：非法值一律按「会话不存在」处理，错误消息里也不回显
# 用户输入，避免把任意文本塞进响应与日志。
SESSION_ID_PATTERN = re.compile(r"^[0-9a-f]{16}$")


def is_valid_session_id(session_id: str) -> bool:
    """会话标识是否是合法的十六进制串。"""
    return bool(SESSION_ID_PATTERN.fullmatch(session_id))


def _env_int(name: str, default: int) -> int:
    """读一个正整数环境变量；缺省或非法时用默认值。"""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        logger.warning("环境变量 %s 取值非法（%r），改用默认值 %d", name, raw, default)
        return default
    if value <= 0:
        logger.warning("环境变量 %s 取值非法（%r），改用默认值 %d", name, raw, default)
        return default
    return value


@dataclass(frozen=True)
class TerminalSpawnRequest:
    """起一个终端会话所需的宿主侧信息。"""

    session_id: str
    sandbox_name: str
    container_name: str
    system_user: str
    cols: int
    rows: int


@dataclass(frozen=True)
class TerminalFrame:
    """往浏览器推的一帧。

    帧类型显式化，服务端才能在输出字节之外夹带提示（例：输入被截断）。
    """

    kind: str
    payload: bytes = b""
    message: str = ""


@dataclass(frozen=True)
class TerminalSessionRemoval:
    """一次会话移除的结果。"""

    session_id: str
    # 移除前的会话状态（running / exited）
    state: str
    # 关闭流程是否走完（false = 记录已删，但关闭流程未走完）
    closed: bool
    # 会话记录文件是否确实删掉了
    removed: bool


class TerminalStream:
    """一个浏览器连接对应的输出流。"""

    def __init__(self, queue: asyncio.Queue, start_seq: int) -> None:
        self.queue = queue
        # 回放快照已经覆盖到哪一块：序号不大于它的实时块不再重复投递
        self.start_seq = start_seq


class TerminalSession:
    """一个终端会话：容器内进程 + 宿主侧伪终端 + 输出缓冲。

    一个会话一个独立的容器内进程与伪终端：同一沙箱开多个终端时互不影响，
    一个会话的输入不会串到另一个会话。
    """

    def __init__(
        self,
        record: TerminalSessionRecord,
        pty: PtyProcess,
        loop: asyncio.AbstractEventLoop,
        table: TerminalSessionTable,
        *,
        ring_size: int = DEFAULT_RING_SIZE,
        mark_dirty: Callable[..., None] | None = None,
        container_cleanup: Callable[[], None] | None = None,
    ) -> None:
        self.record = record
        self.pty = pty
        self._loop = loop
        self._table = table
        self._ring_size = ring_size
        self._mark_dirty_cb = mark_dirty
        self._container_cleanup = container_cleanup
        self._streams: list[TerminalStream] = []
        self._ring = bytearray()
        self._write_buffer = bytearray()
        self._seq = 0
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._closed = False
        self._wake_r, self._wake_w = os.pipe()
        os.set_blocking(self._wake_w, False)
        self._thread = threading.Thread(
            target=self._io_loop,
            name=f"terminal-io-{record.session_id}",
            daemon=True,
        )
        self._thread.start()

    # ---------------------------------------------------------------- 状态
    @property
    def session_id(self) -> str:
        """会话标识。"""
        return self.record.session_id

    @property
    def state(self) -> str:
        """会话状态（运行中 / 已退出）。"""
        return self.record.state

    @property
    def exit_code(self) -> int | None:
        """容器内进程的退出码（未退出为空）。"""
        return self.record.exit_code

    @property
    def exit_reason(self) -> str | None:
        """会话结束的原因（未结束为空，见 SESSION_EXIT_REASON_* 常量）。"""
        return self.record.exit_reason

    @property
    def exited(self) -> bool:
        """容器内进程是否已退出。"""
        return self.record.state == SESSION_STATE_EXITED

    # ---------------------------------------------------------------- 输出流
    def open_stream(self) -> tuple[TerminalStream, bytes]:
        """登记一个输出流，并取回当前缓冲快照。

        登记与取快照在同一把锁内完成：输出要么落在快照里，要么走实时流，
        不会重复也不会漏。
        """
        queue: asyncio.Queue = asyncio.Queue(maxsize=DEFAULT_QUEUE_SIZE)
        with self._lock:
            stream = TerminalStream(queue, self._seq)
            self._streams.append(stream)
            snapshot = bytes(self._ring)
            exited = self.record.state == SESSION_STATE_EXITED
        if exited:
            queue.put_nowait(TerminalFrame(kind=FRAME_EXIT))
        return stream, snapshot

    def close_stream(self, stream: TerminalStream) -> None:
        """注销一个输出流（浏览器断开时调用）。"""
        with self._lock:
            if stream in self._streams:
                self._streams.remove(stream)

    # ---------------------------------------------------------------- 输入
    def write(self, data: bytes) -> None:
        """把浏览器送来的输入字节塞进伪终端。

        待发输入超过上限时**丢最新的字节**（保最旧的）：开头的内容通常是命令
        主体，把刚粘进来的尾巴丢掉比把开头丢掉更让人困惑。截断时给客户端发一
        条提示帧，让用户知道粘贴被截了。
        """
        if not data or self.exited:
            return
        dropped = 0
        with self._lock:
            room = MAX_PENDING_INPUT - len(self._write_buffer)
            if room <= 0:
                dropped = len(data)
                data = b""
            elif len(data) > room:
                dropped = len(data) - room
                data = data[:room]
            if data:
                self._write_buffer.extend(data)
        if dropped:
            logger.warning(
                "终端会话 %s 的待发输入超过上限，丢弃最新的 %d 字节",
                self.session_id,
                dropped,
            )
            self._publish_error(
                f"待发输入超过 {MAX_PENDING_INPUT // 1024} KiB 上限，"
                f"最新的 {dropped} 字节已被截断"
            )
        self._wake()

    def resize(self, cols: int, rows: int) -> None:
        """同步窗口大小到伪终端（容器内 TTY 随之更新）。"""
        try:
            self.pty.resize(cols, rows)
        except OSError as exc:
            logger.debug("同步终端会话 %s 的窗口大小失败：%s", self.session_id, exc)
            return
        with self._lock:
            self.record.cols = cols
            self.record.rows = rows
        # 窗口大小也落盘：浏览器拖窗口会连发 resize，合并窗口内只写一次
        self._mark_dirty(immediate=False)

    # ---------------------------------------------------------------- 附着
    def attach(self) -> None:
        """登记一次附着（连接数加一，落盘）。"""
        with self._lock:
            self.record.attached_count += 1
            self.record.last_attached_at = utc_now()
        self._mark_dirty()

    def detach(self) -> None:
        """登记一次断开（连接数减一，落盘）。"""
        with self._lock:
            self.record.attached_count = max(0, self.record.attached_count - 1)
        self._mark_dirty()

    def close(self, reason: str) -> None:
        """关闭会话：终止容器内进程并回收伪终端。

        ``reason`` 是结束原因（见 ``SESSION_EXIT_REASON_*`` 常量），**必填**：
        每次关闭都得说清是为什么关的，状态机才闭合。只有本次调用**真的把一个
        运行中的会话关掉**时才写进记录——已经退出的会话不覆盖既有原因
        （容器内进程自己退出的会话，原因保持 ``exited``）。

        关闭流程分两段：

        - **先发结束标记**：容器内清理可能要跑几十秒，发在前面能让浏览器立刻
          知道会话没了，不必等清理结束（发帧与清理耗时解耦）。
        - **再收现场**：终止宿主侧伪终端、按会话标识清掉容器内残留进程、回收
          伪终端文件描述符。某一步出错不阻断其余步骤，但异常会在最后抛给
          调用方，由调用方如实回报（记录照删，状态回报「关闭流程未走完」）。

        会话本来就是已退出的：不重复终止进程（进程早没了），仍走一次收尾——
        回收伪终端文件描述符，并顺带清一次容器内可能残留的进程树。
        """
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self.record.attached_count = 0
            # 会话原本还在跑：关掉它算一次「被关闭」，要给附着的浏览器发结束标记
            was_running = self.record.state != SESSION_STATE_EXITED
            if was_running:
                self.record.state = SESSION_STATE_EXITED
                if self.record.exit_code is None:
                    self.record.exit_code = -1
                # 结束原因只在「本次真的关掉了运行中的会话」时写：已退出的会话
                # 保留既有原因（如容器内进程自己退出 = exited）
                self.record.exit_reason = reason
            streams = list(self._streams)
        if was_running:
            # 还连着的浏览器必须知道会话没了：走既有的退出帧路径，它们据此
            # 收到结束标记并断开，而不是一直挂着等超时
            self._notify_exit(streams)
        self._stop.set()
        self._wake()
        failure: Exception | None = None
        if was_running:
            # 会话还在跑才终止宿主侧伪终端（已退出的不重复终止）
            failure = self._run_close_step("终止伪终端", self._terminate_pty)
        # 宿主侧的 exec 客户端退出**不会**带走容器内的 shell：按会话标识在容器内
        # 把残留进程收掉，否则服务重启后容器里会堆积无主 shell
        if self._container_cleanup is not None:
            cleanup_failure = self._run_close_step("容器内进程清理", self._container_cleanup)
            failure = failure or cleanup_failure
        reclaim_failure = self._run_close_step("伪终端回收", self._reclaim_pty)
        failure = failure or reclaim_failure
        dirty_failure = self._run_close_step("终态落盘", self._mark_dirty)
        failure = failure or dirty_failure
        if failure is not None:
            raise failure

    def _run_close_step(self, name: str, step: Callable[[], None]) -> Exception | None:
        """跑一步收尾动作；失败只记日志并返回异常（不阻断其余步骤）。"""
        try:
            step()
        except Exception as exc:
            logger.warning(
                "关闭终端会话 %s 的%s失败：%s",
                self.session_id,
                name,
                exc,
                exc_info=True,
            )
            return exc
        return None

    def _terminate_pty(self) -> None:
        """终止宿主侧的伪终端进程。"""
        self.pty.terminate()

    def _reclaim_pty(self) -> None:
        """回收伪终端：I/O 线程退出后再关主端文件描述符。

        先关会让线程里的读写打到可能已被复用的文件描述符上。
        """
        self._thread.join(timeout=5)
        self.pty.close()

    # ---------------------------------------------------------------- I/O 线程
    def _io_loop(self) -> None:
        """伪终端 I/O 线程：读输出、写入待发输入。"""
        fd = self.pty.master_fd
        try:
            while not self._stop.is_set():
                pending = self._pending_size() > 0
                readers = [fd, self._wake_r]
                writers = [fd] if pending else []
                try:
                    readable, writable, _ = select.select(readers, writers, [], 0.5)
                except (OSError, ValueError):
                    break
                if self._wake_r in readable:
                    self._drain_wake()
                if fd in readable:
                    data = self._read_output()
                    if data is None:
                        # 可读事件里没数据（主端非阻塞，可能被别的线程抢走）
                        pass
                    elif not data:
                        # 容器内进程结束
                        break
                    else:
                        self._publish(data)
                if pending and fd in writable:
                    self._flush_output(fd)
        except Exception:  # pragma: no cover - I/O 线程兜底，不让线程静默死掉
            logger.exception("终端会话 %s 的 I/O 线程异常退出", self.session_id)
        finally:
            code = self.pty.wait(timeout=5)
            try:
                self._loop.call_soon_threadsafe(self._mark_exited, code)
            except RuntimeError:
                logger.debug("终端会话 %s 的事件循环已关闭，退出状态不再投递", self.session_id)
            self._close_wake()

    def _read_output(self) -> bytes | None:
        """读一段容器内输出。

        返回 ``None`` 表示「可读事件里没数据」；返回空字节表示进程已经结束。
        """
        try:
            return self.pty.read(READ_CHUNK)
        except BlockingIOError:
            # 主端非阻塞：暂时没数据，等下一次可读事件
            return None
        except OSError as exc:
            logger.debug("读取终端会话 %s 的输出失败：%s", self.session_id, exc)
            return b""

    def _publish(self, data: bytes) -> None:
        """把输出写进环形缓冲，并投递给各浏览器连接。"""
        with self._lock:
            self._seq += 1
            seq = self._seq
            self._ring.extend(data)
            if len(self._ring) > self._ring_size:
                del self._ring[: len(self._ring) - self._ring_size]
            streams = list(self._streams)
        frame = TerminalFrame(kind=FRAME_DATA, payload=data)
        for stream in streams:
            try:
                self._loop.call_soon_threadsafe(self._deliver, stream, seq, frame)
            except RuntimeError:
                # 事件循环已关闭（服务正在退出）：实时流无处可投，缓冲仍在
                logger.debug("终端会话 %s 的事件循环已关闭，实时输出不再投递", self.session_id)
                return

    def _publish_error(self, message: str) -> None:
        """给所有浏览器连接发一条提示帧。"""
        with self._lock:
            streams = list(self._streams)
        frame = TerminalFrame(kind=FRAME_ERROR, message=message)
        for stream in streams:
            try:
                self._loop.call_soon_threadsafe(self._deliver, stream, 0, frame)
            except RuntimeError:
                return

    def _notify_exit(self, streams: list[TerminalStream]) -> None:
        """给还连着的浏览器推结束标记。

        关闭一个正在运行的会话时，附着的连接必须知道「会话没了」：结束标记
        走的是与进程自然退出同一条路径，浏览器据此收尾并断开。
        """
        frame = TerminalFrame(kind=FRAME_EXIT)
        for stream in streams:
            try:
                self._loop.call_soon_threadsafe(self._deliver, stream, 0, frame)
            except RuntimeError:
                # 事件循环已关闭（服务正在退出）：没有连接可通知了
                return

    def _deliver(self, stream: TerminalStream, seq: int, frame: TerminalFrame) -> None:
        """投递一帧（跑在事件循环线程上）。"""
        if frame.kind == FRAME_DATA and seq <= stream.start_seq:
            # 已经在回放快照里，不重复投递
            return
        try:
            stream.queue.put_nowait(frame)
        except asyncio.QueueFull:
            # 浏览器消费不过来：丢最旧的一块，保证最新输出还能到达
            try:
                stream.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                stream.queue.put_nowait(frame)
            except asyncio.QueueFull:  # pragma: no cover - 队列刚腾出一格
                pass

    def _flush_output(self, fd: int) -> None:
        """把待发输入写进伪终端。

        主端是非阻塞的：内核缓冲满时一个字节都写不进去（``BlockingIOError``），
        此时保留全部待写字节，等下一个「可写事件」再试。这里绝不能阻塞——
        阻塞会把 I/O 线程卡死，输出也就没人读了（双向死锁）。
        """
        with self._lock:
            if not self._write_buffer:
                return
            chunk = bytes(self._write_buffer[:WRITE_CHUNK])
        try:
            written = os.write(fd, chunk)
        except BlockingIOError:
            # 缓冲满：待写字节原样留着，等下一次可写事件
            return
        except OSError as exc:
            logger.debug("写入终端会话 %s 的输入失败：%s", self.session_id, exc)
            return
        with self._lock:
            del self._write_buffer[:written]

    def _pending_size(self) -> int:
        """待发输入的字节数。"""
        with self._lock:
            return len(self._write_buffer)

    def _wake(self) -> None:
        """唤醒 I/O 线程。"""
        try:
            os.write(self._wake_w, WAKE_TOKEN)
        except OSError:
            pass

    def _drain_wake(self) -> None:
        """清空唤醒管道里的令牌。"""
        try:
            os.read(self._wake_r, 4096)
        except OSError:
            pass

    def _close_wake(self) -> None:
        """回收唤醒管道。"""
        for fd in (self._wake_r, self._wake_w):
            try:
                os.close(fd)
            except OSError:
                pass

    def _mark_dirty(self, *, immediate: bool = True) -> None:
        """把会话记录交给落盘合并队列。"""
        if self._mark_dirty_cb is None:
            return
        self._mark_dirty_cb(self.record, immediate=immediate)

    def _mark_exited(self, code: int | None) -> None:
        """标记会话已退出（跑在事件循环线程上），并落盘。"""
        with self._lock:
            if self.record.state == SESSION_STATE_EXITED:
                return
            exit_code = code if code is not None else self.pty.poll()
            self.record.state = SESSION_STATE_EXITED
            self.record.exit_code = exit_code if exit_code is not None else -1
            # 容器内进程自己退出：与「被人为关掉」区分开，客户端据此提示正常结束
            self.record.exit_reason = SESSION_EXIT_REASON_EXITED
            self.record.attached_count = 0
            streams = list(self._streams)
        self._mark_dirty()
        for stream in streams:
            try:
                stream.queue.put_nowait(TerminalFrame(kind=FRAME_EXIT))
            except asyncio.QueueFull:  # pragma: no cover - 队列满时结束标记可能丢
                logger.warning("终端会话 %s 的输出队列已满，结束标记可能丢失", self.session_id)


class TerminalSessionManager:
    """终端会话管理器：会话生命周期与伪终端承载。"""

    def __init__(
        self,
        config: PlatformConfig,
        service: SandboxService,
        spawner: Callable[[TerminalSpawnRequest], PtyProcess] | None = None,
        *,
        ring_size: int = DEFAULT_RING_SIZE,
        max_sessions: int | None = None,
        max_sessions_per_sandbox: int | None = None,
        idle_timeout: int | None = None,
    ) -> None:
        self.config = config
        self.service = service
        self.table = TerminalSessionTable(config)
        self.ring_size = ring_size
        self.max_sessions = (
            max_sessions
            if max_sessions is not None
            else _env_int(ENV_MAX_SESSIONS, DEFAULT_MAX_SESSIONS)
        )
        self.max_sessions_per_sandbox = (
            max_sessions_per_sandbox
            if max_sessions_per_sandbox is not None
            else _env_int(ENV_MAX_SESSIONS_PER_SANDBOX, DEFAULT_MAX_SESSIONS_PER_SANDBOX)
        )
        self.idle_timeout = (
            idle_timeout
            if idle_timeout is not None
            else _env_int(ENV_IDLE_TIMEOUT, DEFAULT_IDLE_TIMEOUT)
        )
        self._spawner = spawner or self._spawn
        self._sessions: dict[str, TerminalSession] = {}
        self._lock = threading.Lock()
        # 落盘合并：立即写的一桶 + 合并窗口内写的一桶
        self._pending_now: dict[str, TerminalSessionRecord] = {}
        self._pending_later: dict[str, TerminalSessionRecord] = {}
        # 会话表的锁：落盘队列、墓碑集合与文件读写共用一把锁。
        # 删除与落盘必须串行，否则删掉的记录会被晚到的落盘写回磁盘。
        self._store_lock = threading.Lock()
        # 被手动移除的会话：这些会话的记录不再落盘（关闭流程与退出回调的落盘
        # 都会晚到，不挡住就会把删掉的记录写回来）
        self._removed: set[str] = set()
        self._save_event = threading.Event()
        self._stop = threading.Event()
        self._flusher: threading.Thread | None = None
        self._reaper: threading.Thread | None = None

    # ---------------------------------------------------------------- 会话
    async def create(
        self,
        sandbox_name: str,
        *,
        cols: int = DEFAULT_COLS,
        rows: int = DEFAULT_ROWS,
    ) -> TerminalSession:
        """新建一个终端会话。

        沙箱不存在 / 未运行 / 容器已被删除时直接失败，不产生空会话。
        会话数超过上限（全局或单沙箱）时直接失败，不产生空会话。
        """
        loop = asyncio.get_running_loop()
        metadata = await run_in_threadpool(self.service.get, sandbox_name)
        # 先回收空闲会话，给新会话腾位置
        await run_in_threadpool(self.reap_idle_sessions)
        self._check_capacity(metadata.name)
        request = TerminalSpawnRequest(
            session_id=new_session_id(),
            sandbox_name=metadata.name,
            container_name=metadata.container_name,
            system_user=metadata.system_user,
            cols=cols,
            rows=rows,
        )
        pty = await run_in_threadpool(self._spawner, request)
        record = new_session_record(
            session_id=request.session_id,
            sandbox_name=request.sandbox_name,
            container_name=request.container_name,
            system_user=request.system_user,
            pid=pty.pid,
            cols=cols,
            rows=rows,
        )
        session = TerminalSession(
            record,
            pty,
            loop,
            self.table,
            ring_size=self.ring_size,
            mark_dirty=self._mark_dirty,
            container_cleanup=lambda: self._kill_container_session(record),
        )
        with self._lock:
            self._sessions[record.session_id] = session
        try:
            await run_in_threadpool(self._save_record, record)
        except Exception:
            try:
                # 回滚路径：会话记录没落盘、用户没碰过它，属系统级收尾
                #（与「服务退出兜底」同一类原因）
                session.close(SESSION_EXIT_REASON_SHUTDOWN)
            except Exception as exc:  # pragma: no cover - 收尾失败不影响原始错误
                logger.warning("回滚新建的终端会话 %s 时出错：%s", record.session_id, exc)
            with self._lock:
                self._sessions.pop(record.session_id, None)
            raise
        self._ensure_background()
        logger.info(
            "已创建终端会话：%s（沙箱 %s，容器 %s，进程号 %s）",
            record.session_id,
            record.sandbox_name,
            record.container_name,
            record.pid,
        )
        return session

    def get(self, session_id: str) -> TerminalSession | None:
        """取会话；不存在返回 ``None``（服务重启后旧标识一律取不到）。"""
        with self._lock:
            return self._sessions.get(session_id)

    def list_records(self, sandbox_name: str | None = None) -> list[TerminalSessionRecord]:
        """列出会话记录；给了沙箱名则只列该沙箱的会话。"""
        with self._lock:
            records = [session.record for session in self._sessions.values()]
        if sandbox_name:
            records = [item for item in records if item.sandbox_name == sandbox_name]
        return sorted(records, key=lambda item: (item.created_at, item.session_id))

    def close_all(self) -> None:
        """关闭全部会话（进程退出时兜底）。"""
        self._stop.set()
        self._save_event.set()
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        if sessions:
            # 并行收尾：每个会话都要跑一次容器内清理，串行会把退出拖得很长
            with ThreadPoolExecutor(max_workers=min(8, len(sessions))) as pool:
                for session in sessions:
                    pool.submit(self._close_quietly, session)
        for thread in (self._flusher, self._reaper):
            if thread is not None and thread.is_alive():
                thread.join(timeout=2)

    def _close_quietly(self, session: TerminalSession) -> None:
        """关掉一个会话并把异常吃掉（退出兜底路径不让异常冒到线程池外）。"""
        try:
            # 服务退出兜底：不是用户主动关的
            session.close(SESSION_EXIT_REASON_SHUTDOWN)
        except Exception as exc:  # pragma: no cover - 退出兜底路径
            logger.warning(
                "关闭终端会话 %s 时出错：%s", session.session_id, exc, exc_info=True
            )

    def remove_session(self, session_id: str) -> TerminalSessionRemoval | None:
        """移除一个终端会话。

        运行中的会话先走完整关闭流程（终止宿主伪终端、按会话标识收掉容器内
        残留进程、状态落盘），再删掉会话记录；已退出的会话不重复终止进程，
        但仍走一次收尾（回收伪终端文件描述符、顺带清一次容器内可能残留的
        进程树），再删记录。两种情况都会把会话从内存里摘掉。

        关闭流程中途出错时**照样删记录**：记录留着会让用户以为没删掉。异常
        记日志，``closed`` 回报 ``False``（记录已删，但关闭流程未走完）。

        会话不存在返回 ``None``（路由据此回 404）。
        """
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session is None:
            return None
        state = session.state
        closed = False
        try:
            # DELETE 路由路径：用户主动关掉这个会话
            session.close(SESSION_EXIT_REASON_CLOSED_BY_USER)
            closed = True
        except Exception as exc:
            logger.warning(
                "关闭终端会话 %s 时出错（会话记录照删）：%s",
                session_id,
                exc,
                exc_info=True,
            )
        finally:
            # 记录必须删掉：否则会话还会出现在列表里，用户看着像没删掉
            removed = self._forget_record(session_id)
        return TerminalSessionRemoval(
            session_id=session_id,
            state=state,
            closed=closed,
            removed=removed,
        )

    # ---------------------------------------------------------------- 上限与回收
    def _check_capacity(self, sandbox_name: str) -> None:
        """会话数超限时直接失败。

        已退出的会话也占名额（它们不做自动清理），提示必须指向清理入口，
        否则用户只看到「已达上限」却不知道去哪儿腾位置。
        """
        with self._lock:
            sessions = list(self._sessions.values())
        if len(sessions) >= self.max_sessions:
            exited = sum(1 for item in sessions if item.exited)
            raise ValidationError(self._capacity_message(self.max_sessions, exited))
        in_sandbox = [item for item in sessions if item.record.sandbox_name == sandbox_name]
        if len(in_sandbox) >= self.max_sessions_per_sandbox:
            exited = sum(1 for item in in_sandbox if item.exited)
            raise ValidationError(
                self._capacity_message(self.max_sessions_per_sandbox, exited, sandbox_name)
            )

    @staticmethod
    def _capacity_message(limit: int, exited: int, sandbox_name: str | None = None) -> str:
        """会话数超限的中文提示（带已退出的会话数与清理入口）。"""
        scope = f"沙箱 {sandbox_name} 的" if sandbox_name else ""
        if exited > 0:
            return (
                f"{scope}终端会话数已达上限（{limit} 个，其中 {exited} 个已退出待清理），"
                f"请先在『后端保留的会话』列表中移除已退出的会话"
            )
        return (
            f"{scope}终端会话数已达上限（{limit} 个），"
            f"请先在『后端保留的会话』列表中移除不用的会话"
        )

    def reap_idle_sessions(self, *, now: datetime | None = None) -> list[str]:
        """回收无附着且空闲超时的会话，返回被回收的会话标识。

        只回收**运行中**的会话：已退出的会话不留任何现场（进程已死），保留
        下来给用户自己删，不做自动清理。

        回收走正常关闭流程：终止进程、收掉容器内残留进程、会话表更新为已退出。
        """
        moment = now or datetime.now(UTC)
        with self._lock:
            sessions = list(self._sessions.values())
        reaped: list[str] = []
        for session in sessions:
            if session.record.attached_count > 0:
                continue
            if session.record.state != SESSION_STATE_RUNNING:
                # 已退出的会话不纳入回收
                continue
            idle = _idle_seconds(session.record.last_attached_at, moment)
            if idle < self.idle_timeout:
                continue
            reaped.append(session.session_id)
            self._close_session(session.session_id)
        if reaped:
            logger.info("已回收空闲终端会话：%s", "、".join(reaped))
        return reaped

    def _close_session(self, session_id: str) -> None:
        """关掉一个会话并从会话表里摘掉。"""
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session is None:
            return
        try:
            # 空闲回收：没有人主动关，是平台自己收走的
            session.close(SESSION_EXIT_REASON_RECLAIMED)
        except Exception as exc:
            # 回收路径的异常不往上抛：否则一次失败的回收会连带新建会话失败
            logger.warning(
                "关闭空闲终端会话 %s 时出错：%s", session_id, exc, exc_info=True
            )

    # ---------------------------------------------------------------- 后台线程
    def _ensure_background(self) -> None:
        """确保后台线程已启动（落盘合并 + 空闲回收）。"""
        with self._lock:
            if self._flusher is None or not self._flusher.is_alive():
                self._flusher = threading.Thread(
                    target=self._flush_loop, name="terminal-flush", daemon=True
                )
                self._flusher.start()
            if self._reaper is None or not self._reaper.is_alive():
                self._reaper = threading.Thread(
                    target=self._reap_loop, name="terminal-reap", daemon=True
                )
                self._reaper.start()

    def _flush_loop(self) -> None:
        """落盘线程：把会话记录的变更写进会话表。"""
        while not self._stop.is_set():
            self._save_event.wait(timeout=0.5)
            if self._stop.is_set():
                break
            self._save_event.clear()
            self._flush_pending(self._pending_now)
            if self._pending_later:
                # 合并窗口：窗口内的连续变更（窗口大小抖动）合并成一次落盘
                time.sleep(SAVE_DEBOUNCE)
                self._save_event.clear()
                self._flush_pending(self._pending_later)
        # 退出前把待写的写完
        self._flush_pending(self._pending_now)
        self._flush_pending(self._pending_later)

    def _flush_pending(self, bucket: dict[str, TerminalSessionRecord]) -> None:
        """把一桶待写记录落盘（写失败只记日志）。"""
        with self._store_lock:
            if not bucket:
                return
            records = list(bucket.values())
            bucket.clear()
            for record in records:
                if record.session_id in self._removed:
                    # 已被手动移除：不再落盘（否则删掉的记录会被写回来）
                    logger.debug("终端会话 %s 已被移除，跳过落盘", record.session_id)
                    continue
                try:
                    self.table.save(record)
                except Exception as exc:  # pragma: no cover - 落盘失败不影响会话
                    logger.error("落盘终端会话 %s 失败：%s", record.session_id, exc)

    def _mark_dirty(self, record: TerminalSessionRecord, *, immediate: bool = True) -> None:
        """把会话记录挂到落盘队列。

        ``immediate=False`` 走合并窗口：高频变更（窗口大小）不会每次都写文件。
        """
        with self._store_lock:
            if record.session_id in self._removed:
                # 已被手动移除：不再落盘
                logger.debug("终端会话 %s 已被移除，跳过落盘", record.session_id)
                return
            bucket = self._pending_now if immediate else self._pending_later
            bucket[record.session_id] = record
        self._save_event.set()

    def _save_record(self, record: TerminalSessionRecord) -> Path:
        """落盘一条会话记录（与落盘队列串行，避免与删除撞车）。"""
        with self._store_lock:
            return self.table.save(record)

    def _forget_record(self, session_id: str) -> bool:
        """把会话记录从落盘队列里摘掉并删掉记录文件。

        关闭流程与退出回调都会触发落盘，而且落盘是异步的（后台合并写）：
        不摘干净的话，用户刚删掉的记录会被晚到的落盘写回磁盘。
        """
        with self._store_lock:
            self._removed.add(session_id)
            self._pending_now.pop(session_id, None)
            self._pending_later.pop(session_id, None)
            return self.table.delete(session_id)

    def _reap_loop(self) -> None:
        """空闲回收线程：定期回收无附着且空闲超时的会话。"""
        interval = max(1.0, min(float(DEFAULT_IDLE_SWEEP_INTERVAL), self.idle_timeout / 4))
        while not self._stop.wait(interval):
            try:
                self.reap_idle_sessions()
            except Exception:  # pragma: no cover - 巡检失败不影响服务
                logger.exception("回收空闲终端会话失败")

    # ---------------------------------------------------------------- 起会话
    def _spawn(self, request: TerminalSpawnRequest) -> PtyProcess:
        """默认起会话方式：容器内开一个带真实 TTY 的交互式 shell。

        执行身份、环境变量与权限构造复用核心包的既有入口，服务层不自己拼命令。
        """
        daemon = self.service.daemon_for(request.sandbox_name)
        if not daemon.container_exists(request.container_name):
            raise ValidationError(
                f"沙箱容器不存在，无法创建终端会话：{request.sandbox_name}"
            )
        if not daemon.container_running(request.container_name):
            raise ValidationError(f"沙箱未运行，无法创建终端会话：{request.sandbox_name}")
        shell = daemon.container_shell(request.container_name)
        return daemon.exec_pty_shell(
            request.container_name,
            session_id=request.session_id,
            cols=request.cols,
            rows=request.rows,
            shell=shell,
        )

    def _kill_container_session(self, record: TerminalSessionRecord) -> None:
        """按会话标识收掉容器内残留的进程。"""
        try:
            daemon = self.service.daemon_for(record.sandbox_name)
        except Exception as exc:
            logger.info(
                "沙箱 %s 已不可用，跳过容器内会话清理：%s", record.sandbox_name, exc
            )
            return
        daemon.kill_container_session(record.container_name, record.session_id)


def _idle_seconds(last_attached_at: str, now: datetime) -> float:
    """会话距上次附着的空闲秒数；时间戳坏了按 0 算（不当成空闲）。"""
    try:
        moment = datetime.fromisoformat(last_attached_at)
    except (TypeError, ValueError):
        return 0.0
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return (now - moment).total_seconds()
