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
  /** 面板最大宽度。 */
  maxWidthClassName?: string;
  /** 面板主体。 */
  children: ReactNode;
  /** 面板底部（按钮区）。 */
  footer?: ReactNode;
}

/**
 * 面板最大宽度补上断点变体：`max-w-[440px]` → `sm:max-w-[440px]`。
 *
 * Base UI 原语自带 `sm:max-w-sm`（384px）的默认窄宽，不覆盖的话
 * 宽弹窗在桌面端会被压成一条窄框。
 */
function withBreakpoint(maxWidthClassName: string): string {
  return maxWidthClassName.replace(/^max-w-/, 'sm:max-w-');
}

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
  maxWidthClassName = 'max-w-[440px]',
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
          'max-w-[calc(100%-3rem)]',
          withBreakpoint(maxWidthClassName),
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
