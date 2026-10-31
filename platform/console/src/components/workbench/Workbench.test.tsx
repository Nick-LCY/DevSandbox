// @vitest-environment jsdom
/**
 * 工作台：沙箱列表的读取失败与轮询失败反馈、停止沙箱的确认环节。
 *
 * 覆盖四件事：
 * - 首次加载失败：立刻弹失败 toast；
 * - 后台轮询失败：逐次不弹，连续 3 次才弹一条（端点级失败侧栏健康自检兜不住）；
 * - 轮询成功一次：连续计数清零；
 * - 点「停止」先弹确认框：未确认前不发停止请求。
 *
 * 反馈一律走右上角的 toast（挂全局 Provider），断言看 toast 条目与
 * `data-toast-kind` / `data-toast-source`。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../Toast';
import { Workbench } from './Workbench';

const mocks = vi.hoisted(() => ({
  listSandboxes: vi.fn(),
  health: vi.fn(),
  getSandbox: vi.fn(),
  stopSandbox: vi.fn(),
}));

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listSandboxes: mocks.listSandboxes,
      health: mocks.health,
      getSandbox: mocks.getSandbox,
      stopSandbox: mocks.stopSandbox,
    },
  };
});

// 终端视图要真 xterm（jsdom 里没有 canvas）：这里只关心列表轮询，直接替掉。
vi.mock('../TerminalView', () => ({
  TerminalView: () => null,
}));

/** 列表轮询间隔（毫秒）：与 `Workbench.tsx` 里的常量一致。 */
const POLL_INTERVAL = 5000;

/** 当前屏幕上的 toast（按类型筛）。 */
function toastsOf(kind: 'success' | 'error' | 'info'): HTMLElement[] {
  return screen
    .queryAllByTestId('page-toast-item')
    .filter((node) => node.getAttribute('data-toast-kind') === kind);
}

/** 渲染带 Provider 的工作台。 */
function renderWorkbench(): void {
  render(
    <ToastProvider>
      <Workbench />
    </ToastProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  mocks.listSandboxes.mockReset();
  mocks.health.mockReset();
  mocks.getSandbox.mockReset();
  mocks.stopSandbox.mockReset();
  window.location.hash = '';
});

describe('沙箱列表读取失败', () => {
  it('首次加载失败：立刻弹失败 toast', async () => {
    mocks.health.mockResolvedValue({ version: '0.2.0', console_mounted: true });
    mocks.listSandboxes.mockRejectedValue(new Error('读取沙箱列表失败'));

    renderWorkbench();

    await vi.waitFor(() => expect(toastsOf('error')).toHaveLength(1));
    const toast = toastsOf('error')[0];
    expect(toast.textContent).toContain('读取沙箱列表失败');
    expect(toast.getAttribute('data-toast-source')).toBe('sandbox-list');
  });

  it('轮询连续 3 次失败：弹一条失败 toast', async () => {
    vi.useFakeTimers();
    mocks.health.mockResolvedValue({ version: '0.2.0', console_mounted: true });
    // 首次加载成功，之后每轮都失败。
    mocks.listSandboxes.mockResolvedValueOnce([]);
    mocks.listSandboxes.mockRejectedValue(new Error('读取沙箱列表失败'));

    renderWorkbench();

    await vi.waitFor(() => expect(mocks.listSandboxes).toHaveBeenCalledTimes(1));
    // 前两轮失败：不弹。
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL);
    expect(toastsOf('error')).toHaveLength(0);
    // 第三轮失败：弹一条。
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL);
    const toast = toastsOf('error')[0];
    expect(toast.textContent).toContain('连续 3 次轮询');
    expect(toast.getAttribute('data-toast-source')).toBe('sandbox-list');
  });

  it('中间成功一次：连续计数清零，不弹 toast', async () => {
    vi.useFakeTimers();
    mocks.health.mockResolvedValue({ version: '0.2.0', console_mounted: true });
    mocks.listSandboxes.mockResolvedValueOnce([]);
    mocks.listSandboxes.mockRejectedValueOnce(new Error('读取沙箱列表失败'));
    mocks.listSandboxes.mockResolvedValueOnce([]);
    mocks.listSandboxes.mockRejectedValue(new Error('读取沙箱列表失败'));

    renderWorkbench();

    await vi.waitFor(() => expect(mocks.listSandboxes).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL); // 失败 1
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL); // 成功：计数清零
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL); // 失败 1
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL); // 失败 2
    expect(toastsOf('error')).toHaveLength(0);
  });
});

describe('停止沙箱的确认环节', () => {
  /** 一个够用的沙箱详情。 */
  const makeDetail = () => ({
    name: 'acc-demo',
    state: 'running',
    state_label: '运行中',
    image: 'sandbox-platform/base:0.2.0',
    image_source: 'host',
    created_at: '2026-10-30T01:00:00+00:00',
    updated_at: '2026-10-30T01:00:00+00:00',
    system_user: 'acc-demo',
    uid: 1000,
    gid: 1000,
    home: '/home/acc-demo',
    subid_start: 100000,
    subid_length: 65536,
    socket_path: '/run/acc-demo.sock',
    socket_mount_path: '/run/sandbox/acc-demo.sock',
    container_name: 'sandbox-acc-demo',
    container_id: 'abc',
    network_name: 'acc-demo-net',
    network_owned: true,
    unit_path: '/etc/systemd/user/acc-demo.service',
    mounts: [],
    dependency_containers: [],
    command: [],
    env: {},
    workdir: '',
  });

  it('点停止先弹确认框，未确认前不发停止请求', async () => {
    mocks.health.mockResolvedValue({ version: '0.2.0', console_mounted: true });
    mocks.listSandboxes.mockResolvedValue([
      {
        name: 'acc-demo',
        state: 'running',
        state_label: '运行中',
        image: 'sandbox-platform/base:0.2.0',
        created_at: '2026-10-30T01:00:00+00:00',
      },
    ]);
    mocks.getSandbox.mockResolvedValue(makeDetail());
    mocks.stopSandbox.mockResolvedValue(makeDetail());

    // 选中一个沙箱：工作区头部才有停止按钮。
    window.location.hash = '#/sandboxes/acc-demo';
    renderWorkbench();

    const stopButton = await screen.findByTestId('page-sandbox-detail-stop-button');
    await waitFor(() => expect((stopButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(stopButton);

    // 先弹确认框：还没发停止请求。
    const dialog = await screen.findByTestId('page-sandbox-detail-stop-dialog');
    expect(dialog.textContent).toContain('停止沙箱 acc-demo');
    expect(mocks.stopSandbox).not.toHaveBeenCalled();

    // 确认后才真的停。
    fireEvent.click(screen.getByTestId('page-sandbox-detail-stop-confirm-button'));
    await waitFor(() => expect(mocks.stopSandbox).toHaveBeenCalledTimes(1));
    expect(mocks.stopSandbox).toHaveBeenCalledWith('acc-demo', true);
  });
});
