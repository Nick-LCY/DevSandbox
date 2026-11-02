/**
 * 网页终端的剪贴板快捷键真机验收。
 *
 * 四条口径：
 * 1. **Ctrl+Shift+C**：终端里的选区复制到系统剪贴板（从剪贴板读回来逐字比对）；
 * 2. **Ctrl+Shift+V**：系统剪贴板的内容进到终端里（容器内的 shell 真收到了，
 *    判据是**输出行整行就是标记串**——命令回显行里也含标记串，不能拿它当证据）；
 * 3. **语义锁**：Ctrl+V 仍然是字面量 0x16（不碰系统剪贴板），
 *    Ctrl+C 仍然是发往容器的 SIGINT；
 *    0x16 到 pty 的证据：0x16 之后的第一枚 Ctrl+C 被**字面量插入**（回显成 ^C、
 *    当前命令行原样保留），第二枚 Ctrl+C 才真的中断；
 * 4. **没有选区**时按 Ctrl+Shift+C：静默无反馈（不弹提示、不抛异常）。
 *
 * 剪贴板接口要安全上下文：验收跑在 127.0.0.1 上（回环地址算安全上下文），
 * 读写权限在每个用例前显式授予。首用读取可能弹一次浏览器授权，属预期行为。
 */

import { expect, test, type Page } from '@playwright/test';

import { createSandbox, listSandboxes } from '../helpers/api';
import { gotoDetail, toastItem } from '../helpers/console';
import { readFixtures } from '../helpers/sandbox';
import {
  expectTerminalConnected,
  expectTerminalRow,
  expectTerminalTextAbsent,
  openTerminal,
  surfaceOf,
  terminalRows,
  typeInTerminal,
} from '../helpers/terminal';

/** 验收沙箱名（acc- 前缀：收尾清理只碰这个前缀）。 */
const SANDBOX_NAME = 'acc-clipboard';
/** 平台基础镜像（宿主已有）：本用例只关心终端快捷键，不依赖任何个人镜像。 */
const IMAGE = 'sandbox-platform/base:0.3.0';

/** 读系统剪贴板（页面上下文里读；读不到时把原因带回来，别让断言只显示"空"）。 */
async function readClipboard(page: Page): Promise<string> {
  return await page.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch (error) {
      return `__读取失败__:${error instanceof Error ? error.message : String(error)}`;
    }
  });
}

/** 往系统剪贴板写一段内容（页面上下文里写）。 */
async function writeClipboard(page: Page, text: string): Promise<void> {
  await page.evaluate(async (value: string) => {
    await navigator.clipboard.writeText(value);
  }, text);
}

/** 往终端里敲一段文字但**不回车**（粘贴用例要自己控制回车时机）。 */
async function typeWithoutEnter(page: Page, sessionId: string, text: string): Promise<void> {
  const surface = surfaceOf(page, sessionId);
  await surface.click();
  const textarea = surface.locator('textarea');
  if ((await textarea.count()) > 0) {
    await textarea.first().focus();
  }
  await page.keyboard.type(text);
}

/**
 * 终端当前输入行（屏幕最后一行非空内容）。
 *
 * 终端的光标永远在可视区的最后一行，所以「最后一行非空」就是当前正在编辑的那行：
 * shell 被中断时会另起一行新提示符，当前行随之变成新提示符。
 */
async function currentInputRow(page: Page, sessionId: string): Promise<string> {
  const rows = await terminalRows(page, sessionId);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const text = rows[index].trim();
    if (text !== '') {
      return text;
    }
  }
  return '';
}

/**
 * 把容器内 shell 的当前输入行清掉。
 *
 * 用例共用一个终端会话：上一条用例留在输入行里的半截命令会跟下一条串起来，
 * 所以每条用例先 Ctrl+C 丢弃当前行（Ctrl+C 到 pty 的语义不受影响）。
 */
async function resetShellLine(page: Page, sessionId: string): Promise<void> {
  const surface = surfaceOf(page, sessionId);
  await surface.click();
  const textarea = surface.locator('textarea');
  if ((await textarea.count()) > 0) {
    await textarea.first().focus();
  }
  await page.keyboard.press('Control+C');
}

/**
 * 附着到一个终端会话（没有就新建一个），返回会话标识。
 *
 * 面板会自动选中文档里第一个会话（标签 = 会话），所以进沙箱工作区即可附着；
 * 会话表空的时候自己新建一个。
 */
async function attachOrCreateTerminal(page: Page): Promise<string> {
  const response = await page.request.get(
    `/api/terminal/sessions?sandbox=${encodeURIComponent(SANDBOX_NAME)}`,
  );
  const records = (await response.json()) as { session_id: string }[];
  await gotoDetail(page, SANDBOX_NAME);
  if (records.length > 0) {
    const surface = page.locator('[data-testid="page-sandbox-detail-terminal-surface"]');
    await expect(surface).toHaveCount(1, { timeout: 60_000 });
    const sessionId = await surface.getAttribute('data-session-id');
    if (!sessionId) {
      throw new Error('终端表面上没有会话标识');
    }
    return sessionId;
  }
  return await openTerminal(page);
}

/**
 * 用鼠标在终端里拖选出某一行的标记串。
 *
 * 拖的是**整行**：标记串自己占一行（`echo` 的输出行），拖过它正好选中这段
 * 文字——复制出来的内容与标记串逐字相等，不带命令回显那一行的内容。
 *
 * 坐标用 Range 量出来（xterm 的 DOM 渲染器把字符放在 span 里，
 * 按字符格宽算容易差一格）。
 */
async function selectMarkerByDrag(page: Page, sessionId: string, marker: string): Promise<void> {
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
    const rows = await terminalRows(page, sessionId);
    throw new Error(
      `终端屏幕上找不到整行就是「${marker}」的那一行；当前屏幕：\n${rows.join('\n')}`,
    );
  }
  const y = (box.top + box.bottom) / 2;
  await page.mouse.move(box.left + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.right - 1, y, { steps: 5 });
  await page.mouse.up();
  // 拖选真的选中了东西：xterm 把选区画在 .xterm-selection 容器里。
  await expect(surface.locator('.xterm-selection > div')).not.toHaveCount(0);
}

test.describe('网页终端剪贴板', () => {
  test.beforeAll(async () => {
    readFixtures();
    // 用例失败后 worker 会重启，beforeAll 会重跑：建沙箱必须幂等
    const existing = (await listSandboxes()).find((item) => item.name === SANDBOX_NAME);
    if (!existing) {
      await createSandbox({
        name: SANDBOX_NAME,
        image: IMAGE,
        command: 'sleep infinity',
      });
    }
  });

  test.beforeEach(async ({ context }) => {
    // 剪贴板读写权限：回环地址是安全上下文，但读写权限仍要显式授予
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('Ctrl+Shift+C：选区复制到系统剪贴板', async ({ page }) => {
    const sessionId = await attachOrCreateTerminal(page);
    await expectTerminalConnected(page);
    await resetShellLine(page, sessionId);

    const marker = 'ACC_COPY_MARKER_7x9';
    await typeInTerminal(page, sessionId, `echo ${marker}`);
    // 输出行整行就是标记串（命令回显行不算）
    await expectTerminalRow(page, sessionId, marker);

    await selectMarkerByDrag(page, sessionId, marker);
    await page.keyboard.press('Control+Shift+C');

    // 剪贴板里就是刚才选中的那段文字
    await expect
      .poll(async () => (await readClipboard(page)).trim(), {
        timeout: 15_000,
        message: '系统剪贴板里没有复制到选中的内容',
      })
      .toBe(marker);
  });

  test('Ctrl+Shift+V：系统剪贴板的内容进到终端里', async ({ page }) => {
    const sessionId = await attachOrCreateTerminal(page);
    await expectTerminalConnected(page);
    await resetShellLine(page, sessionId);

    const marker = 'ACC_PASTE_MARKER_3k5';
    await writeClipboard(page, marker);

    // 先敲 echo 前缀，再粘贴，最后回车：输出行整行就是标记串 = 容器内的 shell 真收到了
    await typeWithoutEnter(page, sessionId, 'echo ');
    // 键盘输入到终端屏幕有延迟：先把输入行等稳，再记下粘贴前的整行
    await expect
      .poll(async () => (await currentInputRow(page, sessionId)).trim(), {
        timeout: 15_000,
        message: 'echo 前缀没有出现在终端上',
      })
      .toMatch(/echo$/);
    const rowBeforePaste = (await currentInputRow(page, sessionId)).trim();
    await page.keyboard.press('Control+Shift+V');
    // 粘贴是异步的（读剪贴板走 promise）：等它落到终端上再回车，
    // 否则回车会抢在粘贴前面，把命令提前提交出去。
    // 判据是**整行相等**：粘贴后的输入行必须正好是「粘贴前的行 + 标记串」——
    // 只看行里含不含标记串，会被命令回显行里的同名字符串骗过去。
    await expect
      .poll(async () => (await currentInputRow(page, sessionId)).trim(), {
        timeout: 15_000,
        message: '粘贴的内容没有出现在终端上',
      })
      .toBe(`${rowBeforePaste} ${marker}`);
    await page.keyboard.press('Enter');
    await expectTerminalRow(page, sessionId, marker);
  });

  test('语义锁：Ctrl+V 仍然是字面量 0x16，不粘贴系统剪贴板', async ({ page }) => {
    const sessionId = await attachOrCreateTerminal(page);
    await expectTerminalConnected(page);
    await resetShellLine(page, sessionId);

    const marker = 'ACC_PASTE_LOCK_9z1';
    await writeClipboard(page, marker);

    // 当前输入行里留一条半截命令（不回车）：0x16 之后的第一枚 Ctrl+C 若真到了 shell，
    // 这条命令会被打断（当前行换成新提示符）；若 0x16 把它吃成字面量，当前行原样保留。
    const lineMarker = 'ACC_LOCK_LINE_5r8';
    await typeWithoutEnter(page, sessionId, `echo ${lineMarker}`);

    await page.keyboard.press('Control+V');
    await page.waitForTimeout(1000);

    // 剪贴板里的内容没有进终端（0x16 只是让终端进入「下一个字符原样插入」状态）
    await expectTerminalTextAbsent(page, sessionId, marker);

    // 0x16 之后的第一枚 Ctrl+C 被字面量插入：伪终端把它回显成 ^C，当前行没被打断。
    await page.keyboard.press('Control+C');
    await expect
      .poll(async () => await currentInputRow(page, sessionId), {
        timeout: 15_000,
        message: '0x16 之后的第一枚 Ctrl+C 没有被字面量插入（当前行没有 ^C 回显）',
      })
      .toContain('^C');
    expect(
      await currentInputRow(page, sessionId),
      '0x16 之后的第一枚 Ctrl+C 打断了当前命令行（说明 0x16 没真正到 pty）',
    ).toContain(lineMarker);

    // 再按一次 Ctrl+C 才真的中断：当前行换成新提示符，半截命令被丢弃。
    await page.keyboard.press('Control+C');
    await expect
      .poll(async () => await currentInputRow(page, sessionId), {
        timeout: 15_000,
        message: '第二枚 Ctrl+C 没有真的中断当前命令行',
      })
      .not.toContain(lineMarker);

    // 终端随后照常执行命令（证明 Ctrl+C 到 pty 的语义没被改）。
    await typeInTerminal(page, sessionId, 'echo ACC_LOCK_ALIVE_4t6');
    await expectTerminalRow(page, sessionId, 'ACC_LOCK_ALIVE_4t6');
  });

  test('没有选区时按 Ctrl+Shift+C：静默无反馈', async ({ page }) => {
    const sessionId = await attachOrCreateTerminal(page);
    await expectTerminalConnected(page);

    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    // 单击终端清掉任何选区，再按 Ctrl+Shift+C
    await surfaceOf(page, sessionId).click();
    await page.keyboard.press('Control+Shift+C');

    // 等一会儿再看：成功路径零 UI 反馈，只有失败路径才有提示条
    await page.waitForTimeout(1000);
    // 零反馈的判定收窄到剪贴板来源：页面上别处弹的提示与本用例无关
    await expect(page.locator('[data-toast-source="terminal-clipboard"]')).toHaveCount(0);
    expect(pageErrors, '按 Ctrl+Shift+C 抛了页面异常').toEqual([]);
  });

  test('剪贴板不可用时弹失败提示', async ({ page }) => {
    // 让剪贴板 API 直接失败（非安全上下文 / 权限被拒都走这条路径）
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        get: () => ({
          writeText: () => Promise.reject(new Error('clipboard denied')),
          readText: () => Promise.reject(new Error('clipboard denied')),
        }),
      });
    });

    const sessionId = await attachOrCreateTerminal(page);
    await expectTerminalConnected(page);
    await resetShellLine(page, sessionId);

    const marker = 'ACC_CLIP_FAIL_2q4';
    await typeInTerminal(page, sessionId, `echo ${marker}`);
    await expectTerminalRow(page, sessionId, marker);
    await selectMarkerByDrag(page, sessionId, marker);

    // 复制失败：弹失败提示（来源标记 terminal-clipboard）
    await page.keyboard.press('Control+Shift+C');
    await expect(toastItem(page, 'error', 'terminal-clipboard')).toContainText(
      '复制到系统剪贴板失败',
      { timeout: 15_000 },
    );

    // 读取失败：弹失败提示
    await page.keyboard.press('Control+Shift+V');
    await expect(toastItem(page, 'error', 'terminal-clipboard')).toContainText(
      '读取系统剪贴板失败',
      { timeout: 15_000 },
    );
  });
});
