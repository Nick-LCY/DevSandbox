// @vitest-environment jsdom
/**
 * 抽屉外壳：基于 Base UI Drawer 原语的焦点管理、关闭途径与宽度调整。
 *
 * 覆盖六件事：
 * - 抽屉面板与标题挂在一个 role=dialog 的容器上；
 * - Esc 关闭；
 * - 关闭被禁用时（不可逆操作进行中）Esc 与关闭按钮都不响应；
 * - 打开时焦点落进抽屉里；
 * - 宽度拖拽把手存在，且是 role=separator 的竖向分隔条；
 * - 把手上按方向键能改宽度（每次 2 个百分点，Home 回默认值）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DrawerShell } from './DrawerShell';

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
