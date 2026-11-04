/**
 * 端口转发的纯逻辑单测。
 *
 * 覆盖三条口径：
 * - **本机端口校验**：非空、纯数字、`1~65535`；**低端口（<1024）不拦**
 *   （能不能绑由操作系统说了算，绑不上时桌面端明确报错）；
 * - **映射文案**：容器端口 → 本机端口；
 * - **状态文案与本机地址拼接**：四色语义 + `http://127.0.0.1:<port>`。
 */

import { describe, expect, it } from 'vitest';

import {
  LOCAL_FORWARD_HOST,
  PORT_MAX,
  PORT_MIN,
  describeListenerStarted,
  forwardMappingLabel,
  forwardStateLabel,
  listenerBadgeState,
  listenerStateLabel,
  listenerTone,
  listenerToneClass,
  localForwardUrl,
  parsePort,
  validatePort,
} from './port-forward';

describe('本机端口校验', () => {
  it('空值非法（不可为空）', () => {
    expect(validatePort('')).not.toBe('');
    expect(validatePort('   ')).not.toBe('');
    expect(validatePort('', '本机端口')).toBe('请填写本机端口');
  });

  it('非数字非法', () => {
    expect(validatePort('abc')).toBe('端口只能是数字');
    expect(validatePort('80.5')).toBe('端口只能是数字');
    expect(validatePort('-1')).toBe('端口只能是数字');
    expect(validatePort('80a')).toBe('端口只能是数字');
  });

  it('超范围非法', () => {
    expect(validatePort('0')).toBe(`端口必须在 ${PORT_MIN}~${PORT_MAX} 之间`);
    expect(validatePort('65536')).toBe(`端口必须在 ${PORT_MIN}~${PORT_MAX} 之间`);
    expect(validatePort('99999')).toBe(`端口必须在 ${PORT_MIN}~${PORT_MAX} 之间`);
  });

  it('边界值合法', () => {
    expect(validatePort('1')).toBe('');
    expect(validatePort('65535')).toBe('');
  });

  it('低端口（<1024）允许（能不能绑由操作系统说了算）', () => {
    expect(validatePort('80')).toBe('');
    expect(validatePort('443')).toBe('');
  });

  it('带空白的输入按去空白后的值判', () => {
    expect(validatePort('  8080  ')).toBe('');
    expect(parsePort('  8080  ')).toBe(8080);
  });
});

describe('端口解析', () => {
  it('合法端口解析成数字', () => {
    expect(parsePort('8080')).toBe(8080);
    expect(parsePort('1')).toBe(1);
    expect(parsePort('65535')).toBe(65535);
  });

  it('非法端口解析成 null', () => {
    expect(parsePort('')).toBeNull();
    expect(parsePort('abc')).toBeNull();
    expect(parsePort('0')).toBeNull();
    expect(parsePort('65536')).toBeNull();
    expect(parsePort('80.5')).toBeNull();
  });
});

describe('映射文案与本机地址', () => {
  it('容器端口 → 本机端口', () => {
    expect(forwardMappingLabel(8080, 18000)).toBe('8080 → 18000');
    expect(forwardMappingLabel(8080, 8080)).toBe('8080 → 8080');
  });

  it('本机端口还没开启时显示占位符', () => {
    expect(forwardMappingLabel(8080, null)).toBe('8080 → —');
  });

  it('本机地址只指回环', () => {
    expect(localForwardUrl(8080)).toBe(`http://${LOCAL_FORWARD_HOST}:8080`);
    expect(LOCAL_FORWARD_HOST).toBe('127.0.0.1');
  });
});

describe('状态文案', () => {
  it('后端转发记录状态', () => {
    expect(forwardStateLabel('running')).toBe('可用');
    expect(forwardStateLabel('stopped')).toBe('已停止');
    expect(forwardStateLabel('别的')).toBe('未知');
  });

  it('本机监听状态', () => {
    expect(listenerStateLabel('listening')).toBe('监听中');
    expect(listenerStateLabel('stopped')).toBe('未开启');
    expect(listenerStateLabel('error')).toBe('失败');
  });

  it('状态色只有四种语义', () => {
    expect(listenerTone('listening')).toBe('running');
    expect(listenerTone('starting')).toBe('busy');
    expect(listenerTone('stopped')).toBe('stopped');
    expect(listenerTone('error')).toBe('failed');
    expect(listenerTone('别的')).toBe('stopped');
    // 四种语义对应四种状态色类名（不写裸色值）。
    expect(listenerToneClass('running')).toBe('text-status-running');
    expect(listenerToneClass('busy')).toContain('text-status-busy');
    expect(listenerToneClass('stopped')).toBe('text-status-stopped');
    expect(listenerToneClass('failed')).toBe('text-status-failed');
  });
});

describe('开启本机监听后的提示文案', () => {  it('端口没被占时给本机地址', () => {
    expect(describeListenerStarted(8080, 8080)).toBe('本机监听已开启：http://127.0.0.1:8080');
  });

  it('端口被占自动换掉时说清楚实际端口', () => {
    const text = describeListenerStarted(8080, 18000);
    expect(text).toContain('8080');
    expect(text).toContain('18000');
    expect(text).toContain('http://127.0.0.1:18000');
  });
});

describe('本机监听徽标的状态（颜色与文字同源）', () => {
  it('徽标只表达本机监听语义，不带后端记录的状态', () => {
    // 未开启 → 灰。
    expect(listenerBadgeState({ starting: false, listening: false, failed: false })).toBe('stopped');
    // 开启中 → 琥珀（脉动）。
    expect(listenerBadgeState({ starting: true, listening: false, failed: false })).toBe('starting');
    // 监听中 → 绿。
    expect(listenerBadgeState({ starting: false, listening: true, failed: false })).toBe('listening');
    // 开启失败 → 红。
    expect(listenerBadgeState({ starting: false, listening: false, failed: true })).toBe('error');
  });

  it('监听中优先于失败（隧道失败时监听器还在）', () => {
    expect(listenerBadgeState({ starting: false, listening: true, failed: true })).toBe('listening');
  });

  it('开启中优先于其它（正在绑端口时不是「未开启」）', () => {
    expect(listenerBadgeState({ starting: true, listening: false, failed: true })).toBe('starting');
  });

  it('徽标状态接得上既有的四色与文案分支', () => {
    expect(listenerTone(listenerBadgeState({ starting: false, listening: true, failed: false }))).toBe(
      'running',
    );
    expect(listenerToneClass(listenerTone('starting'))).toContain('animate-status-pulse');
    expect(listenerStateLabel(listenerBadgeState({ starting: false, listening: false, failed: false }))).toBe(
      '未开启',
    );
  });
});
