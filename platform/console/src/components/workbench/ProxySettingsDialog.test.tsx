// @vitest-environment jsdom
/**
 * 代理设置弹窗：重启失败时的反馈不被「状态刷新失败」顶掉。
 *
 * 覆盖两件事：
 * - 重启成功：弹成功 toast；
 * - 重启失败：弹失败 toast；随后那次状态刷新也失败时，**不能**再弹一条
 *   「读取代理状态失败」把更具体的「重启代理失败」顶掉。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../Toast';
import { ProxySettingsDialog } from './ProxySettingsDialog';

const mocks = vi.hoisted(() => ({
  proxyStatus: vi.fn(),
  restartProxy: vi.fn(),
}));

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      proxyStatus: mocks.proxyStatus,
      restartProxy: mocks.restartProxy,
    },
  };
});

/** 一份够用的代理状态。 */
function makeStatus() {
  return {
    container: { exists: true, running: true },
    healthy: true,
    tcp_ok: true,
    ca_fetchable: true,
    cache_size_bytes: 1024,
    certificate_ready: true,
    proxy_url: 'http://127.0.0.1:3128',
    detail: '正常',
  };
}

/** 一份够用的重启结果。 */
function makeRestartResult() {
  return {
    ...makeStatus(),
    restarted: true,
    ca_changed: false,
    ca_reinstalled: false,
    message: '重启成功，代理已恢复健康',
    reinstalled_users: [],
    failed_users: [],
  };
}

/** 渲染带 Provider 的代理设置弹窗。 */
function renderDialog(): void {
  render(
    <ToastProvider>
      <ProxySettingsDialog open onOpenChange={vi.fn()} widthVw={40} onWidthChange={vi.fn()} />
    </ToastProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.proxyStatus.mockReset();
  mocks.restartProxy.mockReset();
});

describe('代理重启反馈', () => {
  it('重启成功：弹成功 toast', async () => {
    mocks.proxyStatus.mockResolvedValue(makeStatus());
    mocks.restartProxy.mockResolvedValue(makeRestartResult());

    renderDialog();

    await screen.findByTestId('page-settings-cache-size');
    fireEvent.click(screen.getByTestId('page-settings-restart-button'));

    await waitFor(() => {
      const toast = screen.getByTestId('page-toast-item');
      expect(toast.getAttribute('data-toast-kind')).toBe('success');
    });
  });

  it('重启失败：弹失败 toast，状态刷新也失败时不顶掉它', async () => {
    // 首次读状态成功；重启后的那次状态刷新失败。
    mocks.proxyStatus.mockResolvedValueOnce(makeStatus());
    mocks.proxyStatus.mockRejectedValue(new Error('读取代理状态失败'));
    mocks.restartProxy.mockRejectedValue(new Error('重启代理失败：容器起不来'));

    renderDialog();

    await screen.findByTestId('page-settings-cache-size');
    fireEvent.click(screen.getByTestId('page-settings-restart-button'));

    await waitFor(() => {
      const toast = screen.getByTestId('page-toast-item');
      expect(toast.getAttribute('data-toast-kind')).toBe('error');
      expect(toast.textContent).toContain('重启代理失败：容器起不来');
    });
    // 等重启后的那次状态刷新也跑完：失败提示不能被它顶掉。
    await waitFor(() => expect(mocks.proxyStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('page-toast-item').textContent).toContain('重启代理失败：容器起不来');
    expect(screen.getByTestId('page-toast-item').textContent).not.toContain('读取代理状态失败');
  });
});
