// @vitest-environment jsdom
/**
 * 终端焦点回填门控的单元测试。
 *
 * 口径：只有「用户刚点了标签 / 终端表面 / 新建了会话」或「判定当下焦点就在
 * 终端表面内」才允许把焦点塞回终端；焦点在别处（抽屉输入框等）一律不回填。
 *
 * 另外锁一条硬约束：**焦点宿主被摘出 DOM 后不能当成「焦点还在终端里」**
 * （终端重挂载时浏览器把焦点复位到 body 且不派发 focusin，
 *  只靠事件跟踪记的标志会永远停在 true，门控退化成「永远回填」）。
 */

import { describe, expect, it } from 'vitest';

import {
  focusInsideTerminalSurface,
  isInsideTerminalSurface,
  resolveTerminalFocus,
  TERMINAL_SURFACE_SELECTOR,
} from './terminal-focus';

/** 造一个终端表面（焦点跟踪靠它判定「焦点在不在终端里」）。 */
function makeSurface(): HTMLElement {
  const surface = document.createElement('div');
  surface.setAttribute('data-testid', 'page-sandbox-detail-terminal-surface');
  document.body.appendChild(surface);
  return surface;
}

describe('终端焦点回填门控', () => {
  it('有操作意图：回填（用户刚点了标签，焦点已被浏览器挪到标签按钮上）', () => {
    expect(
      resolveTerminalFocus({
        intent: true,
        focusInsideTerminal: false,
      }),
    ).toBe(true);
  });

  it('焦点此刻就在终端表面内：回填（重挂载把焦点弄丢了，要恢复）', () => {
    expect(
      resolveTerminalFocus({
        intent: false,
        focusInsideTerminal: true,
      }),
    ).toBe(true);
  });

  it('焦点在抽屉输入框：不回填（不能抢别处的焦点）', () => {
    expect(
      resolveTerminalFocus({
        intent: false,
        focusInsideTerminal: false,
      }),
    ).toBe(false);
  });

  it('终端表面的选择器指向既有标识', () => {
    expect(TERMINAL_SURFACE_SELECTOR).toBe(
      '[data-testid="page-sandbox-detail-terminal-surface"]',
    );
  });
});

describe('焦点位置判定', () => {
  it('焦点落在终端表面内：算「在终端里」', () => {
    const surface = makeSurface();
    const inside = document.createElement('input');
    surface.appendChild(inside);
    inside.focus();

    expect(document.activeElement).toBe(inside);
    expect(focusInsideTerminalSurface(document.activeElement, inside)).toBe(true);
    expect(isInsideTerminalSurface(inside)).toBe(true);

    surface.remove();
  });

  it('焦点落在终端表面之外：不算「在终端里」', () => {
    const surface = makeSurface();
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();

    expect(focusInsideTerminalSurface(document.activeElement, outside)).toBe(false);
    expect(isInsideTerminalSurface(outside)).toBe(false);

    outside.remove();
    surface.remove();
  });

  it('焦点宿主被摘出 DOM：不算「在终端里」（重挂载后浏览器把焦点复位到 body）', () => {
    const surface = makeSurface();
    const inside = document.createElement('input');
    surface.appendChild(inside);
    inside.focus();

    // 终端重挂载：helper textarea 被摘出 DOM。浏览器把焦点复位到 body，
    // 且**不派发 focusin**——只靠事件跟踪记下来的标志会永远停在 true。
    inside.remove();

    expect(focusInsideTerminalSurface(document.activeElement, inside)).toBe(false);
    surface.remove();
  });

  it('没有焦点宿主（判定为 null）：不算「在终端里」', () => {
    expect(focusInsideTerminalSurface(null, null)).toBe(false);
  });
});
