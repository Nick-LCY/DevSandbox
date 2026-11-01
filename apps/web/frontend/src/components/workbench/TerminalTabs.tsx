import { Plus, X } from 'lucide-react';

import { cn } from '../../lib/cn';

/** 标签对应的会话状态。 */
export type TerminalTabState = 'running' | 'exited' | 'invalid';

/** 一个终端标签（= 后端的一个终端会话）。 */
export interface TerminalTabItem {
  /** 会话标识（服务端生成，重连时原样带回）。 */
  id: string;
  /** 标签标题（「终端 N」，N 是标签在会话列表里的序号）。 */
  title: string;
  /** 会话状态：运行中 / 已退出 / 已失效。 */
  state: TerminalTabState;
}

interface TerminalTabsProps {
  tabs: TerminalTabItem[];
  /** 当前选中的会话标识。 */
  activeId: string | null;
  /** 右侧状态文案（当前标签的连接状态）。 */
  statusLabel: string;
  /** 新建会话进行中。 */
  busy: boolean;
  /** 沙箱是否在运行：停止的沙箱起不了终端会话。 */
  sandboxRunning: boolean;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onNew: () => void;
}

/** 状态点的颜色：运行=绿，已退出=灰，已失效=红。 */
function dotClass(state: TerminalTabState): string {
  if (state === 'running') {
    return 'bg-status-running';
  }
  if (state === 'invalid') {
    return 'bg-status-failed';
  }
  return 'bg-status-stopped';
}

/**
 * 终端会话标签条。
 *
 * 标签就是后端的终端会话：一个标签一个会话，点标签即附着到该会话，
 * 标签尾的 × 关闭会话（会先弹确认）。
 */
export function TerminalTabs({
  tabs,
  activeId,
  statusLabel,
  busy,
  sandboxRunning,
  onSelect,
  onClose,
  onNew,
}: TerminalTabsProps) {
  return (
    <div className="flex h-[42px] items-center justify-between gap-4 border-b border-border bg-card px-6">
      <div
        role="tablist"
        className="flex h-full min-w-0 items-end gap-0.5 overflow-x-auto"
        data-testid="page-sandbox-detail-terminal-tabs"
      >
        {tabs.length === 0 && (
          <span               className={cn(
                'group inline-flex h-8 shrink-0 items-center gap-1.5 rounded-t-lg px-2.5 text-[13px]',
                'border-b-2 transition-colors',
                  'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
              )}>暂无终端会话</span>
        )}
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <span
              key={tab.id}
              role="tab"
              aria-selected={active}
              data-testid="page-sandbox-detail-terminal-tab"
              data-session-id={tab.id}
              data-active={active ? 'true' : 'false'}
              className={cn(
                'group inline-flex h-8 shrink-0 items-center gap-1.5 rounded-t-lg px-2.5 text-[13px]',
                'border-b-2 transition-colors',
                active
                  ? 'border-primary font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(tab.id)}
                data-testid="page-sandbox-detail-terminal-tab-select"
                className="inline-flex items-center gap-1.5 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <span
                  aria-hidden="true"
                  className={cn('size-[7px] shrink-0 rounded-full', dotClass(tab.state))}
                />
                {tab.title}
              </button>
              <button
                type="button"
                onClick={() => onClose(tab.id)}
                aria-label={`关闭 ${tab.title}`}
                data-testid="page-sandbox-detail-terminal-tab-close"
                className={cn(
                  'grid size-[18px] place-items-center rounded-[5px] text-faint transition-colors',
                  'hover:bg-destructive-soft hover:text-destructive',
                  'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                )}
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </span>
          );
        })}
        <button
          type="button"
          onClick={onNew}
          disabled={busy || !sandboxRunning}
          title={sandboxRunning ? '新建终端会话' : '沙箱未运行，无法新建终端会话'}
          aria-label="新建终端会话"
          data-testid="page-sandbox-detail-terminal-new-button"
          className={cn(
            'mb-0.5 grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors',
            'hover:bg-muted hover:text-foreground',
            'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
            'disabled:pointer-events-none disabled:opacity-50',
          )}
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-2 text-[11.5px] text-muted-foreground">
        <span data-testid="page-sandbox-detail-terminal-status">{statusLabel}</span>
      </div>
    </div>
  );
}
