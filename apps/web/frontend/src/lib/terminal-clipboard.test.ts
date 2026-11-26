import { describe, expect, it, vi } from 'vitest';

import {
  OSC52_MAX_BYTES,
  OSC52_MAX_BASE64_LENGTH,
  buildOsc52Response,
  decodeOsc52Base64,
  decodeOsc52Text,
  encodeOsc52Text,
  parseOsc52Payload,
} from './terminal-clipboard';

describe('OSC 52 参数解析', () => {
  it('兼容 xterm 参数形态与完整形态', () => {
    expect(parseOsc52Payload('c;SGVsbG8=')).toEqual({
      selection: 'c',
      operation: 'set',
      data: 'SGVsbG8=',
    });
    expect(parseOsc52Payload('52;c;SGVsbG8=')).toEqual({
      selection: 'c',
      operation: 'set',
      data: 'SGVsbG8=',
    });
    expect(parseOsc52Payload('c;?')).toEqual({ selection: 'c', operation: 'query', data: null });
  });

  it('保留 p / s / cut buffer 选择区供调用方忽略', () => {
    expect(parseOsc52Payload('p;SGVsbG8=')?.selection).toBe('p');
    expect(parseOsc52Payload('s;SGVsbG8=')?.selection).toBe('s');
    expect(parseOsc52Payload('0;SGVsbG8=')?.selection).toBe('0');
    expect(parseOsc52Payload('c')).toBeNull();
  });
});

describe('OSC 52 base64 与 UTF-8', () => {
  it('支持空数据与 UTF-8 往返', () => {
    expect(decodeOsc52Text('')).toBe('');
    const text = '剪贴板 — terminal';
    expect(decodeOsc52Text(encodeOsc52Text(text)!)).toBe(text);
  });

  it('拒绝非法字符、错误 padding 与错误长度', () => {
    for (const value of ['not base64!', 'SGVsbG8', 'SGVsbG8===', 'A===', 'ab=c', 'Zh==']) {
      expect(decodeOsc52Base64(value)).toBeNull();
    }
  });

  it('超过 base64 预检阈值时立即拒绝且不调用 atob', () => {
    const overPrecheckLimit = 'A'.repeat(OSC52_MAX_BASE64_LENGTH + 4);
    const atobSpy = vi.spyOn(globalThis, 'atob');

    expect(decodeOsc52Base64(overPrecheckLimit)).toBeNull();
    expect(atobSpy).not.toHaveBeenCalled();
    atobSpy.mockRestore();
  });

  it('接受 64 KiB 边界并拒绝超限', () => {
    const atLimit = 'a'.repeat(OSC52_MAX_BYTES);
    const overLimit = `${atLimit}a`;
    expect(encodeOsc52Text(atLimit)).not.toBeNull();
    expect(encodeOsc52Text(overLimit)).toBeNull();
    expect(decodeOsc52Text(encodeOsc52Text(atLimit)!)).toBe(atLimit);
  });
});

describe('OSC 52 响应帧', () => {
  it('精确构造 ESC ] 52 ; c ; base64 BEL', () => {
    expect(buildOsc52Response('hello')).toBe('\u001b]52;c;aGVsbG8=\u0007');
    expect(buildOsc52Response('')).toBe('\u001b]52;c;\u0007');
  });
});
