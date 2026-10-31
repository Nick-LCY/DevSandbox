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
import type { TerminalState, TerminalStatus } from '../lib/terminal-feedback';

/**
 * 终端连接状态与上报状态。
 *
 * 类型定义在 `src/lib/terminal-feedback.ts`（提示口径与去重规则同住），
 * 这里转出去给组件用。
 */
export type { TerminalState, TerminalStatus } from '../lib/terminal-feedback';

/** 重连退避上限（毫秒）。 */
const RECONNECT_MAX_DELAY = 8000;
/** 重连退避基数（毫秒）。 */
const RECONNECT_BASE_DELAY = 500;
/** 连接稳定存活多久算「真的连上了」（毫秒）。 */
const RECONNECT_STABLE_AFTER = 5000;
/** 连续失败上限：达到即停掉自动重连，等用户手动重试。 */
const MAX_RECONNECT_FAILURES = 10;

/**
 * 浏览器保留快捷键（豁免清单）。
 *
 * 这些键交回浏览器处理：新标签页 / 新窗口 / 关闭窗口 / 切换标签页 /
 * 刷新 / 全屏 / 开发者工具 / 打印 / 另存为。
 *
 * - Ctrl+N 与 Ctrl+Shift+N：新窗口与新隐身窗口
 * - Ctrl+T 与 Ctrl+Shift+T：新标签页与恢复标签页
 * - Ctrl+W 与 Ctrl+Shift+W：关闭标签页与窗口
 * - Ctrl+Q：退出应用
 * - Ctrl+Tab 与 Ctrl+Shift+Tab：切换浏览器标签页
 * - F5：刷新页面
 * - F11：全屏
 * - F12：开发者工具
 * - Alt+F4：关闭窗口
 * - Ctrl+P：打印
 * - Ctrl+S：另存为
 */
const RESERVED_CTRL_KEYS = new Set(['n', 't', 'w', 'q', 'p', 's', 'tab']);

/**
 * 这个按键是不是浏览器保留快捷键。
 *
 * 判定口径：带 Ctrl 或 Meta 的字母 / Tab 组合，以及 F5 / F11 / F12 与 Alt+F4。
 * 单的 Shift（Shift+Tab、Shift+N）不算保留键：终端里要能正常用。
 */
function isBrowserReservedShortcut(event: KeyboardEvent): boolean {
  if (event.key === 'F5' || event.key === 'F11' || event.key === 'F12') {
    return true;
  }
  if (event.altKey && event.key === 'F4') {
    return true;
  }
  if (!event.ctrlKey && !event.metaKey) {
    return false;
  }
  return RESERVED_CTRL_KEYS.has(event.key.toLowerCase());
}

interface TerminalViewProps {
  sessionId: string;
  /** 重试令牌：值变化时重建连接（用于「重连失败」后用户手动点重试）。 */
  retryToken?: number;
  onStateChange: (state: TerminalState) => void;
}

/**
 * 单个终端视图：xterm 实例 + 一条 WebSocket。
 *
 * 帧协议：二进制帧是终端字节流，文本帧是 `hello` / `exit` / `error` / `resize`。
 * 断线后按退避节奏重连，**始终携带原 `session_id`**（服务端会先回放缓冲再接实时流）。
 * 服务端重启导致会话失效时，停止重连并提示需要新开终端。
 *
 * 快捷键：带 Ctrl / Meta / Alt 的组合一律拦下来（不触发浏览器行为），
 * 但仍然编码后送进容器内的 shell（Ctrl+C 必须能到 pty）；
 * 浏览器保留键（见下方豁免清单）交回浏览器。
 *
 * 重连退避的计数只在连接**真的可用**时才清零：收到服务端的 `hello` 帧，
 * 或连接稳定存活超过 5 秒。握手成功不等于连上了——服务端握手后立刻关闭时，
 * 若在 `onopen` 清零计数就会变成每 500ms 一次的连接风暴。
 */
export function TerminalView({ sessionId, retryToken = 0, onStateChange }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
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
    let gaveUp = false;
    let retryTimer: number | null = null;
    let stableTimer: number | null = null;
    let socket: WebSocket | null = null;

    const term = new Terminal({
      cursorBlink: true,
      // 终端配色与字体固定：两套主题下都是深色终端，亮暗切换不影响可读性。
      fontFamily:
        "'Geist Mono', SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Noto Sans Mono CJK SC', monospace",
      fontSize: 12.5,
      theme: {
        background: '#152019',
        foreground: '#e3ebe5',
        cursor: '#a7d8af',
        selectionBackground: '#2b3d31',
      },
      scrollback: 5000,
      convertEol: false,
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    // 快捷键全量拦截：带 Ctrl / Meta / Alt 的组合一律不交给浏览器，
    // 但仍然让 xterm 编码后送进容器内的 shell（Ctrl+C 必须能到 pty）。
    // 浏览器保留键（见上方豁免清单）原样交回浏览器。
    term.attachCustomKeyEventHandler((event: KeyboardEvent): boolean => {
      if (isBrowserReservedShortcut(event)) {
        return true;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) {
        event.preventDefault();
        event.stopPropagation();
      }
      return true;
    });

    const report = (
      status: TerminalStatus,
      message: string,
      extra?: { exitCode?: number | null; retryDelaySeconds?: number },
    ): void => {
      stateCallbackRef.current({ status, message, ...extra });
    };

    /** 连接确认可用：连续失败计数清零。 */
    const markConnected = (): void => {
      attempt = 0;
      if (stableTimer !== null) {
        window.clearTimeout(stableTimer);
        stableTimer = null;
      }
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
      if (disposed || finished || gaveUp) {
        return;
      }
      attempt += 1;
      if (attempt >= MAX_RECONNECT_FAILURES) {
        // 连续失败到上限：停掉自动重连，改由用户点「重试」手动触发。
        gaveUp = true;
        report('failed', '重连失败，点击重试');
        return;
      }
      const delay = Math.min(RECONNECT_MAX_DELAY, RECONNECT_BASE_DELAY * 2 ** (attempt - 1));
      report('reconnecting', `连接断开，${Math.round(delay / 1000)} 秒后自动重连…`, {
        retryDelaySeconds: Math.round(delay / 1000),
      });
      retryTimer = window.setTimeout(() => {
        connect();
      }, delay);
    }

    function connect(): void {
      if (disposed || finished || gaveUp) {
        return;
      }
      report(attempt === 0 ? 'connecting' : 'reconnecting', '正在连接终端会话…');

      let next: WebSocket;
      try {
        next = new WebSocket(terminalSocketUrl(sessionId, window.location));
      } catch {
        // 连接地址非法：走失效状态，不抛异常把整个 effect 打断。
        finished = true;
        report('invalid', '终端连接地址非法，无法建立连接');
        return;
      }
      next.binaryType = 'arraybuffer';
      socket = next;

      next.onopen = () => {
        // 握手成功不等于连上了：只有 hello 帧或稳定存活才清零失败计数。
        report(
          attempt === 0 ? 'connecting' : 'reconnecting',
          '连接已建立，等待会话握手…',
        );
        safeFit();
        sendResize();
        stableTimer = window.setTimeout(() => {
          stableTimer = null;
          if (disposed || finished) {
            return;
          }
          attempt = 0;
          report('connected', '已连接');
        }, RECONNECT_STABLE_AFTER);
      };

      next.onmessage = (event: MessageEvent) => {
        if (typeof event.data === 'string') {
          const frame = parseTerminalFrame(event.data);
          if (frame.type === 'hello') {
            markConnected();
            report('connected', `已连接（会话 ${frame.sessionId.slice(0, 8)}）`);
            safeFit();
            sendResize();
            return;
          }
          if (frame.type === 'exit') {
            finished = true;
            report('closed', `终端进程已退出（退出码 ${frame.code ?? '未知'}）`, {
              exitCode: frame.code,
            });
            return;
          }
          if (frame.type === 'error') {
            if (isSessionInvalidMessage(frame.message)) {
              finished = true;
              report('invalid', SESSION_INVALID_MESSAGE);
              return;
            }
            // 服务端报错但连接还在：单独一个警告状态，不跟「已连接」混文案。
            report('warning', frame.message);
            return;
          }
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(event.data));
        }
      };

      next.onclose = (event: CloseEvent) => {
        if (stableTimer !== null) {
          // 连接没活到稳定阈值：失败计数保持不变，退避继续往上加。
          window.clearTimeout(stableTimer);
          stableTimer = null;
        }
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
      if (stableTimer !== null) {
        window.clearTimeout(stableTimer);
      }
      observer.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      socket?.close();
      fitAddon.dispose();
      term.dispose();
    };
  }, [sessionId, retryToken]);

  return (
    <div
      className="h-full min-h-0 overflow-auto rounded-xl border border-border bg-terminal-bg p-3"
      ref={containerRef}
      data-testid="page-sandbox-detail-terminal-surface"
      data-session-id={sessionId}
    />
  );
}
