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

import type { FileListEntry, TerminalSessionRecord } from '../api/types';
import { FILE_PANE_COLLAPSED_STORAGE_KEY } from '../lib/file-pane-collapsed';
import { clearSessionPwd, getSessionPwd, setSessionPwd } from '../lib/terminal-pwd';
import { TerminalPanel } from './TerminalPanel';
import { ToastProvider } from './Toast';

const mocks = vi.hoisted(() => ({
  listTerminalSessions: vi.fn(),
  createTerminalSession: vi.fn(),
  deleteTerminalSession: vi.fn(),
  listFiles: vi.fn(),
}));

/** 终端视图上报的状态：默认「连接中」，用来验证「标签状态与后端记录任一 running 即按运行中」。 */
const viewMocks = vi.hoisted(() => ({
  status: 'connecting',
  /** 按会话标识指定状态：验证状态栏只反映当前会话。 */
  bySession: {} as Record<string, string>,
  /** 按会话标识指定完整状态（含退出码 / 结束原因 / 退避秒数）：验证终态提示。 */
  states: {} as Record<
    string,
    {
      status: string;
      message?: string;
      exitCode?: number | null;
      exitReason?: string | null;
      retryDelaySeconds?: number;
    }
  >,
  /**
   * 上报次数：自增后终端视图会**再上报一次**当前状态。
   *
   * 服务端可能反复推同一个状态（同一个 error 帧），面板必须只弹一次提示。
   * 之前这个 mock 只在会话切换时上报一次，去重逻辑坏了也测不出来。
   */
  reportTick: 0,
  /**
   * 每次挂载时终端视图收到的 autoFocus 取值（会话标识 → 最近一次的值）。
   *
   * 焦点回填的口径在 `src/lib/terminal-focus.ts`（纯函数），面板这里只负责
   * 把门控后的结论传给终端视图，所以组件测试盯的是「传下去的值」。
   */
  autoFocus: {} as Record<string, boolean>,
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
      listFiles: mocks.listFiles,
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
      autoFocus,
      onStateChange,
    }: {
      sessionId: string;
      autoFocus?: boolean;
      onStateChange: (state: {
        status: string;
        message: string;
        exitCode?: number | null;
        exitReason?: string | null;
        retryDelaySeconds?: number;
      }) => void;
    }) => {
      const callbackRef = useRef(onStateChange);
      callbackRef.current = onStateChange;
      // 记下这次**挂载**时收到的焦点回填开关（重渲染不覆盖：口径看的是挂载那一刻）。
      const autoFocusRef = useRef(autoFocus);
      useEffect(() => {
        viewMocks.autoFocus[sessionId] = autoFocusRef.current ?? false;
      }, [sessionId]);
      useEffect(() => {
        const override = viewMocks.states[sessionId];
        if (override) {
          callbackRef.current({
            status: override.status,
            message: override.message ?? '模拟状态',
            exitCode: override.exitCode,
            exitReason: override.exitReason,
            retryDelaySeconds: override.retryDelaySeconds,
          });
          return;
        }
        const status = viewMocks.bySession[sessionId] ?? viewMocks.status;
        callbackRef.current({ status, message: '模拟状态' });
      }, [sessionId, viewMocks.reportTick]);
      // 渲染一个真的终端表面：焦点跟踪（focusin 冒泡到 document）要靠它。
      return (
        <div
          data-testid="page-sandbox-detail-terminal-surface"
          data-session-id={sessionId}
        />
      );
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
    exit_reason: null,
    pid: 4242,
    cols: 80,
    rows: 24,
    attached_count: 0,
    host_pid: 0,
    ...overrides,
  };
}

function fileEntry(overrides: Partial<FileListEntry> = {}): FileListEntry {
  return {
    name: 'a.txt',
    kind: 'file',
    size: 10,
    mtime: 1_700_000_000,
    ...overrides,
  };
}

/** 文件窗格里的行（按 `data-name` 找）。 */
function fileRow(name: string): HTMLElement | undefined {
  return screen
    .queryAllByTestId('page-file-browser-row')
    .find((node) => node.getAttribute('data-name') === name);
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

/**
 * 造一个指针事件。
 *
 * **jsdom 没有 PointerEvent**（`window.PointerEvent` 是 undefined），
 * `fireEvent.pointerDown` 的 init 字段会被丢掉 ⇒ 这里用 `MouseEvent` 带上
 * `clientX`，再自己补一个 `pointerId`。
 */
function pointerEvent(type: string, clientX: number, pointerId: number): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  return event;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  mocks.listTerminalSessions.mockReset();
  mocks.createTerminalSession.mockReset();
  mocks.deleteTerminalSession.mockReset();
  mocks.listFiles.mockReset();
  viewMocks.status = 'connecting';
  viewMocks.bySession = {};
  viewMocks.states = {};
  viewMocks.autoFocus = {};
  window.localStorage.clear();
  // pwd 是模块级缓存：用例之间清掉（免得串到下一条）。
  clearSessionPwd('sess-a');
  clearSessionPwd('sess-b');
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

  it('确认关闭会话：这条会话的 pwd 缓存一并清空（会话真的结束了）', async () => {
    mockSessions([makeRecord({ session_id: 'sess-running', state: 'running' })]);
    mocks.deleteTerminalSession.mockResolvedValue({
      session_id: 'sess-running',
      state: 'running',
      closed: true,
      removed: true,
    });
    setSessionPwd('sess-running', '/workspace');

    renderPanel();

    const tab = await screen.findByTestId('page-sandbox-detail-terminal-tab');
    fireEvent.click(within(tab).getByTestId('page-sandbox-detail-terminal-tab-close'));
    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-remove-confirm-button'));

    // 会话被关掉 ⇒ 这条会话的 pwd 缓存作废（否则缓存只增不减）。
    await waitFor(() => expect(getSessionPwd('sess-running')).toBeNull());
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

  it('用户主动关闭（结束原因 closed_by_user）：弹成功 toast，不当成失败', async () => {
    viewMocks.states = {
      'sess-a': {
        status: 'closed',
        message: '终端进程已退出（退出码 -1）',
        exitCode: -1,
        exitReason: 'closed_by_user',
      },
    };
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    renderPanel();

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('success');
    expect(toast.getAttribute('data-toast-source')).toBe('terminal-status');
    expect(toast.textContent).toContain('已关闭终端');
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

describe('终端全屏', () => {
  it('全屏开关：面板类切到覆盖整页，再点一次复原', async () => {
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    renderPanel();

    const panel = screen.getByTestId('page-sandbox-detail-terminal-panel');
    expect(panel.className).toContain('flex min-h-0 flex-1 flex-col');
    expect(panel.className).not.toContain('fixed');

    const button = screen.getByTestId('page-sandbox-detail-terminal-fullscreen-button');
    // 全屏按钮是「动作名随状态变化」的普通按钮：不带 aria-pressed。
    expect(button.getAttribute('aria-pressed')).toBeNull();
    expect(button.getAttribute('aria-label')).toBe('全屏终端');
    expect(button.getAttribute('title')).toBe('全屏终端');

    fireEvent.click(button);

    expect(panel.className).toContain('fixed');
    expect(panel.className).toContain('inset-0');
    expect(panel.className).toContain('z-40');
    expect(panel.className).toContain('overflow-hidden');
    // 面板内部是 flex 列（终端表面靠 flex-1 撑满剩余高度）：不能丢
    expect(panel.className).toContain('flex');
    expect(panel.className).toContain('flex-col');
    expect(button.getAttribute('aria-pressed')).toBeNull();
    expect(button.getAttribute('aria-label')).toBe('退出全屏');
    expect(button.getAttribute('title')).toBe('退出全屏');

    // 退出全屏 = 再点同一个按钮
    fireEvent.click(button);

    expect(panel.className).not.toContain('fixed');
    expect(panel.className).toContain('flex min-h-0 flex-1 flex-col');
    expect(button.getAttribute('aria-pressed')).toBeNull();
    expect(button.getAttribute('aria-label')).toBe('全屏终端');
  });

  it('全屏状态不入路由也不入存储', async () => {
    mockSessions([makeRecord({ session_id: 'sess-a' })]);
    const hashBefore = window.location.hash;
    const hrefBefore = window.location.href;

    renderPanel();

    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-fullscreen-button'));

    // 路由一点没动
    expect(window.location.hash).toBe(hashBefore);
    expect(window.location.href).toBe(hrefBefore);
    // 存储里不能有全屏相关的键：全屏只活在本地面板状态里
    expect(
      Object.keys(window.localStorage).filter((key) => key.includes('fullscreen')),
      '全屏状态被写进了存储',
    ).toEqual([]);
  });
  it('换沙箱：退出全屏（全屏是当前沙箱终端的局部状态）', async () => {
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    const { rerender } = renderPanel(vi.fn(), { sandboxName: 'demo-a' });

    const panel = screen.getByTestId('page-sandbox-detail-terminal-panel');
    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-fullscreen-button'));
    expect(panel.className).toContain('fixed');

    // 换沙箱：不能把新沙箱的终端顶在一个覆盖整页的全屏面板下面
    rerender({ sandboxName: 'demo-b' });

    await waitFor(() => expect(panel.className).not.toContain('fixed'));
  });
});

describe('焦点回填', () => {
  it('点标签后重挂载的终端自动聚焦', async () => {
    mockSessions([
      makeRecord({ session_id: 'sess-a', created_at: '2026-10-30T01:00:00+00:00' }),
      makeRecord({ session_id: 'sess-b', created_at: '2026-10-30T01:00:05+00:00' }),
    ]);
    const { rerender } = renderPanel(vi.fn(), { activeSessionId: 'sess-a' });

    const tabs = await screen.findAllByTestId('page-sandbox-detail-terminal-tab');
    // 初次挂载：没有回填意图、焦点也不在终端里 → 不回填
    // （终端视图把收到的值记在挂载那一刻的 useEffect 里：断言等它落定，
    //  但口径一点没放宽——仍然是「必须正好是 false」。）
    await waitFor(() => expect(viewMocks.autoFocus['sess-a']).toBe(false));

    // 点标签：这是明确的操作意图（重挂载之后要把焦点还给终端）
    fireEvent.click(
      within(tabs[1]).getByTestId('page-sandbox-detail-terminal-tab-select'),
    );
    // 路由跟上（真实页面里路由变了，终端才会整块重挂载）
    rerender({ activeSessionId: 'sess-b' });

    await waitFor(() => expect(viewMocks.autoFocus['sess-b']).toBe(true));
  });

  it('焦点原本就在终端表面内：重挂载后把焦点还回终端', async () => {
    mockSessions([
      makeRecord({ session_id: 'sess-a', created_at: '2026-10-30T01:00:00+00:00' }),
      makeRecord({ session_id: 'sess-b', created_at: '2026-10-30T01:00:05+00:00' }),
    ]);
    const { rerender } = renderPanel(vi.fn(), { activeSessionId: 'sess-a' });

    await screen.findAllByTestId('page-sandbox-detail-terminal-tab');

    // 焦点落在终端表面里（用户正在终端里干活）
    const surface = screen.getByTestId('page-sandbox-detail-terminal-surface');
    const inside = document.createElement('input');
    surface.appendChild(inside);
    inside.focus();
    inside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(document.activeElement).toBe(inside);

    // 会话切换（不是用户点的标签）：焦点原本就在终端里，重挂载后要还回来
    rerender({ activeSessionId: 'sess-b' });

    await waitFor(() => expect(viewMocks.autoFocus['sess-b']).toBe(true));
    inside.remove();
  });

  it('焦点在终端表面之外时不抢：重挂载也不回填焦点', async () => {
    mockSessions([
      makeRecord({ session_id: 'sess-a', created_at: '2026-10-30T01:00:00+00:00' }),
      makeRecord({ session_id: 'sess-b', created_at: '2026-10-30T01:00:05+00:00' }),
    ]);
    const { rerender } = renderPanel(vi.fn(), { activeSessionId: 'sess-a' });

    await screen.findAllByTestId('page-sandbox-detail-terminal-tab');

    // 焦点落到终端表面之外（比如抽屉里的输入框）
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(document.activeElement).toBe(outside);

    // 会话切换（不是用户点的标签）：重挂载时不能把焦点从别处抢回终端
    rerender({ activeSessionId: 'sess-b' });

    await waitFor(() => expect(viewMocks.autoFocus['sess-b']).toBe(false));
    outside.remove();
  });

  it('重挂载把焦点复位到 body（且不派发 focusin）：没有用户意图就不回填', async () => {
    mockSessions([
      makeRecord({ session_id: 'sess-a', created_at: '2026-10-30T01:00:00+00:00' }),
      makeRecord({ session_id: 'sess-b', created_at: '2026-10-30T01:00:05+00:00' }),
    ]);
    const { rerender } = renderPanel(vi.fn(), { activeSessionId: 'sess-a' });

    await screen.findAllByTestId('page-sandbox-detail-terminal-tab');

    // 焦点落在终端表面里（用户正在终端里干活）
    const surface = screen.getByTestId('page-sandbox-detail-terminal-surface');
    const inside = document.createElement('input');
    surface.appendChild(inside);
    inside.focus();
    inside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(document.activeElement).toBe(inside);

    // 终端重挂载：xterm 的 helper textarea 被摘出 DOM。浏览器把焦点复位到
    // body，且**不派发 focusin**——只靠事件跟踪记下来的标志会永远停在 true，
    // 门控退化成「永远回填」。
    inside.remove();
    expect(document.activeElement).toBe(document.body);

    // 下一轮重挂载（不是用户点的标签，没有操作意图）：不能回填
    rerender({ activeSessionId: 'sess-b' });

    await waitFor(() => expect(viewMocks.autoFocus['sess-b']).toBe(false));
  });

  it('新建终端会话后：新建出来的终端自动聚焦（明确的用户意图）', async () => {
    mocks.listTerminalSessions.mockResolvedValueOnce([]);
    mocks.listTerminalSessions.mockResolvedValue([
      makeRecord({ session_id: 'sess-new', created_at: '2026-10-30T01:00:00+00:00' }),
    ]);
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
    const { rerender } = renderPanel(onActiveSessionChange);

    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-new-button'));
    await waitFor(() => expect(onActiveSessionChange).toHaveBeenCalledWith('sess-new'));

    // 路由跟上（真实页面里路由变了，终端才会整块重挂载）
    rerender({ activeSessionId: 'sess-new' });

    // 新建会话是明确的用户操作意图：重挂载后要把焦点还给用户
    await waitFor(() => expect(viewMocks.autoFocus['sess-new']).toBe(true));
  });
});

describe('选中会话的稳定性', () => {
  it('刷新成功且路由会话真消失：回落一次到第一个标签并同步回路由', async () => {
    mocks.listTerminalSessions.mockResolvedValueOnce([
      makeRecord({ session_id: 'sess-a', created_at: '2026-10-30T01:00:00+00:00' }),
      makeRecord({ session_id: 'sess-b', created_at: '2026-10-30T01:00:05+00:00' }),
    ]);
    // 之后的每一轮：sess-b 已经不在会话表里了
    mocks.listTerminalSessions.mockResolvedValue([
      makeRecord({ session_id: 'sess-a', created_at: '2026-10-30T01:00:00+00:00' }),
    ]);
    const onActiveSessionChange = vi.fn();
    const { rerender } = renderPanel(onActiveSessionChange, { activeSessionId: 'sess-b' });

    await screen.findAllByTestId('page-sandbox-detail-terminal-tab');

    // 路由指向的会话真消失了（这一轮刷新是成功的）
    rerender({ activeSessionId: 'sess-gone' });

    // 回落一次到第一个标签，并把回落结果同步回路由（否则下一轮轮询又会跳回去）
    await waitFor(() => expect(onActiveSessionChange).toHaveBeenCalledWith('sess-a'));
    const tabs = screen.getAllByTestId('page-sandbox-detail-terminal-tab');
    const active = tabs.find((tab) => tab.getAttribute('data-active') === 'true');
    expect(active?.getAttribute('data-session-id')).toBe('sess-a');
  });

  it('会话表刷新失败：标签表不清空（沿用上一轮读到的会话与当前选中）', async () => {
    vi.useFakeTimers();
    mocks.listTerminalSessions.mockResolvedValueOnce([
      makeRecord({ session_id: 'sess-a', created_at: '2026-10-30T01:00:00+00:00' }),
      makeRecord({ session_id: 'sess-b', created_at: '2026-10-30T01:00:05+00:00' }),
    ]);
    mocks.listTerminalSessions.mockRejectedValue(new Error('读取终端会话列表失败'));

    renderPanel(vi.fn(), { activeSessionId: 'sess-b' });

    await vi.waitFor(() =>
      expect(screen.getAllByTestId('page-sandbox-detail-terminal-tab')).toHaveLength(2),
    );
    // 跨过一次 10 秒轮询窗口：这一轮读取失败
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() =>
      expect(mocks.listTerminalSessions.mock.calls.length).toBeGreaterThan(1),
    );

    // 标签还在：沿用上一轮成功的会话表，不清空
    const tabs = screen.getAllByTestId('page-sandbox-detail-terminal-tab');
    expect(tabs.map((tab) => tab.getAttribute('data-session-id'))).toEqual([
      'sess-a',
      'sess-b',
    ]);
    // 当前选中也没变
    const active = tabs.find((tab) => tab.getAttribute('data-active') === 'true');
    expect(active?.getAttribute('data-session-id')).toBe('sess-b');
  });

  it('刷新失败且路由会话不在表里：沿用上一轮选中的会话，不跳走也不改路由', async () => {
    vi.useFakeTimers();
    mocks.listTerminalSessions.mockResolvedValueOnce([
      makeRecord({ session_id: 'sess-a', created_at: '2026-10-30T01:00:00+00:00' }),
      makeRecord({ session_id: 'sess-b', created_at: '2026-10-30T01:00:05+00:00' }),
    ]);
    mocks.listTerminalSessions.mockRejectedValue(new Error('读取终端会话列表失败'));
    const onActiveSessionChange = vi.fn();
    const { rerender } = renderPanel(onActiveSessionChange, { activeSessionId: 'sess-b' });

    await vi.waitFor(() =>
      expect(screen.getAllByTestId('page-sandbox-detail-terminal-tab')).toHaveLength(2),
    );
    // 跨过一次轮询窗口：这一轮读取失败（表不可信）
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() =>
      expect(mocks.listTerminalSessions.mock.calls.length).toBeGreaterThan(1),
    );

    // 路由指向一个不在会话表里的会话（别的终端关掉了它 / 链接过期）
    rerender({ activeSessionId: 'sess-gone' });

    // 刷新失败：沿用上一轮选中的会话（不跳到第一个标签，也不改路由）
    const tabs = screen.getAllByTestId('page-sandbox-detail-terminal-tab');
    const active = tabs.find((tab) => tab.getAttribute('data-active') === 'true');
    expect(active?.getAttribute('data-session-id')).toBe('sess-b');
    expect(onActiveSessionChange).not.toHaveBeenCalled();
  });
});

describe('三段式分屏与文件窗格', () => {
  it('有终端会话：左终端面板 + 中分隔条 + 右文件窗格（默认 340px）', async () => {
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    renderPanel();

    await screen.findByTestId('page-sandbox-detail-terminal-tab');
    expect(screen.getByTestId('page-terminal-split')).toBeTruthy();
    expect(screen.getByTestId('page-terminal-split-terminal')).toBeTruthy();

    const handle = screen.getByTestId('page-terminal-split-handle');
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    // 窗格宽度的可调范围：下限 = 窗格最小宽 240；上限默认 = 窗格最大宽 720。
    expect(handle.getAttribute('aria-valuemin')).toBe('240');
    expect(handle.getAttribute('aria-valuemax')).toBe('720');
    expect(handle.getAttribute('aria-valuenow')).toBe('340');

    const pane = screen.getByTestId('page-file-pane');
    expect(pane.style.width).toBe('340px');
  });

  it('没有终端会话：窗格整体消失，内容区显示空态', async () => {
    mockSessions([]);

    renderPanel();

    const empty = await screen.findByTestId('page-sandbox-detail-terminal-empty-title');
    expect(empty.textContent).toContain('没有终端会话');
    expect(screen.getByTestId('page-sandbox-detail-terminal-empty-create-button')).toBeTruthy();
    expect(screen.queryByTestId('page-file-pane')).toBeNull();
    expect(screen.queryByTestId('page-terminal-split-handle')).toBeNull();
  });

  it('空态里的「新建会话」入口：点了真的建会话', async () => {
    mockSessions([]);
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

    fireEvent.click(await screen.findByTestId('page-sandbox-detail-terminal-empty-create-button'));
    await waitFor(() => expect(mocks.createTerminalSession).toHaveBeenCalledWith(sandboxName, 80, 24));
    await waitFor(() => expect(onActiveSessionChange).toHaveBeenCalledWith('sess-new'));
  });

  it('折叠：收成 36px 纯图标竖条（无文字、只有展开按钮），折叠态落盘', async () => {
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    renderPanel();

    await screen.findByTestId('page-file-pane');
    fireEvent.click(screen.getByTestId('page-file-pane-collapse-button'));

    const collapsed = await screen.findByTestId('page-file-pane-collapsed');
    // 竖条上**只有顶部一个展开按钮**，且**没有任何文字**。
    expect(collapsed.querySelectorAll('button')).toHaveLength(1);
    expect(collapsed.textContent).toBe('');
    expect(screen.getByTestId('page-file-pane-expand-button')).toBeTruthy();
    // 折叠态：36px 竖条，没有分隔条可拖。
    expect(screen.getByTestId('page-file-pane').style.width).toBe('36px');
    expect(screen.queryByTestId('page-terminal-split-handle')).toBeNull();
    // 折叠态写进本地存储（跨会话关闭 / 重开保持）。
    expect(window.localStorage.getItem(FILE_PANE_COLLAPSED_STORAGE_KEY)).toBe('1');
  });

  it('展开：恢复原宽度；折叠态从存储里读回', async () => {
    window.localStorage.setItem(FILE_PANE_COLLAPSED_STORAGE_KEY, '1');
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    renderPanel();

    await screen.findByTestId('page-file-pane-collapsed');
    expect(screen.getByTestId('page-file-pane').style.width).toBe('36px');

    fireEvent.click(screen.getByTestId('page-file-pane-expand-button'));

    await screen.findByTestId('page-file-pane-content');
    expect(screen.getByTestId('page-file-pane').style.width).toBe('340px');
    expect(window.localStorage.getItem(FILE_PANE_COLLAPSED_STORAGE_KEY)).toBe('0');
  });

  it('拖分隔条：往左拖窗格变宽，往右拖变窄', async () => {
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    renderPanel();

    const handle = await screen.findByTestId('page-terminal-split-handle');
    fireEvent(handle, pointerEvent('pointerdown', 600, 1));
    fireEvent(handle, pointerEvent('pointermove', 500, 1));
    await waitFor(() => expect(screen.getByTestId('page-file-pane').style.width).toBe('440px'));

    fireEvent(handle, pointerEvent('pointermove', 650, 1));
    await waitFor(() => expect(screen.getByTestId('page-file-pane').style.width).toBe('290px'));
  });

  it('分隔条能用键盘调宽（每次 16px）', async () => {
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    renderPanel();

    const handle = await screen.findByTestId('page-terminal-split-handle');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    await waitFor(() => expect(screen.getByTestId('page-file-pane').style.width).toBe('356px'));
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByTestId('page-file-pane').style.width).toBe('340px'));
  });

  it('骑缝把手常显且直角（复验修复轮·第二批 #2/#6）：把手带与图标静置可见、无圆角', async () => {
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    renderPanel();

    const handle = await screen.findByTestId('page-terminal-split-handle');
    const tokens = handle.className.split(/\s+/).filter(Boolean);
    // **常显**：把手带静置有底色（不再「hover 才显形」的 bg-transparent）
    expect(tokens, '把手带应有静置可见的底色（bg-muted）').toContain('bg-muted');
    expect(tokens).not.toContain('bg-transparent');
    // hover 高亮保留：**不透明叠加实色**（不用半透明 `/30`，半透明会透出终端底色）
    expect(tokens).toContain(
      'hover:bg-[color-mix(in_oklab,var(--app-primary)_30%,var(--app-muted))]',
    );
    expect(tokens.some((token) => token.includes('/30'))).toBe(false);
    // **直角**：把手本体与 hover 高亮都不带任何圆角
    expect(tokens.filter((token) => token.includes('rounded'))).toEqual([]);
    // 抓握图标静置可见（不再是半透明 /40，hover / 聚焦时加深）
    const icon = handle.querySelector('svg');
    expect(icon).toBeTruthy();
    const iconTokens = (icon as unknown as SVGElement).getAttribute('class')?.split(/\s+/) ?? [];
    expect(iconTokens).toContain('text-muted-foreground');
    expect(iconTokens.some((token) => token.includes('/40'))).toBe(false);
    // a11y 增强（复验修复轮·第二批审查）：数值带单位（与 Obsidian 把手同一份组件）
    expect(handle.getAttribute('aria-valuetext')).toBe('340px');
  });

  it('分隔条 aria-valuemax 跟钳位函数的实际上限走（容器宽 900 ⇒ 上限 580）', async () => {
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    renderPanel();

    const handle = await screen.findByTestId('page-terminal-split-handle');
    const split = screen.getByTestId('page-terminal-split');
    vi.spyOn(split, 'getBoundingClientRect').mockReturnValue({
      width: 900,
      height: 400,
      top: 0,
      left: 0,
      right: 900,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    // 键盘调宽触发一次重渲染，aria-valuemax 按当时的容器宽重新求值：
    // min(720, 900 − 320) = 580。
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    await waitFor(() => expect(handle.getAttribute('aria-valuemax')).toBe('580'));
    expect(handle.getAttribute('aria-valuenow')).toBe('356');
  });

  it('折叠态跨会话：关掉全部会话后再新建，窗格仍是折叠态', async () => {
    window.localStorage.setItem(FILE_PANE_COLLAPSED_STORAGE_KEY, '1');
    // 首轮没有会话；新建之后这一轮读到新会话。
    mocks.listTerminalSessions.mockResolvedValueOnce([]);
    mocks.listTerminalSessions.mockResolvedValue([makeRecord({ session_id: 'sess-new' })]);
    mocks.createTerminalSession.mockResolvedValue({
      session_id: 'sess-new',
      sandbox: 'demo',
      container_name: 'sandbox-demo',
      cols: 80,
      rows: 24,
      state: 'running',
      created_at: '2026-10-30T01:00:00+00:00',
    });

    renderPanel();

    // 没有会话：窗格整体消失。
    await screen.findByTestId('page-sandbox-detail-terminal-empty-title');
    expect(screen.queryByTestId('page-file-pane')).toBeNull();

    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-empty-create-button'));

    // 新会话进来：窗格恢复，而且**仍是折叠态**（36px 纯图标竖条）。
    const collapsed = await screen.findByTestId('page-file-pane-collapsed');
    expect(collapsed.querySelectorAll('button')).toHaveLength(1);
    expect(screen.getByTestId('page-file-pane').style.width).toBe('36px');
  });

  it('换会话：窗格按新会话重新定位，不沿用上一个会话的 pwd', async () => {
    setSessionPwd('sess-a', '/from-a');
    mockSessions([
      makeRecord({ session_id: 'sess-a' }),
      makeRecord({ session_id: 'sess-b' }),
    ]);

    const { sandboxName, rerender } = renderPanel(vi.fn(), {
      activeSessionId: 'sess-a',
      sandboxWorkdir: '/workdir',
    });

    // 会话 A：从它的 pwd 起读。
    await waitFor(() => expect(mocks.listFiles).toHaveBeenCalledWith(sandboxName, '/from-a'));

    // 切到会话 B（它还没上报 pwd）：定位走 fallback 链的 workdir，
    // **不能**拿 A 的 pwd 顶上。
    rerender({ activeSessionId: 'sess-b' });
    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenLastCalledWith(sandboxName, '/workdir'),
    );
    // 回跳按钮也立刻回到「未上报」态（tooltip 不残留 A 的路径）。
    await waitFor(() =>
      expect(screen.getByTestId('page-file-pane-jump-button').getAttribute('title')).toBe(
        '当前会话未上报工作目录',
      ),
    );
  });

  it('换会话：A 里导航过的目录不带到 B（窗格落 B 的 fallback 起点）', async () => {
    setSessionPwd('sess-a', '/from-a');
    mockSessions([
      makeRecord({ session_id: 'sess-a' }),
      makeRecord({ session_id: 'sess-b' }),
    ]);
    mocks.listFiles.mockImplementation((_sandbox: string, directory: string) =>
      Promise.resolve(
        directory === '/from-a' ? [fileEntry({ name: 'a-sub', kind: 'dir' })] : [],
      ),
    );

    const { sandboxName, rerender } = renderPanel(vi.fn(), {
      activeSessionId: 'sess-a',
      sandboxWorkdir: '/workdir',
    });
    await waitFor(() => expect(mocks.listFiles).toHaveBeenCalledWith(sandboxName, '/from-a'));

    // 用户在会话 A 里导航到子目录。
    await waitFor(() => expect(fileRow('a-sub')).toBeTruthy());
    fireEvent.click(fileRow('a-sub')!);
    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenLastCalledWith(sandboxName, '/from-a/a-sub'),
    );

    // 切到会话 B（无 pwd）：必须按 B 的 fallback（workdir）重新起点，
    // 绝不留在 A 里用户去的目录（userNavigatedRef 已复位）。
    mocks.listFiles.mockClear();
    rerender({ activeSessionId: 'sess-b' });
    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenLastCalledWith(sandboxName, '/workdir'),
    );
    expect(
      mocks.listFiles.mock.calls.some(([, directory]) => directory === '/from-a/a-sub'),
    ).toBe(false);
    expect(screen.queryByText('a-sub')).toBeNull();
  });

  it('换沙箱自动退出全屏（全屏是「当前沙箱终端」的局部状态）', async () => {
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    const { rerender } = renderPanel(vi.fn(), { sandboxName: 'demo-fullscreen' });

    await screen.findByTestId('page-file-pane');
    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-fullscreen-button'));
    expect(screen.getByTestId('page-sandbox-detail-terminal-panel').className).toContain('fixed');

    rerender({ sandboxName: 'demo-other' });

    await waitFor(() =>
      expect(
        screen.getByTestId('page-sandbox-detail-terminal-panel').className,
      ).not.toContain('fixed'),
    );
  });

  it('全屏：内容区（含文件窗格）被 fixed 覆盖，tabs 条仍在全屏层内', async () => {
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    renderPanel();

    await screen.findByTestId('page-file-pane');
    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-fullscreen-button'));

    const panel = screen.getByTestId('page-sandbox-detail-terminal-panel');
    expect(panel.className).toContain('fixed');
    expect(panel.className).toContain('inset-0');
    expect(panel.className).toContain('z-40');
    // 全屏层里 tabs 条可见（可切 tab），文件窗格也在层内。
    expect(screen.getByTestId('page-sandbox-detail-terminal-tabs')).toBeTruthy();
    expect(screen.getByTestId('page-file-pane')).toBeTruthy();
  });
});

describe('Obsidian tab（06 轮：固定 tab + 文件窗格联动）', () => {
  /** tabs 条里固定的 Obsidian tab。 */
  function obsidianTab(): HTMLElement {
    return screen.getByTestId('page-sandbox-detail-obsidian-tab');
  }

  it('最左的固定 tab：官方 logo（本地资产）+「Obsidian」文字、无关闭按钮', async () => {
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    renderPanel();

    await screen.findAllByTestId('page-sandbox-detail-terminal-tab');
    const tablist = screen.getByTestId('page-sandbox-detail-terminal-tabs');
    const first = tablist.querySelector('[role="tab"]');
    expect(first?.getAttribute('data-testid')).toBe('page-sandbox-detail-obsidian-tab');

    const tab = obsidianTab();
    // 不可关闭：tab 上只有一个按钮（选中），没有任何关闭按钮。
    expect(tab.querySelectorAll('button')).toHaveLength(1);
    expect(within(tab).queryByTestId('page-sandbox-detail-terminal-tab-close')).toBeNull();
    expect(tab.textContent).toContain('Obsidian');

    // 图标是本地 SVG 资产（运行时零 CDN：不是 http(s) 外链）。
    const icon = within(tab).getByTestId('page-sandbox-detail-obsidian-tab-icon');
    const src = icon.getAttribute('src') ?? '';
    expect(src).toContain('obsidian');
    expect(src.startsWith('http://')).toBe(false);
    expect(src.startsWith('https://')).toBe(false);

    // 默认激活的是终端 tab。
    expect(tab.getAttribute('aria-selected')).toBe('false');
    expect(tab.getAttribute('data-active')).toBe('false');
  });

  it('没有任何终端会话时该 tab 仍可用（点开照样进 Obsidian 视图）', async () => {
    mockSessions([]);

    const onActiveSessionChange = vi.fn();
    renderPanel(onActiveSessionChange);

    await screen.findByTestId('page-sandbox-detail-terminal-empty-title');
    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-tab-select'));

    expect(obsidianTab().getAttribute('aria-selected')).toBe('true');
    expect(obsidianTab().getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('page-sandbox-detail-obsidian')).toBeTruthy();
    // 点 tab 不改选中会话（tab 与终端会话无关）。
    expect(onActiveSessionChange).not.toHaveBeenCalled();
    // 终端 tab 的「没有终端会话」空态只在终端 tab 激活时出现。
    expect(screen.queryByTestId('page-sandbox-detail-terminal-empty-title')).toBeNull();
  });

  it('激活 Obsidian ⇒ 文件窗格与分隔条消失；切回终端 tab ⇒ 按原折叠态恢复', async () => {
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    renderPanel();

    // 先在终端 tab 里把窗格折叠起来（折叠态由 TerminalPanel 持有）。
    await screen.findByTestId('page-file-pane');
    fireEvent.click(screen.getByTestId('page-file-pane-collapse-button'));
    await screen.findByTestId('page-file-pane-collapsed');
    expect(screen.getByTestId('page-file-pane').style.width).toBe('36px');

    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-tab-select'));

    // Obsidian tab 激活：终端分屏整体不出现（窗格 / 分隔条 / 终端表面都不在）。
    expect(screen.queryByTestId('page-terminal-split')).toBeNull();
    expect(screen.queryByTestId('page-file-pane')).toBeNull();
    expect(screen.queryByTestId('page-terminal-split-handle')).toBeNull();
    expect(screen.queryByTestId('page-sandbox-detail-terminal-surface')).toBeNull();
    expect(screen.getByTestId('page-sandbox-detail-obsidian')).toBeTruthy();

    // 点终端标签切回：窗格按**原折叠态**恢复（36px），折叠态没被重置。
    const tab = await screen.findByTestId('page-sandbox-detail-terminal-tab');
    fireEvent.click(within(tab).getByTestId('page-sandbox-detail-terminal-tab-select'));

    const pane = await screen.findByTestId('page-file-pane');
    expect(pane.style.width).toBe('36px');
    expect(screen.getByTestId('page-file-pane-collapsed')).toBeTruthy();
    expect(screen.getByTestId('page-sandbox-detail-terminal-surface')).toBeTruthy();
    expect(screen.queryByTestId('page-sandbox-detail-obsidian')).toBeNull();
    expect(obsidianTab().getAttribute('aria-selected')).toBe('false');
  });

  it('展开态下切回终端 tab：窗格与分隔条都回来（宽度不变）', async () => {
    mockSessions([makeRecord({ session_id: 'sess-a' })]);

    renderPanel();

    await screen.findByTestId('page-file-pane');
    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-tab-select'));
    expect(screen.queryByTestId('page-file-pane')).toBeNull();

    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-tab-select'));
    await screen.findByTestId('page-file-pane');
    expect(screen.getByTestId('page-file-pane').style.width).toBe('340px');
    expect(screen.getByTestId('page-terminal-split-handle')).toBeTruthy();
  });

  it('在 Obsidian tab 上新建会话：回到终端 tab', async () => {
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

    renderPanel();

    await screen.findByTestId('page-sandbox-detail-terminal-empty-title');
    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-tab-select'));
    expect(screen.getByTestId('page-sandbox-detail-obsidian')).toBeTruthy();

    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-new-button'));

    await waitFor(() => expect(screen.queryByTestId('page-sandbox-detail-obsidian')).toBeNull());
    // 路由由父组件驱动（这里 onActiveSessionChange 是替身）：断言的是「tab 回到终端」。
    expect(screen.getByTestId('page-sandbox-detail-terminal-empty-title')).toBeTruthy();
  });

  it('全屏：Obsidian 双栏在全屏层内（tabs 条仍可见、可切）', async () => {
    mockSessions([]);

    renderPanel();

    await screen.findByTestId('page-sandbox-detail-terminal-empty-title');
    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-tab-select'));
    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-fullscreen-button'));

    const panel = screen.getByTestId('page-sandbox-detail-terminal-panel');
    expect(panel.className).toContain('fixed');
    expect(screen.getByTestId('page-sandbox-detail-terminal-tabs')).toBeTruthy();
    expect(screen.getByTestId('page-sandbox-detail-obsidian')).toBeTruthy();
  });
});
