/**
 * 网页终端的快捷键分类。
 *
 * 纯函数：把一次按键（等价于 KeyboardEvent 的最小字段）归成一类，
 * 由终端视图按类别决定「交回浏览器 / 拦下来转发给容器内的 shell /
 * 复制选区到系统剪贴板 / 从系统剪贴板粘贴进终端」。
 *
 * 为什么要抽成纯函数：这份分类是**语义锁**——
 * Ctrl+C 仍然是发往容器的 SIGINT（0x03）、Ctrl+V 仍然是字面量 0x16、
 * 浏览器保留键仍然放行、新加的 Ctrl+Shift+C / Ctrl+Shift+V 才走剪贴板。
 * 把规则钉在纯函数里才能单测钉死，不靠真机回归兜。
 */

/** 一次按键的最小字段（与 KeyboardEvent 同名同义，便于直接映射）。 */
export interface TerminalShortcutEvent {
  /** 按键的 key 值（`KeyboardEvent.key`：字母键给的是字符本身，如 'c' / 'C'）。 */
  key: string;
  /** Ctrl 键是否按下。 */
  ctrlKey: boolean;
  /** Meta 键是否按下（macOS 的 Cmd / Windows 键）。 */
  metaKey: boolean;
  /** Alt 键是否按下（macOS 的 Option）。 */
  altKey: boolean;
  /** Shift 键是否按下。 */
  shiftKey: boolean;
}

/**
 * 快捷键的处置类别。
 *
 * - `reserved`：浏览器保留键，交回浏览器（不拦、不转发）；
 * - `copy`：复制选区到系统剪贴板；
 * - `paste`：从系统剪贴板粘贴进终端；
 * - `forward`：拦下浏览器行为，但仍编码后送进容器内的 shell；
 * - `plain`：普通按键，交给 xterm 照常处理。
 */
export type TerminalShortcutAction = 'reserved' | 'copy' | 'paste' | 'forward' | 'plain';

/**
 * 浏览器保留快捷键的字母清单（带 Ctrl 或 Meta 时生效）。
 *
 * 这些键交回浏览器处理：新标签页 / 新窗口 / 关闭窗口 / 切换标签页 /
 * 刷新 / 全屏 / 开发者工具 / 打印 / 另存为。
 *
 * - Ctrl+N 与 Ctrl+Shift+N：新窗口与新隐身窗口
 * - Ctrl+T 与 Ctrl+Shift+T：新标签页与恢复标签页
 * - Ctrl+W 与 Ctrl+Shift+W：关闭标签页与窗口
 * - Ctrl+Q：退出应用
 * - Ctrl+Tab 与 Ctrl+Shift+Tab：切换浏览器标签页
 * - Ctrl+P：打印
 * - Ctrl+S：另存为
 */
const RESERVED_CTRL_KEYS = new Set(['n', 't', 'w', 'q', 'p', 's', 'tab']);

/**
 * 这个按键是不是浏览器保留快捷键。
 *
 * 判定口径：带 Ctrl 或 Meta 的字母 / Tab 组合，以及 F5 / F11 / F12 与 Alt+F4。
 * 单的 Shift（Shift+Tab、Shift+N）不算保留键：终端里要能正常用。
 */
function isBrowserReservedShortcut(event: TerminalShortcutEvent): boolean {
  if (event.key === 'F5' || event.key === 'F11' || event.key === 'F12') {
    return true;
  }
  if (event.altKey && event.key === 'F4') {
    return true;
  }
  if (!event.ctrlKey && !event.metaKey) {
    return false;
  }
  return RESERVED_CTRL_KEYS.has(event.key.toLowerCase());
}

/**
 * 把一次按键归类。
 *
 * 判定顺序（顺序本身是语义的一部分）：
 * 1. **保留键优先**：浏览器保留键交回浏览器，不做复制 / 粘贴 / 转发；
 * 2. **剪贴板组合**：`Ctrl+Shift+C` 复制、`Ctrl+Shift+V` 粘贴；
 *    `Meta`（macOS 的 Cmd）同样支持——`Cmd+Shift+C` / `Cmd+Shift+V` 也触发，
 *    与 macOS 上终端的既有习惯一致；
 *    **带 Alt 的不算**：Windows 上 AltGr 在浏览器里报成 Ctrl+Alt 双修饰，
 *    `Ctrl+Alt+Shift+C` 是 AltGr 组合（输入特殊字符），不能被劫持成复制——
 *    这类组合一律留给转发路径；
 * 3. **其余带 Ctrl / Meta / Alt 的组合**：拦下浏览器行为，但仍转发给容器内的 shell；
 * 4. **纯按键**：交给 xterm 照常处理。
 *
 * `c` / `v` 都不在保留键清单里，所以第 1 步与第 2 步天然不冲突。
 */
export function classifyTerminalShortcut(event: TerminalShortcutEvent): TerminalShortcutAction {
  if (isBrowserReservedShortcut(event)) {
    return 'reserved';
  }
  const combo = event.ctrlKey || event.metaKey;
  // Alt 一律排除：Windows 的 AltGr 在浏览器里就是 Ctrl+Alt 双修饰，
  // Ctrl+Alt+Shift+C 这类 AltGr 组合必须走转发路径，不能被当成复制。
  if (combo && event.shiftKey && !event.altKey) {
    const key = event.key.toLowerCase();
    if (key === 'c') {
      return 'copy';
    }
    if (key === 'v') {
      return 'paste';
    }
  }
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return 'forward';
  }
  return 'plain';
}
