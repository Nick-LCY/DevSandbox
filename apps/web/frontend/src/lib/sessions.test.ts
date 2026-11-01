import { describe, expect, it } from 'vitest';

import { SessionNumbering, sortSessionsByCreation } from './sessions';

describe('sortSessionsByCreation', () => {
  it('按创建时间排序：早创建的排前面', () => {
    const sorted = sortSessionsByCreation([
      { session_id: 'sess-c', created_at: '2026-10-30T01:00:10+00:00' },
      { session_id: 'sess-a', created_at: '2026-10-30T01:00:00+00:00' },
      { session_id: 'sess-b', created_at: '2026-10-30T01:00:05+00:00' },
    ]);
    expect(sorted.map((item) => item.session_id)).toEqual(['sess-a', 'sess-b', 'sess-c']);
  });

  it('同一时刻创建的会话按会话标识兜底，顺序稳定', () => {
    const sorted = sortSessionsByCreation([
      { session_id: 'sess-b', created_at: '2026-10-30T01:00:00+00:00' },
      { session_id: 'sess-a', created_at: '2026-10-30T01:00:00+00:00' },
    ]);
    expect(sorted.map((item) => item.session_id)).toEqual(['sess-a', 'sess-b']);
  });

  it('不改动调用方手里的原数组', () => {
    const records = [
      { session_id: 'sess-b', created_at: '2026-10-30T01:00:05+00:00' },
      { session_id: 'sess-a', created_at: '2026-10-30T01:00:00+00:00' },
    ];
    const sorted = sortSessionsByCreation(records);
    expect(records.map((item) => item.session_id)).toEqual(['sess-b', 'sess-a']);
    expect(sorted).not.toBe(records);
  });

  it('创建时间缺失或解析不了时排在最前，其余顺序不受影响', () => {
    const sorted = sortSessionsByCreation([
      { session_id: 'sess-b', created_at: '2026-10-30T01:00:05+00:00' },
      { session_id: 'sess-x', created_at: '' },
      { session_id: 'sess-a', created_at: '2026-10-30T01:00:00+00:00' },
    ]);
    expect(sorted.map((item) => item.session_id)).toEqual(['sess-x', 'sess-a', 'sess-b']);
  });

  it('空列表原样返回', () => {
    expect(sortSessionsByCreation([])).toEqual([]);
  });
});

describe('SessionNumbering', () => {
  it('序号按首次见到的顺序递增分配', () => {
    const numbering = new SessionNumbering();
    expect(numbering.numberOf('sess-a')).toBe(1);
    expect(numbering.numberOf('sess-b')).toBe(2);
    expect(numbering.numberOf('sess-c')).toBe(3);
  });

  it('同一个会话一直给同一个号：关掉中间的标签，其余标签不重排', () => {
    const numbering = new SessionNumbering();
    const a = numbering.numberOf('sess-a');
    const b = numbering.numberOf('sess-b');
    const c = numbering.numberOf('sess-c');

    // sess-b 被关掉：它的号不回收，a 与 c 的号不动。
    expect(numbering.numberOf('sess-a')).toBe(a);
    expect(numbering.numberOf('sess-c')).toBe(c);
    expect(numbering.numberOf('sess-a')).not.toBe(b);
  });

  it('登记过的会话个数只增不减', () => {
    const numbering = new SessionNumbering();
    numbering.numberOf('sess-a');
    numbering.numberOf('sess-b');
    numbering.numberOf('sess-a');
    expect(numbering.size).toBe(2);
  });
});
