/**
 * 终端快照（VT 恢复流）的解码。
 *
 * **快照是什么**：服务端常驻一份终端模拟器（pyghostty），与容器内的输出
 * 并行跑；浏览器附着时，服务端把「当前屏幕 + 光标 + 终端模式」导成一份
 * VT 恢复流，按 48 KiB 原文分片（base64 后约 64 KiB）、装在文本帧里下发
 * （`snapshot` 帧）。
 * 前端把它喂回 xterm，画面与模式一次性恢复——**不是历史回放**。
 *
 * **为什么不是历史回放**：历史字节里有终端探测（kitty 键盘查询、DA1、
 * 主题色查询）。回放历史时，新建的 xterm 实例会把这些探测当新请求**再答
 * 一遍**，应答经 WS 写进 PTY 输入 ⇒ 程序退出后 shell 把应答当键盘输入回显
 * 成乱码。快照里只有「画面 + 模式」，没有探测 ⇒ 不会再有应答。
 *
 * **几何必须对齐**：恢复流是「按字面换行相对定位」的，重放端的 rows/cols
 * 与快照不一致，画面就错位。调用方负责先 `term.resize(cols, rows)` 再写。
 *
 * 纯函数，不碰 DOM、不碰网络：解码口径收敛在本文件，可单测。
 */

/** 一片快照（与服务端下发的 snapshot 帧一一对应）。 */
export interface SnapshotPart {
  /** 本片的序号（从 0 起）。 */
  part: number;
  /** 总片数。 */
  parts: number;
  /** 本片的 base64 载荷。 */
  data: string;
  /** 快照的列数（重放端必须与它一致）。 */
  cols: number;
  /** 快照的行数（重放端必须与它一致）。 */
  rows: number;
  /** 最近一条 OSC 1337 载荷（工作目录上报；可空）。 */
  pwd: string | null;
}

/**
 * base64 → 字节。
 *
 * 解不了（不是字符串、含非法字符）返回 `null`；**空串是合法的**（解出空数组）。
 */
export function base64ToBytes(text: string): Uint8Array | null {
  if (typeof text !== 'string') {
    return null;
  }
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * 把分片拼成完整的恢复流。
 *
 * 返回 `null` 的情形（**一律丢弃，不写半截画面**）：
 *
 * - 没有分片；
 * - 片数与 `parts` 对不上（缺片）；
 * - 各分片的 `parts` / `cols` / `rows` 不一致（不是同一份快照）；
 * - 序号重复；
 * - 序号越界或不是整数；
 * - 某一片的 base64 非法。
 */
export function decodeSnapshotParts(parts: SnapshotPart[]): Uint8Array | null {
  if (!Array.isArray(parts) || parts.length === 0) {
    return null;
  }
  const total = parts[0].parts;
  const expectedCols = parts[0].cols;
  const expectedRows = parts[0].rows;
  if (!Number.isInteger(total) || total <= 0) {
    return null;
  }
  if (parts.length !== total) {
    // 缺片：宁可不写，也不写半截画面
    return null;
  }
  const ordered = [...parts].sort((left, right) => left.part - right.part);
  const chunks: Uint8Array[] = [];
  const seen = new Set<number>();
  for (const item of ordered) {
    if (item.parts !== total || item.cols !== expectedCols || item.rows !== expectedRows) {
      // 分片间元数据不一致：这不是同一份快照（片数/几何对不上）
      return null;
    }
    if (!Number.isInteger(item.part) || item.part < 0 || item.part >= total) {
      return null;
    }
    if (seen.has(item.part)) {
      // 序号重复：拼出来的内容不可信
      return null;
    }
    seen.add(item.part);
    const bytes = base64ToBytes(item.data);
    if (bytes === null) {
      return null;
    }
    chunks.push(bytes);
  }
  let length = 0;
  for (const chunk of chunks) {
    length += chunk.length;
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}
