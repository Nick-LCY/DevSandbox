import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { fetchAuthTicket } from '../api/client';
import { getConnectionConfig } from '../lib/connection';
import {
  CLOSE_CODE_UNKNOWN_SESSION,
  SESSION_INVALID_MESSAGE,
  encodeAttach,
  encodeResize,
  isSessionInvalidMessage,
  isUnknownAttachMessage,
  parseTerminalFrame,
  terminalSocketUrl,
  type TerminalFrame,
} from '../lib/terminal';
import { decodeSnapshotParts } from '../lib/terminal-snapshot';
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
import {
  OSC_CURRENT_DIR_IDENT,
  clearSessionPwd,
  parseCurrentDirPayload,
  setSessionPwd,
} from '../lib/terminal-pwd';
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

/**
 * attach 之后等快照分片的窗口（毫秒）。
 *
 * **降级兜底用**：旧后端（不认 attach / 不下发 snapshot）与模拟器关闭的会话
 * 只回放历史字节，pwd 只能靠实时流里的 OSC 1337 更新；重新附着后没有新提示符
 * 就永远拿不到新 pwd。超过这个窗口还没见到任何快照分片时，用一次「尺寸真变化」
 * 逼 readline 重绘提示符（重绘会顺带重发 OSC 1337）。
 *
 * 正常路径（服务端下发快照）在窗口内就有分片到达 ⇒ 不做这两步。
 */
const SNAPSHOT_FALLBACK_MS = 2000;

/** 剪贴板失败提示的来源标记（端到端脚本靠它定位这条提示）。 */
const CLIPBOARD_TOAST_SOURCE = 'terminal-clipboard';

/** 终端连接失败（票据取不到 / 连不上）的来源标记。 */
const TERMINAL_CONNECTION_TOAST_SOURCE = 'terminal-connection';

interface TerminalViewProps {
  sessionId: string;
  /** 重试令牌：值变化时重建连接（用于「重连失败」后用户手动点重试）。 */
  retryToken?: number;
  /**
   * 这个实例当前**是不是可见的**（标签之间常驻：不活跃的那份被藏起来）。
   *
   * 隐藏态用 `display:none`——xterm 在隐藏态下量不到尺寸（fit 会算出 0 列），
   * 所以**变可见时要补一次 fit**（见下面 `active` 的 effect）。
   */
  active?: boolean;
  /**
   * 焦点回填的**请求序号**。
   *
   * 终端实例常驻之后，「把焦点还给这个终端」不再是一次挂载事件，而是一次
   * **请求**：序号才能表达「同一个会话第二次激活」，且**一次请求只回填一次**
   * （序号不变就不重复抢；重连 / 重试不重放旧请求）。
   *
   * 门控口径在 `src/lib/terminal-focus.ts`（纯函数，可单测）：上游只在该
   * 回填时才递增序号，这里只负责执行回填。
   */
  focusRequestId?: number;
  onStateChange: (state: TerminalState) => void;
}

/**
 * 单个终端视图：xterm 实例 + 一条 WebSocket。
 *
 * **生命周期（标签之间常驻）**：本组件**不再随标签切换销毁重建**——
 * 同一会话的 xterm 实例在标签之间保留（不活跃的那份被 `display:none` 藏起来），
 * 切回时补一次 fit（隐藏态量不到尺寸）并按请求序号回填焦点。
 * **卸载语义不变**：socket close / addon dispose / term dispose / observer 断开。
 *
 * 帧协议：二进制帧是终端字节流，文本帧是 `hello` / `snapshot` / `exit` /
 * `error` / `resize` / `attach`。
 * 断线后按退避节奏重连，**始终携带原 `session_id`**（服务端会先下发屏幕
 * 快照再接实时流）。服务端重启导致会话失效时，停止重连并提示需要新开终端。
 *
 * **握手次序（attach 必须是第一个控制帧）**：连接建立后**不发任何帧**，
 * 等服务端的 `hello`；收到 hello ⇒ fit 一次、拿到终端尺寸 ⇒ 先发 `attach`
 * （报尺寸）再补发一帧 `resize`（兼容旧后端）。服务端据此把会话对齐到
 * 客户端尺寸，再把「屏幕现场」导成 VT 恢复流下发（`snapshot` 帧）——
 * 前端按它 `reset` + 重放，画面与终端模式（鼠标上报 / 焦点上报 / 括号粘贴 /
 * 备用屏）一次性恢复。
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
  active = true,
  focusRequestId = 0,
  onStateChange,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stateCallbackRef = useRef(onStateChange);
  stateCallbackRef.current = onStateChange;
  /**
   * 当前这个 xterm 实例（连接 effect 建出来的）。
   *
   * 可见性切换与焦点回填都在**连接 effect 之外**发生，但都要用到实例本身：
   * 通过它把「重新量尺寸」与「聚焦」两件事的入口暴露出去。
   */
  const termRef = useRef<Terminal | null>(null);
  /** 重新量尺寸的入口（连接 effect 闭包里的 `safeFit`）：断开后置 null。 */
  const refitRef = useRef<(() => void) | null>(null);
  /** 聚焦的入口（连接 effect 闭包里的 `term.focus()`）：断开后置 null。 */
  const focusRef = useRef<(() => void) | null>(null);
  /** 上一次生效的可见性（判断 false → true 的那一跳）。 */
  const wasActiveRef = useRef(active);
  /**
   * 隐藏时记下的滚动位置：**距底部多少行**（不是绝对的 viewportY）。
   *
   * 绝对行号会在隐藏期间有新输出时漂移：缓冲区往下长，同一个绝对行号对应的
   * 内容已经变了。记「距底部行数」才能跟住原来那段输出。
   */
  const scrollRef = useRef<number | null>(null);
  /** 已消费到的焦点回填请求序号（一次请求只回填一次）。 */
  const consumedFocusRef = useRef(0);
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

    /**
     * attach 帧发过了吗（每条连接各自一份）。
     *
     * **attach 必须是第一个控制帧**：服务端拿它对齐尺寸，再导出屏幕快照。
     * 在这之前发出去的 resize 帧一律空转（否则尺寸帧会抢在 attach 前面到，
     * 服务端会先按旧尺寸改一轮）。
     */
    let attachSent = false;
    /**
     * 本次连接收到的快照分片（按序号累积）。
     *
     * 服务端按 48 KiB 原文（base64 后约 64 KiB）分片下发，集齐后才拼成完整的恢复流。
     */
    let snapshotParts = new Map<number, Extract<TerminalFrame, { type: 'snapshot' }>>();
    /**
     * 本次连接收到过快照分片了吗（降级兜底的判据）。
     *
     * 只要见到**任何一片**就算快照路径已生效：分片可能还没集齐，但服务端显然
     * 会走快照恢复，不该再补两步 resize。
     */
    let snapshotSeen = false;
    /** attach 之后等快照分片的定时器（超时走降级兜底）。 */
    let snapshotFallbackTimer: number | null = null;

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
    // 实例入口：可见性切换（refit）与焦点回填（focus）都在 effect 之外发生，
    // 通过这三个引用拿到连接闭包里的能力。
    termRef.current = term;
    focusRef.current = (): void => {
      term.focus();
    };

    /**
     * 接管 OSC 1337（shell integration 的 pwd 上报）。
     *
     * 用 xterm 自己的状态机接序列：**不手写字节流扫描器**——一条 OSC 可能被拆到
     * 两帧里（跨帧边界由 xterm 的状态机兜底），这里只处理「补齐之后」送来的整条载荷。
     *
     * 载荷解析口径在 `src/lib/terminal-pwd.ts`（纯函数 + 单元测试）：剥 `CurrentDir=`
     * 前缀 → 绝对路径校验 → 过既有 `normalizeContainerPath`。
     */
    const oscDisposable = term.parser.registerOscHandler(
      OSC_CURRENT_DIR_IDENT,
      (payload: string) => {
        const path = parseCurrentDirPayload(payload);
        if (path === null) {
          // 不认识的载荷 / 非法路径：静默忽略。`dash` / `sh` 会话根本不上报，
          // 那是设计内的降级（前端据此判定「会话未上报工作目录」），不该报错。
          return false;
        }
        // pwd 是**纯前端产物**：按会话记在前端内存里（后端会话记录不加字段）。
        setSessionPwd(sessionId, path);
        return true;
      },
    );

    /**
     * 焦点回填：**不在这里做**。
     *
     * 实例常驻之后，焦点回填由「请求序号」驱动（见组件层的 `focusRequestId`
     * effect）：挂载那一刻不再无条件回填。
     */

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

    const sendResize = (cols: number = term.cols, rows: number = term.rows): void => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (!attachSent) {
        // attach 还没发：尺寸帧一律空转（attach 必须是第一个控制帧）
        return;
      }
      socket.send(encodeResize(cols, rows));
    };

    /** 取消「等快照」的降级定时器。 */
    const cancelSnapshotFallback = (): void => {
      if (snapshotFallbackTimer !== null) {
        window.clearTimeout(snapshotFallbackTimer);
        snapshotFallbackTimer = null;
      }
    };

    /**
     * 降级兜底：用一次「尺寸真变化」把 readline 的提示符（连同 OSC 1337 pwd）
     * 逼出来。
     *
     * 依据 01 轮实测：readline 收到 SIGWINCH 后**只在尺寸真的变了**时才重绘提示符
     * ——同尺寸的 resize 实测 0 字节；尺寸真变了就会重绘，并顺带重新带一条
     * OSC 1337（拿到新鲜的 pwd）。
     *
     * 基准取**当前终端尺寸**（不是 hello 帧里的旧尺寸）：attach 已经把会话对齐到
     * 前端尺寸，用旧尺寸当基准会把 pty 尺寸改回去。两步的净效果是尺寸不变。
     * 列数上限 1000（后端超限会回「窗口大小参数非法」）：顶到上限时往下挪一格，
     * 同样能让尺寸真变化。
     */
    const refreshPwdByResize = (): void => {
      const baseCols = term.cols;
      const baseRows = term.rows;
      const bumped = baseCols >= 1000 ? baseCols - 1 : baseCols + 1;
      sendResize(bumped, baseRows);
      sendResize(baseCols, baseRows);
    };

    /**
     * 安排降级兜底：attach 发出去后等一个窗口，期间没有快照分片才补两步 resize。
     *
     * 收到快照分片、连接关掉、组件卸载都会让这次检查变成空操作（见调用点与
     * `cancelSnapshotFallback`）。
     */
    const scheduleSnapshotFallback = (): void => {
      cancelSnapshotFallback();
      snapshotFallbackTimer = window.setTimeout(() => {
        snapshotFallbackTimer = null;
        if (disposed || finished || gaveUp) {
          return;
        }
        if (snapshotSeen) {
          // 服务端走了快照路径：pwd 由快照帧带回，不做兜底。
          return;
        }
        if (!attachSent || !socket || socket.readyState !== WebSocket.OPEN) {
          return;
        }
        refreshPwdByResize();
      }, SNAPSHOT_FALLBACK_MS);
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

    // 重新量尺寸的入口：变可见时（display:none 下量不到尺寸）由外部调一次。
    refitRef.current = safeFit;

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

      // 新的一条连接 ⇒ 握手重来一遍（attach 重发、快照分片重新累积）
      attachSent = false;
      snapshotParts = new Map();
      snapshotSeen = false;
      cancelSnapshotFallback();

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
        // **不发任何帧**：attach 必须是第一个控制帧，它要等 hello 里的会话尺寸。
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
            // 尺寸自适应（前端视宽 → 会话尺寸）：先 fit 一次拿到真实行列数
            safeFit();
            const cols = term.cols;
            const rows = term.rows;
            if (socket && socket.readyState === WebSocket.OPEN) {
              // 标记置位与真正的发送放在同一个分支里：连接不是 OPEN 时什么都没发
              // 出去，不能把「已发」先记上（否则尺寸帧会在没 attach 的连接上空转）。
              attachSent = true;
              // **attach 必须是第一个控制帧**：报自己的窗口大小，
              // 服务端据此对齐会话尺寸，再导出屏幕快照。
              socket.send(encodeAttach(cols, rows));
              // 第二帧 resize：兼容旧后端（它不认 attach，只会处理 resize）。
              socket.send(encodeResize(cols, rows));
              // 降级兜底：窗口内没等到快照分片就补两步 resize（旧后端 / 模拟器关闭）。
              scheduleSnapshotFallback();
            }
            return;
          }
          if (frame.type === 'snapshot') {
            // 快照分片：集齐 parts 才拼（缺一片宁可不写，也不写半截画面）
            // 收到任何一片 ⇒ 服务端走的是快照路径，降级兜底不再做。
            snapshotSeen = true;
            cancelSnapshotFallback();
            snapshotParts.set(frame.part, frame);
            const total = frame.parts;
            if (snapshotParts.size < total) {
              return;
            }
            const parts = [...snapshotParts.values()];
            snapshotParts = new Map();
            const bytes = decodeSnapshotParts(parts);
            if (bytes === null) {
              // 拼不出来（缺片 / 重复 / 非法 base64）：丢弃，不写
              return;
            }
            // 几何必须对齐：恢复流按字面换行相对定位，尺寸不一致画面就错位
            if (term.cols !== frame.cols || term.rows !== frame.rows) {
              term.resize(frame.cols, frame.rows);
            }
            // 先 reset（清掉旧画面与旧模式），再重放恢复流
            term.reset();
            term.write(bytes);
            // pwd：快照带着最近一条 OSC 1337 载荷，按既有口径校验后落库
            if (frame.pwd) {
              const path = parseCurrentDirPayload(frame.pwd);
              if (path !== null) {
                setSessionPwd(sessionId, path);
              }
            }
            return;
          }
          if (frame.type === 'exit') {
            finished = true;
            // 会话**真的结束**了 ⇒ 这条会话的 pwd 缓存作废。
            // 注意：只在**会话结束**时清——组件卸载（切标签）时会话还活着，
            // 那时清会把还活着的会话的 pwd 弄丢。
            clearSessionPwd(sessionId);
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
            if (isUnknownAttachMessage(frame.message)) {
              // 旧后端不认 attach 帧（兼容探测）：**静默豁免**——
              // 不弹提示、不改状态（那条报错不是故障）。
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
      cancelSnapshotFallback();
      fitDebouncer.cancel();
      observer.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      oscDisposable.dispose();
      socket?.close();
      fitAddon.dispose();
      term.dispose();
      // 入口随连接一起失效：别把焦点塞进一个已经拆掉的终端。
      termRef.current = null;
      refitRef.current = null;
      focusRef.current = null;
    };
  }, [sessionId, retryToken]);

  /**
   * 可见性切换：变可见时补一次尺寸自适应，变隐藏时记下滚动位置。
   *
   * **变可见必须 refit**：隐藏态是 `display:none`，xterm 量不到尺寸
   * （fit 会算出 0 列），不补这一次就会出现「显示出来的是旧尺寸」。
   *
   * **滚动位置还原按相对口径**（记「距底部行数」，不是绝对 viewportY）：
   * 隐藏期间终端仍在收输出，缓冲区会往下长；用绝对行号还原会落到别的内容上。
   * 记 `baseY - viewportY`，变可见时按「当前 baseY − 距底部行数」定位；
   * 原本就在底部（距底部 0 行）则 scrollToBottom（跟着新输出回到底部）。
   * jsdom 里测不了（没有真实布局与滚动），**真机验证口径**：在一个有滚动的
   * 会话里往上翻几页 → 切到别的标签 → 切回来 ⇒ 视口停在**同样几行之前**
   * （距离底部不变，而不是跳回底部或跳到别的绝对行）。
   * 还原失败也不影响终端可用性（位置是锦上添花）。
   */
  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    if (wasActive === active) {
      return;
    }
    if (!active) {
      // 变隐藏：记下当前视口距离底部多少行。
      const term = termRef.current;
      if (term) {
        try {
          const buffer = term.buffer.active;
          scrollRef.current = buffer.baseY - buffer.viewportY;
        } catch {
          scrollRef.current = null;
        }
      }
      return;
    }
    // 变可见：rAF 里等布局落定（display:none → block 的那一帧）再量尺寸。
    window.requestAnimationFrame(() => {
      const term = termRef.current;
      refitRef.current?.();
      if (!term) {
        return;
      }
      const fromBottom = scrollRef.current;
      if (fromBottom === null) {
        return;
      }
      try {
        const buffer = term.buffer.active;
        if (fromBottom <= 0) {
          // 原来停在底部：隐藏期间有新输出 ⇒ 跟着回到底部。
          term.scrollToBottom();
        } else {
          // 距底部行数不变 ⇒ 原来的那段输出仍在视口里（隐藏期间的新输出在它下面）。
          const targetY = Math.max(0, buffer.baseY - fromBottom);
          term.scrollLines(targetY - buffer.viewportY);
        }
      } catch {
        // 还原失败就算了：终端照样能用。
      }
      scrollRef.current = null;
    });
  }, [active]);

  /**
   * 焦点回填：**按请求序号消费**。
   *
   * - 序号 >0 且与上次消费到的不同 ⇒ 消费一次（一次请求只回填一次）；
   * - 只在**可见**时回填：隐藏的终端抢焦点是错的；
   * - rAF：等布局落定再聚焦（xterm 的 helper 文本框此刻才在正确的位置）；
   * - 重连 / 重试不重放旧请求（依赖项里没有 `retryToken`）。
   */
  useEffect(() => {
    if (focusRequestId <= 0 || focusRequestId === consumedFocusRef.current) {
      return;
    }
    if (!active) {
      return;
    }
    consumedFocusRef.current = focusRequestId;
    window.requestAnimationFrame(() => {
      focusRef.current?.();
    });
  }, [focusRequestId, active]);

  return (
    /*
     * 终端表面分两层：
     *
     * - 外层（视觉层）：圆角、边框、内边距、深色底都在这一层，**不滚动**
     *   （overflow-hidden）——外层一旦能滚，就会多出一根原生滚动条。
     * - 内层（测量 / 挂载层）：无内边距、无边框的空盒，xterm 挂在这里。
     *   fit 量的是父容器的**边框盒**且只减终端元素自身的 padding，
     *   放在这一层才量得到真实可用空间（外层的 padding 与 border 不再被漏算）。
     *
     * 右缘直角（文件窗格贴上来时）由 TerminalPanel 外层任意变体覆盖实现（[&_[data-testid=page-sandbox-detail-terminal-surface]]:rounded-r-none 盖掉这里的 rounded-xl 右侧），见 TerminalPanel.tsx:709-716。
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
