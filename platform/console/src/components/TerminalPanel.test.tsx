// @vitest-environment jsdom
/**
 * 终端面板的会话标签与关闭会话交互。
 *
 * 覆盖三件事：
 * - 后端会话表渲染成标签（一个标签 = 一个会话），点标签回调选中；
 * - 关标签先弹确认：运行中的会话说「关闭并移除」，已退出的说「移除记录」；
 * - 删除成功 / 有副作用（记录已不存在、关闭流程未走完）分别落在正确位置。
 *
 * 操作结果一律走右上角的 toast（挂全局 Provider），断言看 toast 条目与
 * `data-toast-kind`，不再看面板上的内嵌横幅。
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';

import type { TerminalSessionRecord } from '../api/types';
import { TerminalPanel } from './TerminalPanel';
import { ToastProvider } from './Toast';

const mocks = vi.hoisted(() => ({
  listTerminalSessions: vi.fn(),
  createTerminalSession: vi.fn(),
  deleteTerminalSession: vi.fn(),
}));

/** 终端视图上报的状态：默认「连接中」，用来验证「标签状态与后端记录任一 running 即按运行中」。 */
const viewMocks = vi.hoisted(() => ({
  status: 'connecting',
  /** 按会话标识指定状态：验证状态栏只反映当前会话。 */
  bySession: {} as Record<string, string>,
  /** 按会话标识指定完整状态（含退出码 / 退避秒数）：验证终态提示。 */
  states: {} as Record<
    string,
    { status: string; message?: string; exitCode?: number | null; retryDelaySeconds?: number }
  >,
  /**
   * 上报次数：自增后终端视图会**再上报一次**当前状态。
   *
   * 服务端可能反复推同一个状态（同一个 error 帧），面板必须只弹一次提示。
   * 之前这个 mock 只在会话切换时上报一次，去重逻辑坏了也测不出来。
   */
  reportTick: 0,
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listTerminalSessions: mocks.listTerminalSessions,
      createTerminalSession: mocks.createTerminalSession,
      deleteTerminalSession: mocks.deleteTerminalSession,
    },
  };
});

// 终端视图要真 xterm 与真 WebSocket：这里只关心面板的交互，直接替掉。
// 替掉的那份会按 viewMocks.status 上报连接状态；
// viewMocks.reportTick 自增后会再上报一次（模拟服务端反复推同一个状态）。
vi.mock('./TerminalView', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    TerminalView: ({
      sessionId,
      onStateChange,
    }: {
      sessionId: string;
      onStateChange: (state: {
        status: string;
        message: string;
        exitCode?: number | null;
        retryDelaySeconds?: number;
      }) => void;
    }) => {
      const callbackRef = useRef(onStateChange);
      callbackRef.current = onStateChange;
      useEffect(() => {
        const override = viewMocks.states[sessionId];
        if (override) {
          callbackRef.current({
            status: override.status,
            message: override.message ?? '模拟状态',
            exitCode: override.exitCode,
            retryDelaySeconds: override.retryDelaySeconds,
          });
          return;
        }
        const status = viewMocks.bySession[sessionId] ?? viewMocks.status;
        callbackRef.current({ status, message: '模拟状态' });
      }, [sessionId, viewMocks.reportTick]);
      return null;
    },
  };
});

function makeRecord(overrides: Partial<TerminalSessionRecord> = {}): TerminalSessionRecord {
  return {
    session_id: 'sess-1',
    sandbox_name: 'demo',
    container_name: 'sandbox-demo',
    system_user: 'sandbox-demo',
    created_at: '2026-10-30T01:00:00+00:00',
    last_attached_at: '2026-10-30T01:00:00+00:00',
    state: 'running',
    exit_code: null,
    pid: 4242,
    cols: 80,
    rows: 24,
    attached_count: 0,
    host_pid: 0,
    ...overrides,
  };
}

/** 每个测试用独立的沙箱名：标签序号按沙箱登记，测试之间互不干扰。 */
let sandboxSeq = 0;

/** 当前屏幕上的 toast（按类型筛）。 */
function toastsOf(kind: 'success' | 'error' | 'info'): HTMLElement[] {
  return screen
    .queryAllByTestId('page-toast-item')
    .filter((node) => node.getAttribute('data-toast-kind') === kind);
}

/** 当前唯一那条 toast（同屏只留最新一条）。 */
function currentToast(): HTMLElement {
  const items = screen.queryAllByTestId('page-toast-item');
  expect(items, '屏上应当有且只有一条 toast').toHaveLength(1);
  return items[0];
}

function renderPanel(
  onActiveSessionChange: (sessionId: string | null) => void = vi.fn(),
  props: Partial<ComponentProps<typeof TerminalPanel>> = {},
): {
  sandboxName: string;
  rerender: (next: Partial<ComponentProps<typeof TerminalPanel>>) => void;
} {
  sandboxSeq += 1;
  const sandboxName = props.sandboxName ?? `demo-${sandboxSeq}`;
  const panel = (extra: Partial<ComponentProps<typeof TerminalPanel>>) => (
    <TerminalPanel
      sandboxName={sandboxName}
      sandboxRunning
      activeSessionId={null}
      onActiveSessionChange={onActiveSessionChange}
      {...props}
      {...extra}
    />
  );
  // toast 挂全局 Provider：渲染必须带上，否则面板拿不到反馈接口。
  const view = render(<ToastProvider>{panel({})}</ToastProvider>);
  return {
    sandboxName,
    rerender: (next) =>
      view.rerender(<ToastProvider>{panel(next)}</ToastProvider>),
  };
}

/** 首次返回会话列表，之后返回空列表（会话已经被删掉了）。 */
function mockSessions(records: TerminalSessionRecord[]): void {
  mocks.listTerminalSessions.mockResolvedValueOnce(records);
  mocks.listTerminalSessions.mockResolvedValue([]);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  mocks.listTerminalSessions.mockReset();
  mocks.createTerminalSession.mockReset();
  mocks.deleteTerminalSession.mockReset();
  viewMocks.status = 'connecting';
  viewMocks.bySession = {};
  viewMocks.states = {};
});

describe('终端会话标签', () => {
  it('后端会话表渲染成标签：一个标签一个会话', async () => {
    mockSessions([
      makeRecord({ session_id: 'sess-a', state: 'running' }),
      makeRecord({ session_id: 'sess-b', state: 'exited', exit_code: 0 }),
    ]);

    renderPanel();

    const tabs = await screen.findAllByTestId('page-sandbox-detail-terminal-tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0].getAttribute('data-session-id')).toBe('sess-a');
    expect(tabs[1].getAttribute('data-session-id')).toBe('sess-b');
    expect(
      within(tabs[0]).getByTestId('page-sandbox-detail-terminal-tab-select').textContent,
    ).toContain('终端 1');
    expect(
      within(tabs[1]).getByTestId('page-sandbox-detail-terminal-tab-select').textContent,
    ).toContain('终端 2');
  });

  it('点标签：回调选中的会话标识', async () => {
    mockSessions([
      makeRecord({ session_id: 'sess-a', state: 'running' }),
      makeRecord({ session_id: 'sess-b', state: 'running' }),
    ]);
    const onActiveSessionChange = vi.fn();

    renderPanel(onActiveSessionChange);

    const tabs = await screen.findAllByTestId('page-sandbox-detail-terminal-tab');
    fireEvent.click(
      within(tabs[1]).getByTestId('page-sandbox-detail-terminal-tab-select'),
    );
    expect(onActiveSessionChange).toHaveBeenCalledWith('sess-b');
  });

  it('新建终端：建出会话后刷新列表并选中新会话', async () => {
    mocks.listTerminalSessions.mockResolvedValue([]);
    mocks.createTerminalSession.mockResolvedValue({
      session_id: 'sess-new',
      sandbox: 'demo',
      container_name: 'sandbox-demo',
      cols: 80,
      rows: 24,
      state: 'running',
      created_at: '2026-10-30T01:00:00+00:00',
    });
    const onActiveSessionChange = vi.fn();

    const { sandboxName } = renderPanel(onActiveSessionChange);

    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-new-button'));
    await waitFor(() => expect(mocks.createTerminalSession).toHaveBeenCalledWith(sandboxName, 80, 24));
    await waitFor(() => expect(onActiveSessionChange).toHaveBeenCalledWith('sess-new'));
  });
});

describe('关闭终端会话', () => {
  it('运行中的会话：弹确认，按钮是「关闭并移除」', async () => {
    mockSessions([makeRecord({ session_id: 'sess-running', state: 'running' })]);

    renderPanel();

    const tab = await screen.findByTestId('page-sandbox-detail-terminal-tab');
    fireEvent.click(within(tab).getByTestId('page-sandbox-detail-terminal-tab-close'));

    const dialog = screen.getByTestId('page-sandbox-detail-terminal-remove-confirm');
    expect(dialog.textContent).toContain('关闭终端会话');
    expect(dialog.textContent).toContain('关闭会终止容器内该会话的进程树，终端现场不保留');
    expect(
      within(dialog).getByTestId('page-sandbox-detail-terminal-remove-confirm-button').textContent,
    ).toBe('关闭并移除');
    // 确认之前不发删除请求
    expect(mocks.deleteTerminalSession).not.toHaveBeenCalled();
  });

  it('已退出的会话：弹确认，按钮是「移除记录」', async () => {
    mockSessions([makeRecord({ session_id: 'sess-exited', state: 'exited', exit_code: 0 })]);
    // 标签状态：会话已退出（连接侧也确认结束了）
    viewMocks.status = 'closed';

    renderPanel();

    const tab = await screen.findByTestId('page-sandbox-detail-terminal-tab');
    fireEvent.click(within(tab).getByTestId('page-sandbox-detail-terminal-tab-close'));

    const dialog = screen.getByTestId('page-sandbox-detail-terminal-remove-confirm');
    expect(dialog.textContent).toContain('移除终端会话记录');
    expect(dialog.textContent).toContain('会话已退出，只移除记录，容器内无残留进程');
    expect(
      within(dialog).getByTestId('page-sandbox-detail-terminal-remove-confirm-button').textContent,
    ).toBe('移除记录');
  });

  it('确认后删会话：标签消失', async () => {
    mockSessions([makeRecord({ session_id: 'sess-running', state: 'running' })]);
    mocks.deleteTerminalSession.mockResolvedValue({
      session_id: 'sess-running',
      state: 'running',
      closed: true,
      removed: true,
    });

    renderPanel();

    const tab = await screen.findByTestId('page-sandbox-detail-terminal-tab');
    fireEvent.click(within(tab).getByTestId('page-sandbox-detail-terminal-tab-close'));
    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-remove-confirm-button'));

    await waitFor(() =>
      expect(mocks.deleteTerminalSession).toHaveBeenCalledWith('sess-running'),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('page-sandbox-detail-terminal-tab')).toBeNull(),
    );
  });

  it('取消：确认条关掉，一个删除请求都不发', async () => {
    mockSessions([makeRecord({ session_id: 'sess-running', state: 'running' })]);

    renderPanel();

    const tab = await screen.findByTestId('page-sandbox-detail-terminal-tab');
    fireEvent.click(within(tab).getByTestId('page-sandbox-detail-terminal-tab-close'));
    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-remove-cancel-button'));

    expect(screen.queryByTestId('page-sandbox-detail-terminal-remove-confirm')).toBeNull();
    expect(mocks.deleteTerminalSession).not.toHaveBeenCalled();
  });

  it('删除失败：弹失败 toast，文案用后端的 detail 原文', async () => {
    mockSessions([makeRecord({ session_id: 'sess-gone', state: 'exited', exit_code: 0 })]);
    mocks.deleteTerminalSession.mockRejectedValue(
      new Error('终端会话不存在或已失效：sess-gone'),
    );

    renderPanel();

    const tab = await screen.findByTestId('page-sandbox-detail-terminal-tab');
    fireEvent.click(within(tab).getByTestId('page-sandbox-detail-terminal-tab-close'));
    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-remove-confirm-button'));

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('error');
    expect(toast.textContent).toContain('终端会话不存在或已失效：sess-gone');
    // 失败时标签还在：用户还能重试
    expect(screen.getByTestId('page-sandbox-detail-terminal-tab')).toBeTruthy();
  });

  it('删除响应说记录已不存在：弹 info 提示，不当成失败', async () => {
    mockSessions([makeRecord({ session_id: 'sess-gone', state: 'exited', exit_code: 0 })]);
    mocks.deleteTerminalSession.mockResolvedValue({
      session_id: 'sess-gone',
      state: 'exited',
      closed: false,
      removed: false,
    });

    renderPanel();

    const tab = await screen.findByTestId('page-sandbox-detail-terminal-tab');
    fireEvent.click(within(tab).getByTestId('page-sandbox-detail-terminal-tab-close'));
    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-remove-confirm-button'));

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('info');
    expect(toast.textContent).toContain('记录已不存在（可能已被删除）');
    // 删除本体没失败：不弹失败 toast
    expect(toastsOf('error')).toHaveLength(0);
  });

  it('关闭流程没走完：弹 info 提示残留进程，不当成失败', async () => {
    mockSessions([makeRecord({ session_id: 'sess-half', state: 'running' })]);
    mocks.deleteTerminalSession.mockResolvedValue({
      session_id: 'sess-half',
      state: 'running',
      closed: false,
      removed: true,
    });

    renderPanel();

    const tab = await screen.findByTestId('page-sandbox-detail-terminal-tab');
    fireEvent.click(within(tab).getByTestId('page-sandbox-detail-terminal-tab-close'));
    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-remove-confirm-button'));

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('info');
    expect(toast.textContent).toContain('会话记录已删除，但关闭流程未走完（容器内可能仍有残留进程）');
    expect(toastsOf('error')).toHaveLength(0);
  });

  it('删除成功但列表刷新失败：成功语义不被覆盖', async () => {
    mocks.listTerminalSessions.mockResolvedValueOnce([
      makeRecord({ session_id: 'sess-1', state: 'exited', exit_code: 0 }),
    ]);
    mocks.listTerminalSessions.mockRejectedValueOnce(new Error('读取终端会话列表失败'));
    mocks.listTerminalSessions.mockResolvedValue([]);
    mocks.deleteTerminalSession.mockResolvedValue({
      session_id: 'sess-1',
      state: 'exited',
      closed: true,
      removed: true,
    });

    renderPanel();

    const tab = await screen.findByTestId('page-sandbox-detail-terminal-tab');
    fireEvent.click(within(tab).getByTestId('page-sandbox-detail-terminal-tab-close'));
    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-remove-confirm-button'));

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.textContent).toContain('会话列表刷新失败');
    // 删除已经成功：不把刷新失败说成删除失败
    expect(toastsOf('error')).toHaveLength(0);
  });
});

describe('标签序号与会话身份绑定', () => {
  it('按会话创建时间定序：早建的会话序号在前', async () => {
    mockSessions([
      makeRecord({ session_id: 'sess-c', created_at: '2026-10-30T01:00:10+00:00' }),
      makeRecord({ session_id: 'sess-a', created_at: '2026-10-30T01:00:00+00:00' }),
      makeRecord({ session_id: 'sess-b', created_at: '2026-10-30T01:00:05+00:00' }),
    ]);

    renderPanel();

    const tabs = await screen.findAllByTestId('page-sandbox-detail-terminal-tab');
    expect(tabs.map((tab) => tab.getAttribute('data-session-id'))).toEqual([
      'sess-a',
      'sess-b',
      'sess-c',
    ]);
    expect(
      tabs.map((tab) =>
        within(tab).getByTestId('page-sandbox-detail-terminal-tab-select').textContent,
      ),
    ).toEqual(['终端 1', '终端 2', '终端 3']);
  });

  it('关掉中间标签后，其余标签的序号不动', async () => {
    const sessA = makeRecord({ session_id: 'sess-a', created_at: '2026-10-30T01:00:00+00:00' });
    const sessB = makeRecord({ session_id: 'sess-b', created_at: '2026-10-30T01:00:05+00:00' });
    const sessC = makeRecord({ session_id: 'sess-c', created_at: '2026-10-30T01:00:10+00:00' });
    // 删掉中间那个之后，后端会话表里剩 a 与 c。
    mocks.listTerminalSessions.mockResolvedValueOnce([sessA, sessB, sessC]);
    mocks.listTerminalSessions.mockResolvedValue([sessA, sessC]);
    mocks.deleteTerminalSession.mockResolvedValue({
      session_id: 'sess-b',
      state: 'running',
      closed: true,
      removed: true,
    });

    renderPanel();

    const tabs = await screen.findAllByTestId('page-sandbox-detail-terminal-tab');
    fireEvent.click(
      within(tabs[1]).getByTestId('page-sandbox-detail-terminal-tab-close'),
    );
    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-remove-confirm-button'));

    await waitFor(() => expect(screen.queryAllByTestId('page-sandbox-detail-terminal-tab')).toHaveLength(2));
    const left = screen.getAllByTestId('page-sandbox-detail-terminal-tab');
    expect(left.map((tab) => tab.getAttribute('data-session-id'))).toEqual(['sess-a', 'sess-c']);
    expect(
      left.map((tab) =>
        within(tab).getByTestId('page-sandbox-detail-terminal-tab-select').textContent,
      ),
    ).toEqual(['终端 1', '终端 3']);
  });
});

describe('连接状态按会话存', () => {
  it('切到别的标签时，状态栏只反映当前会话', async () => {
    viewMocks.bySession = { 'sess-a': 'connected', 'sess-b': 'connecting' };
    mockSessions([
      makeRecord({ session_id: 'sess-a', created_at: '2026-10-30T01:00:00+00:00' }),
      makeRecord({ session_id: 'sess-b', created_at: '2026-10-30T01:00:05+00:00' }),
    ]);

    const { rerender } = renderPanel(vi.fn(), { activeSessionId: 'sess-a' });

    await screen.findAllByTestId('page-sandbox-detail-terminal-tab');
    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-detail-terminal-status').textContent).toContain('已连接'),
    );

    // 切到第二个会话：状态不能还挂着上一个会话的「已连接」。
    rerender({ activeSessionId: 'sess-b' });

    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-detail-terminal-status').textContent).toContain('连接中'),
    );
    expect(screen.getByTestId('page-sandbox-detail-terminal-status').textContent).not.toContain(
      '已连接',
    );
  });
});

describe('会话表刷新', () => {
  it('切沙箱时，旧沙箱的在途响应不覆盖新沙箱的标签条', async () => {
    const pending: { resolve?: (records: TerminalSessionRecord[]) => void } = {};
    mocks.listTerminalSessions.mockImplementationOnce(
      () =>
        new Promise<TerminalSessionRecord[]>((resolve) => {
          pending.resolve = resolve;
        }),
    );
    mocks.listTerminalSessions.mockResolvedValue([
      makeRecord({ session_id: 'sess-b', sandbox_name: 'other' }),
    ]);

    const { rerender } = renderPanel();
    rerender({ sandboxName: 'other' });

    const tabs = await screen.findAllByTestId('page-sandbox-detail-terminal-tab');
    expect(tabs).toHaveLength(1);
    expect(tabs[0].getAttribute('data-session-id')).toBe('sess-b');

    // 旧沙箱的响应这时才回来：必须被丢弃。
    pending.resolve?.([makeRecord({ session_id: 'sess-old' })]);
    await waitFor(() =>
      expect(screen.getAllByTestId('page-sandbox-detail-terminal-tab')).toHaveLength(1),
    );
    expect(
      screen.getByTestId('page-sandbox-detail-terminal-tab').getAttribute('data-session-id'),
    ).toBe('sess-b');
  });

  it('会话表读取失败：弹失败 toast；新的反馈顶掉旧的失败提示', async () => {
    mocks.listTerminalSessions.mockRejectedValueOnce(new Error('读取终端会话列表失败'));
    mocks.listTerminalSessions.mockResolvedValue([]);
    mocks.createTerminalSession.mockRejectedValue(new Error('新建终端会话失败'));

    renderPanel();

    const failed = await screen.findByTestId('page-toast-item');
    expect(failed.getAttribute('data-toast-kind')).toBe('error');
    expect(failed.textContent).toContain('读取终端会话列表失败');

    // 新建会话失败：新的反馈顶掉上一条，旧的失败提示不再出现。
    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-new-button'));
    await waitFor(() =>
      expect(currentToast().textContent).toContain('新建终端会话失败'),
    );
    expect(currentToast().textContent).not.toContain('读取终端会话列表失败');
  });

  it('会话表轻轮询：面板可见时每 10 秒自动再拉一次', async () => {
    vi.useFakeTimers();
    mocks.listTerminalSessions.mockResolvedValue([]);

    renderPanel();

    await vi.waitFor(() => expect(mocks.listTerminalSessions).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.listTerminalSessions.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('终端状态提示', () => {
  it('会话正常结束（退出码 0）：弹提示 toast，不当成失败', async () => {
    viewMocks.states = {
      'sess-a': { status: 'closed', message: '终端进程已退出（退出码 0）', exitCode: 0 },
    };
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    renderPanel();

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('info');
    expect(toast.textContent).toContain('终端会话已结束');
    expect(toastsOf('error')).toHaveLength(0);
  });

  it('会话异常结束（退出码非 0）：弹失败 toast，文案带退出码', async () => {
    viewMocks.states = {
      'sess-a': { status: 'closed', message: '终端进程已退出（退出码 1）', exitCode: 1 },
    };
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    renderPanel();

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('error');
    expect(toast.textContent).toContain('退出码 1');
  });

  it('退避重连中：弹提示 toast，文案带退避秒数', async () => {
    viewMocks.states = {
      'sess-a': {
        status: 'reconnecting',
        message: '连接断开，4 秒后自动重连…',
        retryDelaySeconds: 4,
      },
    };
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    renderPanel();

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('info');
    expect(toast.textContent).toContain('4 秒后自动重连');
  });

  it('重连到上限：弹失败 toast', async () => {
    viewMocks.states = {
      'sess-a': { status: 'failed', message: '重连失败，点击重试' },
    };
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    renderPanel();

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('error');
    expect(toast.textContent).toContain('重连失败，点击重试');
  });

  it('同一状态不重复刷屏：反复上报同一个状态只弹一次', async () => {
    viewMocks.states = {
      'sess-a': { status: 'failed', message: '重连失败，点击重试' },
    };
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    const { rerender } = renderPanel();

    const toast = await screen.findByTestId('page-toast-item');
    expect(toastsOf('error')).toHaveLength(1);
    // 每次弹提示都会重建倒计时圆环（代次 +1）：拿它当「弹了几次」的凭据。
    const ringBefore = within(toast).getByTestId('page-toast-close').querySelector('circle');

    // 服务端又推了同一个状态（文案略有变化）：
    // 面板必须当成同一条提示，不再弹第二遍。
    viewMocks.states['sess-a'] = { status: 'failed', message: '重连失败，点击重试（又一次）' };
    viewMocks.reportTick += 1;
    rerender({});

    await waitFor(() =>
      expect(
        within(screen.getByTestId('page-toast-item')).getByTestId('page-toast-close').querySelector('circle'),
      ).toBe(ringBefore),
    );
    // 提示还是第一次那条：没有被第二条覆盖。
    expect(screen.getByTestId('page-toast-item').textContent).toContain('重连失败，点击重试');
    expect(screen.getByTestId('page-toast-item').textContent).not.toContain('又一次');
  });

  it('连接恢复后再失败：同一状态能重新提示', async () => {
    viewMocks.states = {
      'sess-a': { status: 'failed', message: '重连失败，点击重试' },
    };
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    const { rerender } = renderPanel();

    await screen.findByTestId('page-toast-item');
    expect(toastsOf('error')).toHaveLength(1);

    // 连接恢复：清掉「已提示过」的记录。
    viewMocks.states['sess-a'] = { status: 'connected', message: '已连接' };
    viewMocks.reportTick += 1;
    rerender({});

    // 下一轮失败：能重新提示。
    viewMocks.states['sess-a'] = { status: 'failed', message: '重连失败，点击重试' };
    viewMocks.reportTick += 1;
    rerender({});

    await waitFor(() => expect(screen.getByTestId('page-toast-item').textContent).toContain('重连失败'));
  });
});

describe('会话表轮询失败', () => {
  it('连续 3 次轮询失败：弹一条失败 toast', async () => {
    vi.useFakeTimers();
    // 首次加载成功，之后每轮都失败。
    mocks.listTerminalSessions.mockResolvedValueOnce([]);
    mocks.listTerminalSessions.mockRejectedValue(new Error('读取终端会话列表失败'));

    renderPanel();

    await vi.waitFor(() => expect(mocks.listTerminalSessions).toHaveBeenCalledTimes(1));
    // 前两轮失败：不弹。
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(screen.queryAllByTestId('page-toast-item')).toHaveLength(0);
    // 第三轮失败：弹一条。
    await vi.advanceTimersByTimeAsync(10_000);
    const toast = screen.getByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('error');
    expect(toast.textContent).toContain('连续 3 次轮询');
  });

  it('中间成功一次：连续计数清零，不弹 toast', async () => {
    vi.useFakeTimers();
    mocks.listTerminalSessions.mockResolvedValueOnce([]);
    mocks.listTerminalSessions.mockRejectedValueOnce(new Error('读取终端会话列表失败'));
    mocks.listTerminalSessions.mockResolvedValueOnce([]);
    mocks.listTerminalSessions.mockRejectedValue(new Error('读取终端会话列表失败'));

    renderPanel();

    await vi.waitFor(() => expect(mocks.listTerminalSessions).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10_000); // 失败 1
    await vi.advanceTimersByTimeAsync(10_000); // 成功：计数清零
    await vi.advanceTimersByTimeAsync(10_000); // 失败 1
    await vi.advanceTimersByTimeAsync(10_000); // 失败 2
    expect(screen.queryAllByTestId('page-toast-item')).toHaveLength(0);
  });
});
