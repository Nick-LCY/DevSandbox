// @vitest-environment node
/**
 * tooltip 定位的纯逻辑（wikilink hover tooltip 的**防视口裁切**）。
 *
 * 口径来源：PRD「方案四 · Obsidian tab」OBS-08——tooltip 内容是解析后的目标
 * 路径，**靠近视口边缘不被裁切**。这里把「上方优先 / 越界翻转 / 水平钳位」逐条
 * 钉死；真实渲染里的测量与 portal 由组件负责。
 */

import { describe, expect, it } from 'vitest';

import {
  computeTooltipPosition,
  TOOLTIP_GAP_PX,
  TOOLTIP_MARGIN_PX,
  type TooltipRect,
  type TooltipViewport,
} from './tooltip-position';

const VIEWPORT: TooltipViewport = { width: 1000, height: 800 };
const TOOLTIP: TooltipViewport = { width: 200, height: 20 };

/** 锚点矩形：只关心 left / top / 宽高。 */
function anchor(left: number, top: number, width = 100, height = 16): TooltipRect {
  return { left, top, width, height };
}

describe('computeTooltipPosition', () => {
  it('空间足够时落在锚点上方、水平居中', () => {
    const position = computeTooltipPosition(anchor(400, 300), TOOLTIP, VIEWPORT);
    expect(position.placement).toBe('top');
    expect(position.top).toBe(300 - TOOLTIP_GAP_PX - 20);
    // 锚点中心 450 - 浮层半宽 100 = 350
    expect(position.left).toBe(350);
  });

  it('上方放不下 ⇒ 翻转到下方', () => {
    const position = computeTooltipPosition(anchor(400, 4), TOOLTIP, VIEWPORT);
    expect(position.placement).toBe('bottom');
    expect(position.top).toBe(4 + 16 + TOOLTIP_GAP_PX);
  });

  it('上下都放不下（视口太矮）⇒ 竖向钳进视口', () => {
    const tiny: TooltipViewport = { width: 1000, height: 40 };
    const position = computeTooltipPosition(anchor(400, 18), TOOLTIP, tiny);
    expect(position.top).toBeGreaterThanOrEqual(TOOLTIP_MARGIN_PX);
    expect(position.top + 20).toBeLessThanOrEqual(tiny.height - TOOLTIP_MARGIN_PX);
  });

  it('靠左边缘 ⇒ 水平不越过留白', () => {
    const position = computeTooltipPosition(anchor(0, 300), TOOLTIP, VIEWPORT);
    expect(position.left).toBe(TOOLTIP_MARGIN_PX);
  });

  it('靠右边缘 ⇒ 水平反推到视口内', () => {
    const position = computeTooltipPosition(anchor(980, 300, 20), TOOLTIP, VIEWPORT);
    expect(position.left).toBe(VIEWPORT.width - TOOLTIP_MARGIN_PX - TOOLTIP.width);
    expect(position.left + TOOLTIP.width).toBeLessThanOrEqual(VIEWPORT.width - TOOLTIP_MARGIN_PX);
  });

  it('浮层比视口还宽 ⇒ 贴住左留白（不出现负坐标）', () => {
    const narrow: TooltipViewport = { width: 120, height: 800 };
    const position = computeTooltipPosition(anchor(50, 300), TOOLTIP, narrow);
    expect(position.left).toBe(TOOLTIP_MARGIN_PX);
  });

  it('尺寸未知（还没量到）时不抛错，按 0 宽高算', () => {
    const position = computeTooltipPosition(anchor(400, 300), { width: 0, height: 0 }, VIEWPORT);
    expect(position).toEqual({ left: 450, top: 300 - TOOLTIP_GAP_PX, placement: 'top' });
  });

  it('间距与留白可调', () => {
    const position = computeTooltipPosition(anchor(400, 300), TOOLTIP, VIEWPORT, {
      gap: 2,
      margin: 30,
    });
    expect(position.top).toBe(300 - 2 - 20);
    expect(computeTooltipPosition(anchor(0, 300), TOOLTIP, VIEWPORT, { margin: 30 }).left).toBe(30);
  });

  it('非法数值（NaN）不 produce NaN 坐标', () => {
    const position = computeTooltipPosition(
      { left: Number.NaN, top: Number.NaN, width: Number.NaN, height: Number.NaN },
      TOOLTIP,
      VIEWPORT,
    );
    expect(Number.isFinite(position.left)).toBe(true);
    expect(Number.isFinite(position.top)).toBe(true);
  });
});
