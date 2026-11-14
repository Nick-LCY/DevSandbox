/**
 * 文件窗格（终端右侧分屏）的操作与断言。
 *
 * 口径来源：PRD「方案一 · 文件窗格」+ 任务 04 / 05；标识一律照
 * `apps/web/frontend/README.md` 的标识表（`page-file-pane` 一族 +
 * `page-file-browser` 一族），**不碰已退役的抽屉标识**
 * （`page-sandbox-detail-files-button` / `page-file-browser-dialog`）。
 *
 * 窗格是**终端 tab 的伴生物**：没有终端会话时它压根不渲染（PRD FP-04）。
 * 所以「打开窗格」= 在沙箱工作区里建一个终端会话，等窗格与列表都到位。
 *
 * 与抽屉时期的三处差异（用例里都要照顾到）：
 * 1. **没有打开 / 关闭动作**：窗格随会话出现、随会话消失，没有开关按钮；
 * 2. **起手目录**是「会话 pwd → 沙箱 workdir → `/`」的第一个可得值
 *    （抽屉时期是元数据 workdir）；
 * 3. **重读列表**靠导航（点面包屑 / 点目录行 / 回跳按钮，同路径也会强制重读），
 *    没有「关掉再打开」这条路径。
 */

import { expect, type Locator, type Page } from '@playwright/test';

import { expectTerminalConnected, openTerminal } from './terminal';

/** 窗格容器（展开 / 折叠都在这一格里，宽度随折叠态变）。 */
export function filePane(page: Page): Locator {
  return page.getByTestId('page-file-pane');
}

/** 展开态的面板根（折叠态不存在）。 */
export function paneContent(page: Page): Locator {
  return page.getByTestId('page-file-pane-content');
}

/** 折叠态的 36px 竖条（展开态不存在）。 */
export function paneCollapsed(page: Page): Locator {
  return page.getByTestId('page-file-pane-collapsed');
}

/** 中：可拖拽分隔条（折叠态不渲染）。 */
export function paneHandle(page: Page): Locator {
  return page.getByTestId('page-terminal-split-handle');
}

/** 左：终端面板格。 */
export function splitTerminal(page: Page): Locator {
  return page.getByTestId('page-terminal-split-terminal');
}

/** 面板的 toast（按类型 + 来源 + 文案筛）。 */
export function paneToast(
  page: Page,
  kind: 'success' | 'error' | 'info',
  text: string,
): Locator {
  return page
    .locator(`[data-testid="page-toast-item"][data-toast-kind="${kind}"][data-toast-source="file-browser"]`)
    .filter({ hasText: text });
}

/**
 * 打开文件窗格：建一个终端会话 → 等窗格与列表到位。
 *
 * 返回新会话的标识（个别断言要按会话取终端表面）。
 */
export async function openFilePane(page: Page): Promise<string> {
  const sessionId = await openTerminal(page);
  await expectTerminalConnected(page);
  await expect(filePane(page)).toBeVisible();
  await expect(paneContent(page)).toBeVisible();
  await expect(page.getByTestId('page-file-browser-list')).toBeVisible();
  return sessionId;
}

/** 列表里某个条目（按 `data-name` 筛）。 */
export function fileRow(page: Page, name: string): Locator {
  return page.locator(`[data-testid="page-file-browser-row"][data-name="${name}"]`);
}

/** 面包屑（各级 crumb，根目录是 `data-depth="-1"`）。 */
export function crumbs(page: Page): Locator {
  return page.getByTestId('page-file-browser-crumb');
}

/** 行内上传行（按 `data-upload-name` 筛）。 */
export function uploadRow(page: Page, name: string): Locator {
  return page.locator(`[data-testid="page-file-browser-upload-row"][data-upload-name="${name}"]`);
}

/**
 * 走窗格的上传入口传一个本地文件：点「上传」→ 原生文件选择框 → 选定文件。
 *
 * 上传按钮点的是真按钮（`page-file-browser-upload-button`），文件落在**隐藏的
 * 原生 `<input type="file">`** 上（`page-file-browser-file-input`）。
 */
export async function uploadFromPane(page: Page, filePath: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('page-file-browser-upload-button').click();
  await (await chooser).setFiles(filePath);
}

/**
 * 等窗格定位到某个目录（面包屑的当前层级就是 `name`，且列表已就绪）。
 *
 * 起手目录来自 fallback 链，pwd 是异步到达的：断言目录前先等它落定，
 * 免得在「先落 workdir、再被 pwd 挪一次」的中间态量东西。
 */
export async function expectPaneAt(page: Page, segments: readonly string[]): Promise<void> {
  await expect(crumbs(page)).toHaveCount(segments.length + 1, { timeout: 60_000 });
  if (segments.length > 0) {
    await expect(crumbs(page).nth(segments.length)).toHaveText(segments[segments.length - 1]);
  }
  await expect(crumbs(page).nth(segments.length)).toHaveAttribute('aria-current', 'page');
}
