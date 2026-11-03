/**
 * 终端连接的失败策略：取票失败怎么判、要不要继续重连、状态与提示怎么写。
 *
 * 纯逻辑（不碰 React、不碰 WebSocket），收敛在 `src/lib/` 并有单元测试：
 * 「取票失败 → 重连节奏 → 提示去重」这条链子原先散在 `TerminalView` 的 effect 里，
 * 收到 `src/lib/` 才能单独钉死每一条口径。
 *
 * 背景：浏览器发起的 WebSocket 不能设请求头，握手靠一次性票据（`?ticket=`）。
 * 票据取不到 = 根本没连上（不是「连上之后断了」），失败原因分三类：
 * 令牌无效 / 后端不可达 / 其它。**令牌无效不重试**（重试多少次都是 401）。
 */

/** 重连退避上限（毫秒）。 */
export const RECONNECT_MAX_DELAY_MS = 8000;

/** 重连退避基数（毫秒）。 */
export const RECONNECT_BASE_DELAY_MS = 500;

/** 连续失败上限：达到即停掉自动重连，等用户手动重试。 */
export const MAX_RECONNECT_FAILURES = 10;

/** 取票失败的分类。 */
export type TicketFailureKind =
  /** 令牌无效（或压根没配令牌）：重试也没用，要去设置抽屉改令牌。 */
  | 'unauthorized'
  /** 后端不可达（网络不通 / 地址不对）：可以退避重试。 */
  | 'unreachable'
  /** 其它失败（后端 500 之类）：可以退避重试。 */
  | 'unknown';

/** 一次取票失败。 */
export interface TicketFailure {
  kind: TicketFailureKind;
  /** 给用户看的中文原因（后端 `detail` 原文优先）。 */
  message: string;
}

/** 取出错误对象上的 HTTP 状态码（没有则 null）。 */
function statusOf(exc: unknown): number | null {
  if (typeof exc !== 'object' || exc === null) {
    return null;
  }
  const status = (exc as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

/**
 * 取票失败分类。
 *
 * - 401 / 403 → 令牌无效；
 * - 「未配置连接」错误（令牌压根是空的）→ 也算令牌无效；
 * - 网络不可达（状态码 0）→ 后端不可达；
 * - 其它状态码 / 说不清的异常 → 未知失败（仍可重试）。
 */
export function classifyTicketFailure(exc: unknown): TicketFailure {
  const name = exc instanceof Error ? exc.name : '';
  const message = exc instanceof Error ? exc.message : '';
  if (name === 'ConnectionNotConfiguredError') {
    return { kind: 'unauthorized', message: message || '尚未配置后端连接' };
  }
  const status = statusOf(exc);
  if (status === 401 || status === 403) {
    return { kind: 'unauthorized', message: message || '访问令牌无效或缺失' };
  }
  if (status === 0) {
    return { kind: 'unreachable', message: message || '无法连接后端服务' };
  }
  if (status !== null) {
    return { kind: 'unknown', message: message || `获取终端票据失败（HTTP ${status}）` };
  }
  return { kind: 'unreachable', message: message || '无法连接后端服务' };
}

/**
 * 这种失败要不要停掉自动重连。
 *
 * **令牌无效 → 停**：重试多少次都是 401，白跑；提示用户去设置抽屉换令牌，
 * 换完点「重试连接」手动再来一次。
 */
export function stopsAutoReconnect(failure: TicketFailure): boolean {
  return failure.kind === 'unauthorized';
}

/**
 * 第 n 次失败后等多久再重连（毫秒）：指数退避，封顶 8 秒。
 */
export function reconnectDelayMs(attempt: number): number {
  const step = Math.max(1, attempt);
  return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** (step - 1));
}

/**
 * 取票失败时的状态栏文案（**单列**：不与「连接断开」混）。
 *
 * 原因与退避秒数都写清楚：用户看到的是「票据没取到 → 因为什么原因 → 多久后重试」。
 */
export function ticketFailureStatusText(failure: TicketFailure, retryDelaySeconds: number): string {
  return `取不到终端票据：${failure.message}；${retryDelaySeconds} 秒后自动重连…`;
}

/**
 * 令牌无效时的状态栏文案（终态：不再自动重连）。
 */
export function unauthorizedStatusText(failure: TicketFailure): string {
  return `令牌无效：${failure.message}；请到设置抽屉更新令牌后重试`;
}

/**
 * 取票失败提示的去重键：同一句不重复弹（重连会反复取票据）。
 */
export function ticketFailureToastKey(failure: TicketFailure): string {
  return `${failure.kind}:${failure.message}`;
}
