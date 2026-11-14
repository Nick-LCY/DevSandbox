/**
 * 浮层定位的纯逻辑：hover tooltip 的**防视口裁切**计算。
 *
 * 口径来源：PRD「方案四 · Obsidian tab」——wikilink 的 tooltip 内容是解析后的
 * 目标路径，**靠近视口边缘时不被裁切**。
 *
 * 这里只做算术：给定锚点矩形、浮层尺寸与视口尺寸，算出 `position: fixed` 的
 * `left` / `top` 与最终落位（上方还是下方）。不碰 DOM、不读全局对象，单测能
 * 把每条边界逐条钉死。
 */

/** 矩形（与 `DOMRect` 的取用字段对齐，测试里用普通对象即可）。 */
export interface TooltipRect {
  /** 左边缘（视口坐标，`position: fixed` 的参照系）。 */
  left: number;
  /** 上边缘。 */
  top: number;
  /** 宽度。 */
  width: number;
  /** 高度。 */
  height: number;
}

/** 视口尺寸。 */
export interface TooltipViewport {
  width: number;
  height: number;
}

/** 定位参数（像素）。 */
export interface TooltipPositionOptions {
  /** 浮层与锚点之间的间距，默认 6。 */
  gap?: number;
  /** 浮层与视口边缘的最小留白，默认 8。 */
  margin?: number;
}

/** 定位结果。 */
export interface TooltipPosition {
  /** `position: fixed` 的 `left`。 */
  left: number;
  /** `position: fixed` 的 `top`。 */
  top: number;
  /** 最终落在锚点上方还是下方（**越界时翻转**）。 */
  placement: 'top' | 'bottom';
}

/** 默认间距（浮层与锚点）。 */
export const TOOLTIP_GAP_PX = 6;

/** 默认留白（浮层与视口边缘）。 */
export const TOOLTIP_MARGIN_PX = 8;

/** 把值钳在 `[min, max]`；`max < min` 时取 `min`（视口比浮层还窄的极端情况）。 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (!Number.isFinite(max) || max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

/**
 * 算 tooltip 的落位。
 *
 * 规则：
 *
 * 1. **优先在锚点上方**（`top = anchor.top - gap - height`）；
 * 2. **上方放不下**（越过上边留白）⇒ **翻转到下方**（`anchor.bottom + gap`）；
 * 3. **下方也放不下**（视口太矮 / 浮层太高）⇒ 竖向上**钳进视口**（宁可压住锚点，
 *    也不让内容跑到视口外），`placement` 取翻转后的那一侧；
 * 4. **水平居中于锚点**，再钳进 `[margin, viewport.width - margin - width]`——
 *    靠近左右边缘时不会被裁掉半截。
 *
 * 尺寸取 0（还没量到）时不会抛错：按「0 宽高」算，位置落在锚点附近，等
 * `useLayoutEffect` 量到真实尺寸后再算一次即可。
 */
export function computeTooltipPosition(
  anchor: TooltipRect,
  tooltip: TooltipViewport,
  viewport: TooltipViewport,
  options?: TooltipPositionOptions,
): TooltipPosition {
  const gap = options?.gap ?? TOOLTIP_GAP_PX;
  const margin = options?.margin ?? TOOLTIP_MARGIN_PX;
  const width = Math.max(0, tooltip.width);
  const height = Math.max(0, tooltip.height);
  const viewportWidth = Math.max(0, viewport.width);
  const viewportHeight = Math.max(0, viewport.height);

  const anchorTop = Number.isFinite(anchor.top) ? anchor.top : 0;
  const anchorLeft = Number.isFinite(anchor.left) ? anchor.left : 0;
  const anchorHeight = Number.isFinite(anchor.height) ? Math.max(0, anchor.height) : 0;
  const anchorWidth = Number.isFinite(anchor.width) ? Math.max(0, anchor.width) : 0;

  const above = anchorTop - gap - height;
  const below = anchorTop + anchorHeight + gap;
  const aboveFits = above >= margin;
  const belowFits = below + height <= viewportHeight - margin;

  let placement: TooltipPosition['placement'];
  let top: number;
  if (aboveFits) {
    placement = 'top';
    top = above;
  } else if (belowFits) {
    placement = 'bottom';
    top = below;
  } else {
    // 上下都放不下：钳进视口（优先保住上方落位，钳不动就贴住上边留白）。
    placement = 'bottom';
    top = clamp(above, margin, viewportHeight - margin - height);
  }

  const left = clamp(
    anchorLeft + anchorWidth / 2 - width / 2,
    margin,
    viewportWidth - margin - width,
  );

  return { left, top, placement };
}
