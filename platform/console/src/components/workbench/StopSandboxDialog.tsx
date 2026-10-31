import { ModalShell } from './ModalShell';

interface StopSandboxDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 要停止的沙箱名。 */
  sandboxName: string;
  /** 是否连依赖容器一起停。 */
  stopDependencies: boolean;
  /** 勾选状态变化回调。 */
  onStopDependenciesChange: (value: boolean) => void;
  /** 停止进行中。 */
  busy: boolean;
  onConfirm: () => void;
}

/**
 * 停止沙箱确认弹窗。
 *
 * 停止是可逆操作（还能再启动），但「同时停掉依赖容器」会连带影响别的服务，
 * 所以这一项摆到弹窗里让用户逐次确认，默认勾选（与命令行默认一致）。
 *
 * 停止进行中不响应 Esc 与遮罩点击：请求已经发出，不能半途退出。
 */
export function StopSandboxDialog({
  open,
  onOpenChange,
  sandboxName,
  stopDependencies,
  onStopDependenciesChange,
  busy,
  onConfirm,
}: StopSandboxDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <ModalShell
      open={open}
      title={`停止沙箱 ${sandboxName}`}
      testId="page-sandbox-detail-stop-dialog"
      onOpenChange={onOpenChange}
      closeDisabled={busy}
      maxWidthPx={400}
      footer={
        <>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            data-testid="page-sandbox-detail-stop-cancel-button"
            className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-[13px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            data-testid="page-sandbox-detail-stop-confirm-button"
            className="inline-flex h-8 items-center justify-center rounded-lg border border-transparent bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            {busy ? '正在停止…' : '确认停止'}
          </button>
        </>
      }
    >
      <h2 className="sr-only" data-testid="page-sandbox-detail-stop-title">
        停止沙箱 {sandboxName}
      </h2>

      <p className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground">
        停止后沙箱的容器会退出，文件与配置保留；之后可以随时再启动。
      </p>

      <label className="flex items-center gap-2 text-[12.5px] text-foreground">
        <input
          type="checkbox"
          checked={stopDependencies}
          onChange={(event) => onStopDependenciesChange(event.target.checked)}
          data-testid="page-sandbox-detail-stop-dependencies-checkbox"
          className="size-3.5 accent-primary"
        />
        同时停止依赖容器
      </label>
    </ModalShell>
  );
}
