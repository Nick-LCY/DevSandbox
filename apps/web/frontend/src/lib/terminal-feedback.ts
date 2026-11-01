/**
 * 终端状态提示（toast）的口径与去重规则。
 *
 * 纯函数，不碰 React：终端状态 → 提示类型 / 文案 / 去重键，
 * 以及「同一会话的同一条提示只弹一次」的登记表。
 *
 * 抽到这里是为了能单独单测去重规则：去重一旦失效，
 * 服务端反复推同一个错误帧就会把提示刷屏。
 */
import type { ToastKind } from './toast';

/** 终端的连接状态。 */
/**
 * 终端的连接状态。
 *
 * - `connected`：会话握手完成（收到服务端的 hello 帧）或连接稳定存活；
 * - `warning`：连接还在，但服务端报了错误帧（会话本身没断）；
 * - `failed`：连续重连失败到上限，自动重连已停，等用户手动重试。
 */
export type TerminalStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed'
  | 'invalid'
  | 'warning'
  | 'failed';

/** 终端视图向上层汇报的一条状态。 */
export interface TerminalState {
  status: TerminalStatus;
  message: string;
  /** 进程退出码（`closed` 时有值；null 表示后端没给退出码）。 */
  exitCode?: number | null;
  /**
   * 会话结束的原因（`closed` 时有值；null 表示后端没给或旧版本没带）。
   *
   * 取值与后端一致：`exited`（容器内进程自己退出）/ `closed_by_user`
   * （用户主动关闭）/ `reclaimed`（空闲回收）/ `shutdown`（服务退出兜底）。
   */
  exitReason?: string | null;
  /** 重连退避秒数（`reconnecting` 且确实在退避等待时有值）。 */
  retryDelaySeconds?: number;
}

/** 一条状态提示：类型与文案。 */
export interface StateFeedback {
  kind: ToastKind;
  text: string;
}

/**
 * 终端状态 → 操作反馈（toast）。
 *
 * - `invalid` / `warning`：服务端报错帧与会话失效，失败 toast；
 * - `closed`：用户主动关的（结束原因 `closed_by_user`）是**成功** toast；
 *   空闲回收（`reclaimed`）与服务退出兜底（`shutdown`）是**提示** toast；
 *   容器内进程自己退出的，退出码 0 是正常收尾（提示蓝），非 0 是失败
 *   （提示红，文案带退出码）；
 * - `reconnecting`：退避等待中，提示蓝，文案带退避秒数；
 * - `failed`：重连到上限，失败 toast。
 *
 * 返回 null 的状态（连接中 / 已连接 / 没有退避秒数的重连中间态）不弹。
 */
export function feedbackForState(state: TerminalState): StateFeedback | null {
  if (state.status === 'invalid' || state.status === 'warning') {
    return { kind: 'error', text: state.message };
  }
  if (state.status === 'closed') {
    // 用户主动关闭：成功语义，不报成异常退出。
    if (state.exitReason === 'closed_by_user') {
      return { kind: 'success', text: '已关闭终端' };
    }
    // 空闲回收与服务退出兜底：会话确实结束了，但不是异常退出。
    // 报成失败会让用户以为终端崩了。
    if (state.exitReason === 'reclaimed' || state.exitReason === 'shutdown') {
      return { kind: 'info', text: '终端会话已结束' };
    }
    if (state.exitCode === 0) {
      return { kind: 'info', text: '终端会话已结束' };
    }
    const code = state.exitCode ?? null;
    return {
      kind: 'error',
      text:
        code === null
          ? '终端会话异常结束（退出码未知）'
          : `终端会话异常结束（退出码 ${code}）`,
    };
  }
  if (state.status === 'reconnecting') {
    // 只有真的在退避等待（带退避秒数）时才提示：连接中的中间态不提示。
    if (state.retryDelaySeconds === undefined) {
      return null;
    }
    return { kind: 'info', text: state.message };
  }
  if (state.status === 'failed') {
    return { kind: 'error', text: state.message };
  }
  return null;
}

/**
 * 状态提示的去重键：同一会话的同一个提示不重复弹。
 *
 * 退避秒数进键：同一档退避只弹一次，档位变了才弹新的一条。
 * 结束原因也进键：同一会话先「正常结束」后「主动关闭」是两条不同的提示，
 * 不能互相顶掉。
 */
export function feedbackKey(state: TerminalState): string {
  if (state.status === 'closed') {
    return `closed:${state.exitReason ?? 'unknown'}:${state.exitCode ?? 'unknown'}`;
  }
  if (state.status === 'reconnecting') {
    return `reconnecting:${state.retryDelaySeconds ?? 'pending'}`;
  }
  if (state.status === 'failed') {
    return 'failed';
  }
  return `${state.status}:${state.message}`;
}

/** 提示去重登记表：会话标识 → 该会话已提示过的键集合。 */
export type FeedbackLedger = Map<string, Set<string>>;

/** 空的去重登记表。 */
export function createFeedbackLedger(): FeedbackLedger {
  return new Map<string, Set<string>>();
}

/**
 * 登记并判断这条提示该不该弹。
 *
 * 返回 true = 该弹（同时已登记）；false = 同一会话的同一条提示已经弹过。
 */
export function claimFeedback(
  ledger: FeedbackLedger,
  sessionId: string,
  key: string,
): boolean {
  const warned = ledger.get(sessionId) ?? new Set<string>();
  if (warned.has(key)) {
    return false;
  }
  warned.add(key);
  ledger.set(sessionId, warned);
  return true;
}

/**
 * 连接恢复：清掉该会话的「已提示过」记录，下一轮失败能重新提示。
 */
export function clearFeedback(ledger: FeedbackLedger, sessionId: string): void {
  ledger.delete(sessionId);
}
