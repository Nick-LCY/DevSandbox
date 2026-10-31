// @vitest-environment jsdom
/**
 * 停止沙箱确认弹窗：复选框默认值、取消与确认、忙碌时锁关闭。
 *
 * 覆盖四件事：
 * - 复选框默认勾选（与命令行默认一致）；
 * - 取消勾选后确认：回调收到「不停依赖容器」；
 * - 点「确认停止」才真的发停止请求（取消不发）；
 * - 停止进行中 Esc 不响应、按钮禁用。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StopSandboxDialog } from './StopSandboxDialog';

afterEach(cleanup);

/** 渲染弹窗（默认开着、默认勾选依赖容器）。 */
function renderDialog(overrides: Partial<Parameters<typeof StopSandboxDialog>[0]> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    sandboxName: 'acc-demo',
    stopDependencies: true,
    onStopDependenciesChange: vi.fn(),
    busy: false,
    onConfirm: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<StopSandboxDialog {...props} />) };
}

describe('StopSandboxDialog', () => {
  it('复选框默认勾选「同时停止依赖容器」', () => {
    renderDialog();

    const checkbox = screen.getByTestId(
      'page-sandbox-detail-stop-dependencies-checkbox',
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(screen.getByTestId('page-sandbox-detail-stop-dialog').textContent).toContain(
      '同时停止依赖容器',
    );
  });

  it('取消勾选会回调新的勾选状态', () => {
    const { props } = renderDialog();

    const checkbox = screen.getByTestId(
      'page-sandbox-detail-stop-dependencies-checkbox',
    ) as HTMLInputElement;
    fireEvent.click(checkbox);

    expect(props.onStopDependenciesChange).toHaveBeenCalledWith(false);
  });

  it('点确认才发停止请求；取消不发', async () => {
    const { props } = renderDialog();

    // 取消：只关弹窗，不发请求。
    fireEvent.click(screen.getByTestId('page-sandbox-detail-stop-cancel-button'));
    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
    expect(props.onConfirm).not.toHaveBeenCalled();

    // 确认：发请求。
    fireEvent.click(screen.getByTestId('page-sandbox-detail-stop-confirm-button'));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('停止进行中：Esc 不响应，按钮禁用', async () => {
    const { props } = renderDialog({ busy: true });

    fireEvent.keyDown(document, { key: 'Escape' });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(props.onOpenChange).not.toHaveBeenCalled();

    const confirm = screen.getByTestId(
      'page-sandbox-detail-stop-confirm-button',
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toContain('正在停止');
  });

  it('弹窗没打开时不渲染任何内容', () => {
    renderDialog({ open: false });

    expect(screen.queryByTestId('page-sandbox-detail-stop-dialog')).toBeNull();
    expect(screen.queryByTestId('page-sandbox-detail-stop-confirm-button')).toBeNull();
  });
});
