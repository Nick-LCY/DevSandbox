import { describe, expect, it } from 'vitest';

import {
  CLOSE_CODE_UNKNOWN_SESSION,
  encodeResize,
  isSessionInvalidMessage,
  parseTerminalFrame,
  resolveTerminalSocketBase,
  terminalSocketUrl,
  toWebSocketBase,
} from './terminal';

describe('parseTerminalFrame', () => {
  it('解析 hello 帧', () => {
    const frame = parseTerminalFrame(
      JSON.stringify({ type: 'hello', session_id: 'abc', sandbox: 'demo', cols: 100, rows: 30 }),
    );
    expect(frame).toEqual({ type: 'hello', sessionId: 'abc', sandbox: 'demo', cols: 100, rows: 30 });
  });

  it('解析 exit 帧（带结束原因）', () => {
    const frame = parseTerminalFrame(
      JSON.stringify({ type: 'exit', code: -1, reason: 'closed_by_user' }),
    );
    expect(frame).toEqual({ type: 'exit', code: -1, reason: 'closed_by_user' });
  });

  it('解析 exit 帧（服务端没带原因）：原因为 null', () => {
    const frame = parseTerminalFrame(JSON.stringify({ type: 'exit', code: 0 }));
    expect(frame).toEqual({ type: 'exit', code: 0, reason: null });
  });

  it('解析 error 帧', () => {
    const frame = parseTerminalFrame(JSON.stringify({ type: 'error', message: '窗口大小参数非法' }));
    expect(frame).toEqual({ type: 'error', message: '窗口大小参数非法' });
  });

  it('非法 JSON 不抛异常，归为未知帧', () => {
    const frame = parseTerminalFrame('不是 JSON');
    expect(frame.type).toBe('unknown');
  });

  it('非对象载荷归为未知帧', () => {
    expect(parseTerminalFrame('123').type).toBe('unknown');
  });
});

describe('encodeResize', () => {
  it('生成窗口大小同步帧', () => {
    expect(encodeResize(80, 24)).toBe('{"type":"resize","cols":80,"rows":24}');
  });
});

describe('terminalSocketUrl', () => {
  /** 同源推导的输入（web 形态）。 */
  const sameOrigin = {
    baseUrl: '',
    origin: { protocol: 'http:', host: '127.0.0.1:8000' },
  };

  it('http 页面走 ws', () => {
    expect(terminalSocketUrl('sid', sameOrigin)).toBe(
      'ws://127.0.0.1:8000/api/terminal/sessions/sid',
    );
  });

  it('https 页面走 wss', () => {
    expect(
      terminalSocketUrl('sid', {
        baseUrl: '',
        origin: { protocol: 'https:', host: 'sandbox.example:8443' },
      }),
    ).toBe('wss://sandbox.example:8443/api/terminal/sessions/sid');
  });

  it('会话标识做百分号编码', () => {
    expect(terminalSocketUrl('a b', sameOrigin)).toBe(
      'ws://127.0.0.1:8000/api/terminal/sessions/a%20b',
    );
  });

  it('基址非空时从基址推导：http→ws', () => {
    expect(
      terminalSocketUrl('sid', {
        baseUrl: 'http://10.0.0.5:8000',
        origin: { protocol: 'http:', host: 'tauri.localhost' },
      }),
    ).toBe('ws://10.0.0.5:8000/api/terminal/sessions/sid');
  });

  it('基址非空时从基址推导：https→wss', () => {
    expect(
      terminalSocketUrl('sid', {
        baseUrl: 'https://sandbox.example',
        origin: { protocol: 'http:', host: 'tauri.localhost' },
      }),
    ).toBe('wss://sandbox.example/api/terminal/sessions/sid');
  });

  it('基址带尾部斜杠时归一', () => {
    expect(
      terminalSocketUrl('sid', {
        baseUrl: 'http://10.0.0.5:8000/',
        origin: { protocol: 'http:', host: 'tauri.localhost' },
      }),
    ).toBe('ws://10.0.0.5:8000/api/terminal/sessions/sid');
  });

  it('基址非空但推导不出来：不回落同源，直接给 null（连错地址不能猜）', () => {
    // ftp:// 推不出 ws/wss：宁可报「连接地址非法」，也不要连到页面同源去。
    expect(
      terminalSocketUrl('sid', {
        baseUrl: 'ftp://10.0.0.5',
        origin: { protocol: 'http:', host: 'tauri.localhost' },
      }),
    ).toBeNull();
    expect(
      terminalSocketUrl('sid', {
        baseUrl: '不是地址',
        origin: { protocol: 'http:', host: 'tauri.localhost' },
      }),
    ).toBeNull();
  });

  it('票据拼在 URL 上（?ticket=）', () => {
    expect(terminalSocketUrl('sid', sameOrigin, 'sbxt_abc')).toBe(
      'ws://127.0.0.1:8000/api/terminal/sessions/sid?ticket=sbxt_abc',
    );
  });

  it('票据做百分号编码', () => {
    expect(terminalSocketUrl('sid', sameOrigin, 'a b')).toBe(
      'ws://127.0.0.1:8000/api/terminal/sessions/sid?ticket=a%20b',
    );
  });

  it('没有票据时不带查询串', () => {
    expect(terminalSocketUrl('sid', sameOrigin)).not.toContain('?');
  });
});

describe('toWebSocketBase', () => {
  it('空基址返回 null（调用方回落到同源推导）', () => {
    expect(toWebSocketBase('')).toBeNull();
    expect(toWebSocketBase('   ')).toBeNull();
  });

  it('http→ws、https→wss', () => {
    expect(toWebSocketBase('http://h:1')).toBe('ws://h:1');
    expect(toWebSocketBase('https://h')).toBe('wss://h');
  });

  it('已经是 ws/wss 时原样保留', () => {
    expect(toWebSocketBase('ws://h:1')).toBe('ws://h:1');
    expect(toWebSocketBase('wss://h')).toBe('wss://h');
  });

  it('不保留基址里的路径（与 HTTP 侧口径一致：基址只到端口）', () => {
    expect(toWebSocketBase('http://h:1/console')).toBe('ws://h:1');
    expect(toWebSocketBase('https://h/console/')).toBe('wss://h');
  });

  it('解析不了 / 不认识的 scheme 返回 null', () => {
    expect(toWebSocketBase('不是地址')).toBeNull();
    expect(toWebSocketBase('ftp://h')).toBeNull();
  });
});

describe('resolveTerminalSocketBase', () => {
  it('基址为空：按页面位置推导（同源）', () => {
    const resolved = resolveTerminalSocketBase({
      baseUrl: '',
      origin: { protocol: 'https:', host: 'h:1' },
    });
    expect(resolved).toEqual({ ok: true, base: 'wss://h:1' });
  });

  it('基址非空：按基址推导', () => {
    const resolved = resolveTerminalSocketBase({
      baseUrl: 'http://10.0.0.5:8000',
      origin: { protocol: 'http:', host: 'tauri.localhost' },
    });
    expect(resolved).toEqual({ ok: true, base: 'ws://10.0.0.5:8000' });
  });

  it('基址非空但推导失败：明确报「基址非法」，不回落同源', () => {
    const resolved = resolveTerminalSocketBase({
      baseUrl: 'ftp://10.0.0.5',
      origin: { protocol: 'http:', host: 'tauri.localhost' },
    });
    expect(resolved).toEqual({ ok: false, reason: 'invalid-base' });
  });

  it('页面位置不可用（同源推导不出来）：明确报「页面位置不可用」', () => {
    const resolved = resolveTerminalSocketBase({
      baseUrl: '',
      origin: { protocol: '', host: '' },
    });
    expect(resolved).toEqual({ ok: false, reason: 'invalid-origin' });
  });
});

describe('isSessionInvalidMessage', () => {
  it('识别会话失效文案', () => {
    expect(isSessionInvalidMessage('终端会话不存在或已失效，请新建会话')).toBe(true);
    expect(isSessionInvalidMessage('窗口大小参数非法')).toBe(false);
  });

  it('失效关闭码固定为 1008', () => {
    expect(CLOSE_CODE_UNKNOWN_SESSION).toBe(1008);
  });
});
