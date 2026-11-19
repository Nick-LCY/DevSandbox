/**
 * 网页终端的帧协议。
 *
 * 与后端 `apps/web/backend/src/sandbox_console/routes/terminal.py` 对齐：
 *
 * - 客户端 → 服务端：二进制帧 = 终端输入字节；文本帧 =
 *   `{"type":"attach","cols":..,"rows":..}`（**第一个控制帧**：报自己的窗口大小）
 *   与 `{"type":"resize","cols":..,"rows":..}`；
 * - 服务端 → 客户端：二进制帧 = 终端输出字节；文本帧 =
 *   `hello` / `snapshot` / `exit` / `error`。
 *
 * **attach 与 snapshot 是新协议的一对**：attach 报尺寸，服务端据此把会话
 * （伪终端 + 终端模拟器）对齐到客户端，再把「屏幕现场」导成一份 VT 恢复流
 * 分片下发（snapshot 帧）；客户端按它恢复画面与终端模式，而不是回放历史
 * 字节。旧后端不认 attach（回一条错误帧）与旧前端不发 attach（服务端超时
 * 后回退到环形缓冲回放）两侧都有兼容。
 */

import { normalizeBaseUrl } from './connection';

/** 服务端发来的文本帧。 */
export type TerminalFrame =
  | { type: 'hello'; sessionId: string; sandbox: string; cols: number; rows: number }
  | { type: 'exit'; code: number | null; reason: string | null }
  | { type: 'error'; message: string }
  | {
      /** 快照分片：VT 恢复流（base64 装在 data 里），按 part/parts 拼。 */
      type: 'snapshot';
      part: number;
      parts: number;
      data: string;
      /** 快照的几何：重放端的 rows/cols 必须与它一致。 */
      cols: number;
      rows: number;
      /** 最近一条 OSC 1337 载荷（工作目录上报；可空）。 */
      pwd: string | null;
    }
  | { type: 'unknown'; raw: string };

/** 会话失效时服务端用的关闭码（策略违规：客户端拿着一个失效的会话标识）。 */
export const CLOSE_CODE_UNKNOWN_SESSION = 1008;

/** 会话失效的提示文案（服务端重启会让全部会话失效）。 */
export const SESSION_INVALID_MESSAGE = '终端会话已失效（后端服务已重启），请新建终端';

/**
 * 终端连接的地址推导输入。
 *
 * - `baseUrl`：连接配置里的后端基址。**恒非空**（默认 `http://127.0.0.1:8000`）。
 *
 * **不再有页面位置（`window.location`）回退**：决策 D 之后「空 = 同源」语义废除，
 * WS 地址恒从基址推导（`http→ws` / `https→wss`）。
 */
export interface TerminalSocketTarget {
  /** 后端基址（恒非空；空值视为非法地址）。 */
  baseUrl: string;
}

/**
 * 主机名里的非 ASCII 字符（如中文）。
 *
 * URL 解析会按 IDNA 把它们编成 punycode（`http://不是地址` →
 * `http://xn--ihqq6tnb086g`）——那是**用户没写过的地址**，不猜。
 */
const NON_ASCII_PATTERN = /[^\x00-\x7F]/;

/**
 * 把后端基址换成 WebSocket 基址：`http→ws` / `https→wss`。
 *
 * 解析不了（空串 / 非法地址 / 不认识的 scheme）时返回 null，由调用方决定
 * 怎么办（**不许静默回落到别处**：那会把「连错了地址」变成「连到了别的地方」）。
 *
 * **入参先过归一层**（`normalizeBaseUrl`，连接层的单一真相源）：补 scheme、
 * 去尾部斜杠。用户填 `10.0.0.5:8000`（漏了 scheme）也能推导出 WS 地址——
 * 与 HTTP 侧（`resolveApiBaseUrl`）一个口径。
 *
 * **不保留基址里的路径**：基址只表示「主机 + 端口」（带路径的基址由
 * `validateBaseUrl` 拦掉），与 HTTP 侧的口径一致。
 */
export function toWebSocketBase(baseUrl: string): string | null {
  const text = baseUrl.trim();
  if (text === '') {
    // 空串按非法处理：**不猜默认地址**（猜了就等于「连到了别的地方」）。
    return null;
  }
  if (NON_ASCII_PATTERN.test(text)) {
    // 主机名带非 ASCII 字符：归一后会变成 punycode 主机（用户没写的地址），不猜。
    return null;
  }
  const normalized = normalizeBaseUrl(text);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
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
  /** 推导不出来（原因：基址非法 / 为空）。 */
  | { ok: false; reason: 'invalid-base' };

/**
 * 终端连接的 WS 基址：**恒从后端基址推导**。
 *
 * - 按基址推导（`http→ws` / `https→wss`），网页形态与桌面形态一个口径。
 * - **推导不出来就说推导不出来**（`ok: false`），不回落页面同源——回落会把
 *   「连错了地址」变成「连到了别的地方」，用户看到的现象是「连上了但不是那台后端」。
 */
export function resolveTerminalSocketBase(target: TerminalSocketTarget): TerminalSocketBase {
  const derived = toWebSocketBase(target.baseUrl);
  if (derived === null) {
    return { ok: false, reason: 'invalid-base' };
  }
  return { ok: true, base: derived };
}

/**
 * 终端连接的地址。
 *
 * - **恒从基址推导**（`http→ws` / `https→wss`），不再按页面位置回退；
 * - 推导不出来（基址为空 / 非法等）：返回 **null**，由调用方进「连接地址非法」
 *   状态（不猜一个地址连上去）；
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
  if (kind === 'snapshot') {
    const part = record.part;
    const parts = record.parts;
    const data = record.data;
    const cols = record.cols;
    const rows = record.rows;
    // 字段缺失或类型不对一律归为未知帧：协议不对不该让终端崩掉。
    if (
      typeof part !== 'number' ||
      typeof parts !== 'number' ||
      typeof data !== 'string' ||
      typeof cols !== 'number' ||
      typeof rows !== 'number'
    ) {
      return { type: 'unknown', raw: text };
    }
    return {
      type: 'snapshot',
      part,
      parts,
      data,
      cols,
      rows,
      pwd: typeof record.pwd === 'string' ? record.pwd : null,
    };
  }
  return { type: 'unknown', raw: text };
}

/** 生成窗口大小同步帧。 */
export function encodeResize(cols: number, rows: number): string {
  return JSON.stringify({ type: 'resize', cols, rows });
}

/**
 * 生成握手帧（**必须是第一个控制帧**）：报自己的窗口大小。
 *
 * 服务端拿它把会话（伪终端 + 终端模拟器）对齐到客户端，再导出屏幕快照。
 */
export function encodeAttach(cols: number, rows: number): string {
  return JSON.stringify({ type: 'attach', cols, rows });
}

/**
 * 服务端不认 attach 帧时的报错文案（旧后端）。
 *
 * 新前端为了兼容旧后端，发完 attach 还会补发一帧 resize；旧后端把 attach
 * 当成未知指令，回一条「无法识别的终端指令：attach」。那**不是故障**：
 * 静默豁免（不弹提示、不改状态）。
 */
export function isUnknownAttachMessage(message: string): boolean {
  return message.includes('无法识别的终端指令') && message.includes('attach');
}

/** 判断一条错误帧是不是「会话已失效」。 */
export function isSessionInvalidMessage(message: string): boolean {
  return message.includes('会话不存在') || message.includes('已失效');
}
