/**
 * 网页终端的帧协议。
 *
 * 与后端 `apps/web/backend/src/sandbox_console/routes/terminal.py` 对齐：
 *
 * - 客户端 → 服务端：二进制帧 = 终端输入字节；文本帧 = `{"type":"resize","cols":..,"rows":..}`
 * - 服务端 → 客户端：二进制帧 = 终端输出字节；文本帧 = `hello` / `exit` / `error`
 */

/** 服务端发来的文本帧。 */
export type TerminalFrame =
  | { type: 'hello'; sessionId: string; sandbox: string; cols: number; rows: number }
  | { type: 'exit'; code: number | null; reason: string | null }
  | { type: 'error'; message: string }
  | { type: 'unknown'; raw: string };

/** 会话失效时服务端用的关闭码（策略违规：客户端拿着一个失效的会话标识）。 */
export const CLOSE_CODE_UNKNOWN_SESSION = 1008;

/** 会话失效的提示文案（服务端重启会让全部会话失效）。 */
export const SESSION_INVALID_MESSAGE = '终端会话已失效（后端服务已重启），请新建终端';

/**
 * 终端连接的地址推导输入。
 *
 * - `baseUrl`：连接配置里的后端基址。**空串 = 同源**（web 形态：后端托管前端，
 *   终端与页面同源）。
 * - `origin`：页面自身的位置（基址为空时用它推导协议与主机，web 形态行为不变）。
 */
export interface TerminalSocketTarget {
  /** 后端基址（空串 = 同源）。 */
  baseUrl: string;
  /** 页面自身位置。 */
  origin: { protocol: string; host: string };
}

/**
 * 把后端基址换成 WebSocket 基址：`http→ws` / `https→wss`。
 *
 * 解析不了（空串 / 非法地址 / 不认识的 scheme）时返回 null，由调用方决定
 * 怎么办（**不许静默回落到同源**：那会把「连错了地址」变成「连到了别的地方」）。
 *
 * **不保留基址里的路径**：基址只表示「主机 + 端口」（带路径的基址由
 * `validateBaseUrl` 拦掉），与 HTTP 侧的口径一致。
 */
export function toWebSocketBase(baseUrl: string): string | null {
  const text = baseUrl.trim();
  if (text === '') {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  let scheme: string;
  if (parsed.protocol === 'http:') {
    scheme = 'ws:';
  } else if (parsed.protocol === 'https:') {
    scheme = 'wss:';
  } else if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
    scheme = parsed.protocol;
  } else {
    return null;
  }
  return `${scheme}//${parsed.host}`;
}

/** 终端 WS 基址的推导结果。 */
export type TerminalSocketBase =
  | { ok: true; base: string }
  /** 推导不出来（原因：基址非法 / 页面位置不可用）。 */
  | { ok: false; reason: 'invalid-base' | 'invalid-origin' };

/**
 * 终端连接的 WS 基址。
 *
 * - 基址非空：按基址推导（`http→ws` / `https→wss`），桌面形态连远端后端走这条。
 *   **推导不出来就说推导不出来**（`ok: false`），不回落页面同源——回落会把
 *   「连错了地址」变成「连到了别的地方」，用户看到的现象是「连上了但不是那台后端」。
 * - 基址为空：按页面位置推导（同源），**web 形态行为零变化**。
 */
export function resolveTerminalSocketBase(target: TerminalSocketTarget): TerminalSocketBase {
  const base = target.baseUrl.trim();
  if (base !== '') {
    const derived = toWebSocketBase(base);
    if (derived === null) {
      return { ok: false, reason: 'invalid-base' };
    }
    return { ok: true, base: derived };
  }
  const protocol = target.origin.protocol;
  const host = target.origin.host;
  if (!protocol || !host) {
    return { ok: false, reason: 'invalid-origin' };
  }
  return { ok: true, base: `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}` };
}

/**
 * 终端连接的地址。
 *
 * - 基址非空：按基址推导（`http→ws` / `https→wss`），桌面形态连远端后端走这条；
 * - 基址为空：按页面位置推导（同源），**web 形态行为零变化**；
 * - 推导不出来（基址非法等）：返回 **null**，由调用方进「连接地址非法」状态
 *   （不猜一个地址连上去）；
 * - 票据：浏览器发起的 WebSocket 不能设请求头，握手靠 `?ticket=`（一次性票据，
 *   每次连接 / 重连前现取，不缓存）。
 */
export function terminalSocketUrl(
  sessionId: string,
  target: TerminalSocketTarget,
  ticket?: string,
): string | null {
  const resolved = resolveTerminalSocketBase(target);
  if (!resolved.ok) {
    return null;
  }
  const url = `${resolved.base}/api/terminal/sessions/${encodeURIComponent(sessionId)}`;
  return ticket ? `${url}?ticket=${encodeURIComponent(ticket)}` : url;
}

/** 解析服务端发来的文本帧。非法 JSON 一律当成未知帧，不让协议错误打断终端。 */
export function parseTerminalFrame(text: string): TerminalFrame {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { type: 'unknown', raw: text };
  }
  if (typeof payload !== 'object' || payload === null) {
    return { type: 'unknown', raw: text };
  }

  const record = payload as Record<string, unknown>;
  const kind = record.type;
  if (kind === 'hello') {
    return {
      type: 'hello',
      sessionId: typeof record.session_id === 'string' ? record.session_id : '',
      sandbox: typeof record.sandbox === 'string' ? record.sandbox : '',
      cols: typeof record.cols === 'number' ? record.cols : 80,
      rows: typeof record.rows === 'number' ? record.rows : 24,
    };
  }
  if (kind === 'exit') {
    return {
      type: 'exit',
      code: typeof record.code === 'number' ? record.code : null,
      // 结束原因（服务端旧版本可能不带）：缺失一律当 null，不做推测。
      reason: typeof record.reason === 'string' ? record.reason : null,
    };
  }
  if (kind === 'error') {
    return {
      type: 'error',
      message: typeof record.message === 'string' ? record.message : '终端会话异常',
    };
  }
  return { type: 'unknown', raw: text };
}

/** 生成窗口大小同步帧。 */
export function encodeResize(cols: number, rows: number): string {
  return JSON.stringify({ type: 'resize', cols, rows });
}

/** 判断一条错误帧是不是「会话已失效」。 */
export function isSessionInvalidMessage(message: string): boolean {
  return message.includes('会话不存在') || message.includes('已失效');
}
