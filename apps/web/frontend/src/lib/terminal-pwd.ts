/**
 * 终端会话的工作目录（pwd）通道。
 *
 * 口径来源：PRD「方案二 · pwd 通道」+ 01 打样轮的实测结论（唯一施工依据）。
 *
 * - **解析**：shell integration 往提示符里塞一条 OSC 1337
 *   （`ESC ] 1337 ; CurrentDir=<绝对路径> BEL`），前端用 xterm 自己的状态机接管
 *   （`term.parser.registerOscHandler(1337, cb)`），**不手写字节流扫描器**——
 *   一条序列可能被拆到两帧里，跨帧边界交给 xterm 的状态机兜底；
 * - **纯函数**：解析口径收敛在本文件（`parseCurrentDirPayload`），不碰 DOM、不碰网络；
 * - **缓存**：pwd 是**纯前端产物**——按会话记在前端内存里，**后端会话记录不加字段、
 *   不入 localStorage** ⇒ 刷新页面即失（PRD「pwd 是纯前端产物」口径）。
 */

import { normalizeContainerPath } from './file-transfer';

/* ------------------------------------------------------------ OSC 1337 常量 */

/** OSC 1337 的标识符（注册 xterm 的 OSC 处理器用）。 */
export const OSC_CURRENT_DIR_IDENT = 1337;

/** OSC 1337 载荷里的键名（`CurrentDir=<path>`）。 */
export const CURRENT_DIR_KEY = 'CurrentDir=';

/**
 * 载荷里可能带的标识符前缀（`1337;`）。
 *
 * xterm 的 `registerOscHandler(1337, cb)` 回调拿到的是**去掉 `ESC ]`、标识符、
 * 分隔符 `;` 与终结符之后**的载荷（01 轮实测：回调收到 `CurrentDir=/workspace`）。
 * 这里额外兼容「标识符还带着」的形态（`1337;CurrentDir=/workspace`），两种都能解析。
 */
const IDENT_PREFIX = `${OSC_CURRENT_DIR_IDENT};`;

/* ------------------------------------------------------------------ 解析 */

/**
 * 只剥**前导**空白。
 *
 * **尾部空白不动**：既有 `normalizeContainerPath` 的口径是「条目名保真」——
 * 目录 / 文件名可能以空格结尾（`/work space ` 与 `/work space` 是两个东西），
 * 整串 `trim()` 会把路径改掉。尾部空白交给 `normalizeContainerPath` 判定。
 */
function stripLeadingWhitespace(value: string): string {
  return value.replace(/^\s+/, '');
}

/**
 * 剥掉首尾**成对**的引号（`'` / `"`）。
 *
 * 01 轮实测：bash 展开提示符时**不做引号去除**——`CurrentDir="$(pwd)"` 的载荷
 * 就是 `CurrentDir="/workspace"`。定稿写法不需要这层容错，但能兼容别的镜像来源。
 *
 * 收尾引号之后的空白**保留**（可能也是路径的一部分）：只剥引号本身。
 */
function stripMatchingQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  if (first !== '"' && first !== "'") {
    return value;
  }
  const closing = value.lastIndexOf(first);
  if (closing <= 0) {
    // 没有配对的收尾引号：不剥（剥了就变成别的路径）。
    return value;
  }
  return value.slice(1, closing) + value.slice(closing + 1);
}

/**
 * 解析一条 OSC 1337 载荷，取出容器内的工作目录。
 *
 * 接受的载荷形态（两种都收）：
 *
 * - `CurrentDir=/workspace` —— xterm 的 `registerOscHandler(1337, cb)` 实际送来的形态；
 * - `1337;CurrentDir=/workspace` —— 标识符还带着的形态。
 *
 * 校验链（任一步不过一律返回 `null`，**不抛异常**）：
 *
 * 1. **只**剥载荷的**前导**空白（协议噪声）；**尾部空白原样保留**——
 *    路径里可能真的有尾部空格（条目名保真口径，与 `normalizeContainerPath` 一致）；
 * 2. 剥掉可选的 `1337;` 前缀；
 * 3. 必须以 `CurrentDir=` 开头——别的键、别的标识符（`1338;…`）一律不认；
 * 4. 路径值剥掉**前导**空白与首尾成对的引号（尾部空白不动）；
 * 5. **必须是绝对路径**（以 `/` 开头；相对路径、`..` 段一律不认）；
 * 6. 过一遍既有的 `normalizeContainerPath`（拒 NUL、拒 `.` / `..` 段、归一多余的斜杠）。
 *
 * @param payload OSC 回调送来的载荷（**不含** `ESC ]` 与终结符）。
 * @returns 容器内的绝对路径；不合法返回 `null`（调用方静默忽略，不报错）。
 */
export function parseCurrentDirPayload(payload: string): string | null {
  if (typeof payload !== 'string') {
    return null;
  }
  // 只剥前导空白：载荷前端的空白是协议噪声，尾部的空白可能是路径的一部分。
  const stripped = stripLeadingWhitespace(payload);
  if (stripped === '') {
    return null;
  }
  const body = stripped.startsWith(IDENT_PREFIX) ? stripped.slice(IDENT_PREFIX.length) : stripped;
  if (!body.startsWith(CURRENT_DIR_KEY)) {
    return null;
  }
  // 键名与路径值之间的空白是噪声；路径值**尾部**的空白原样保留。
  const rawPath = stripMatchingQuotes(stripLeadingWhitespace(body.slice(CURRENT_DIR_KEY.length)));
  if (rawPath === '') {
    return null;
  }
  // 绝对路径校验：pwd 必须是容器内的绝对路径，相对路径没有定位意义。
  if (!rawPath.startsWith('/')) {
    return null;
  }
  // 既有口径的单一真相源：归一 + 拒 NUL + 拒 `.` / `..` 段。
  return normalizeContainerPath(rawPath);
}

/* ------------------------------------------------- 会话级内存缓存（pwd） */

/**
 * 会话标识 → 工作目录。
 *
 * **纯前端产物**：只在内存里（模块级 Map）——后端会话记录**不加字段**、
 * 不落 localStorage ⇒ 页面刷新即失（PRD「pwd / vault 根 / 折叠态的后端持久化」
 * 三者全部前端本地记忆的口径）。
 */
const pwdBySession = new Map<string, string>();

/** 会话标识 → 监听器集合（订阅 pwd 变化用）。 */
const listenersBySession = new Map<string, Set<() => void>>();

/** 通知某个会话的监听器：pwd 变了。单个监听器出错不影响其它监听器。 */
function notifySessionPwd(sessionId: string): void {
  const listeners = listenersBySession.get(sessionId);
  if (!listeners) {
    return;
  }
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // 监听器自己的问题：吞掉，别打断终端的数据流。
    }
  }
}

/**
 * 记下某个会话当前上报的工作目录。
 *
 * 非法路径（相对路径 / 含 NUL / 含 `.` `..` 段）**直接忽略**，缓存里不留脏值。
 * 同一会话多次上报 ⇒ **后到的覆盖先到的**（pwd 跟着 shell 的 `cd` 实时更新）。
 *
 * **值没变就不通知**：shell 每画一次提示符就报一次 pwd（同一条路径会连着报
 * 很多次），每次都通知会让订阅方（04 轮的文件窗格）跟着刷新一遍目录——
 * 与 PRD「无自动跟随」（shell 里 `cd` 时窗格绝不联动）的口径相悖。
 */
export function setSessionPwd(sessionId: string, path: string): void {
  if (!sessionId) {
    return;
  }
  const normalized = normalizeContainerPath(path);
  if (normalized === null) {
    return;
  }
  const previous = pwdBySession.get(sessionId);
  pwdBySession.set(sessionId, normalized);
  if (previous === normalized) {
    // 同一个值：不通知（只更新缓存）。
    return;
  }
  notifySessionPwd(sessionId);
}

/**
 * 取某个会话当前上报的工作目录。
 *
 * 返回 `null` = **该会话没有上报过工作目录**（如 `dash` / `sh` 会话），
 * 调用方据此走「回跳按钮禁用 + tooltip『当前会话未上报工作目录』」的降级口径。
 */
export function getSessionPwd(sessionId: string): string | null {
  return pwdBySession.get(sessionId) ?? null;
}

/**
 * 清掉某个会话的工作目录。
 *
 * **调用点 = 会话真的结束**（不是组件卸载——切标签会卸载终端视图，但会话还活着）：
 *
 * - `TerminalView.tsx` 收到 `exit` 帧（容器内进程退出了）；
 * - `TerminalPanel.tsx` 确认关闭会话（后端关掉了这条会话）。
 *
 * 不清也不会串到别的会话（按会话标识存），但缓存会**只增不减**——会话没了，
 * 旧 pwd 还在，前端内存白白占着。
 */
export function clearSessionPwd(sessionId: string): void {
  if (pwdBySession.delete(sessionId)) {
    notifySessionPwd(sessionId);
  }
}

/**
 * 订阅某个会话的工作目录变化（04 轮文件窗格按会话消费 pwd 时用）。
 *
 * @returns 退订函数（组件卸载时调用；**可以重复调用**，重复调用不会牵连
 *   后来的订阅者）。
 */
export function subscribeSessionPwd(sessionId: string, listener: () => void): () => void {
  const listeners = listenersBySession.get(sessionId) ?? new Set<() => void>();
  listeners.add(listener);
  listenersBySession.set(sessionId, listeners);
  return () => {
    listeners.delete(listener);
    // 只有「这份监听器集合仍是这个会话当前挂着的集合」才删表项：
    // 退订函数可能被**重复调用**（先退订 A、再订阅 B、旧的退订函数又跑一遍），
    // 无脑 `delete(sessionId)` 会把后来的 B 一起带走（订阅凭空失效）。
    if (listeners.size === 0 && listenersBySession.get(sessionId) === listeners) {
      listenersBySession.delete(sessionId);
    }
  };
}
