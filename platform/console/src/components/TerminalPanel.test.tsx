// @vitest-environment jsdom
/**
 * 终端面板的删除会话交互。
 *
 * 覆盖三件事：
 * - 运行中的会话：点「关闭」先轻确认，确认后真的删掉（列表项与标签都消失）；
 * - 已退出的会话：点「移除」直接执行，不多问一句；
 * - 删除失败：把后端的 `detail` 原样展示出来。
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

// 终端视图要真 xterm 与真 WebSocket：这里只关心面板的交互，直接替掉
vi.mock('./TerminalView', () => ({
  TerminalView: () => null,
}));

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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.listTerminalSessions.mockReset();
  mocks.createTerminalSession.mockReset();
  mocks.deleteTerminalSession.mockReset();
});

describe('终端会话删除', () => {
  it('运行中的会话：点关闭先轻确认，确认后才删', async () => {
    mocks.listTerminalSessions.mockResolvedValue([]);
    mocks.listTerminalSessions.mockResolvedValueOnce([
      makeRecord({ session_id: 'sess-running', state: 'running' }),
    ]);
    mocks.deleteTerminalSession.mockResolvedValue({
      session_id: 'sess-running',
      state: 'running',
      closed: true,
      removed: true,
    });

    render(<TerminalPanel sandboxName="demo" sandboxRunning />);

    const item = await screen.findByTestId('page-sandbox-detail-terminal-existing-item');
    const button = within(item).getByTestId(
      'page-sandbox-detail-terminal-existing-remove-button',
    );
    expect(button.textContent).toBe('关闭');

    fireEvent.click(button);
    // 轻确认条出现，删除请求还没发
    expect(screen.getByTestId('page-sandbox-detail-terminal-remove-confirm')).toBeTruthy();
    expect(mocks.deleteTerminalSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-remove-confirm-button'));
    await waitFor(() => expect(mocks.deleteTerminalSession).toHaveBeenCalledWith('sess-running'));
    await waitFor(() =>
      expect(screen.queryByTestId('page-sandbox-detail-terminal-existing-item')).toBeNull(),
    );
  });

  it('轻确认可以取消：取消不发删除请求', async () => {
    mocks.listTerminalSessions.mockResolvedValue([
      makeRecord({ session_id: 'sess-running', state: 'running' }),
    ]);

    render(<TerminalPanel sandboxName="demo" sandboxRunning />);

    const item = await screen.findByTestId('page-sandbox-detail-terminal-existing-item');
    fireEvent.click(
      within(item).getByTestId('page-sandbox-detail-terminal-existing-remove-button'),
    );
    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-remove-cancel-button'));

    expect(screen.queryByTestId('page-sandbox-detail-terminal-remove-confirm')).toBeNull();
    expect(mocks.deleteTerminalSession).not.toHaveBeenCalled();
  });

  it('已退出的会话：点移除直接执行，不多问一句', async () => {
    mocks.listTerminalSessions.mockResolvedValue([]);
    mocks.listTerminalSessions.mockResolvedValueOnce([
      makeRecord({ session_id: 'sess-exited', state: 'exited', exit_code: 0 }),
    ]);
    mocks.deleteTerminalSession.mockResolvedValue({
      session_id: 'sess-exited',
      state: 'exited',
      closed: false,
      removed: true,
    });

    render(<TerminalPanel sandboxName="demo" sandboxRunning />);

    const item = await screen.findByTestId('page-sandbox-detail-terminal-existing-item');
    const button = within(item).getByTestId(
      'page-sandbox-detail-terminal-existing-remove-button',
    );
    expect(button.textContent).toBe('移除');

    fireEvent.click(button);
    expect(screen.queryByTestId('page-sandbox-detail-terminal-remove-confirm')).toBeNull();
    await waitFor(() => expect(mocks.deleteTerminalSession).toHaveBeenCalledWith('sess-exited'));
    await waitFor(() =>
      expect(screen.queryByTestId('page-sandbox-detail-terminal-existing-item')).toBeNull(),
    );
  });

  it('删除失败：把后端的 detail 原样展示出来', async () => {
    mocks.listTerminalSessions.mockResolvedValue([
      makeRecord({ session_id: 'sess-gone', state: 'exited', exit_code: 0 }),
    ]);
    mocks.deleteTerminalSession.mockRejectedValue(
      new Error('终端会话不存在或已失效：sess-gone'),
    );

    render(<TerminalPanel sandboxName="demo" sandboxRunning />);

    const item = await screen.findByTestId('page-sandbox-detail-terminal-existing-item');
    fireEvent.click(
      within(item).getByTestId('page-sandbox-detail-terminal-existing-remove-button'),
    );

    const banner = await screen.findByTestId('page-sandbox-detail-terminal-error');
    expect(banner.textContent).toContain('终端会话不存在或已失效：sess-gone');
    // 失败时列表项还在：用户还能重试
    expect(screen.getByTestId('page-sandbox-detail-terminal-existing-item')).toBeTruthy();
  });

  it('标签上的关闭动作：删成功后标签消失', async () => {
    mocks.listTerminalSessions.mockResolvedValue([]);
    mocks.createTerminalSession.mockResolvedValue({
      session_id: 'sess-tab',
      sandbox: 'demo',
      container_name: 'sandbox-demo',
      cols: 80,
      rows: 24,
      state: 'running',
      created_at: '2026-10-30T01:00:00+00:00',
    });
    mocks.deleteTerminalSession.mockResolvedValue({
      session_id: 'sess-tab',
      state: 'running',
      closed: true,
      removed: true,
    });

    render(<TerminalPanel sandboxName="demo" sandboxRunning />);

    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-new-button'));
    const tab = await screen.findByTestId('page-sandbox-detail-terminal-tab');
    const removeButton = within(tab).getByTestId('page-sandbox-detail-terminal-tab-remove-button');
    expect(removeButton.textContent).toBe('关闭');

    fireEvent.click(removeButton);
    fireEvent.click(screen.getByTestId('page-sandbox-detail-terminal-remove-confirm-button'));
    await waitFor(() => expect(mocks.deleteTerminalSession).toHaveBeenCalledWith('sess-tab'));
    await waitFor(() =>
      expect(screen.queryByTestId('page-sandbox-detail-terminal-tab')).toBeNull(),
    );
  });
});
