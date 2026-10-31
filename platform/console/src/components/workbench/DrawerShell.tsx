import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';

import { cn } from '../../lib/cn';
import {
  clampDrawerWidth,
  DEFAULT_DRAWER_WIDTH_VW,
  MAX_DRAWER_WIDTH_VW,
  MIN_DRAWER_WIDTH_VW,
  pxToVw,
  vwToPx,
} from '../../lib/drawer-width';
import {
  Drawer,
  DrawerBackdrop,
  DrawerClose,
  DrawerContent,
  DrawerPopup,
  DrawerPortal,
  DrawerTitle,
  DrawerViewport,
} from '../ui/drawer';

interface DrawerShellProps {
  open: boolean;
  /** 抽屉标题（无障碍标签与顶部标题共用）。 */
  title: string;
  /** 抽屉容器的定位标识。 */
  testId: string;
  /** 关闭（Esc、点遮罩、点右上角关闭按钮都走这里）。 */
  onOpenChange: (open: boolean) => void;
  /** 关闭被禁用（不可逆操作进行中：不能半途退出）。 */
  closeDisabled?: boolean;
  /** 抽屉宽度（视口宽度的百分比）。 */
  widthVw: number;
  /** 宽度变化回调（松手或键盘调整后上抛，调用方负责持久化）。 */
  onWidthChange: (vw: number) => void;
  /** 抽屉主体。 */
  children: ReactNode;
  /** 抽屉底部（按钮区）。 */
  footer?: ReactNode;
}

/** 键盘调整宽度的步长（百分点）。 */
const KEYBOARD_STEP_VW = 2;

/** 抽屉宽度写在内联样式里的 CSS 变量名。 */
const WIDTH_VAR = '--app-drawer-width';

type DrawerPopupStyle = CSSProperties & { [WIDTH_VAR]: string };

export function DrawerShell({
  open,
  title,
  testId,
  onOpenChange,
  closeDisabled = false,
  widthVw,
  onWidthChange,
  children,
  footer,
}: DrawerShellProps) {
  /**
   * 拖拽期间的本地宽度。
   *
   * 拖动时只改本地状态：每像素都上抛会让整个工作台跟着重渲染。
   * 松手才把最终值上抛给调用方持久化。
   */
  const [dragWidthVw, setDragWidthVw] = useState<number | null>(null);

  const effectiveWidthVw = dragWidthVw ?? clampDrawerWidth(widthVw);

  const popupRef = useRef<HTMLDivElement | null>(null);
  /** 拖拽起点信息：起始横坐标与起始宽度（像素）。 */
  const dragRef = useRef<{ startX: number; startWidthPx: number; pointerId: number } | null>(null);
  /** 下一帧要落地的宽度（每帧最多更新一次本地状态）。 */
  const pendingWidthRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  /** 当前生效宽度的最新值（拖拽起点算宽度时用）。 */
  const effectiveWidthRef = useRef(effectiveWidthVw);

  useEffect(() => {
    effectiveWidthRef.current = effectiveWidthVw;
  }, [effectiveWidthVw]);

  // 抽屉关掉时清掉拖拽残留：下次打开从当前持久化宽度开始。
  useEffect(() => {
    if (open) {
      return;
    }
    dragRef.current = null;
    pendingWidthRef.current = null;
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    setDragWidthVw(null);
  }, [open]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // 关闭被禁用时（不可逆操作进行中）：Esc、点遮罩、点关闭按钮一律不响应。
      if (!next && closeDisabled) {
        return;
      }
      onOpenChange(next);
    },
    [closeDisabled, onOpenChange],
  );

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    /**
     * 抽屉的横向滑动关闭是原语自带的、没有开关：Base UI 在 Viewport 上挂
     * pointerdown 判定滑动方向。把手必须挡住它——preventDefault +
     * stopPropagation 双保险，另加 data-base-ui-swipe-ignore="x"。
     */
    event.preventDefault();
    event.stopPropagation();

    const measured = popupRef.current?.getBoundingClientRect().width ?? 0;
    const startWidthPx =
      measured > 0 ? measured : vwToPx(effectiveWidthRef.current, window.innerWidth);

    dragRef.current = { startX: event.clientX, startWidthPx, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    // 向左拖变宽：把手横坐标往左走，面板左边缘也跟着往左走。
    const deltaPx = event.clientX - drag.startX;
    const nextWidthPx = drag.startWidthPx - deltaPx;
    const nextWidthVw = clampDrawerWidth(pxToVw(nextWidthPx, window.innerWidth));
    pendingWidthRef.current = nextWidthVw;

    // 每帧最多更新一次本地状态。
    if (frameRef.current !== null) {
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const pending = pendingWidthRef.current;
      if (pending !== null) {
        setDragWidthVw(pending);
      }
    });
  }, []);

  const finishDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      dragRef.current = null;
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      const pending = pendingWidthRef.current;
      pendingWidthRef.current = null;
      setDragWidthVw(null);
      // 拖过才上抛：没动过就不写存储。
      if (pending !== null) {
        onWidthChange(clampDrawerWidth(pending));
      }
    },
    [onWidthChange],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const current = clampDrawerWidth(effectiveWidthRef.current);
      let next: number;
      if (event.key === 'ArrowLeft') {
        // 向左 = 变宽（与拖拽方向一致）。
        next = current + KEYBOARD_STEP_VW;
      } else if (event.key === 'ArrowRight') {
        next = current - KEYBOARD_STEP_VW;
      } else if (event.key === 'Home') {
        next = DEFAULT_DRAWER_WIDTH_VW;
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onWidthChange(clampDrawerWidth(next));
    },
    [onWidthChange],
  );

  const popupStyle: DrawerPopupStyle = {
    [WIDTH_VAR]: `${effectiveWidthVw}vw`,
  };

  return (
    <Drawer
      open={open}
      onOpenChange={handleOpenChange}
      swipeDirection="right"
      disablePointerDismissal={closeDisabled}
    >
      <DrawerPortal>
        <DrawerBackdrop />
        <DrawerViewport className="fixed inset-0 z-50 flex justify-end pointer-events-none">
          <DrawerPopup
            ref={popupRef}
            data-console-shell=""
            data-testid={testId}
            style={popupStyle}
            className={cn(
              'pointer-events-auto relative flex h-full w-full flex-col overflow-hidden',
              'border-l border-border bg-popover text-popover-foreground shadow-lg outline-none',
              'sm:w-[var(--app-drawer-width)]',
              // 不加 duration-*：Tailwind 默认 transition-property 是 all，
              // 带上就会连宽度一起过渡（拖拽时面板会滞后 150ms 跟手）。
              // 入场 / 退场动画的时长由 animate-in 自带的 0.15s 兜底。
              'data-open:animate-in data-open:slide-in-from-right',
              'data-closed:animate-out data-closed:slide-out-to-right',
            )}
          >
            {/* 宽度拖拽把手：左边缘 6 像素竖条。 */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整抽屉宽度"
              aria-valuemin={MIN_DRAWER_WIDTH_VW}
              aria-valuemax={MAX_DRAWER_WIDTH_VW}
              aria-valuenow={Math.round(effectiveWidthVw)}
              tabIndex={0}
              data-testid="page-drawer-resize-handle"
              data-base-ui-swipe-ignore="x"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={finishDrag}
              onPointerCancel={finishDrag}
              onKeyDown={handleKeyDown}
              className={cn(
                'absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize touch-none select-none',
                'bg-border/60 transition-colors hover:bg-primary/40 focus-visible:outline-none',
                'focus-visible:ring-3 focus-visible:ring-ring/50',
              )}
            />

            <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3.5">
              <DrawerTitle className="text-[15px] font-semibold">{title}</DrawerTitle>
              <DrawerClose
                disabled={closeDisabled}
                aria-label="关闭"
                className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
              >
                <X className="size-4" aria-hidden="true" />
              </DrawerClose>
            </div>

            {/*
              正文容器标 data-base-ui-swipe-ignore：表单里拖选文本不会被
              抽屉的横向滑动关闭吃掉。
            */}
            <DrawerContent
              data-base-ui-swipe-ignore=""
              className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
            >
              {children}
            </DrawerContent>

            {footer && (
              <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/40 px-5 py-3">
                {footer}
              </div>
            )}
          </DrawerPopup>
        </DrawerViewport>
      </DrawerPortal>
    </Drawer>
  );
}
