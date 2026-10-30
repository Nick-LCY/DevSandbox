import { useEffect } from 'react';

import { cn } from '../../lib/cn';

interface CloseSessionDialogProps {
  open: boolean;
  /** 要关闭的会话标识。 */
  sessionId: string | null;
  /** 会话是不是还在跑（决定文案与后果说明）。 */
  running: boolean;
  /** 删除进行中。 */
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 关闭 / 移除终端会话的确认弹窗。
 *
 * 运行中的会话与已退出的会话后果完全不同，文案必须分开说：
 * - 运行中：关掉会终止容器内该会话的进程树，终端现场不保留；
 * - 已退出：只移除记录，容器内没有残留进程。
 */
export function CloseSessionDialog({
  open,
  sessionId,
  running,
  busy,
  onConfirm,
  onCancel,
}: CloseSessionDialogProps) {
  // Esc 关闭：不可逆操作必须给一条不点任何按钮就能退出的路。
  useEffect(() => {
    if (!open || busy) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onCancel]);

  if (!open) {
    return null;
  }

  const title = running ? '关闭终端会话' : '移除终端会话记录';
  const consequence = running
    ? '关闭会终止容器内该会话的进程树，终端现场不保留'
    : '会话已退出，只移除记录，容器内无残留进程';
  const confirmLabel = running ? '关闭并移除' : '移除记录';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div
        aria-hidden="true"
        onClick={busy ? undefined : onCancel}
        className="absolute inset-0 bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="page-sandbox-detail-terminal-remove-confirm"
        className={cn(
          'relative z-10 w-full max-w-[420px] rounded-xl border border-border bg-popover p-5 text-popover-foreground',
          'shadow-lg',
        )}
      >
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">{consequence}</p>
        {sessionId && (
          <p className="mt-1 font-mono text-[11.5px] text-faint">会话 {sessionId.slice(0, 8)}</p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            data-testid="page-sandbox-detail-terminal-remove-cancel-button"
            className={cn(
              'inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3',
              'text-[13px] text-foreground transition-colors hover:bg-muted',
              'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              'disabled:pointer-events-none disabled:opacity-50',
            )}
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            data-testid="page-sandbox-detail-terminal-remove-confirm-button"
            className={cn(
              'inline-flex h-8 items-center justify-center rounded-lg border border-transparent px-3',
              'text-[13px] font-medium transition-colors',
              'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              'disabled:pointer-events-none disabled:opacity-50',
              running
                ? 'bg-destructive text-white hover:bg-destructive/90'
                : 'bg-primary text-primary-foreground hover:bg-primary/80',
            )}
          >
            {busy ? '正在处理…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
