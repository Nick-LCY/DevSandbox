// @vitest-environment jsdom
/**
 * 终端面板的会话标签与关闭会话交互。
 *
 * 覆盖三件事：
 * - 后端会话表渲染成标签（一个标签 = 一个会话），点标签回调选中；
 * - 关标签先弹确认：运行中的会话说「关闭并移除」，已退出的说「移除记录」；
 * - 删除成功 / 有副作用（记录已不存在、关闭流程未走完）分别落在正确位置。
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalSessionRecord } from '../api/types';
import { TerminalPanel } from './TerminalPanel';

const mocks = vi.hoisted(() => ({
  listTerminalSessions: vi.fn(),
  createTerminalSession: vi.fn(),
  deleteTerminalSession: vi.fn(),
}));

/** 终端视图上报的状态：默认「连接中」，用来验证「标签状态与后端记录任一 running 即按运行中」。 */
const viewMocks = vi.hoisted(() => ({ status: 'connecting' }));

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
// 替掉的那份会按 viewMocks.status 上报一次连接状态。
vi.mock('./TerminalView', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    TerminalView: ({
      sessionId,
      onStateChange,
    }: {
      sessionId: string;
      onStateChange: (state: { status: string; message: string }) => void;
    }) => {
      const callbackRef = useRef(onStateChange);
      callbackRef.current = onStateChange;
      useEffect(() => {
        callbackRef.current({ status: viewMocks.status, message: '模拟状态' });
      }, [sessionId]);
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

function renderPanel(
  onActiveSessionChange: (sessionId: string | null) => void = vi.fn(),
): void {
  render(
    <TerminalPanel
      sandboxName="demo"
      sandboxRunning
      activeSessionId={null}
      onActiveSessionChange={onActiveSessionChange}
    />,
  );
}

/** 首次返回会话列表，之后返回空列表（会话已经被删掉了）。 */
function mockSessions(records: TerminalSessionRecord[]): void {
  mocks.listTerminalSessions.mockResolvedValueOnce(records);
  mocks.listTerminalSessions.mockResolvedValue([]);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.listTerminalSessions.mockReset();
  mocks.createTerminalSession.mockReset();
  mocks.deleteTerminalSession.mockReset();
  viewMocks.status = 'connecting';
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

    renderPanel(onActiveSessionChange);

    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-new-button'));
    await waitFor(() => expect(mocks.createTerminalSession).toHaveBeenCalledWith('demo', 80, 24));
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

  it('删除失败：把后端的 detail 原样展示出来', async () => {
    mockSessions([makeRecord({ session_id: 'sess-gone', state: 'exited', exit_code: 0 })]);
    mocks.deleteTerminalSession.mockRejectedValue(
      new Error('终端会话不存在或已失效：sess-gone'),
    );

    renderPanel();

    const tab = await screen.findByTestId('page-sandbox-detail-terminal-tab');
    fireEvent.click(within(tab).getByTestId('page-sandbox-detail-terminal-tab-close'));
    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-remove-confirm-button'));

    const banner = await screen.findByTestId('page-sandbox-detail-terminal-error');
    expect(banner.textContent).toContain('终端会话不存在或已失效：sess-gone');
    // 失败时标签还在：用户还能重试
    expect(screen.getByTestId('page-sandbox-detail-terminal-tab')).toBeTruthy();
  });

  it('删除响应说记录已不存在：单独提示，不当成失败', async () => {
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

    const notice = await screen.findByTestId('page-sandbox-detail-terminal-notice');
    expect(notice.textContent).toContain('记录已不存在（可能已被删除）');
    // 删除本体没失败：不挂错误横幅
    expect(screen.queryByTestId('page-sandbox-detail-terminal-error')).toBeNull();
  });

  it('关闭流程没走完：提示残留进程，不当成失败', async () => {
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

    const notice = await screen.findByTestId('page-sandbox-detail-terminal-notice');
    expect(notice.textContent).toContain('会话记录已删除，但关闭流程未走完（容器内可能仍有残留进程）');
    expect(screen.queryByTestId('page-sandbox-detail-terminal-error')).toBeNull();
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

    const notice = await screen.findByTestId('page-sandbox-detail-terminal-notice');
    expect(notice.textContent).toContain('会话列表刷新失败');
    // 删除已经成功：不把刷新失败说成删除失败
    expect(screen.queryByTestId('page-sandbox-detail-terminal-error')).toBeNull();
  });
});
