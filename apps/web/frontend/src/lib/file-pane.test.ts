/**
 * 文件窗格纯逻辑的单元测试。
 *
 * 覆盖四块：
 * - 分隔条拖拽的宽度钳位（窗格最小 / 最大宽 + 终端最小宽度保底）；
 * - 定位 fallback 链（会话 pwd → 沙箱 workdir → `/`）；
 * - 同路径判定（回跳按钮「已在目标目录」的判据）；
 * - 入口条件（窗格只在「有终端会话 **且** 激活终端 tab」时存在）。
 */
import { describe, expect, it } from 'vitest';

import {
  FILE_PANE_COLLAPSED_WIDTH_PX,
  FILE_PANE_DEFAULT_WIDTH_PX,
  FILE_PANE_MAX_WIDTH_PX,
  FILE_PANE_MIN_TERMINAL_WIDTH_PX,
  FILE_PANE_MIN_WIDTH_PX,
  OBSIDIAN_PREVIEW_MIN_WIDTH_PX,
  OBSIDIAN_TREE_DEFAULT_WIDTH_PX,
  OBSIDIAN_TREE_MAX_WIDTH_PX,
  OBSIDIAN_TREE_MIN_WIDTH_PX,
  clampFilePaneWidth,
  clampObsidianTreeWidth,
  filePaneWidthFromDrag,
  isSameContainerPath,
  obsidianTreeWidthFromDrag,
  resolveFilePaneStartPath,
  shouldShowFilePane,
} from './file-pane';

describe('窗格宽度钳位', () => {
  it('默认宽度是 340、折叠竖条 36', () => {
    expect(FILE_PANE_DEFAULT_WIDTH_PX).toBe(340);
    expect(FILE_PANE_COLLAPSED_WIDTH_PX).toBe(36);
    expect(FILE_PANE_MIN_WIDTH_PX).toBe(240);
    expect(FILE_PANE_MAX_WIDTH_PX).toBe(720);
    expect(FILE_PANE_MIN_TERMINAL_WIDTH_PX).toBe(320);
  });

  it('默认宽度原样通过（不被动钳位）', () => {
    expect(clampFilePaneWidth(FILE_PANE_DEFAULT_WIDTH_PX)).toBe(340);
  });

  it('小于最小宽度 ⇒ 收到最小宽度', () => {
    expect(clampFilePaneWidth(10)).toBe(FILE_PANE_MIN_WIDTH_PX);
    expect(clampFilePaneWidth(0)).toBe(FILE_PANE_MIN_WIDTH_PX);
    expect(clampFilePaneWidth(-100)).toBe(FILE_PANE_MIN_WIDTH_PX);
  });

  it('大于最大宽度 ⇒ 收到最大宽度', () => {
    expect(clampFilePaneWidth(5000)).toBe(FILE_PANE_MAX_WIDTH_PX);
  });

  it('不是有限数字 ⇒ 回落默认宽度', () => {
    expect(clampFilePaneWidth(Number.NaN)).toBe(FILE_PANE_DEFAULT_WIDTH_PX);
    expect(clampFilePaneWidth(Number.POSITIVE_INFINITY)).toBe(FILE_PANE_DEFAULT_WIDTH_PX);
  });

  it('容器宽已知时：窗格不能把终端压过最小宽度', () => {
    // 容器 1000px、终端最小 320px ⇒ 窗格最多 680px。
    expect(clampFilePaneWidth(900, { containerWidth: 1000 })).toBe(680);
    // 终端最小宽度自定义时按自定义值算。
    expect(clampFilePaneWidth(900, { containerWidth: 1000, minTerminalWidth: 400 })).toBe(600);
  });

  it('容器宽不可用（0 / 负数 / 缺省）⇒ 只按窗格自身上下限钳位', () => {
    expect(clampFilePaneWidth(900, { containerWidth: 0 })).toBe(FILE_PANE_MAX_WIDTH_PX);
    expect(clampFilePaneWidth(900, { containerWidth: -10 })).toBe(FILE_PANE_MAX_WIDTH_PX);
    expect(clampFilePaneWidth(900)).toBe(FILE_PANE_MAX_WIDTH_PX);
  });

  it('容器窄到装不下「最小窗格 + 最小终端」⇒ 终端保底，窗格不再让位', () => {
    // 容器 500px：上限 = 500 - 320 = 180px < 最小窗格 240px ⇒ 上限抬回 240px。
    expect(clampFilePaneWidth(100, { containerWidth: 500 })).toBe(FILE_PANE_MIN_WIDTH_PX);
    expect(clampFilePaneWidth(400, { containerWidth: 500 })).toBe(FILE_PANE_MIN_WIDTH_PX);
  });

  it('返回值是整数像素', () => {
    expect(clampFilePaneWidth(340.4)).toBe(340);
    expect(clampFilePaneWidth(339.6)).toBe(340);
  });
});

describe('分隔条拖拽', () => {
  it('往左拖 ⇒ 窗格变宽；往右拖 ⇒ 窗格变窄', () => {
    const base = { startWidth: 340, containerWidth: 1200 };
    expect(filePaneWidthFromDrag({ ...base, startX: 600, pointerX: 500 })).toBe(440);
    expect(filePaneWidthFromDrag({ ...base, startX: 600, pointerX: 700 })).toBe(240);
  });

  it('拖拽同样距离 ⇒ 宽度同样变化（每帧都从起点算，不累加漂移）', () => {
    const first = filePaneWidthFromDrag({
      startWidth: 340,
      startX: 600,
      pointerX: 520,
      containerWidth: 1200,
    });
    const second = filePaneWidthFromDrag({
      startWidth: 340,
      startX: 600,
      pointerX: 520,
      containerWidth: 1200,
    });
    expect(first).toBe(second);
    expect(first).toBe(420);
  });

  it('拖到最窄：终端不被压没（窗格收到最小宽度）', () => {
    expect(
      filePaneWidthFromDrag({
        startWidth: 340,
        startX: 600,
        pointerX: 2000,
        containerWidth: 1200,
      }),
    ).toBe(FILE_PANE_MIN_WIDTH_PX);
  });

  it('拖到最宽：窗格不超过「容器宽 - 终端最小宽」', () => {
    expect(
      filePaneWidthFromDrag({
        startWidth: 340,
        startX: 600,
        pointerX: -5000,
        containerWidth: 1000,
      }),
    ).toBe(680);
  });
});

describe('Obsidian 双栏树宽钳位（复验修复轮·第二批 #4）', () => {
  it('默认树宽 264、下限 180、上限 520、预览最小宽 320', () => {
    expect(OBSIDIAN_TREE_DEFAULT_WIDTH_PX).toBe(264);
    expect(OBSIDIAN_TREE_MIN_WIDTH_PX).toBe(180);
    expect(OBSIDIAN_TREE_MAX_WIDTH_PX).toBe(520);
    expect(OBSIDIAN_PREVIEW_MIN_WIDTH_PX).toBe(320);
  });

  it('不是有限数字 ⇒ 回落默认树宽', () => {
    expect(clampObsidianTreeWidth(Number.NaN)).toBe(OBSIDIAN_TREE_DEFAULT_WIDTH_PX);
    expect(clampObsidianTreeWidth(Number.POSITIVE_INFINITY)).toBe(
      OBSIDIAN_TREE_DEFAULT_WIDTH_PX,
    );
  });

  it('低于下限 ⇒ 钳到最小树宽；高于上限 ⇒ 钳到最大树宽', () => {
    expect(clampObsidianTreeWidth(50)).toBe(OBSIDIAN_TREE_MIN_WIDTH_PX);
    expect(clampObsidianTreeWidth(99_999)).toBe(OBSIDIAN_TREE_MAX_WIDTH_PX);
    expect(clampObsidianTreeWidth(300)).toBe(300);
  });

  it('容器宽可用 ⇒ 上限不超过「容器宽 - 预览最小宽」', () => {
    // 容器充裕（1200 - 320 = 880 > 520）⇒ 绝对上限 520 生效
    expect(clampObsidianTreeWidth(99_999, { containerWidth: 1200 })).toBe(
      OBSIDIAN_TREE_MAX_WIDTH_PX,
    );
    // 容器较窄（700 - 320 = 380 < 520）⇒ 容器推导的上限生效
    expect(clampObsidianTreeWidth(99_999, { containerWidth: 700 })).toBe(380);
    expect(clampObsidianTreeWidth(99_999, { containerWidth: 700, minPreviewWidth: 500 })).toBe(
      200,
    );
    // 容器宽不可用（≤ 0 / null）⇒ 只按树自身上下限锢位，不能钳到 0
    expect(clampObsidianTreeWidth(99_999, { containerWidth: 0 })).toBe(
      OBSIDIAN_TREE_MAX_WIDTH_PX,
    );
    expect(clampObsidianTreeWidth(99_999, { containerWidth: null })).toBe(
      OBSIDIAN_TREE_MAX_WIDTH_PX,
    );
  });

  it('容器窄到装不下「最小树 + 最小预览」⇒ 预览保底，树不再让位（上限被抬回下限）', () => {
    expect(clampObsidianTreeWidth(300, { containerWidth: 400 })).toBe(
      OBSIDIAN_TREE_MIN_WIDTH_PX,
    );
  });

  it('返回值是整数像素（不出现小数抖动）', () => {
    expect(clampObsidianTreeWidth(300.6)).toBe(301);
  });

  it('拖拽：树在左 ⇒ 往右拖变宽、往左拖变窄', () => {
    const base = { startWidth: 264, containerWidth: 1200 };
    expect(obsidianTreeWidthFromDrag({ ...base, startX: 500, pointerX: 600 })).toBe(364);
    expect(obsidianTreeWidthFromDrag({ ...base, startX: 500, pointerX: 400 })).toBe(
      OBSIDIAN_TREE_MIN_WIDTH_PX,
    );
  });

  it('拖拽同样距离 ⇒ 宽度同样变化（每帧都从起点算，不累加漂移）', () => {
    const first = obsidianTreeWidthFromDrag({
      startWidth: 264,
      startX: 500,
      pointerX: 580,
      containerWidth: 1200,
    });
    const second = obsidianTreeWidthFromDrag({
      startWidth: 264,
      startX: 500,
      pointerX: 580,
      containerWidth: 1200,
    });
    expect(first).toBe(second);
    expect(first).toBe(344);
  });

  it('拖到最宽：树不超过「容器宽 - 预览最小宽」（预览区吃剩余宽度但不被压没）', () => {
    expect(
      obsidianTreeWidthFromDrag({
        startWidth: 264,
        startX: 500,
        pointerX: 5000,
        containerWidth: 700,
      }),
    ).toBe(380);
  });
});

describe('定位 fallback 链', () => {
  it('会话 pwd 可得 ⇒ 用 pwd', () => {
    expect(resolveFilePaneStartPath({ pwd: '/workspace/src', workdir: '/workspace' })).toBe(
      '/workspace/src',
    );
  });

  it('pwd 不可得 ⇒ 用沙箱 workdir', () => {
    expect(resolveFilePaneStartPath({ pwd: null, workdir: '/workspace' })).toBe('/workspace');
    expect(resolveFilePaneStartPath({ workdir: '/workspace' })).toBe('/workspace');
  });

  it('两者都不可得 ⇒ 兜底到容器根目录', () => {
    expect(resolveFilePaneStartPath({ pwd: null, workdir: null })).toBe('/');
    expect(resolveFilePaneStartPath({ pwd: null, workdir: '' })).toBe('/');
    expect(resolveFilePaneStartPath({})).toBe('/');
  });

  it('非法候选（相对路径 / 带 .. 段 / 带 NUL）不采用', () => {
    expect(resolveFilePaneStartPath({ pwd: 'workspace', workdir: '/ok' })).toBe('/ok');
    expect(resolveFilePaneStartPath({ pwd: '/a/../b', workdir: '/ok' })).toBe('/ok');
    expect(resolveFilePaneStartPath({ pwd: '/a\0b', workdir: '/ok' })).toBe('/ok');
  });

  it('候选会被归一（多余斜杠 / 前导空白）', () => {
    expect(resolveFilePaneStartPath({ pwd: '  /a//b' })).toBe('/a/b');
  });

  it('候选的尾部空白保真（与既有「条目名保真」口径一致）', () => {
    expect(resolveFilePaneStartPath({ pwd: '/a/b ' })).toBe('/a/b ');
  });
});

describe('同路径判定', () => {
  it('归一后相同 ⇒ 相等', () => {
    expect(isSameContainerPath('/a/b', '/a/b')).toBe(true);
    expect(isSameContainerPath('/a/b/', '/a/b')).toBe(true);
    expect(isSameContainerPath('/a//b', '/a/b')).toBe(true);
    expect(isSameContainerPath('/', '/')).toBe(true);
  });

  it('不同路径 ⇒ 不相等', () => {
    expect(isSameContainerPath('/a/b', '/a/c')).toBe(false);
    expect(isSameContainerPath('/a/b', '/a')).toBe(false);
  });

  it('任一侧为空 / 非法 ⇒ 不相等（回跳按钮不禁用）', () => {
    expect(isSameContainerPath(null, '/a')).toBe(false);
    expect(isSameContainerPath('/a', null)).toBe(false);
    expect(isSameContainerPath('relative', 'relative')).toBe(false);
  });
});

describe('入口条件', () => {
  it('有终端会话且激活终端 tab ⇒ 窗格出现', () => {
    expect(shouldShowFilePane({ tabKind: 'terminal', hasActiveSession: true })).toBe(true);
  });

  it('没有终端会话 ⇒ 窗格不出现', () => {
    expect(shouldShowFilePane({ tabKind: 'terminal', hasActiveSession: false })).toBe(false);
  });

  it('激活的不是终端 tab（Obsidian）⇒ 窗格不出现', () => {
    expect(shouldShowFilePane({ tabKind: 'obsidian', hasActiveSession: true })).toBe(false);
    expect(shouldShowFilePane({ tabKind: 'obsidian', hasActiveSession: false })).toBe(false);
  });
});
