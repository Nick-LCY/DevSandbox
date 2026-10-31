import { ModalShell } from './ModalShell';

/** 回收清单里固定出现的字样：用户声明的挂载目录平台不碰。 */
export const UNTOUCHED_NOTE = '用户挂载的宿主机目录不受影响';

interface DeleteSandboxDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 要删除的沙箱名。 */
  sandboxName: string;
  /** 删除进行中。 */
  busy: boolean;
  onConfirm: () => void;
}

/**
 * 删除沙箱确认弹窗。
 *
 * 一次点「确认删除」就真的发删除请求：删除前不再预取回收清单，
 * 弹窗只说两件事——删了会怎样、哪些东西不受影响。
 *
 * 删除进行中不响应 Esc 与遮罩点击：请求已经发出，不能半途退出。
 */
export function DeleteSandboxDialog({
  open,
  onOpenChange,
  sandboxName,
  busy,
  onConfirm,
}: DeleteSandboxDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <ModalShell
      open={open}
      title={`删除沙箱 ${sandboxName}`}
      testId="page-sandbox-detail-delete-dialog"
      onOpenChange={onOpenChange}
      closeDisabled={busy}
      maxWidthPx={400}
      footer={
        <>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            data-testid="page-sandbox-detail-delete-cancel-button"
            className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-[13px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            data-testid="page-sandbox-detail-delete-confirm-button"
            className="inline-flex h-8 items-center justify-center rounded-lg border border-transparent bg-destructive px-3 text-[13px] font-medium text-white transition-colors hover:bg-destructive/90 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            {busy ? '正在删除…' : '确认删除'}
          </button>
        </>
      }
    >
      <h2 className="sr-only" data-testid="page-sandbox-detail-delete-title">
        删除沙箱 {sandboxName}
      </h2>

      <p className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground">
        删除后平台会回收这个沙箱的容器、网络、守护进程与系统用户，此操作不可撤销。
      </p>

      <div
        className="flex items-start gap-2 rounded-lg border border-success/30 bg-success-soft px-3 py-2.5 text-[12.5px] text-success"
        data-testid="page-sandbox-detail-delete-untouched-note"
      >
        <span>{UNTOUCHED_NOTE}</span>
      </div>
    </ModalShell>
  );
}
