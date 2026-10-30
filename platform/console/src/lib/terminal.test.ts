import { describe, expect, it } from 'vitest';

import {
  CLOSE_CODE_UNKNOWN_SESSION,
  encodeResize,
  isSessionInvalidMessage,
  parseTerminalFrame,
  terminalSocketUrl,
} from './terminal';

describe('parseTerminalFrame', () => {
  it('解析 hello 帧', () => {
    const frame = parseTerminalFrame(
      JSON.stringify({ type: 'hello', session_id: 'abc', sandbox: 'demo', cols: 100, rows: 30 }),
    );
    expect(frame).toEqual({ type: 'hello', sessionId: 'abc', sandbox: 'demo', cols: 100, rows: 30 });
  });

  it('解析 exit 帧', () => {
    const frame = parseTerminalFrame(JSON.stringify({ type: 'exit', code: 0 }));
    expect(frame).toEqual({ type: 'exit', code: 0 });
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
  it('http 页面走 ws', () => {
    expect(terminalSocketUrl('sid', { protocol: 'http:', host: '127.0.0.1:8000' })).toBe(
      'ws://127.0.0.1:8000/api/terminal/sessions/sid',
    );
  });

  it('https 页面走 wss', () => {
    expect(terminalSocketUrl('sid', { protocol: 'https:', host: 'sandbox.example:8443' })).toBe(
      'wss://sandbox.example:8443/api/terminal/sessions/sid',
    );
  });

  it('会话标识做百分号编码', () => {
    expect(terminalSocketUrl('a b', { protocol: 'http:', host: 'h:1' })).toBe(
      'ws://h:1/api/terminal/sessions/a%20b',
    );
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
