// @vitest-environment jsdom
/**
 * 弹窗外壳：基于 Base UI Dialog 原语的焦点管理与关闭途径。
 *
 * 覆盖四件事：
 * - 弹窗内容与标题挂在一个 role=dialog 的容器上；
 * - Esc 与右上角关闭按钮都能关闭；
 * - 关闭被禁用时（删除进行中）Esc 不响应；
 * - 打开时焦点落进弹窗里（焦点圈在弹窗内，不掉到背景上）。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModalShell } from './ModalShell';

afterEach(cleanup);

/** 等一拍：Base UI 的关闭是异步派发的。 */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('ModalShell', () => {
  it('弹窗内容与标题挂在一个 role=dialog 的容器上', async () => {
    render(
      <ModalShell open title="新建沙箱" testId="page-sandbox-create-dialog" onOpenChange={vi.fn()}>
        <p>弹窗正文</p>
      </ModalShell>,
    );

    const dialog = await screen.findByTestId('page-sandbox-create-dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.textContent).toContain('新建沙箱');
    expect(dialog.textContent).toContain('弹窗正文');
  });

  it('Esc 关闭：回调收到 false', async () => {
    const onOpenChange = vi.fn();
    render(
      <ModalShell open title="标题" testId="shell-dialog" onOpenChange={onOpenChange}>
        <p>弹窗正文</p>
      </ModalShell>,
    );
    await screen.findByTestId('shell-dialog');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('关闭被禁用时：Esc 与关闭按钮都不触发关闭', async () => {
    const onOpenChange = vi.fn();
    render(
      <ModalShell open closeDisabled title="标题" testId="shell-dialog" onOpenChange={onOpenChange}>
        <p>弹窗正文</p>
      </ModalShell>,
    );
    const dialog = await screen.findByTestId('shell-dialog');

    fireEvent.keyDown(document, { key: 'Escape' });
    await tick();
    expect(onOpenChange).not.toHaveBeenCalled();

    const closeButton = dialog.querySelector('button[aria-label="关闭"]');
    expect(closeButton).not.toBeNull();
    fireEvent.click(closeButton as HTMLButtonElement);
    await tick();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('关闭按钮点一下就关闭', async () => {
    const onOpenChange = vi.fn();
    render(
      <ModalShell open title="标题" testId="shell-dialog" onOpenChange={onOpenChange}>
        <p>弹窗正文</p>
      </ModalShell>,
    );
    const dialog = await screen.findByTestId('shell-dialog');

    const closeButton = dialog.querySelector('button[aria-label="关闭"]');
    expect(closeButton).not.toBeNull();
    fireEvent.click(closeButton as HTMLButtonElement);

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('打开时焦点落进弹窗里（焦点圈在弹窗内）', async () => {
    render(
      <ModalShell open title="标题" testId="shell-dialog" onOpenChange={vi.fn()}>
        <button type="button">弹窗里的按钮</button>
      </ModalShell>,
    );
    const dialog = await screen.findByTestId('shell-dialog');

    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });
});
