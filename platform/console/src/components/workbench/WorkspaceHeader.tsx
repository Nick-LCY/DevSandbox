import { Info, Play, RefreshCw, Square, Trash2 } from 'lucide-react';

import type { SandboxDetail } from '../../api/types';
import { cn } from '../../lib/cn';
import { formatTimestamp } from '../../lib/format';

interface WorkspaceHeaderProps {
  detail: SandboxDetail | null;
  /** 生命周期操作进行中（禁用按钮）。 */
  busy: boolean;
  stopDependencies: boolean;
  onStopDependenciesChange: (value: boolean) => void;
  onRefresh: () => void;
  onStart: () => void;
  onStop: () => void;
  onOpenDetail: () => void;
  onDelete: () => void;
}

/** 状态点的颜色：运行=绿，启动中 / 停止中=琥珀，已停止=灰，失败=红。 */
function stateClass(state: string): string {
  switch (state) {
    case 'running':
      return 'text-status-running';
    case 'starting':
    case 'stopping':
      return 'text-status-busy animate-status-pulse';
    case 'failed':
      return 'text-status-failed';
    default:
      return 'text-status-stopped';
  }
}

/**
 * 工作区头部：选中的沙箱摘要 + 生命周期操作。
 *
 * 完整字段（容器名 / 网络名 / 挂载 / 依赖容器等）在「详情」弹窗里看，
 * 头部只放一眼能扫到的三项：状态、镜像、时间。
 */
export function WorkspaceHeader({
  detail,
  busy,
  stopDependencies,
  onStopDependenciesChange,
  onRefresh,
  onStart,
  onStop,
  onOpenDetail,
  onDelete,
}: WorkspaceHeaderProps) {
  const running = detail?.state === 'running';

  const actionClass =
    'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[13px] ' +
    'text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 ' +
    'focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50';

  return (
    <header className="flex items-start justify-between gap-6 border-b border-border bg-card px-6 py-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h1
            className="truncate text-[18px] font-semibold tracking-[-0.01em]"
            data-testid="page-sandbox-detail-title"
          >
            {detail?.name ?? '—'}
          </h1>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5',
              'text-[11.5px]',
              stateClass(detail?.state ?? 'stopped'),
            )}
            data-testid="page-sandbox-detail-state"
          >
            <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
            {detail?.state_label ?? '—'}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
          <code className="font-mono text-[11.5px]" data-testid="page-sandbox-detail-image">
            {detail?.image ?? '—'}
          </code>
          <span aria-hidden="true" className="opacity-40">
            ·
          </span>
          <span data-testid="page-sandbox-detail-created-at">
            创建于 {formatTimestamp(detail?.created_at)}
          </span>
          <span aria-hidden="true" className="opacity-40">
            ·
          </span>
          <span data-testid="page-sandbox-detail-updated-at">
            更新于 {formatTimestamp(detail?.updated_at)}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          title="刷新沙箱详情"
          aria-label="刷新沙箱详情"
          data-testid="page-sandbox-detail-refresh-button"
          className={cn(actionClass, 'size-8 px-0')}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onStart}
          disabled={busy || running}
          data-testid="page-sandbox-detail-start-button"
          className={cn(actionClass, 'bg-primary text-primary-foreground hover:bg-primary/80')}
        >
          <Play className="size-4" aria-hidden="true" />
          启动
        </button>
        <button
          type="button"
          onClick={onStop}
          disabled={busy || !running}
          data-testid="page-sandbox-detail-stop-button"
          className={actionClass}
        >
          <Square className="size-4" aria-hidden="true" />
          停止
        </button>
        <label className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <input
            type="checkbox"
            checked={stopDependencies}
            onChange={(event) => onStopDependenciesChange(event.target.checked)}
            data-testid="page-sandbox-detail-stop-dependencies-checkbox"
            className="size-3.5 accent-primary"
          />
          同时停止依赖容器
        </label>
        <button
          type="button"
          onClick={onOpenDetail}
          data-testid="page-sandbox-detail-detail-button"
          className={actionClass}
        >
          <Info className="size-4" aria-hidden="true" />
          详情
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          data-testid="page-sandbox-detail-delete-button"
          className={cn(
            actionClass,
            'border-destructive/40 text-destructive hover:bg-destructive-soft',
          )}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          删除
        </button>
      </div>
    </header>
  );
}
