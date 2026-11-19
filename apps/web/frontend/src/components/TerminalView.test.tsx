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

/** 从连接上取全部文本控制帧的「类型」序列（按发出顺序）。 */
function controlFrameTypes(socket: FakeWebSocket): string[] {
  return socket.sent
    .map((frame) => {
      try {
        const parsed = JSON.parse(frame) as { type?: string };
        return typeof parsed.type === 'string' ? parsed.type : null;
      } catch {
        return null;
      }
    })
    .filter((type): type is string => type !== null);
}

/** 读终端表面上渲染出来的屏幕文本（xterm 的 DOM 渲染器）。 */
function renderedText(): string {
  const rows = document.querySelector(
    '[data-testid="page-sandbox-detail-terminal-surface"] .xterm-rows',
  );
  return rows?.textContent ?? '';
}

/** 终端表面渲染出来的行数（几何变了行数就变）。 */
function renderedRowCount(): number {
  return document.querySelectorAll(
    '[data-testid="page-sandbox-detail-terminal-surface"] .xterm-rows > div',
  ).length;
}

/** 一帧快照（base64 装在 data 里）。 */
function snapshotFrame(options: {
  data: string;
  cols?: number;
  rows?: number;
  pwd?: string | null;
  part?: number;
  parts?: number;
}): string {
  return JSON.stringify({
    type: 'snapshot',
    part: options.part ?? 0,
    parts: options.parts ?? 1,
    data: btoa(options.data),
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    pwd: options.pwd ?? null,
  });
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

  it('重新附着（第二次握手）：不再做「±1 两步 resize」', async () => {
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

    // 重新附着**只发一帧尺寸同步**（80）：不再有 bump（81）/ 还原（80）那两步。
    // 那两步是为了「刷 pwd」；现在 pwd 由服务端快照帧带回来。
    expect(resizeCols(second)).toEqual([80]);
  });

  it('首次握手只发一帧尺寸同步（没有多余的 ±1 帧）', async () => {
    render(
      <ToastProvider>
        <TerminalView sessionId="sess-pwd" onStateChange={() => {}} />
      </ToastProvider>,
    );

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitText(HELLO_FRAME);

    // 连接建立时**不发帧**（attach 必须是第一个控制帧），
    // 握手后只发一帧尺寸同步（80）。
    expect(resizeCols(socket)).toEqual([80]);
  });

  it('attach 是第一个控制帧（报自己的窗口大小），resize 跟在后面', async () => {
    render(
      <ToastProvider>
        <TerminalView sessionId="sess-pwd" onStateChange={() => {}} />
      </ToastProvider>,
    );

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    // 连接建立后**还没有任何帧**：等 hello 才知道会话尺寸。
    expect(socket.sent).toHaveLength(0);
    socket.emitText(HELLO_FRAME);

    expect(controlFrameTypes(socket)).toEqual(['attach', 'resize']);
    const attach = JSON.parse(socket.sent[0]) as { type: string; cols: number; rows: number };
    expect(attach.type).toBe('attach');
    expect(attach.cols).toBe(80);
    expect(attach.rows).toBe(24);
  });

  it('快照帧：reset 后写入恢复流，画面上出现快照内容', async () => {
    render(
      <ToastProvider>
        <TerminalView sessionId="sess-pwd" onStateChange={() => {}} />
      </ToastProvider>,
    );

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitText(HELLO_FRAME);
    socket.emitText(snapshotFrame({ data: 'SNAPSHOT-CONTENT-MARKER' }));

    await waitFor(() => expect(renderedText()).toContain('SNAPSHOT-CONTENT-MARKER'));
  });

  it('快照帧带 pwd：按既有口径校验后落进会话 pwd 缓存', async () => {
    render(
      <ToastProvider>
        <TerminalView sessionId="sess-pwd" onStateChange={() => {}} />
      </ToastProvider>,
    );

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitText(HELLO_FRAME);
    socket.emitText(snapshotFrame({ data: 'X', pwd: 'CurrentDir=/workspace' }));

    await waitFor(() => expect(getSessionPwd('sess-pwd')).toBe('/workspace'));
  });

  it('快照的几何与当前不同：先 resize 再写（恢复流按字面换行定位）', async () => {
    render(
      <ToastProvider>
        <TerminalView sessionId="sess-pwd" onStateChange={() => {}} />
      </ToastProvider>,
    );

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitText(HELLO_FRAME);
    expect(renderedRowCount()).toBe(24);

    socket.emitText(snapshotFrame({ data: 'GEOMETRY-MARKER', cols: 100, rows: 30 }));

    await waitFor(() => expect(renderedRowCount()).toBe(30));
    await waitFor(() => expect(renderedText()).toContain('GEOMETRY-MARKER'));
  });

  it('快照分片不齐时丢弃（不写半截画面）', async () => {
    render(
      <ToastProvider>
        <TerminalView sessionId="sess-pwd" onStateChange={() => {}} />
      </ToastProvider>,
    );

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitText(HELLO_FRAME);
    // 两片只到一片：拼不出来 ⇒ 丢弃
    socket.emitText(snapshotFrame({ data: 'PART-ONE', part: 0, parts: 2 }));

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(renderedText()).not.toContain('PART-ONE');
  });

  it('旧后端不认 attach 时的报错：静默豁免（不改状态）', async () => {
    const states: { status: string; message: string }[] = [];
    render(
      <ToastProvider>
        <TerminalView sessionId="sess-pwd" onStateChange={(state) => states.push(state)} />
      </ToastProvider>,
    );

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.emitOpen();
    socket.emitText(HELLO_FRAME);
    const before = states.length;

    socket.emitText(
      JSON.stringify({ type: 'error', message: '无法识别的终端指令：attach' }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    // 状态没被那条报错改掉（没有 warning / failed）
    expect(states.length).toBe(before);
    expect(states.some((state) => state.status === 'warning')).toBe(false);
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
