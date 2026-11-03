import {
  Box,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Settings,
  Sun,
} from 'lucide-react';

import type { SandboxSummary } from '../../api/types';
import { cn } from '../../lib/cn';
import { useSidebarCollapsed } from '../../lib/sidebar-collapsed';
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
 *
 * **折叠能力**（侧栏自持 `useSidebarCollapsed`，不入路由、不入 URL）：
 * - 折叠态宽 56px（`w-14`），只留图标；宽度变化带过渡。
 * - **隐藏一律走样式切换（`hidden` / `sr-only`），DOM 不卸载**：
 *   「新建沙箱」按钮必须始终挂载（页面上有两个同名标识，取第一个）。
 * - 折叠态的图标按钮仍保留可访问名：按钮文字用 `sr-only` 收起来，
 *   折叠按钮另有随状态变化的 `aria-label` / `title`。
 * - **底部工具区永远贴底**（`mt-auto`）：它不依赖列表撑高——列表折叠收起后
 *   底部工具仍然贴在侧边栏底部，不会浮到顶部去。
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
  const { collapsed, toggle: toggleCollapsed } = useSidebarCollapsed();

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground',
        'transition-[width] duration-200',
        collapsed ? 'w-14' : 'w-[264px]',
      )}
      data-testid="page-layout-sidebar"
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      {/* 品牌 */}
      <div
        className={cn(
          'flex items-center gap-2.5 px-4 pt-4 pb-3',
          collapsed && 'justify-center px-0',
        )}
      >
        <div className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-primary text-primary-foreground">
          <Box className="size-4" aria-hidden="true" />
        </div>
        <div className={cn('min-w-0 flex-1', collapsed && 'hidden')}>
          <div
            className={cn(
              'truncate text-[13px] leading-tight font-semibold',
              collapsed && 'hidden',
            )}
            data-testid="page-layout-title"
          >
            沙箱控制台
          </div>
        </div>
      </div>

      {/* 新建沙箱（折叠态只留图标，文字用 sr-only 收起来：按钮始终挂载） */}
      <div className={cn('px-3 pb-3', collapsed && 'px-2')}>
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
          <span className={collapsed ? 'sr-only' : undefined}>新建沙箱</span>
        </button>
      </div>

      {/* 列表头（折叠态整块收起：DOM 保留，只切样式） */}
      <div
        className={cn(
          'flex items-center justify-between gap-2 px-4 py-2 text-[11px] tracking-[0.06em] text-sidebar-muted',
          collapsed && 'hidden',
        )}
      >
        <span className="flex items-center gap-1.5">
          <span className={collapsed ? 'hidden' : undefined} data-testid="page-sandbox-list-title">
            沙箱列表
          </span>
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
            collapsed && 'hidden',
          )}
        >
          <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} aria-hidden="true" />
        </button>
      </div>

      {/* 沙箱列表（折叠态整块收起：DOM 保留，只切样式） */}
      <nav
        className={cn(
          'min-h-0 flex-1 overflow-y-auto px-2 pb-2',
          collapsed && 'hidden',
        )}
      >
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

      {/*
        底部：健康自检 + 设置 + 主题切换 + 侧栏折叠。

        `mt-auto`：这块永远贴在侧边栏底部。列表（`nav`）折叠时被整体隐藏，
        不再是那个把底部工具压到底部的弹性元素——没有这条约束，折叠后
        健康状态点 / 设置 / 主题切换 / 折叠按钮会一起浮到顶部去。
      */}
      <div className="mt-auto space-y-0.5 border-t border-sidebar-border px-3 py-2.5">
        <div
          className={cn(
            'flex items-center gap-2 px-2 pb-2 text-[11px] text-sidebar-muted',
            collapsed && 'justify-center px-0',
          )}
          title="GET /api/health 轮询结果"
          // 折叠态文字收起来了，可访问名不能跟着丢：辅助技术读的是这句 aria-label。
          aria-label={`后端健康：${health.text}`}
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
          <span
            className={cn('truncate', collapsed && 'sr-only')}
            // 折叠态文字不可见，但**不能从可访问树里消失**：
            // `sr-only` 只做视觉隐藏，辅助技术照读得到健康文案。
          >
            {health.text}
          </span>
        </div>
        <button
          type="button"
          onClick={onSettingsClick}
          data-testid="page-layout-settings-button"
          className={cn(
            'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-sidebar-foreground',
            'transition-colors hover:bg-sidebar-hover',
            'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
            collapsed && 'justify-center',
          )}
        >
          <Settings className="size-4 shrink-0 opacity-80" aria-hidden="true" />
          <span className={cn('flex-1 text-left', collapsed && 'sr-only')}>设置</span>
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
            collapsed && 'justify-center',
          )}
        >
          {dark ? (
            <Moon className="size-4 shrink-0 opacity-80" aria-hidden="true" />
          ) : (
            <Sun className="size-4 shrink-0 opacity-80" aria-hidden="true" />
          )}
          <span className={cn('flex-1 text-left', collapsed && 'sr-only')}>
            {dark ? '深色模式' : '浅色模式'}
          </span>
        </button>
        <button
          type="button"
          onClick={toggleCollapsed}
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
          data-testid="page-layout-sidebar-collapse-button"
          className={cn(
            'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-sidebar-foreground',
            'transition-colors hover:bg-sidebar-hover',
            'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
            collapsed && 'justify-center',
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4 shrink-0 opacity-80" aria-hidden="true" />
          ) : (
            <PanelLeftClose className="size-4 shrink-0 opacity-80" aria-hidden="true" />
          )}
          <span className={cn('flex-1 text-left', collapsed && 'sr-only')}>
            {collapsed ? '展开侧栏' : '收起侧栏'}
          </span>
        </button>
      </div>
    </aside>
  );
}
