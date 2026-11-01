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

/** 终端连接的地址：同源，页面在 https 下自动用 wss。 */
export function terminalSocketUrl(
  sessionId: string,
  location: { protocol: string; host: string },
): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/api/terminal/sessions/${encodeURIComponent(sessionId)}`;
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
