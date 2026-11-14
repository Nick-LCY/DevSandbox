/**
 * 文件窗格**文本预览**的纯逻辑：大文件判定、预览返回栈、行号切分。
 *
 * 这里不碰 DOM、不碰网络：面板组件只负责把结果画出来（口径见
 * `docs/prds/file-pane-obsidian.md` 方案一「预览 = 窗格内的第二视图」）。
 */

/* -------------------------------------------------------------- 大文件判定 */

/**
 * 「大文件」阈值：**2 MB**（`2 * 1024 * 1024` 字节）。
 *
 * 判定依据是**文件列表条目的 `size` 字段**（int 字节数），不是下载到的字节数
 * ——决策要在**发请求之前**做（大文件先弹二次确认）。
 *
 * 单位口径跟 `formatFileSize` 一致（1024 进制），否则界面显示「2.0 MB」的文件
 * 与判定阈值会对不上。
 */
export const PREVIEW_LARGE_FILE_BYTES = 2 * 1024 * 1024;

/**
 * 是否走「大文件预览」流程（**二次确认 + 进度条 + 全文渲染**）。
 *
 * **严格大于**阈值才算大文件（PRD 写的是「超过 2 MB」）：恰好 2 MB 的文件直接
 * 加载、不弹确认。`size` 缺失 / 非法（`null` / `NaN` / 负数）一律按**小文件**
 * 处理——拿不到大小时不该用一个弹窗挡住用户，走「先读了再说」的默认路径。
 */
export function isLargePreviewFile(size: number | null | undefined): boolean {
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    return false;
  }
  return size > PREVIEW_LARGE_FILE_BYTES;
}

/* ---------------------------------------------------------------- 预览栈 */

/** 一次预览的目标（点「预览」那一刻的快照）。 */
export interface PreviewTarget {
  /** 容器内绝对路径。 */
  path: string;
  /** 文件名（工具条标题用）。 */
  name: string;
  /** 列表条目的字节数（大文件判定与进度条分母）。 */
  size: number;
}

/** 预览栈的动作。 */
export type PreviewStackAction =
  | { type: 'push'; target: PreviewTarget }
  | { type: 'pop' }
  | { type: 'clear' };

/**
 * 预览返回栈的 reducer（**纯函数、不原地改**）。
 *
 * 口径（PRD PV-02）：
 *
 * - **栈空 = 列表态**（窗格里显示目录列表，返回钮隐藏）；
 * - `push` 进下一层预览（同一路径重复点击也照样压栈——它是「返回栈」不是
 *   「路径去重集合」，返回一次就退回上一层）；
 * - `pop` 退回上一层；**栈空时 pop 保持空**（不抛错、不变成负数）；
 * - `clear` 清栈（点面包屑 / 换目录 / 换沙箱 / 卸载）。
 */
export function previewStackReducer(
  state: readonly PreviewTarget[],
  action: PreviewStackAction,
): PreviewTarget[] {
  switch (action.type) {
    case 'push':
      return [...state, action.target];
    case 'pop':
      return state.length === 0 ? [] : state.slice(0, -1);
    case 'clear':
      // 已经空着就复用同一个引用（省一次重渲染）
      return state.length === 0 ? (state as PreviewTarget[]) : [];
    default:
      return state as PreviewTarget[];
  }
}

/** 当前预览目标（栈顶）；栈空（列表态）返回 `null`。 */
export function currentPreview(
  state: readonly PreviewTarget[],
): PreviewTarget | null {
  return state.length === 0 ? null : state[state.length - 1];
}

/* ---------------------------------------------------------------- 行号槽 */

/**
 * 把预览正文切成行（行号槽逐行对齐用）。
 *
 * 口径：
 *
 * - 只按 `\n` 切，行尾的 `\r`（CRLF 文件）去掉——否则 jsdom / 浏览器里每行末尾
 *   会多一个不可见的回车符，复制出来的内容与原文不一致；
 * - **末尾换行不算多一行**（`"a\n"` ⇒ `['a']`）：编辑器与 `cat` 的行号习惯如此；
 * - 空文本 ⇒ `[]`（不画行号槽，直接是空正文）；
 * - **空行保留**（`"a\n\nb"` ⇒ `['a', '', 'b']`）：行号必须与原文对得上。
 */
export function splitPreviewLines(text: string): string[] {
  if (text === '') {
    return [];
  }
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (normalized === '') {
    // 只有一个换行（`"\n"`）：一行空内容。
    return [''];
  }
  return normalized.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}
