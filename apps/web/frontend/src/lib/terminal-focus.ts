/**
 * 网页终端的焦点回填门控。
 *
 * 背景：切换终端会话会让终端**整块重挂载**（`key={activeId}`），重挂载之后
 * 浏览器焦点落到 body，新终端就成了「空心光标」——看得见、敲不进（按键没进 pty）。
 * 所以重挂载后要把焦点回填进终端；但**不能抢走别处的焦点**（比如抽屉里的输入框）。
 *
 * 口径：只有两种情况允许回填——
 *
 * ① **意图**（`intent`）：用户刚点了标签、点了终端表面或新建了会话。这是明确的
 *    操作意图，此时焦点多半已经被浏览器挪到了标签按钮上（不在终端表面内），
 *    只能靠意图来判定「用户就是想回到这个终端」。
 * ② **原位**（`focusInsideTerminal`）：判定当下，焦点就落在终端表面内。
 *    焦点本来就是终端的，是重挂载把它弄丢的，属于要恢复的状态。
 *
 * 焦点在别处（抽屉输入框 / 其他控件）且没有上述两条时，**一律不回填**。
 */

/** 终端表面的定位标识（焦点跟踪靠它判定「焦点在不在终端里」）。 */
export const TERMINAL_SURFACE_TEST_ID = 'page-sandbox-detail-terminal-surface';

/** 终端表面的选择器（`Element.closest` 用）。 */
export const TERMINAL_SURFACE_SELECTOR = `[data-testid="${TERMINAL_SURFACE_TEST_ID}"]`;

/**
 * 判定一个事件落点是不是在终端表面内（沿祖先链找终端表面）。
 *
 * 用鸭子类型而不是 `instanceof Element`：这个模块的单元测试跑在 Node 环境里
 * （那里没有 `Element` 全局对象），`instanceof` 会直接抛 ReferenceError。
 */
export function isInsideTerminalSurface(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') {
    return false;
  }
  return (target as Element).closest(TERMINAL_SURFACE_SELECTOR) !== null;
}

/**
 * 判定「焦点此刻是否落在终端表面内」。
 *
 * 两个条件都要成立：
 *
 * 1. **活读焦点宿主**（判定当下的 `document.activeElement`）：浏览器自己的
 *    焦点账本。终端重挂载会把 xterm 的 helper textarea 从 DOM 摘掉，浏览器把
 *    焦点复位到 `body` 且**不派发 `focusin`**——只靠事件跟踪记下来的标志会永远
 *    停在 true，门控退化成「永远回填」（什么场合都往终端里塞焦点）。
 * 2. **焦点宿主仍在文档里**（`isConnected`）：被摘下来的旧宿主不算数。
 *
 * @param active 判定当下的焦点宿主（`document.activeElement`，可为 null）
 * @param host   最后一次 `focusin` 的落点（可为 null；用于识别「已被摘出 DOM」）
 */
export function focusInsideTerminalSurface(
  active: Element | null,
  host: Element | null,
): boolean {
  if (host !== null && !host.isConnected) {
    // 宿主已经被摘出 DOM：浏览器此刻的焦点不在终端里（多半已复位到 body）。
    return false;
  }
  if (!active || typeof active.closest !== 'function') {
    return false;
  }
  return active.closest(TERMINAL_SURFACE_SELECTOR) !== null;
}

/** 一次焦点回填的判定输入。 */
export interface TerminalFocusInput {
  /** 用户刚点了标签 / 终端表面 / 新建了会话（一次性意图，用完即消费）。 */
  intent: boolean;
  /** 判定当下，焦点是否落在终端表面内。 */
  focusInsideTerminal: boolean;
}

/**
 * 算一次焦点回填的结论：该不该把焦点塞回终端。
 *
 * 两条口径（确定性排序）：
 *
 * 1. 焦点此刻就在终端表面内：终端已经占着焦点，保持即可（回填是幂等的）；
 * 2. 有操作意图：用户刚点了标签 / 终端表面 / 新建了会话 —— 明确要回到这个终端。
 *
 * 都不成立 → 不回填（焦点在抽屉输入框等别处，不能抢）。
 */
export function resolveTerminalFocus(input: TerminalFocusInput): boolean {
  return input.focusInsideTerminal || input.intent;
}
