import { Maximize, Minimize, Plus, X } from 'lucide-react';

import obsidianLogoUrl from '../../assets/brand/obsidian.svg';
import { cn } from '../../lib/cn';
import type { WorkspaceTabKind } from '../../lib/file-pane';

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
  /** 终端是否处于全屏（面板覆盖整页）。 */
  fullscreen: boolean;
  /** 当前激活的工作区 tab 类型（固定 Obsidian tab 与终端会话 tab 二选一）。 */
  activeTabKind: WorkspaceTabKind;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onNew: () => void;
  /** 切到某个工作区 tab。 */
  onSelectTabKind: (kind: WorkspaceTabKind) => void;
  /** 切换全屏：退出全屏就是再点同一个按钮。 */
  onToggleFullscreen: () => void;
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
 *
 * **最左是固定的 Obsidian tab**（06 轮）：图标是 Obsidian 官方 logo SVG
 * （本地资产，运行时零 CDN）、**不可关闭、无关闭按钮**，且**独立于终端会话**
 * 存在——没有任何终端会话时仍然可用。
 */
export function TerminalTabs({
  tabs,
  activeId,
  statusLabel,
  busy,
  sandboxRunning,
  fullscreen,
  activeTabKind,
  onSelect,
  onClose,
  onNew,
  onSelectTabKind,
  onToggleFullscreen,
}: TerminalTabsProps) {
  const terminalActive = activeTabKind === 'terminal';
  return (
    <div className="flex h-[42px] items-center justify-between gap-4 border-b border-border bg-card px-6">
      <div
        role="tablist"
        className="flex h-full min-w-0 items-end gap-0.5 overflow-x-auto"
        data-testid="page-sandbox-detail-terminal-tabs"
      >
        {/*
          固定 Obsidian tab：**tabs 条最左**、**不可关闭（没有关闭按钮）**，
          与终端会话无关（零会话时照样可用）。

          图标用 `img` 引本地 SVG 资产：该 SVG 内含 `logo-*` 渐变 id，
          内联多副本会 ID 冲突，走图片引用最省事，且运行时零 CDN。
        */}
        <span
          role="tab"
          aria-selected={activeTabKind === 'obsidian'}
          data-testid="page-sandbox-detail-obsidian-tab"
          data-active={activeTabKind === 'obsidian' ? 'true' : 'false'}
          className={cn(
            'group inline-flex h-8 shrink-0 items-center gap-1.5 rounded-t-lg px-2.5 text-[13px]',
            'border-b-2 transition-colors',
            activeTabKind === 'obsidian'
              ? 'border-primary font-medium text-foreground'
              : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          <button
            type="button"
            onClick={() => onSelectTabKind('obsidian')}
            data-testid="page-sandbox-detail-obsidian-tab-select"
            className="inline-flex items-center gap-1.5 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <img
              src={obsidianLogoUrl}
              alt=""
              aria-hidden="true"
              data-testid="page-sandbox-detail-obsidian-tab-icon"
              className="size-[14px] shrink-0"
            />
            Obsidian
          </button>
        </span>
        {tabs.length === 0 && terminalActive && (
          <span
            className={cn(
              'group inline-flex h-8 shrink-0 items-center gap-1.5 rounded-t-lg px-2.5 text-[13px]',
              'border-b-2 transition-colors',
              'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            暂无终端会话
          </span>
        )}
        {tabs.map((tab) => {
          // 激活 Obsidian tab 时终端标签一律不显示「激活」态（highlight 只属于当前 tab）。
          const active = terminalActive && tab.id === activeId;
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
        {/*
          全屏开关：面板覆盖整页 / 回到常规布局。
          状态文案一个字不动，全屏按钮另起一个图标按钮（不占状态文案的位置）。

          ARIA 语义是「动作名随状态变化的普通按钮」：**不带 `aria-pressed`**
          （它不是开关，是两个动作），可访问名与 `title` 随状态切换
          （「全屏终端」↔「退出全屏」）。
        */}
        <button
          type="button"
          onClick={onToggleFullscreen}
          aria-label={fullscreen ? '退出全屏' : '全屏终端'}
          title={fullscreen ? '退出全屏' : '全屏终端'}
          data-testid="page-sandbox-detail-terminal-fullscreen-button"
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors',
            'hover:bg-muted hover:text-foreground',
            'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
          )}
        >
          {fullscreen ? (
            <Minimize className="size-3.5" aria-hidden="true" />
          ) : (
            <Maximize className="size-3.5" aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}
