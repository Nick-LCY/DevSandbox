import { useCallback, type ReactNode } from 'react';
import { X } from 'lucide-react';

import { cn } from '../../lib/cn';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../ui/dialog';

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
  /**
   * 面板最大宽度（像素）。
   *
   * 取值必须落在 `WIDTH_CLASS` 表里，不在表内一律回落默认 440。
   * 这里只收像素数字，不收类名字符串：Tailwind 只为源码里的字面量生成 CSS，
   * 运行期拼出来的类名（如 `sm:max-w-[${px}px]`）根本没有对应的规则，
   * 面板会一路撑到视口宽度。
   */
  maxWidthPx?: number;
  /** 面板主体。 */
  children: ReactNode;
  /** 面板底部（按钮区）。 */
  footer?: ReactNode;
}

/**
 * 面板最大宽度 → Tailwind 类名（字面量表）。
 *
 * 每个类名都以字面量形式写在这里，Tailwind 扫源码时能直接捡到，
 * 生成的 CSS 里一定有对应规则；调用方只给像素数字。
 *
 * 窄屏（< 640px）不套断点变体，由 `max-w-[calc(100%-3rem)]` 兜底。
 */
const WIDTH_CLASS: Record<number, string> = {
  360: 'sm:max-w-[360px]',
  400: 'sm:max-w-[400px]',
  440: 'sm:max-w-[440px]',
};

/** 面板默认最大宽度（像素）。 */
const DEFAULT_MAX_WIDTH_PX = 440;

/**
 * 弹窗外壳：基于 Base UI Dialog 原语的遮罩 + 面板 + 顶部标题栏。
 *
 * 焦点管理交给原语：弹窗打开时焦点落进面板并被圈住（Tab 在面板里循环），
 * 背景内容被标记为 aria-hidden（辅助技术读不到，Tab 也走不到），遮罩盖住整页，
 * 关闭后焦点回到打开弹窗的那个按钮。
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
  maxWidthPx = DEFAULT_MAX_WIDTH_PX,
  children,
  footer,
}: ModalShellProps) {
  const handleOpenChange = useCallback(
    (next: boolean) => {
      // 关闭被禁用时（删除进行中）：Esc、点遮罩、点关闭按钮一律不响应。
      if (!next && closeDisabled) {
        return;
      }
      onOpenChange(next);
    },
    [closeDisabled, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} disablePointerDismissal={closeDisabled}>
      <DialogContent
        showCloseButton={false}
        data-testid={testId}
        className={cn(
          'flex max-h-[calc(100vh-3rem)] w-full flex-col gap-0 overflow-hidden p-0',
          // 窄屏兜底：视口窄于 640px 时不套断点变体，按视口留边。
          'max-w-[calc(100%-3rem)]',
          // 宽度类名取字面量表里的值（未知宽度回落默认 440）。
          WIDTH_CLASS[maxWidthPx] ?? WIDTH_CLASS[DEFAULT_MAX_WIDTH_PX],
          'rounded-xl border border-border bg-popover text-popover-foreground shadow-lg',
          'ring-0',
        )}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3.5">
          <DialogTitle className="text-[15px] font-semibold">{title}</DialogTitle>
          <DialogClose
            disabled={closeDisabled}
            aria-label="关闭"
            className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            <X className="size-4" aria-hidden="true" />
          </DialogClose>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/40 px-5 py-3">
            {footer}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
