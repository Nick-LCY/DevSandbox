/**
 * 网页终端的操作与断言。
 *
 * **标签 = 会话**：标签条的数据源就是后端的会话表，一个标签一个会话。
 * 点标签即附着到该会话（服务端回放现场缓冲）。
 *
 * xterm.js 用 DOM 渲染器，行文本落在 `.xterm-rows` 里：
 * 用 `textContent()` 读（`innerText()` 对隐藏元素返回空串，切换标签时会踩坑）。
 */

import { expect, type Page } from '@playwright/test';

const SURFACE = 'page-sandbox-detail-terminal-surface';

/** 某个会话的终端表面。 */
function surfaceOf(page: Page, sessionId: string) {
  return page.locator(`[data-testid="${SURFACE}"][data-session-id="${sessionId}"]`);
}

/** 某个会话的标签。 */
function tabOf(page: Page, sessionId: string) {
  return page.locator(`[data-testid="page-sandbox-detail-terminal-tab"][data-session-id="${sessionId}"]`);
}

/**
 * 新建一个终端标签，返回会话标识。
 */
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

/**
 * 点某个会话的标签（标签 = 会话，点标签就是附着到这个会话）。
 */
async function clickTab(page: Page, sessionId: string): Promise<void> {
  const tab = tabOf(page, sessionId);
  await tab.getByTestId('page-sandbox-detail-terminal-tab-select').click();
  await expect(tab).toHaveAttribute('data-active', 'true');
}

/**
 * 切到某个终端标签（标签已经在页面上）。
 */
export async function selectTerminal(page: Page, sessionId: string): Promise<void> {
  await expect(tabOf(page, sessionId)).toHaveCount(1);
  await clickTab(page, sessionId);
}

/**
 * 重新附着到某个已有会话。
 *
 * 场景：浏览器断开 / 页面刷新之后，后端会话还在，标签条里也还在——
 * 打开 `#/sandboxes/<名>` 后点标签就能挂回原会话（服务端回放现场缓冲）。
 *
 * 标签是随会话表异步刷新的，所以这里先等标签出现再点。
 */
export async function reattachTerminal(page: Page, sessionId: string): Promise<void> {
  const tab = tabOf(page, sessionId);
  await expect(tab).toHaveCount(1, { timeout: 30_000 });
  await clickTab(page, sessionId);
}

/**
 * 断言终端会话已连接（看面板上的状态标签，不是终端屏幕）。
 */
export async function expectTerminalConnected(page: Page): Promise<void> {
  await expect(page.getByTestId('page-sandbox-detail-terminal-status')).toHaveText('已连接', {
    timeout: 60_000,
  });
}

/**
 * 读终端当前屏幕上的文本。
 */
export async function terminalText(page: Page, sessionId: string): Promise<string> {
  const rows = surfaceOf(page, sessionId).locator('.xterm-rows');
  return (await rows.textContent()) ?? '';
}

/**
 * 往终端里敲一条命令并回车。
 */
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

/**
 * 断言终端屏幕上出现某段文本。
 */
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

/**
 * 断言终端屏幕上不出现某段文本。
 */
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

/**
 * 断言 Ctrl+C 真的送到了容器内的 shell。
 *
 * 口径：先让 shell 跑一条长命令（前台阻塞），发 Ctrl+C 之后
 * ① 屏幕上有 `^C` 回显或提示符回来了，② shell 立刻能执行下一条命令，
 * 且上一条命令的退出码是 130（128 + SIGINT）。
 *
 * 第二条是硬证据：Ctrl+C 没到 shell 的话，shell 还卡在长命令里，
 * 后面的 echo 根本不会执行。
 */
export async function expectInterruptReachedShell(
  page: Page,
  sessionId: string,
  timeoutMs = 30_000,
): Promise<void> {
  // ① 提示符回归或 ^C 回显
  await expect
    .poll(async () => await terminalText(page, sessionId), {
      timeout: timeoutMs,
      message: 'Ctrl+C 之后终端既没有 ^C 回显，也没有回到提示符',
    })
    .toMatch(/\^C|[$#]\s*$/m);

  // ② 硬证据：shell 立刻能执行下一条命令，且上一条命令的退出码是 130（128 + SIGINT）
  await typeInTerminal(page, sessionId, 'echo ACC_CTRL_C_STATUS_$?');
  await expectTerminalText(page, sessionId, 'ACC_CTRL_C_STATUS_130', timeoutMs);
}
