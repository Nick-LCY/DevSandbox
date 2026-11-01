import type { SandboxSummary } from '../../api/types';
import { cn } from '../../lib/cn';

interface SandboxListProps {
  sandboxes: SandboxSummary[];
  selectedName: string | null;
  onSelect: (name: string) => void;
}

/**
 * 沙箱状态点的颜色。
 *
 * 运行=品牌绿，启动中 / 停止中=琥珀（带脉冲），已停止=灰，失败=红。
 * 状态点用 `bg-current`，颜色由文字色令牌决定。
 */
function stateClass(state: string): string {
  switch (state) {
    case 'running':
      return 'text-status-running';
    case 'starting':
    case 'stopping':
      return 'text-status-busy animate-status-pulse';
    case 'failed':
      return 'text-status-failed';
    case 'stopped':
      return 'text-status-stopped';
    default:
      return 'text-status-stopped';
  }
}

/**
 * 沙箱列表项。
 *
 * 选中态只用背景色（bg-sidebar-active）高亮：不画左侧竖线、不加内嵌边框，
 * 侧栏是整块深色背景，任何竖线都会变成刺眼的一条。
 */
export function SandboxList({ sandboxes, selectedName, onSelect }: SandboxListProps) {
  if (sandboxes.length === 0) {
    return (
      <p className="px-2 py-3 text-[12px] leading-relaxed text-sidebar-muted" data-testid="page-sandbox-list-empty">
        还没有沙箱。点「新建沙箱」从宿主本地镜像里选一个开始。
      </p>
    );
  }

  return (
    <ul className="m-0 list-none space-y-0.5 p-0">
      {sandboxes.map((item) => {
        const active = item.name === selectedName;
        return (
          <li key={item.name}>
            <button
              type="button"
              onClick={() => onSelect(item.name)}
              data-testid="page-sandbox-list-item"
              data-sandbox-name={item.name}
              data-sandbox-state={item.state}
              aria-current={active ? 'true' : undefined}
              className={cn(
                'flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors',
                'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                active
                  ? 'bg-sidebar-active'
                  : 'hover:bg-sidebar-hover',
              )}
            >
              <span
                aria-hidden="true"
                className={cn('mt-1.5 size-[7px] shrink-0 rounded-full bg-current', stateClass(item.state))}
              />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block truncate text-[13px] leading-tight font-medium',
                    active ? 'text-sidebar-foreground' : 'text-sidebar-foreground/90',
                  )}
                  data-testid="page-sandbox-list-item-name"
                >
                  {item.name}
                </span>
                <span className="mt-0.5 flex items-center gap-1 text-[11px] leading-tight text-sidebar-muted">
                  <span className="truncate" data-testid="page-sandbox-list-item-state">
                    {item.state_label}
                  </span>
                  <span aria-hidden="true" className="opacity-40">
                    ·
                  </span>
                  <span className="truncate" data-testid="page-sandbox-list-item-image">
                    {item.image}
                  </span>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
