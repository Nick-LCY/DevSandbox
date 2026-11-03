import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../api/client';
import type { TerminalSessionRecord } from '../api/types';
import { nextPollFailure } from '../lib/poll';
import { sessionNumbering, sortSessionsByCreation } from '../lib/sessions';
import { resolveActiveSession, type TerminalRefreshState } from '../lib/terminal-active';
import {
  claimFeedback,
  clearFeedback,
  createFeedbackLedger,
  feedbackForState,
  feedbackKey,
  type FeedbackLedger,
} from '../lib/terminal-feedback';
import {
  focusInsideTerminalSurface,
  isInsideTerminalSurface,
  resolveTerminalFocus,
} from '../lib/terminal-focus';
import { TerminalView, type TerminalState, type TerminalStatus } from './TerminalView';
import { useToast } from './Toast';
import { CloseSessionDialog } from './workbench/CloseSessionDialog';
import { TerminalTabs, type TerminalTabItem } from './workbench/TerminalTabs';

/** 状态标签文案。 */
const STATUS_LABEL: Record<TerminalStatus, string> = {
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  closed: '已结束',
  invalid: '会话失效',
  warning: '有告警',
  failed: '重连失败',
};

/** 后端会话表里的两种状态。 */
const SESSION_STATE_RUNNING = 'running';

/** 会话表的轻轮询间隔（毫秒）：让关闭确认弹窗拿到较新的会话状态。 */
const SESSION_POLL_INTERVAL = 10000;

/**
 * 标签视角的会话是不是还在跑。
 *
 * 标签报「已结束」或「会话失效」之外的状态（连接中 / 已连接 / 重连中 /
 * 告警 / 重连失败）都按「还在跑」处理：标签的状态可能滞后于后端。
 */
function tabSaysRunning(status: TerminalStatus | undefined): boolean {
  if (status === undefined) {
    return false;
  }
  return status !== 'closed' && status !== 'invalid';
}

/** 一个会话的连接状态。 */
interface SessionState {
  status: TerminalStatus;
  message: string;
}

interface TerminalPanelProps {
  sandboxName: string;
  /** 沙箱是否在运行：停止的沙箱起不了终端会话。 */
  sandboxRunning: boolean;
  /** 当前选中的终端会话标识（路由里的第三段）。 */
  activeSessionId: string | null;
  /** 选中终端会话发生变化（点标签、新建会话、关掉当前会话）。 */
  onActiveSessionChange: (sessionId: string | null) => void;
}

/**
 * 网页终端面板。
 *
 * 标签条的数据源就是后端的会话表（`GET /api/terminal/sessions?sandbox=<名>`）：
 * **一个标签就是一个后端会话**，没有第二份「后端保留会话」列表。
 *
 * - 点标签 = 附着到该会话（重新连上它的 WebSocket，服务端回放现场缓冲）；
 * - 标签尾的 × = 关闭会话（会终止容器内该会话的进程树），先弹确认；
 * - 关闭的是真会话：后端先关进程再删记录，标签随记录一起消失。
 */
export function TerminalPanel({
  sandboxName,
  sandboxRunning,
  activeSessionId,
  onActiveSessionChange,
}: TerminalPanelProps) {
  const { show } = useToast();
  /**
   * 后端会话表（标签条的数据源）。
   *
   * 连沙箱名一起存：切换沙箱的那一帧里，上一个沙箱的会话不能还挂在标签条上。
   */
  const [sessionTable, setSessionTable] = useState<{
    sandboxName: string;
    records: TerminalSessionRecord[];
  }>({ sandboxName, records: [] });
  const records = sessionTable.sandboxName === sandboxName ? sessionTable.records : [];
  /**
   * 每个会话的连接状态。
   *
   * 按会话标识存，不放单一状态：切换标签的瞬间，状态栏必须立刻反映新标签，
   * 不能还挂着上一个会话的「已连接」。
   */
  const [sessionStates, setSessionStates] = useState<Record<string, SessionState>>({});
  const [busy, setBusy] = useState(false);
  /**
   * 终端是否全屏（面板覆盖整页）。
   *
   * 只在本地：不入路由、不入 localStorage——刷新页面回到常规布局。
   */
  const [fullscreen, setFullscreen] = useState(false);
  /**
   * 会话表这一轮的状态（还没读到 / 读到了 / 读失败）。
   *
   * 读失败时表不可信：选中的会话要沿用上一轮（不能因为读不到就跳走，
   * 跳一次就是一次终端重挂载）。
   */
  const [refreshState, setRefreshState] = useState<TerminalRefreshState>('pending');
  /** 正在等确认的会话（关标签时弹确认）。 */
  const [closing, setClosing] = useState<{ sessionId: string; running: boolean } | null>(null);
  /** 删除进行中：确认按钮禁用，弹窗不接受关闭。 */
  const [closingBusy, setClosingBusy] = useState(false);
  /** 每个会话的重试令牌：手动点重试时自增，终端视图据此重建连接。 */
  const [retryTokens, setRetryTokens] = useState<Record<string, number>>({});
  /** 刷新令牌：自增。旧响应回来时令牌对不上，一律丢弃。 */
  const refreshTokenRef = useRef(0);
  /**
   * 上一轮选中的会话标识。
   *
   * 刷新失败时用它沿用选中（见 `src/lib/terminal-active.ts`）。
   */
  const lastActiveIdRef = useRef<string | null>(null);
  /**
   * 焦点回填意图：用户刚点了标签、点了终端表面或新建了会话时置 true，
   * 消费一次后清掉。
   */
  const focusIntentRef = useRef(false);
  /**
   * 焦点宿主：最后一次 `focusin` 的落点。
   *
   * 记它是为了认出「宿主已经被摘出 DOM」——终端重挂载时 xterm 的 helper
   * textarea 会被摘掉，浏览器把焦点复位到 body 且**不派发 `focusin`**，
   * 只靠事件跟踪记下来的标志会永远停在 true（门控退化成「永远回填」）。
   */
  const focusHostRef = useRef<Element | null>(null);
  /** 本沙箱的标签序号登记表：序号跟会话身份绑定，关掉标签不重排。 */
  const numbering = useMemo(() => sessionNumbering(sandboxName), [sandboxName]);
  /** 已弹过的状态提示（会话标识 → 提示键集合）：同一句话不重复弹。 */
  const warnedRef = useRef<FeedbackLedger>(createFeedbackLedger());
  /** 后台轮询连续失败次数：到阈值弹一条失败 toast，任一次成功即清零。 */
  const pollFailuresRef = useRef(0);

  /** 刷新会话列表；返回失败原因（成功返回 null）。 */
  const refresh = useCallback(async (): Promise<string | null> => {
    const token = refreshTokenRef.current + 1;
    refreshTokenRef.current = token;
    try {
      const list = await api.listTerminalSessions(sandboxName);
      if (token !== refreshTokenRef.current) {
        // 过期响应：已经有更新的刷新在飞，直接丢掉，别覆盖当前沙箱的标签条。
        return null;
      }
      // 首次见到的会话按创建时间顺序分配标签序号（之后不再变）。
      for (const record of sortSessionsByCreation(list)) {
        numbering.numberOf(record.session_id);
      }
      setSessionTable({ sandboxName, records: list });
      setRefreshState('ok');
      return null;
    } catch (exc) {
      if (token !== refreshTokenRef.current) {
        return null;
      }
      // 读失败：会话表保持上一轮成功的版本（标签不清空），
      // 只把「这一轮失败」记下来——选中会话据此沿用上一轮。
      setRefreshState('failed');
      return exc instanceof Error ? exc.message : '读取终端会话列表失败';
    }
  }, [sandboxName, numbering]);

  // 换沙箱：清空上一个沙箱的会话表与状态，重新拉一次。
  useEffect(() => {
    setSessionTable({ sandboxName, records: [] });
    setSessionStates({});
    setRetryTokens({});
    setRefreshState('pending');
    lastActiveIdRef.current = null;
    pollFailuresRef.current = 0;
    void refresh().then((failure) => {
      if (failure) {
        show('error', failure, { source: 'terminal-sessions' });
      }
    });
  }, [refresh, show]);

  // 轻轮询：会话表的变化（别的终端关掉了会话、后端回收了会话）能及时反映到标签条，
  // 关闭确认弹窗的「还在跑」判定也能拿到较新的记录。
  // 轮询失败逐次不弹（会刷屏）：连续 3 次失败弹一条，任一次成功即清零。
  useEffect(() => {
    const timer = window.setInterval(() => {
      // 页面不可见时不轮询：省一次往返，也不让后台标签页堆积请求。
      if (document.visibilityState !== 'visible') {
        return;
      }
      void refresh().then((failure) => {
        const step = nextPollFailure(pollFailuresRef.current, failure === null);
        pollFailuresRef.current = step.count;
        if (!step.shouldToast) {
          return;
        }
        show('error', `读取终端会话列表失败（连续 3 次轮询）：${failure}`, {
          source: 'terminal-sessions',
        });
      });
    }, SESSION_POLL_INTERVAL);
    return () => window.clearInterval(timer);
  }, [refresh, show]);

  /**
   * 换沙箱：退出全屏。
   *
   * 全屏是「当前沙箱终端」的局部状态：换沙箱时退出来，
   * 别让新沙箱的终端顶着一个覆盖整页的全屏面板。
   */
  useEffect(() => {
    setFullscreen(false);
  }, [sandboxName]);

  /**
   * 焦点跟踪：焦点宿主在哪、焦点在不在终端表面内。
   *
   * - `focusin`（冒泡到 document）：记下焦点宿主；焦点落在终端表面内就是
   *   「原位」，落到别处（抽屉输入框、其他控件）就把之前的回填意图作废——
   *   不能把焦点从抽屉输入框抢回终端；
   * - `pointerdown`：点在终端表面上就是一次明确意图（置 true，用完即消费）。
   */
  useEffect(() => {
    const handleFocusIn = (event: FocusEvent): void => {
      const inside = isInsideTerminalSurface(event.target);
      focusHostRef.current =
        event.target && typeof (event.target as Element).closest === 'function'
          ? (event.target as Element)
          : null;
      if (!inside) {
        focusIntentRef.current = false;
      }
    };
    const handlePointerDown = (event: PointerEvent): void => {
      if (isInsideTerminalSurface(event.target)) {
        focusIntentRef.current = true;
      }
    };
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, []);

  /**
   * 标签：会话表按创建时间定序，序号取自会话自己的登记号。
   *
   * 序号跟会话身份绑定：关掉中间一个标签，其余标签的序号不动。
   */
  const tabs = useMemo<TerminalTabItem[]>(
    () =>
      sortSessionsByCreation(records).map((record) => ({
        id: record.session_id,
        title: `终端 ${numbering.numberOf(record.session_id)}`,
        state: record.state === SESSION_STATE_RUNNING ? 'running' : 'exited',
      })),
    [records, numbering],
  );

  /**
   * 当前选中的标签。
   *
   * 口径在 `src/lib/terminal-active.ts`（纯函数，可单测）：路由指定的会话在表里
   * 就用它；不在表里且会话表还不可信（首轮还没读到 / 这一轮读失败）就沿用上一轮；
   * 不在表里且会话表是权威的（这一轮读到了，会话真消失）就回落一次到第一个标签，
   * 并把回落结果同步回路由——否则选中的会话会在两次轮询之间来回跳，
   * 每跳一次终端就重挂载一次。
   */
  const active = resolveActiveSession({
    routeSessionId: activeSessionId,
    tableSessionIds: tabs.map((tab) => tab.id),
    lastActiveId: lastActiveIdRef.current,
    refreshState,
  });
  const activeId = active.activeId;
  /**
   * 要不要把回落结果同步回路由（拆成原始值）。
   *
   * `active` 是每次渲染新建的对象，直接进依赖数组会让这个 effect 每次渲染
   * 都重跑一遍（虽然内容没变）。依赖改成原始值后，只有「该不该同步」或
   * 「同步哪个会话」真的变了才重跑。
   */
  const activeSyncRoute = active.syncRoute;

  /** 记下本轮选中的会话：下一轮刷新失败时用它沿用。 */
  useEffect(() => {
    lastActiveIdRef.current = activeId;
  });

  /** 回落结果同步回路由：会话真的消失了，路由得跟着走。 */
  useEffect(() => {
    if (!activeSyncRoute || activeId === activeSessionId) {
      return;
    }
    onActiveSessionChange(activeId);
  }, [activeSyncRoute, activeId, activeSessionId, onActiveSessionChange]);

  /**
   * 焦点回填的结论。
   *
   * 判定当下的焦点位置是**活读** `document.activeElement`（口径见
   * `src/lib/terminal-focus.ts`）：终端重挂载会把 helper textarea 摘出 DOM，
   * 浏览器把焦点复位到 body 且不派发 `focusin`——只靠事件跟踪记下来的标志
   * 会永远停在 true，门控退化成「永远回填」。
   *
   * 活读发生在渲染期：此刻旧终端还在 DOM 里，焦点宿主仍连着文档，
   * 读到的就是「重挂载前焦点在哪」。
   */
  const focusInside = focusInsideTerminalSurface(
    document.activeElement,
    focusHostRef.current,
  );
  const autoFocus = resolveTerminalFocus({
    intent: focusIntentRef.current,
    focusInsideTerminal: focusInside,
  });

  /** 回填意图只对下一次重挂载生效：终端挂上去之后就消费掉。 */
  useEffect(() => {
    focusIntentRef.current = false;
  }, [activeId]);

  /** 当前标签的连接状态：没有记录时按「连接中」算。 */
  const activeState = activeId ? sessionStates[activeId] : undefined;
  const activeStatus: TerminalStatus = activeState?.status ?? 'connecting';

  /**
   * 终端视图上报状态：存进会话状态表，并把需要告知用户的终态弹成 toast。
   *
   * 同一会话的同一条提示不重复弹（服务端可能反复推同一个 error 帧）；
   * 连接恢复后清掉记录，下一轮失败能重新提示。
   */
  const handleStateChange = useCallback(
    (sessionId: string, state: TerminalState) => {
      setSessionStates((previous) => ({ ...previous, [sessionId]: state }));
      const feedback = feedbackForState(state);
      if (!feedback) {
        // 连接恢复：清掉这个会话的「已提示过」记录，下一轮失败能重新提示。
        if (state.status === 'connected') {
          clearFeedback(warnedRef.current, sessionId);
        }
        return;
      }
      if (!claimFeedback(warnedRef.current, sessionId, feedbackKey(state))) {
        // 同一会话的同一条提示已经弹过了：不重复弹。
        return;
      }
      show(feedback.kind, feedback.text, { source: 'terminal-status' });
    },
    [show],
  );

  const createTerminal = useCallback(async () => {
    setBusy(true);
    try {
      const session = await api.createTerminalSession(sandboxName, 80, 24);
      const failure = await refresh();
      if (failure) {
        show('error', failure, { source: 'terminal-sessions' });
      }
      // 新会话直接选中：路由带上会话标识，刷新页面也能回到这个终端。
      // 新建会话是明确的用户操作意图：终端重挂载后要把焦点还给用户
      // （否则新终端成了看得见、敲不进 pty 的「空心光标」）。
      focusIntentRef.current = true;
      onActiveSessionChange(session.session_id);
    } catch (exc) {
      show('error', exc instanceof Error ? exc.message : '新建终端会话失败', {
        source: 'terminal-sessions',
      });
    } finally {
      setBusy(false);
    }
  }, [sandboxName, refresh, onActiveSessionChange, show]);

  /**
   * 点标签尾的 ×：先算清楚这个会话是不是还在跑（决定确认弹窗的文案），
   * 再弹确认。运行中的会话关掉会终止容器内的现场，不能一点就删。
   */
  const requestClose = useCallback(
    (sessionId: string) => {
      const record = records.find((item) => item.session_id === sessionId);
      const recordRunning = record?.state === SESSION_STATE_RUNNING;
      // 保守口径：标签状态与后端记录任一 running 即按运行中处理。
      const tabRunning = tabSaysRunning(sessionStates[sessionId]?.status);
      setClosing({ sessionId, running: recordRunning || tabRunning });
    },
    [records, sessionStates],
  );

  /** 确认关闭：后端先关掉再删记录，成功后标签消失。 */
  const confirmClose = useCallback(async () => {
    if (!closing) {
      return;
    }
    const sessionId = closing.sessionId;
    setClosingBusy(true);
    try {
      const result = await api.deleteTerminalSession(sessionId);
      setClosing(null);
      // 标签立刻消失：记录已经被删掉了，列表刷新失败也不能让标签留着。
      setSessionTable((previous) => ({
        sandboxName: previous.sandboxName,
        records: previous.records.filter((item) => item.session_id !== sessionId),
      }));
      setSessionStates((previous) => {
        const next = { ...previous };
        delete next[sessionId];
        return next;
      });
      const notes: string[] = [];
      if (!result.removed) {
        notes.push('记录已不存在（可能已被删除）');
      } else if (!result.closed) {
        notes.push('会话记录已删除，但关闭流程未走完（容器内可能仍有残留进程）');
      }
      // 删除本体已经成功：列表刷新失败单独提示，不覆盖成功语义
      const failure = await refresh();
      if (failure) {
        notes.push(`会话列表刷新失败：${failure}`);
      }
      if (notes.length > 0) {
        show('info', notes.join('；'), { source: 'terminal-sessions' });
      }
      if (activeId === sessionId) {
        const next = tabs.find((tab) => tab.id !== sessionId);
        onActiveSessionChange(next?.id ?? null);
      }
    } catch (exc) {
      show('error', exc instanceof Error ? exc.message : '删除终端会话失败', {
        source: 'terminal-sessions',
      });
    } finally {
      setClosingBusy(false);
    }
  }, [closing, refresh, activeId, tabs, onActiveSessionChange, show]);

  /** 手动重试：令牌自增，终端视图重建连接并把失败计数清零。 */
  const retryActive = useCallback(() => {
    if (!activeId) {
      return;
    }
    // 用户主动重试：清掉这个会话的「已提示过」记录，再失败时能重新提示。
    warnedRef.current.delete(activeId);
    setRetryTokens((previous) => ({
      ...previous,
      [activeId]: (previous[activeId] ?? 0) + 1,
    }));
  }, [activeId]);

  /**
   * 点标签：选会话 + 记一次焦点回填意图。
   *
   * 点标签后终端会整块重挂载（key 变了），浏览器焦点会落到标签按钮上——
   * 这次意图就是告诉终端「重挂载之后把焦点还给我」。
   */
  const selectSession = useCallback(
    (sessionId: string) => {
      focusIntentRef.current = true;
      onActiveSessionChange(sessionId);
    },
    [onActiveSessionChange],
  );

  /** 全屏开关：退出全屏就是再点同一个按钮（不绑 Esc / F11）。 */
  const toggleFullscreen = useCallback(() => {
    setFullscreen((previous) => !previous);
  }, []);

  const statusLabel = activeId ? STATUS_LABEL[activeStatus] : '未打开终端';

  return (
    <section
      className={
        fullscreen
          ? // 全屏：覆盖整页。**必须保留 flex 列布局**（面板内部是 flex 列：
            // 终端表面靠 flex-1 撑满剩余高度；少了它终端会缩成一小块）。
            'fixed inset-0 z-40 flex min-h-0 flex-col overflow-hidden bg-background'
          : 'flex min-h-0 flex-1 flex-col'
      }
      data-testid="page-sandbox-detail-terminal-panel"
    >
      <TerminalTabs
        tabs={tabs}
        activeId={activeId}
        statusLabel={statusLabel}
        busy={busy}
        sandboxRunning={sandboxRunning}
        fullscreen={fullscreen}
        onSelect={selectSession}
        onClose={requestClose}
        onNew={() => void createTerminal()}
        onToggleFullscreen={toggleFullscreen}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {activeId && activeStatus === 'failed' && (
          <div>
            <button
              type="button"
              onClick={retryActive}
              data-testid="page-sandbox-detail-terminal-retry-button"
              className="inline-flex h-7 items-center justify-center rounded-lg border border-border bg-card px-2.5 text-[12.5px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              重试连接
            </button>
          </div>
        )}

        {activeId ? (
          <TerminalView
            key={activeId}
            sessionId={activeId}
            retryToken={retryTokens[activeId] ?? 0}
            autoFocus={autoFocus}
            onStateChange={(state) => {
              handleStateChange(activeId, state);
            }}
          />
        ) : (
          // 没有会话时也留一个终端框：工作区不悬空，形状与真实终端一致。
          <div
            className="flex h-full min-h-0 items-center justify-center rounded-xl border border-border bg-terminal-bg p-3"
            data-testid="page-sandbox-detail-terminal-placeholder"
          >
            <span className="text-[12.5px] text-terminal-fg/60">
              {sandboxRunning ? '还没有终端会话，点上方的 + 新建一个。' : '沙箱未运行，无法新建终端会话。'}
            </span>
          </div>
        )}
      </div>

      <CloseSessionDialog
        open={closing !== null}
        running={closing?.running ?? false}
        busy={closingBusy}
        onConfirm={() => void confirmClose()}
        onCancel={() => setClosing(null)}
      />
    </section>
  );
}
