// @vitest-environment jsdom
/**
 * 引导面板（未配置态）：后端地址 + 访问令牌 + 「保存并连接」。
 *
 * 覆盖 2026-11-03 起的连接配置口径：**两种形态不再有差别**——
 * - 网页形态的后端地址**不再只读**：填了就用（体检与保存都按填的那台后端）；
 * - 地址留空 = 与本页面同源（合法，不是「没填地址」）；
 * - 本地校验（地址格式非法 / 令牌为空）就地红字，不发请求。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PENDING_CONNECTION_STORAGE_KEY } from '../../lib/connection';
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
function renderSetup(options?: { desktop?: boolean }): void {
  render(
    <ToastProvider>
      <ConnectionSetup
        config={{ backendBaseUrl: '', token: '' }}
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

  it('地址留空 = 与本页面同源（合法配置）', async () => {
    renderSetup();

    const token = await screen.findByTestId('page-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_test' } });
    fireEvent.click(screen.getByTestId('page-connection-submit-button'));

    // 网页形态：留空照旧走体检（同源）。
    await waitFor(() => expect(mocks.health).toHaveBeenCalledTimes(1));
    expect(mocks.health.mock.calls[0][0]).toEqual({ backendBaseUrl: '', token: 'sbx_test' });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toEqual({ backendBaseUrl: '', token: 'sbx_test' });
  });

  it('桌面形态：地址留空 → 就地红字，不进「写 pending → 同步 CSP → 重载 → 体检」流程', async () => {
    // 桌面壳与后端不同源：留空 = 请求打到桌面壳自己，重载后必然 404，
    // 体检只会报一句误导人的「后端不可达」。
    const { invoke } = injectDesktopRuntime();

    renderSetup({ desktop: true });

    const token = await screen.findByTestId('page-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_test' } });
    fireEvent.click(screen.getByTestId('page-connection-submit-button'));

    const error = await screen.findByTestId('page-connection-error');
    expect(error.textContent).toContain('桌面形态必须填写后端地址');
    expect(error.textContent).toContain('桌面壳与后端不同源');
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
