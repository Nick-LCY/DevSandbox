/**
 * 终端实例常驻的**口径单测**。
 *
 * 逐条钉死挂载集合的五条口径：
 *
 * ① 会话关闭 ⇒ 掉出挂载集合（实例随之卸载）；
 * ② 激活会话恒在集合里（哪怕它还没被访问过）；
 * ③ 没访问过的会话不挂载（不自动附着用户没点过的会话）；
 * ④ 顺序按会话表（= 标签顺序）；
 * ⑤ `markVisited` 幂等（重复登记不改变结果，也不产生新引用）。
 */

import { describe, expect, it } from 'vitest';

import { markVisited, resolveMountedSessions } from './terminal-residency';

describe('终端实例的常驻口径', () => {
  it('会话关闭 ⇒ 掉出挂载集合', () => {
    const mounted = resolveMountedSessions({
      sessionIds: ['sess-a', 'sess-b'],
      visited: ['sess-a', 'sess-b'],
      activeId: 'sess-a',
    });
    expect(mounted).toEqual(['sess-a', 'sess-b']);

    // 会话 b 被关掉：它不在会话表里了 ⇒ 掉出挂载集合（实例随之卸载）
    const afterClose = resolveMountedSessions({
      sessionIds: ['sess-a'],
      visited: ['sess-a', 'sess-b'],
      activeId: 'sess-a',
    });
    expect(afterClose).toEqual(['sess-a']);
  });

  it('激活会话恒在挂载集合里（哪怕它还没被访问过）', () => {
    const mounted = resolveMountedSessions({
      sessionIds: ['sess-a', 'sess-b'],
      visited: [],
      activeId: 'sess-b',
    });
    expect(mounted).toEqual(['sess-b']);
  });

  it('没访问过的会话不挂载（不自动附着用户没点过的会话）', () => {
    const mounted = resolveMountedSessions({
      sessionIds: ['sess-a', 'sess-b', 'sess-c'],
      visited: ['sess-a'],
      activeId: 'sess-a',
    });
    expect(mounted).toEqual(['sess-a']);
    expect(mounted).not.toContain('sess-b');
    expect(mounted).not.toContain('sess-c');
  });

  it('顺序按会话表（= 标签顺序）', () => {
    const mounted = resolveMountedSessions({
      sessionIds: ['sess-c', 'sess-a', 'sess-b'],
      visited: ['sess-a', 'sess-b', 'sess-c'],
      activeId: 'sess-b',
    });
    // 不是访问顺序，是会话表顺序
    expect(mounted).toEqual(['sess-c', 'sess-a', 'sess-b']);
  });

  it('没有激活会话时：只挂载已访问且还在会话表里的会话', () => {
    const mounted = resolveMountedSessions({
      sessionIds: ['sess-a', 'sess-b'],
      visited: ['sess-a'],
      activeId: null,
    });
    expect(mounted).toEqual(['sess-a']);
  });

  it('激活会话还不在会话表里（会话表这一轮没读到）：照样挂载，排在末尾', () => {
    const mounted = resolveMountedSessions({
      sessionIds: [],
      visited: [],
      activeId: 'sess-late',
    });
    expect(mounted).toEqual(['sess-late']);
  });

  it('markVisited 幂等：重复登记不改变结果，也不产生新引用', () => {
    const once = markVisited([], 'sess-a');
    expect(once).toEqual(['sess-a']);

    const twice = markVisited(once, 'sess-a');
    expect(twice).toEqual(['sess-a']);
    // 同引用 ⇒ setState 会被 bailout 跳过，不会多跑一轮渲染
    expect(twice).toBe(once);

    const third = markVisited(twice, 'sess-b');
    expect(third).toEqual(['sess-a', 'sess-b']);
  });

  it('markVisited 不动原数组（纯函数）', () => {
    const visited = ['sess-a'];
    const next = markVisited(visited, 'sess-b');
    expect(visited).toEqual(['sess-a']);
    expect(next).not.toBe(visited);
  });
});
