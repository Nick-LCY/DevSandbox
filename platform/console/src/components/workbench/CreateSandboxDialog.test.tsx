// @vitest-environment jsdom
/**
 * 新建沙箱抽屉：镜像列表读取失败时的反馈、创建成功后的收口。
 *
 * 覆盖四件事：
 * - 镜像列表读得到：抽屉里不留任何失败说明；
 * - 镜像列表读不到：弹一条失败 toast，**并**在抽屉里留一行就地环境状态说明
 *   （toast 5 秒就消失，只留 toast 会让空下拉变得没有解释）；
 * - 创建成功后不再渲染成功面板（成功面板已退役）；
 * - 创建成功后触发回调并关闭抽屉。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../Toast';
import { CreateSandboxDialog } from './CreateSandboxDialog';

const mocks = vi.hoisted(() => ({
  listImages: vi.fn(),
  createSandbox: vi.fn(),
}));

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listImages: mocks.listImages,
      createSandbox: mocks.createSandbox,
    },
  };
});

/** 宿主上的一张本地镜像。 */
const IMAGE = 'sandbox-platform/base:0.2.0';

/** 渲染带 Provider 的新建沙箱抽屉。 */
function renderDialog(overrides: Partial<Parameters<typeof CreateSandboxDialog>[0]> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    onCreated: vi.fn(),
    widthVw: 40,
    onWidthChange: vi.fn(),
    ...overrides,
  };
  return {
    props,
    ...render(
      <ToastProvider>
        <CreateSandboxDialog {...props} />
      </ToastProvider>,
    ),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.listImages.mockReset();
  mocks.createSandbox.mockReset();
});

describe('新建沙箱抽屉的镜像列表', () => {
  it('镜像列表读得到：抽屉里不留失败说明', async () => {
    mocks.listImages.mockResolvedValue([
      { reference: IMAGE, size_bytes: 1024, created_at: '2026-10-30T01:00:00+00:00' },
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

    // toast 会消失，抽屉里的这行说明一直在：空下拉有解释。
    const status = screen.getByTestId('page-sandbox-create-image-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toContain('镜像列表读取失败');
    expect(status.textContent).toContain('读取宿主本地镜像失败');
  });
});

describe('新建沙箱抽屉的创建结果', () => {
  /** 填好表单并提交。 */
  async function submitForm(): Promise<void> {
    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-create-image-detail')).toBeTruthy(),
    );
    fireEvent.change(screen.getByTestId('page-sandbox-create-name-input'), {
      target: { value: 'acc-demo' },
    });
    fireEvent.change(screen.getByTestId('page-sandbox-create-image-select'), {
      target: { value: IMAGE },
    });
    fireEvent.click(screen.getByTestId('page-sandbox-create-submit-button'));
  }

  it('创建成功后不再渲染成功面板', async () => {
    mocks.listImages.mockResolvedValue([
      { reference: IMAGE, size_bytes: 1024, created_at: '2026-10-30T01:00:00+00:00' },
    ]);
    mocks.createSandbox.mockResolvedValue({
      metadata: { name: 'acc-demo' },
      steps: ['第一步'],
      connection: { exec_command: 'docker exec -it sandbox-acc-demo bash' },
    });

    renderDialog();
    await submitForm();

    await waitFor(() => expect(mocks.createSandbox).toHaveBeenCalledTimes(1));
    // 成功面板的四个标识全部退役。
    expect(screen.queryByTestId('page-sandbox-create-success')).toBeNull();
    expect(screen.queryByTestId('page-sandbox-create-success-message')).toBeNull();
    expect(screen.queryByTestId('page-sandbox-create-steps')).toBeNull();
    expect(screen.queryByTestId('page-sandbox-create-success-link')).toBeNull();
  });

  it('创建成功后触发回调并关闭抽屉', async () => {
    mocks.listImages.mockResolvedValue([
      { reference: IMAGE, size_bytes: 1024, created_at: '2026-10-30T01:00:00+00:00' },
    ]);
    mocks.createSandbox.mockResolvedValue({
      metadata: { name: 'acc-demo' },
      steps: ['第一步'],
      connection: { exec_command: 'docker exec -it sandbox-acc-demo bash' },
    });

    const { props } = renderDialog();
    await submitForm();

    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith('acc-demo'));
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });
});
