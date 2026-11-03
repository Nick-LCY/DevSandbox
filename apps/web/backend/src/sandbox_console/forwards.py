"""端口转发的服务端装配：转发编排接入、活动隧道登记与字节泵搬运。

服务端只做**编排与转译**，能力本体在核心包（``sandbox_platform.forwarding``）：
转发容器的起停、转发记录的读写、字节泵进程的执行与回收全在核心包里。
本模块只管三件事：

- **接入转发编排入口**：生命周期服务已持有那一个管理器实例（不另建）；
- **登记活动隧道**：服务退出时统一关掉（对应的字节泵进程一并回收）；
- **搬运字节**：WebSocket 的二进制帧 ⇄ 字节泵的 stdin/stdout。

**后端宿主零端口**：转发链路的字节通道只有一条——核心包在沙箱守护进程下起的
exec 字节泵。后端宿主既不发布转发端口，也不监听转发端口（用户机本机的监听
端口由桌面端持有，不进平台记录）。

**取舍说明（背压与并发）**：字节泵的读写是**阻塞式**的（裸管道），所以搬字节
一律放到线程里做，事件循环不参与阻塞 I/O。本期按**简单串行泵**实现：一条
隧道两个方向各一个搬运任务，任一侧结束就取消另一侧并收泵。字节泵的 I/O 走
**专用线程池**（见 :data:`PUMP_IO_EXECUTOR`），不与事件循环的默认执行器抢线程。
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from sandbox_platform import BytePump
from starlette.websockets import WebSocket

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------- 关闭码
# 正常关闭（任一侧 EOF 或断开后，服务端把另一侧也收掉）
TUNNEL_CLOSE_NORMAL = 1000
# 服务退出兜底：服务端主动关掉活动隧道（客户端据此重连）
TUNNEL_CLOSE_SHUTDOWN = 1001
# 策略违规：转发不存在 / 已停止 / 鉴权未过
TUNNEL_CLOSE_POLICY = 1008
# 字节泵异常结束（exec 失败：失败原因只在 stderr 里，客户端拿到的是原因帧）
TUNNEL_CLOSE_PUMP_ERROR = 1011

# ---------------------------------------------------------------- 字节泵搬运
# 单次读取的字节数（一次 syscall 拿多少算多少，不等满）
READ_CHUNK = 65536

# 字节泵异常结束时给客户端的**固定文案**（exec 的失败原因只在 stderr 里，
# 原文只进日志，不回显给客户端）
PUMP_FAILED_MESSAGE = "字节泵异常结束（转发链路执行失败），详见服务日志"

# ---------------------------------------------------------------- 字节泵 I/O 线程池
# 字节泵的读写是**阻塞式**的（裸管道），必须放到线程里做。
#
# **为什么不用默认执行器**：``asyncio.to_thread`` 与框架的同步路由共用事件循环的
# 默认执行器（容量只有十几个）：并发隧道一多，读写互相等线程（**饿死**），
# 而 REST 接口（同一默认池）也会被拖慢。这里给字节泵 I/O 建**独立**的线程池。
#
# 取舍：池容量显式给到 32（一条隧道最多占 2 个线程：读 + 写）；超过这个规模的
# 并发连接会排队等待（而不是把别的接口饿死）。REST 接口**不受影响**（走自己的池）。
PUMP_IO_WORKERS = 32
PUMP_IO_EXECUTOR = ThreadPoolExecutor(
    max_workers=PUMP_IO_WORKERS,
    thread_name_prefix="sandbox-pump-io",
)


async def pump_read(pump: BytePump, size: int = READ_CHUNK) -> bytes:
    """在**字节泵专用线程池**里读字节（阻塞读不进事件循环）。

    空字节 = 字节泵那头关了（EOF）。
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(PUMP_IO_EXECUTOR, pump.read, size)


async def pump_write(pump: BytePump, data: bytes) -> int:
    """在**字节泵专用线程池**里把字节写进字节泵（阻塞写不进事件循环）。

    返回实际写入的字节数（小于入参说明字节泵写不动了）。
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(PUMP_IO_EXECUTOR, write_all_bytes, pump, data)


def pump_stderr_tail(pump: BytePump) -> str:
    """取字节泵的 stderr 尾部（最后 8KB；取不到就是空串）。

    **只进日志**：stderr 里有容器客户端原文与宿主绝对路径，不回显给客户端。
    """
    getter = getattr(pump, "stderr_tail", None)
    if getter is None:
        return ""
    try:
        return str(getter)
    except Exception:  # pragma: no cover - 取尾部失败不影响收尾
        return ""


async def pump_failure_reason(pump: BytePump, *, wait_seconds: float = 0.5) -> str:
    """字节泵是不是**异常结束**（exec 失败）：是则返回原因（stderr 尾部）。

    **等一小会儿**再取尾部：stderr 排空线程与 stdout 的 EOF 几乎同时发生，
    立刻取可能拿到**空尾部**（原因帧就丢了）。等待**不阻塞事件循环**，
    且只在排空线程还活着时才等（正常收尾的隧道不受影响）。

    返回值**只进日志**：里面有容器客户端原文与宿主绝对路径。
    """
    tail = pump_stderr_tail(pump)
    if not tail and getattr(pump, "stderr_drain_alive", False):
        deadline = time.monotonic() + wait_seconds
        while time.monotonic() < deadline:
            await asyncio.sleep(0.01)
            tail = pump_stderr_tail(pump)
            if tail or not getattr(pump, "stderr_drain_alive", False):
                break
    code = _pump_exit_code(pump)
    if code is not None:
        return tail if code != 0 else ""
    return tail if tail.strip() else ""


def _pump_exit_code(pump: BytePump) -> int | None:
    """取字节泵进程的退出码（还没退出就是 ``None``；取不到也是 ``None``）。"""
    process = getattr(pump, "process", None)
    if process is None:
        return None
    try:
        return process.poll()
    except Exception:  # pragma: no cover - 取退出码失败不影响收尾
        return None


def write_all_bytes(pump: BytePump, data: bytes) -> int:
    """把字节全部写进字节泵的 stdin，返回实际写入的字节数。

    字节泵的写入走**裸管道**：一次写不完整是常态（管道缓冲满了就少写），
    必须循环到写完为止。返回 0 表示字节泵已经关了（写入侧该收敛了）。
    """
    total = 0
    while total < len(data):
        written = pump.write(data[total:])
        if written <= 0:
            break
        total += written
    return total


# ---------------------------------------------------------------- 隧道登记
@dataclass
class TunnelHandle:
    """一条活动隧道的句柄（登记在 :class:`TunnelRegistry` 里）。

    ``pump`` 是核心包的字节泵句柄：连接断开时必须 :meth:`BytePump.close`
    立即回收对应的 exec 进程（按进程组回收，不留僵尸进程）。

    ``accepted`` 为 ``False`` 表示**服务正在退出**：登记表已经关过一轮，这条
    隧道不再被接纳（连接已被按 1001 关掉，字节泵照常回收）。
    """

    tunnel_id: str
    forward_id: str
    websocket: WebSocket
    pump: BytePump
    closed: bool = field(default=False)
    accepted: bool = field(default=True)

    def close_pump(self) -> None:
        """回收字节泵进程（幂等；失败只记日志，不阻断收尾）。"""
        if self.closed:
            return
        self.closed = True
        try:
            self.pump.close()
        except Exception as exc:  # pragma: no cover - 收尾失败不影响服务
            logger.warning(
                "回收转发 %s 的字节泵进程失败：%s", self.forward_id, exc, exc_info=True
            )


class TunnelRegistry:
    """活动隧道登记表。

    **同一个转发可以有多条并发隧道**（一条 WebSocket 对一条 TCP 连接），
    所以登记表的键是**隧道标识**，不是转发标识。

    登记表是线程安全的：登记发生在事件循环线程，关闭发生在生命周期钩子
    （同为事件循环线程），但读接口可能被后台线程用到。

    **「正在关闭」标志**：服务退出时 :meth:`close_all` 会置上标志。此后
    再来连接（登记与关闭之间的竞态窗口）**立即按 1001 关掉**，字节泵照常
    回收——不留一条既没被登记、也没被关掉的野隧道。
    """

    def __init__(self) -> None:
        self._tunnels: dict[str, TunnelHandle] = {}
        self._lock = threading.Lock()
        self._counter = 0
        self._closing = False

    @property
    def closing(self) -> bool:
        """登记表是否已进入「正在关闭」状态。"""
        with self._lock:
            return self._closing

    async def register(
        self, forward_id: str, websocket: WebSocket, pump: BytePump
    ) -> TunnelHandle:
        """登记一条活动隧道，返回它的句柄。

        **服务正在退出时**（:meth:`close_all` 已跑过）：连接立即按 1001 关掉，
        字节泵照常回收，返回的句柄 ``accepted`` 为 ``False``（调用方据此
        收敛，不再往这条连接上发帧）。
        """
        with self._lock:
            self._counter += 1
            tunnel_id = f"tun-{self._counter:06d}"
            handle = TunnelHandle(
                tunnel_id=tunnel_id,
                forward_id=forward_id,
                websocket=websocket,
                pump=pump,
            )
            if self._closing:
                handle.accepted = False
            else:
                self._tunnels[tunnel_id] = handle
                logger.info("已登记转发隧道：%s（转发 %s）", tunnel_id, forward_id)
        if not handle.accepted:
            # 服务正在退出：这条隧道不再接纳（连接按 1001 关掉，泵照常回收）
            handle.close_pump()
            logger.info("服务正在退出，拒绝新转发隧道：%s（转发 %s）", tunnel_id, forward_id)
            try:
                await websocket.close(code=TUNNEL_CLOSE_SHUTDOWN)
            except Exception as exc:  # pragma: no cover - 连接已断时忽略
                logger.debug(
                    "断开转发隧道 %s 失败（连接多半已断）：%s", tunnel_id, exc
                )
        return handle

    def unregister(self, handle: TunnelHandle) -> None:
        """把一条隧道从登记表里摘掉（连接结束时的收尾）。"""
        with self._lock:
            self._tunnels.pop(handle.tunnel_id, None)

    @property
    def count(self) -> int:
        """当前活动隧道数。"""
        with self._lock:
            return len(self._tunnels)

    async def close_all(self) -> None:
        """关掉全部活动隧道：回收字节泵进程 + 断开连接。

        服务退出时调用：隧道不跨服务重启存活（与终端会话「服务重启即丢」
        同款语义）。字节泵进程在这里一并回收，不留僵尸 exec 进程。

        顺带置上「正在关闭」标志：**之后**再来的连接立即被拒（按 1001 关掉），
        不留竞态窗口里的野隧道。
        """
        with self._lock:
            self._closing = True
            handles = list(self._tunnels.values())
            self._tunnels.clear()
        for handle in handles:
            handle.close_pump()
            try:
                await handle.websocket.close(code=TUNNEL_CLOSE_SHUTDOWN)
            except Exception as exc:  # pragma: no cover - 连接已断时忽略
                logger.debug(
                    "断开转发隧道 %s 失败（连接多半已断）：%s", handle.tunnel_id, exc
                )
        if handles:
            logger.info("已关闭活动转发隧道：%d 条", len(handles))
