import { useEffect, type ReactNode } from 'react';

import { cn } from '../../lib/cn';

interface ModalShellProps {
  open: boolean;
  /** 弹窗标题（无障碍标签与顶部标题共用）。 */
  title: string;
  /** 弹窗容器的定位标识。 */
  testId: string;
  /** 关闭（Esc、点遮罩、点右上角关闭按钮都走这里）。 */
  onOpenChange: (open: boolean) => void;
  /** 关闭被禁用（删除进行中：不可逆操作中途不能退出）。 */
  closeDisabled?: boolean;
  /** 面板最大宽度。 */
  maxWidthClassName?: string;
  /** 面板主体。 */
  children: ReactNode;
  /** 面板底部（按钮区）。 */
  footer?: ReactNode;
}

/**
 * 弹窗外壳：遮罩 + 面板 + 顶部标题栏。
 *
 * 关闭途径有三条：Esc、点遮罩、点右上角 ×。三条都走 `onOpenChange(false)`，
 * 调用方可以按业务需要拦住（比如删除进行中不响应）。
 */
export function ModalShell({
  open,
  title,
  testId,
  onOpenChange,
  closeDisabled = false,
  maxWidthClassName = 'max-w-[560px]',
  children,
  footer,
}: ModalShellProps) {
  useEffect(() => {
    if (!open || closeDisabled) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onOpenChange(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, closeDisabled, onOpenChange]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div
        aria-hidden="true"
        onClick={closeDisabled ? undefined : () => onOpenChange(false)}
        className="absolute inset-0 bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        className={cn(
          'relative z-10 flex max-h-[calc(100vh-3rem)] w-full flex-col overflow-hidden',
          'rounded-xl border border-border bg-popover text-popover-foreground shadow-lg',
          maxWidthClassName,
        )}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={closeDisabled}
            aria-label="关闭"
            className={cn(
              'grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors',
              'hover:bg-muted hover:text-foreground',
              'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              'disabled:pointer-events-none disabled:opacity-50',
            )}
          >
            <span aria-hidden="true" className="text-[15px] leading-none">
              ×
            </span>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/40 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
