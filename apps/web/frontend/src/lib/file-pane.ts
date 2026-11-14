/**
 * 文件窗格（分屏右侧那一块）的纯逻辑。
 *
 * 口径来源：PRD「方案一 · 文件窗格（分屏）」+ 任务 04「文件窗格分屏骨架」。
 *
 * 这里只放**纯函数**：不碰 DOM、不碰网络、不碰存储。组件层（`TerminalPanel.tsx`
 * 与 `FileBrowserPanel.tsx`）只负责把结果画出来。
 *
 * 收敛的四件事：
 *
 * 1. **分隔条拖拽的宽度钳位**（`clampFilePaneWidth` / `filePaneWidthFromDrag`）：
 *    窗格有最小 / 最大宽度，**终端面板有最小宽度钳位**（拖到最窄时终端不被压没）；
 * 2. **定位 fallback 链**（`resolveFilePaneStartPath`）：会话 pwd → 沙箱 workdir → `/`；
 * 3. **同路径判定**（`isSameContainerPath`）：回跳按钮「已在目标目录」的判据；
 * 4. **入口条件**（`shouldShowFilePane`）：窗格只在「存在终端会话 **且** 激活的是
 *    终端 tab」时存在（06 轮起 Obsidian tab 是另一种 tab，激活它时窗格隐藏）。
 */

import { normalizeContainerPath } from './file-transfer';

/* ------------------------------------------------------------------ 尺寸 */

/** 文件窗格的默认宽度（像素）。 */
export const FILE_PANE_DEFAULT_WIDTH_PX = 340;

/** 折叠态竖条的宽度（像素）：右缘一条纯图标竖条。 */
export const FILE_PANE_COLLAPSED_WIDTH_PX = 36;

/** 文件窗格的最小宽度（像素）：再窄就放不下面包屑与列表了。 */
export const FILE_PANE_MIN_WIDTH_PX = 240;

/** 文件窗格的最大宽度（像素）：再宽就把终端挤没了。 */
export const FILE_PANE_MAX_WIDTH_PX = 720;

/** 终端面板的最小宽度（像素）：拖分隔条时终端不会被压没。 */
export const FILE_PANE_MIN_TERMINAL_WIDTH_PX = 320;

export interface FilePaneWidthOptions {
  /**
   * 内容区（分屏容器）的宽度（像素）。
   *
   * 未知 / 不可用（≤ 0）时**只按窗格自身的最小 / 最大宽度钳位**——
   * 拿不到容器宽度时不能把窗格钳到 0。
   */
  containerWidth?: number | null;
  /** 终端面板的最小宽度（像素）。 */
  minTerminalWidth?: number | null;
}

/**
 * 钳位窗格宽度。
 *
 * 规则（自上而下）：
 *
 * 1. 不是有限数字 ⇒ 回落默认宽度；
 * 2. 下限 = `FILE_PANE_MIN_WIDTH_PX`；
 * 3. 上限 = `min(FILE_PANE_MAX_WIDTH_PX, 容器宽 - 终端最小宽)`
 *    ——**容器宽不可用时上限就是 `FILE_PANE_MAX_WIDTH_PX`**；
 * 4. 容器窄到「装不下最小窗格 + 最小终端」时，**以终端最小宽度优先**：
 *    上限被抬回下限（窗格不再让位，终端自己保底）。
 *
 * 返回值是整数像素（拖拽过程中不出现小数抖动）。
 */
export function clampFilePaneWidth(
  width: number,
  options: FilePaneWidthOptions = {},
): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return FILE_PANE_DEFAULT_WIDTH_PX;
  }
  const minTerminalWidth =
    typeof options.minTerminalWidth === 'number' &&
    Number.isFinite(options.minTerminalWidth) &&
    options.minTerminalWidth > 0
      ? options.minTerminalWidth
      : FILE_PANE_MIN_TERMINAL_WIDTH_PX;

  let max = FILE_PANE_MAX_WIDTH_PX;
  const containerWidth = options.containerWidth;
  if (
    typeof containerWidth === 'number' &&
    Number.isFinite(containerWidth) &&
    containerWidth > 0
  ) {
    max = Math.min(max, containerWidth - minTerminalWidth);
  }
  if (max < FILE_PANE_MIN_WIDTH_PX) {
    // 容器太窄：终端保底，窗格不再让位。
    max = FILE_PANE_MIN_WIDTH_PX;
  }
  const clamped = Math.min(Math.max(width, FILE_PANE_MIN_WIDTH_PX), max);
  return Math.round(clamped);
}

/**
 * 拖拽分隔条时的新窗格宽度。
 *
 * 往**左**拖（指针横坐标变小）⇒ 窗格变宽；往右拖 ⇒ 窗格变窄。
 * 起点宽度与起点指针横坐标一起记（拖拽过程里每帧都从起点算，
 * 免得累加出漂移）。
 */
export function filePaneWidthFromDrag(input: {
  /** 拖拽起点的窗格宽度（像素）。 */
  startWidth: number;
  /** 拖拽起点的指针横坐标（像素）。 */
  startX: number;
  /** 当前指针横坐标（像素）。 */
  pointerX: number;
  /** 内容区宽度（像素）：用来钳位（终端保底）。 */
  containerWidth: number;
  /** 终端面板的最小宽度（像素）。 */
  minTerminalWidth?: number;
}): number {
  const delta = input.startX - input.pointerX;
  return clampFilePaneWidth(input.startWidth + delta, {
    containerWidth: input.containerWidth,
    minTerminalWidth: input.minTerminalWidth,
  });
}

/* ------------------------------------------------------------ 定位与路径 */

export interface FilePaneStartPathInput {
  /** 活动会话上报的工作目录（pwd）；`null` = 该会话没上报。 */
  pwd?: string | null;
  /** 沙箱工作目录（metadata `workdir`）。 */
  workdir?: string | null;
}

/**
 * 窗格的定位 fallback 链：**会话 pwd → 沙箱工作目录 → 容器根目录 `/`**。
 *
 * 取**第一个可得的**：候选值要能过 `normalizeContainerPath`（绝对路径、
 * 不含 NUL、不含 `.` / `..` 段）才算「可得」；都不行时兜底到 `/`。
 *
 * **只算起点**：算出来的路径只用来**首次定位**，之后窗格停在用户最后
 * 导航到的位置（无自动跟随，见 PRD FP-06）。
 */
export function resolveFilePaneStartPath(input: FilePaneStartPathInput): string {
  const candidates = [input.pwd, input.workdir];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const normalized = normalizeContainerPath(candidate);
    if (normalized !== null) {
      return normalized;
    }
  }
  return '/';
}

/**
 * 两个容器内路径是不是同一个目录。
 *
 * 归一后再比（`/a/b` 与 `/a/b/` 是同一个；`/a/./b` 归一成 `/a/b`）。
 * 任一侧非法 ⇒ 不相等（回跳按钮不禁用）。
 */
export function isSameContainerPath(left: string | null, right: string | null): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') {
    return false;
  }
  const a = normalizeContainerPath(left);
  const b = normalizeContainerPath(right);
  if (a === null || b === null) {
    return false;
  }
  return a === b;
}

/* ------------------------------------------------------------ 入口条件 */

/**
 * 工作区 tab 的类型。
 *
 * 06 轮起 tabs 条最左会有一个固定的 Obsidian tab（与终端会话无关）；
 * 本轮只有终端 tab，但**结构先按两种取值搭好**。
 */
export type WorkspaceTabKind = 'terminal' | 'obsidian';

/**
 * 文件窗格要不要出现。
 *
 * 口径（PRD FP-04）：窗格是**终端 tab 的伴生物**——
 * 只有「存在终端会话」**且**「激活的是终端 tab」时才存在。
 */
export function shouldShowFilePane(input: {
  /** 当前激活的 tab 类型。 */
  tabKind: WorkspaceTabKind;
  /** 有没有激活的终端会话。 */
  hasActiveSession: boolean;
}): boolean {
  return input.tabKind === 'terminal' && input.hasActiveSession;
}
