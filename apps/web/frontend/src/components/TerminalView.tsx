import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { fetchAuthTicket } from '../api/client';
import { getConnectionConfig } from '../lib/connection';
import {
  CLOSE_CODE_UNKNOWN_SESSION,
  SESSION_INVALID_MESSAGE,
  encodeResize,
  isSessionInvalidMessage,
  parseTerminalFrame,
  terminalSocketUrl,
} from '../lib/terminal';
import {
  MAX_RECONNECT_FAILURES,
  classifyTicketFailure,
  reconnectDelayMs,
  stopsAutoReconnect,
  ticketFailureStatusText,
  ticketFailureToastKey,
  unauthorizedStatusText,
  type TicketFailure,
} from '../lib/terminal-connection';
import type { TerminalState, TerminalStatus } from '../lib/terminal-feedback';
import { createFitDebouncer } from '../lib/terminal-fit';
import { classifyTerminalShortcut } from '../lib/terminal-shortcuts';
import { useToast } from './Toast';

/**
 * 终端连接状态与上报状态。
 *
 * 类型定义在 `src/lib/terminal-feedback.ts`（提示口径与去重规则同住），
 * 这里转出去给组件用。
 */
export type { TerminalState, TerminalStatus } from '../lib/terminal-feedback';

/** 连接稳定存活多久算「真的连上了」（毫秒）。 */
const RECONNECT_STABLE_AFTER = 5000;

/**
 * 尺寸自适应的去抖窗口（毫秒）。
 *
 * 侧栏折叠 / 展开带 200 毫秒宽度过渡，过渡期间主列宽度逐帧变化，
 * 挂载盒的 ResizeObserver 逐帧触发；不去抖的话每一帧都会 fit + sendResize，
 * 把一串尺寸帧逐个回打到 pty。去抖后一次过渡只回打一帧。
 */
const FIT_DEBOUNCE_MS = 100;

/** 剪贴板失败提示的来源标记（端到端脚本靠它定位这条提示）。 */
const CLIPBOARD_TOAST_SOURCE = 'terminal-clipboard';

/** 终端连接失败（票据取不到 / 连不上）的来源标记。 */
const TERMINAL_CONNECTION_TOAST_SOURCE = 'terminal-connection';

interface TerminalViewProps {
  sessionId: string;
  /** 重试令牌：值变化时重建连接（用于「重连失败」后用户手动点重试）。 */
  retryToken?: number;
  /**
   * 挂载之后要不要把焦点回填进终端。
   *
   * 会话切换会让终端**整块重挂载**（`key={activeId}`），重挂载后浏览器焦点
   * 落到 body，新终端就成了「空心光标」——看得见、敲不进（按键没进 pty）。
   * 门控口径在 `src/lib/terminal-focus.ts`（纯函数，可单测）：
   * 只有「用户刚点了标签 / 终端表面 / 新建了会话」或「判定当下焦点就在终端
   * 表面内」才回填，焦点在别处（抽屉输入框等）不抢。这里只负责执行回填。
   */
  autoFocus?: boolean;
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
 *
 * 取票失败（拿不到一次性票据）的策略在 `src/lib/terminal-connection.ts`
 * （纯函数，可单测）：状态文案单列（不与「连接断开」混）、令牌无效时停掉
 * 自动重连（重试多少次都是 401）、提示按文案去重。
 */
export function TerminalView({
  sessionId,
  retryToken = 0,
  autoFocus = false,
  onStateChange,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stateCallbackRef = useRef(onStateChange);
  stateCallbackRef.current = onStateChange;
  /**
   * 焦点回填的开关：**挂载那一刻的快照**。
   *
   * 这一个终端实例只回填一次：改它不重建终端连接（回填只在挂载那一刻做一次），
   * 后续重渲染（轮询、状态变化）也不改写它；重试连接（`retryToken` 变化）走的是
   * 同一个 effect，但不会把挂载时刻的值再拿出来用一次。
   */
  const autoFocusRef = useRef(autoFocus);
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
    /** 上一条票据失败的提示键（同一句不重复弹）。 */
    let lastTicketFailureKey = '';

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

    /**
     * 焦点回填：会话切换后终端整块重挂载，浏览器焦点会落到 body，
     * 新终端就成了看得见、敲不准的空心光标。这里把焦点抢回终端。
     *
     * - rAF：等布局落定再聚焦（xterm 的 helper 文本框此刻才在正确的位置）；
     * - 只做一次：挂载这一次，不重复抢（值用完就清掉，重试连接不会再来一次）；
     * - 已卸载（disposed）就不做：别把焦点塞进一个已经拆掉的终端。
     */
    if (autoFocusRef.current) {
      autoFocusRef.current = false;
      window.requestAnimationFrame(() => {
        if (disposed) {
          return;
        }
        term.focus();
      });
    }

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

    /**
     * 尺寸自适应的去抖入口：窗口内的多次触发只保留最后一次。
     *
     * 侧栏宽度过渡（200 毫秒）期间主列逐帧变化，挂载盒的 ResizeObserver
     * 逐帧触发；直接每次都 fit + sendResize 会把一串尺寸帧回打到 pty。
     */
    const fitDebouncer = createFitDebouncer(FIT_DEBOUNCE_MS, () => {
      safeFit();
    });

    /**
     * 安排下一次重连。
     *
     * `failure` 是这次失败的原因（取票失败时带上）：状态栏据此写**单列文案**
     * （不与「连接断开」混——「票据没取到」和「连接断了」是两回事）。
     */
    function scheduleReconnect(failure?: TicketFailure): void {
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
      const delay = reconnectDelayMs(attempt);
      const seconds = Math.round(delay / 1000);
      report(
        'reconnecting',
        failure
          ? ticketFailureStatusText(failure, seconds)
          : `连接断开，${seconds} 秒后自动重连…`,
        { retryDelaySeconds: seconds },
      );
      retryTimer = window.setTimeout(() => {
        void connect();
      }, delay);
    }

    /**
     * 票据取不到的失败提示。
     *
     * 浏览器发起的 WebSocket 不能设请求头，握手靠一次性票据（`?ticket=`）；
     * 票据取不到说明后端不可达或令牌无效——不是会话失效，不能报成「会话失效」。
     * 同一句不重复弹（重连会反复取票据）。
     */
    const reportTicketFailure = (failure: TicketFailure): void => {
      const key = ticketFailureToastKey(failure);
      if (key === lastTicketFailureKey) {
        return;
      }
      lastTicketFailureKey = key;
      showRef.current('error', `终端连接失败：${failure.message}`, {
        source: TERMINAL_CONNECTION_TOAST_SOURCE,
      });
    };

    async function connect(): Promise<void> {
      if (disposed || finished || gaveUp) {
        return;
      }
      report(attempt === 0 ? 'connecting' : 'reconnecting', '正在连接终端会话…');

      // 每次连接 / 重连前现取一张一次性票据（不缓存：票据 30 秒过期、用过即废）。
      let ticket: string;
      try {
        ticket = await fetchAuthTicket();
      } catch (exc) {
        if (disposed || finished || gaveUp) {
          return;
        }
        const failure = classifyTicketFailure(exc);
        if (stopsAutoReconnect(failure)) {
          // 令牌无效：重试多少次都是 401——停掉自动重连，
          // 提示去设置抽屉换令牌（换完点「重试连接」手动再来一次）。
          gaveUp = true;
          report('failed', unauthorizedStatusText(failure));
          return;
        }
        // 取不到票据：连不上。按退避节奏重试，状态文案单列，
        // 失败提示单独弹（来源 terminal-connection）。
        scheduleReconnect(failure);
        reportTicketFailure(failure);
        return;
      }
      if (disposed || finished || gaveUp) {
        return;
      }

      let next: WebSocket;
      try {
        // 连接地址从连接配置推导（恒从基址推导：http→ws / https→wss）。
        // 推导不出来（例如基址填成了别的协议）：**不猜一个地址**，进「连接地址非法」。
        const url = terminalSocketUrl(
          sessionId,
          { baseUrl: getConnectionConfig().backendBaseUrl },
          ticket,
        );
        if (url === null) {
          finished = true;
          report('invalid', '终端连接地址非法，无法建立连接');
          return;
        }
        next = new WebSocket(url);
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
      // 去抖：过渡期间的逐帧触发合并成最后一次（只回打一帧尺寸）。
      fitDebouncer.schedule();
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

    void connect();

    return () => {
      disposed = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      if (stableTimer !== null) {
        window.clearTimeout(stableTimer);
      }
      fitDebouncer.cancel();
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
