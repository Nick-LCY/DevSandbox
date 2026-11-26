/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';

import {
  buildOsc52Response,
  decodeOsc52Text,
  encodeOsc52Text,
  parseOsc52Payload,
} from './terminal-clipboard';

const createdTerms: Terminal[] = [];

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function createTerminal(onPayload: (payload: string) => void): Terminal {
  const term = new Terminal({ allowProposedApi: true });
  createdTerms.push(term);
  term.parser.registerOscHandler(52, (payload) => {
    onPayload(payload);
    return true;
  });
  return term;
}

afterEach(() => {
  while (createdTerms.length > 0) {
    createdTerms.pop()?.dispose();
  }
});

describe('OSC 52 与 xterm parser', () => {
  it('完整 set / query 都由 handler 收到，并可解析', async () => {
    const payloads: string[] = [];
    const term = createTerminal((payload) => payloads.push(payload));
    await write(term, '\u001b]52;c;SGVsbG8=\u0007\u001b]52;c;?\u0007');

    expect(payloads).toEqual(['c;SGVsbG8=', 'c;?']);
    expect(decodeOsc52Text(parseOsc52Payload(payloads[0])!.data!)).toBe('Hello');
    expect(parseOsc52Payload(payloads[1])).toEqual({
      selection: 'c',
      operation: 'query',
      data: null,
    });
  });

  it('拆成两次 write 时只在补齐 BEL 后触发一次', async () => {
    const payloads: string[] = [];
    const term = createTerminal((payload) => payloads.push(payload));
    await write(term, '\u001b]52;c;SGVsbG8=');
    expect(payloads).toEqual([]);

    await write(term, '\u0007');
    expect(payloads).toEqual(['c;SGVsbG8=']);
  });

  it('term.reset() 后 handler 仍然有效', async () => {
    const payloads: string[] = [];
    const term = createTerminal((payload) => payloads.push(payload));
    await write(term, `\u001b]52;c;${encodeOsc52Text('before')!}\u0007`);
    term.reset();
    await write(term, `\u001b]52;c;${encodeOsc52Text('after')!}\u0007`);

    expect(payloads).toEqual(['c;YmVmb3Jl', 'c;YWZ0ZXI=']);
    expect(buildOsc52Response('after')).toBe('\u001b]52;c;YWZ0ZXI=\u0007');
  });
});
