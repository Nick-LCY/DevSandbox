/**
 * 终端面板「当前选中会话」的解析。
 *
 * 背景：标签条的数据源是后端会话表（每 10 秒轻轮询一次），路由里还带着
 * 「当前会话」这一段。会话表与路由指定的会话在两次轮询之间可能对不上：
 * 会话刚被别人关掉、刚被建出来、或者这一轮读取失败。
 *
 * 旧口径是「路由指定的会话不在表里就落到第一个标签」，于是选中的会话会在
 * 两次轮询之间来回跳，每跳一次终端就整块重挂载一次（焦点也跟着反复丢）。
 *
 * 口径：
 *
 * - 路由指定的会话**在表里** → 就用它；
 * - 不在表里且**会话表还不可信**（首轮还没读到 / 这一轮读取失败）→
 *   沿用上一轮选中的会话；标签表也不清空（标签由「最近一次成功的会话表」派生）；
 * - 不在表里且**会话表是权威的**（这一轮读到了）→ 会话真的消失了，
 *   回落**一次**到第一个标签，并把回落结果同步回路由（不同步的话，
 *   下一轮轮询又会跳回去）；
 * - 一个标签都没有 → 没有选中会话（null）。
 */

/**
 * 会话表这一轮的状态。
 *
 * - `pending`：还没读到（首轮加载中 / 刚换沙箱）——表不可信，不能据此改路由；
 * - `ok`：读到了——表是权威的，路由指定的会话不在表里就是真没了；
 * - `failed`：读取失败——表不可信，沿用上一轮选中的会话。
 */
export type TerminalRefreshState = 'pending' | 'ok' | 'failed';

/** 一次选中会话解析的输入。 */
export interface TerminalActiveInput {
  /** 路由指定的会话标识（路由没带就是 null）。 */
  routeSessionId: string | null;
  /** 本轮会话表里的会话标识（按标签顺序）。 */
  tableSessionIds: string[];
  /** 上一轮选中的会话标识（表不可信时沿用它）。 */
  lastActiveId: string | null;
  /** 会话表这一轮的状态。 */
  refreshState: TerminalRefreshState;
}

/** 一次选中会话解析的结果。 */
export interface TerminalActiveResult {
  /** 选中的会话标识（null = 没有会话）。 */
  activeId: string | null;
  /** 要不要把回落结果同步回路由。 */
  syncRoute: boolean;
}

/**
 * 解析当前选中的终端会话。
 *
 * 见文件头的口径说明。返回的 `syncRoute` 为真时，调用方要把
 * `activeId` 写回路由（否则路由还指着那个已经消失的会话，下一轮轮询会再跳一次）。
 */
export function resolveActiveSession(input: TerminalActiveInput): TerminalActiveResult {
  const { routeSessionId, tableSessionIds, lastActiveId, refreshState } = input;

  // 路由指定的会话还在表里：就用它。
  if (routeSessionId !== null && tableSessionIds.includes(routeSessionId)) {
    return { activeId: routeSessionId, syncRoute: false };
  }

  // 路由没指定会话：表里有就选第一个（与既有口径一致），没有就没有选中会话。
  if (routeSessionId === null) {
    return { activeId: tableSessionIds[0] ?? null, syncRoute: false };
  }

  // 路由指定的会话不在表里：看会话表这一轮可不可信。
  if (refreshState !== 'ok') {
    // 表不可信（首轮还没读到 / 这一轮读取失败）：沿用上一轮选中的会话，
    // 不跳走——跳一次就是一次终端重挂载，焦点也跟着丢一次。
    // 没有上一轮就退到第一个标签。
    return { activeId: lastActiveId ?? tableSessionIds[0] ?? null, syncRoute: false };
  }

  // 表是权威的：会话真的消失了 → 回落一次到第一个标签，并同步回路由。
  const fallback = tableSessionIds[0] ?? null;
  return { activeId: fallback, syncRoute: fallback !== routeSessionId };
}
