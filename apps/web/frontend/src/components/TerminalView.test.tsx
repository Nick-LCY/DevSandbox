// @vitest-environment jsdom
/**
 * 终端视图的 **pwd 通道**接线验证。
 *
 * 覆盖三件在组件层才能验的事：
 *
 * - **OSC 1337 上报 ⇒ 会话 pwd 缓存更新**：服务端推来的字节流里带着 01 轮
 *   真沙箱捕获的那条 OSC 序列，终端视图解析后按会话记进内存缓存；
 * - **断线重连后的提示符刷新**：重新附着（第二次握手）时走「cols+1 → 还原」
 *   的两步 resize，把最新 pwd 逼出来（01 轮实测：同尺寸 resize 不出字节）；
 * - **缓存的生命周期**：pwd 缓存只在**会话真的结束**（`exit` 帧）时清空——
 *   组件卸载（切标签）时会话还活着，缓存不能跟着没。
 *
 * 这里用**假 WebSocket**驱动帧协议：帧是本组件与后端之间的全部交互面，
 * 没必要为它起真的后端。真 xterm 照用（解析与状态机是本用例要验的东西）。
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getSessionPwd, clearSessionPwd } from '../lib/terminal-pwd';
import { TerminalView } from './TerminalView';
import { ToastProvider } from './Toast';

vi.mock('../api/client', () => ({
  fetchAuthTicket: async () => 'ticket-1',
}));

/** 假 WebSocket：记录发出去的帧，并让用例手动推帧进来。 */
class FakeWebSocket {
  /** 每个实例的 CONNECTING / OPEN / CLOSING / CLOSED。 */
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** 全部实例（按创建顺序）：用例靠它取「当前这条连接」。 */
  static instances: FakeWebSocket[] = [];

  /** 本连接发出去的帧（文本帧是 JSON 字符串）。 */
  readonly sent: string[] = [];

  readyState = FakeWebSocket.OPEN;

  binaryType = 'blob';

  onopen: ((event: Event) => void) | null = null;

  onmessage: ((event: MessageEvent) => void) | null = null;

  onclose: ((event: CloseEvent) => void) | null = null;

  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sent.push(String(data));
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  /* ------------------------------------------------------- 用例侧的推帧口 */

  /** 握手成功。 */
  emitOpen(): void {
    this.onopen?.(new Event('open'));
  }

  /** 推一个文本帧（hello / exit / error）。 */
  emitText(text: string): void {
    this.onmessage?.({ data: text } as MessageEvent);
  }

  /** 推一段终端字节流。 */
  emitBytes(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.buffer } as MessageEvent);
  }
}

/** 01 轮真沙箱捕获的 OSC 序列（ESC ] 1337 ; CurrentDir=/workspace BEL）。 */
const REAL_OSC_BYTES = new Uint8Array([
  0x1b, 0x5d, 0x31, 0x33, 0x33, 0x37, 0x3b, 0x43, 0x75, 0x72, 0x72, 0x65, 0x6e, 0x74,
  0x44, 0x69, 0x72, 0x3d, 0x2f, 0x77, 0x6f, 0x72, 0x6b, 0x73, 0x70, 0x61, 0x63, 0x65, 0x07,
]);

/** hello 帧（服务端握手时推的那一帧）。 */
const HELLO_FRAME = JSON.stringify({
  type: 'hello',
  session_id: 'sess-pwd',
  sandbox: 'demo',
  cols: 80,
  rows: 24,
});

/** exit 帧（服务端告知容器内进程退出了）。 */
const EXIT_FRAME = JSON.stringify({ type: 'exit', code: 0, reason: 'closed' });

/** 从连接上取「resize 帧」的列数序列（文本帧是 JSON，取 cols 字段）。 */
function resizeCols(socket: FakeWebSocket): number[] {
  return socket.sent
    .map((frame) => {
      try {
        const parsed = JSON.parse(frame) as { type?: string; cols?: number };
        return parsed.type === 'resize' && typeof parsed.cols === 'number' ? parsed.cols : null;
      } catch {
        return null;
      }
    })
    .filter((cols): cols is number => cols !== null);
}

describe('终端视图的 pwd 通道接线', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    clearSessionPwd('sess-pwd');
    // jsdom 没有 ResizeObserver（终端视图用它跟尺寸变化）。
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}

        unobserve(): void {}

        disconnect(): void {}
      },
    );
    vi.stubGlobal('WebSocket', FakeWebSocket);
    // jsdom 没有 matchMedia（xterm 用它问设备像素比）。
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('字节流里的 OSC 1337 ⇒ 按会话记进 pwd 缓存', async () => {
    render(
      <ToastProvider>
        <TerminalView sessionId="sess-pwd" onStateChange={() => {}} />
      </ToastProvider>,
    );

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitText(HELLO_FRAME);
    expect(getSessionPwd('sess-pwd')).toBeNull();

    socket.emitBytes(REAL_OSC_BYTES);
    await waitFor(() => expect(getSessionPwd('sess-pwd')).toBe('/workspace'));
  });

  it('重新附着（第二次握手）：走「cols+1 → 还原」的两步 resize', async () => {
    const view = render(
      <ToastProvider>
        <TerminalView sessionId="sess-pwd" onStateChange={() => {}} />
      </ToastProvider>,
    );

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const first = FakeWebSocket.instances[0];
    first.emitOpen();
    first.emitText(HELLO_FRAME);

    // 用户点「重试」⇒ 同一个组件实例里重跑 effect ⇒ 重新附着到还活着的 shell。
    view.rerender(
      <ToastProvider>
        <TerminalView sessionId="sess-pwd" retryToken={1} onStateChange={() => {}} />
      </ToastProvider>,
    );

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const second = FakeWebSocket.instances[1];
    second.emitOpen();
    second.emitText(HELLO_FRAME);

    // **整条序列**（不只看末两帧）：
    // ① 连接建立时同步一次当前视宽（80）；
    // ② 重新附着 ⇒ bump 到 hello 帧带的会话真实尺寸 +1（81）；
    // ③ 还原回真实尺寸（80）。
    // 基准取 hello 帧的 cols（会话真实尺寸），不是前端视宽（tab 不可见时两者可能不等）。
    expect(resizeCols(second)).toEqual([80, 81, 80]);
  });

  it('首次握手不做两步刷新（新起的 shell 自己会画带 OSC 的提示符）', async () => {
    render(
      <ToastProvider>
        <TerminalView sessionId="sess-pwd" onStateChange={() => {}} />
      </ToastProvider>,
    );

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitText(HELLO_FRAME);

    // **整条序列**：只有连接建立时与握手时各一次尺寸同步（80、80），
    // **没有**多出来的 ±1 帧（bump / 还原）。
    expect(resizeCols(socket)).toEqual([80, 80]);
  });

  it('会话真的结束（exit 帧）⇒ 这条会话的 pwd 缓存清空', async () => {
    render(
      <ToastProvider>
        <TerminalView sessionId="sess-pwd" onStateChange={() => {}} />
      </ToastProvider>,
    );

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitText(HELLO_FRAME);
    socket.emitBytes(REAL_OSC_BYTES);
    await waitFor(() => expect(getSessionPwd('sess-pwd')).toBe('/workspace'));

    // 容器内进程退出了 ⇒ 会话结束 ⇒ 缓存作废（不然缓存只增不减）。
    socket.emitText(EXIT_FRAME);
    expect(getSessionPwd('sess-pwd')).toBeNull();
  });

  it('组件卸载（切标签）不清缓存：会话还活着', async () => {
    const view = render(
      <ToastProvider>
        <TerminalView sessionId="sess-pwd" onStateChange={() => {}} />
      </ToastProvider>,
    );

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitText(HELLO_FRAME);
    socket.emitBytes(REAL_OSC_BYTES);
    await waitFor(() => expect(getSessionPwd('sess-pwd')).toBe('/workspace'));

    // 切标签 ⇒ 终端视图整块卸载，但**后端会话还活着** ⇒ pwd 不能跟着没。
    view.unmount();
    expect(getSessionPwd('sess-pwd')).toBe('/workspace');
  });
});
