"""终端模拟器：进程内跑一份 pyghostty 的 VT 模拟器，把「屏幕现场」导成恢复流。

**为什么需要它**：控制台网页终端的 xterm 实例不是常驻的（切标签就整块重挂载），
重挂载后前端只能回放服务端的**历史字节**。历史字节里有两样东西会出事：

- **终端模式丢了**：pi 全屏时开的 DEC 私有模式（鼠标 1000/1002/1003/1006、
  焦点上报 1004、括号粘贴 2004、备用屏 1049）挂在 xterm 实例上，重挂载即归零，
  pi 侧不知情也不重发 ⇒ 鼠标、焦点事件、括号粘贴全部失效；
- **历史里的探测被再应答**：pi 启动时发过两包终端探测（kitty 键盘查询、
  DA1、主题色查询），重放历史时新 xterm 实例把历史中的探测当新请求**再答一遍**，
  应答经 WS 写进 PTY 输入 ⇒ pi 退出后 bash 把应答当键盘输入回显成乱码。

本模块的做法：**服务端常驻一份模拟器**，与 PTY 输出并行喂进去；前端重挂载时
不再回放历史字节，而是拿一份**屏幕快照**（VT 恢复流）把画面与模式一次性恢复。

**恢复流不是历史回放**：它是「当前屏幕 + 光标 + 模式」的重新描绘，历史里的
探测序列不在其中 ⇒ 前端拿到快照不会再产生任何应答（问题②根治）。

两条硬约束（踩过的坑，写在这里钉死）：

- **红线 1 —— `Terminal.get()` 必须逐字段显式传类型**。pyghostty 的默认 ctype
  是 ``uint16_t``，而 ``active_screen``（int）、``total_rows`` / ``scrollback_rows``
  （size_t）、``cursor_visible``（bool）、``kitty_keyboard_flags``（uint8_t）
  的真实宽度各不相同：按默认类型读 4/8 字节字段会**堆越界拖崩整个进程**。
  本模块用 ``_GET_CTYPES`` 表把九个字段的类型钉死，表里没有的键直接抛错。
- **红线 2 —— 绝不给模拟器注册 on_reply / 应答转发**。模拟器自己产生的探测
  应答（DA1、kitty 键盘查询、主题色查询）必须**静默丢弃**：一旦转发出去，
  历史里的探测会被再应答，问题②原样复发。

另外两个坑：

- ``mode(n)`` 问一个不认识的模式号会抛 ``GhosttyError``（不是返回 False），
  逐项 try/except 记 False 即可；
- 恢复流喂回**另一个**模拟器之前不需要 reset（本模块每次都是新建终端）；
  真正需要 reset 的是前端的 xterm 实例（``term.reset()``）。
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# 模拟器的回滚行数：够覆盖一屏多几屏，又不至于把内存吃满
EMULATOR_SCROLLBACK_LINES = 1000

# 模式号表：键是状态字段名，值是 DEC 私有模式号
_MODE_NUMBERS: dict[str, int] = {
    "dec_1": 1,
    "dec_1000": 1000,
    "dec_1002": 1002,
    "dec_1003": 1003,
    "dec_1004": 1004,
    "dec_1006": 1006,
    "dec_1049": 1049,
    "dec_2004": 2004,
}

# 状态字段 → ctype（红线 1：逐字段显式传类型，杜绝默认类型路径）
_GET_CTYPES: dict[str, str] = {
    "cols": "uint16_t",
    "rows": "uint16_t",
    "cursor_x": "uint16_t",
    "cursor_y": "uint16_t",
    "active_screen": "int",
    "total_rows": "size_t",
    "scrollback_rows": "size_t",
    "cursor_visible": "bool",
    "kitty_keyboard_flags": "uint8_t",
}


class EmulatorUnavailable(RuntimeError):
    """模拟器不可用（pyghostty 没装 / 动态库加载不了 / 建不出来）。"""


def _load_pyghostty():
    """载入 pyghostty。

    装不上（ImportError）或动态库加载不了（OSError）都归成
    ``EmulatorUnavailable``：调用方据此降级，不让整个服务起不来。
    """
    try:
        import pyghostty
    except Exception as exc:  # noqa: BLE001 - 装不上就降级，不该拖垮服务
        raise EmulatorUnavailable(f"pyghostty 不可用：{exc}") from exc
    return pyghostty


@dataclass(frozen=True)
class EmulatorState:
    """模拟器的状态快照（供上层判断与自检用）。"""

    cols: int
    rows: int
    cursor_x: int
    cursor_y: int
    cursor_visible: bool
    active_screen: int
    kitty_keyboard_flags: int
    total_rows: int
    scrollback_rows: int
    # DEC 私有模式逐项状态（键见 ``_MODE_NUMBERS``）
    modes: dict[str, bool] = field(default_factory=dict)


def _init_sized(ctype: str):
    """按「size 字段约定」分配一个结构体指针（pyghostty 的 init_sized 同款）。

    约定：结构体里名为 ``size`` 的字段是该结构体自身的大小；嵌套结构体
    递归按同一约定填。没有这一步，cffi 写嵌套结构体时会踩未初始化内存。
    """
    from pyghostty._ffi import ffi

    pointer = ffi.new(f"{ctype}*")
    _set_sizes(pointer)
    return pointer


def _set_sizes(pointer) -> None:
    """递归填 ``size`` 字段。"""
    from pyghostty._ffi import ffi

    item = ffi.typeof(pointer).item
    for name, field_type in item.fields:
        if name == "size":
            pointer.size = ffi.sizeof(item)
        elif field_type.type.kind == "struct":
            _set_sizes(ffi.addressof(pointer[0], name))


def _check(result: int, what: str) -> None:
    """``GhosttyResult`` 非 0 即失败（与 pyghostty 自己的 check 同口径）。"""
    if result:
        raise EmulatorUnavailable(f"{what} 失败：{result}")


def format_vt_restore_stream(term) -> bytes:
    """把模拟器的当前现场导成一份 **VT 恢复流**（可直接喂给 xterm.js）。

    产出的是「重绘当前屏幕 + 恢复光标 + 恢复模式」，**不是历史回放**：
    历史里的探测序列不在里面 ⇒ 前端拿到它不会再产生任何应答。

    走「先查长度再填」两段式（``ghostty_formatter_format_buf`` 传 NULL/0 拿到
    需要的字节数，再分配缓冲区填进去），不用 ``format_alloc``（那个要在
    分配器上做取舍，pyghostty 自己的读缓冲也是这个两段式路子）。

    格式化选项按实测定稿：模式要恢复（``modes``）、调色板不要（``palette``
    关掉——前端有自己的配色）、光标与字符样式要（``screen.cursor`` /
    ``screen.style``）、kitty 键盘标志要（``screen.kitty_keyboard``），
    其余（超链接 / 保护区 / 字符集 / 滚动区 / 制表位 / pwd）一律关。
    """
    from pyghostty._ffi import ffi, lib

    options = _init_sized("GhosttyFormatterTerminalOptions")
    options.emit = lib.GHOSTTY_FORMATTER_FORMAT_VT
    options.unwrap = False
    options.trim = False
    options.extra.modes = True
    options.extra.palette = False
    options.extra.pwd = False
    options.extra.keyboard = False
    options.extra.scrolling_region = False
    options.extra.tabstops = False
    options.extra.screen.cursor = True
    options.extra.screen.style = True
    options.extra.screen.kitty_keyboard = True
    options.extra.screen.hyperlink = False
    options.extra.screen.protection = False
    options.extra.screen.charsets = False
    options.selection = ffi.NULL

    formatter = ffi.new("GhosttyFormatter*")
    _check(
        lib.ghostty_formatter_terminal_new(ffi.NULL, formatter, term._t[0], options[0]),
        "ghostty_formatter_terminal_new",
    )
    try:
        needed = ffi.new("size_t*")
        # 第一段：只问长度（传 NULL / 0，返回「空间不足」并把长度写进 needed）
        lib.ghostty_formatter_format_buf(formatter[0], ffi.NULL, 0, needed)
        buffer = ffi.new("uint8_t[]", max(int(needed[0]), 1))
        # 第二段：真正填内容
        _check(
            lib.ghostty_formatter_format_buf(formatter[0], buffer, len(buffer), needed),
            "ghostty_formatter_format_buf",
        )
        return bytes(ffi.buffer(buffer, int(needed[0]))[:])
    finally:
        lib.ghostty_formatter_free(formatter[0])


class TerminalEmulator:
    """一份进程内的终端模拟器。

    - ``feed``：把 PTY 的输出喂进去（与真实终端同一套解析）；
    - ``resize``：跟随窗口大小变化（几何必须与 PTY 一致，见下）；
    - ``snapshot``：导出当前现场的 VT 恢复流；
    - ``state``：读状态（自检与测试用）。

    **几何必须与 PTY 一致**：恢复流是「按字面换行相对定位」的，前端重放时
    的 rows/cols 与模拟器不一致，画面就会错位（硬约束 A）。所以 resize 时
    模拟器与 PTY 一起改；模拟器改不动就不改 PTY（宁可尺寸不变，也不让两边
    打架）。
    """

    def __init__(
        self,
        cols: int,
        rows: int,
        *,
        scrollback: int = EMULATOR_SCROLLBACK_LINES,
    ) -> None:
        module = _load_pyghostty()
        self._lock = threading.RLock()
        self._cols = int(cols)
        self._rows = int(rows)
        # **红线 2**：这里只 new 一个终端，**不注册 on_reply**——
        # 模拟器自己产生的探测应答必须静默丢弃，转发出去就会再应答复发问题。
        self._term = module.Terminal(
            cols=self._cols, rows=self._rows, scrollback=int(scrollback)
        )
        self._closed = False

    # ---------------------------------------------------------------- 属性
    @property
    def cols(self) -> int:
        """模拟器当前的列数。"""
        return self._cols

    @property
    def rows(self) -> int:
        """模拟器当前的行数。"""
        return self._rows

    # ---------------------------------------------------------------- 输入
    def feed(self, data: bytes) -> None:
        """把容器内输出喂进模拟器。

        异常**上抛给调用方**：调用方负责降级（这台会话的模拟器就此作废，
        退回环形缓冲回放）。这里吞掉异常等于「模拟器状态悄悄错掉」，
        比明确降级更糟。
        """
        if self._closed or not data:
            return
        with self._lock:
            self._term.feed(data)

    def resize(self, cols: int, rows: int) -> None:
        """改窗口大小（几何必须与 PTY 同步）。"""
        if self._closed:
            raise EmulatorUnavailable("模拟器已关闭")
        with self._lock:
            self._term.resize(int(cols), int(rows))
            self._cols = int(cols)
            self._rows = int(rows)

    # ---------------------------------------------------------------- 输出
    def snapshot(self) -> bytes:
        """导出当前现场的 VT 恢复流。"""
        if self._closed:
            raise EmulatorUnavailable("模拟器已关闭")
        with self._lock:
            return format_vt_restore_stream(self._term)

    def state(self) -> EmulatorState:
        """读模拟器状态（九个字段逐个显式取，模式逐项 try/except）。"""
        if self._closed:
            raise EmulatorUnavailable("模拟器已关闭")
        with self._lock:
            return EmulatorState(
                cols=self._get("cols"),
                rows=self._get("rows"),
                cursor_x=self._get("cursor_x"),
                cursor_y=self._get("cursor_y"),
                cursor_visible=bool(self._get("cursor_visible")),
                active_screen=self._get("active_screen"),
                kitty_keyboard_flags=self._get("kitty_keyboard_flags"),
                total_rows=self._get("total_rows"),
                scrollback_rows=self._get("scrollback_rows"),
                modes=self._modes(),
            )

    def close(self) -> None:
        """释放模拟器（幂等）。"""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            try:
                self._term.close()
            except Exception as exc:  # noqa: BLE001 - 释放失败只记日志
                logger.warning("释放终端模拟器失败：%s", exc)

    # ---------------------------------------------------------------- 内部
    def _get(self, key: str):
        """按 ``_GET_CTYPES`` 表取一个状态字段（表里没有的键直接抛错）。"""
        ctype = _GET_CTYPES[key]
        return self._term.get(key, ctype)

    def _modes(self) -> dict[str, bool]:
        """逐项读 DEC 私有模式（不认识的模式号抛错 ⇒ 记 False，不崩）。"""
        from pyghostty._ffi import GhosttyError

        result: dict[str, bool] = {}
        for name, number in _MODE_NUMBERS.items():
            try:
                result[name] = bool(self._term.mode(number))
            except GhosttyError:
                # 不认识的模式号：记 False（这一项不可知，不影响其余项）
                result[name] = False
        return result


def create_emulator(cols: int, rows: int) -> TerminalEmulator | None:
    """建一份模拟器；建不出来（pyghostty 装不上等）返回 ``None``。

    ``None`` = **降级信号**：调用方退回「环形缓冲回放」路径（功能不崩，
    只是少了快照恢复那部分好处）。
    """
    try:
        return TerminalEmulator(cols, rows)
    except Exception as exc:  # noqa: BLE001 - 装不上就降级，不拖垮服务
        logger.warning("终端模拟器不可用，降级为环形缓冲回放：%s", exc)
        return None
