// @vitest-environment jsdom
/**
 * 工作台：沙箱列表的读取失败与轮询失败反馈、停止沙箱的确认环节。
 *
 * 覆盖七件事：
 * - 首次加载失败：立刻弹失败 toast；
 * - 后台轮询失败：逐次不弹，连续 3 次才弹一条（端点级失败侧栏健康自检兜不住）；
 * - 轮询成功一次：连续计数清零；
 * - 点「停止」先弹确认框：未确认前不发停止请求；
 * - 每次打开停止弹窗，「同时停止依赖容器」都回到默认勾选；
 * - 停止失败：弹窗不关（留在原地重试）；
 * - 点「删除」不预取回收清单。
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
  reclaimSandbox: vi.fn(),
  deleteSandbox: vi.fn(),
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
      reclaimSandbox: mocks.reclaimSandbox,
      deleteSandbox: mocks.deleteSandbox,
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
  mocks.reclaimSandbox.mockReset();
  mocks.deleteSandbox.mockReset();
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

/** 把工作台架到一个运行中的沙箱上（选中 acc-demo）。 */
function mockRunningSandbox(): void {
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
  window.location.hash = '#/sandboxes/acc-demo';
}

describe('停止沙箱的确认环节', () => {
  it('点停止先弹确认框，未确认前不发停止请求', async () => {
    mockRunningSandbox();
    mocks.stopSandbox.mockResolvedValue(makeDetail());

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

  it('每次打开停止弹窗：「同时停止依赖容器」都回到默认勾选', async () => {
    mockRunningSandbox();
    mocks.stopSandbox.mockResolvedValue(makeDetail());

    renderWorkbench();

    const stopButton = await screen.findByTestId('page-sandbox-detail-stop-button');
    await waitFor(() => expect((stopButton as HTMLButtonElement).disabled).toBe(false));

    // 第一次打开：默认勾选 → 取消勾选 → 取消弹窗。
    fireEvent.click(stopButton);
    const checkbox = (await screen.findByTestId(
      'page-sandbox-detail-stop-dependencies-checkbox',
    )) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);

    fireEvent.click(screen.getByTestId('page-sandbox-detail-stop-cancel-button'));
    await waitFor(() =>
      expect(screen.queryByTestId('page-sandbox-detail-stop-dialog')).toBeNull(),
    );

    // 再打开：回到默认勾选（上一次取消时的选择不粘到下一次）。
    fireEvent.click(stopButton);
    const reopened = (await screen.findByTestId(
      'page-sandbox-detail-stop-dependencies-checkbox',
    )) as HTMLInputElement;
    expect(reopened.checked).toBe(true);
  });

  it('停止失败：弹窗不关，留在原地可以重试', async () => {
    mockRunningSandbox();
    mocks.stopSandbox.mockRejectedValue(new Error('停止沙箱失败'));

    renderWorkbench();

    const stopButton = await screen.findByTestId('page-sandbox-detail-stop-button');
    await waitFor(() => expect((stopButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(stopButton);
    await screen.findByTestId('page-sandbox-detail-stop-dialog');

    fireEvent.click(screen.getByTestId('page-sandbox-detail-stop-confirm-button'));
    await waitFor(() => expect(mocks.stopSandbox).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastsOf('error')).toHaveLength(1));
    expect(toastsOf('error')[0].textContent).toContain('停止沙箱失败');

    // 失败不关弹窗：确认键重新可用，可以直接重试。
    expect(screen.getByTestId('page-sandbox-detail-stop-dialog')).not.toBeNull();
    const confirm = screen.getByTestId(
      'page-sandbox-detail-stop-confirm-button',
    ) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
  });
});

describe('删除沙箱', () => {
  it('点「删除」不预取回收清单', async () => {
    mockRunningSandbox();

    renderWorkbench();

    const deleteButton = await screen.findByTestId('page-sandbox-detail-delete-button');
    fireEvent.click(deleteButton);
    await screen.findByTestId('page-sandbox-detail-delete-dialog');

    // 删除前不再拉回收清单：清单一律用接口直取核对。
    expect(mocks.reclaimSandbox).not.toHaveBeenCalled();
  });
});
