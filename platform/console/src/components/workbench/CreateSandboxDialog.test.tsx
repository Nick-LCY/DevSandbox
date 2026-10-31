// @vitest-environment jsdom
/**
 * 新建沙箱弹窗：镜像列表读取失败时的反馈。
 *
 * 覆盖两件事：
 * - 镜像列表读得到：弹窗里不留任何失败说明；
 * - 镜像列表读不到：弹一条失败 toast，**并**在弹窗里留一行就地环境状态说明
 *   （toast 5 秒就消失，只留 toast 会让空下拉变得没有解释）。
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../Toast';
import { CreateSandboxDialog } from './CreateSandboxDialog';

const mocks = vi.hoisted(() => ({
  listImages: vi.fn(),
}));

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listImages: mocks.listImages,
    },
  };
});

/** 渲染带 Provider 的新建沙箱弹窗。 */
function renderDialog(): void {
  render(
    <ToastProvider>
      <CreateSandboxDialog open onOpenChange={vi.fn()} onCreated={vi.fn()} onOpenDetail={vi.fn()} />
    </ToastProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.listImages.mockReset();
});

describe('新建沙箱弹窗的镜像列表', () => {
  it('镜像列表读得到：弹窗里不留失败说明', async () => {
    mocks.listImages.mockResolvedValue([
      { reference: 'sandbox-platform/base:0.2.0', size_bytes: 1024, created_at: '2026-10-30T01:00:00+00:00' },
    ]);

    renderDialog();

    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-create-image-detail')).toBeTruthy(),
    );
    expect(screen.queryByTestId('page-sandbox-create-image-status')).toBeNull();
    expect(screen.queryByTestId('page-toast-item')).toBeNull();
  });

  it('镜像列表读不到：弹失败 toast，并留一行就地环境状态说明', async () => {
    mocks.listImages.mockRejectedValue(new Error('读取宿主本地镜像失败'));

    renderDialog();

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('error');
    expect(toast.textContent).toContain('读取宿主本地镜像失败');
    expect(toast.getAttribute('data-toast-source')).toBe('sandbox-create');

    // toast 会消失，弹窗里的这行说明一直在：空下拉有解释。
    const status = screen.getByTestId('page-sandbox-create-image-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toContain('镜像列表读取失败');
    expect(status.textContent).toContain('读取宿主本地镜像失败');
  });
});
