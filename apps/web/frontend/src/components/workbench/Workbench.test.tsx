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
 *
 * 另外覆盖「沙箱详情 + 转发记录的合并轮询」：
 * - **web 形态只刷详情**（转发记录连读都不读）、桌面形态一拍刷两份；
 * - 页面不可见整拍跳过、连续 3 次失败弹一条（来源 `sandbox-detail`）；
 * - **轮询失败不清空已有详情**；
 * - **写操作完成后工作台立即重拉转发记录**；
 * - **打开抽屉那一拍失败立即弹 toast，且不消耗连续失败计数**。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, ConnectionNotConfiguredError } from '../../api/client';
import {
  CONNECTION_STORAGE_KEY,
  DEFAULT_BACKEND_BASE_URL,
  resetDesktopSyncState,
} from '../../lib/connection';
import { ToastProvider } from '../Toast';
import { Workbench } from './Workbench';

const mocks = vi.hoisted(() => ({
  listSandboxes: vi.fn(),
  health: vi.fn(),
  getSandbox: vi.fn(),
  listForwards: vi.fn(),
  createForward: vi.fn(),
  listFiles: vi.fn(),
  listTerminalSessions: vi.fn(),
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
      listForwards: mocks.listForwards,
      createForward: mocks.createForward,
      listFiles: mocks.listFiles,
      listTerminalSessions: mocks.listTerminalSessions,
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

/** 详情 + 转发记录的合并轮询间隔（毫秒）：与 `Workbench.tsx` 里的常量一致。 */
const DETAIL_POLL_INTERVAL = 10000;

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
  mocks.listForwards.mockReset();
  mocks.createForward.mockReset();
  mocks.listFiles.mockReset();
  mocks.listTerminalSessions.mockReset();
  mocks.stopSandbox.mockReset();
  mocks.reclaimSandbox.mockReset();
  mocks.deleteSandbox.mockReset();
  window.location.hash = '';
  window.localStorage.clear();
  // 桌面同步的去重缓存是模块级的：每个用例之间清掉。
  resetDesktopSyncState();
  // 形态探测看的是 `window.__TAURI_INTERNALS__`：用例之间复位成 web 形态。
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

/**
 * 把运行形态切成**桌面壳**。
 *
 * 转发记录的读取在工作台层且**仅桌面形态执行**（web 形态连记录都不读），
 * 所以「转发记录也刷」那几条用例得先切形态。
 */
function mockDesktopShell(): void {
  const invoke = vi.fn(async (cmd: string) => {
    switch (cmd) {
      case 'csp_needs_reload':
        return false;
      case 'forward_listeners':
        return [];
      case 'start_forward':
        return 8080;
      default:
        return undefined;
    }
  });
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: { invoke },
    configurable: true,
    writable: true,
  });
}

/**
 * 默认给一份**已配置**的连接配置。
 *
 * 未配置（没令牌）时工作台根本不挂载，改渲染引导面板——测工作台得先配置好。
 */
beforeEach(() => {
  window.localStorage.setItem(
    CONNECTION_STORAGE_KEY,
    JSON.stringify({ backendBaseUrl: DEFAULT_BACKEND_BASE_URL, token: 'sbx_test' }),
  );
  mocks.listForwards.mockResolvedValue([]);
  mocks.listFiles.mockResolvedValue([]);
  mocks.createForward.mockResolvedValue({
    id: 'abc123def456',
    sandbox: 'acc-demo',
    container_port: 8080,
    state: 'running',
    created_at: '2026-11-03T00:00:00Z',
    updated_at: '2026-11-03T00:00:00Z',
  });
  // 终端会话表：本组用例不关心终端，让它安静下来（它的失败提示会顶掉别的提示）。
  mocks.listTerminalSessions.mockResolvedValue([]);
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

describe('沙箱详情与转发记录的合并轮询', () => {
  it('web 形态：只刷详情，转发记录连读都不读', async () => {
    mockRunningSandbox();

    renderWorkbench();

    await waitFor(() => expect(mocks.getSandbox).toHaveBeenCalledWith('acc-demo'));
    // web 形态的端口转发区不渲染表格：转发记录一个都不读。
    expect(mocks.listForwards).not.toHaveBeenCalled();
  });

  it('桌面形态：选中沙箱一拍刷两份（详情 + 转发记录）', async () => {
    mockDesktopShell();
    mockRunningSandbox();

    renderWorkbench();

    await waitFor(() => expect(mocks.getSandbox).toHaveBeenCalledWith('acc-demo'));
    await waitFor(() => expect(mocks.listForwards).toHaveBeenCalledWith('acc-demo'));
  });

  it('每 10 秒一拍：详情与转发记录各刷一次', async () => {
    vi.useFakeTimers();
    mockDesktopShell();
    mockRunningSandbox();

    renderWorkbench();

    await vi.waitFor(() => expect(mocks.getSandbox).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mocks.listForwards).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(DETAIL_POLL_INTERVAL);
    expect(mocks.getSandbox).toHaveBeenCalledTimes(2);
    expect(mocks.listForwards).toHaveBeenCalledTimes(2);
  });

  it('页面不可见时：整拍跳过（不发请求）', async () => {
    vi.useFakeTimers();
    mockDesktopShell();
    mockRunningSandbox();
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden' as DocumentVisibilityState);

    try {
      renderWorkbench();

      await vi.waitFor(() => expect(mocks.getSandbox).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(DETAIL_POLL_INTERVAL);
      expect(mocks.getSandbox).toHaveBeenCalledTimes(1);
      expect(mocks.listForwards).toHaveBeenCalledTimes(1);
    } finally {
      visibility.mockRestore();
    }
  });

  it('轮询连续 3 次失败：弹一条失败 toast（来源 sandbox-detail）', async () => {
    vi.useFakeTimers();
    mockRunningSandbox();
    // 首次加载成功，之后每轮都失败。
    mocks.getSandbox.mockResolvedValueOnce(makeDetail());
    mocks.getSandbox.mockRejectedValue(new Error('读取沙箱详情失败'));

    renderWorkbench();

    await vi.waitFor(() => expect(mocks.getSandbox).toHaveBeenCalledTimes(1));
    // 前两轮失败：不弹。
    await vi.advanceTimersByTimeAsync(DETAIL_POLL_INTERVAL);
    await vi.advanceTimersByTimeAsync(DETAIL_POLL_INTERVAL);
    expect(toastsOf('error')).toHaveLength(0);
    // 第三轮失败：弹一条。
    await vi.advanceTimersByTimeAsync(DETAIL_POLL_INTERVAL);
    const toast = toastsOf('error')[0];
    expect(toast.textContent).toContain('连续 3 次轮询');
    expect(toast.getAttribute('data-toast-source')).toBe('sandbox-detail');
  });

  it('轮询失败不清空已有详情（头部仍显示上一次读到的沙箱）', async () => {
    vi.useFakeTimers();
    mockRunningSandbox();
    mocks.getSandbox.mockResolvedValue(makeDetail());

    renderWorkbench();

    await vi.waitFor(() => expect(mocks.getSandbox).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(screen.getByTestId('page-sandbox-detail-title').textContent).toBe('acc-demo'),
    );

    // 之后都失败：轮询那一拍是 silent 的，**不清空已有详情**。
    mocks.getSandbox.mockRejectedValue(new Error('读取沙箱详情失败'));
    await vi.advanceTimersByTimeAsync(DETAIL_POLL_INTERVAL);

    expect(screen.getByTestId('page-sandbox-detail-title').textContent).toBe('acc-demo');
  });

  it('写操作完成后：工作台立即重拉转发记录（不等下一拍）', async () => {
    mockDesktopShell();
    mockRunningSandbox();

    renderWorkbench();

    await waitFor(() => expect(mocks.listForwards).toHaveBeenCalledTimes(1));

    // 打开详情抽屉（端口转发区在抽屉底部）。
    fireEvent.click(await screen.findByTestId('page-sandbox-detail-detail-button'));
    const containerInput = await screen.findByTestId('page-forward-create-container-port-input');
    await waitFor(() => expect(mocks.listForwards).toHaveBeenCalledTimes(2));

    // 新建一条转发：写操作完成 → 工作台立即重拉转发记录。
    fireEvent.change(containerInput, { target: { value: '8080' } });
    fireEvent.click(screen.getByTestId('page-forward-create-submit-button'));

    await waitFor(() => expect(mocks.listForwards).toHaveBeenCalledTimes(3));
  });

  it('打开抽屉那一拍：刷新失败立即弹 toast，且不消耗连续失败计数', async () => {
    vi.useFakeTimers();
    mockDesktopShell();
    mockRunningSandbox();
    mocks.getSandbox.mockResolvedValue(makeDetail());

    renderWorkbench();

    await vi.waitFor(() => expect(mocks.getSandbox).toHaveBeenCalledTimes(1));
    // 之后都失败。
    mocks.getSandbox.mockRejectedValue(new Error('读取沙箱详情失败'));

    // 开抽屉是用户主动触发的：那一拍的失败**立即弹**。
    fireEvent.click(screen.getByTestId('page-sandbox-detail-detail-button'));
    await vi.waitFor(() => expect(toastsOf('error')).toHaveLength(1));
    expect(toastsOf('error')[0].getAttribute('data-toast-source')).toBe('sandbox-detail');

    // 这一拍**不计入**合并轮询的连续失败计数：计数从 0 起，
    // 后面两拍轮询失败都不到阈值（不弹）。
    await vi.advanceTimersByTimeAsync(DETAIL_POLL_INTERVAL);
    await vi.advanceTimersByTimeAsync(DETAIL_POLL_INTERVAL);
    expect(toastsOf('error')).toHaveLength(0);

    // 第三拍轮询失败：连续 3 次才弹一条（说明计数确实是从 0 起的）。
    await vi.advanceTimersByTimeAsync(DETAIL_POLL_INTERVAL);
    expect(toastsOf('error')).toHaveLength(1);
    expect(toastsOf('error')[0].textContent).toContain('连续 3 次轮询');
  });
});

describe('运行期文件入口', () => {
  it('沙箱操作区「文件」按钮打开独立抽屉，并只从容器内 workdir 起读目录', async () => {
    mockRunningSandbox();

    renderWorkbench();

    const filesButton = await screen.findByTestId('page-sandbox-detail-files-button');
    expect(filesButton.textContent).toContain('文件');
    fireEvent.click(filesButton);

    expect(await screen.findByTestId('page-file-browser-dialog')).toBeTruthy();
    // makeDetail 的 workdir 为空：home 是**宿主侧**路径（容器里不存在），
    // 不能拿来做起始目录；兜底用任何镜像都有的根目录 `/`。
    await waitFor(() => expect(mocks.listFiles).toHaveBeenCalledWith('acc-demo', '/'));
  });
});

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

describe('未配置态', () => {
  it('没有令牌：渲染引导面板，一个请求都不发', async () => {
    window.localStorage.clear();

    renderWorkbench();

    await screen.findByTestId('page-connection-setup');
    expect(mocks.listSandboxes).not.toHaveBeenCalled();
    expect(mocks.health).not.toHaveBeenCalled();
    // 引导态不是路由：地址栏仍然是工作台。
    expect(window.location.hash === '' || window.location.hash === '#/').toBe(true);
  });

  it('填了令牌保存后：工作台挂载，轮询立即启动', async () => {
    window.localStorage.clear();
    mocks.health.mockResolvedValue({ version: '0.2.0', console_mounted: true });
    mocks.listSandboxes.mockResolvedValue([]);

    renderWorkbench();

    const token = await screen.findByTestId('page-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_test' } });
    fireEvent.click(screen.getByTestId('page-connection-submit-button'));

    // 保存后工作台立即挂载：沙箱列表与健康自检都立刻发一次。
    await waitFor(() => expect(mocks.listSandboxes).toHaveBeenCalled());
    await waitFor(() => expect(mocks.health).toHaveBeenCalled());
    expect(screen.queryByTestId('page-connection-setup')).toBeNull();
  });

  it('桌面形态：存量配置里基址为空 → 归一为默认地址，有令牌即已配置，工作台直接挂载', async () => {
    // 鉴别力在这里：**旧口径**（基址为空 = 未配置）会渲染引导面板；
    // **新口径**（基址恒非空、空值归一为默认地址 + 未配置只看令牌）直接挂载工作台。
    // （网页形态的同款场景两套口径都判「已配置」，不具鉴别力，故取桌面形态。）
    const invoke = vi.fn();
    invoke.mockResolvedValue(undefined);
    invoke.mockResolvedValueOnce(undefined); // set_backend_base_url
    invoke.mockResolvedValue(false); // csp_needs_reload → 不用重载
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: { invoke },
      configurable: true,
      writable: true,
    });
    try {
      window.localStorage.setItem(
        CONNECTION_STORAGE_KEY,
        JSON.stringify({ backendBaseUrl: '', token: 'sbx_test' }),
      );
      mocks.health.mockResolvedValue({ version: '0.2.0', console_mounted: true });
      mocks.listSandboxes.mockResolvedValue([]);

      renderWorkbench();

      await waitFor(() => expect(mocks.listSandboxes).toHaveBeenCalled());
      expect(screen.queryByTestId('page-connection-setup')).toBeNull();
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  it('网页形态：后端地址可填，填了就按它体检（基址恒非空，但可改）', async () => {
    window.localStorage.clear();
    mocks.health.mockResolvedValue({ version: '0.2.0', console_mounted: true });
    mocks.listSandboxes.mockResolvedValue([]);

    renderWorkbench();

    const base = await screen.findByTestId('page-connection-base-url-input');
    // 网页形态下地址框也可编辑（不再是只读）。
    expect((base as HTMLInputElement).readOnly).toBe(false);
    fireEvent.change(base, { target: { value: 'http://10.0.0.5:8000' } });
    const token = screen.getByTestId('page-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_test' } });
    fireEvent.click(screen.getByTestId('page-connection-submit-button'));

    await waitFor(() => expect(mocks.health).toHaveBeenCalled());
    // 体检用的是填的那台后端。
    expect(mocks.health.mock.calls[0][0]).toEqual({
      backendBaseUrl: 'http://10.0.0.5:8000',
      token: 'sbx_test',
    });
    // 落盘的配置保留基址：不被形态收敛成空串。
    expect(JSON.parse(window.localStorage.getItem(CONNECTION_STORAGE_KEY) ?? '{}')).toEqual({
      backendBaseUrl: 'http://10.0.0.5:8000',
      token: 'sbx_test',
    });
  });

  it('引导态下令牌为空：就地红字，不发请求', async () => {
    window.localStorage.clear();

    renderWorkbench();

    await screen.findByTestId('page-connection-setup');
    fireEvent.click(screen.getByTestId('page-connection-submit-button'));

    const error = await screen.findByTestId('page-connection-error');
    expect(error.textContent).toContain('请填写访问令牌');
    expect(mocks.health).not.toHaveBeenCalled();
  });

  it('引导态的校验红字带 role="alert"（读屏能播报）', async () => {
    window.localStorage.clear();

    renderWorkbench();

    await screen.findByTestId('page-connection-setup');
    fireEvent.click(screen.getByTestId('page-connection-submit-button'));

    const error = await screen.findByTestId('page-connection-error');
    expect(error.getAttribute('role')).toBe('alert');
  });

  it('引导态下健康检查 401：不保存、不挂载工作台，就地红字说「令牌无效」', async () => {
    window.localStorage.clear();
    mocks.health.mockRejectedValue(new ApiError('访问令牌无效或缺失', 401));

    renderWorkbench();

    const token = await screen.findByTestId('page-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_bad' } });
    fireEvent.click(screen.getByTestId('page-connection-submit-button'));

    const error = await screen.findByTestId('page-connection-error');
    expect(error.textContent).toContain('令牌无效');
    expect(error.textContent).toContain('访问令牌无效或缺失');
    // 没保存：不进工作台（工作台还在引导面板后面）。
    expect(screen.queryByTestId('page-connection-setup')).not.toBeNull();
    expect(mocks.listSandboxes).not.toHaveBeenCalled();
    // 配置没落盘。
    expect(window.localStorage.getItem(CONNECTION_STORAGE_KEY)).toBeNull();
  });

  it('引导态下健康检查不通：就地红字说「后端不可达」（与「令牌无效」不混）', async () => {
    window.localStorage.clear();
    mocks.health.mockRejectedValue(new ApiError('无法连接后端服务，请确认控制台服务已启动', 0));

    renderWorkbench();

    const token = await screen.findByTestId('page-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_test' } });
    fireEvent.click(screen.getByTestId('page-connection-submit-button'));

    const error = await screen.findByTestId('page-connection-error');
    expect(error.textContent).toContain('后端不可达');
    expect(error.textContent).not.toContain('令牌无效');
    expect(mocks.listSandboxes).not.toHaveBeenCalled();
  });
});

describe('运行期配置失效', () => {
  it('轮询报「未配置」：回到引导面板，不弹普通错误 toast', async () => {
    mocks.health.mockResolvedValue({ version: '0.2.0', console_mounted: true });
    mocks.listSandboxes.mockRejectedValue(
      new ConnectionNotConfiguredError('尚未配置后端连接：请先填写访问令牌'),
    );

    renderWorkbench();

    // 回到引导面板。
    await screen.findByTestId('page-connection-setup');
    // 不弹「读取沙箱列表失败」那种普通错误 toast。
    expect(toastsOf('error')).toHaveLength(0);
  });

  it('健康检查 401：侧栏健康文案带「令牌无效：」前缀', async () => {
    mocks.health.mockRejectedValue(new ApiError('访问令牌无效或缺失', 401));
    mocks.listSandboxes.mockResolvedValue([]);

    renderWorkbench();

    const health = await screen.findByTestId('page-layout-health');
    await waitFor(() =>
      expect(health.getAttribute('aria-label')).toContain('令牌无效：访问令牌无效或缺失'),
    );
  });
});

describe('桌面形态的动态 CSP 同步', () => {
  /** 桌面壳的 IPC 替身。 */
  const invoke = vi.fn();

  beforeEach(() => {
    invoke.mockReset();
    // set_backend_base_url → 无返回值；csp_needs_reload → 不用重载。
    invoke.mockResolvedValue(undefined);
    invoke.mockResolvedValueOnce(undefined);
    invoke.mockResolvedValue(false);
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: { invoke },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('启动时先同步 CSP，再挂载界面', async () => {
    window.localStorage.clear();

    renderWorkbench();

    await screen.findByTestId('page-connection-setup');
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      'set_backend_base_url',
      'csp_needs_reload',
    ]);
  });

  it('「保存并连接」：先同步 CSP，再体检，体检通过了才落盘并挂载工作台', async () => {
    window.localStorage.clear();
    mocks.health.mockResolvedValue({ version: '0.2.0', console_mounted: true });
    mocks.listSandboxes.mockResolvedValue([]);

    renderWorkbench();

    const base = await screen.findByTestId('page-connection-base-url-input');
    fireEvent.change(base, { target: { value: 'http://10.0.0.5:8000' } });
    const token = screen.getByTestId('page-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_test' } });
    fireEvent.click(screen.getByTestId('page-connection-submit-button'));

    await waitFor(() => expect(mocks.health).toHaveBeenCalled());
    // 同步在体检之前（主文档的 CSP 得先放行这台主机，体检才发得出去）。
    const lastInvokeOrder = invoke.mock.invocationCallOrder.at(-1) ?? 0;
    expect(lastInvokeOrder).toBeLessThan(mocks.health.mock.invocationCallOrder[0]);
    // 体检通过 → 配置落盘 → 工作台挂载。
    await waitFor(() => expect(mocks.listSandboxes).toHaveBeenCalled());
    expect(
      JSON.parse(window.localStorage.getItem(CONNECTION_STORAGE_KEY) ?? '{}'),
    ).toEqual({ backendBaseUrl: 'http://10.0.0.5:8000', token: 'sbx_test' });
  });

  it('体检 401：配置不落盘、不挂载工作台，就地红字', async () => {
    window.localStorage.clear();
    mocks.health.mockRejectedValue(new ApiError('访问令牌无效或缺失', 401));

    renderWorkbench();

    const base = await screen.findByTestId('page-connection-base-url-input');
    fireEvent.change(base, { target: { value: 'http://10.0.0.5:8000' } });
    const token = screen.getByTestId('page-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_bad' } });
    fireEvent.click(screen.getByTestId('page-connection-submit-button'));

    const error = await screen.findByTestId('page-connection-error');
    expect(error.textContent).toContain('令牌无效');
    expect(mocks.listSandboxes).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(CONNECTION_STORAGE_KEY)).toBeNull();
  });
});
