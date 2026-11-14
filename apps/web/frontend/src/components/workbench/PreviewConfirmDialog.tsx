/**
 * **大文件预览的二次确认对话框**（文件窗格预览与 Obsidian 阅读器**共用**）。
 *
 * 口径来源：PRD「方案一 · 预览」PV-04 /「方案四 · Obsidian tab」OBS-11——两处预览
 * **同一个二次确认对话框**、**同一套行为**：
 *
 * - 提醒内容只有两件事：文件**超过 2 MB**、是否要预览；
 * - **确认才发起读取**、**取消不发任何请求**（两个动作都由调用方实现，这里只
 *   负责构图与回调）；
 * - **不出现任何「仅展示前 N KB」之类的截断说法**（截断提示条已按 PRD 删除）。
 *
 * 标识默认取文件窗格预览那一套（05 的测试与 e2e 钉着它们）；Obsidian 阅读器
 * 通过 `dialogTestId` / `confirmTestId` / `cancelTestId` 换成自己的命名空间。
 */

import { formatFileSize } from '../../lib/file-transfer';
import { ModalShell } from './ModalShell';

export interface PreviewConfirmDialogProps {
  /** 是否打开（`false` 时什么都不渲染）。 */
  open: boolean;
  /** 文件名（提醒文案里带出来）。 */
  name: string;
  /** 字节数（提醒文案里带出来）。 */
  size: number;
  /** 确认：调用方在这里**才**发起读取。 */
  onConfirm: () => void;
  /** 取消 / Esc / 点遮罩 / 点 ×：**一个请求都不发**。 */
  onCancel: () => void;
  /** 弹窗容器的定位标识（默认 `page-file-preview-confirm-dialog`）。 */
  dialogTestId?: string;
  /** 确认按钮的定位标识（默认 `page-file-preview-confirm-button`）。 */
  confirmTestId?: string;
  /** 取消按钮的定位标识（默认 `page-file-preview-confirm-cancel-button`）。 */
  cancelTestId?: string;
}

const SECONDARY_BUTTON =
  'inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-[13px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none';

const PRIMARY_BUTTON =
  'inline-flex h-8 items-center justify-center rounded-lg border border-transparent bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none';

export function PreviewConfirmDialog({
  open,
  name,
  size,
  onConfirm,
  onCancel,
  dialogTestId = 'page-file-preview-confirm-dialog',
  confirmTestId = 'page-file-preview-confirm-button',
  cancelTestId = 'page-file-preview-confirm-cancel-button',
}: PreviewConfirmDialogProps) {
  return (
    <ModalShell
      open={open}
      title="预览大文件"
      testId={dialogTestId}
      onOpenChange={(next) => {
        if (!next) {
          onCancel();
        }
      }}
      maxWidthPx={400}
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            data-testid={cancelTestId}
            className={SECONDARY_BUTTON}
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            data-testid={confirmTestId}
            className={PRIMARY_BUTTON}
          >
            预览
          </button>
        </>
      }
    >
      <p className="text-[13px]">
        「{name}」超过 2 MB（{formatFileSize(size)}），确认预览？
      </p>
    </ModalShell>
  );
}
