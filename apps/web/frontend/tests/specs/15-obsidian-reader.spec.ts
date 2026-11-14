/**
 * Obsidian 阅读器（固定 tab）真机验收。
 *
 * 需求：`docs/prds/file-pane-obsidian.md`「验收标准」Obsidian tab（OBS）一节；
 * 任务：`docs/tasks/file-pane-obsidian/06-obsidian-tab.md`（tab 骨架 / vault 树 /
 * 设根引导态）与 `07-markdown-wikilink.md`（渲染 / wikilink / 错误条）。
 * 本 spec 对应 PRD 的 **QA-01 主链路**里「Obsidian 双栏 / wikilink 跳转 /
 * 目标不存在错误条」三项。
 *
 * 钉的行为（真浏览器 + 真沙箱）：
 *
 * 一、**固定 tab**：tabs 条**最左**、带 Obsidian 本地 logo、**不可关闭**
 *    （tab 上只有「选中」这一个按钮，没有关闭钮），**零终端会话时照样可用**；
 * 二、**双栏**：左 vault 树（宽度可拖拽调）+ 中间一条**可拖拽的骑缝把手**
 *    （复验修复轮·第二批 #4：原「不可拖拽的细分隔线」改可拖拽，样式与文件窗格
 *    把手一致——常显、直角）+ 右预览区（吃剩余宽度）；左树有最小宽度钳位；
 *    激活 Obsidian tab 时**文件窗格隐藏**，切回终端 tab 后窗格按**原折叠态**恢复；
 * 三、**设根引导态**：「选择一个目录作为 vault 根」+「使用沙箱工作目录」+ 路径输入框
 *    +「打开」按钮；两条入口都可用（本 spec 走「使用沙箱工作目录」，输入框路径由
 *    前端单测覆盖）；已设根后左栏顶部显示「vault 根：<路径>」+「更改」；
 * 四、**vault 树**：树形展开（箭头旋转 + 层级线），**只列目录与 `.md` 文件**，
 *    目录可展开 / 收起；
 * 五、**markdown 渲染**：工具条 = 返回 + 文件名 / 大小 + 「渲染 / 源码」分段切换 +
 *    复制；渲染态**隐藏 frontmatter**、源码态可见；渲染态内容列**填满预览区宽度**
 *    （保留水平内边距，不再 620px 居中限宽；用户浏览器复验修复轮）；左栏 header
 *    有**刷新**钮（失效目录缓存后按当前展开态重拉，不重置阅读位）；
 * 六、**wikilink 正向跳转**：`[[目标]]` 点击 ⇒ 沿预览历史栈推入目标渲染视图，
 *    返回键退回；hover 出 tooltip（内容 = 解析后的路径）；
 * 七、**目标不存在**：正文**顶部就地**出现浅红错误条「链接目标不存在：<名>」，
 *    可手动关闭，**不跳转、不弹 toast**。
 *
 * 夹具：沙箱内 `/workspace` 下两个互链的 `.md`（A ↔ B）+ 一个子目录里的 `.md`（C）
 * + 一个 `.txt`（用来证明树只列目录与 `.md`）。文件走**既有上传通道**
 * （`helpers/api.uploadSandboxFile`，与文件窗格上传同一条端点）；子目录用宿主侧
 * `docker exec` 造（不经被测接口，避免「用被测代码造证据」）。
 *
 * 渲染 / 源码切换、frontmatter 可见性、树只列 `.md` 这几条在前端单测里也有覆盖；
 * 这里在真机上再过一遍，是为了让 PRD 核销能挂「真机实证」这一类证据。
 */

import { expect, test, type Page } from '@playwright/test';

import {
  clearTerminalSessions,
  createSandbox,
  deleteSandbox,
  getSandbox,
  uploadSandboxFile,
} from '../helpers/api';
import { gotoDetail, toastItem } from '../helpers/console';
import { filePane, paneCollapsed, paneContent } from '../helpers/file-pane';
import { sandboxExec } from '../helpers/host';
import { readFixtures } from '../helpers/sandbox';
import { expectTerminalConnected, openTerminal } from '../helpers/terminal';

/** 本轮 base image（0.3.1）。 */
const IMAGE = 'sandbox-platform/base:0.3.1';
/** Obsidian 用例专用的沙箱。 */
const SANDBOX = 'acc-obsidian';
/** vault 根 = 沙箱工作目录。 */
const VAULT = '/workspace';

/** 夹具文件名。 */
const NOTE_A = 'acc-vault-note-a.md';
const NOTE_B = 'acc-vault-note-b.md';
const NOTE_C = 'acc-vault-note-c.md';
const PLAIN_TXT = 'acc-vault-not-markdown.txt';
const SUBDIR = 'acc-vault-dir';
/** 不存在的 wikilink 目标（错误条断言用）。 */
const MISSING = 'acc-vault-missing';

/** 笔记 A：带 frontmatter + 一条命中链接 + 一条不存在的链接。 */
const NOTE_A_BODY = `---
title: 笔记 A
tags: [acc, obsidian]
---

# 笔记 A

这是验收夹具 note A。

参见 [[${NOTE_B.replace(/\.md$/, '')}]] 与 [[${MISSING}]]。
`;

/** 笔记 B：反向链回 A（互链）。 */
const NOTE_B_BODY = `# 笔记 B

回到 [[${NOTE_A.replace(/\.md$/, '')}]]。
`;

/** 子目录里的笔记 C。 */
const NOTE_C_BODY = `# 笔记 C

子目录里的笔记。
`;

/** 打开 Obsidian tab（不设根：引导态）。 */
async function openObsidianTab(page: Page): Promise<void> {
  await gotoDetail(page, SANDBOX);
  const tab = page.getByTestId('page-sandbox-detail-obsidian-tab');
  await expect(tab).toBeVisible();
  await tab.getByTestId('page-sandbox-detail-obsidian-tab-select').click();
  await expect(page.getByTestId('page-sandbox-detail-obsidian')).toBeVisible();
}

/** 引导态里用「使用沙箱工作目录」设根，并等双栏就绪。 */
async function useWorkdirAsVaultRoot(page: Page): Promise<void> {
  const button = page.getByTestId('page-sandbox-detail-obsidian-use-workdir-button');
  await expect(button, '「使用沙箱工作目录」按钮不可用（workdir 没传到组件）').toBeEnabled();
  await button.click();
  await expect(page.getByTestId('page-sandbox-detail-obsidian-vault-tree')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId('page-sandbox-detail-obsidian-vault-root')).toHaveText(
    `vault 根：${VAULT}`,
  );
}

/** 树里按容器内路径找节点。 */
function treeNode(page: Page, path: string) {
  return page.locator(`[data-testid="page-sandbox-detail-obsidian-tree-node"][data-path="${path}"]`);
}

/** 树里按容器内路径找目录行。 */
function treeDir(page: Page, path: string) {
  return page.locator(`[data-testid="page-sandbox-detail-obsidian-tree-dir"][data-path="${path}"]`);
}

/** 树里按容器内路径找文件行。 */
function treeFile(page: Page, path: string) {
  return page.locator(`[data-testid="page-sandbox-detail-obsidian-tree-file"][data-path="${path}"]`);
}

/** 右栏容器（`data-selected-path` = 历史栈栈顶）。 */
function preview(page: Page) {
  return page.getByTestId('page-sandbox-detail-obsidian-preview');
}

/** 渲染态正文容器。 */
function previewContent(page: Page) {
  return page.getByTestId('page-sandbox-detail-obsidian-preview-content');
}

/** 点树里的 `.md` 并等右栏切到它。 */
async function openNote(page: Page, path: string, name: string): Promise<void> {
  await treeFile(page, path).click();
  await expect(preview(page)).toHaveAttribute('data-selected-path', path, { timeout: 60_000 });
  await expect(page.getByTestId('page-sandbox-detail-obsidian-preview-title')).toHaveText(name);
}

/** 某条 wikilink（按 `data-target` 筛）。 */
function wikilink(page: Page, target: string) {
  return page.locator(
    `[data-testid="page-sandbox-detail-obsidian-preview-wikilink"][data-target="${target}"]`,
  );
}

test.describe('Obsidian 阅读器', () => {
  test.beforeAll(async () => {
    readFixtures();
    // 「先删再建」：容器从干净状态开始（vault 里的夹具必须只有本 spec 放的那几份）。
    await deleteSandbox(SANDBOX).catch(() => undefined);
    await createSandbox({
      name: SANDBOX,
      image: IMAGE,
      command: 'sleep infinity',
      workdir: VAULT,
    });

    // 夹具：子目录 + 四份文件（走既有上传通道）
    const detail = await getSandbox(SANDBOX);
    const mkdir = sandboxExec(detail.system_user, detail.uid, [
      'docker',
      'exec',
      detail.container_name,
      'mkdir',
      '-p',
      `${VAULT}/${SUBDIR}`,
    ]);
    if (mkdir.code !== 0) {
      throw new Error(`容器内造子目录失败：${mkdir.stderr}`);
    }
    const fixtures: Array<[string, string]> = [
      [`${VAULT}/${NOTE_A}`, NOTE_A_BODY],
      [`${VAULT}/${NOTE_B}`, NOTE_B_BODY],
      [`${VAULT}/${SUBDIR}/${NOTE_C}`, NOTE_C_BODY],
      [`${VAULT}/${PLAIN_TXT}`, 'ACC_NOT_MARKDOWN\n'],
    ];
    for (const [target, body] of fixtures) {
      await uploadSandboxFile(SANDBOX, target, Buffer.from(body, 'utf-8'));
    }
  });

  test.afterAll(async () => {
    await deleteSandbox(SANDBOX).catch(() => undefined);
  });

  /*
   * 会话记录是宿主侧持久资源（同一沙箱上限 5 个）：用例会看到彼此留下的会话。
   * 每条用例开始前清场——固定 tab 那条「零会话照样可用」的断言依赖这个前提。
   */
  test.beforeEach(async () => {
    await clearTerminalSessions(SANDBOX);
  });

  test('固定 tab：tabs 条最左、不可关闭、零会话可用；引导态设根后是双栏 + vault 树', async ({
    page,
  }) => {
    await gotoDetail(page, SANDBOX);

    // ── ① 零终端会话时 tab 照样在（固定 tab 与会话无关）
    await expect(page.getByTestId('page-sandbox-detail-terminal-tab')).toHaveCount(0);
    const tab = page.getByTestId('page-sandbox-detail-obsidian-tab');
    await expect(tab).toBeVisible();
    await expect(tab).toContainText('Obsidian');
    // 图标是**本地打包资产**（运行时零 CDN）：src 必须落在本页同源的构建产物下
    const icon = tab.getByTestId('page-sandbox-detail-obsidian-tab-icon');
    await expect(icon).toBeVisible();
    const iconSrc = (await icon.getAttribute('src')) ?? '';
    const iconUrl = new URL(iconSrc, page.url());
    expect(
      iconUrl.origin,
      `tab 图标不是本地资产（非同源，可能是外链 CDN）：${iconSrc}`,
    ).toBe(new URL(page.url()).origin);
    expect(iconUrl.pathname, `tab 图标不是构建产物里的 SVG 资产：${iconSrc}`).toMatch(
      /\/assets\/[^/]+\.svg$/,
    );

    // ── ② tabs 条**最左**就是它（第一个 role=tab 元素）
    const tablist = page.getByTestId('page-sandbox-detail-terminal-tabs');
    await expect(tablist.getByRole('tab').first()).toHaveAttribute(
      'data-testid',
      'page-sandbox-detail-obsidian-tab',
    );

    // ── ③ **不可关闭**：tab 上只有「选中」一个按钮，没有关闭钮
    await expect(tab.locator('button'), 'Obsidian tab 上出现了多余的按钮').toHaveCount(1);
    await expect(tab.getByTestId('page-sandbox-detail-terminal-tab-close')).toHaveCount(0);

    // ── ④ 激活：引导态三件套（标题 / 按钮 / 输入框 + 打开）
    await tab.getByTestId('page-sandbox-detail-obsidian-tab-select').click();
    await expect(tab).toHaveAttribute('data-active', 'true');
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('page-sandbox-detail-obsidian-onboarding')).toBeVisible();
    await expect(page.getByTestId('page-sandbox-detail-obsidian-onboarding-title')).toHaveText(
      '选择一个目录作为 vault 根',
    );
    const useWorkdir = page.getByTestId('page-sandbox-detail-obsidian-use-workdir-button');
    await expect(useWorkdir).toBeVisible();
    await expect(useWorkdir).toBeEnabled();
    await expect(page.getByTestId('page-sandbox-detail-obsidian-root-input')).toBeVisible();
    // 空输入时「打开」禁用（路径必须非空且是绝对路径）
    await expect(page.getByTestId('page-sandbox-detail-obsidian-root-open-button')).toBeDisabled();

    // ── ⑤ 设根（走「使用沙箱工作目录」）⇒ 双栏
    await useWorkdirAsVaultRoot(page);
    await expect(page.getByTestId('page-sandbox-detail-obsidian-onboarding')).toHaveCount(0);
    const tree = page.getByTestId('page-sandbox-detail-obsidian-vault-tree');
    const divider = page.getByTestId('page-sandbox-detail-obsidian-divider');
    await expect(tree).toBeVisible();
    await expect(divider).toBeVisible();
    await expect(preview(page)).toBeVisible();
    // 左树 + 细分隔线 + 右预览（从左到右）
    const treeBox = await tree.boundingBox();
    const dividerBox = await divider.boundingBox();
    const previewBox = await preview(page).boundingBox();
    expect(treeBox, '量不到 vault 树').not.toBeNull();
    expect(dividerBox, '量不到分隔线').not.toBeNull();
    expect(previewBox, '量不到预览区').not.toBeNull();
    expect(treeBox!.x).toBeLessThan(dividerBox!.x);
    expect(dividerBox!.x).toBeLessThan(previewBox!.x);
    // 分隔线现在是**可拖拽的骑缝把手**（复验修复轮·第二批 #4）：role=separator、
    // 12px 常显把手带骑在两格接缝上（不占布局宽度；审查收敛后从 16px 收窄——
    // 每侧压入从 8px 减到 6px，与左树的右内边距 pr-1.5 配平，滚动条不被吞热区）；
    // 数值范围与文件窗格把手同一钳位口径（下限 180）。
    expect(Math.round(dividerBox!.width), '把手不是骑缝的 12px 带').toBe(12);
    await expect(divider).toHaveAttribute('role', 'separator');
    await expect(divider).toHaveAttribute('aria-label', '调整 vault 树宽度');
    await expect(divider).toHaveAttribute('aria-valuemin', '180');
    await expect(divider).toHaveAttribute('aria-valuenow', '264');
    await expect(divider).toHaveAttribute('aria-valuetext', '264px');
    // 左树按当前宽度渲染（默认 264px）
    expect(Math.round(treeBox!.width), '左树默认宽度不是 264px').toBe(264);
    // 右栏还没选文件：空态
    await expect(page.getByTestId('page-sandbox-detail-obsidian-preview-empty')).toHaveText(
      '从左侧选择文件',
    );
    // 「更改」按钮在左栏顶部（已设根）
    await expect(page.getByTestId('page-sandbox-detail-obsidian-change-root-button')).toBeVisible();
    // 左栏 header 的刷新钮（用户浏览器复验修复轮）：重拉 vault 树、不重置阅读位
    await expect(page.getByTestId('page-sandbox-detail-obsidian-tree-refresh-button')).toBeVisible();
    await expect(page.getByTestId('page-sandbox-detail-obsidian-tree-refresh-button')).toHaveAttribute(
      'aria-label',
      '刷新',
    );

    // ── ⑥ vault 树：**只列目录与 .md**（.txt 不出现），目录可展开 / 收起
    await expect(treeFile(page, `${VAULT}/${NOTE_A}`)).toBeVisible({ timeout: 60_000 });
    await expect(treeFile(page, `${VAULT}/${NOTE_B}`)).toBeVisible();
    await expect(
      treeNode(page, `${VAULT}/${PLAIN_TXT}`),
      'vault 树里出现了非 markdown 文件（应只列目录与 .md）',
    ).toHaveCount(0);
    const dir = treeDir(page, `${VAULT}/${SUBDIR}`);
    await expect(dir, 'vault 树里没有列出子目录').toBeVisible();
    await expect(dir).toHaveAttribute('data-expanded', 'false');
    await expect(dir).toHaveAttribute('aria-expanded', 'false');

    // 展开 ⇒ 子层出现、笔记本 C 出现、箭头转 90°
    await dir.click();
    await expect(dir).toHaveAttribute('data-expanded', 'true');
    await expect(dir).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('page-sandbox-detail-obsidian-tree-children')).toBeVisible();
    await expect(treeFile(page, `${VAULT}/${SUBDIR}/${NOTE_C}`)).toBeVisible({ timeout: 60_000 });
    const chevron = dir.locator('[data-testid="page-sandbox-detail-obsidian-tree-chevron"]');
    expect((await chevron.getAttribute('class')) ?? '').toContain('rotate-90');

    // 收起 ⇒ 子层消失
    await dir.click();
    await expect(dir).toHaveAttribute('data-expanded', 'false');
    await expect(treeFile(page, `${VAULT}/${SUBDIR}/${NOTE_C}`)).toHaveCount(0);

    // ── ⑦ 左栏刷新钮：不导航、不重置选中，重拉 vault 树（新文件直接出现）
    await uploadSandboxFile(
      SANDBOX,
      `${VAULT}/acc-obsidian-refresh-probe.md`,
      Buffer.from('# 探针\n', 'utf-8'),
    );
    await page.getByTestId('page-sandbox-detail-obsidian-tree-refresh-button').click();
    await expect(
      treeFile(page, `${VAULT}/acc-obsidian-refresh-probe.md`),
      '点刷新后 vault 树没有出现新文件（缓存失效重拉没生效）',
    ).toBeVisible({ timeout: 60_000 });
  });

  test('双栏可拖拽：拖把手调左树宽度（右拖变宽 / 左拖变窄）、钳位生效、预览吃剩余宽度', async ({
    page,
  }) => {
    await openObsidianTab(page);
    await useWorkdirAsVaultRoot(page);

    const handle = page.getByTestId('page-sandbox-detail-obsidian-divider');
    await expect(handle).toBeVisible();

    /** 量某个 testid 元素的整数化宽度。 */
    const widthOf = async (testId: string): Promise<number> => {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box, `量不到 ${testId}`).not.toBeNull();
      return Math.round(box!.width);
    };
    /** 拖把手：从当前指针位置拖到 `offsetX`（相对起点，正数 = 往右 = 树变宽）。 */
    const drag = async (offsetX: number): Promise<void> => {
      const box = await handle.boundingBox();
      expect(box, '量不到双栏把手').not.toBeNull();
      const startX = box!.x + box!.width / 2;
      const startY = box!.y + box!.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + offsetX, startY, { steps: 8 });
      await page.mouse.up();
    };

    // ── ① 默认树宽 264px，把手 aria 与宽度同步
    expect(await widthOf('page-sandbox-detail-obsidian-vault-tree')).toBe(264);
    await expect(handle).toHaveAttribute('aria-valuenow', '264');

    // ── ② 往右拖 120px ⇒ 树变宽约 120px，预览区仍在右侧且变窄（吃剩余宽度）
    const previewBefore = (await preview(page).boundingBox())!.x;
    await drag(120);
    const widened = await widthOf('page-sandbox-detail-obsidian-vault-tree');
    expect(widened, `往右拖 120px 后树宽应在 374~394 之间（实测 ${widened}）`)
      .toBeGreaterThanOrEqual(374);
    expect(widened).toBeLessThanOrEqual(394);
    await expect(handle).toHaveAttribute('aria-valuenow', String(widened));
    const previewAfterX = (await preview(page).boundingBox())!.x;
    expect(previewAfterX, '树变宽后预览区左缘没有右移（预览没吃剩余宽度）').toBeGreaterThan(
      previewBefore,
    );
    await expect(preview(page)).toBeVisible();

    // ── ③ 往左猛拖 ⇒ 树铌到最小宽度 180px（左树最小宽度钳位）
    await drag(-2000);
    expect(await widthOf('page-sandbox-detail-obsidian-vault-tree')).toBe(180);
    await expect(handle).toHaveAttribute('aria-valuenow', '180');

    // ── ④ 方向键调宽：→ 变宽 16px、← 变窄 16px（键盘可用性）
    await handle.focus();
    await handle.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', '196');
    expect(await widthOf('page-sandbox-detail-obsidian-vault-tree')).toBe(196);
    await handle.press('ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', '180');
  });

  test('点击 .md 渲染 + wikilink 命中跳转（含 tooltip / 返回栈）+ 渲染与源码切换', async ({
    page,
  }) => {
    await openObsidianTab(page);
    await useWorkdirAsVaultRoot(page);

    // ── ① 点树里的笔记 A ⇒ 右栏渲染
    await openNote(page, `${VAULT}/${NOTE_A}`, NOTE_A);
    await expect(page.getByTestId('page-sandbox-detail-obsidian-preview-body')).toHaveAttribute(
      'data-mode',
      'render',
    );
    const content = previewContent(page);
    await expect(content).toBeVisible({ timeout: 60_000 });
    await expect(content).toContainText('笔记 A');
    await expect(content).toContainText('这是验收夹具 note A。');
    // 内容列**填满预览区宽度**（保留合理水平内边距；不再 620px 居中限宽）
    const contentBox = await content.boundingBox();
    const previewBox = await preview(page).boundingBox();
    expect(contentBox, '量不到渲染内容列').not.toBeNull();
    expect(previewBox, '量不到预览区').not.toBeNull();
    const leftGap = contentBox!.x - previewBox!.x;
    const rightGap = previewBox!.x + previewBox!.width - (contentBox!.x + contentBox!.width);
    // 两侧只留外层滚动容器的水平内边距（约 16px）：不再有居中的大片留白
    expect(leftGap, '渲染内容列左侧内边距不合理').toBeGreaterThanOrEqual(8);
    expect(rightGap, '渲染内容列右侧内边距不合理').toBeGreaterThanOrEqual(8);
    expect(leftGap, '渲染内容列左侧内边距过大').toBeLessThanOrEqual(32);
    expect(rightGap, '渲染内容列右侧内边距过大（含纵向滚动条）').toBeLessThanOrEqual(48);
    // 填满：内容列宽度以预览区宽度为**独立基准**（与源码态同口径）。两侧内边距
    // 的上下界已由上面四条 gap 断言锁定；不用 contentBox 自推自证（那条恒真）。
    expect(
      Math.round(contentBox!.width),
      '渲染内容列没有填满预览区宽度',
    ).toBeGreaterThanOrEqual(Math.round(previewBox!.width - 48));
    // **frontmatter 渲染态隐藏**
    const renderedText = (await content.textContent()) ?? '';
    expect(renderedText, '渲染态漏出了 frontmatter').not.toContain('tags: [acc, obsidian]');

    // ── ② 渲染 / 源码分段切换：源码态原文（frontmatter 可见）
    await expect(page.getByTestId('page-sandbox-detail-obsidian-preview-mode-render')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByTestId('page-sandbox-detail-obsidian-preview-mode-source').click();
    const source = page.getByTestId('page-sandbox-detail-obsidian-preview-source');
    await expect(source).toBeVisible();
    await expect(source).toHaveAttribute('data-mode', 'source');
    // 源码态同样填满预览区宽度（无 620px 上限）
    const sourceBox = await source.boundingBox();
    expect(sourceBox, '量不到源码态内容列').not.toBeNull();
    expect(
      Math.round(sourceBox!.width),
      '源码态内容列没有填满预览区宽度',
    ).toBeGreaterThanOrEqual(Math.round(previewBox!.width - 48));
    await expect(source).toContainText('title: 笔记 A');
    await expect(source).toContainText('tags: [acc, obsidian]');
    await page.getByTestId('page-sandbox-detail-obsidian-preview-mode-render').click();
    await expect(previewContent(page)).toBeVisible();

    // ── ③ wikilink：hover 出 tooltip（内容 = 解析后的路径）
    const found = wikilink(page, NOTE_B.replace(/\.md$/, ''));
    await expect(found).toBeVisible();
    await found.hover();
    const tooltip = page.getByTestId('page-sandbox-detail-obsidian-preview-wikilink-tooltip');
    await expect(tooltip).toBeVisible({ timeout: 60_000 });
    await expect(tooltip).toHaveText(`${VAULT}/${NOTE_B}`);
    // 强调色 + 虚线下划线（样式口径）
    const decoration = await found.evaluate(
      (element) => window.getComputedStyle(element).textDecorationLine,
    );
    expect(decoration, 'wikilink 没有虚线下划线').toContain('underline');
    const decoStyle = await found.evaluate(
      (element) => window.getComputedStyle(element).textDecorationStyle,
    );
    expect(decoStyle, 'wikilink 下划线不是虚线').toBe('dashed');
    // 解析结果落到 `data-status` / `data-resolved-path`
    await expect(found).toHaveAttribute('data-status', 'found', { timeout: 60_000 });
    await expect(found).toHaveAttribute('data-resolved-path', `${VAULT}/${NOTE_B}`);

    // ── ④ 点击命中 ⇒ 沿历史栈推入目标视图（返回钮出现）
    await found.click();
    await expect(preview(page)).toHaveAttribute('data-selected-path', `${VAULT}/${NOTE_B}`, {
      timeout: 60_000,
    });
    await expect(page.getByTestId('page-sandbox-detail-obsidian-preview-title')).toHaveText(NOTE_B);
    await expect(previewContent(page)).toContainText('笔记 B');
    const back = page.getByTestId('page-sandbox-detail-obsidian-preview-back-button');
    await expect(back, '压栈之后没有出现返回钮').toBeVisible();

    // ── ⑤ 返回 ⇒ 回到笔记 A；栈底时返回钮**不渲染**
    await back.click();
    await expect(preview(page)).toHaveAttribute('data-selected-path', `${VAULT}/${NOTE_A}`);
    await expect(page.getByTestId('page-sandbox-detail-obsidian-preview-title')).toHaveText(NOTE_A);
    await expect(back, '栈底仍然渲染了返回钮').toHaveCount(0);

    // ── ⑥ 反向互链：B 里的 [[A]] 也能跳回来（两文件确实互链）
    await openNote(page, `${VAULT}/${NOTE_B}`, NOTE_B);
    await wikilink(page, NOTE_A.replace(/\.md$/, '')).click();
    await expect(preview(page)).toHaveAttribute('data-selected-path', `${VAULT}/${NOTE_A}`, {
      timeout: 60_000,
    });
  });

  test('wikilink 目标不存在：正文顶部就地错误条（文案 / 可关闭 / 不跳转 / 不弹 toast）', async ({
    page,
  }) => {
    await openObsidianTab(page);
    await useWorkdirAsVaultRoot(page);
    await openNote(page, `${VAULT}/${NOTE_A}`, NOTE_A);

    const missing = wikilink(page, MISSING);
    await expect(missing).toBeVisible({ timeout: 60_000 });
    await missing.click();

    const errorBar = page.getByTestId('page-sandbox-detail-obsidian-preview-wikilink-error');
    await expect(errorBar, '点不存在的 wikilink 没有出现错误条').toBeVisible({ timeout: 60_000 });
    await expect(errorBar).toHaveAttribute('role', 'alert');
    await expect(errorBar).toHaveText(`链接目标不存在：${MISSING}`);

    // ── ① **不跳转**：右栏仍是笔记 A
    await expect(preview(page)).toHaveAttribute('data-selected-path', `${VAULT}/${NOTE_A}`);
    await expect(page.getByTestId('page-sandbox-detail-obsidian-preview-title')).toHaveText(NOTE_A);
    await expect(page.getByTestId('page-sandbox-detail-obsidian-preview-back-button')).toHaveCount(0);

    // ── ② 错误条在**正文顶部**（纵向在渲染内容列之上，且就在工具条之下）
    const errorBox = await errorBar.boundingBox();
    const contentBox = await previewContent(page).boundingBox();
    expect(errorBox, '量不到错误条').not.toBeNull();
    expect(contentBox, '量不到渲染内容').not.toBeNull();
    expect(errorBox!.y, '错误条不在正文顶部（渲染内容之上）').toBeLessThan(contentBox!.y);

    // ── ③ **不弹 toast**（就地错误，不进全局提示）
    await expect(toastItem(page, 'error', 'obsidian')).toHaveCount(0);
    await expect(toastItem(page, 'error', undefined).filter({ hasText: MISSING })).toHaveCount(0);

    // ── ④ 可手动关闭
    await page
      .getByTestId('page-sandbox-detail-obsidian-preview-wikilink-error-close-button')
      .click();
    await expect(errorBar).toHaveCount(0);

    // ── ⑤ 正向对照：命中的那条链接点击后**确实跳转**（证明上面「不跳转」不是监听器失灵）
    await wikilink(page, NOTE_B.replace(/\.md$/, '')).click();
    await expect(preview(page)).toHaveAttribute('data-selected-path', `${VAULT}/${NOTE_B}`, {
      timeout: 60_000,
    });
  });

  test('激活 Obsidian tab 时文件窗格隐藏，切回终端 tab 按原折叠态恢复', async ({ page }) => {
    await gotoDetail(page, SANDBOX);
    const sessionId = await openTerminal(page);
    await expectTerminalConnected(page);
    await expect(page.getByTestId('page-file-pane-content')).toBeVisible();

    // 先把窗格折叠起来（切回来要按这个态恢复）
    await page.getByTestId('page-file-pane-collapse-button').click();
    await expect(paneCollapsed(page)).toBeVisible();

    // 切到 Obsidian tab：窗格与分屏**整体不出现**，Obsidian 视图接管内容区
    await page.getByTestId('page-sandbox-detail-obsidian-tab-select').click();
    await expect(page.getByTestId('page-sandbox-detail-obsidian')).toBeVisible();
    await expect(filePane(page), '激活 Obsidian tab 时文件窗格仍然存在').toHaveCount(0);
    await expect(page.getByTestId('page-terminal-split'), 'Obsidian tab 下终端分屏仍然渲染').toHaveCount(
      0,
    );
    await expect(paneContent(page)).toHaveCount(0);
    // 固定 tab 不能被会话挤走（切回终端 tab 之后仍在最左）
    await expect(page.getByTestId('page-sandbox-detail-obsidian-tab')).toHaveAttribute(
      'data-active',
      'true',
    );

    // 切回终端 tab：窗格按**原折叠态**恢复
    await page
      .locator(`[data-testid="page-sandbox-detail-terminal-tab"][data-session-id="${sessionId}"]`)
      .getByTestId('page-sandbox-detail-terminal-tab-select')
      .click();
    await expect(page.getByTestId('page-terminal-split')).toBeVisible();
    await expect(paneCollapsed(page), '切回终端 tab 后窗格没有按原折叠态恢复').toBeVisible();
    // 展开照常可用
    await page.getByTestId('page-file-pane-expand-button').click();
    await expect(paneContent(page)).toBeVisible();
    await expect(page.getByTestId('page-file-browser-list')).toBeVisible();
  });
});
