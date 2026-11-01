// @vitest-environment jsdom
/**
 * 删除沙箱确认弹窗：一次点确认即执行、内容口径与关闭途径。
 *
 * 覆盖五件事：
 * - 点一次「确认删除」就真的发删除请求（不再有武装窗口）；
 * - 内容含后果说明与「用户挂载的宿主机目录不受影响」的安全提示；
 * - Esc 关闭不发删除请求；
 * - 删除进行中 Esc 不响应（不可逆操作不能半途退出）；
 * - 弹窗没打开时不渲染任何内容。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeleteSandboxDialog, UNTOUCHED_NOTE } from './DeleteSandboxDialog';

afterEach(cleanup);

/** 渲染弹窗（默认开着）。 */
function renderDialog(overrides: Partial<Parameters<typeof DeleteSandboxDialog>[0]> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    sandboxName: 'acc-demo',
    busy: false,
    onConfirm: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<DeleteSandboxDialog {...props} />) };
}

describe('DeleteSandboxDialog', () => {
  it('一次点确认即执行：直接发删除请求', () => {
    const { props } = renderDialog();

    const confirm = screen.getByTestId('page-sandbox-detail-delete-confirm-button');
    expect(confirm.textContent).toContain('确认删除');

    fireEvent.click(confirm);
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('内容含后果说明与安全提示', () => {
    renderDialog();

    const dialog = screen.getByTestId('page-sandbox-detail-delete-dialog');
    expect(dialog.textContent).toContain('此操作不可撤销');
    // 安全提示块单独挂标识，文案固定。
    expect(screen.getByTestId('page-sandbox-detail-delete-untouched-note').textContent).toContain(
      UNTOUCHED_NOTE,
    );
    expect(UNTOUCHED_NOTE).toBe('用户挂载的宿主机目录不受影响');
    // 标题带沙箱名。
    expect(screen.getByTestId('page-sandbox-detail-delete-title').textContent).toContain('acc-demo');
  });

  it('Esc 关闭：弹窗关闭但不发删除请求', async () => {
    const { props } = renderDialog();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('删除进行中：Esc 不响应，也不发删除请求', async () => {
    const { props } = renderDialog({ busy: true });

    fireEvent.keyDown(document, { key: 'Escape' });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(props.onConfirm).not.toHaveBeenCalled();
    // 确认按钮禁用、按钮文案提示正在删除。
    const confirm = screen.getByTestId('page-sandbox-detail-delete-confirm-button') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toContain('正在删除');
  });

  it('弹窗没打开时不渲染任何内容', () => {
    renderDialog({ open: false });

    expect(screen.queryByTestId('page-sandbox-detail-delete-dialog')).toBeNull();
    expect(screen.queryByTestId('page-sandbox-detail-delete-confirm-button')).toBeNull();
  });
});
