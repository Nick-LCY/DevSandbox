/**
 * 网页终端的操作与断言。
 *
 * xterm.js 用 DOM 渲染器，行文本落在 `.xterm-rows` 里：
 * 用 `textContent()` 读（`innerText()` 对隐藏元素返回空串，切换标签时会踩坑）。
 */

import { expect, type Page } from '@playwright/test';

const SURFACE = 'page-sandbox-detail-terminal-surface';

function surfaceOf(page: Page, sessionId: string) {
  return page.locator(`[data-testid="${SURFACE}"][data-session-id="${sessionId}"]`);
}

/** 新建一个终端标签，返回会话标识。 */
export async function openTerminal(page: Page): Promise<string> {
  const tabs = page.locator('[data-testid="page-sandbox-detail-terminal-tab"]');
  const readIds = async (): Promise<string[]> =>
    tabs.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-session-id') ?? ''));
  const before = await readIds();
  await page.getByTestId('page-sandbox-detail-terminal-new-button').click();
  await expect
    .poll(async () => tabs.count(), { timeout: 60_000, message: '新建终端会话超时' })
    .toBe(before.length + 1);
  const after = await readIds();
  const created = after.find((id) => !before.includes(id));
  if (!created) {
    throw new Error('新建终端后没有拿到新的会话标识');
  }
  return created;
}

/** 切到某个终端标签。 */
export async function selectTerminal(page: Page, sessionId: string): Promise<void> {
  const tab = page.locator(`[data-testid="page-sandbox-detail-terminal-tab"][data-session-id="${sessionId}"]`);
  await tab.getByTestId('page-sandbox-detail-terminal-tab-select').click();
  await expect(tab).toHaveAttribute('data-active', 'true');
}

/** 断言终端会话已连接（看面板上的状态标签，不是终端屏幕）。 */
export async function expectTerminalConnected(page: Page): Promise<void> {
  await expect(page.getByTestId('page-sandbox-detail-terminal-status')).toHaveText('已连接', {
    timeout: 60_000,
  });
}

/** 读终端当前屏幕上的文本。 */
export async function terminalText(page: Page, sessionId: string): Promise<string> {
  const rows = surfaceOf(page, sessionId).locator('.xterm-rows');
  return (await rows.textContent()) ?? '';
}

/** 往终端里敲一条命令并回车。 */
export async function typeInTerminal(page: Page, sessionId: string, command: string): Promise<void> {
  const surface = surfaceOf(page, sessionId);
  await surface.click();
  const textarea = surface.locator('textarea');
  if ((await textarea.count()) > 0) {
    await textarea.first().focus();
  }
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

/** 断言终端屏幕上出现某段文本。 */
export async function expectTerminalText(
  page: Page,
  sessionId: string,
  needle: string,
  timeoutMs = 30_000,
): Promise<void> {
  await expect
    .poll(async () => await terminalText(page, sessionId), {
      timeout: timeoutMs,
      message: `终端 ${sessionId.slice(0, 8)} 的屏幕上没有出现「${needle}」`,
    })
    .toContain(needle);
}

/** 断言终端屏幕上不出现某段文本。 */
export async function expectTerminalTextAbsent(
  page: Page,
  sessionId: string,
  needle: string,
  timeoutMs = 10_000,
): Promise<void> {
  await expect
    .poll(async () => await terminalText(page, sessionId), { timeout: timeoutMs })
    .not.toContain(needle);
}
