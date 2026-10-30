import { useEffect, useState } from 'react';

import type { ReclaimPlan } from '../../api/types';
import { ModalShell } from './ModalShell';

/** 回收清单里固定出现的字样（后端 `untouched_note` 为空时的兜底）。 */
export const UNTOUCHED_NOTE_FALLBACK = '用户挂载的宿主机目录不受影响';

/** 武装窗口：第一次点确认后，多久内再点一次才真的删除（毫秒）。 */
const ARM_WINDOW = 5000;

interface DeleteSandboxDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 回收清单（关掉弹窗后为 null）。 */
  plan: ReclaimPlan | null;
  /** 删除进行中。 */
  busy: boolean;
  onConfirm: () => void;
}

/**
 * 删除沙箱确认弹窗。
 *
 * 两步确认（不可逆操作）：
 * 1. 第一次点「确认删除」只进入武装状态，按钮变成「再点一次确认删除」，
 *    红色提示条提醒「此操作不可撤销，再点一次确认」；
 * 2. 武装窗口（5 秒）内第二次点才真的发删除请求；窗口过了自动解除武装。
 *
 * 删除进行中不响应 Esc 与遮罩点击：请求已经发出，不能半途退出。
 */
export function DeleteSandboxDialog({
  open,
  onOpenChange,
  plan,
  busy,
  onConfirm,
}: DeleteSandboxDialogProps) {
  const [armed, setArmed] = useState(false);

  // 弹窗关掉就解除武装：下次打开还是从第一步开始。
  useEffect(() => {
    if (!open) {
      setArmed(false);
    }
  }, [open]);

  // 武装窗口自动过期：过了 5 秒不点第二次就当没点过。
  useEffect(() => {
    if (!armed) {
      return undefined;
    }
    const timer = window.setTimeout(() => setArmed(false), ARM_WINDOW);
    return () => window.clearTimeout(timer);
  }, [armed]);

  if (!open || !plan) {
    return null;
  }

  const note = plan.untouched_note.trim() || UNTOUCHED_NOTE_FALLBACK;

  const handleConfirm = (): void => {
    if (!armed) {
      setArmed(true);
      return;
    }
    onConfirm();
  };

  return (
    <ModalShell
      open={open}
      title={`删除沙箱 ${plan.sandbox_name}`}
      testId="page-sandbox-detail-delete-dialog"
      onOpenChange={onOpenChange}
      closeDisabled={busy}
      maxWidthClassName="max-w-[560px]"
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
            onClick={handleConfirm}
            disabled={busy}
            data-testid="page-sandbox-detail-delete-confirm-button"
            className="inline-flex h-8 items-center justify-center rounded-lg border border-transparent bg-destructive px-3 text-[13px] font-medium text-white transition-colors hover:bg-destructive/90 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            {busy ? '正在删除…' : armed ? '再点一次确认删除' : '确认删除'}
          </button>
        </>
      }
    >
      <h2 className="sr-only" data-testid="page-sandbox-detail-delete-title">
        删除沙箱 {plan.sandbox_name}
      </h2>

      {armed && !busy && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-destructive/40 bg-destructive-soft px-3 py-2 text-[12.5px] text-destructive"
          data-testid="page-sandbox-detail-delete-armed-hint"
        >
          此操作不可撤销，再点一次确认
        </div>
      )}

      <div
        className="mb-4 flex items-start gap-2 rounded-lg border border-success/30 bg-success-soft px-3 py-2.5 text-[12.5px] text-success"
        data-testid="page-sandbox-detail-delete-untouched-note"
      >
        <span>{note}</span>
      </div>

      <div>
        <p className="mb-1.5 text-[12.5px] font-medium">平台将回收以下资源：</p>
        <ul className="m-0 list-none space-y-1.5 p-0" data-testid="page-sandbox-detail-delete-items">
          {plan.items.map((item) => (
            <li
              key={item}
              className="flex items-start gap-2 text-[12.5px] leading-relaxed"
              data-testid="page-sandbox-detail-delete-item"
            >
              <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-destructive" />
              <span className="font-mono text-[11.5px]">{item}</span>
            </li>
          ))}
        </ul>
      </div>

      {plan.user_mounts.length > 0 && (
        <div className="mt-4">
          <p className="mb-1.5 text-[12.5px] font-medium">
            用户声明的挂载（保持原样，不创建也不删除）：
          </p>
          <ul className="m-0 list-none space-y-1.5 p-0" data-testid="page-sandbox-detail-delete-user-mounts">
            {plan.user_mounts.map((item) => (
              <li
                key={item}
                className="flex items-start gap-2 text-[12.5px] leading-relaxed"
                data-testid="page-sandbox-detail-delete-user-mount-item"
              >
                <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-success" />
                <span className="font-mono text-[11.5px]">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan.incomplete && (
        <div
          className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-muted px-3 py-2.5 text-[12px] text-muted-foreground"
          data-testid="page-sandbox-detail-delete-incomplete"
        >
          <span>依赖容器清单可能不完整（实时扫描未成功），删除后请人工核对残留容器。</span>
        </div>
      )}
    </ModalShell>
  );
}
