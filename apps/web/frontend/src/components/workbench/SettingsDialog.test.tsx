// @vitest-environment jsdom
/**
 * 设置抽屉：代理设置的重启反馈不被「状态刷新失败」顶掉；
 * 第二区的启动模板管理（列表 / 行内重命名 / 删除确认）。
 *
 * 覆盖几件事：
 * - 重启成功：弹成功 toast；
 * - 重启失败：弹失败 toast；随后那次状态刷新也失败时，**不能**再弹一条
 *   「读取代理状态失败」把更具体的「重启代理失败」顶掉；
 * - 模板列表渲染（名称 + 更新时间）与空态；
 * - 行内重命名：回车提交、Esc 取消、空名禁提交；
 * - 删除走确认弹窗，文案写明只删模板、不影响已创建的沙箱；
 * - 删除结果说「没删掉」时提示「记录已不存在」，不谎报已删除；
 * - 模板管理区不再挂说明段（模板是什么由文档讲，界面不重复）；
 * - 「刷新状态」与「重启代理」两个按钮在代理设置区里（抽屉不再有全局页脚）。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../Toast';
import { SettingsDialog } from './SettingsDialog';

const mocks = vi.hoisted(() => ({
  proxyStatus: vi.fn(),
  restartProxy: vi.fn(),
  listTemplates: vi.fn(),
  renameTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
}));

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      proxyStatus: mocks.proxyStatus,
      restartProxy: mocks.restartProxy,
      listTemplates: mocks.listTemplates,
      renameTemplate: mocks.renameTemplate,
      deleteTemplate: mocks.deleteTemplate,
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

/** 渲染带 Provider 的设置抽屉。 */
function renderDialog(): void {
  render(
    <ToastProvider>
      <SettingsDialog open onOpenChange={vi.fn()} widthVw={40} onWidthChange={vi.fn()} />
    </ToastProvider>,
  );
}

/** 一条模板记录。 */
function makeTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tpl_0123456789ab',
    name: '开发环境',
    config: { image: 'sandbox-platform/base:0.3.0' },
    created_at: '2026-10-31T01:00:00+00:00',
    updated_at: '2026-10-31T02:00:00+00:00',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.proxyStatus.mockReset();
  mocks.restartProxy.mockReset();
  mocks.listTemplates.mockReset();
  mocks.renameTemplate.mockReset();
  mocks.deleteTemplate.mockReset();
});

// 默认：代理状态读得到、模板列表为空（各用例自己覆盖需要的那一项）。
beforeEach(() => {
  mocks.proxyStatus.mockResolvedValue(makeStatus());
  mocks.listTemplates.mockResolvedValue([]);
});

describe('代理重启反馈', () => {
  it('刷新与重启两个按钮在代理设置区里（抽屉不再有全局页脚）', async () => {
    renderDialog();

    await screen.findByTestId('page-settings-cache-size');
    const section = screen.getByLabelText('代理设置');
    expect(section.contains(screen.getByTestId('page-settings-refresh-button'))).toBe(true);
    expect(section.contains(screen.getByTestId('page-settings-restart-button'))).toBe(true);

    // 抽屉页脚（按钮区）整个没了。
    const drawer = screen.getByTestId('page-settings-dialog');
    const footers = Array.from(drawer.querySelectorAll('div')).filter((element) =>
      (element.getAttribute('class') ?? '').includes('bg-muted/40'),
    );
    expect(footers).toHaveLength(0);
  });

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

describe('设置抽屉的模板管理区', () => {
  it('模板列表渲染：名称与最近更新时间', async () => {
    mocks.listTemplates.mockResolvedValue([makeTemplate()]);

    renderDialog();

    const item = await screen.findByTestId('page-settings-template-item');
    expect(item.getAttribute('data-template-name')).toBe('开发环境');
    expect(screen.getByTestId('page-settings-template-name').textContent).toBe('开发环境');
    expect(screen.getByTestId('page-settings-template-updated-at').textContent).toContain('更新于');
  });

  it('一个模板都没有：给空态说明', async () => {
    renderDialog();

    const empty = await screen.findByTestId('page-settings-template-empty');
    expect(empty.textContent).toContain('还没有模板');
  });

  it('模板管理区不再挂说明段', async () => {
    renderDialog();

    await screen.findByTestId('page-settings-template-empty');
    expect(document.body.textContent).not.toContain('模板是一份沙箱启动配置');
  });

  it('读不到模板列表：弹失败 toast（来源 settings-template）', async () => {
    mocks.listTemplates.mockRejectedValue(new Error('读取模板列表失败'));

    renderDialog();

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('error');
    expect(toast.getAttribute('data-toast-source')).toBe('settings-template');
    expect(toast.textContent).toContain('读取模板列表失败');
  });

  it('行内重命名：回车提交，成功弹 toast', async () => {
    mocks.listTemplates.mockResolvedValue([makeTemplate()]);
    mocks.renameTemplate.mockResolvedValue(makeTemplate({ name: '开发环境 A' }));

    renderDialog();

    await screen.findByTestId('page-settings-template-item');
    fireEvent.click(screen.getByTestId('page-settings-template-rename-button'));

    const input = screen.getByTestId('page-settings-template-rename-input') as HTMLInputElement;
    expect(input.value).toBe('开发环境');
    fireEvent.change(input, { target: { value: '开发环境 A' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mocks.renameTemplate).toHaveBeenCalledTimes(1));
    expect(mocks.renameTemplate.mock.calls[0][0]).toBe('tpl_0123456789ab');
    expect(mocks.renameTemplate.mock.calls[0][1]).toBe('开发环境 A');
    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('success');
    expect(toast.getAttribute('data-toast-source')).toBe('settings-template');
  });

  it('行内重命名：Esc 取消，不发请求', async () => {
    mocks.listTemplates.mockResolvedValue([makeTemplate()]);

    renderDialog();

    await screen.findByTestId('page-settings-template-item');
    fireEvent.click(screen.getByTestId('page-settings-template-rename-button'));

    const input = screen.getByTestId('page-settings-template-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '改了一半' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(mocks.renameTemplate).not.toHaveBeenCalled();
    // 回到只读的一行：输入框没了。
    expect(screen.queryByTestId('page-settings-template-rename-input')).toBeNull();
    expect(screen.getByTestId('page-settings-template-name').textContent).toBe('开发环境');
  });

  it('行内重命名：空名禁提交（按钮禁用）', async () => {
    mocks.listTemplates.mockResolvedValue([makeTemplate()]);

    renderDialog();

    await screen.findByTestId('page-settings-template-item');
    fireEvent.click(screen.getByTestId('page-settings-template-rename-button'));

    const input = screen.getByTestId('page-settings-template-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });

    const save = screen.getByTestId('page-settings-template-rename-save-button') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(mocks.renameTemplate).not.toHaveBeenCalled();
  });

  it('删除走确认弹窗：文案写明只删模板、不影响已建沙箱', async () => {
    mocks.listTemplates.mockResolvedValue([makeTemplate()]);
    mocks.deleteTemplate.mockResolvedValue({ id: 'tpl_0123456789ab', deleted: true });

    renderDialog();

    await screen.findByTestId('page-settings-template-item');
    fireEvent.click(screen.getByTestId('page-settings-template-delete-button'));

    const dialog = await screen.findByTestId('page-settings-template-delete-dialog');
    expect(dialog.textContent).toContain('删除模板 开发环境');
    expect(screen.getByTestId('page-settings-template-delete-untouched-note').textContent).toBe(
      '只删模板，不影响已创建的沙箱',
    );
    // 确认前一个删除请求都不发。
    expect(mocks.deleteTemplate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('page-settings-template-delete-confirm-button'));
    await waitFor(() => expect(mocks.deleteTemplate).toHaveBeenCalledWith('tpl_0123456789ab'));
    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('success');
    expect(toast.getAttribute('data-toast-source')).toBe('settings-template');
  });

  it('删除结果说没删掉：提示「记录已不存在」，不谎报已删除', async () => {
    mocks.listTemplates.mockResolvedValue([makeTemplate()]);
    mocks.deleteTemplate.mockResolvedValue({ id: 'tpl_0123456789ab', deleted: false });

    renderDialog();

    await screen.findByTestId('page-settings-template-item');
    fireEvent.click(screen.getByTestId('page-settings-template-delete-button'));
    fireEvent.click(
      await screen.findByTestId('page-settings-template-delete-confirm-button'),
    );

    await waitFor(() => expect(mocks.deleteTemplate).toHaveBeenCalledTimes(1));
    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('info');
    expect(toast.getAttribute('data-toast-source')).toBe('settings-template');
    expect(toast.textContent).toContain('记录已不存在（可能已被删除）');
    expect(toast.textContent).not.toContain('已删除');
  });
});
