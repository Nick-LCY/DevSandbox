/**
 * 终端交互增强真机验收。
 *
 * 覆盖设置抽屉的通用设置、偏好持久化、Shift+Enter、终端内右键复制 / 粘贴
 * 与 OSC 52 双向剪贴板通路。所有终端行为都在真沙箱的真实 PTY 内取证。
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { clearTerminalSessions, createSandbox, deleteSandbox, listSandboxes } from '../helpers/api';
import { gotoDetail, openSettingsDrawer, toastItem } from '../helpers/console';
import {
  expectTerminalConnected,
  expectTerminalRow,
  expectTerminalText,
  expectTerminalTextAbsent,
  focusTerminal,
  openTerminal,
  surfaceOf,
  terminalRows,
  typeInTerminal,
  typeInTerminalWithoutClick,
} from '../helpers/terminal';

const SANDBOX_NAME = `acc-${process.pid}-${randomUUID().replaceAll('-', '').slice(0, 11)}`;
const IMAGE = 'sandbox-platform/base:0.3.0';
const SHIFT_ENTER_KEY = 'sandbox-console-terminal-shift-enter-escape';
const RIGHT_CLICK_KEY = 'sandbox-console-terminal-right-click-clipboard';

let sandboxClaimed = false;

async function cleanupSpecSandbox(): Promise<void> {
  if (!sandboxClaimed) {
    return;
  }
  await clearTerminalSessions(SANDBOX_NAME).catch(() => undefined);
  await deleteSandbox(SANDBOX_NAME).catch(() => undefined);
}

async function clearTerminalPreferences(page: Page): Promise<void> {
  await page.goto('/#/');
  await page.evaluate(
    ({ shiftEnterKey, rightClickKey }) => {
      localStorage.removeItem(shiftEnterKey);
      localStorage.removeItem(rightClickKey);
    },
    { shiftEnterKey: SHIFT_ENTER_KEY, rightClickKey: RIGHT_CLICK_KEY },
  );
  // 删除 localStorage 不会自动更新已挂载 Workbench 的 React 状态；重载后让
  // useTerminalPreferences 从已清空的存储重新初始化，避免旧偏好污染下一条分支。
  await page.reload();
}

async function enablePreference(page: Page, testId: string): Promise<void> {
  await clearTerminalPreferences(page);
  await openSettingsDrawer(page);
  const toggle = page.getByTestId(testId);
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('page-settings-dialog')).toBeHidden();
}

async function openFreshTerminal(page: Page): Promise<string> {
  await gotoDetail(page, SANDBOX_NAME);
  const sessionId = await openTerminal(page);
  await expectTerminalConnected(page);
  // 「已连接」对应服务端 hello，快照可能仍在随后到达；先等初始 shell
  // 提示符落到 xterm，避免命令抢在快照前执行而丢失 OSC 52 输出。
  await expect
    .poll(
      async () => (await terminalRows(page, sessionId)).some((row) => /[$#]\s*$/.test(row.trim())),
      { timeout: 15_000, message: '终端初始 shell 快照尚未就绪' },
    )
    .toBe(true);
  return sessionId;
}

async function readClipboard(page: Page): Promise<string> {
  return await page.evaluate(async () => await navigator.clipboard.readText());
}

async function writeClipboard(page: Page, text: string): Promise<void> {
  await page.evaluate(async (value) => await navigator.clipboard.writeText(value), text);
}

/**
 * 选中终端中整行等于 marker 的输出，返回可用于右键的字符范围。
 * xterm 的选区坐标来自 Range，避免按字符宽估算时偏一列。
 */
async function selectMarkerByDrag(
  page: Page,
  sessionId: string,
  marker: string,
): Promise<{ left: number; top: number; right: number; bottom: number }> {
  const surface = surfaceOf(page, sessionId);
  const box = await surface.evaluate((host, needle: string) => {
    const rows = host.querySelectorAll('.xterm-rows > div');
    for (const row of Array.from(rows)) {
      if ((row.textContent ?? '').trim() !== needle) {
        continue;
      }
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode() as Text | null;
      while (node) {
        const at = node.data.indexOf(needle);
        if (at >= 0) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + needle.length);
          const rect = range.getBoundingClientRect();
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        }
        node = walker.nextNode() as Text | null;
      }
    }
    return null;
  }, marker);
  if (!box) {
    throw new Error(`终端屏幕上找不到整行就是「${marker}」的输出`);
  }
  const y = (box.top + box.bottom) / 2;
  await page.mouse.move(box.left + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.right - 1, y, { steps: 5 });
  await page.mouse.up();
  await expect(surface.locator('.xterm-selection > div')).not.toHaveCount(0);
  return box;
}

async function rightClickAt(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('右键目标没有可见边界');
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
}

async function assertNoTerminalClipboardToast(page: Page): Promise<void> {
  await expect(toastItem(page, 'success', 'terminal-clipboard')).toHaveCount(0);
  await expect(toastItem(page, 'error', 'terminal-clipboard')).toHaveCount(0);
}

test.describe('终端交互增强', () => {
  test.beforeAll(async () => {
    const existing = (await listSandboxes()).find((item) => item.name === SANDBOX_NAME);
    if (existing) {
      throw new Error(`验收沙箱名意外已存在，拒绝复用：${SANDBOX_NAME}`);
    }
    // 名称已通过存在性检查；从这一刻起本 spec 独占该随机名称。即使创建
    // 中途失败，收尾也会尝试清理该名称下本 spec 可能已经产生的资源。
    sandboxClaimed = true;
    try {
      await createSandbox({
        name: SANDBOX_NAME,
        image: IMAGE,
        command: 'sleep infinity',
      });
    } catch (error) {
      await cleanupSpecSandbox();
      throw error;
    }
  });

  test.afterAll(async () => {
    await cleanupSpecSandbox();
  });

  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await clearTerminalSessions(SANDBOX_NAME);
  });

  test('设置抽屉：通用设置是第一个 tab 且默认激活', async ({ page }) => {
    await clearTerminalPreferences(page);
    await openSettingsDrawer(page);
    const tabs = page.getByTestId('page-settings-tabs');
    const order = await tabs.evaluate((element) =>
      Array.from(element.querySelectorAll<HTMLElement>('[data-testid]'))
        .map((item) => item.dataset.testid ?? '')
        .filter((id) => id.startsWith('page-settings-tab-')),
    );
    expect(order).toEqual([
      'page-settings-tab-general',
      'page-settings-tab-proxy',
      'page-settings-tab-templates',
    ]);
    await expect(page.getByTestId('page-settings-tab-general')).toHaveText('通用设置');
    await expect(page.getByTestId('page-settings-tab-general')).toHaveAttribute('data-active', '');
    await expect(page.getByTestId('page-settings-tab-proxy')).not.toHaveAttribute('data-active');
    await expect(page.getByTestId('page-settings-tab-templates')).not.toHaveAttribute('data-active');
  });

  test('通用设置：两个终端交互开关默认关闭', async ({ page }) => {
    await clearTerminalPreferences(page);
    await openSettingsDrawer(page);
    await expect(page.getByTestId('page-settings-terminal-interaction')).toBeVisible();
    await expect(page.getByTestId('page-settings-terminal-shift-enter-switch')).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await expect(page.getByTestId('page-settings-terminal-right-click-switch')).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  test('开关切换后刷新页面仍保持 localStorage 偏好', async ({ page }) => {
    await clearTerminalPreferences(page);
    await openSettingsDrawer(page);
    await page.getByTestId('page-settings-terminal-shift-enter-switch').click();
    await page.getByTestId('page-settings-terminal-right-click-switch').click();
    await expect(page.getByTestId('page-settings-terminal-shift-enter-switch')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByTestId('page-settings-terminal-right-click-switch')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect
      .poll(async () => await page.evaluate((key) => localStorage.getItem(key), SHIFT_ENTER_KEY))
      .toBe('1');
    await expect
      .poll(async () => await page.evaluate((key) => localStorage.getItem(key), RIGHT_CLICK_KEY))
      .toBe('1');

    await page.reload();
    await openSettingsDrawer(page);
    await expect(page.getByTestId('page-settings-terminal-shift-enter-switch')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByTestId('page-settings-terminal-right-click-switch')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test('Shift+Enter 开启后在 PTY 内发送完整 kitty CSI-u 序列，关闭时仍是单独回车', async ({ page }) => {
    await enablePreference(page, 'page-settings-terminal-shift-enter-switch');
    const enabledSession = await openFreshTerminal(page);
    await typeInTerminal(page, enabledSession, 'stty -icanon -icrnl -echo; cat -v');
    await focusTerminal(page, enabledSession);
    await page.keyboard.press('Shift+Enter');
    await expectTerminalText(page, enabledSession, '^[[13;2u', 15_000);

    await clearTerminalPreferences(page);
    const disabledSession = await openFreshTerminal(page);
    await typeInTerminal(page, disabledSession, 'stty -icanon -icrnl -echo; cat -v');
    await focusTerminal(page, disabledSession);
    await page.keyboard.press('Shift+Enter');
    await expectTerminalText(page, disabledSession, '^M', 15_000);
    await expectTerminalTextAbsent(page, disabledSession, '^[[13;2u', 3_000);
  });

  test('右键开启 + 终端内有选区：复制选区到系统剪贴板且不弹成功 toast', async ({ page }) => {
    await enablePreference(page, 'page-settings-terminal-right-click-switch');
    const sessionId = await openFreshTerminal(page);
    const marker = 'ACC_RIGHT_COPY_7x9';
    await typeInTerminal(page, sessionId, `echo ${marker}`);
    await expectTerminalRow(page, sessionId, marker);
    const box = await selectMarkerByDrag(page, sessionId, marker);
    await page.mouse.click((box.left + box.right) / 2, (box.top + box.bottom) / 2, {
      button: 'right',
    });
    await expect.poll(async () => (await readClipboard(page)).trim(), { timeout: 15_000 }).toBe(marker);
    await expect(surfaceOf(page, sessionId).locator('.xterm-selection > div')).toHaveCount(0);
    await assertNoTerminalClipboardToast(page);
  });

  test('右键开启 + 无选区：剪贴板内容粘贴进终端且不弹成功 toast', async ({ page }) => {
    await enablePreference(page, 'page-settings-terminal-right-click-switch');
    const sessionId = await openFreshTerminal(page);
    const marker = 'ACC_RIGHT_PASTE_3k5';
    await writeClipboard(page, marker);
    await typeInTerminalWithoutClick(
      page,
      sessionId,
      `read value; printf 'ACC_RIGHT_PASTE=%s\\n' "$value"`,
    );
    await rightClickAt(page, surfaceOf(page, sessionId));
    await expectTerminalText(page, sessionId, marker, 15_000);
    await focusTerminal(page, sessionId);
    await page.keyboard.press('Enter');
    await expectTerminalRow(page, sessionId, `ACC_RIGHT_PASTE=${marker}`);
    await assertNoTerminalClipboardToast(page);
  });

  test('右键开启但点击终端外部：无剪贴板副作用且不产生终端粘贴', async ({ page }) => {
    await enablePreference(page, 'page-settings-terminal-right-click-switch');
    const sessionId = await openFreshTerminal(page);
    const marker = 'ACC_RIGHT_OUTSIDE_4m2';
    const sentinel = 'ACC_CLIPBOARD_UNCHANGED_8p4';
    await writeClipboard(page, sentinel);
    await typeInTerminalWithoutClick(
      page,
      sessionId,
      `read value; printf 'ACC_RIGHT_OUTSIDE=%s\\n' "$value"`,
    );
    // 设置入口在终端面板外：它是原生 contextmenu 的可观测边界，不能被终端接管。
    await rightClickAt(page, page.getByTestId('page-layout-settings-button'));
    await expectTerminalTextAbsent(page, sessionId, marker, 2_000);
    expect(await readClipboard(page)).toBe(sentinel);
    await focusTerminal(page, sessionId);
    await page.keyboard.press('Enter');
    await expectTerminalRow(page, sessionId, 'ACC_RIGHT_OUTSIDE=');
    await assertNoTerminalClipboardToast(page);
  });

  test('右键关闭：终端内右键不产生前端复制 / 粘贴副作用', async ({ page }) => {
    await clearTerminalPreferences(page);
    const sessionId = await openFreshTerminal(page);
    const marker = 'ACC_RIGHT_DISABLED_6h2';
    const sentinel = 'ACC_CLIPBOARD_DISABLED_1q8';
    await writeClipboard(page, sentinel);
    await typeInTerminalWithoutClick(
      page,
      sessionId,
      `read value; printf 'ACC_RIGHT_DISABLED=%s\\n' "$value"`,
    );
    await rightClickAt(page, surfaceOf(page, sessionId));
    await expectTerminalTextAbsent(page, sessionId, marker, 2_000);
    expect(await readClipboard(page)).toBe(sentinel);
    await focusTerminal(page, sessionId);
    await page.keyboard.press('Enter');
    await expectTerminalRow(page, sessionId, 'ACC_RIGHT_DISABLED=');
    await assertNoTerminalClipboardToast(page);
  });

  test('OSC 52 set：终端序列把剪贴板写成目标文本', async ({ page }) => {
    await clearTerminalPreferences(page);
    const sessionId = await openFreshTerminal(page);
    const marker = 'ACC_OSC52_SET_7x9';
    const command = String.raw`printf '\033]52;c;%s\a' "$(printf '${marker}' | base64 | tr -d '\n')"`;
    await typeInTerminal(page, sessionId, command);
    await expect.poll(async () => await readClipboard(page), { timeout: 15_000 }).toBe(marker);
    await assertNoTerminalClipboardToast(page);
  });

  test('OSC 52 query：剪贴板响应经 PTY 回写并由 shell 内读回', async ({ page }) => {
    await clearTerminalPreferences(page);
    const sessionId = await openFreshTerminal(page);
    const marker = 'ACC_OSC52_QUERY_5m7';
    await writeClipboard(page, marker);
    const responseBytes = 7 + Buffer.from(marker).toString('base64').length + 1;
    const command = String.raw`stty -icanon min 1 time 0 -echo; printf '\033]52;c;?\a'; response=$(dd bs=1 count=${responseBytes} 2>/dev/null); stty echo; encoded=$(printf '%s' "$response" | tr -d '\a' | cut -d ';' -f 3); printf 'ACC_OSC52_QUERY=%s\n' "$(printf '%s' "$encoded" | base64 -d)"`;
    await typeInTerminal(page, sessionId, command);
    await expectTerminalRow(page, sessionId, `ACC_OSC52_QUERY=${marker}`);
    await assertNoTerminalClipboardToast(page);
  });

  test('OSC 52 边界：非 c 选择区与非法 base64 无剪贴板副作用且不弹成功 toast', async ({ page }) => {
    await clearTerminalPreferences(page);
    const sessionId = await openFreshTerminal(page);
    const sentinel = 'ACC_OSC52_BOUNDARY_SENTINEL_2v6';
    await writeClipboard(page, sentinel);
    const command = String.raw`stty -icanon min 0 time 1 -echo; printf '\033]52;p;%s\a' "$(printf 'ACC_OSC52_IGNORED_4r8' | base64 | tr -d '\n')"; printf '\033]52;s;?\a'; response=$(dd bs=1 count=128 2>/dev/null); stty echo; encoded=$(printf '%s' "$response" | tr -d '\a' | cut -d ';' -f 3); printf 'ACC_OSC52_BOUNDARY_RESPONSE=%s\n' "$encoded"; printf '\033]52;c;not-valid-base64!\a'`;
    await typeInTerminal(page, sessionId, command);
    await expect.poll(async () => await readClipboard(page), { timeout: 15_000 }).toBe(sentinel);
    await expectTerminalRow(page, sessionId, 'ACC_OSC52_BOUNDARY_RESPONSE=', 15_000);
    await assertNoTerminalClipboardToast(page);
  });
});
