/**
 * 终端面板「当前选中会话」解析的单元测试。
 *
 * 口径：路由会话在表里就用它；会话表不可信（首轮还没读到 / 这一轮读失败）
 * 就沿用上一轮；表是权威的且路由会话真消失，则回落一次到第一个标签并同步
 * 回路由；一个标签都没有就是 null。
 */

import { describe, expect, it } from 'vitest';

import { resolveActiveSession } from './terminal-active';

describe('终端选中会话的解析', () => {
  it('路由指定的会话在表里：直接用它', () => {
    const result = resolveActiveSession({
      routeSessionId: 'sess-b',
      tableSessionIds: ['sess-a', 'sess-b'],
      lastActiveId: 'sess-a',
      refreshState: 'ok',
    });
    expect(result).toEqual({ activeId: 'sess-b', syncRoute: false });
  });

  it('刷新失败且路由会话不在表里：沿用上一轮选中的会话，不跳走', () => {
    const result = resolveActiveSession({
      routeSessionId: 'sess-gone',
      tableSessionIds: ['sess-a', 'sess-b'],
      lastActiveId: 'sess-b',
      refreshState: 'failed',
    });
    expect(result).toEqual({ activeId: 'sess-b', syncRoute: false });
  });

  it('刷新失败且没有上一轮选中：退到第一个标签', () => {
    const result = resolveActiveSession({
      routeSessionId: 'sess-gone',
      tableSessionIds: ['sess-a', 'sess-b'],
      lastActiveId: null,
      refreshState: 'failed',
    });
    expect(result).toEqual({ activeId: 'sess-a', syncRoute: false });
  });

  it('首轮会话表还没读到：不改路由（不能把地址栏里的会话抹掉）', () => {
    const result = resolveActiveSession({
      routeSessionId: 'sess-b',
      tableSessionIds: [],
      lastActiveId: null,
      refreshState: 'pending',
    });
    expect(result).toEqual({ activeId: null, syncRoute: false });
  });

  it('刷新成功且路由会话真消失：回落一次并同步回路由', () => {
    const result = resolveActiveSession({
      routeSessionId: 'sess-gone',
      tableSessionIds: ['sess-a', 'sess-b'],
      lastActiveId: 'sess-gone',
      refreshState: 'ok',
    });
    expect(result.activeId).toBe('sess-a');
    expect(result.syncRoute).toBe(true);
  });

  it('回落目标是第一个标签', () => {
    const result = resolveActiveSession({
      routeSessionId: 'sess-gone',
      tableSessionIds: ['sess-b', 'sess-a'],
      lastActiveId: 'sess-gone',
      refreshState: 'ok',
    });
    expect(result.activeId).toBe('sess-b');
  });

  it('路由没指定会话：表里有就选第一个，不动路由', () => {
    const result = resolveActiveSession({
      routeSessionId: null,
      tableSessionIds: ['sess-a', 'sess-b'],
      lastActiveId: null,
      refreshState: 'ok',
    });
    expect(result).toEqual({ activeId: 'sess-a', syncRoute: false });
  });

  it('一个标签都没有：没有选中会话（null）', () => {
    const result = resolveActiveSession({
      routeSessionId: 'sess-gone',
      tableSessionIds: [],
      lastActiveId: 'sess-gone',
      refreshState: 'ok',
    });
    expect(result.activeId).toBeNull();
    // 会话确实没了：路由要跟着清掉。
    expect(result.syncRoute).toBe(true);
  });
});
