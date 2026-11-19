"""终端模拟器（pyghostty 封装层）测试。

覆盖八件事：

- **状态字段的类型矩阵**：九个字段逐个显式取类型（红线 1），值全对、进程不崩；
- **DEC 私有模式矩阵**：模式逐项可读，不认识的模式号不抛；
- **备用屏**：``?1049h`` 之后 active_screen 切到 1；
- **快照 roundtrip**：A 的现场导成恢复流 → 喂给同尺寸的新 B → 画面 / 光标 / 模式一致；
- **快照幂等**：B 再导一次，与 A 的字节相同；
- **尺寸同步**：resize 之后状态与快照都按新几何；
- **不外发应答**：模拟器自己产生的探测应答必须静默丢弃（红线 2），
  恢复流里也不该含那些查询序列；
- **kitty 键盘协议**：恢复流里带对应的恢复序列（前端据此续上协议状态）；
- **降级**：pyghostty 装不上时 ``create_emulator`` 返回 ``None``。

pyghostty 装不上（没有对应平台的 wheel）时整组用例跳过——那正是降级路径。
"""

from __future__ import annotations

import pytest

from sandbox_console import emulator as emulator_module
from sandbox_console.emulator import (
    EMULATOR_SCROLLBACK_LINES,
    TerminalEmulator,
    create_emulator,
)

# pyghostty 装不上（没有对应平台的 wheel）⇒ 整组用例跳过。
# 放在导入之后：模拟器封装层本身**不**在导入期依赖 pyghostty（懒载入）。
pyghostty = pytest.importorskip("pyghostty")

# 探测序列（各挑一种代表）
CSI_KITTY_SET = b"\x1b[>5u"
CSI_KITTY_QUERY = b"\x1b[?u"
CSI_DA1 = b"\x1b[c"
OSC_FG_QUERY = b"\x1b]10;?\x07"
OSC_PALETTE_QUERY = b"\x1b]4;0;?\x07"


def _emulator(cols: int = 80, rows: int = 24) -> TerminalEmulator:
    """建一份模拟器（用例里显式建，不走降级路径）。"""
    instance = create_emulator(cols, rows)
    assert instance is not None, "pyghostty 不可用（用例应当被 importorskip 跳过）"
    return instance


def test_state_fields_have_explicit_types() -> None:
    """九个状态字段全对（逐字段显式传类型，进程不崩）。"""
    emu = _emulator(100, 30)
    emu.feed(b"\x1b[?1049h\x1b[?2004h\x1b[?1000h\x1b[?1006h")
    emu.feed("hello 世界".encode())
    emu.feed(b"\x1b[3;7H")

    state = emu.state()
    assert state.cols == 100
    assert state.rows == 30
    assert state.cursor_x == 6
    assert state.cursor_y == 2
    assert state.cursor_visible is True
    assert state.active_screen == 1
    assert state.total_rows >= 30
    assert state.scrollback_rows >= 0
    assert state.kitty_keyboard_flags == 0

    # kitty 键盘标志：喂 `CSI > 5 u` 后是 5
    flags = _emulator()
    flags.feed(CSI_KITTY_SET)
    assert flags.state().kitty_keyboard_flags == 5


def test_mode_matrix_is_readable() -> None:
    """DEC 私有模式逐项可读；不认识的模式号不抛（记 False）。"""
    emu = _emulator()
    emu.feed(b"\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[?2004h\x1b[?1049h\x1b[?1h")

    modes = emu.state().modes
    for name in (
        "dec_1",
        "dec_1000",
        "dec_1002",
        "dec_1003",
        "dec_1004",
        "dec_1006",
        "dec_1049",
        "dec_2004",
    ):
        assert name in modes
    assert modes["dec_1"] is True
    assert modes["dec_1000"] is True
    assert modes["dec_1002"] is True
    assert modes["dec_1006"] is True
    assert modes["dec_1004"] is True
    assert modes["dec_2004"] is True
    assert modes["dec_1049"] is True
    # 没开的模式是 False（不是「不可知」）
    assert modes["dec_1003"] is False

    # 不认识的模式号：底层会抛错，但 state() 不受牵连
    with pytest.raises(Exception):
        emu._term.mode(9999)
    assert emu.state().modes["dec_2004"] is True


def test_alternate_screen_is_tracked() -> None:
    """备用屏：``?1049h`` 之后 active_screen 切到 1。"""
    emu = _emulator()
    assert emu.state().active_screen == 0
    emu.feed(b"\x1b[?1049h")
    assert emu.state().active_screen == 1


def test_snapshot_roundtrip_preserves_screen_cursor_and_modes() -> None:
    """快照 roundtrip：A 的现场恢复进同尺寸的新 B，画面 / 光标 / 模式一致。"""
    source = _emulator(80, 24)
    source.feed(b"\x1b[?1049h\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[1m")
    source.feed("hello 世界".encode())
    source.feed(b"\x1b[3;7H\x1b[0m")

    restore = source.snapshot()
    assert restore

    target = _emulator(80, 24)
    target.feed(restore)

    # 画面一致（可见区域的纯文本）
    assert target._term.text() == source._term.text()
    # 光标一致
    assert (target.state().cursor_x, target.state().cursor_y) == (
        source.state().cursor_x,
        source.state().cursor_y,
    )
    # 模式一致
    assert target.state().modes == source.state().modes
    # 备用屏状态一致
    assert target.state().active_screen == source.state().active_screen


def test_snapshot_is_idempotent() -> None:
    """快照幂等：A 的快照喂给 B 后，B 再导一次与 A 的字节相同。"""
    source = _emulator(80, 24)
    source.feed(b"\x1b[?2004h")
    source.feed("stable".encode())
    source.feed(b"\x1b[2;3H")

    restore = source.snapshot()
    target = _emulator(80, 24)
    target.feed(restore)

    assert target.snapshot() == restore


def test_resize_moves_state_and_snapshot_geometry() -> None:
    """尺寸同步：resize 之后状态与快照都按新几何。"""
    emu = _emulator(80, 24)
    emu.feed(b"hello")
    emu.resize(100, 30)

    state = emu.state()
    assert state.cols == 100
    assert state.rows == 30

    # 快照按新几何：与「一开始就是 100x30」的模拟器导出的流相同
    reference = _emulator(100, 30)
    reference.feed(b"hello")
    assert emu.snapshot() == reference.snapshot()


def test_snapshot_restores_kitty_keyboard_flags() -> None:
    """kitty 键盘协议：恢复流里带对应的恢复序列（前端据此续上协议状态）。

    喂 ``CSI > 5 u``（flags=5）⇒ 恢复流含 ``CSI = 5 ; 1 u``；
    flags=1 ⇒ ``CSI = 1 ; 1 u``（实测口径：靠 formatter 的
    ``extra.screen.kitty_keyboard`` 开关产出）。

    **这条承重**：常驻改造后前端按快照恢复现场，kitty 键盘协议状态靠这串
    恢复序列续上（不靠历史回放——回放里的 kitty 探测会被再应答）。
    """
    emu = _emulator()
    emu.feed(CSI_KITTY_SET)
    assert emu.state().kitty_keyboard_flags == 5
    restore = emu.snapshot()
    assert b"\x1b[=5;1u" in restore

    simple = _emulator()
    simple.feed(b"\x1b[>1u")
    assert simple.state().kitty_keyboard_flags == 1
    assert b"\x1b[=1;1u" in simple.snapshot()


def test_emulator_never_answers_probes(monkeypatch: pytest.MonkeyPatch) -> None:
    """不外发应答：不注册 on_reply，探测序列不进恢复流。

    **红线 2**：一旦把模拟器的应答转发出去，历史里的探测会被再应答，
    「退出 pi 后切标签向 bash 回显乱码」原样复发。
    """
    calls: list[object] = []
    original = pyghostty.Terminal.on_reply

    def spy(self, fn):  # noqa: ANN001 - 测试替身
        calls.append(fn)
        return original(self, fn)

    monkeypatch.setattr(pyghostty.Terminal, "on_reply", spy)

    emu = _emulator()
    emu.feed(CSI_KITTY_QUERY)
    emu.feed(CSI_DA1)
    emu.feed(OSC_FG_QUERY)
    emu.feed(OSC_PALETTE_QUERY)

    # 没有注册过任何应答回调
    assert calls == []
    assert emu._term._reply_cb is None

    # 恢复流里不含那些查询序列（历史里的探测不会被前端再应答）
    restore = emu.snapshot()
    assert CSI_KITTY_QUERY not in restore
    assert CSI_DA1 not in restore
    assert OSC_FG_QUERY not in restore
    assert OSC_PALETTE_QUERY not in restore
    assert b"\x1b[c" not in restore
    assert b"\x1b]10;?" not in restore


def test_create_emulator_degrades_when_pyghostty_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """降级：pyghostty 装不上时 create_emulator 返回 None（调用方走回放路径）。"""

    def boom() -> None:
        raise ImportError("No module named 'pyghostty'")

    monkeypatch.setattr(emulator_module, "_load_pyghostty", boom)

    assert create_emulator(80, 24) is None


def test_scrollback_constant_is_exposed() -> None:
    """回滚行数是模块常量（调用方按它估内存占用）。"""
    assert EMULATOR_SCROLLBACK_LINES == 1000
