import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '../api/client';
import type { TerminalSessionRecord } from '../api/types';
import { TerminalView } from './TerminalView';
import type { TerminalStatus } from './TerminalView';

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

/**
 * 终端标签序号：单调递增的全局计数器。
 *
 * 用「当前标签数 + 1」当标题，关掉中间的标签后会与剩下的标签重名；
 * 计数器只增不减，重名就不会再发生。
 */
let terminalTabSeq = 0;

function nextTerminalTitle(): string {
  terminalTabSeq += 1;
  return `终端 ${terminalTabSeq}`;
}

interface TerminalTab {
  /** 会话标识（服务端生成，重连时原样带回）。 */
  id: string;
  title: string;
  status: TerminalStatus;
  message: string;
}

/** 会话状态：运行中 / 已退出 / 已失效。 */
const SESSION_STATE_RUNNING = 'running';
const SESSION_STATE_EXITED = 'exited';
const SESSION_STATE_INVALID = 'invalid';

/**
 * 删除动作的按钮文案。
 *
 * 运行中的会话要先关掉（会终止容器内的现场），已退出的会话直接移除记录。
 */
function removeActionLabel(state: string): string {
  return state === SESSION_STATE_RUNNING ? '关闭' : '移除';
}

/**
 * 一个会话的状态。
 *
 * 后端会话表里的状态为准；标签自己报的「已结束」也算已退出（会话表可能还没
 * 刷新到），「会话失效」说明后端已经没有这个会话了。
 */
function resolveSessionState(
  sessionId: string,
  status: TerminalStatus | undefined,
  known: Map<string, string>,
): string {
  if (status === 'closed') {
    return SESSION_STATE_EXITED;
  }
  if (status === 'invalid') {
    return SESSION_STATE_INVALID;
  }
  return known.get(sessionId) ?? SESSION_STATE_RUNNING;
}

interface TerminalPanelProps {
  sandboxName: string;
  /** 沙箱是否在运行：停止的沙箱起不了终端会话。 */
  sandboxRunning: boolean;
}

/**
 * 网页终端面板。
 *
 * 一个沙箱可以开多个终端标签，每个标签一个独立会话（容器内一个带真实 TTY 的 shell）。
 * 标签关闭只断开浏览器连接，容器内的进程继续跑，重新附着同一 `session_id` 就能恢复现场。
 */
export function TerminalPanel({ sandboxName, sandboxRunning }: TerminalPanelProps) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [existing, setExisting] = useState<TerminalSessionRecord[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** 正在等确认的会话标识（运行中的会话要先确认再关）。 */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  /** 正在删除的会话标识：删除期间禁用相关按钮。 */
  const [removingId, setRemovingId] = useState<string | null>(null);
  /** 每个标签的重试令牌：手动点重试时自增，终端视图据此重建连接。 */
  const [retryTokens, setRetryTokens] = useState<Record<string, number>>({});

  const refreshExisting = useCallback(async () => {
    try {
      const records = await api.listTerminalSessions(sandboxName);
      setExisting(records);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : '读取终端会话列表失败');
    }
  }, [sandboxName]);

  useEffect(() => {
    void refreshExisting();
  }, [refreshExisting]);

  const createTerminal = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const session = await api.createTerminalSession(sandboxName, 80, 24);
      const tab: TerminalTab = {
        id: session.session_id,
        title: nextTerminalTitle(),
        status: 'connecting',
        message: '正在连接终端会话…',
      };
      setTabs((previous) => [...previous, tab]);
      setActiveTabId(tab.id);
      await refreshExisting();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : '新建终端会话失败');
    } finally {
      setBusy(false);
    }
  }, [sandboxName, refreshExisting]);

  const attachExisting = useCallback((record: TerminalSessionRecord) => {
    // 标题在更新函数外算好：更新函数必须是纯的（开发模式下会被重复调用）。
    const title = nextTerminalTitle();
    setTabs((previous) => {
      if (previous.some((tab) => tab.id === record.session_id)) {
        return previous;
      }
      return [
        ...previous,
        {
          id: record.session_id,
          title,
          status: 'connecting' as TerminalStatus,
          message: '正在重新附着已有会话…',
        },
      ];
    });
    setActiveTabId(record.session_id);
  }, []);

  const closeTab = useCallback((tabId: string) => {
    setTabs((previous) => previous.filter((tab) => tab.id !== tabId));
  }, []);

  /** 删除一个会话：后端先关掉再删记录，成功后标签与列表项都消失。 */
  const removeSession = useCallback(
    async (sessionId: string) => {
      setRemovingId(sessionId);
      setError('');
      try {
        await api.deleteTerminalSession(sessionId);
        setTabs((previous) => previous.filter((tab) => tab.id !== sessionId));
        setConfirmingId(null);
        await refreshExisting();
      } catch (exc) {
        setError(exc instanceof Error ? exc.message : '删除终端会话失败');
      } finally {
        setRemovingId(null);
      }
    },
    [refreshExisting],
  );

  /**
   * 点删除按钮：运行中的会话先轻确认一下（会终止容器内的现场），
   * 已退出的会话直接执行。
   */
  const requestRemove = useCallback(
    (sessionId: string, state: string) => {
      if (state === SESSION_STATE_RUNNING) {
        setConfirmingId(sessionId);
        return;
      }
      void removeSession(sessionId);
    },
    [removeSession],
  );

  /** 手动重试：令牌自增，终端视图重建连接并把失败计数清零。 */
  const retryTab = useCallback((tabId: string) => {
    setRetryTokens((previous) => ({
      ...previous,
      [tabId]: (previous[tabId] ?? 0) + 1,
    }));
  }, []);

  // 活动标签被关掉后自动落到剩下的第一个。
  useEffect(() => {
    if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) {
      return;
    }
    setActiveTabId(tabs[0]?.id ?? null);
  }, [tabs, activeTabId]);

  const updateTabState = useCallback(
    (tabId: string, status: TerminalStatus, message: string) => {
      setTabs((previous) =>
        previous.map((tab) => (tab.id === tabId ? { ...tab, status, message } : tab)),
      );
      if (status === 'closed') {
        // 会话退出了：刷新会话表，列表状态与按钮文案跟着变
        void refreshExisting();
      }
    },
    [refreshExisting],
  );

  /** 会话表里的状态（会话标识 → 状态）。 */
  const knownStates = useMemo(() => {
    const map = new Map<string, string>();
    for (const record of existing) {
      map.set(record.session_id, record.state);
    }
    return map;
  }, [existing]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  /** 提示条的样式：告警与失败各有各的样式，不跟正常状态混用。 */
  const messageClass =
    activeTab === null
      ? 'hint'
      : activeTab.status === 'warning'
        ? 'hint hint-warning'
        : activeTab.status === 'failed' || activeTab.status === 'invalid'
          ? 'hint hint-error'
          : 'hint';

  return (
    <section className="panel terminal-panel" data-testid="page-sandbox-detail-terminal-panel">
      <div className="panel-header">
        <h2 className="panel-title">网页终端</h2>
        <div className="panel-header-actions">
          <span className="terminal-status" data-testid="page-sandbox-detail-terminal-status">
            {activeTab ? STATUS_LABEL[activeTab.status] : '未打开终端'}
          </span>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void createTerminal()}
            disabled={busy || !sandboxRunning}
            data-testid="page-sandbox-detail-terminal-new-button"
          >
            {busy ? '正在新建…' : '新建终端'}
          </button>
        </div>
      </div>

      {error && (
        <div className="banner banner-error" role="alert" data-testid="page-sandbox-detail-terminal-error">
          {error}
        </div>
      )}
      {!sandboxRunning && (
        <p className="hint" data-testid="page-sandbox-detail-terminal-stopped-hint">
          沙箱当前未运行，无法新建终端会话。请先启动沙箱。
        </p>
      )}
      <p className={messageClass} data-testid="page-sandbox-detail-terminal-message">
        {activeTab?.message ?? '终端会话在浏览器断开后仍保留，重新附着同一会话可恢复现场。'}
      </p>
      {activeTab?.status === 'failed' && (
        <div className="form-actions">
          <button
            type="button"
            className="button button-small"
            onClick={() => retryTab(activeTab.id)}
            data-testid="page-sandbox-detail-terminal-retry-button"
          >
            重试连接
          </button>
        </div>
      )}

      {confirmingId && (
        <div
          className="terminal-confirm"
          role="alertdialog"
          aria-label="确认关闭终端会话"
          data-testid="page-sandbox-detail-terminal-remove-confirm"
        >
          <span className="terminal-confirm-text">
            关闭会终止容器内该会话的进程，终端现场不保留。确认关闭？
          </span>
          <button
            type="button"
            className="button button-small button-danger"
            onClick={() => void removeSession(confirmingId)}
            disabled={removingId === confirmingId}
            data-testid="page-sandbox-detail-terminal-remove-confirm-button"
          >
            {removingId === confirmingId ? '正在关闭…' : '确认关闭'}
          </button>
          <button
            type="button"
            className="button button-small"
            onClick={() => setConfirmingId(null)}
            disabled={removingId === confirmingId}
            data-testid="page-sandbox-detail-terminal-remove-cancel-button"
          >
            取消
          </button>
        </div>
      )}

      {existing.length > 0 && (
        <div className="terminal-existing">
          <p className="dialog-hint">后端保留的会话（可重新附着，也可删除）：</p>
          <ul className="terminal-existing-list" data-testid="page-sandbox-detail-terminal-existing-list">
            {existing.map((record) => (
              <li
                key={record.session_id}
                className="terminal-existing-item"
                data-testid="page-sandbox-detail-terminal-existing-item"
                data-session-id={record.session_id}
              >
                <span className="terminal-existing-id">{record.session_id.slice(0, 8)}</span>
                <span className="terminal-existing-state">{record.state}</span>
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => attachExisting(record)}
                  data-testid="page-sandbox-detail-terminal-existing-attach-button"
                >
                  附着
                </button>
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => requestRemove(record.session_id, record.state)}
                  disabled={removingId === record.session_id}
                  aria-label={`${removeActionLabel(record.state)}会话 ${record.session_id.slice(0, 8)}`}
                  data-testid="page-sandbox-detail-terminal-existing-remove-button"
                >
                  {removeActionLabel(record.state)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {tabs.length > 0 && (
        <div className="terminal-tabs" role="tablist" data-testid="page-sandbox-detail-terminal-tabs">
          {tabs.map((tab) => {
            const state = resolveSessionState(tab.id, tab.status, knownStates);
            const label = removeActionLabel(state);
            return (
              <span
                key={tab.id}
                className={tab.id === activeTabId ? 'terminal-tab terminal-tab-active' : 'terminal-tab'}
                data-testid="page-sandbox-detail-terminal-tab"
                data-session-id={tab.id}
              >
                <button
                  type="button"
                  className="terminal-tab-button"
                  onClick={() => setActiveTabId(tab.id)}
                  data-testid="page-sandbox-detail-terminal-tab-select"
                >
                  {tab.title}
                </button>
                {state !== SESSION_STATE_INVALID && (
                  <button
                    type="button"
                    className="terminal-tab-remove"
                    onClick={() => requestRemove(tab.id, state)}
                    disabled={removingId === tab.id}
                    aria-label={`${label}会话 ${tab.title}`}
                    data-testid="page-sandbox-detail-terminal-tab-remove-button"
                  >
                    {label}
                  </button>
                )}
                <button
                  type="button"
                  className="terminal-tab-close"
                  onClick={() => closeTab(tab.id)}
                  aria-label={`断开 ${tab.title}`}
                  data-testid="page-sandbox-detail-terminal-tab-close"
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}

      {tabs.map((tab) => (
        <div
          key={tab.id}
          className="terminal-host"
          style={{ display: tab.id === activeTabId ? 'block' : 'none' }}
        >
          <TerminalView
            sessionId={tab.id}
            active={tab.id === activeTabId}
            retryToken={retryTokens[tab.id] ?? 0}
            onStateChange={(state) => updateTabState(tab.id, state.status, state.message)}
          />
        </div>
      ))}
    </section>
  );
}
