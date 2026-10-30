import { describe, expect, it } from 'vitest';

import { parseRoute, routeToHash, sandboxHash } from './router';

describe('parseRoute', () => {
  it('空地址落到工作台', () => {
    expect(parseRoute('')).toEqual({ name: 'workbench' });
    expect(parseRoute('#/')).toEqual({ name: 'workbench' });
  });

  it('旧四页地址与未知地址都落到工作台', () => {
    expect(parseRoute('#/new')).toEqual({ name: 'workbench' });
    expect(parseRoute('#/settings')).toEqual({ name: 'workbench' });
    expect(parseRoute('#/unknown/path')).toEqual({ name: 'workbench' });
    expect(parseRoute('#/sandboxes')).toEqual({ name: 'workbench' });
    expect(parseRoute('#/sandboxes/demo-01/extra/parts')).toEqual({ name: 'workbench' });
  });

  it('带沙箱名：没有终端标签', () => {
    expect(parseRoute('#/sandboxes/demo-01')).toEqual({
      name: 'workbench-sandbox',
      sandboxName: 'demo-01',
      sessionId: null,
    });
  });

  it('带沙箱名与终端会话标识', () => {
    expect(parseRoute('#/sandboxes/demo-01/sess-42')).toEqual({
      name: 'workbench-sandbox',
      sandboxName: 'demo-01',
      sessionId: 'sess-42',
    });
  });

  it('名字与会话标识里的百分号编码会被解开', () => {
    expect(parseRoute('#/sandboxes/a%2Fb')).toEqual({
      name: 'workbench-sandbox',
      sandboxName: 'a/b',
      sessionId: null,
    });
    expect(parseRoute('#/sandboxes/demo/ses%2F1')).toEqual({
      name: 'workbench-sandbox',
      sandboxName: 'demo',
      sessionId: 'ses/1',
    });
  });

  it('畸形百分号编码不会抛异常，退回工作台', () => {
    // decodeURIComponent('%') 抛 URIError；解析路由的调用栈直通 React 渲染，
    // 抛出去就是整站白屏。
    expect(() => parseRoute('#/sandboxes/%')).not.toThrow();
    expect(parseRoute('#/sandboxes/%')).toEqual({ name: 'workbench' });
    expect(parseRoute('#/sandboxes/%E4%B8%AD%E6%96')).toEqual({ name: 'workbench' });
    expect(parseRoute('#/sandboxes/a%zz')).toEqual({ name: 'workbench' });
    expect(parseRoute('#/sandboxes/demo/%')).toEqual({ name: 'workbench' });
    expect(parseRoute('#/sandboxes/demo/a%zz')).toEqual({ name: 'workbench' });
  });
});

describe('routeToHash', () => {
  it('路由与哈希一一对应', () => {
    expect(routeToHash({ name: 'workbench' })).toBe('#/');
    expect(
      routeToHash({ name: 'workbench-sandbox', sandboxName: 'demo-01', sessionId: null }),
    ).toBe('#/sandboxes/demo-01');
    expect(
      routeToHash({ name: 'workbench-sandbox', sandboxName: 'demo-01', sessionId: 's1' }),
    ).toBe('#/sandboxes/demo-01/s1');
  });

  it('会话标识为空串时按「没有标签」处理', () => {
    expect(
      routeToHash({ name: 'workbench-sandbox', sandboxName: 'demo-01', sessionId: '' }),
    ).toBe('#/sandboxes/demo-01');
  });
});

describe('sandboxHash', () => {
  it('不带会话标识时就是沙箱地址', () => {
    expect(sandboxHash('demo_01')).toBe('#/sandboxes/demo_01');
  });

  it('传 null 与不传等价', () => {
    expect(sandboxHash('demo_01', null)).toBe(sandboxHash('demo_01'));
    expect(sandboxHash('demo_01', null)).toBe('#/sandboxes/demo_01');
  });

  it('带会话标识时拼上第三段', () => {
    expect(sandboxHash('demo_01', 'sess-1')).toBe('#/sandboxes/demo_01/sess-1');
  });

  it('与 parseRoute 互为逆运算', () => {
    expect(parseRoute(sandboxHash('demo_01'))).toEqual({
      name: 'workbench-sandbox',
      sandboxName: 'demo_01',
      sessionId: null,
    });
    expect(parseRoute(sandboxHash('demo_01', 'sess-1'))).toEqual({
      name: 'workbench-sandbox',
      sandboxName: 'demo_01',
      sessionId: 'sess-1',
    });
  });

  it('名字里的特殊字符会被编码后再解析回来', () => {
    const hash = sandboxHash('a/b c');
    expect(hash).toBe('#/sandboxes/a%2Fb%20c');
    expect(parseRoute(hash)).toEqual({
      name: 'workbench-sandbox',
      sandboxName: 'a/b c',
      sessionId: null,
    });
  });
});
