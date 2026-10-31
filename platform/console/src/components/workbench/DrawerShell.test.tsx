// @vitest-environment jsdom
/**
 * 抽屉外壳：基于 Base UI Drawer 原语的焦点管理、关闭途径与宽度调整。
 *
 * 覆盖七件事：
 * - 抽屉面板与标题挂在一个 role=dialog 的容器上；
 * - Esc 关闭；
 * - 关闭被禁用时（不可逆操作进行中）Esc 与关闭按钮都不响应；
 * - 打开时焦点落进抽屉里；
 * - 宽度拖拽把手存在，且是 role=separator 的竖向分隔条；
 * - 把手上带竖向抓握图标（纯视觉提示，装饰性元素对辅助技术隐藏）；
 * - 把手上按方向键能改宽度（每次 2 个百分点，Home 回默认值）；
 * - 指针拖拽宽度：拖动过程中不落盘，松手才落盘一次（按下即松手不落盘）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DrawerShell } from './DrawerShell';

/**
 * jsdom 没有 PointerEvent（也没有指针捕获 API）：补一个最小实现。
 *
 * 指针事件继承 MouseEvent，因此 clientX / clientY 照常生效；
 * pointerId 由我们自己带上（实现里用它区分是哪一次拖拽）。
 */
class FakePointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
    this.isPrimary = init.isPrimary ?? true;
  }
}

/** 正在持有指针捕获的元素（打桩用）。 */
const capturedElements = new WeakSet<Element>();

beforeAll(() => {
  (window as unknown as { PointerEvent: typeof FakePointerEvent }).PointerEvent =
    FakePointerEvent;
  // jsdom 未实现指针捕获：打桩，否则拖拽路径直接抛异常。
  Element.prototype.setPointerCapture = function setPointerCapture(this: Element): void {
    capturedElements.add(this);
  };
  Element.prototype.releasePointerCapture = function releasePointerCapture(
    this: Element,
  ): void {
    capturedElements.delete(this);
  };
  Element.prototype.hasPointerCapture = function hasPointerCapture(this: Element): boolean {
    return capturedElements.has(this);
  };
});

afterEach(cleanup);

/** 等一拍：Base UI 的关闭是异步派发的。 */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** 渲染抽屉（默认开着、宽度 40）。 */
function renderDrawer(overrides: Partial<Parameters<typeof DrawerShell>[0]> = {}) {
  const props = {
    open: true,
    title: '新建沙箱',
    testId: 'page-sandbox-create-dialog',
    onOpenChange: vi.fn(),
    widthVw: 40,
    onWidthChange: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<DrawerShell {...props}><p>抽屉正文</p></DrawerShell>) };
}

describe('DrawerShell', () => {
  it('抽屉面板与标题挂在一个 role=dialog 的容器上', async () => {
    renderDrawer();

    const drawer = await screen.findByTestId('page-sandbox-create-dialog');
    expect(drawer.getAttribute('role')).toBe('dialog');
    expect(drawer.textContent).toContain('新建沙箱');
    expect(drawer.textContent).toContain('抽屉正文');
  });

  it('Esc 关闭：回调收到 false', async () => {
    const { props } = renderDrawer();
    await screen.findByTestId('page-sandbox-create-dialog');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
  });

  it('关闭被禁用时：Esc 与关闭按钮都不触发关闭', async () => {
    const { props } = renderDrawer({ closeDisabled: true });
    const drawer = await screen.findByTestId('page-sandbox-create-dialog');

    fireEvent.keyDown(document, { key: 'Escape' });
    await tick();
    expect(props.onOpenChange).not.toHaveBeenCalled();

    const closeButton = drawer.querySelector('button[aria-label="关闭"]');
    expect(closeButton).not.toBeNull();
    fireEvent.click(closeButton as HTMLButtonElement);
    await tick();
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  it('打开时焦点落进抽屉里（焦点圈在抽屉内）', async () => {
    renderDrawer();
    const drawer = await screen.findByTestId('page-sandbox-create-dialog');

    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
  });

  it('宽度拖拽把手存在，且是竖向分隔条', async () => {
    renderDrawer();
    await screen.findByTestId('page-sandbox-create-dialog');

    const handle = screen.getByTestId('page-drawer-resize-handle');
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-label')).toBe('调整抽屉宽度');
    expect(handle.getAttribute('tabindex')).toBe('0');
    // 横向滑动关闭是原语自带的：把手必须挡住它。
    expect(handle.getAttribute('data-base-ui-swipe-ignore')).toBe('x');
  });

  it('把手上带竖向抓握图标：装饰性元素，辅助技术不读', async () => {
    renderDrawer();
    await screen.findByTestId('page-sandbox-create-dialog');

    const handle = screen.getByTestId('page-drawer-resize-handle');
    // lucide 的 GripVertical：svg 上的类名带图标名。
    const icon = handle.querySelector('svg.lucide-grip-vertical');
    expect(icon).not.toBeNull();
    // 装饰性图标：把手本身已有 aria-label，图标不再重复播报。
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('把手上按方向键改宽度：左右各 2 个百分点，Home 回默认值', async () => {
    const { props } = renderDrawer();
    await screen.findByTestId('page-sandbox-create-dialog');

    const handle = screen.getByTestId('page-drawer-resize-handle');

    // 向左 = 变宽。
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(props.onWidthChange).toHaveBeenLastCalledWith(42);

    // 向右 = 变窄。
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(props.onWidthChange).toHaveBeenLastCalledWith(38);

    // Home 回默认值 40。
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(props.onWidthChange).toHaveBeenLastCalledWith(40);
  });
});

describe('DrawerShell 宽度拖拽', () => {
  /** 视口宽（jsdom 默认 1024）。 */
  const viewport = window.innerWidth;

  /** 起始像素宽：宽度 40% 换算成像素。 */
  const startWidthPx = (40 / 100) * viewport;

  it('拖动过程中不落盘，松手才上抛一次宽度', () => {
    const { props } = renderDrawer();
    const onWidthChange = props.onWidthChange as ReturnType<typeof vi.fn>;
    const handle = screen.getByTestId('page-drawer-resize-handle');

    fireEvent.pointerDown(handle, { clientX: 800, clientY: 300, pointerId: 1 });
    // 按下即拿回焦点：方向键调宽度的入口要能用键盘。
    expect(document.activeElement).toBe(handle);

    fireEvent.pointerMove(handle, { clientX: 700, clientY: 300, pointerId: 1 });
    // 拖动中：不上抛（否则每像素都要重渲染整个工作台）。
    expect(onWidthChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, { clientX: 700, clientY: 300, pointerId: 1 });
    // 松手：恰好一次。
    expect(onWidthChange).toHaveBeenCalledTimes(1);
    const [vw] = onWidthChange.mock.calls[0] as [number];
    // 向左拖 100 像素 = 变宽 100/视口宽 个百分点。
    const expected = ((startWidthPx + 100) / viewport) * 100;
    expect(vw).toBeCloseTo(expected, 6);
  });

  it('按下即松手（没拖动）：不落盘', () => {
    const { props } = renderDrawer();
    const onWidthChange = props.onWidthChange as ReturnType<typeof vi.fn>;
    const handle = screen.getByTestId('page-drawer-resize-handle');

    fireEvent.pointerDown(handle, { clientX: 800, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 800, clientY: 300, pointerId: 1 });

    expect(onWidthChange).not.toHaveBeenCalled();
  });

  it('视口宽不可用时不做换算：不落盘', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    Object.defineProperty(window, 'innerWidth', { value: 0, configurable: true });
    try {
      const { props } = renderDrawer();
      const onWidthChange = props.onWidthChange as ReturnType<typeof vi.fn>;
      const handle = screen.getByTestId('page-drawer-resize-handle');

      fireEvent.pointerDown(handle, { clientX: 800, clientY: 300, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: 700, clientY: 300, pointerId: 1 });
      fireEvent.pointerUp(handle, { clientX: 700, clientY: 300, pointerId: 1 });

      // 像素值当百分比写回去就是单位混算：这种情况宁可不改宽度。
      expect(onWidthChange).not.toHaveBeenCalled();
    } finally {
      if (original) {
        Object.defineProperty(window, 'innerWidth', original);
      }
    }
  });
});
