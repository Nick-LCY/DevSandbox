import type { ReactNode } from 'react';

import type { SandboxSummary } from '../../api/types';
import { Sidebar } from './Sidebar';

/** 后端健康自检的展示状态。 */
export type HealthState = 'checking' | 'ok' | 'degraded' | 'down';

/** 健康自检的展示状态与文案。 */
export interface HealthView {
  state: HealthState;
  text: string;
}

interface AppShellProps {
  sandboxes: SandboxSummary[];
  /** 当前选中的沙箱名（没选中时为 null）。 */
  selectedName: string | null;
  health: HealthView;
  onSelectSandbox: (name: string) => void;
  onCreateClick: () => void;
  /** 打开设置抽屉（代理设置 + 启动模板管理）。 */
  onSettingsClick: () => void;
  /** 列表正在首次加载。 */
  loading: boolean;
  /** 手动刷新沙箱列表。 */
  onRefresh: () => void;
  /** 列表正在刷新（禁用刷新按钮）。 */
  refreshing: boolean;
  children: ReactNode;
}

/**
 * 工作台外壳：左侧边栏（品牌 / 新建 / 沙箱列表 / 底部工具）+ 右侧工作区。
 *
 * 根元素带 `data-console-shell`：选中态与 color-scheme 收在这个标记下，
 * 只对新外壳生效（见 src/styles/globals.css 头部说明第 4 条）。
 */
export function AppShell({
  sandboxes,
  selectedName,
  health,
  onSelectSandbox,
  onCreateClick,
  onSettingsClick,
  loading,
  onRefresh,
  refreshing,
  children,
}: AppShellProps) {
  return (
    <div
      data-console-shell=""
      className="flex h-screen overflow-hidden bg-background text-foreground"
    >
      <Sidebar
        sandboxes={sandboxes}
        selectedName={selectedName}
        health={health}
        onSelectSandbox={onSelectSandbox}
        onCreateClick={onCreateClick}
        onSettingsClick={onSettingsClick}
        loading={loading}
        onRefresh={onRefresh}
        refreshing={refreshing}
      />
      <main className="flex min-w-0 flex-1 flex-col bg-background">{children}</main>
    </div>
  );
}
