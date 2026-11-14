"""运行期文件传输的服务端装配：流式搬运、请求体桥接与专用线程池。

服务端只做**编排与转译**，能力本体在核心包（``sandbox_platform.transfer``）：
路径校验、上传（临时名 + ``mv`` 原子覆盖）、分层探测、下载字节泵、目录列表
全在核心包里。本模块只管四件事：

- **字节搬运走专用线程池**（:data:`TRANSFER_IO_EXECUTOR`）：容器的字节泵读写是
  **阻塞式**的（裸管道），必须放到线程里做，**不进事件循环**；
- **请求体桥接**（:class:`RequestBodyBridge`）：把 ASGI 的**异步** body 流桥接成
  核心包要的**同步**字节块迭代器（上传用），且**有界缓冲**（内存有界）；
- **下载流迭代**（:func:`iter_download_chunks`）：把核心包的 ``DownloadStream``
  逐块读出来喂给 ``StreamingResponse``，并**按声明长度裁剪**（实际流超出探测值
  时截断，避免响应体长度与 ``Content-Length`` 冲突触发协议层错误）；
- **期望字节数的取用**（:func:`parse_expected_bytes`）：从请求头 ``Content-Length``
  取上传的**期望字节数**，交给核心包在容器内 ``mv`` **之前**核对（**有头才核对**，
  **非法头直接 400**——见下）。

**上传端点必须 raw 流式读 body**（ADR 0018 第 5 节的硬前提）：FastAPI 的
JSON body 会被**整体缓冲进内存**——实测 200 MiB body 让控制台进程 RSS 从
**44.5 MiB 涨到 433.9 MiB**。因此本模块**不使用** ``request.body()``，只消费
``request.stream()`` 的分块；「内存有界」只在字节泵层成立，端到端成立的前提
就是这条 raw 流式读。

**期望字节数（``Content-Length``）的口径**：客户端给了 ``Content-Length`` ⇒
服务端把它当**期望字节数**传给核心包（``expected_bytes``），核心包在容器内
``mv`` **之前**核对临时文件的实际字节数——**不符就不 ``mv``**（目标路径原样
不动，旧内容不被半截内容覆盖），失败归类成 ``size_mismatch`` ⇒ **400**。
**头缺失**（chunked 传输）⇒ **不核对**（``expected_bytes=None``），此时客户端
中断仍**可能在目标路径留下半截文件**（残余风险，核心包文档与 ``API.md``
16.2 都写明了）。**头非法**（不是数字 / 负数 / 空串 / 超长数字串）⇒ **直接
400**、**不静默降级成「没有期望值」**——静默降级等于把调用方声明的长度悄悄
丢掉、字节数核对静默失效。

**服务端字节计数兜底（双保险的第二道保险）**：容器内那道 ``wc -c`` 核对在真机
中断场景下**会丢信号**（失败路径先 ``pump.close()`` 再读 stderr 尾部，容器
客户端被杀时标记一并丢了 ⇒ 核心包只能归 ``write_failed`` / ``exec_failed`` ⇒
500）。所以服务端自己数「核心包实际取走的字节数」：**取走的字节数少于期望值**
⇒ 直接归 ``size_mismatch``（400，固定文案「上传中断，目标文件未完整写入」），
**不依赖 stderr 标记**（见 :func:`_translate_upload_failure`）。

**专用线程池的取舍**（对齐转发轮的 ``PUMP_IO_EXECUTOR`` 惯例）：字节搬运是
阻塞式的，若与事件循环的默认执行器共用，并发传输一多就互相等线程（**饿死**，
默认池只有十几个），REST 接口也会被拖慢。这里给传输 I/O 建**独立**的线程池：
容量显式给到 32（一条传输最多占 1~2 个线程：读 / 写），超过这个规模的并发
传输会排队等待（而不是把别的接口饿死）。**REST 接口不受影响**（走自己的池）。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import queue
import threading
from collections.abc import AsyncIterator, Iterable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from fastapi import HTTPException
from sandbox_platform import (
    MSG_SIZE_MISMATCH,
    REASON_EXEC_FAILED,
    REASON_SIZE_MISMATCH,
    REASON_WRITE_FAILED,
    DownloadStream,
    FileTransferManager,
    TransferError,
)

from .errors import (
    INVALID_CONTENT_LENGTH_MESSAGE,
    INVALID_CONTENT_LENGTH_TOO_LONG_MESSAGE,
    STATUS_BAD_REQUEST,
    single_line,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------- 传输 I/O 线程池
# 传输的字节搬运是**阻塞式**的（裸管道读 / 写、exec 探测），必须放到线程里做，
# **不进事件循环**。
#
# **为什么不用默认执行器**：``asyncio.to_thread`` 与框架的同步路由共用事件循环的
# 默认执行器（容量只有十几个）：并发传输一多，读写互相等线程（**饿死**），
# 而 REST 接口（同一默认池）也会被拖慢。这里给传输 I/O 建**独立**的线程池。
#
# 取舍：池容量显式给到 32（一条传输最多占 2 个线程：读 + 写）；超过这个规模的
# 并发传输会排队等待（而不是把别的接口饿死）。REST 接口**不受影响**。
TRANSFER_IO_WORKERS = 32
TRANSFER_IO_EXECUTOR = ThreadPoolExecutor(
    max_workers=TRANSFER_IO_WORKERS,
    thread_name_prefix="sandbox-transfer-io",
)

# ---------------------------------------------------------------- 搬运参数
#: 下载时单次从字节泵读取的字节数（一次 syscall 拿多少算多少，不等满）
TRANSFER_CHUNK = 65536
#: 请求体桥接的在途缓冲块数（**有界**：N × 单块大小 = 在途字节上限）
BODY_BRIDGE_CHUNKS = 4
#: 请求体桥接里「队列满时」的轮询间隔（秒）
BODY_BRIDGE_POLL_INTERVAL = 0.005
#: 请求体桥接里「等下一块」的轮询间隔（秒）
BODY_BRIDGE_WAIT_INTERVAL = 0.05
#: ``Content-Length`` 的**十进制位数上限**（超过直接 400）
#:
#: **为什么要限位**：``int()`` 对超过 ``sys.int_info.str_digits_check_threshold``
#: （CPython 3.12 默认 **4300** 位）的数字串抛 ``ValueError``——不拦住就是
#: **500**（未预期异常 ⇒ 固定文案，调用方看不出是「头非法」）。两道闸：
#: **长度预判**（本常量）+ ``try/except ValueError`` 兜底。
#:
#: **20 位够用**：上限约 1 EiB（10^18 字节），远超任何真实文件；再长就是
#: 明显异常（探测 / 构造的畸形头）。
MAX_CONTENT_LENGTH_DIGITS = 20
#: 「上传被中断」的失败分类码集合（服务端字节计数兜底用）
#:
#: 这两个分类码是核心包在**没拿到更精确证据**时的兜底归类（「写入中断」/
#: 「容器内命令执行失败」）——**它们不说明「为什么失败」**，所以服务端可以用
#: 自己的字节计数补一个更准的结论（见 :func:`_translate_upload_failure`）。
INTERRUPTION_REASONS = frozenset({REASON_WRITE_FAILED, REASON_EXEC_FAILED})


# ---------------------------------------------------------------- 请求体桥接
class RequestBodyBridge:
    """把 ASGI 的**异步** body 流桥接成**同步**字节块迭代器（上传用）。

    **为什么要桥接**：核心包的上传编排是**同步**的（要往字节泵的裸管道写，
    写是阻塞的），而 ASGI 的请求体是**异步**分块来的。两边模型不同，中间要
    有一层桥。

    **有界缓冲**（内存有界的关键）：最多缓存 :data:`BODY_BRIDGE_CHUNKS` 块；
    消费侧（核心包）不取走，异步侧就不继续读 body ⇒ **端到端内存不随文件
    大小增长**（与「JSON body 整体缓冲」的坑相对）。

    **两侧的分工**：

    - 异步侧（事件循环）：:meth:`offer` 投递（非阻塞，满了返回 ``False``）、
      :meth:`finish` 收尾、:meth:`fail` 报失败；
    - 同步侧（传输线程）：直接迭代本对象（阻塞等下一块）。

    **失败语义**：客户端断开时异步侧 :meth:`fail` 记下异常，同步侧在下一轮
    迭代时把它**抛出来**——核心包据此走失败路径（清容器内临时文件、回收
    exec 进程），**不会**把半截文件当成完整文件写进目标路径。

    **字节计数**（两个口径，服务端上传中断判定用）：

    - :attr:`delivered_bytes`——**feeder 侧**累计的「已投递字节数」（投进队列的）；
    - :attr:`consumed_bytes`——**消费侧**累计的「已取走字节数」（核心包真正拿到
      的）。

    判定用的是**消费侧**计数：它与失败发生的时序**无竞态**（核心包失败时它取走
    了多少字节是确定的），而投递侧计数会随 feeder 的进度漂移。
    """

    def __init__(self, max_chunks: int = BODY_BRIDGE_CHUNKS) -> None:
        self._queue: queue.Queue[bytes] = queue.Queue(maxsize=max(1, max_chunks))
        self._done = threading.Event()
        self._error: BaseException | None = None
        self._error_lock = threading.Lock()
        # 已投递字节数（**feeder 侧**：投进队列的字节数）
        self._delivered_bytes = 0
        # 已消费字节数（**消费侧**：核心包真正取走的字节数）
        self._consumed_bytes = 0

    # -- 异步侧接口
    def offer(self, chunk: bytes) -> bool:
        """投递一块字节；队列满时返回 ``False``（调用方等一会儿再试）。

        **非阻塞**：绝不把事件循环堵在队列上。
        """
        try:
            self._queue.put_nowait(chunk)
        except queue.Full:
            return False
        self._delivered_bytes += len(chunk)
        return True

    def finish(self) -> None:
        """收尾：body 读完了（同步侧读到队列空且本标志置上就收工）。"""
        self._done.set()

    def fail(self, error: BaseException) -> None:
        """记下失败原因（客户端断开 / 读 body 出错）。

        同步侧在下一轮迭代时抛出它——**不抛的话**，核心包会把「读到一半的
        body」当成完整 body，``mv`` 出去一个半截文件。
        """
        with self._error_lock:
            if self._error is None:
                self._error = error
        self._done.set()

    # -- 同步侧接口
    @property
    def error(self) -> BaseException | None:
        """已记录的失败原因（没有就是 ``None``）。"""
        with self._error_lock:
            return self._error

    @property
    def delivered_bytes(self) -> int:
        """**feeder 侧**累计的「已投递字节数」（投进队列的字节数）。

        **只由 feeder 线程写**（单写者 ⇒ 无需加锁）；读方拿到的是一次整数
        读取（CPython 下是原子的）。
        """
        return self._delivered_bytes

    @property
    def consumed_bytes(self) -> int:
        """**消费侧**累计的「已取走字节数」（核心包真正拿到的字节数）。

        **只由消费线程写**（单写者 ⇒ 无需加锁）。

        **这个计数是上传中断判定的依据**（见 :func:`_translate_upload_failure`）：
        它比 feeder 侧的「已投递」**确定**——核心包失败时它已经取走（或没取走）
        多少字节是确定的，而投递侧与失败发生的时序有竞态。
        """
        return self._consumed_bytes

    def __iter__(self) -> Iterable[bytes]:
        """迭代 body 的字节块（**阻塞**等下一块；失败时抛异常）。"""
        while True:
            try:
                chunk = self._queue.get(timeout=BODY_BRIDGE_WAIT_INTERVAL)
            except queue.Empty:
                error = self.error
                if error is not None:
                    raise error
                if self._done.is_set():
                    return
                continue
            error = self.error
            if error is not None:
                raise error
            # 先记账再交块：消费侧拿到的字节数与计数一致
            self._consumed_bytes += len(chunk)
            yield chunk


# ---------------------------------------------------------------- 上传
def parse_expected_bytes(request: Any) -> int | None:
    """从请求头取上传的**期望字节数**（``None`` = 不做字节数核对）。

    三种情形：

    - **头缺失**（chunked 传输）⇒ ``None``：**跳过核对**（核心包不校验字节数）。
      **残余风险**：没有长度信息时，客户端中断的上传**可能在目标路径留下半截
      文件**（宿主侧关掉 exec 的 stdin ⇒ 容器内 ``cat`` 收到干净 EOF、rc=0 ⇒
      无条件 ``mv``）——**调用方拿得到总长度时应当带上 ``Content-Length``**；
    - **头非法**（不是数字 / 负数 / 空串）⇒ **400**（抛 :class:`HTTPException`）：
      **不静默按「没有期望值」处理**——静默降级会把调用方声明的长度悄悄丢掉，
      字节数核对静默失效（用户以为有核对、实际没有）；
    - **头合法**⇒ 期望字节数（``int``），传给核心包的 ``manager.upload``。

    **只认 ASCII 数字**：``str.isdigit()`` 对上标数字（``"²"``）也返回真、
    对全角数字返回真而 ``int()`` 解析不出想要的值——所以额外要求
    ``isascii()``。

    **超长数字串 ⇒ 400（不落 500）**：``int()`` 对超过
    ``sys.int_info.str_digits_check_threshold``（CPython 3.12 默认 **4300** 位）
    的数字串抛 ``ValueError``——不拦住就是**未预期异常**（500 + 固定文案，
    调用方看不出是「头非法」）。**两道闸**：**长度预判**（超过
    :data:`MAX_CONTENT_LENGTH_DIGITS` 位直接 400）+ ``try/except ValueError``
    兜底。
    """
    raw = request.headers.get("content-length")
    if raw is None:
        return None
    text = raw.strip()
    if not text.isascii() or not text.isdigit():
        raise HTTPException(
            status_code=STATUS_BAD_REQUEST, detail=INVALID_CONTENT_LENGTH_MESSAGE
        )
    if len(text) > MAX_CONTENT_LENGTH_DIGITS:
        raise HTTPException(
            status_code=STATUS_BAD_REQUEST, detail=INVALID_CONTENT_LENGTH_TOO_LONG_MESSAGE
        )
    try:
        return int(text)
    except ValueError:  # pragma: no cover - 长度预判之后不该再到这里（兜底闸）
        raise HTTPException(
            status_code=STATUS_BAD_REQUEST, detail=INVALID_CONTENT_LENGTH_TOO_LONG_MESSAGE
        ) from None


async def feed_request_body(request: Any, bridge: RequestBodyBridge) -> None:
    """把请求体逐块喂进桥接（异步侧）。

    **逐块消费** ``request.stream()``：**不用** ``request.body()``（后者把整个
    body 缓冲进内存——实测 200 MiB body 让进程 RSS 从 44.5 MiB 涨到 433.9 MiB）。

    队列满时**等消费侧取走**再继续读（这就是端到端背压）。

    **读完即收尾**（``bridge.finish()``）：消费侧读到「队列空且已收尾」就收工；
    **读出错**（客户端断开等）则记下失败，让消费侧抛错（核心包走失败路径）。
    """
    try:
        async for chunk in request.stream():
            if not chunk:
                continue
            while not bridge.offer(chunk):
                await asyncio.sleep(BODY_BRIDGE_POLL_INTERVAL)
    except BaseException as exc:
        bridge.fail(exc)
        raise
    finally:
        bridge.finish()


class _UploadAborted(Exception):
    """上传已被中止（内部信号：让还在等下一块的消费侧立刻收工）。"""


async def run_upload(
    manager: FileTransferManager,
    sandbox: str,
    target_path: str,
    request: Any,
) -> int:
    """把请求体流式写进沙箱容器，返回**实际写入的字节数**。

    **并发结构**：事件循环这一侧喂 body（异步），传输专用线程池那一侧做阻塞
    的上传编排（同步）——中间的桥接队列**有界**，两端互相背压。

    **两端并行、谁先结束谁收场**：上传一结束（成功或失败）就**终止读 body**
    ——否则「上传前置就失败」（目标是已存在目录 / 父目录缺失 / 沙箱已停等）时，
    消费侧已经退出，body 仍被读进有界队列 ⇒ 队列塞满 ⇒ 喂 body 的一侧永远等
    不到空位（**请求挂死**）。

    **客户端断开**：喂 body 的一侧抛异常 ⇒ 桥接记下失败 ⇒ 核心包的消费侧
    抛异常 ⇒ 核心包走失败路径（**清容器内临时文件**、回收 exec 进程）。

    **期望字节数**：先从请求头 ``Content-Length`` 取（:func:`parse_expected_bytes`），
    再交给核心包在容器内 ``mv`` **之前**核对；**头非法直接 400**（此时**还没开始
    读 body**，上传压根没发生）。

    **服务端字节计数兜底**：核心包失败时，服务端用自己的字节计数补一个更准的
    结论（“上传被中断” ⇒ 400 ``size_mismatch``），**不依赖容器内 stderr 里的
    标记**（那个标记会随容器客户端被杀而丢失）——见
    :func:`_translate_upload_failure`。
    """
    expected_bytes = parse_expected_bytes(request)
    loop = asyncio.get_running_loop()
    bridge = RequestBodyBridge()
    future = loop.run_in_executor(
        TRANSFER_IO_EXECUTOR,
        _upload_worker,
        manager,
        sandbox,
        target_path,
        bridge,
        expected_bytes,
    )
    # 后台的上传工作自己收尾（清临时文件、回收进程）：把它的异常取走，
    # 免得事件循环报「异常从未被取走」。
    future.add_done_callback(_discard_future_exception)
    feeder = asyncio.create_task(feed_request_body(request, bridge))
    try:
        return await future
    except Exception as exc:
        # 上传失败：服务端字节计数兜底（“传少了” ⇒ 400 size_mismatch）
        translated = _translate_upload_failure(
            exc, expected_bytes, bridge, target_path
        )
        if translated is exc:
            raise
        raise translated from exc
    finally:
        # 上传结束（成功 / 失败 / 被取消）：终止读 body。
        # 先给桥接记一个失败：万一消费侧还在等下一块，让它立刻抛错收工。
        bridge.fail(_UploadAborted())
        feeder.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await feeder


def _translate_upload_failure(
    exc: Exception,
    expected_bytes: int | None,
    bridge: RequestBodyBridge,
    target_path: str,
) -> Exception:
    """把「上传被中断」改判成 ``size_mismatch``（**服务端字节计数兜底**）。

    **为什么要有兜底**：容器内那道核对（``wc -c`` 临时文件 vs 期望值，命中就打
    ``size mismatch`` 标记）是**双保险里的第二道**；真机中断场景下**第一道信号
    会丢**——核心包的失败路径**先** ``pump.close()``（按进程组回收 exec 进程）
    **再**读 stderr 尾部，容器客户端被杀掉时 stderr 里的 ``size mismatch``
    标记**一并丢了** ⇒ 核心包只能归成 ``write_failed`` / ``exec_failed``
    ⇒ 服务端回 **500**，而 ``API.md`` 承诺的是 **400**。

    **兜底口径**（**不依赖 stderr 标记**）：服务端自己数「核心包实际取走的字节数」
    （:attr:`RequestBodyBridge.consumed_bytes`）：

    - **期望值未知**（chunked 传输，没给 ``Content-Length``）⇒ **不兜底**
      （没有契约值可比，维持核心包原分类）；
    - **取走的字节数 == 期望值** ⇒ **维持核心包原分类**（字节数对得上，问题
      不在「少传了」上）；
    - **取走的字节数 == 0** ⇒ **维持核心包原分类**（核心包一个字节都没拿到 ⇒
      失败发生在**写入之前**：前置探测 / 路径校验 / 沙箱已停……那是用户侧或环境
      侧的错，不是「传少了」）；
    - **其余**（取走了一些、但少于期望值）**且**核心包给的是「写入中断 / 命令
      执行失败」这类**没有更精确归类**的失败码 ⇒ **改判 ``size_mismatch``**
      （400，固定文案「上传中断，目标文件未完整写入」）。**更精确的分类码不动**
      （如「目标目录不可写」——那是真的原因，不能被字节数盖掉）。

    **为什么用「消费侧计数」而不是「投递侧计数」**：投递侧（feeder 投进队列的
    字节数）与失败发生的**时序有竞态**——前置失败时 feeder 可能已经投了 0 字节、
    1 字节或全部字节 ⇒ 判定不确定（同一条请求可能时而 400 时而 500）。消费侧
    计数是**确定的**：核心包失败时它已经取走（或没取走）多少字节是确定的。
    """
    if expected_bytes is None:
        return exc
    consumed = bridge.consumed_bytes
    if consumed == expected_bytes or consumed <= 0:
        return exc
    reason = getattr(exc, "reason", None)
    if isinstance(exc, TransferError) and reason not in INTERRUPTION_REASONS:
        # 核心包给出了更精确的分类码（如 parent_not_writable）⇒ 维持原分类
        return exc
    logger.info(
        "上传字节数不符（已取走 %s 字节 / 期望 %s 字节），改判 size_mismatch：%s",
        consumed,
        expected_bytes,
        single_line(target_path),
    )
    return TransferError(
        f"{MSG_SIZE_MISMATCH}：{target_path}", reason=REASON_SIZE_MISMATCH
    )


def _upload_worker(
    manager: FileTransferManager,
    sandbox: str,
    target_path: str,
    bridge: RequestBodyBridge,
    expected_bytes: int | None,
) -> int:
    """传输线程池里的上传编排（**阻塞**：exec 探测 + 往裸管道写）。

    **期望字节数透传**（``None`` = 核心包跳过字节数核对）。
    """
    return manager.upload(
        sandbox, target_path, bridge, expected_bytes=expected_bytes
    )


def _discard_future_exception(future: Any) -> None:
    """取走后台 future 的异常（只记日志，不往事件循环抛）。

    **兜底**：正常路径上异常由 ``await future`` 取走；这里防的是「请求被取消」
    之类取不到的场景——免得事件循环报「异常从未被取走」。
    """
    if future.cancelled():
        return
    error = future.exception()
    if error is not None:
        logger.info("上传收尾失败：%s", error)


# ---------------------------------------------------------------- 下载
async def open_download(
    manager: FileTransferManager, sandbox: str, path: str
) -> DownloadStream:
    """起一条下载字节流（**阻塞部分在传输专用线程池**）。

    核心包的 ``download()`` **先做分层探测**（目录 / 普通文件 / 特殊文件可
    区分，特殊文件一律拒——FIFO 会挂死 ``cat``），再起 ``cat`` 字节泵；返回的
    流带着**探测到的字节数**（只作响应头提示用）。
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(TRANSFER_IO_EXECUTOR, manager.download, sandbox, path)


async def iter_download_chunks(
    stream: DownloadStream,
    chunk_size: int = TRANSFER_CHUNK,
    limit: int | None = None,
) -> AsyncIterator[bytes]:
    """把下载字节流逐块读出来（**读操作走传输专用线程池**）。

    **按声明长度裁剪**（``limit`` = 响应头声明的字节数 = 探测值）：文件在探测
    与读取之间**变大**时，实际流会**超过**声明值 ⇒ 响应体长度与
    ``Content-Length`` 冲突 ⇒ uvicorn / h11 抛 ``LocalProtocolError``（连接异常
    终止，客户端看到的是「传输中断」而不是文件）。这里**按声明值裁剪**：超出
    部分**丢弃**并记 warning ⇒ **响应体永不超过声明长度**。

    **不足时保持现状**：流**自然结束**（文件在传输中变小）⇒ body 比
    ``Content-Length`` 短 ⇒ 由**协议层**按「短 body」处理（h11 报错、连接关闭）
    ——服务端**只记 warning**、不改口径：改成「按实际长度发」需要先读完整个流
    （等于放弃流式），而声明值是**探测值**、本来就允许与实际值不一致。

    **读完要核对失败原因**：``cat`` 的失败原因只在 stderr 里（退出码非零但
    没有异常），不核对就把一次失败下载当成「空文件」。**被截断时不做核对**：
    容器内的 ``cat`` 还在写（我们主动切断了流）⇒ 核对要么等它退出（最多 5 s）
    要么误报失败。

    **收尾**：无论读完、出错还是客户端断开，都在 ``finally`` 里关掉字节流
    （**回收 exec 进程**，按进程组回收，不留挂死进程）。

    **关泵走传输专用线程池**（**不阻塞事件循环**）：``stream.close()`` 最坏可
    阻塞约 **6 s**（``BytePump.close()``：关管道 + 按进程组回收：SIGTERM →
    ``wait(timeout=3)`` → SIGKILL → ``wait(timeout=3)``，再加 stderr 排空线程
    ``join(2)``）——**同步关会把事件循环堵住 6 s**（同一时刻其它 REST 接口全部
    卡住）。丢进线程池后：事件循环只等“线程池排队”，**不占事件循环线程**；
    取消路径上 ``await`` 可能被打断，但**关泵任务已提交到线程池**（照常执行，
    不会漏回收）。
    """
    loop = asyncio.get_running_loop()
    remaining = limit
    truncated = False
    try:
        while True:
            chunk = await loop.run_in_executor(
                TRANSFER_IO_EXECUTOR, stream.read, chunk_size
            )
            if not chunk:
                break
            if remaining is not None:
                if len(chunk) > remaining:
                    # 实际流超过声明长度：裁剪到声明长度（多出来的字节丢弃）
                    chunk = chunk[:remaining] if remaining > 0 else b""
                    truncated = True
                else:
                    remaining -= len(chunk)
            if chunk:
                yield chunk
            if truncated:
                break
        if truncated:
            logger.warning(
                "下载流字节数超出声明长度，已按声明长度截断：%s",
                single_line(_stream_path(stream)),
            )
        else:
            if remaining is not None and remaining > 0:
                logger.warning(
                    "下载流字节数少于声明长度（文件在传输中变小）：%s",
                    single_line(_stream_path(stream)),
                )
            await loop.run_in_executor(TRANSFER_IO_EXECUTOR, stream.raise_for_status)
    finally:
        await _close_download_stream(loop, stream)


def _stream_path(stream: Any) -> str:
    """取下载流的路径（**只进日志**；取不到就空串）。"""
    return str(getattr(stream, "path", "") or "")


async def _close_download_stream(
    loop: asyncio.AbstractEventLoop, stream: DownloadStream
) -> None:
    """关掉下载字节流（**走传输专用线程池**：不阻塞事件循环）。

    **为什么要丢线程池**：``stream.close()`` → ``BytePump.close()`` 最坏可阻塞
    约 **6 s**（按进程组回收：SIGTERM → ``wait(timeout=3)`` → SIGKILL →
    ``wait(timeout=3)``；再加 stderr 排空线程 ``join(2)``）。同步关 = **事件
    循环被堵 6 s**（同一时刻其它 REST 接口全部排队）。

    **等不等它**：一律 ``await``（正常读完时**等关泵完成再结束响应**——关泵是
    收尾的一部分：exec 进程要回收干净）。**取消路径上 ``await`` 会被打断**
    （``CancelledError`` 抛出去），但**关泵任务已提交到线程池**——它照常执行，
    不会漏回收。
    """
    try:
        future = loop.run_in_executor(TRANSFER_IO_EXECUTOR, stream.close)
    except RuntimeError:  # pragma: no cover - 事件循环已关闭（进程收尾）
        logger.warning("事件循环已关闭，下载字节流无法回收", exc_info=True)
        return
    future.add_done_callback(_consume_future_exception)
    try:
        await future
    except asyncio.CancelledError:
        raise
    except Exception:
        # 异常已由 done 回调取走并记日志（不往响应里抛）
        pass


def _consume_future_exception(future: Any) -> None:
    """取走后台 future 的异常（只记日志，不往事件循环抛）。

    **兜底**：取消路径上关泵任务可能没人 ``await`` ⇒ 异常没人取 ⇒ 事件循环
    报「异常从未被取走」。这里取走并记 warning。
    """
    if future.cancelled():
        return
    error = future.exception()
    if error is not None:
        logger.warning("回收下载字节流失败：%s", error)


# ---------------------------------------------------------------- 目录列表
async def run_list(
    manager: FileTransferManager, sandbox: str, dir_path: str
) -> list[Any]:
    """列目录（**阻塞部分在传输专用线程池**）。"""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(TRANSFER_IO_EXECUTOR, manager.list, sandbox, dir_path)


# ---------------------------------------------------------------- 只读读取
#: ``max_bytes`` 非法（不是正整数）时的固定提示（**请求参数错误**，不经 stderr）。
#: 口径对齐上传的 ``Content-Length`` 非法提示：**直接 400，不静默降级成「没有上限」**
#: ——静默降级会把调用方声明的上限悄悄丢掉，变成「不限量读」的反向行为。
INVALID_MAX_BYTES_MESSAGE = "max_bytes 非法：必须是正整数"


def parse_max_bytes(value: int | None) -> int | None:
    """校验只读读取的防护性上限（``None`` = 不传 = **不截断**）。

    - **不传** ⇒ ``None``（核心包按文件实际大小读到 EOF）。这是本端点的默认口径：
      正文本来就是流式的（内存有界），而预览的「大文件」语义是**不截断**（二次
      确认 + 进度条 + 全文渲染）；默认上限会把「全量预览」变成「悄悄只看一截」。
    - **正整数** ⇒ 原样透传。
    - **其余**（0 / 负数 / 非整数）⇒ **400**（固定中文文案）。**不静默降级**：
      0 等于「什么都不给」，与缺省语义相反；静默当成缺省会让调用方以为自己拿到了
      限量结果。

    非整数（``abc``）由 FastAPI 的参数校验拦住（400「请求参数不合法」），这里只需
    管「是整数但不合法」（§0 / 负数）——两边合起来覆盖全部非法形态。
    """
    if value is None:
        return None
    if isinstance(value, bool) or value <= 0:
        raise HTTPException(
            status_code=STATUS_BAD_REQUEST, detail=INVALID_MAX_BYTES_MESSAGE
        )
    return value


async def open_read(
    manager: FileTransferManager,
    sandbox: str,
    path: str,
    max_bytes: int | None = None,
) -> Any:
    """起一条只读读取字节流（**阻塞部分在传输专用线程池**）。

    核心包的 ``read()`` **先做分层探测**（只放行普通文件——FIFO 会挂死 ``cat``），
    再起 ``cat`` 字节泵、**读掉首块做 NUL 嗅探**；返回的流带着二进制标记、探测
    到的总字节数与（``max_bytes`` 比文件小时的）截断声明。
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        TRANSFER_IO_EXECUTOR, manager.read, sandbox, path, max_bytes
    )


async def iter_read_chunks(
    stream: Any,
    chunk_size: int = TRANSFER_CHUNK,
    limit: int | None = None,
) -> AsyncIterator[bytes]:
    """把只读读取的字节流逐块吐给 ``StreamingResponse``。

    **复用下载流的搬运口径**（:func:`iter_download_chunks`）：逐块读、按声明长度
    裁剪、读完核对失败原因、无论怎么结束都在 ``finally`` 里关泵（客户端提前断开
    ⇒ 关泵回收 exec，不留挂死进程）。只读读取的区别全在核心包那一侧：
    ``ReadStream.read`` 到达 ``max_bytes`` 上限就**自己关泵**并让
    ``raise_for_status`` 不给失败结论（那是我们主动停的，不是容器内失败）。

    ``limit`` = 响应头声明的 ``Content-Length``（= ``min(总字节数, max_bytes)``）：
    仍是「声明值与裁剪上限取同一个值」那套口径，响应体**永不超过**声明长度。
    """
    async for chunk in iter_download_chunks(stream, chunk_size, limit):
        yield chunk
