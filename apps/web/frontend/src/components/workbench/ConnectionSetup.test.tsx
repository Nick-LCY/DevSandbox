// @vitest-environment jsdom
/**
 * 引导面板（未配置态）：后端地址 + 访问令牌 + 「保存并连接」。
 *
 * 覆盖决策 D 起的连接配置口径：**基址恒非空**——
 * - 后端地址**预填默认值** `http://127.0.0.1:8000`，允许编辑；
 * - 地址**不允许置空**：留空 → 就地红字（通用必填校验，网页形态与桌面形态一个口径）；
 * - 本地校验（地址格式非法 / 令牌为空）就地红字，不发请求。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_BACKEND_BASE_URL,
  PENDING_CONNECTION_STORAGE_KEY,
  type ConnectionConfig,
} from '../../lib/connection';
import { ToastProvider } from '../Toast';
import { ConnectionSetup } from './ConnectionSetup';

const mocks = vi.hoisted(() => ({
  health: vi.fn(),
}));

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      health: mocks.health,
    },
  };
});

/** 「保存并连接」的替身：工作台挂载后由它接手配置。 */
const onSave = vi.fn();

/** 渲染带 Provider 的引导面板（网页形态：不注入 `__TAURI_INTERNALS__`）。 */
function renderSetup(options?: { desktop?: boolean; config?: ConnectionConfig }): void {
  render(
    <ToastProvider>
      <ConnectionSetup
        config={options?.config ?? { backendBaseUrl: DEFAULT_BACKEND_BASE_URL, token: '' }}
        desktop={options?.desktop ?? false}
        onSave={onSave}
      />
    </ToastProvider>,
  );
}

/**
 * 注入桌面壳的 IPC 替身（`syncDesktopBackend` 靠 `window.__TAURI_INTERNALS__` 发命令）。
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

beforeEach(() => {
  mocks.health.mockResolvedValue({ version: '0.2.0', console_mounted: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.health.mockReset();
  window.localStorage.clear();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('引导面板的连接配置', () => {
  it('网页形态：后端地址可编辑（不再是只读）', async () => {
    renderSetup();

    const base = await screen.findByTestId('page-connection-base-url-input');
    expect((base as HTMLInputElement).readOnly).toBe(false);
  });

  it('地址框预填默认地址（基址恒非空）', async () => {
    renderSetup();

    const base = await screen.findByTestId('page-connection-base-url-input');
    expect((base as HTMLInputElement).value).toBe(DEFAULT_BACKEND_BASE_URL);
  });

  it('填了后端地址：体检与保存都按填的那台后端', async () => {
    renderSetup();

    const base = await screen.findByTestId('page-connection-base-url-input');
    fireEvent.change(base, { target: { value: 'http://10.0.0.5:8000' } });
    const token = screen.getByTestId('page-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_test' } });
    fireEvent.click(screen.getByTestId('page-connection-submit-button'));

    await waitFor(() => expect(mocks.health).toHaveBeenCalledTimes(1));
    expect(mocks.health.mock.calls[0][0]).toEqual({
      backendBaseUrl: 'http://10.0.0.5:8000',
      token: 'sbx_test',
    });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toEqual({
      backendBaseUrl: 'http://10.0.0.5:8000',
      token: 'sbx_test',
    });
  });

  it('地址留空：就地红字（基址必填），不发请求也不保存', async () => {
    renderSetup();

    const base = await screen.findByTestId('page-connection-base-url-input');
    fireEvent.change(base, { target: { value: '' } });
    const token = screen.getByTestId('page-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_test' } });
    fireEvent.click(screen.getByTestId('page-connection-submit-button'));

    const error = await screen.findByTestId('page-connection-error');
    expect(error.textContent).toContain('请填写后端地址');
    expect(error.getAttribute('role')).toBe('alert');
    expect(mocks.health).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('桌面形态：地址留空 → 同样就地红字（通用必填校验，桌面网页一个口径）', async () => {
    // 基址恒非空：网页形态与桌面形态共用同一条必填校验，不再有桌面特判。
    const { invoke } = injectDesktopRuntime();

    renderSetup({ desktop: true });

    const base = await screen.findByTestId('page-connection-base-url-input');
    fireEvent.change(base, { target: { value: '' } });
    const token = screen.getByTestId('page-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_test' } });
    fireEvent.click(screen.getByTestId('page-connection-submit-button'));

    const error = await screen.findByTestId('page-connection-error');
    expect(error.textContent).toContain('请填写后端地址');
    expect(error.getAttribute('role')).toBe('alert');
    // 不体检、不保存、不同步 CSP、不写待验证配置。
    expect(mocks.health).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(PENDING_CONNECTION_STORAGE_KEY)).toBeNull();
  });

  it('桌面形态：填了后端地址 → 照旧同步 CSP 再体检', async () => {
    const { invoke } = injectDesktopRuntime();
    invoke.mockResolvedValue(undefined);
    invoke.mockResolvedValueOnce(undefined);
    invoke.mockResolvedValue(false);

    renderSetup({ desktop: true });

    const base = await screen.findByTestId('page-connection-base-url-input');
    fireEvent.change(base, { target: { value: 'http://10.0.0.5:8000' } });
    const token = screen.getByTestId('page-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_test' } });
    fireEvent.click(screen.getByTestId('page-connection-submit-button'));

    await waitFor(() => expect(mocks.health).toHaveBeenCalledTimes(1));
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      'set_backend_base_url',
      'csp_needs_reload',
    ]);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  it('桌面形态：存量空基址 → 同步给桌面壳的是归一后的默认地址', async () => {
    // 决策 D 之前允许基址为空（同源）：那些存量数据归一为默认地址再送出去。
    // 送空串的话，Rust 侧解析不出主机 → CSP 静默拦死那台主机。
    const { invoke } = injectDesktopRuntime();
    invoke.mockResolvedValue(undefined);
    invoke.mockResolvedValueOnce(undefined);
    invoke.mockResolvedValueOnce(false);

    renderSetup({ desktop: true, config: { backendBaseUrl: '', token: '' } });

    const base = await screen.findByTestId('page-connection-base-url-input');
    // 表单回填的也是归一后的默认地址（归一规则只有 normalizeBaseUrl 一处）。
    expect((base as HTMLInputElement).value).toBe('http://127.0.0.1:8000');
    const token = screen.getByTestId('page-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_test' } });
    fireEvent.click(screen.getByTestId('page-connection-submit-button'));

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(invoke.mock.calls[0][0]).toBe('set_backend_base_url');
    expect(invoke.mock.calls[0][1]).toEqual({ backendBaseUrl: 'http://127.0.0.1:8000' });
  });

  it('桌面形态：填了漏 scheme 的地址 → 同步给桌面壳的是补好 scheme 的地址', async () => {
    // 用户填 `10.0.0.5:8000`：原串送进 Rust 侧的 `Url::parse` 会解析失败 →
    // `connect-src` 少掉那台主机 → 跨主机请求全被 CSP 拦死（界面上看不出原因）。
    const { invoke } = injectDesktopRuntime();
    invoke.mockResolvedValue(undefined);
    invoke.mockResolvedValueOnce(undefined);
    invoke.mockResolvedValueOnce(false);

    renderSetup({ desktop: true });

    const base = await screen.findByTestId('page-connection-base-url-input');
    fireEvent.change(base, { target: { value: '10.0.0.5:8000' } });
    const token = screen.getByTestId('page-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_test' } });
    fireEvent.click(screen.getByTestId('page-connection-submit-button'));

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(invoke.mock.calls[0][0]).toBe('set_backend_base_url');
    expect(invoke.mock.calls[0][1]).toEqual({ backendBaseUrl: 'http://10.0.0.5:8000' });
  });

  it('后端地址非法：就地红字，不发请求也不保存', async () => {
    renderSetup();

    const base = await screen.findByTestId('page-connection-base-url-input');
    fireEvent.change(base, { target: { value: 'ftp://host' } });
    const token = screen.getByTestId('page-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_test' } });
    fireEvent.click(screen.getByTestId('page-connection-submit-button'));

    const error = await screen.findByTestId('page-connection-error');
    expect(error.textContent).toContain('只支持 http 与 https');
    expect(mocks.health).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('令牌为空：就地红字，不发请求也不保存', async () => {
    renderSetup();

    fireEvent.click(screen.getByTestId('page-connection-submit-button'));

    const error = await screen.findByTestId('page-connection-error');
    expect(error.textContent).toContain('请填写访问令牌');
    expect(mocks.health).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
