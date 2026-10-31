import { useCallback } from 'react';

import { cn } from '../../lib/cn';
import { ModalShell } from './ModalShell';

interface CloseSessionDialogProps {
  open: boolean;
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
 *
 * 弹窗外壳与其他弹窗共用一套（Base UI Dialog 原语）：焦点圈在弹窗里，
 * Esc 与点遮罩都能退出，删除进行中则一律不响应。
 */
export function CloseSessionDialog({
  open,
  running,
  busy,
  onConfirm,
  onCancel,
}: CloseSessionDialogProps) {
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        onCancel();
      }
    },
    [onCancel],
  );

  if (!open) {
    return null;
  }

  const title = running ? '关闭终端会话' : '移除终端会话记录';
  const consequence = running
    ? '关闭会终止容器内该会话的进程树，终端现场不保留'
    : '会话已退出，只移除记录，容器内无残留进程';
  const confirmLabel = running ? '关闭并移除' : '移除记录';

  return (
    <ModalShell
      open={open}
      title={title}
      testId="page-sandbox-detail-terminal-remove-confirm"
      onOpenChange={handleOpenChange}
      closeDisabled={busy}
      maxWidthPx={360}
      footer={
        <>
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
        </>
      }
    >
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">{consequence}</p>
    </ModalShell>
  );
}
