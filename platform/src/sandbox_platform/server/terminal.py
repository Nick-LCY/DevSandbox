"""终端会话管理：伪终端承载、输出环形缓冲与断线重连。

一个终端会话 = 容器内一个带真实 TTY 的交互式进程 + 宿主侧一个伪终端。
浏览器断开时进程不退出，输出继续写进环形缓冲；重连同一会话标识时先回放缓冲
再接实时流，终端现场不丢。

会话的宿主侧资源（伪终端、容器内进程）活在服务进程内存里，伪终端本身由核心包
的伪终端入口分配；本模块只做编排：起会话、收字节、喂缓冲、登记会话表。
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import select
import threading
from collections.abc import Callable
from dataclasses import dataclass

from sandbox_platform import (
    PlatformConfig,
    PtyProcess,
    SandboxService,
    ValidationError,
)
from sandbox_platform.metadata import utc_now
from starlette.concurrency import run_in_threadpool

from .sessions import (
    SESSION_STATE_EXITED,
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
# 待发输入的上限（字节）：容器内进程不读时不让缓冲无限涨
MAX_PENDING_INPUT = 1024 * 1024
# 唤醒管道：写入侧通知 I/O 线程有活干（管道满时忽略，不阻塞调用方）
WAKE_TOKEN = b"\x01"


def new_session_id() -> str:
    """生成会话标识（十六进制随机串，可直接当文件名用）。"""
    return secrets.token_hex(8)


@dataclass(frozen=True)
class TerminalSpawnRequest:
    """起一个终端会话所需的宿主侧信息。"""

    session_id: str
    sandbox_name: str
    container_name: str
    system_user: str
    cols: int
    rows: int


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
    ) -> None:
        self.record = record
        self.pty = pty
        self._loop = loop
        self._table = table
        self._ring_size = ring_size
        self._ring = bytearray()
        self._streams: list[TerminalStream] = []
        self._write_buffer = bytearray()
        self._seq = 0
        self._lock = threading.RLock()
        self._stop = threading.Event()
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
            queue.put_nowait(None)
        return stream, snapshot

    def close_stream(self, stream: TerminalStream) -> None:
        """注销一个输出流（浏览器断开时调用）。"""
        with self._lock:
            if stream in self._streams:
                self._streams.remove(stream)

    # ---------------------------------------------------------------- 输入
    def write(self, data: bytes) -> None:
        """把浏览器送来的输入字节塞进伪终端。"""
        if not data or self.exited:
            return
        with self._lock:
            self._write_buffer.extend(data)
            overflow = 0
            if len(self._write_buffer) > MAX_PENDING_INPUT:
                overflow = len(self._write_buffer) - MAX_PENDING_INPUT
                del self._write_buffer[:overflow]
        if overflow:
            logger.warning(
                "终端会话 %s 的待发输入超过上限，丢弃 %d 字节", self.session_id, overflow
            )
        self._wake()

    def resize(self, cols: int, rows: int) -> None:
        """同步窗口大小到伪终端（容器内 TTY 随之更新）。"""
        try:
            self.pty.resize(cols, rows)
        except OSError as exc:
            logger.debug("同步终端会话 %s 的窗口大小失败：%s", self.session_id, exc)
            return
        self.record.cols = cols
        self.record.rows = rows

    # ---------------------------------------------------------------- 附着
    def attach(self) -> None:
        """登记一次附着（连接数加一，落盘）。"""
        with self._lock:
            self.record.attached_count += 1
            self.record.last_attached_at = utc_now()
        self._table.save(self.record)

    def detach(self) -> None:
        """登记一次断开（连接数减一，落盘）。"""
        with self._lock:
            self.record.attached_count = max(0, self.record.attached_count - 1)
        self._table.save(self.record)

    def close(self) -> None:
        """关闭会话：终止容器内进程并回收伪终端。"""
        self._stop.set()
        self._wake()
        self.pty.terminate()
        self.pty.close()
        self._thread.join(timeout=2)

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
                    if not data:
                        break
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

    def _read_output(self) -> bytes:
        """读一段容器内输出。"""
        try:
            return self.pty.read(READ_CHUNK)
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
        for stream in streams:
            try:
                self._loop.call_soon_threadsafe(self._deliver, stream, seq, data)
            except RuntimeError:
                # 事件循环已关闭（服务正在退出）：实时流无处可投，缓冲仍在
                logger.debug("终端会话 %s 的事件循环已关闭，实时输出不再投递", self.session_id)
                return

    def _deliver(self, stream: TerminalStream, seq: int, data: bytes) -> None:
        """投递一块实时输出（跑在事件循环线程上）。"""
        if seq <= stream.start_seq:
            # 已经在回放快照里，不重复投递
            return
        try:
            stream.queue.put_nowait(data)
        except asyncio.QueueFull:
            # 浏览器消费不过来：丢最旧的一块，保证最新输出还能到达
            try:
                stream.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                stream.queue.put_nowait(data)
            except asyncio.QueueFull:  # pragma: no cover - 队列刚腾出一格
                pass

    def _flush_output(self, fd: int) -> None:
        """把待发输入写进伪终端。"""
        with self._lock:
            if not self._write_buffer:
                return
            chunk = bytes(self._write_buffer[:READ_CHUNK])
        try:
            written = os.write(fd, chunk)
        except OSError:
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

    def _mark_exited(self, code: int | None) -> None:
        """标记会话已退出（跑在事件循环线程上），并落盘。"""
        with self._lock:
            if self.record.state == SESSION_STATE_EXITED:
                return
            exit_code = code if code is not None else self.pty.poll()
            self.record.state = SESSION_STATE_EXITED
            self.record.exit_code = exit_code if exit_code is not None else -1
            self.record.attached_count = 0
            streams = list(self._streams)
        try:
            self._table.save(self.record)
        except Exception as exc:  # pragma: no cover - 落盘失败不影响会话收尾
            logger.error("落盘终端会话退出状态失败：%s（%s）", self.session_id, exc)
        for stream in streams:
            try:
                stream.queue.put_nowait(None)
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
    ) -> None:
        self.config = config
        self.service = service
        self.table = TerminalSessionTable(config)
        self.ring_size = ring_size
        self._spawner = spawner or self._spawn
        self._sessions: dict[str, TerminalSession] = {}
        self._lock = threading.Lock()

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
        """
        loop = asyncio.get_running_loop()
        metadata = await run_in_threadpool(self.service.get, sandbox_name)
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
            record, pty, loop, self.table, ring_size=self.ring_size
        )
        with self._lock:
            self._sessions[record.session_id] = session
        try:
            self.table.save(record)
        except Exception:
            session.close()
            with self._lock:
                self._sessions.pop(record.session_id, None)
            raise
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
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            session.close()

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
