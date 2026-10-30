import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '../api/client';
import type { TerminalSessionRecord } from '../api/types';
import { TerminalView, type TerminalStatus } from './TerminalView';
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
  /** 当前标签的连接状态。 */
  const [activeStatus, setActiveStatus] = useState<TerminalStatus>('connecting');
  /** 当前标签的状态文案。 */
  const [activeMessage, setActiveMessage] = useState('');
  const [error, setError] = useState('');
  /** 提示位：删除成功但有副作用（记录已不存在 / 关闭流程未走完 / 列表刷新失败）。 */
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  /** 正在等确认的会话（关标签时弹确认）。 */
  const [closing, setClosing] = useState<{ sessionId: string; running: boolean } | null>(null);
  /** 删除进行中：确认按钮禁用，弹窗不接受关闭。 */
  const [closingBusy, setClosingBusy] = useState(false);
  /** 每个会话的重试令牌：手动点重试时自增，终端视图据此重建连接。 */
  const [retryTokens, setRetryTokens] = useState<Record<string, number>>({});

  /** 刷新会话列表；返回失败原因（成功返回 null）。 */
  const refresh = useCallback(async (): Promise<string | null> => {
    try {
      const list = await api.listTerminalSessions(sandboxName);
      setSessionTable({ sandboxName, records: list });
      return null;
    } catch (exc) {
      return exc instanceof Error ? exc.message : '读取终端会话列表失败';
    }
  }, [sandboxName]);

  useEffect(() => {
    setSessionTable({ sandboxName, records: [] });
    void refresh().then((failure) => {
      if (failure) {
        setError(failure);
      }
    });
  }, [refresh]);

  /** 标签：会话表按创建时间排序，序号即标签序号。 */
  const tabs = useMemo<TerminalTabItem[]>(
    () =>
      records.map((record, index) => ({
        id: record.session_id,
        title: `终端 ${index + 1}`,
        state: record.state === SESSION_STATE_RUNNING ? 'running' : 'exited',
      })),
    [records],
  );

  /** 当前选中的标签：路由指定的会话优先，路由没给（或已失效）时落到第一个。 */
  const activeId = useMemo(() => {
    if (activeSessionId && tabs.some((tab) => tab.id === activeSessionId)) {
      return activeSessionId;
    }
    return tabs[0]?.id ?? null;
  }, [activeSessionId, tabs]);

  const createTerminal = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const session = await api.createTerminalSession(sandboxName, 80, 24);
      const failure = await refresh();
      if (failure) {
        setError(failure);
      }
      // 新会话直接选中：路由带上会话标识，刷新页面也能回到这个终端。
      onActiveSessionChange(session.session_id);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : '新建终端会话失败');
    } finally {
      setBusy(false);
    }
  }, [sandboxName, refresh, onActiveSessionChange]);

  /**
   * 点标签尾的 ×：先算清楚这个会话是不是还在跑（决定确认弹窗的文案），
   * 再弹确认。运行中的会话关掉会终止容器内的现场，不能一点就删。
   */
  const requestClose = useCallback(
    (sessionId: string) => {
      const record = records.find((item) => item.session_id === sessionId);
      const recordRunning = record?.state === SESSION_STATE_RUNNING;
      // 保守口径：标签状态与后端记录任一 running 即按运行中处理。
      const tabRunning = sessionId === activeId ? tabSaysRunning(activeStatus) : false;
      setClosing({ sessionId, running: recordRunning || tabRunning });
    },
    [records, activeId, activeStatus],
  );

  /** 确认关闭：后端先关掉再删记录，成功后标签消失。 */
  const confirmClose = useCallback(async () => {
    if (!closing) {
      return;
    }
    const sessionId = closing.sessionId;
    setClosingBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api.deleteTerminalSession(sessionId);
      setClosing(null);
      // 标签立刻消失：记录已经被删掉了，列表刷新失败也不能让标签留着。
      setSessionTable((previous) => ({
        sandboxName: previous.sandboxName,
        records: previous.records.filter((item) => item.session_id !== sessionId),
      }));
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
        setNotice(notes.join('；'));
      }
      if (activeId === sessionId) {
        const next = tabs.find((tab) => tab.id !== sessionId);
        onActiveSessionChange(next?.id ?? null);
      }
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : '删除终端会话失败');
    } finally {
      setClosingBusy(false);
    }
  }, [closing, refresh, activeId, tabs, onActiveSessionChange]);

  /** 手动重试：令牌自增，终端视图重建连接并把失败计数清零。 */
  const retryActive = useCallback(() => {
    if (!activeId) {
      return;
    }
    setRetryTokens((previous) => ({
      ...previous,
      [activeId]: (previous[activeId] ?? 0) + 1,
    }));
  }, [activeId]);

  const statusLabel = activeId ? STATUS_LABEL[activeStatus] : '未打开终端';

  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      data-testid="page-sandbox-detail-terminal-panel"
    >
      <TerminalTabs
        tabs={tabs}
        activeId={activeId}
        statusLabel={statusLabel}
        busy={busy}
        sandboxRunning={sandboxRunning}
        onSelect={(sessionId) => onActiveSessionChange(sessionId)}
        onClose={requestClose}
        onNew={() => void createTerminal()}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {error && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive-soft px-3 py-2 text-[12.5px] text-destructive"
            data-testid="page-sandbox-detail-terminal-error"
          >
            {error}
          </div>
        )}
        {notice && (
          <div
            role="status"
            className="rounded-lg border border-info/30 bg-info-soft px-3 py-2 text-[12.5px] text-info"
            data-testid="page-sandbox-detail-terminal-notice"
          >
            {notice}
          </div>
        )}
        {!sandboxRunning && (
          <p className="text-[12.5px] text-muted-foreground" data-testid="page-sandbox-detail-terminal-stopped-hint">
            沙箱当前未运行，无法新建终端会话。请先启动沙箱。
          </p>
        )}
        <p
          className={
            activeStatus === 'warning'
              ? 'text-[12.5px] text-warning'
              : activeStatus === 'failed' || activeStatus === 'invalid'
                ? 'text-[12.5px] text-destructive'
                : 'text-[12.5px] text-muted-foreground'
          }
          data-testid="page-sandbox-detail-terminal-message"
        >
          {activeId
            ? activeMessage || '正在连接终端会话…'
            : '终端会话在浏览器断开后仍保留，重新点标签即可恢复现场。'}
        </p>
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
            active
            retryToken={retryTokens[activeId] ?? 0}
            onStateChange={(state) => {
              setActiveStatus(state.status);
              setActiveMessage(state.message);
            }}
          />
        ) : (
          // 没有会话时也留一个终端框：工作区不悬空，形状与真实终端一致。
          <div
            className="flex h-full min-h-0 items-center justify-center rounded-xl border border-border bg-terminal-bg p-3"
            data-testid="page-sandbox-detail-terminal-placeholder"
          >
            <span className="text-[12.5px] text-terminal-fg/60">
              {sandboxRunning ? '还没有终端会话，点右侧的 + 新建一个。' : '沙箱未运行，无法新建终端会话。'}
            </span>
          </div>
        )}
      </div>

      <CloseSessionDialog
        open={closing !== null}
        sessionId={closing?.sessionId ?? null}
        running={closing?.running ?? false}
        busy={closingBusy}
        onConfirm={() => void confirmClose()}
        onCancel={() => setClosing(null)}
      />
    </section>
  );
}
