import { describe, expect, it } from 'vitest';

import { parseRoute, routeToHash, sandboxDetailHash } from './router';

describe('parseRoute', () => {
  it('空地址落到沙箱列表', () => {
    expect(parseRoute('')).toEqual({ name: 'sandbox-list' });
    expect(parseRoute('#/')).toEqual({ name: 'sandbox-list' });
  });

  it('新建沙箱页', () => {
    expect(parseRoute('#/new')).toEqual({ name: 'sandbox-create' });
  });

  it('设置页', () => {
    expect(parseRoute('#/settings')).toEqual({ name: 'settings' });
  });

  it('沙箱详情页带名字', () => {
    expect(parseRoute('#/sandboxes/demo-01')).toEqual({
      name: 'sandbox-detail',
      sandboxName: 'demo-01',
    });
  });

  it('名字里的百分号编码会被解开', () => {
    expect(parseRoute('#/sandboxes/a%2Fb')).toEqual({
      name: 'sandbox-detail',
      sandboxName: 'a/b',
    });
  });

  it('无法识别的地址落到沙箱列表', () => {
    expect(parseRoute('#/unknown/path')).toEqual({ name: 'sandbox-list' });
  });

  it('畸形百分号编码不会抛异常，退回沙箱列表', () => {
    // decodeURIComponent('%') 抛 URIError；解析路由的调用栈直通 React 渲染，
    // 抛出去就是整站白屏。
    expect(() => parseRoute('#/sandboxes/%')).not.toThrow();
    expect(parseRoute('#/sandboxes/%')).toEqual({ name: 'sandbox-list' });
    expect(parseRoute('#/sandboxes/%E4%B8%AD%E6%96')).toEqual({ name: 'sandbox-list' });
    expect(parseRoute('#/sandboxes/a%zz')).toEqual({ name: 'sandbox-list' });
  });
});

describe('routeToHash', () => {
  it('路由与哈希一一对应', () => {
    expect(routeToHash({ name: 'sandbox-list' })).toBe('#/');
    expect(routeToHash({ name: 'sandbox-create' })).toBe('#/new');
    expect(routeToHash({ name: 'settings' })).toBe('#/settings');
    expect(routeToHash({ name: 'sandbox-detail', sandboxName: 'demo-01' })).toBe(
      '#/sandboxes/demo-01',
    );
  });

  it('详情页地址与路由互为逆运算', () => {
    const hash = sandboxDetailHash('demo_01');
    expect(parseRoute(hash)).toEqual({ name: 'sandbox-detail', sandboxName: 'demo_01' });
  });
});
