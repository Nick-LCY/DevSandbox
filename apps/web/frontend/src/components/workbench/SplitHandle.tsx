import { GripVertical } from 'lucide-react';
import type { KeyboardEvent, PointerEvent } from 'react';

/**
 * 骑缝拖拽把手（**共用**）：文件窗格（终端右侧分屏）与 Obsidian 双栏
 * （vault 树 / 预览区）的接缝都是这一条。
 *
 * 视觉口径（复验修复轮·第二批 #2 / #6，用户桌面端实测反馈）：
 * - **固定常显区域**：把手带（`bg-muted`）与抓握图标静置就可见，不再
 *   「hover 才显形」——宽窄可调这件事要一直看得见；
 * - **直角**：把手本体与 hover 高亮都**不带圆角**（`rounded-md` 已去），
 *   与周围直角环境一致；
 * - hover 高亮保留（`bg-primary/30`，同样直角），抓握图标 hover / 键盘
 *   聚焦时加深；
 * - 骑缝：`-mx-1.5 w-3`（**每侧压入 6px**）骑在两格的接缝上，**不占布局宽度**
 *   （两侧零间隙的视觉合并不受影响）。审查收敛（复验修复轮·第二批）：从
 *   `-mx-2 w-4`（每侧 8px）收窄而来——把手带对两侧内容的遮挡减半（终端右缘
 *   字符列、Obsidian 树的原生滚动条各少压 2px），骑缝中心仍落在接缝上；
 * - 语义与行为由调用方决定：role / aria（separator + 数值范围 + 方向键
 *   调宽）与指针拖拽回调全部从 props 传入，本组件只负责外壳与外观。
 *
 * `GripVertical` 抓握图标照抽屉宽度把手（`DrawerShell`）的选型。
 */
export function SplitHandle({
  label,
  min,
  max,
  value,
  testId,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onKeyDown,
}: {
  /** 可访问名（`aria-label`，如「调整文件窗格宽度」）。 */
  label: string;
  /** 可调范围下限（`aria-valuemin`）。 */
  min: number;
  /** 可调范围上限（`aria-valuemax`）。 */
  max: number;
  /** 当前值（`aria-valuenow`）。 */
  value: number;
  /** 定位标识（两侧调用方各自的 `page-*` testid）。 */
  testId: string;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    // a11y 增强（复验修复轮·第二批审查）：aria-valuetext 给数值带上单位，
    // 读屏读「340 像素」而不是光秃的「340」（两处调用共用）。
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value}px`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={onKeyDown}
      data-testid={testId}
      className="group relative z-10 -mx-1.5 flex w-3 flex-none cursor-col-resize touch-none select-none items-center justify-center bg-muted transition-colors hover:bg-primary/30 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <GripVertical
        className="pointer-events-none size-3 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground group-focus-visible:text-foreground"
        aria-hidden="true"
      />
    </div>
  );
}
