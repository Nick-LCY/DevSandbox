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

import { DEFAULT_BACKEND_BASE_URL, type ConnectionConfig } from '../../lib/connection';
import { ToastProvider } from '../Toast';
import { SettingsDialog } from './SettingsDialog';

const mocks = vi.hoisted(() => ({
  proxyStatus: vi.fn(),
  restartProxy: vi.fn(),
  listTemplates: vi.fn(),
  renameTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  health: vi.fn(),
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
      health: mocks.health,
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

/** 「保存配置」回调的替身。 */
const onConnectionChange = vi.fn();

/** 渲染带 Provider 的设置抽屉。 */
function renderDialog(options?: { connection?: ConnectionConfig }): void {
  render(
    <ToastProvider>
      <SettingsDialog
        open
        onOpenChange={vi.fn()}
        widthVw={40}
        onWidthChange={vi.fn()}
        connection={
          options?.connection ?? { backendBaseUrl: DEFAULT_BACKEND_BASE_URL, token: 'sbx_test' }
        }
        onConnectionChange={onConnectionChange}
      />
    </ToastProvider>,
  );
}

/**
 * 注入桌面壳的 IPC 替身（`isDesktopRuntime()` 靠 `window.__TAURI_INTERNALS__` 探测）。
 *
 * **必须在渲染前注入**：抽屉里的「桌面形态」判定是首渲染时算好的。
 */
function injectDesktopRuntime(): { invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn();
  invoke.mockResolvedValue(undefined);
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: { invoke },
    configurable: true,
    writable: true,
  });
  return { invoke };
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
  mocks.health.mockReset();
  // 桌面形态的探测标记（模块外注入，测试之间清掉）。
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

// 默认：代理状态读得到、模板列表为空（各用例自己覆盖需要的那一项）。
beforeEach(() => {
  mocks.proxyStatus.mockResolvedValue(makeStatus());
  mocks.listTemplates.mockResolvedValue([]);
  mocks.health.mockResolvedValue({ version: '0.2.0', console_mounted: true });
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

describe('设置抽屉的连接配置区', () => {
  it('「连接配置」区在抽屉里，网页形态下后端地址也能填', async () => {
    renderDialog();

    const section = await screen.findByLabelText('连接配置');
    expect(section.contains(screen.getByTestId('page-settings-connection-base-url-input'))).toBe(
      true,
    );
    expect(section.contains(screen.getByTestId('page-settings-connection-token-input'))).toBe(true);
    expect(section.contains(screen.getByTestId('page-settings-connection-test-button'))).toBe(true);
    expect(section.contains(screen.getByTestId('page-settings-connection-save-button'))).toBe(true);

    // 网页形态：后端地址不再是只读（与桌面形态一个口径）。
    const baseUrl = screen.getByTestId(
      'page-settings-connection-base-url-input',
    ) as HTMLInputElement;
    expect(baseUrl.readOnly).toBe(false);
  });

  it('地址框预填默认地址（基址恒非空）', async () => {
    renderDialog();

    const baseUrl = await screen.findByTestId(
      'page-settings-connection-base-url-input',
    ) as HTMLInputElement;
    expect(baseUrl.value).toBe(DEFAULT_BACKEND_BASE_URL);
  });

  it('「测试连接」成功：弹成功 toast（来源 connection）', async () => {
    renderDialog();

    await screen.findByTestId('page-settings-connection-test-button');
    fireEvent.click(screen.getByTestId('page-settings-connection-test-button'));

    await waitFor(() => expect(mocks.health).toHaveBeenCalledTimes(1));
    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('success');
    expect(toast.getAttribute('data-toast-source')).toBe('connection');
  });

  it('「测试连接」失败：弹失败 toast（来源 connection），文案带原因', async () => {
    mocks.health.mockRejectedValue(new Error('访问令牌无效或缺失'));

    renderDialog();

    await screen.findByTestId('page-settings-connection-test-button');
    fireEvent.click(screen.getByTestId('page-settings-connection-test-button'));

    await waitFor(() => expect(mocks.health).toHaveBeenCalledTimes(1));
    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('error');
    expect(toast.getAttribute('data-toast-source')).toBe('connection');
    expect(toast.textContent).toContain('访问令牌无效或缺失');
  });

  it('「保存配置」：把草稿交出去并弹成功 toast', async () => {
    renderDialog();

    const token = await screen.findByTestId('page-settings-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_new' } });
    fireEvent.click(screen.getByTestId('page-settings-connection-save-button'));

    await waitFor(() => expect(onConnectionChange).toHaveBeenCalledTimes(1));
    expect(onConnectionChange.mock.calls[0][0]).toEqual({
      backendBaseUrl: DEFAULT_BACKEND_BASE_URL,
      token: 'sbx_new',
    });
    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('success');
    expect(toast.getAttribute('data-toast-source')).toBe('connection');
  });

  it('「保存配置」：填了后端地址就带上（网页形态也能连远端后端）', async () => {
    renderDialog();

    const base = await screen.findByTestId('page-settings-connection-base-url-input');
    fireEvent.change(base, { target: { value: 'http://10.0.0.5:8000' } });
    fireEvent.click(screen.getByTestId('page-settings-connection-save-button'));

    await waitFor(() => expect(onConnectionChange).toHaveBeenCalledTimes(1));
    expect(onConnectionChange.mock.calls[0][0]).toEqual({
      backendBaseUrl: 'http://10.0.0.5:8000',
      token: 'sbx_test',
    });
  });

  it('后端地址非法：就地红字，不发请求也不保存', async () => {
    renderDialog();

    const base = await screen.findByTestId('page-settings-connection-base-url-input');
    fireEvent.change(base, { target: { value: 'ftp://host' } });
    fireEvent.click(screen.getByTestId('page-settings-connection-test-button'));

    const error = await screen.findByTestId('page-settings-connection-error');
    expect(error.textContent).toContain('只支持 http 与 https');
    expect(mocks.health).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('page-settings-connection-save-button'));
    expect(onConnectionChange).not.toHaveBeenCalled();
  });

  it('令牌为空：就地红字，不发请求也不保存', async () => {
    renderDialog();

    const token = await screen.findByTestId('page-settings-connection-token-input');
    fireEvent.change(token, { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('page-settings-connection-test-button'));

    const error = await screen.findByTestId('page-settings-connection-error');
    expect(error.textContent).toContain('请填写访问令牌');
    expect(mocks.health).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('page-settings-connection-save-button'));
    expect(onConnectionChange).not.toHaveBeenCalled();
  });

  it('校验红字带 role="alert"（读屏能播报）', async () => {
    renderDialog();

    const token = await screen.findByTestId('page-settings-connection-token-input');
    fireEvent.change(token, { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('page-settings-connection-test-button'));

    const error = await screen.findByTestId('page-settings-connection-error');
    expect(error.getAttribute('role')).toBe('alert');
  });

  it('桌面形态：后端地址留空 → 同样就地红字（通用必填校验，桌面网页一个口径）', async () => {
    // 基址恒非空：留空由通用必填校验拦下，不再有桌面特判的专属文案。
    const { invoke } = injectDesktopRuntime();

    renderDialog();

    const base = await screen.findByTestId('page-settings-connection-base-url-input');
    fireEvent.change(base, { target: { value: '' } });
    await screen.findByTestId('page-settings-connection-save-button');
    fireEvent.click(screen.getByTestId('page-settings-connection-save-button'));

    const error = await screen.findByTestId('page-settings-connection-error');
    expect(error.textContent).toContain('请填写后端地址');
    expect(error.getAttribute('role')).toBe('alert');
    // 不落盘、不弹成功 toast、不同步 CSP（那一步会重载主文档）。
    expect(onConnectionChange).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.queryByTestId('page-toast-item')).toBeNull();
  });

  it('网页形态：后端地址留空 → 同样就地红字，不保存（基址必填）', async () => {
    renderDialog();

    const base = await screen.findByTestId('page-settings-connection-base-url-input');
    fireEvent.change(base, { target: { value: '   ' } });
    await screen.findByTestId('page-settings-connection-save-button');
    fireEvent.click(screen.getByTestId('page-settings-connection-save-button'));

    const error = await screen.findByTestId('page-settings-connection-error');
    expect(error.textContent).toContain('请填写后端地址');
    expect(onConnectionChange).not.toHaveBeenCalled();
  });

  it('桌面形态：填了漏 scheme 的地址 → 同步给桌面壳的是补好 scheme 的地址', async () => {
    // 用户填 `10.0.0.5:8000`：原串送进 Rust 侧的 `Url::parse` 会解析失败 →
    // `connect-src` 少掉那台主机 → 跨主机请求全被 CSP 拦死（界面上看不出原因）。
    const { invoke } = injectDesktopRuntime();
    // `csp_needs_reload` 返回 false（不用重载主文档）；其余命令返回 undefined。
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'csp_needs_reload' ? false : undefined),
    );

    renderDialog();

    const base = await screen.findByTestId('page-settings-connection-base-url-input');
    fireEvent.change(base, { target: { value: '10.0.0.5:8000' } });
    fireEvent.click(screen.getByTestId('page-settings-connection-save-button'));

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    // 保存配置时**先重启已开启的本机监听**（forward_listeners），再同步 CSP，
    // 所以不能假设第一条 invoke 就是同步命令。
    const syncCall = invoke.mock.calls.find((call) => call[0] === 'set_backend_base_url');
    expect(syncCall).toBeTruthy();
    expect(syncCall?.[1]).toEqual({ backendBaseUrl: 'http://10.0.0.5:8000' });
  });

  it('桌面形态：存量空基址 → 表单回填与同步都是归一后的默认地址', async () => {
    // 决策 D 之前允许基址为空（同源）：那些存量数据归一为默认地址再送出去。
    const { invoke } = injectDesktopRuntime();
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'csp_needs_reload' ? false : undefined),
    );

    renderDialog({ connection: { backendBaseUrl: '', token: 'sbx_test' } });

    const base = await screen.findByTestId('page-settings-connection-base-url-input');
    expect((base as HTMLInputElement).value).toBe('http://127.0.0.1:8000');
    fireEvent.click(screen.getByTestId('page-settings-connection-save-button'));

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    const syncCall = invoke.mock.calls.find((call) => call[0] === 'set_backend_base_url');
    expect(syncCall).toBeTruthy();
    expect(syncCall?.[1]).toEqual({ backendBaseUrl: 'http://127.0.0.1:8000' });
  });

  it('桌面形态：保存连接配置 → 已开启的本机监听用新凭据重启（同端口）', async () => {
    // 令牌与基址是**开启监听那一刻的快照**：改了配置不重启，旧监听仍拿着
    // 旧凭据，隧道会以 1008（策略违规）收场。
    const { invoke } = injectDesktopRuntime();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'forward_listeners') {
        return Promise.resolve([
          {
            forward_id: 'abc123def456',
            container_port: 8080,
            local_port: 18000,
            state: 'listening',
          },
        ]);
      }
      if (cmd === 'csp_needs_reload') {
        return Promise.resolve(false);
      }
      return Promise.resolve(undefined);
    });

    renderDialog();

    const token = await screen.findByTestId('page-settings-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_new' } });
    fireEvent.click(screen.getByTestId('page-settings-connection-save-button'));

    // 先停后开，且用**新令牌 + 同一个本机端口**重开。
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('stop_forward', { forwardId: 'abc123def456' }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('start_forward', {
        forwardId: 'abc123def456',
        backendBaseUrl: 'http://127.0.0.1:8000',
        token: 'sbx_new',
        containerPort: 8080,
        localPort: 18000,
      }),
    );
    // 顺序：stop 在 start 之前。
    const stopIndex = invoke.mock.calls.findIndex((call) => call[0] === 'stop_forward');
    const startIndex = invoke.mock.calls.findIndex((call) => call[0] === 'start_forward');
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThan(stopIndex);
  });

  it('桌面形态：某条监听重启失败 → 弹失败提示，其余流程不中断', async () => {
    const { invoke } = injectDesktopRuntime();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'forward_listeners') {
        return Promise.resolve([
          {
            forward_id: 'abc123def456',
            container_port: 8080,
            local_port: 18000,
            state: 'listening',
          },
        ]);
      }
      if (cmd === 'stop_forward') {
        return Promise.reject('本机监听停止失败');
      }
      if (cmd === 'csp_needs_reload') {
        return Promise.resolve(false);
      }
      return Promise.resolve(undefined);
    });

    renderDialog();

    const token = await screen.findByTestId('page-settings-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_new' } });
    fireEvent.click(screen.getByTestId('page-settings-connection-save-button'));

    const toast = await screen.findByTestId('page-toast-item');
    // toast 同时只留最新一条：失败提示弹在成功提示之后，最终看到的是它。
    await waitFor(() => expect(toast.textContent).toContain('本机监听重启失败'));
    // 失败不中断：配置照样保存成功。
    await waitFor(() => expect(onConnectionChange).toHaveBeenCalled());
  });
});
