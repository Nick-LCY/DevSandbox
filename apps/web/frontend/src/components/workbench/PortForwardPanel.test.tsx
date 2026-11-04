// @vitest-environment jsdom
/**
 * 端口转发区（沙箱详情抽屉里）的两种形态。
 *
 * 覆盖决策 C 的形态差异与本机端口规则：
 * - **web 形态**：**只渲染说明卡 + 「安装桌面端」按钮**（点击开 ModalShell
 *   安装指引弹窗），**不渲染列表 / 新建 / 停止等任何管理操作**；
 * - **桌面形态**：完整管理——新建（容器端口 + 本机端口，默认 = 容器端口）、
 *   列表按「容器端口 → 本机端口」呈现、开启 / 关闭本机监听、停止转发、
 *   开启后行内显示 `http://127.0.0.1:<port>` 与复制按钮；
 * - **被占自动换端口**：Rust 侧返回的实际端口与请求值不同时，界面显示
 *   **实际值**，提示里说清楚换了端口；
 * - 校验红字就地展示（`role="alert"`），不发请求。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_BACKEND_BASE_URL, type ConnectionConfig } from '../../lib/connection';
import { ToastProvider } from '../Toast';
import { PortForwardPanel } from './PortForwardPanel';

const mocks = vi.hoisted(() => ({
  listForwards: vi.fn(),
  createForward: vi.fn(),
  deleteForward: vi.fn(),
  startForwardListener: vi.fn(),
  stopForwardListener: vi.fn(),
  listForwardListeners: vi.fn(),
  listenForwardEvents: vi.fn(),
}));

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listForwards: mocks.listForwards,
      createForward: mocks.createForward,
      deleteForward: mocks.deleteForward,
    },
  };
});

vi.mock('../../lib/desktop-forward', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/desktop-forward')>();
  return {
    ...actual,
    startForwardListener: mocks.startForwardListener,
    stopForwardListener: mocks.stopForwardListener,
    listForwardListeners: mocks.listForwardListeners,
    listenForwardEvents: mocks.listenForwardEvents,
  };
});

/** 一条转发记录。 */
function makeForward(overrides?: Partial<{ id: string; container_port: number; state: string }>) {
  return {
    id: 'abc123def456',
    sandbox: 'demo-01',
    container_port: 8080,
    state: 'running',
    created_at: '2026-11-03T00:00:00Z',
    updated_at: '2026-11-03T00:00:00Z',
    ...overrides,
  };
}

/** 连接配置（桌面形态下要经 IPC 交给 Rust 侧）。 */
const connection: ConnectionConfig = {
  backendBaseUrl: DEFAULT_BACKEND_BASE_URL,
  token: 'sbx_test',
};

/** 渲染带 Provider 的端口转发区。 */
function renderPanel(options?: { desktop?: boolean }): void {
  render(
    <ToastProvider>
      <PortForwardPanel
        sandbox="demo-01"
        desktop={options?.desktop ?? true}
        connection={connection}
      />
    </ToastProvider>,
  );
}

beforeEach(() => {
  mocks.listForwards.mockResolvedValue([]);
  mocks.createForward.mockResolvedValue(makeForward());
  mocks.deleteForward.mockResolvedValue({ id: 'abc123def456', removed: [], failed: [] });
  mocks.startForwardListener.mockResolvedValue(8080);
  mocks.stopForwardListener.mockResolvedValue(undefined);
  mocks.listForwardListeners.mockResolvedValue([]);
  mocks.listenForwardEvents.mockResolvedValue(() => {});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('web 形态的端口转发区', () => {
  it('只渲染说明卡与「安装桌面端」按钮，不渲染任何管理操作', async () => {
    renderPanel({ desktop: false });

    await waitFor(() => expect(mocks.listForwards).not.toHaveBeenCalled());
    expect(mocks.createForward).not.toHaveBeenCalled();

    expect(screen.getByTestId('page-forward-notice')).toBeTruthy();
    expect(screen.getByTestId('page-forward-install-button')).toBeTruthy();
    // 管理操作一个都不渲染。
    expect(screen.queryByTestId('page-forward-panel')).toBeNull();
    expect(screen.queryByTestId('page-forward-list')).toBeNull();
    expect(screen.queryByTestId('page-forward-create-submit-button')).toBeNull();
    expect(screen.queryByTestId('page-forward-item')).toBeNull();
  });

  it('点「安装桌面端」开 ModalShell 安装指引弹窗', async () => {
    renderPanel({ desktop: false });

    fireEvent.click(screen.getByTestId('page-forward-install-button'));

    const dialog = await screen.findByTestId('page-forward-install-dialog');
    expect(dialog).toBeTruthy();
    // 三个要点：安装包来源、装完填后端地址与令牌、开启后访问 127.0.0.1:<端口>。
    expect(screen.getByTestId('page-forward-install-step-package')).toBeTruthy();
    expect(screen.getByTestId('page-forward-install-step-config')).toBeTruthy();
    expect(screen.getByTestId('page-forward-install-step-access')).toBeTruthy();
  });

  it('说明卡文案：网页形态无法管理端口转发（不说「只能查看转发记录」）', async () => {
    renderPanel({ desktop: false });

    const notice = screen.getByTestId('page-forward-notice');
    expect(notice.textContent).toContain('网页形态无法管理端口转发，请使用桌面端');
    expect(notice.textContent).not.toContain('只能查看转发记录');
  });
});

describe('桌面形态的端口转发区', () => {
  it('列出转发：容器端口 → 本机端口，开启后显示本机地址与复制按钮', async () => {
    mocks.listForwards.mockResolvedValue([makeForward()]);
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'abc123def456', container_port: 8080, local_port: 18000, state: 'listening' },
    ]);

    renderPanel({ desktop: true });

    const item = await screen.findByTestId('page-forward-item');
    expect(item).toBeTruthy();
    // 映射按「容器端口 → 本机端口」呈现（本机端口是实际值 18000）。
    expect(screen.getByTestId('page-forward-item-mapping').textContent).toBe('8080 → 18000');
    // 开启后行内显示本机访问地址 + 复制按钮。
    expect(screen.getByTestId('page-forward-item-url').textContent).toBe(
      'http://127.0.0.1:18000',
    );
    expect(screen.getByTestId('page-forward-item-copy-button')).toBeTruthy();
    // 行内两个操作：关闭本机监听 + 停止转发。
    expect(screen.getByTestId('page-forward-item-toggle-button').textContent).toContain(
      '关闭本机监听',
    );
    expect(screen.getByTestId('page-forward-item-stop-button')).toBeTruthy();
  });

  it('新建：容器端口默认带出本机端口，转发后开启本机监听', async () => {
    renderPanel({ desktop: true });

    const containerInput = await screen.findByTestId('page-forward-create-container-port-input');
    const localInput = screen.getByTestId('page-forward-create-local-port-input') as HTMLInputElement;
    // 本机端口默认跟随容器端口（= 容器端口）。
    expect(localInput.value).toBe('');

    fireEvent.change(containerInput, { target: { value: '8080' } });
    await waitFor(() =>
      expect(
        (screen.getByTestId('page-forward-create-local-port-input') as HTMLInputElement).value,
      ).toBe('8080'),
    );

    fireEvent.click(screen.getByTestId('page-forward-create-submit-button'));

    await waitFor(() => expect(mocks.createForward).toHaveBeenCalledWith('demo-01', 8080));
    await waitFor(() =>
      expect(mocks.startForwardListener).toHaveBeenCalledWith(
        expect.objectContaining({
          forwardId: 'abc123def456',
          containerPort: 8080,
          localPort: 8080,
        }),
      ),
    );
  });

  it('校验红字就地展示，不发请求', async () => {
    renderPanel({ desktop: true });

    const containerInput = await screen.findByTestId('page-forward-create-container-port-input');
    fireEvent.change(containerInput, { target: { value: '70000' } });
    fireEvent.click(screen.getByTestId('page-forward-create-submit-button'));

    const error = await screen.findByTestId('page-forward-create-error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toContain('容器端口必须在 1~65535 之间');
    expect(mocks.createForward).not.toHaveBeenCalled();
  });

  it('本机端口为空视为非法输入', async () => {
    renderPanel({ desktop: true });

    const containerInput = await screen.findByTestId('page-forward-create-container-port-input');
    fireEvent.change(containerInput, { target: { value: '8080' } });
    const localInput = screen.getByTestId('page-forward-create-local-port-input');
    fireEvent.change(localInput, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('page-forward-create-submit-button'));

    const error = await screen.findByTestId('page-forward-create-error');
    expect(error.textContent).toContain('请填写本机端口');
    expect(mocks.createForward).not.toHaveBeenCalled();
  });

  it('本机端口被占自动换端口时显示实际值', async () => {
    mocks.listForwards.mockResolvedValue([makeForward()]);
    // Rust 侧返回的实际端口与请求值不同（8080 被占 → 换成 18000）。
    mocks.startForwardListener.mockResolvedValue(18000);

    renderPanel({ desktop: true });

    const item = await screen.findByTestId('page-forward-item');
    expect(item).toBeTruthy();

    fireEvent.click(screen.getByTestId('page-forward-item-toggle-button'));

    await waitFor(() =>
      expect(screen.getByTestId('page-forward-item-url').textContent).toBe(
        'http://127.0.0.1:18000',
      ),
    );
    // 提示里说清楚换了端口。
    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.textContent).toContain('8080');
    expect(toast.textContent).toContain('18000');
  });

  it('关闭本机监听：调 Rust 的 stop_forward', async () => {
    mocks.listForwards.mockResolvedValue([makeForward()]);
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'abc123def456', container_port: 8080, local_port: 8080, state: 'listening' },
    ]);

    renderPanel({ desktop: true });

    await screen.findByTestId('page-forward-item');
    fireEvent.click(screen.getByTestId('page-forward-item-toggle-button'));

    await waitFor(() => expect(mocks.stopForwardListener).toHaveBeenCalledWith('abc123def456'));
    await waitFor(() => expect(screen.queryByTestId('page-forward-item-url')).toBeNull());
  });

  it('停止转发：先关本机监听，再删后端的转发记录', async () => {
    mocks.listForwards.mockResolvedValue([makeForward()]);
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'abc123def456', container_port: 8080, local_port: 8080, state: 'listening' },
    ]);

    renderPanel({ desktop: true });

    await screen.findByTestId('page-forward-item');
    fireEvent.click(screen.getByTestId('page-forward-item-stop-button'));

    await waitFor(() => expect(mocks.stopForwardListener).toHaveBeenCalledWith('abc123def456'));
    await waitFor(() => expect(mocks.deleteForward).toHaveBeenCalledWith('abc123def456'));
    await waitFor(() => expect(screen.queryByTestId('page-forward-item')).toBeNull());
  });

  it('停止转发：本机监听停不掉 → 弹警告提示，记录照删（不静默）', async () => {
    mocks.listForwards.mockResolvedValue([makeForward()]);
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'abc123def456', container_port: 8080, local_port: 8080, state: 'listening' },
    ]);
    mocks.stopForwardListener.mockRejectedValue(new Error('本机监听停不掉'));
    // 删除请求悬着：失败提示留在屏幕上（不被后续的成功提示顶掉）。
    mocks.deleteForward.mockImplementation(() => new Promise(() => {}));

    renderPanel({ desktop: true });

    await screen.findByTestId('page-forward-item');
    fireEvent.click(screen.getByTestId('page-forward-item-stop-button'));

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.textContent).toContain(
      '本机监听停止失败，该端口可能仍被占用；请在桌面端重新开启本机监听后再关闭',
    );
    // 失败不中断：转发记录照删。
    await waitFor(() => expect(mocks.deleteForward).toHaveBeenCalledWith('abc123def456'));
  });

  it('没有本机监听时：徽标只说本机监听语义（未开启），后端记录状态另起一行', async () => {
    mocks.listForwards.mockResolvedValue([makeForward()]);

    renderPanel({ desktop: true });

    await screen.findByTestId('page-forward-item');
    const badge = screen.getByTestId('page-forward-item-state');
    // 徽标的文字与颜色同源：都是本机监听语义（未开启 = 灰）。
    expect(badge.textContent).toContain('未开启');
    expect(badge.textContent).not.toContain('可用');
    expect(badge.className).toContain('text-status-stopped');
    // 后端记录状态（running / 已停止）不进徽标，单独一行文字。
    expect(screen.getByTestId('page-forward-item-record-state').textContent).toBe('转发状态：可用');
  });

  it('开启进行中：徽标显示「开启中」（琥珀脉动）', async () => {
    mocks.listForwards.mockResolvedValue([makeForward()]);
    // 开启请求悬着：徽标停在「开启中」。
    mocks.startForwardListener.mockImplementation(() => new Promise(() => {}));

    renderPanel({ desktop: true });

    await screen.findByTestId('page-forward-item');
    fireEvent.click(screen.getByTestId('page-forward-item-toggle-button'));

    await waitFor(() =>
      expect(screen.getByTestId('page-forward-item-state').textContent).toContain('开启中'),
    );
    expect(screen.getByTestId('page-forward-item-state').className).toContain('animate-status-pulse');
  });

  it('invoke 拒绝裸字符串 → 行内红字展示 Rust 侧的原文', async () => {
    // **走真实的 IPC 桥**（不 mock `startForwardListener`）：桌面壳的 invoke
    // 拒绝值是裸字符串（Rust 侧的 `Result<_, String>`），桥层收口成 Error，
    // 界面拿到的就是那段固定中文文案——不被兜底文案顶掉。
    const actual = await vi.importActual<typeof import('../../lib/desktop-forward')>(
      '../../lib/desktop-forward',
    );
    mocks.startForwardListener.mockImplementation(actual.startForwardListener);
    const invoke = vi
      .fn()
      .mockRejectedValue('本机端口 80 小于 1024，当前系统不允许普通用户绑定低端口');
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: { invoke },
      configurable: true,
      writable: true,
    });
    mocks.listForwards.mockResolvedValue([makeForward()]);

    renderPanel({ desktop: true });

    await screen.findByTestId('page-forward-item');
    fireEvent.click(screen.getByTestId('page-forward-item-toggle-button'));

    const error = await screen.findByTestId('page-forward-item-error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toBe(
      '本机端口 80 小于 1024，当前系统不允许普通用户绑定低端口',
    );
  });
});
