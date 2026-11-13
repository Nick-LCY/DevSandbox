import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CURRENT_DIR_KEY,
  OSC_CURRENT_DIR_IDENT,
  clearSessionPwd,
  getSessionPwd,
  parseCurrentDirPayload,
  setSessionPwd,
  subscribeSessionPwd,
} from './terminal-pwd';

/**
 * 01 打样轮在**真沙箱**里捕获到的 OSC 序列字节（`xxd` 实测，原样照抄）：
 *
 * ```
 * 1b 5d 31 33 33 37 3b 43 75 72 72 65 6e 74 44 69 72 3d 2f 77 6f 72 6b 73 70 61 63 65 07
 * └ ESC └ ]  └ "1337"  └ ;  └ "CurrentDir"  └ =  └ "/workspace"        └ BEL
 * ```
 *
 * 即 `ESC ] 1337 ; CurrentDir = /workspace BEL`（**BEL 终止**，不是 `ESC \`）。
 */
const REAL_OSC_BYTES = [
  0x1b, 0x5d, 0x31, 0x33, 0x33, 0x37, 0x3b, 0x43, 0x75, 0x72, 0x72, 0x65, 0x6e, 0x74,
  0x44, 0x69, 0x72, 0x3d, 0x2f, 0x77, 0x6f, 0x72, 0x6b, 0x73, 0x70, 0x61, 0x63, 0x65, 0x07,
];

/** 真实字节序列（转成 JS 字符串常量）。 */
const REAL_OSC_SEQUENCE = String.fromCharCode(...REAL_OSC_BYTES);

/** 真实序列去掉 `ESC ]` 与 BEL 之后剩下的部分（= 带标识符的载荷形态）。 */
const REAL_OSC_PAYLOAD_WITH_IDENT = REAL_OSC_SEQUENCE.slice(2, -1);

describe('parseCurrentDirPayload（真实字节）', () => {
  it('真实捕获的字节序列：带标识符的载荷解析出 /workspace', () => {
    expect(REAL_OSC_PAYLOAD_WITH_IDENT).toBe('1337;CurrentDir=/workspace');
    expect(parseCurrentDirPayload(REAL_OSC_PAYLOAD_WITH_IDENT)).toBe('/workspace');
  });

  it('真实捕获的字节序列：xterm 回调形态（标识符已被吃掉）同样解析出 /workspace', () => {
    // xterm 的 registerOscHandler(1337, cb) 送到回调的是「去掉 ESC ]、标识符、
    // 分隔符与终结符之后」的载荷（01 轮实测）。
    const payload = REAL_OSC_PAYLOAD_WITH_IDENT.slice('1337;'.length);
    expect(payload).toBe('CurrentDir=/workspace');
    expect(parseCurrentDirPayload(payload)).toBe('/workspace');
  });

  it('真实捕获的字节序列里确实含 ESC ] 与 BEL 终结符', () => {
    expect(REAL_OSC_SEQUENCE.startsWith('\u001b]')).toBe(true);
    expect(REAL_OSC_SEQUENCE.endsWith('\u0007')).toBe(true);
    expect(OSC_CURRENT_DIR_IDENT).toBe(1337);
  });

  it('容器内 cd 之后的路径（/tmp）同样解析得出', () => {
    expect(parseCurrentDirPayload('CurrentDir=/tmp')).toBe('/tmp');
    expect(parseCurrentDirPayload('1337;CurrentDir=/tmp')).toBe('/tmp');
  });
});

describe('parseCurrentDirPayload（前缀与键名）', () => {
  it('非 1337 标识符的载荷不认', () => {
    expect(parseCurrentDirPayload('1338;CurrentDir=/workspace')).toBeNull();
    expect(parseCurrentDirPayload('0;CurrentDir=/workspace')).toBeNull();
  });

  it('键名不对的载荷不认', () => {
    expect(parseCurrentDirPayload('CurrentFile=/workspace')).toBeNull();
    expect(parseCurrentDirPayload('currentdir=/workspace')).toBeNull();
    expect(parseCurrentDirPayload('/workspace')).toBeNull();
  });

  it('只有 CurrentDir= 前缀才认（键名常量与实现一致）', () => {
    expect(CURRENT_DIR_KEY).toBe('CurrentDir=');
    expect(parseCurrentDirPayload(`${CURRENT_DIR_KEY}/workspace`)).toBe('/workspace');
  });
});

describe('parseCurrentDirPayload（路径校验）', () => {
  it('相对路径一律不认', () => {
    expect(parseCurrentDirPayload('CurrentDir=workspace')).toBeNull();
    expect(parseCurrentDirPayload('CurrentDir=./workspace')).toBeNull();
    expect(parseCurrentDirPayload('CurrentDir=../workspace')).toBeNull();
    expect(parseCurrentDirPayload('CurrentDir=workspace/tmp')).toBeNull();
  });

  it('空串不认', () => {
    expect(parseCurrentDirPayload('')).toBeNull();
    expect(parseCurrentDirPayload('   ')).toBeNull();
    expect(parseCurrentDirPayload('CurrentDir=')).toBeNull();
    expect(parseCurrentDirPayload('1337;CurrentDir=')).toBeNull();
  });

  it('多余空白：只剥**前导**空白（协议噪声），尾部不动', () => {
    expect(parseCurrentDirPayload('  CurrentDir=/workspace')).toBe('/workspace');
    expect(parseCurrentDirPayload('\t1337;CurrentDir=/workspace')).toBe('/workspace');
    expect(parseCurrentDirPayload('CurrentDir= /workspace')).toBe('/workspace');
  });

  it('尾部空白是路径的一部分（条目名保真，与 normalizeContainerPath 同口径）', () => {
    // 目录名可能以空格结尾：`/work space ` 与 `/work space` 是两个东西。
    expect(parseCurrentDirPayload('CurrentDir=/work space ')).toBe('/work space ');
    expect(parseCurrentDirPayload('1337;CurrentDir=/work space ')).toBe('/work space ');
    // 带引号的写法（01 轮实测 bash 不剥引号）同样保真。
    expect(parseCurrentDirPayload('CurrentDir="/work space "')).toBe('/work space ');
    // 收尾引号**之后**的空白也是路径的一部分（不因剥引号而丢失）。
    expect(parseCurrentDirPayload('CurrentDir="/workspace" ')).toBe('/workspace ');
  });

  it('路径内部的空格是路径的一部分，不动它', () => {
    expect(parseCurrentDirPayload('CurrentDir=/work space')).toBe('/work space');
  });

  it('首尾成对的引号做一次容错剥离（01 轮实测 bash 不剥引号）', () => {
    expect(parseCurrentDirPayload('CurrentDir="/workspace"')).toBe('/workspace');
    expect(parseCurrentDirPayload("CurrentDir='/workspace'")).toBe('/workspace');
    // 不成对的引号不剥：剥了就变成别的路径。
    expect(parseCurrentDirPayload('CurrentDir="/workspace')).toBeNull();
  });

  it('过一遍既有 normalizeContainerPath：拒 NUL、拒 . 与 .. 段', () => {
    expect(parseCurrentDirPayload('CurrentDir=/work\u0000space')).toBeNull();
    expect(parseCurrentDirPayload('CurrentDir=/workspace/../etc')).toBeNull();
    expect(parseCurrentDirPayload('CurrentDir=/workspace/./tmp')).toBeNull();
  });

  it('多余的斜杠被归一（根目录仍是 /）', () => {
    expect(parseCurrentDirPayload('CurrentDir=/workspace//tmp/')).toBe('/workspace/tmp');
    expect(parseCurrentDirPayload('CurrentDir=/')).toBe('/');
  });
});

describe('会话级 pwd 缓存', () => {
  beforeEach(() => {
    clearSessionPwd('sess-a');
    clearSessionPwd('sess-b');
  });

  it('按会话读写', () => {
    expect(getSessionPwd('sess-a')).toBeNull();
    setSessionPwd('sess-a', '/workspace');
    expect(getSessionPwd('sess-a')).toBe('/workspace');
    // 别的会话不受影响。
    expect(getSessionPwd('sess-b')).toBeNull();
  });

  it('多次触发取最新值（pwd 跟着 cd 实时更新）', () => {
    setSessionPwd('sess-a', '/workspace');
    setSessionPwd('sess-a', '/tmp');
    setSessionPwd('sess-a', '/etc');
    expect(getSessionPwd('sess-a')).toBe('/etc');
  });

  it('非法路径不落缓存', () => {
    setSessionPwd('sess-a', 'relative/path');
    setSessionPwd('sess-a', '/a/../b');
    expect(getSessionPwd('sess-a')).toBeNull();
  });

  it('清理后回到未上报状态', () => {
    setSessionPwd('sess-a', '/workspace');
    clearSessionPwd('sess-a');
    expect(getSessionPwd('sess-a')).toBeNull();
  });

  it('订阅者在 pwd 变化时被通知，退订后不再通知', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionPwd('sess-a', listener);
    setSessionPwd('sess-a', '/workspace');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setSessionPwd('sess-a', '/tmp');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('同一个值重复上报：不通知（shell 每画一次提示符就报一次）', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionPwd('sess-a', listener);
    setSessionPwd('sess-a', '/workspace');
    expect(listener).toHaveBeenCalledTimes(1);
    // 同一条路径连着报：只更新缓存，不通知（避免 04 轮每条命令刷一次目录）。
    setSessionPwd('sess-a', '/workspace');
    setSessionPwd('sess-a', '/workspace');
    expect(listener).toHaveBeenCalledTimes(1);
    // 值变了才通知。
    setSessionPwd('sess-a', '/tmp');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('退订函数重复调用：不会把后来的订阅一起带走', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeSessionPwd('sess-a', first);
    unsubscribeFirst();
    const unsubscribeSecond = subscribeSessionPwd('sess-a', second);
    // 旧的退订函数又跑一遍（组件卸载时重复调用是常见写法）：
    // 不能把后来订阅的 second 一起删掉。
    unsubscribeFirst();
    setSessionPwd('sess-a', '/workspace');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unsubscribeSecond();
  });

  it('监听器抛错不影响 pwd 落库', () => {
    const unsubscribe = subscribeSessionPwd('sess-a', () => {
      throw new Error('监听器炸了');
    });
    setSessionPwd('sess-a', '/workspace');
    expect(getSessionPwd('sess-a')).toBe('/workspace');
    unsubscribe();
  });
});
