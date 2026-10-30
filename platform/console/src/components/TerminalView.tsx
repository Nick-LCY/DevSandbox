import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import {
  CLOSE_CODE_UNKNOWN_SESSION,
  SESSION_INVALID_MESSAGE,
  encodeResize,
  isSessionInvalidMessage,
  parseTerminalFrame,
  terminalSocketUrl,
} from '../lib/terminal';

/** 终端连接状态。 */
export type TerminalStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'invalid';

/** 终端视图向上层汇报的状态。 */
export interface TerminalState {
  status: TerminalStatus;
  message: string;
}

/** 重连退避上限（毫秒）。 */
const RECONNECT_MAX_DELAY = 8000;
/** 重连退避基数（毫秒）。 */
const RECONNECT_BASE_DELAY = 500;

interface TerminalViewProps {
  sessionId: string;
  /** 当前是否可见：只有可见的标签才做尺寸自适应。 */
  active: boolean;
  onStateChange: (state: TerminalState) => void;
}

/**
 * 单个终端视图：xterm 实例 + 一条 WebSocket。
 *
 * 帧协议：二进制帧是终端字节流，文本帧是 `hello` / `exit` / `error` / `resize`。
 * 断线后按退避节奏重连，**始终携带原 `session_id`**（服务端会先回放缓冲再接实时流）。
 * 服务端重启导致会话失效时，停止重连并提示需要新开终端。
 */
export function TerminalView({ sessionId, active, onStateChange }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const stateCallbackRef = useRef(onStateChange);
  stateCallbackRef.current = onStateChange;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    let disposed = false;
    let attempt = 0;
    let finished = false;
    let retryTimer: number | null = null;
    let socket: WebSocket | null = null;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      scrollback: 5000,
      convertEol: false,
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    termRef.current = term;
    fitRef.current = fitAddon;

    const report = (status: TerminalStatus, message: string): void => {
      stateCallbackRef.current({ status, message });
    };

    const sendResize = (): void => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(encodeResize(term.cols, term.rows));
    };

    /** 尺寸自适应：容器还没铺开（隐藏的标签）时跳过，避免算出 0 列。 */
    const safeFit = (): void => {
      if (container.clientWidth === 0 || container.clientHeight === 0) {
        return;
      }
      try {
        fitAddon.fit();
      } catch {
        // 尺寸未就绪：等下一次 ResizeObserver 回调。
        return;
      }
      sendResize();
    };

    function scheduleReconnect(): void {
      if (disposed || finished) {
        return;
      }
      attempt += 1;
      const delay = Math.min(RECONNECT_MAX_DELAY, RECONNECT_BASE_DELAY * 2 ** (attempt - 1));
      report('reconnecting', `连接断开，${Math.round(delay / 1000)} 秒后自动重连…`);
      retryTimer = window.setTimeout(() => {
        connect();
      }, delay);
    }

    function connect(): void {
      if (disposed || finished) {
        return;
      }
      report(attempt === 0 ? 'connecting' : 'reconnecting', '正在连接终端会话…');

      const next = new WebSocket(terminalSocketUrl(sessionId, window.location));
      next.binaryType = 'arraybuffer';
      socket = next;

      next.onopen = () => {
        attempt = 0;
        report('connected', '已连接');
        safeFit();
        sendResize();
      };

      next.onmessage = (event: MessageEvent) => {
        if (typeof event.data === 'string') {
          const frame = parseTerminalFrame(event.data);
          if (frame.type === 'hello') {
            report('connected', `已连接（会话 ${frame.sessionId.slice(0, 8)}）`);
            safeFit();
            sendResize();
            return;
          }
          if (frame.type === 'exit') {
            finished = true;
            report('closed', `终端进程已退出（退出码 ${frame.code ?? '未知'}）`);
            return;
          }
          if (frame.type === 'error') {
            if (isSessionInvalidMessage(frame.message)) {
              finished = true;
              report('invalid', SESSION_INVALID_MESSAGE);
              return;
            }
            report('connected', frame.message);
            return;
          }
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(event.data));
        }
      };

      next.onclose = (event: CloseEvent) => {
        if (disposed || finished) {
          return;
        }
        if (event.code === CLOSE_CODE_UNKNOWN_SESSION) {
          finished = true;
          report('invalid', SESSION_INVALID_MESSAGE);
          return;
        }
        scheduleReconnect();
      };

      next.onerror = () => {
        // onclose 紧随其后，重连逻辑统一在 onclose 里处理。
      };
    }

    const dataDisposable = term.onData((data: string) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(new TextEncoder().encode(data));
    });

    const resizeDisposable = term.onResize(() => {
      sendResize();
    });

    const observer = new ResizeObserver(() => {
      safeFit();
    });
    observer.observe(container);

    connect();

    return () => {
      disposed = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      observer.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      socket?.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    // 标签刚显示出来时容器才有尺寸，等一帧再自适应。
    const timer = window.setTimeout(() => {
      const term = termRef.current;
      const container = containerRef.current;
      if (!term || !container || container.clientWidth === 0 || container.clientHeight === 0) {
        return;
      }
      try {
        fitRef.current?.fit();
      } catch {
        // 尺寸未就绪：忽略。
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active]);

  return (
    <div
      className="terminal-surface"
      ref={containerRef}
      data-testid="page-sandbox-detail-terminal-surface"
      data-session-id={sessionId}
    />
  );
}
