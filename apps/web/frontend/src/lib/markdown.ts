/**
 * markdown 渲染前的文本处理纯逻辑：**frontmatter 识别与剥离**。
 *
 * 口径来源：PRD「方案四 · Obsidian tab」——`---` 包裹的 YAML **渲染态隐藏、
 * 源码态可见**。识别规则收敛在这里，渲染组件只调一个函数，单测覆盖各种边界
 * （没闭合 / 不在开头 / 分隔线不是围栏）。
 *
 * 不碰 DOM、不碰网络；也不做 YAML 解析（frontmatter 只隐藏、不消费）。
 */

/** frontmatter 的围栏（YAML 文档起始标记，独占一行）。 */
const FRONTMATTER_FENCE = '---';

/** 拆分结果：`frontmatter` 为 `null` 表示这不是一个带 frontmatter 的文件。 */
export interface MarkdownFrontmatterSplit {
  /**
   * frontmatter 原文（**含两条 `---` 围栏**，不含闭合围栏之后的换行）。
   *
   * 没有 frontmatter 时为 `null`。源码态直接把它连同 `body` 一起显示即可。
   */
  frontmatter: string | null;
  /** 去掉 frontmatter 之后的正文（渲染态用；没有 frontmatter 时是原文）。 */
  body: string;
}

/** 一行是不是 frontmatter 围栏（允许行尾空白与 CR，**不允许别的字符**）。 */
function isFenceLine(line: string): boolean {
  return line.replace(/\r$/, '').trimEnd() === FRONTMATTER_FENCE;
}

/**
 * 识别并剥离文件开头的 YAML frontmatter。
 *
 * 识别规则（逐条都有单测钉着）：
 *
 * - **必须以 `---` 开头才算**：`text` 的第一个字符就是围栏的第一个字符
 *   （前面的空行、BOM 之外的任何内容都不算）；
 * - **首行必须整行都是 `---`**：`----`、`--- title` 都不是围栏；
 * - **必须有闭合围栏**：后面再找不到独占一行的 `---` ⇒ **不识别**（整段仍是
 *   正文，不会把整个文件吞掉）；
 * - 围栏前后允许行尾空白与 CRLF；正文从闭合围栏那一行的换行之后开始。
 */
export function splitFrontmatter(text: string): MarkdownFrontmatterSplit {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const unchanged: MarkdownFrontmatterSplit = { frontmatter: null, body: text };
  if (!source.startsWith(FRONTMATTER_FENCE)) {
    return unchanged;
  }

  // 首行（到换行为止）。
  const firstNewline = source.indexOf('\n');
  if (firstNewline < 0) {
    // 整个文件只有一行：不可能有闭合围栏。
    return unchanged;
  }
  if (!isFenceLine(source.slice(0, firstNewline))) {
    return unchanged;
  }

  // 逐行找闭合围栏。
  let lineStart = firstNewline + 1;
  while (lineStart <= source.length) {
    const lineEnd = source.indexOf('\n', lineStart);
    const line = lineEnd < 0 ? source.slice(lineStart) : source.slice(lineStart, lineEnd);
    if (isFenceLine(line)) {
      // frontmatter 原文不含闭合围栏之后的换行（也不留 CR），调用方拼接时自己加。
      const rawEnd = lineEnd < 0 ? source.length : lineEnd;
      const frontmatterEnd = source[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd;
      const bodyStart = lineEnd < 0 ? source.length : lineEnd + 1;
      return {
        frontmatter: source.slice(0, frontmatterEnd),
        body: source.slice(bodyStart),
      };
    }
    if (lineEnd < 0) {
      break;
    }
    lineStart = lineEnd + 1;
  }

  // 没有闭合围栏：**不识别**（按无 frontmatter 处理）。
  return unchanged;
}

/**
 * 渲染用正文：剥掉 frontmatter 之后的 markdown。
 *
 * 顺带去掉正文开头的空行——渲染态里那段空白只会把标题往下推。
 */
export function markdownBodyForRender(text: string): string {
  return splitFrontmatter(text).body.replace(/^(?:[ \t]*\r?\n)+/, '');
}
