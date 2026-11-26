/** OSC 52 与系统剪贴板之间的纯数据转换。 */

/** OSC 52 允许处理的 UTF-8 字节数上限。 */
export const OSC52_MAX_BYTES = 64 * 1024;
/**
 * OSC 52 字节上限对应的最大 canonical base64 长度。
 *
 * 先按编码长度拦截，避免超长但合法的 base64 在 atob / Uint8Array.from
 * 之前先消耗解码时间与内存；解码后仍会按实际字节数做二次校验。
 */
export const OSC52_MAX_BASE64_LENGTH = Math.ceil(OSC52_MAX_BYTES / 3) * 4;

export interface Osc52Payload {
  /** OSC 52 的选择区标识（本轮只由组件消费 `c`）。 */
  selection: string;
  /** `set` 写系统剪贴板，`query` 查询系统剪贴板。 */
  operation: 'set' | 'query';
  /** set 操作的严格 base64 数据；query 操作没有数据。 */
  data: string | null;
}

/**
 * 解析 xterm OSC handler 可能收到的两种参数形态：`c;data` 与 `52;c;data`。
 * 这里只做参数分割；选择区过滤和 base64 / UTF-8 校验由调用方继续完成。
 */
export function parseOsc52Payload(payload: string): Osc52Payload | null {
  if (typeof payload !== 'string') {
    return null;
  }
  const params = payload.startsWith('52;') ? payload.slice(3) : payload;
  const separator = params.indexOf(';');
  if (separator < 1) {
    return null;
  }
  const selection = params.slice(0, separator);
  const encoded = params.slice(separator + 1);
  if (encoded === '?') {
    return { selection, operation: 'query', data: null };
  }
  return { selection, operation: 'set', data: encoded };
}

/** 字节数组转 canonical base64。 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * 严格解码 base64。
 *
 * `atob` 对部分错误 padding 会接受，因此先校验字符 / 长度 / padding，再用
 * canonical re-encode 拒绝未归零的 padding bits。
 */
export function decodeOsc52Base64(encoded: string): Uint8Array | null {
  if (
    typeof encoded !== 'string' ||
    encoded.length % 4 !== 0 ||
    encoded.length > OSC52_MAX_BASE64_LENGTH
  ) {
    return null;
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    return null;
  }
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length > OSC52_MAX_BYTES || bytesToBase64(bytes) !== encoded) {
    return null;
  }
  return bytes;
}

/** base64 → UTF-8 文本，同时执行严格 base64、UTF-8 与 64 KiB 校验。 */
export function decodeOsc52Text(encoded: string): string | null {
  const bytes = decodeOsc52Base64(encoded);
  if (bytes === null) {
    return null;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** UTF-8 文本 → base64；超出字节上限时返回 null。 */
export function encodeOsc52Text(text: string): string | null {
  if (typeof text !== 'string') {
    return null;
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > OSC52_MAX_BYTES) {
    return null;
  }
  return bytesToBase64(bytes);
}

/** 构造回写 PTY 的 OSC 52 选择区 `c` 响应帧。 */
export function buildOsc52Response(text: string): string | null {
  const encoded = encodeOsc52Text(text);
  if (encoded === null) {
    return null;
  }
  return `\u001b]52;c;${encoded}\u0007`;
}
