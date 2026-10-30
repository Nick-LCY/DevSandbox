// @vitest-environment jsdom
/**
 * 删除沙箱确认弹窗：回收清单的两种圆点、兜底文案、两步确认与关闭途径。
 *
 * 覆盖六件事：
 * - 平台回收项渲染红点，用户声明的挂载渲染绿点（两类资源的处置完全不同）；
 * - 后端没给「不受影响」说明时用兜底文案；
 * - 两步确认：第一次点只武装不发请求，第二次才真的发；
 * - 武装窗口（5 秒）过期后要重新武装：过期后的第一次点击仍然不发请求；
 * - Esc 关闭不发删除请求；
 * - 删除进行中 Esc 不响应（不可逆操作不能半途退出）。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReclaimPlan } from '../../api/types';
import { DeleteSandboxDialog, UNTOUCHED_NOTE_FALLBACK } from './DeleteSandboxDialog';

afterEach(() => {
  // 假定时器必须还原，否则下一条用例会跟着停在假时间里。
  vi.useRealTimers();
  cleanup();
});

/** 武装窗口：第一次点确认后，多久内再点一次才真的删除（毫秒）。 */
const ARM_WINDOW = 5000;

/** 一份典型的回收清单：两项平台资源 + 一条用户挂载。 */
function makePlan(overrides: Partial<ReclaimPlan> = {}): ReclaimPlan {
  return {
    sandbox_name: 'acc-demo',
    items: ['容器 sandbox-acc-demo', '网络 acc-demo-net'],
    untouched_note: '用户挂载的宿主机目录不受影响',
    user_mounts: ['/data/acc-demo'],
    incomplete: false,
    ...overrides,
  };
}

/** 渲染弹窗（默认开着、清单齐全）。 */
function renderDialog(overrides: Partial<Parameters<typeof DeleteSandboxDialog>[0]> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    plan: makePlan(),
    busy: false,
    onConfirm: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<DeleteSandboxDialog {...props} />) };
}

/** 列表项前面的圆点。 */
function dotOf(item: HTMLElement): HTMLElement {
  const dot = item.querySelector('span[aria-hidden="true"]');
  if (!(dot instanceof HTMLElement)) {
    throw new Error('清单项里没有圆点');
  }
  return dot;
}

describe('DeleteSandboxDialog', () => {
  it('平台回收项渲染红点，用户声明的挂载渲染绿点', () => {
    renderDialog();

    const items = screen.getAllByTestId('page-sandbox-detail-delete-item');
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(dotOf(item).className).toContain('bg-destructive');
    }
    expect(items[0].textContent).toContain('容器 sandbox-acc-demo');

    const mounts = screen.getAllByTestId('page-sandbox-detail-delete-user-mount-item');
    expect(mounts).toHaveLength(1);
    expect(dotOf(mounts[0]).className).toContain('bg-success');
    expect(mounts[0].textContent).toContain('/data/acc-demo');
  });

  it('「不受影响」说明为空时用兜底文案，有内容时保留原文', () => {
    const { unmount } = renderDialog({ plan: makePlan({ untouched_note: '   ' }) });
    expect(screen.getByTestId('page-sandbox-detail-delete-untouched-note').textContent).toContain(
      UNTOUCHED_NOTE_FALLBACK,
    );
    expect(UNTOUCHED_NOTE_FALLBACK).toBe('用户挂载的宿主机目录不受影响');
    unmount();

    renderDialog({ plan: makePlan({ untouched_note: '这些目录平台不碰' }) });
    const note = screen.getByTestId('page-sandbox-detail-delete-untouched-note');
    expect(note.textContent).toContain('这些目录平台不碰');
    expect(note.textContent).not.toContain(UNTOUCHED_NOTE_FALLBACK);
  });

  it('两步确认：第一次点只武装不发请求，第二次才真的发', async () => {
    const { props } = renderDialog();

    const confirm = screen.getByTestId('page-sandbox-detail-delete-confirm-button');
    expect(confirm.textContent).toContain('确认删除');

    // 第一次点：只武装。
    fireEvent.click(confirm);
    expect(props.onConfirm).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-detail-delete-armed-hint')).toBeTruthy(),
    );
    expect(confirm.textContent).toContain('再点一次确认删除');

    // 第二次点：真的发。
    fireEvent.click(confirm);
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('武装窗口过期：过期后第一次点击只重新武装，不发删除请求', async () => {
    vi.useFakeTimers();
    const { props } = renderDialog();
    const confirm = screen.getByTestId('page-sandbox-detail-delete-confirm-button');

    // 第一次点：只武装。
    fireEvent.click(confirm);
    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(screen.getByTestId('page-sandbox-detail-delete-armed-hint')).toBeTruthy();

    // 武装窗口过去：自动解除武装（按钮文案与提示条都回去）。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ARM_WINDOW);
    });
    expect(screen.queryByTestId('page-sandbox-detail-delete-armed-hint')).toBeNull();
    expect(confirm.textContent).not.toContain('再点一次');

    // 过期后第一次点：只重新武装，仍不发删除请求。
    fireEvent.click(confirm);
    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(screen.getByTestId('page-sandbox-detail-delete-armed-hint')).toBeTruthy();

    // 再点一次：这次才真的发。
    fireEvent.click(confirm);
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
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
