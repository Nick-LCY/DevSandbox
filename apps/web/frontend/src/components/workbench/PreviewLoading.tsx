/**
 * **预览加载态**（文件窗格预览与 Obsidian 阅读器**共用**）。
 *
 * 口径来源：PRD「方案一 · 预览」PV-04 /「方案四 · Obsidian tab」OBS-11：
 *
 * - **大文件（> 2 MB）**：加载时给**进度条**（进度 = 已接收字节 / 列表条目
 *   `size`，换算走 `transferPercent`），加载完渲染全文；
 * - **小文件**：只有一行「正在读取…」，**不出现进度条**；
 * - **界面上不存在任何「文件过大，仅展示前 N KB」提示条**。
 *
 * 标识默认取文件窗格预览那一套（05 的测试与 e2e 钉着它们）；Obsidian 阅读器
 * 通过 `loadingTestId` / `progressTestId` 换成自己的命名空间。
 */

import { Loader2 } from 'lucide-react';

import { transferPercent } from '../../lib/file-transfer';

export interface PreviewLoadingProps {
  /** 文件名（进度条的可访问名用它）。 */
  name: string;
  /** 是否走大文件流程（`true` ⇒ 进度条；`false` ⇒ 只有一行文案）。 */
  large: boolean;
  /** 已接收字节数。 */
  loaded: number;
  /** 总字节数（分母）；拿不到时为 `null`（不显示百分比，进度条仍在）。 */
  total: number | null;
  /** 加载态容器的定位标识（默认 `page-file-preview-loading`）。 */
  loadingTestId?: string;
  /** 进度条的定位标识（默认 `page-file-preview-progress`）。 */
  progressTestId?: string;
}

export function PreviewLoading({
  name,
  large,
  loaded,
  total,
  loadingTestId = 'page-file-preview-loading',
  progressTestId = 'page-file-preview-progress',
}: PreviewLoadingProps) {
  if (!large) {
    /* 小文件：直接加载，**不出现进度条** */
    return (
      <div
        data-testid={loadingTestId}
        className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-[12.5px] text-muted-foreground"
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        正在读取…
      </div>
    );
  }

  const percent = transferPercent(loaded, total);
  return (
    /* 大文件：进度条（已接收字节 / 总大小），加载完渲染全文 */
    <div
      data-testid={loadingTestId}
      className="flex flex-none flex-col gap-1.5 rounded-lg border border-border bg-muted/40 px-3 py-2"
    >
      <div className="flex items-center justify-between gap-2 text-[12px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          正在读取…
        </span>
        {percent !== null && <span className="font-mono tabular-nums">{percent}%</span>}
      </div>
      <div
        role="progressbar"
        aria-label={`读取 ${name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        data-testid={progressTestId}
        className="h-1 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>
    </div>
  );
}
