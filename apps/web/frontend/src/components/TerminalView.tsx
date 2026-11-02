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
import { classifyTerminalShortcut } from '../lib/terminal-shortcuts';
import { useToast } from './Toast';

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

/** 剪贴板失败提示的来源标记（端到端脚本靠它定位这条提示）。 */
const CLIPBOARD_TOAST_SOURCE = 'terminal-clipboard';

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
 * 浏览器保留键（见 `src/lib/terminal-shortcuts.ts` 的豁免清单）交回浏览器；
 * Ctrl+Shift+C / Ctrl+Shift+V 走系统剪贴板（复制选区 / 粘贴内容）。
 *
 * 重连退避的计数只在连接**真的可用**时才清零：收到服务端的 `hello` 帧，
 * 或连接稳定存活超过 5 秒。握手成功不等于连上了——服务端握手后立刻关闭时，
 * 若在 `onopen` 清零计数就会变成每 500ms 一次的连接风暴。
 */
export function TerminalView({ sessionId, retryToken = 0, onStateChange }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stateCallbackRef = useRef(onStateChange);
  stateCallbackRef.current = onStateChange;
  const { show } = useToast();
  /** 反馈接口走引用：换身份时不重建终端连接。 */
  const showRef = useRef(show);
  showRef.current = show;

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

    /** 剪贴板操作失败：弹一条失败提示（成功路径零反馈）。 */
    const reportClipboardFailure = (text: string): void => {
      showRef.current('error', text, { source: CLIPBOARD_TOAST_SOURCE });
    };

    /**
     * 复制选区到系统剪贴板。
     *
     * - 无选区：静默不做任何事（不弹提示）；
     * - 剪贴板 API 不可用（非安全上下文）或写入失败：弹失败提示。
     *
     * 写入是异步的（浏览器要弹授权、或系统剪贴板被别的进程占着），
     * 不能在按键处理函数里等——按键处理函数必须同步返回。
     */
    const copySelectionToClipboard = (): void => {
      if (!term.hasSelection()) {
        return;
      }
      const selection = term.getSelection();
      if (!selection) {
        return;
      }
      try {
        const clipboard = navigator.clipboard;
        if (!clipboard || typeof clipboard.writeText !== 'function') {
          reportClipboardFailure('复制到系统剪贴板失败');
          return;
        }
        void clipboard.writeText(selection).catch(() => {
          reportClipboardFailure('复制到系统剪贴板失败');
        });
      } catch {
        // 非标准实现可能同步抛错：归入失败分支（与异步失败同一条提示）。
        reportClipboardFailure('复制到系统剪贴板失败');
      }
    };

    /**
     * 从系统剪贴板粘贴进终端。
     *
     * 走 xterm 的 `paste`：它自己做括号粘贴模式的包裹与换行归一，
     * 不能直接往 socket 塞字节（否则会绕过终端的输入处理）。
     */
    const pasteFromClipboard = (): void => {
      try {
        const clipboard = navigator.clipboard;
        if (!clipboard || typeof clipboard.readText !== 'function') {
          reportClipboardFailure('读取系统剪贴板失败');
          return;
        }
        void clipboard
          .readText()
          .then((text) => {
            if (disposed || !text) {
              return;
            }
            term.paste(text);
          })
          .catch(() => {
            reportClipboardFailure('读取系统剪贴板失败');
          });
      } catch {
        // 非标准实现可能同步抛错：归入失败分支（与异步失败同一条提示）。
        reportClipboardFailure('读取系统剪贴板失败');
      }
    };

    // 快捷键处置：分类规则在 `src/lib/terminal-shortcuts.ts`（纯函数，可单测）。
    //
    // - 保留键 / 纯按键：交回 xterm 照常处理；
    // - 带 Ctrl / Meta / Alt 的组合：拦下浏览器行为，但仍编码后送进容器内的 shell
    //   （Ctrl+C 必须能到 pty，Ctrl+V 仍然是字面量 0x16）；
    // - Ctrl+Shift+C / Ctrl+Shift+V：走系统剪贴板，不进容器。
    term.attachCustomKeyEventHandler((event: KeyboardEvent): boolean => {
      const action = classifyTerminalShortcut({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
      });
      if (action === 'reserved' || action === 'plain') {
        return true;
      }
      event.preventDefault();
      event.stopPropagation();
      if (action === 'forward') {
        // 仍然让 xterm 编码后送进容器内的 shell。
        return true;
      }
      // 复制与粘贴**只在 keydown 做一次**：xterm 在 keypress / keyup 阶段也会调这个
      // 处理器，不收窄的话一次按键会触发多轮剪贴板操作（粘贴两遍、剪贴板被覆盖两次）。
      if (event.type === 'keyup') {
        // keyup 必须放行：xterm 的 _keyUp 在自定义处理器返回 false 时会直接跳过
        // focus() / updateCursorStyle() 等收尾——浏览器弹权限框抢走焦点后，
        // 终端可能收不到后续按键。动作已由 keydown 阶段执行过，这里不会重复执行。
        return true;
      }
      if (event.type !== 'keydown') {
        return false;
      }
      if (action === 'copy') {
        copySelectionToClipboard();
      } else {
        pasteFromClipboard();
      }
      return false;
    });

    const report = (
      status: TerminalStatus,
      message: string,
      extra?: {
        exitCode?: number | null;
        exitReason?: string | null;
        retryDelaySeconds?: number;
      },
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
              // 结束原因透传给上层：用户主动关闭与容器内进程自己退出语义不同
              exitReason: frame.reason,
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

    // 自托管字体 swap 晚到会让列数失配：fit 用的是量出来的字符宽度，
    // 字体没就位时量的是回退字形。字体就绪后补一次 fit（只做一次）。
    // rAF 是为了让字体 swap 引起的重排先落地，再量尺寸。
    if (document.fonts) {
      void document.fonts.ready
        .then(
          () =>
            new Promise<void>((resolve) => {
              window.requestAnimationFrame(() => resolve());
            }),
        )
        .then(() => {
          if (disposed) {
            return;
          }
          safeFit();
        })
        .catch(() => {
          // 字体加载失败：保持现状，等下一次 ResizeObserver 回调。
        });
    }

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
    /*
     * 终端表面分两层：
     *
     * - 外层（视觉层）：圆角、边框、内边距、深色底都在这一层，**不滚动**
     *   （overflow-hidden）——外层一旦能滚，就会多出一根原生滚动条。
     * - 内层（测量 / 挂载层）：无内边距、无边框的空盒，xterm 挂在这里。
     *   fit 量的是父容器的**边框盒**且只减终端元素自身的 padding，
     *   放在这一层才量得到真实可用空间（外层的 padding 与 border 不再被漏算）。
     */
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-terminal-bg p-3"
      data-testid="page-sandbox-detail-terminal-surface"
      data-session-id={sessionId}
    >
      <div
        className="h-full w-full min-h-0 flex-1 overflow-hidden"
        ref={containerRef}
        data-testid="page-sandbox-detail-terminal-mount"
      />
    </div>
  );
}
