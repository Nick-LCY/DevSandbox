/**
 * @vitest-environment jsdom
 *
 * OSC 1337 通道的**集成**验证：真的 `new Terminal()` + `registerOscHandler` +
 * `term.write()`，看解析与缓存是不是真的接上了。
 *
 * 这里刻意**不**手写字节流扫描器——序列边界交给 xterm 的状态机（跨帧拆分那条
 * 用例就是守这条红线：一条序列被拆到两次 write 里，回调只在补齐后触发一次）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';

import {
  OSC_CURRENT_DIR_IDENT,
  clearSessionPwd,
  getSessionPwd,
  parseCurrentDirPayload,
  setSessionPwd,
} from './terminal-pwd';

/**
 * 01 打样轮在真沙箱捕获的**整段原始字节流**（`pwd` / `cd /tmp` / `pwd` / `exit`
 * 四条命令，`^X` 是控制字符的助记写法）：
 *
 * ```
 * ^[[?2004hroot@f6e57104ff19:/workspace# ^[]1337;CurrentDir=/workspace^Gpwd^M
 * ^[[?2004l^M/workspace^M
 * ^[[?2004hroot@f6e57104ff19:/workspace# ^[]1337;CurrentDir=/workspace^Gcd /tmp^M
 * ^[[?2004l^M^[[?2004hroot@f6e57104ff19:/tmp# ^[]1337;CurrentDir=/tmp^Gpwd^M
 * ^[[?2004l^M/tmp^M
 * ^[[?2004hroot@f6e57104ff19:/tmp# ^[]1337;CurrentDir=/tmp^Gexit^M
 * ^[[?2004l^Mexit^M
 * ```
 */
const REAL_CAPTURED_STREAM =
  '\u001b[?2004hroot@f6e57104ff19:/workspace# \u001b]1337;CurrentDir=/workspace\u0007pwd\r' +
  '\u001b[?2004l\r/workspace\r' +
  '\u001b[?2004hroot@f6e57104ff19:/workspace# \u001b]1337;CurrentDir=/workspace\u0007cd /tmp\r' +
  '\u001b[?2004l\r\u001b[?2004hroot@f6e57104ff19:/tmp# \u001b]1337;CurrentDir=/tmp\u0007pwd\r' +
  '\u001b[?2004l\r/tmp\r' +
  '\u001b[?2004hroot@f6e57104ff19:/tmp# \u001b]1337;CurrentDir=/tmp\u0007exit\r' +
  '\u001b[?2004l\rexit\r';

/** 写进终端并等它解析完（xterm 的 write 是异步的，回调在解析完成后触发）。 */
function write(term: Terminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    term.write(data, resolve);
  });
}

/** 本文件建过的全部终端：afterEach 统一销毁（省得每条用例都记得 dispose）。 */
const createdTerms: Terminal[] = [];

/**
 * 按 TerminalView 的接线方式建一个终端：注册 OSC 1337 处理器，解析成功就写进缓存。
 *
 * @returns 终端实例、收到的原始载荷列表。
 */
function createTerminal(sessionId: string): { term: Terminal; payloads: string[] } {
  const term = new Terminal({ allowProposedApi: true });
  createdTerms.push(term);
  const payloads: string[] = [];
  term.parser.registerOscHandler(OSC_CURRENT_DIR_IDENT, (payload) => {
    payloads.push(payload);
    const path = parseCurrentDirPayload(payload);
    if (path === null) {
      // 不认识的载荷 / 非法路径：静默忽略（dash / sh 会话根本不上报，不该报错）。
      return false;
    }
    setSessionPwd(sessionId, path);
    return true;
  });
  return { term, payloads };
}

describe('OSC 1337 与 xterm 的接线', () => {
  beforeEach(() => {
    clearSessionPwd('sess-integration');
  });

  // 终端实例统一在这里销毁：用例里不用各写一遍 dispose。
  afterEach(() => {
    while (createdTerms.length > 0) {
      createdTerms.pop()?.dispose();
    }
  });

  it('真实捕获的字节流：解析出的路径与容器内 pwd 一致，缓存取最新值', async () => {
    const { term, payloads } = createTerminal('sess-integration');
    await write(term, REAL_CAPTURED_STREAM);

    // 回调收到的载荷：标识符已被 xterm 吃掉（01 轮实测口径）。
    expect(payloads).toEqual([
      'CurrentDir=/workspace',
      'CurrentDir=/workspace',
      'CurrentDir=/tmp',
      'CurrentDir=/tmp',
    ]);
    // 缓存里是最后一条（cd /tmp 之后的上报）。
    expect(getSessionPwd('sess-integration')).toBe('/tmp');
  });

  it('一条 OSC 序列被拆到两次 write：回调只在补齐后触发一次', async () => {
    const { term, payloads } = createTerminal('sess-integration');
    await write(term, '\u001b]1337;CurrentDir=/wor');
    // 半条序列：xterm 的状态机还在等，**回调不该触发**。
    expect(payloads).toEqual([]);
    expect(getSessionPwd('sess-integration')).toBeNull();

    await write(term, 'kspace\u0007');
    expect(payloads).toEqual(['CurrentDir=/workspace']);
    expect(getSessionPwd('sess-integration')).toBe('/workspace');
  });

  it('没有 OSC 的会话（dash / sh）：不上报、不报错、缓存保持空', async () => {
    const { term, payloads } = createTerminal('sess-integration');
    await write(term, '\u001b[?2004h# pwd\r\n/workspace\r\n\u001b[?2004l');
    expect(payloads).toEqual([]);
    expect(getSessionPwd('sess-integration')).toBeNull();
  });

  it('别的 OSC 标识符不误触发 1337 通道', async () => {
    const { term, payloads } = createTerminal('sess-integration');
    // OSC 0 = 改窗口标题；OSC 1338 = 别的标识符。
    await write(term, '\u001b]0;窗口标题\u0007\u001b]1338;CurrentDir=/workspace\u0007');
    expect(payloads).toEqual([]);
    expect(getSessionPwd('sess-integration')).toBeNull();
  });

  it('载荷里的路径非法时：回调照常触发，但缓存不落脏值', async () => {
    const { term, payloads } = createTerminal('sess-integration');
    await write(term, '\u001b]1337;CurrentDir=relative/path\u0007');
    expect(payloads).toEqual(['CurrentDir=relative/path']);
    expect(getSessionPwd('sess-integration')).toBeNull();
  });
});
