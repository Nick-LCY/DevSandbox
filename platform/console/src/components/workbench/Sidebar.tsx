import { Box, Moon, Plus, RefreshCw, Settings, Sun } from 'lucide-react';

import type { SandboxSummary } from '../../api/types';
import { cn } from '../../lib/cn';
import { useTheme } from '../../lib/theme';
import type { HealthView } from './AppShell';
import { SandboxList } from './SandboxList';

interface SidebarProps {
  sandboxes: SandboxSummary[];
  selectedName: string | null;
  health: HealthView;
  onSelectSandbox: (name: string) => void;
  onCreateClick: () => void;
  /** 打开设置抽屉（代理设置 + 启动模板管理）。 */
  onSettingsClick: () => void;
  /** 列表正在首次加载。 */
  loading: boolean;
  onRefresh: () => void;
  refreshing: boolean;
}

/**
 * 左侧边栏：品牌 → 新建沙箱 → 列表头 → 沙箱列表 → 底部工具。
 *
 * 侧栏两套主题下都是深常青绿（sidebar 系列令牌），是整页的视觉锚点。
 */
export function Sidebar({
  sandboxes,
  selectedName,
  health,
  onSelectSandbox,
  onCreateClick,
  onSettingsClick,
  loading,
  onRefresh,
  refreshing,
}: SidebarProps) {
  const { theme, toggle } = useTheme();
  const dark = theme === 'dark';

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      {/* 品牌 */}
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-primary text-primary-foreground">
          <Box className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[13px] leading-tight font-semibold"
            data-testid="page-layout-title"
          >
            沙箱控制台
          </div>
        </div>
      </div>

      {/* 新建沙箱 */}
      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={onCreateClick}
          data-testid="page-sandbox-list-create-button"
          className={cn(
            'inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-transparent',
            'bg-primary text-[13px] font-medium text-primary-foreground transition-colors',
            'hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
          )}
        >
          <Plus className="size-4" aria-hidden="true" />
          新建沙箱
        </button>
      </div>

      {/* 列表头 */}
      <div className="flex items-center justify-between gap-2 px-4 py-2 text-[11px] tracking-[0.06em] text-sidebar-muted">
        <span className="flex items-center gap-1.5">
          <span data-testid="page-sandbox-list-title">沙箱列表</span>
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          title="刷新沙箱列表"
          aria-label="刷新沙箱列表"
          data-testid="page-sandbox-list-refresh-button"
          className={cn(
            'grid size-6 place-items-center rounded-md text-sidebar-muted transition-colors',
            'hover:bg-sidebar-hover hover:text-sidebar-foreground',
            'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
            'disabled:pointer-events-none disabled:opacity-50',
          )}
        >
          <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} aria-hidden="true" />
        </button>
      </div>

      {/* 沙箱列表 */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading && sandboxes.length === 0 && (
          <p className="px-2 py-3 text-[12px] text-sidebar-muted" data-testid="page-sandbox-list-loading">
            正在读取沙箱列表…
          </p>
        )}
        <SandboxList
          sandboxes={sandboxes}
          selectedName={selectedName}
          onSelect={onSelectSandbox}
        />
      </nav>

      {/* 底部：健康自检 + 设置 + 主题切换 */}
      <div className="space-y-0.5 border-t border-sidebar-border px-3 py-2.5">
        <div
          className="flex items-center gap-2 px-2 pb-2 text-[11px] text-sidebar-muted"
          title="GET /api/health 轮询结果"
          data-testid="page-layout-health"
          data-health-state={health.state}
        >
          <span
            aria-hidden="true"
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              health.state === 'ok'
                ? 'bg-success'
                : health.state === 'checking'
                  ? 'bg-status-busy animate-status-pulse'
                  : 'bg-destructive',
            )}
          />
          <span className="truncate">{health.text}</span>
        </div>
        <button
          type="button"
          onClick={onSettingsClick}
          data-testid="page-layout-settings-button"
          className={cn(
            'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-sidebar-foreground',
            'transition-colors hover:bg-sidebar-hover',
            'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
          )}
        >
          <Settings className="size-4 shrink-0 opacity-80" aria-hidden="true" />
          <span className="flex-1 text-left">设置</span>
        </button>
        <button
          type="button"
          onClick={toggle}
          title={dark ? '切换到浅色模式' : '切换到深色模式'}
          data-testid="page-layout-theme-toggle"
          className={cn(
            'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-sidebar-foreground',
            'transition-colors hover:bg-sidebar-hover',
            'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
          )}
        >
          {dark ? (
            <Moon className="size-4 shrink-0 opacity-80" aria-hidden="true" />
          ) : (
            <Sun className="size-4 shrink-0 opacity-80" aria-hidden="true" />
          )}
          <span className="flex-1 text-left">{dark ? '深色模式' : '浅色模式'}</span>
        </button>
      </div>
    </aside>
  );
}
