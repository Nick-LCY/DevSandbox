// @vitest-environment jsdom
/**
 * 端口转发区（沙箱详情抽屉里）的两种形态。
 *
 * 覆盖本轮重排后的口径：
 * - **web 形态**：**只渲染说明卡 + 「安装桌面端」按钮**（点击开 ModalShell
 *   安装指引弹窗），**不渲染表格 / 新建 / 同步 / 编辑 / 删除等任何管理操作**，
 *   也不读任何数据；
 * - **桌面形态**：五列表格（本地端口 / 容器端口 / 本地状态 / 容器状态 / 操作），
 *   **行集合 = 后端记录 ∪ 本机监听的并集**（正常行 / 无监听行 / 孤儿行），
 *   状态是**纯圆点 + tooltip**（圆点带 `aria-label`，可访问名不丢），
 *   操作列三个 icon 按钮：**同步 / 编辑本机端口 / 删除转发**；
 * - **本机监听的生命周期完全手动**：轮询刷回来的数据**不触发任何开 / 关监听**；
 * - **新建双开**、**删除（先停后删 / 孤儿行只停 / 无本机监听则不调 stop）**、
 *   **同步两方向**（含监听迁移与迁移停不掉时中止）、**行内编辑**
 *   （停旧 → 按新端口重开、Esc 不冒泡、回车防重入）、**校验红字就地展示**。
 *
 * 转发记录**由工作台经 props 送来**：测试直接传 props，不再 mock 面板内的
 * 转发记录拉取（面板已经不拉了）。
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ForwardModel } from '../../api/types';
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
function makeForward(overrides?: Partial<ForwardModel>): ForwardModel {
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
function renderPanel(options?: {
  desktop?: boolean;
  forwards?: ForwardModel[];
  onForwardsChanged?: () => void;
}): void {
  render(
    <ToastProvider>
      <PortForwardPanel
        sandbox="demo-01"
        desktop={options?.desktop ?? true}
        connection={connection}
        forwards={options?.forwards ?? []}
        onForwardsChanged={options?.onForwardsChanged ?? (() => {})}
      />
    </ToastProvider>,
  );
}

/** 表格里的一行（按转发标识定位）。 */
function rowOf(forwardId: string): HTMLElement {
  const row = screen
    .queryAllByTestId('page-forward-row')
    .find((node) => node.getAttribute('data-forward-id') === forwardId);
  if (!row) {
    throw new Error(`找不到转发 ${forwardId} 的行`);
  }
  return row;
}

/** 某一行里的元素。 */
function cellOf(forwardId: string, testId: string): HTMLElement {
  return within(rowOf(forwardId)).getByTestId(testId);
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

    expect(screen.getByTestId('page-forward-notice')).toBeTruthy();
    expect(screen.getByTestId('page-forward-install-button')).toBeTruthy();
    // 管理操作一个都不渲染。
    expect(screen.queryByTestId('page-forward-panel')).toBeNull();
    expect(screen.queryByTestId('page-forward-table')).toBeNull();
    expect(screen.queryByTestId('page-forward-create-submit-button')).toBeNull();
    expect(screen.queryByTestId('page-forward-row')).toBeNull();
  });

  it('web 形态不读任何数据（不查转发记录，也不查本机监听）', async () => {
    renderPanel({ desktop: false });

    await waitFor(() => expect(mocks.listForwards).not.toHaveBeenCalled());
    expect(mocks.listForwardListeners).not.toHaveBeenCalled();
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

describe('桌面形态：五列表格与行并集', () => {
  it('表头五列：本地端口 / 容器端口 / 本地状态 / 容器状态 / 操作', async () => {
    renderPanel({ desktop: true, forwards: [makeForward()] });

    const table = await screen.findByTestId('page-forward-table');
    const headers = within(table).getAllByRole('columnheader').map((node) => node.textContent);
    expect(headers).toEqual(['本机端口', '容器端口', '本地状态', '容器状态', '操作']);
  });

  it('行集合 = 后端记录 ∪ 本机监听：正常行 / 无监听行 / 孤儿行', async () => {
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'abc123def456', container_port: 8080, local_port: 18000, state: 'listening' },
      // 孤儿行：后端没有这条记录，本机还在听。
      { forward_id: 'orphan001', container_port: 7070, local_port: 17070, state: 'listening' },
    ]);

    renderPanel({
      desktop: true,
      // 有记录有监听（正常行）+ 有记录无监听（无监听行）。
      forwards: [makeForward(), makeForward({ id: 'second00001', container_port: 9090 })],
    });

    await screen.findByTestId('page-forward-table');
    const rows = screen.getAllByTestId('page-forward-row');
    expect(rows).toHaveLength(3);
    // 孤儿行也照常渲染（记录被删了，本机还在听）。
    expect(rowOf('orphan001').getAttribute('data-container-port')).toBe('7070');
    expect(cellOf('orphan001', 'page-forward-row-container-port').textContent).toBe('7070');
  });

  it('本机端口列显示实际生效端口；没有监听显示「—」', async () => {
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'abc123def456', container_port: 8080, local_port: 18000, state: 'listening' },
    ]);

    renderPanel({
      desktop: true,
      forwards: [makeForward(), makeForward({ id: 'second00001', container_port: 9090 })],
    });

    await screen.findByTestId('page-forward-table');
    // 有监听：显示实际端口（不是容器端口）。
    expect(cellOf('abc123def456', 'page-forward-row-local-port').textContent).toBe('18000');
    // 无监听：占位符。
    expect(cellOf('second00001', 'page-forward-row-local-port').textContent).toBe('—');
  });

  it('容器端口列显示后端记录的值', async () => {
    renderPanel({ desktop: true, forwards: [makeForward({ container_port: 3000 })] });

    await screen.findByTestId('page-forward-table');
    expect(cellOf('abc123def456', 'page-forward-row-container-port').textContent).toBe('3000');
  });
});

describe('桌面形态：状态圆点', () => {
  it('本机状态：未开启红 / 监听中绿 / 开启中黄脉动', async () => {
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'abc123def456', container_port: 8080, local_port: 18000, state: 'listening' },
    ]);

    renderPanel({
      desktop: true,
      forwards: [makeForward(), makeForward({ id: 'second00001', container_port: 9090 })],
    });

    await screen.findByTestId('page-forward-table');

    // 有监听：绿。
    const listening = cellOf('abc123def456', 'page-forward-row-local-state');
    expect(listening.getAttribute('data-state')).toBe('listening');
    expect(listening.className).toContain('text-status-running');
    expect(listening.className).not.toContain('animate-status-pulse');

    // 无监听：未开启（红）。
    const stopped = cellOf('second00001', 'page-forward-row-local-state');
    expect(stopped.getAttribute('data-state')).toBe('stopped');
    expect(stopped.className).toContain('text-status-failed');
  });

  it('开启中：琥珀脉动（data-state="starting"）', async () => {
    // 开启请求悬着：圆点停在「开启中」。
    mocks.startForwardListener.mockImplementation(() => new Promise(() => {}));

    renderPanel({ desktop: true, forwards: [makeForward()] });

    await screen.findByTestId('page-forward-table');
    fireEvent.click(screen.getByTestId('page-forward-row-sync-button'));

    await waitFor(() =>
      expect(
        cellOf('abc123def456', 'page-forward-row-local-state').getAttribute('data-state'),
      ).toBe('starting'),
    );
    const dot = cellOf('abc123def456', 'page-forward-row-local-state');
    expect(dot.className).toContain('text-status-busy');
    expect(dot.className).toContain('animate-status-pulse');
  });

  it('容器状态：可用绿 / 已停止红 / 孤儿行红', async () => {
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'orphan001', container_port: 7070, local_port: 17070, state: 'listening' },
    ]);

    renderPanel({
      desktop: true,
      forwards: [
        makeForward(),
        makeForward({ id: 'second00001', container_port: 9090, state: 'stopped' }),
      ],
    });

    await screen.findByTestId('page-forward-table');

    const running = cellOf('abc123def456', 'page-forward-row-container-state');
    expect(running.getAttribute('data-state')).toBe('running');
    expect(running.className).toContain('text-status-running');

    const stopped = cellOf('second00001', 'page-forward-row-container-state');
    expect(stopped.getAttribute('data-state')).toBe('stopped');
    expect(stopped.className).toContain('text-status-failed');

    const orphan = cellOf('orphan001', 'page-forward-row-container-state');
    expect(orphan.getAttribute('data-state')).toBe('orphan');
    expect(orphan.className).toContain('text-status-failed');
    // 容器状态列不用脉动。
    expect(orphan.className).not.toContain('animate-status-pulse');
  });

  it('圆点的可访问名（aria-label）就是提示文案', async () => {
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'abc123def456', container_port: 8080, local_port: 18000, state: 'listening' },
    ]);

    renderPanel({
      desktop: true,
      forwards: [makeForward(), makeForward({ id: 'second00001', container_port: 9090 })],
    });

    await screen.findByTestId('page-forward-table');

    expect(cellOf('abc123def456', 'page-forward-row-local-state').getAttribute('aria-label')).toBe(
      '监听中 · 127.0.0.1:18000',
    );
    expect(cellOf('second00001', 'page-forward-row-local-state').getAttribute('aria-label')).toBe(
      '本机监听未开启',
    );
    expect(cellOf('abc123def456', 'page-forward-row-container-state').getAttribute('aria-label')).toBe(
      '后端转发可用',
    );
  });

  it('圆点不是 button（纯展示，不占 Tab 序列），但带 role="img" 进可访问树', async () => {
    renderPanel({ desktop: true, forwards: [makeForward()] });

    await screen.findByTestId('page-forward-table');
    const dot = cellOf('abc123def456', 'page-forward-row-local-state');
    expect(dot.tagName).toBe('SPAN');
    // role="img"：圆点真正进可访问树（可访问名就是 aria-label）。
    expect(dot.getAttribute('role')).toBe('img');
    expect(
      cellOf('abc123def456', 'page-forward-row-container-state').getAttribute('role'),
    ).toBe('img');
  });
});

describe('桌面形态：新建转发', () => {
  it('容器端口默认带出本机端口，转发后开启本机监听（一步双开）', async () => {
    const onForwardsChanged = vi.fn();
    renderPanel({ desktop: true, onForwardsChanged });

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
    // 写操作完成后通知工作台重拉转发记录。
    expect(onForwardsChanged).toHaveBeenCalled();
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
});

describe('桌面形态：删除转发', () => {
  it('先关本机监听，再删后端的转发记录', async () => {
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'abc123def456', container_port: 8080, local_port: 8080, state: 'listening' },
    ]);
    const onForwardsChanged = vi.fn();

    renderPanel({ desktop: true, forwards: [makeForward()], onForwardsChanged });

    await screen.findByTestId('page-forward-table');
    fireEvent.click(screen.getByTestId('page-forward-row-delete-button'));

    await waitFor(() => expect(mocks.stopForwardListener).toHaveBeenCalledWith('abc123def456'));
    await waitFor(() => expect(mocks.deleteForward).toHaveBeenCalledWith('abc123def456'));
    expect(onForwardsChanged).toHaveBeenCalled();
  });

  it('本机监听停不掉 → 弹警告提示，记录照删（不静默）', async () => {
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'abc123def456', container_port: 8080, local_port: 8080, state: 'listening' },
    ]);
    mocks.stopForwardListener.mockRejectedValue(new Error('本机监听停不掉'));
    // 删除请求悬着：失败提示留在屏幕上（不被后续的成功提示顶掉）。
    mocks.deleteForward.mockImplementation(() => new Promise(() => {}));

    renderPanel({ desktop: true, forwards: [makeForward()] });

    await screen.findByTestId('page-forward-table');
    fireEvent.click(screen.getByTestId('page-forward-row-delete-button'));

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.textContent).toContain(
      '本机监听停止失败，该端口可能仍被占用；请在桌面端重新开启本机监听后再关闭',
    );
    // 失败不中断：转发记录照删。
    await waitFor(() => expect(mocks.deleteForward).toHaveBeenCalledWith('abc123def456'));
  });

  it('孤儿行（后端没有记录）：只关本机监听，不发 DELETE', async () => {
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'orphan001', container_port: 7070, local_port: 17070, state: 'listening' },
    ]);

    renderPanel({ desktop: true, forwards: [] });

    await screen.findByTestId('page-forward-table');
    fireEvent.click(within(rowOf('orphan001')).getByTestId('page-forward-row-delete-button'));

    await waitFor(() => expect(mocks.stopForwardListener).toHaveBeenCalledWith('orphan001'));
    expect(mocks.deleteForward).not.toHaveBeenCalled();
  });

  it('无本机监听的行：删除时不调 stopForwardListener、不弹失败提示，DELETE 照常发', async () => {
    // 本机监听表是空的（这一行本机没在听）。
    const onForwardsChanged = vi.fn();

    renderPanel({ desktop: true, forwards: [makeForward()], onForwardsChanged });

    await screen.findByTestId('page-forward-table');
    fireEvent.click(screen.getByTestId('page-forward-row-delete-button'));

    await waitFor(() => expect(mocks.deleteForward).toHaveBeenCalledWith('abc123def456'));
    // 本机没在听：不去停（停了也停不掉，只会误报一条「停止失败」）。
    expect(mocks.stopForwardListener).not.toHaveBeenCalled();
    // 没有失败提示：只有一条成功提示。
    const toasts = screen.queryAllByTestId('page-toast-item');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].getAttribute('data-toast-kind')).toBe('success');
    expect(onForwardsChanged).toHaveBeenCalled();
  });
});

describe('桌面形态：同步转发', () => {
  it('方向一：后端可用 + 本机无监听 → 开启本机监听（端口交给桌面端挑）', async () => {
    const onForwardsChanged = vi.fn();
    renderPanel({ desktop: true, forwards: [makeForward()], onForwardsChanged });

    await screen.findByTestId('page-forward-table');
    fireEvent.click(screen.getByTestId('page-forward-row-sync-button'));

    await waitFor(() =>
      expect(mocks.startForwardListener).toHaveBeenCalledWith(
        expect.objectContaining({
          forwardId: 'abc123def456',
          containerPort: 8080,
          // 传 null：Rust 侧默认取容器端口，被占自动换空闲端口。
          localPort: null,
        }),
      ),
    );
    // 后端记录已经是可用的：不重复建记录。
    expect(mocks.createForward).not.toHaveBeenCalled();
    expect(onForwardsChanged).toHaveBeenCalled();
  });

  it('方向一：Rust 换了端口 → 提示里说清实际端口', async () => {
    mocks.startForwardListener.mockResolvedValue(18000);
    renderPanel({ desktop: true, forwards: [makeForward()] });

    await screen.findByTestId('page-forward-table');
    fireEvent.click(screen.getByTestId('page-forward-row-sync-button'));

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.textContent).toContain('8080');
    expect(toast.textContent).toContain('18000');
  });

  it('方向二：本机在听 + 后端无记录 → 建记录，标识变了就把监听迁到新标识', async () => {
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'orphan001', container_port: 7070, local_port: 17070, state: 'listening' },
    ]);
    // 后端重建的记录是**新标识**（旧标识已失效）。
    mocks.createForward.mockResolvedValue(makeForward({ id: 'newid000001', container_port: 7070 }));

    renderPanel({ desktop: true, forwards: [] });

    await screen.findByTestId('page-forward-table');
    fireEvent.click(within(rowOf('orphan001')).getByTestId('page-forward-row-sync-button'));

    await waitFor(() => expect(mocks.createForward).toHaveBeenCalledWith('demo-01', 7070));
    // 旧标识的监听先停掉，再按新标识重开（端口不变）。
    await waitFor(() => expect(mocks.stopForwardListener).toHaveBeenCalledWith('orphan001'));
    await waitFor(() =>
      expect(mocks.startForwardListener).toHaveBeenCalledWith(
        expect.objectContaining({
          forwardId: 'newid000001',
          containerPort: 7070,
          localPort: 17070,
        }),
      ),
    );
  });

  it('迁移期间：旧行的圆点也变「开启中」（用户盯着的那行有反馈）', async () => {
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'orphan001', container_port: 7070, local_port: 17070, state: 'listening' },
    ]);
    mocks.createForward.mockResolvedValue(makeForward({ id: 'newid000001', container_port: 7070 }));
    // 停旧监听悬着：迁移停在半路。
    mocks.stopForwardListener.mockImplementation(() => new Promise(() => {}));

    renderPanel({ desktop: true, forwards: [] });

    await screen.findByTestId('page-forward-table');
    fireEvent.click(within(rowOf('orphan001')).getByTestId('page-forward-row-sync-button'));

    await waitFor(() =>
      expect(cellOf('orphan001', 'page-forward-row-local-state').getAttribute('data-state')).toBe(
        'starting',
      ),
    );
    expect(cellOf('orphan001', 'page-forward-row-local-state').className).toContain(
      'animate-status-pulse',
    );
  });

  it('迁移时旧监听停不掉 → 中止迁移（不开新监听），弹提示，新记录行仍立即出现', async () => {
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'orphan001', container_port: 7070, local_port: 17070, state: 'listening' },
    ]);
    mocks.createForward.mockResolvedValue(makeForward({ id: 'newid000001', container_port: 7070 }));
    mocks.stopForwardListener.mockRejectedValue(new Error('本机监听停不掉'));
    const onForwardsChanged = vi.fn();

    renderPanel({ desktop: true, forwards: [], onForwardsChanged });

    await screen.findByTestId('page-forward-table');
    fireEvent.click(within(rowOf('orphan001')).getByTestId('page-forward-row-sync-button'));

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.textContent).toContain('本机监听仍指向旧的转发标识，请删除该行后重新同步');
    expect(toast.getAttribute('data-toast-kind')).toBe('info');
    expect(toast.getAttribute('data-toast-source')).toBe('port-forward');
    // 中止迁移：不对新标识开监听（会端口冲突）。
    expect(mocks.startForwardListener).not.toHaveBeenCalled();
    // 新记录行仍然立刻出现。
    expect(onForwardsChanged).toHaveBeenCalled();
    // 退出 busy 态：同步键重新可用。
    const syncButton = within(rowOf('orphan001')).getByTestId(
      'page-forward-row-sync-button',
    ) as HTMLButtonElement;
    await waitFor(() => expect(syncButton.disabled).toBe(false));
  });

  it('后端已停 + 本机无监听 → 同步 = 先建记录，再开监听（端口交给桌面端挑）', async () => {
    mocks.createForward.mockResolvedValue(
      makeForward({ id: 'newid000001', container_port: 8080, state: 'running' }),
    );

    renderPanel({ desktop: true, forwards: [makeForward({ state: 'stopped' })] });

    await screen.findByTestId('page-forward-table');
    fireEvent.click(screen.getByTestId('page-forward-row-sync-button'));

    await waitFor(() => expect(mocks.createForward).toHaveBeenCalledWith('demo-01', 8080));
    await waitFor(() =>
      expect(mocks.startForwardListener).toHaveBeenCalledWith(
        expect.objectContaining({
          forwardId: 'newid000001',
          containerPort: 8080,
          // 传 null：Rust 侧默认取容器端口，被占自动换空闲端口。
          localPort: null,
        }),
      ),
    );
    // 本机没有监听：不用停旧监听。
    expect(mocks.stopForwardListener).not.toHaveBeenCalled();
  });

  it('方向二：复用了同一条记录（标识没变）→ 监听不动', async () => {
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'abc123def456', container_port: 8080, local_port: 8080, state: 'listening' },
    ]);
    mocks.createForward.mockResolvedValue(makeForward({ state: 'stopped' }));

    renderPanel({ desktop: true, forwards: [makeForward({ state: 'stopped' })] });

    await screen.findByTestId('page-forward-table');
    fireEvent.click(screen.getByTestId('page-forward-row-sync-button'));

    await waitFor(() => expect(mocks.createForward).toHaveBeenCalledWith('demo-01', 8080));
    // 标识没变：既不停也不重开监听。
    expect(mocks.stopForwardListener).not.toHaveBeenCalled();
    expect(mocks.startForwardListener).not.toHaveBeenCalled();
    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.textContent).toContain('转发已同步');
  });

  it('两者已经一致：不发任何请求，只弹一条成功提示', async () => {
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'abc123def456', container_port: 8080, local_port: 8080, state: 'listening' },
    ]);

    renderPanel({ desktop: true, forwards: [makeForward()] });

    await screen.findByTestId('page-forward-table');
    fireEvent.click(screen.getByTestId('page-forward-row-sync-button'));

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.textContent).toContain('转发已同步');
    expect(mocks.startForwardListener).not.toHaveBeenCalled();
    expect(mocks.stopForwardListener).not.toHaveBeenCalled();
    expect(mocks.createForward).not.toHaveBeenCalled();
  });
});

describe('桌面形态：行内编辑本机端口', () => {
  it('未开启本机监听时：编辑按钮禁用并说明原因', async () => {
    renderPanel({ desktop: true, forwards: [makeForward()] });

    await screen.findByTestId('page-forward-table');
    const button = screen.getByTestId('page-forward-row-edit-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('本机监听未开启，先同步或新建后再编辑');
  });

  it('监听中：可编辑；确认后停旧监听、按新端口重开', async () => {
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'abc123def456', container_port: 8080, local_port: 8080, state: 'listening' },
    ]);

    renderPanel({ desktop: true, forwards: [makeForward()] });

    await screen.findByTestId('page-forward-table');
    const button = screen.getByTestId('page-forward-row-edit-button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('title')).toBe('编辑本机端口');

    fireEvent.click(button);

    const input = await screen.findByTestId('page-forward-row-edit-input');
    expect((input as HTMLInputElement).value).toBe('8080');
    fireEvent.change(input, { target: { value: '18001' } });
    fireEvent.click(screen.getByTestId('page-forward-row-edit-confirm-button'));

    await waitFor(() => expect(mocks.stopForwardListener).toHaveBeenCalledWith('abc123def456'));
    await waitFor(() =>
      expect(mocks.startForwardListener).toHaveBeenCalledWith(
        expect.objectContaining({
          forwardId: 'abc123def456',
          containerPort: 8080,
          localPort: 18001,
        }),
      ),
    );
  });

  it('端口被占自动换端口：提示里说清实际端口', async () => {
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'abc123def456', container_port: 8080, local_port: 8080, state: 'listening' },
    ]);
    mocks.startForwardListener.mockResolvedValue(18002);

    renderPanel({ desktop: true, forwards: [makeForward()] });

    await screen.findByTestId('page-forward-table');
    fireEvent.click(screen.getByTestId('page-forward-row-edit-button'));
    const input = await screen.findByTestId('page-forward-row-edit-input');
    fireEvent.change(input, { target: { value: '18001' } });
    fireEvent.click(screen.getByTestId('page-forward-row-edit-confirm-button'));

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.textContent).toContain('18001');
    expect(toast.textContent).toContain('18002');
  });

  it('校验红字就地展示（role="alert"），不发请求', async () => {
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'abc123def456', container_port: 8080, local_port: 8080, state: 'listening' },
    ]);

    renderPanel({ desktop: true, forwards: [makeForward()] });

    await screen.findByTestId('page-forward-table');
    fireEvent.click(screen.getByTestId('page-forward-row-edit-button'));
    const input = await screen.findByTestId('page-forward-row-edit-input');
    fireEvent.change(input, { target: { value: '70000' } });
    fireEvent.click(screen.getByTestId('page-forward-row-edit-confirm-button'));

    const error = await screen.findByTestId('page-forward-row-edit-error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toContain('本机端口必须在 1~65535 之间');
    expect(mocks.stopForwardListener).not.toHaveBeenCalled();
    expect(mocks.startForwardListener).not.toHaveBeenCalled();
  });

  it('取消编辑：退出编辑态，不发请求', async () => {
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'abc123def456', container_port: 8080, local_port: 8080, state: 'listening' },
    ]);

    renderPanel({ desktop: true, forwards: [makeForward()] });

    await screen.findByTestId('page-forward-table');
    fireEvent.click(screen.getByTestId('page-forward-row-edit-button'));
    await screen.findByTestId('page-forward-row-edit-input');
    fireEvent.click(screen.getByTestId('page-forward-row-edit-cancel-button'));

    await waitFor(() => expect(screen.queryByTestId('page-forward-row-edit-input')).toBeNull());
    expect(mocks.stopForwardListener).not.toHaveBeenCalled();
    expect(mocks.startForwardListener).not.toHaveBeenCalled();
  });

  it('编辑态按 Esc：退出编辑态，且 Esc 不冒泡出去（抽屉不跟着关）', async () => {
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'abc123def456', container_port: 8080, local_port: 8080, state: 'listening' },
    ]);
    // 外层容器扮演「抽屉」：冒泡上来的 Esc 在这里会把抽屉关掉。
    const onKeyDown = vi.fn();

    render(
      <ToastProvider>
        <div onKeyDown={onKeyDown}>
          <PortForwardPanel
            sandbox="demo-01"
            desktop
            connection={connection}
            forwards={[makeForward()]}
            onForwardsChanged={() => {}}
          />
        </div>
      </ToastProvider>,
    );

    await screen.findByTestId('page-forward-table');
    fireEvent.click(screen.getByTestId('page-forward-row-edit-button'));
    const input = await screen.findByTestId('page-forward-row-edit-input');

    // Esc：退出编辑态；事件不冒泡（preventDefault 也调过了）。
    const notPrevented = fireEvent.keyDown(input, { key: 'Escape' });
    expect(notPrevented).toBe(false);
    expect(onKeyDown).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('page-forward-row-edit-input')).toBeNull());
  });

  it('回车提交防重入：这一行忙着时再按回车，不再发第二次请求', async () => {
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'abc123def456', container_port: 8080, local_port: 8080, state: 'listening' },
    ]);
    // 停旧监听悬着：这一行一直处于 busy。
    mocks.stopForwardListener.mockImplementation(() => new Promise(() => {}));

    renderPanel({ desktop: true, forwards: [makeForward()] });

    await screen.findByTestId('page-forward-table');
    fireEvent.click(screen.getByTestId('page-forward-row-edit-button'));
    const input = await screen.findByTestId('page-forward-row-edit-input');

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocks.stopForwardListener).toHaveBeenCalledTimes(1));

    // busy 中再按回车：直接返回，不重复发停 / 启请求。
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mocks.stopForwardListener).toHaveBeenCalledTimes(1);
    expect(mocks.startForwardListener).not.toHaveBeenCalled();
  });
});

describe('桌面形态：本机监听的生命周期完全手动', () => {
  it('转发记录刷新（轮询刷回来的新数据）不触发任何开 / 关监听', async () => {
    mocks.listForwardListeners.mockResolvedValue([
      { forward_id: 'abc123def456', container_port: 8080, local_port: 8080, state: 'listening' },
    ]);

    const { rerender } = render(
      <ToastProvider>
        <PortForwardPanel
          sandbox="demo-01"
          desktop
          connection={connection}
          forwards={[makeForward()]}
          onForwardsChanged={() => {}}
        />
      </ToastProvider>,
    );

    await screen.findByTestId('page-forward-table');
    expect(mocks.startForwardListener).not.toHaveBeenCalled();
    expect(mocks.stopForwardListener).not.toHaveBeenCalled();

    // 数据变了（后端把记录停了）：只改呈现，不碰监听。
    rerender(
      <ToastProvider>
        <PortForwardPanel
          sandbox="demo-01"
          desktop
          connection={connection}
          forwards={[makeForward({ state: 'stopped' })]}
          onForwardsChanged={() => {}}
        />
      </ToastProvider>,
    );

    await waitFor(() =>
      expect(
        cellOf('abc123def456', 'page-forward-row-container-state').getAttribute('data-state'),
      ).toBe('stopped'),
    );
    expect(mocks.startForwardListener).not.toHaveBeenCalled();
    expect(mocks.stopForwardListener).not.toHaveBeenCalled();
  });
});
