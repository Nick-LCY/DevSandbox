/**
 * 网页终端验收：
 * 一、同一沙箱开两个终端并行可用，两端互不串扰；
 * 二、断开浏览器后重连，终端现场（已输出内容与仍在运行的进程）不丢；
 * 三、重启服务后旧会话失效，且页面给出明确提示；
 * 四、终端聚焦时 Ctrl+C 真的送到了容器内的 shell；
 * 五、终端全屏：面板覆盖整屏、关会话确认弹窗浮在全屏之上、退出全屏复原；
 * 六、切换标签后不点终端表面，命令仍然敲得进 pty（重挂载后的焦点回填）；
 * 七、跨过一次 10 秒轮询窗口，当前会话不变、焦点不丢。
 */

import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

import { createSandbox, listSandboxes } from '../helpers/api';
import { gotoDetail, toastItem, waitDialogSettled } from '../helpers/console';
import { sandboxContainerState, userUid } from '../helpers/host';
import { readFixtures } from '../helpers/sandbox';
import {
  expectInterruptReachedShell,
  expectTerminalConnected,
  expectTerminalText,
  expectTerminalTextAbsent,
  openTerminal,
  reattachTerminal,
  selectTerminal,
  surfaceOf,
  terminalLayout,
  terminalRows,
  terminalScrollbarRules,
  terminalText,
  typeInTerminal,
} from '../helpers/terminal';
import { restartConsoleServer } from '../helpers/server';

const SANDBOX_NAME = 'acc-term';
const IMAGE = 'sandbox-platform/base:0.2.0';

/**
 * 终端区域的滚动条形态：截图留档文件名。
 *
 * 落在 tests/artifacts/ 下（该目录不进版本库），验收跑完直接翻图看。
 */
const TERMINAL_SHOT = 'terminal-surface-scrollbars.png';

/** 整行内容就是 TICK 的行数（命令回显那一行里有 TICK 字样，不算）。 */
function countTickLines(rows: string[]): number {
  return rows.filter((row) => row.trim() === 'TICK').length;
}

/** 从终端屏幕上读出 `键=值` 形式的数值输出（等它渲染出来）。 */
async function readTerminalValue(
  page: Page,
  sessionId: string,
  key: string,
  timeoutMs = 30_000,
): Promise<number> {
  let lastText = '';
  let value: number | null = null;
  await expect
    .poll(
      async () => {
        lastText = await terminalText(page, sessionId);
        const matches = [...lastText.matchAll(new RegExp(`${key}=([0-9]+)`, 'g'))];
        if (matches.length === 0) {
          return null;
        }
        value = Number.parseInt(matches[matches.length - 1][1], 10);
        return value;
      },
      { timeout: timeoutMs, message: `终端屏幕上找不到 ${key}=<数字>` },
    )
    .not.toBeNull();
  if (value === null) {
    throw new Error(`终端屏幕上找不到 ${key}=<数字>，屏幕内容：\n${lastText}`);
  }
  return value;
}

test.describe('网页终端', () => {
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

  test('同一沙箱两个终端并行可用，两端互不串扰', async ({ page }) => {
    await gotoDetail(page, SANDBOX_NAME);

    const first = await openTerminal(page);
    await expectTerminalConnected(page);
    await typeInTerminal(page, first, 'echo PARALLEL_ONE_9x7');
    await expectTerminalText(page, first, 'PARALLEL_ONE_9x7');

    const second = await openTerminal(page);
    await expectTerminalConnected(page);
    await typeInTerminal(page, second, 'echo PARALLEL_TWO_3k5');
    await expectTerminalText(page, second, 'PARALLEL_TWO_3k5');

    // 两端各自只看到自己的输出
    await selectTerminal(page, first);
    await expectTerminalConnected(page);
    await expectTerminalText(page, first, 'PARALLEL_ONE_9x7');
    await expectTerminalTextAbsent(page, first, 'PARALLEL_TWO_3k5');

    await selectTerminal(page, second);
    await expectTerminalConnected(page);
    await expectTerminalText(page, second, 'PARALLEL_TWO_3k5');
    await expectTerminalTextAbsent(page, second, 'PARALLEL_ONE_9x7');

    // 两个终端是两个独立的容器内进程（各自一个带真实 TTY 的 shell）
    const sessions = await page.request.get(
      `/api/terminal/sessions?sandbox=${encodeURIComponent(SANDBOX_NAME)}`,
    );
    const records = (await sessions.json()) as { session_id: string; pid: number }[];
    expect(records.length).toBeGreaterThanOrEqual(2);
    const pids = new Set(records.map((item) => item.pid));
    expect(pids.size).toBe(records.length);
    test.info().annotations.push({
      type: '终端会话',
      description: `${records.length} 个会话，宿主侧 exec 进程号互不相同：${records.map((item) => item.pid).join('、')}`,
    });

    // ── 关闭会话确认弹窗的宽度口径：360px（1920 视口下量）。
    // 复用已有会话（不新建）：每个沙箱的终端会话数有上限（5 个）。
    const originViewport = page.viewportSize();
    await page.setViewportSize({ width: 1920, height: 1080 });
    const firstTab = page.locator(
      `[data-testid="page-sandbox-detail-terminal-tab"][data-session-id="${first}"]`,
    );
    await firstTab.getByTestId('page-sandbox-detail-terminal-tab-close').click();
    const removeDialog = page.getByTestId('page-sandbox-detail-terminal-remove-confirm');
    await expect(removeDialog).toBeVisible();
    await waitDialogSettled(page, 'page-sandbox-detail-terminal-remove-confirm');
    const removeBox = (await removeDialog.boundingBox())!;
    expect(
      Math.abs(removeBox.width - 360),
      `关闭会话确认弹窗宽度应为 360px，实测 ${removeBox.width}px`,
    ).toBeLessThanOrEqual(2);
    // 收尾：取消，别真把会话关了（后面的用例还要用终端）。
    await page.getByTestId('page-sandbox-detail-terminal-remove-cancel-button').click();
    await expect(removeDialog).toBeHidden();
    if (originViewport) {
      await page.setViewportSize(originViewport);
    }
  });

  test('终端聚焦时 Ctrl+C 到达容器内的 shell', async ({ page }) => {
    await gotoDetail(page, SANDBOX_NAME);

    const sessionId = await openTerminal(page);
    await expectTerminalConnected(page);

    // 让 shell 跑一条**前台循环**：它占住终端，并每秒吐一行可数的证据。
    // （不用 sleep 300：命令回显早于进程启动，固定等待赌的是「进程起来了」，
    //   循环输出才是真证据——第一行 TICK 出现才说明循环真的在跑。）
    await typeInTerminal(page, sessionId, 'while :; do echo TICK; sleep 1; done');
    await expect
      .poll(async () => countTickLines(await terminalRows(page, sessionId)), {
        timeout: 30_000,
        message: '前台循环没有输出 TICK 行',
      })
      .toBeGreaterThan(0);

    // 中断前记下 TICK 行数与屏幕快照
    const beforeRows = await terminalRows(page, sessionId);
    const ticksBefore = countTickLines(beforeRows);

    // 发 Ctrl+C：浏览器不能抢走这个键，它必须编码后送进容器内的 pty
    await page.keyboard.press('Control+C');

    // 中断后 TICK 必须停止增长：观察窗口 3 秒，循环还活着的话至少再多出 3 行。
    // （+1 的余量：快照与 Ctrl+C 送达之间可能已经多吐了一行。）
    await page.waitForTimeout(3000);
    const ticksAfter = countTickLines(await terminalRows(page, sessionId));
    expect(
      ticksAfter,
      `Ctrl+C 之后前台循环还在输出：TICK 行数没有停止增长（中断前 ${ticksBefore}，中断后 ${ticksAfter}）`,
    ).toBeLessThanOrEqual(ticksBefore + 1);

    // 提示符回归 + 退出码 130（128 + SIGINT）
    await expectInterruptReachedShell(page, sessionId, beforeRows, 60_000);
  });

  test('断开浏览器后重连，终端现场不丢（输出与仍在运行的进程都还在）', async ({ page, browser }) => {
    await gotoDetail(page, SANDBOX_NAME);
    const sessionId = await openTerminal(page);
    await expectTerminalConnected(page);

    await typeInTerminal(page, sessionId, 'echo RECONNECT_MARKER_77');
    await expectTerminalText(page, sessionId, 'RECONNECT_MARKER_77');

    // 起一个后台进程，持续往容器内的文件里写时间戳
    await typeInTerminal(
      page,
      sessionId,
      "nohup sh -c 'while true; do date +%s%N >> /tmp/acc-tick.log; sleep 1; done' >/dev/null 2>&1 & echo TICK_STARTED",
    );
    await expectTerminalText(page, sessionId, 'TICK_STARTED');
    await typeInTerminal(
      page,
      sessionId,
      "cat /tmp/acc-tick.log | wc -l | tr -d ' ' | sed 's/^/TICKCOUNT=/'",
    );
    const before = await readTerminalValue(page, sessionId, 'TICKCOUNT');
    expect(before).toBeGreaterThan(0);

    // ── 断开浏览器（整个上下文关掉，WebSocket 断开）
    await page.context().close();
    await new Promise((resolve) => setTimeout(resolve, 4000));

    // ── 重连：开一个全新的浏览器上下文，直接落到该沙箱的工作区
    const context = await browser.newContext();
    const reconnected = await context.newPage();
    await gotoDetail(reconnected, SANDBOX_NAME);

    // 后端保留着会话，标签条里还在：点标签就是重新附着
    await reattachTerminal(reconnected, sessionId);

    // 现场不丢：之前输出过的内容回放出来了
    await expectTerminalText(reconnected, sessionId, 'RECONNECT_MARKER_77', 60_000);
    await expectTerminalConnected(reconnected);

    // 仍在运行的进程没被杀掉：计数继续涨
    await typeInTerminal(
      reconnected,
      sessionId,
      "cat /tmp/acc-tick.log | wc -l | tr -d ' ' | sed 's/^/TICKCOUNT=/'",
    );
    await expect
      .poll(async () => await readTerminalValue(reconnected, sessionId, 'TICKCOUNT'), {
        timeout: 30_000,
        message: '重连后后台进程的写入计数没有继续增长',
      })
      .toBeGreaterThan(before);

    await context.close();
  });

  test('重启服务后旧会话失效，页面给出明确提示', async ({ page }) => {
    const { port } = readFixtures();
    await gotoDetail(page, SANDBOX_NAME);
    const sessionId = await openTerminal(page);
    await expectTerminalConnected(page);
    await typeInTerminal(page, sessionId, 'echo RESTART_MARKER_55');
    await expectTerminalText(page, sessionId, 'RESTART_MARKER_55');

    // ── 重启控制台服务
    await restartConsoleServer(port);

    // ── 页面明确提示会话失效（右上角失败 toast），并停止重连
    await expect(toastItem(page, 'error')).toContainText(
      '终端会话已失效（后端服务已重启），请新建终端',
      { timeout: 120_000 },
    );
    await expect(page.getByTestId('page-sandbox-detail-terminal-status')).toHaveText('会话失效');

    // ── 服务端的会话表已清空：旧会话不再可附着
    const sessions = await page.request.get(
      `/api/terminal/sessions?sandbox=${encodeURIComponent(SANDBOX_NAME)}`,
    );
    const records = (await sessions.json()) as { session_id: string }[];
    expect(records.map((item) => item.session_id)).not.toContain(sessionId);

    // ── 服务重启不影响沙箱本身：容器还在跑
    const detail = await page.request.get(`/api/sandboxes/${SANDBOX_NAME}`);
    const body = (await detail.json()) as { system_user: string; container_name: string };
    const uid = userUid(body.system_user);
    expect(sandboxContainerState(body.system_user, uid, body.container_name)).toBe('running');
  });

  // ── 终端全屏：面板覆盖整页、弹窗浮在上面、退出后复原。
  // 复用本沙箱既有的会话，不新建沙箱。
  test('终端全屏：面板覆盖整屏，关会话确认弹窗浮在全屏之上，再点按钮退出复原', async ({ page }) => {
    await gotoDetail(page, SANDBOX_NAME);
    const sessionId = await openTerminal(page);
    await expectTerminalConnected(page);

    // 造出足够的回滚内容：全屏后终端内部那根滚动条必须还在（且只有一根）。
    await typeInTerminal(page, sessionId, 'seq 1 300');
    await expect
      .poll(async () => (await terminalRows(page, sessionId)).length, { timeout: 30_000 })
      .toBeGreaterThan(20);

    const panel = page.getByTestId('page-sandbox-detail-terminal-panel');
    const fullscreenButton = page.getByTestId('page-sandbox-detail-terminal-fullscreen-button');
    await expect(fullscreenButton).toBeVisible();
    await expect(panel).not.toHaveClass(/fixed/);

    // 进全屏：面板切到覆盖整页
    await fullscreenButton.click();
    await expect(panel).toHaveClass(/fixed/);
    await expect(panel).toHaveClass(/inset-0/);
    const viewport = page.viewportSize()!;
    const panelBox = (await panel.boundingBox())!;
    expect(
      panelBox.width,
      `全屏面板没有铺满视口宽：${panelBox.width}px / ${viewport.width}px`,
    ).toBeGreaterThanOrEqual(viewport.width - 1);
    expect(
      panelBox.height,
      `全屏面板没有铺满视口高：${panelBox.height}px / ${viewport.height}px`,
    ).toBeGreaterThanOrEqual(viewport.height - 1);

    // 终端表面仍可见，且终端区域内只有一根内部滚动条（xterm 自己的 viewport）
    await expect(surfaceOf(page, sessionId)).toBeVisible();
    const layout = await terminalLayout(page, sessionId);
    expect(layout.surfaceOverflowX).toBe('hidden');
    expect(layout.surfaceOverflowY).toBe('hidden');
    const extras = layout.overflowing.filter(
      (item) => !item.className.includes('xterm-viewport'),
    );
    expect(
      extras,
      `全屏后终端区域内出现了额外的溢出元素：${JSON.stringify(extras)}`,
    ).toEqual([]);
    expect(
      layout.overflowing.some((item) => item.className.includes('xterm-viewport')),
      '全屏后 xterm 内部的滚动条不见了',
    ).toBe(true);

    // 关会话的确认弹窗必须浮在全屏面板之上（弹窗 z-50 > 面板 z-40）
    const tab = page.locator(
      `[data-testid="page-sandbox-detail-terminal-tab"][data-session-id="${sessionId}"]`,
    );
    await tab.getByTestId('page-sandbox-detail-terminal-tab-close').click();
    const removeDialog = page.getByTestId('page-sandbox-detail-terminal-remove-confirm');
    await expect(removeDialog).toBeVisible();
    const panelZ = Number(
      await panel.evaluate((element) => window.getComputedStyle(element).zIndex),
    );
    const dialogZ = Number(
      await removeDialog.evaluate((element) => window.getComputedStyle(element).zIndex),
    );
    expect(dialogZ, '关会话确认弹窗没有浮在全屏面板之上').toBeGreaterThan(panelZ);
    // 弹窗真的能点（没被全屏面板挡住）
    await removeDialog.getByTestId('page-sandbox-detail-terminal-remove-cancel-button').click();
    await expect(removeDialog).toBeHidden();

    // 再点同一个按钮：退出全屏，回到常规布局
    await fullscreenButton.click();
    await expect(panel).not.toHaveClass(/fixed/);
  });

  // ── 会话切换 = 终端整块重挂载：不点终端表面，命令也得能敲进 pty。
  test('切换标签后不点终端表面，命令仍然敲得进 pty（重挂载后的焦点回填）', async ({ page }) => {
    await gotoDetail(page, SANDBOX_NAME);
    // 复用本沙箱（不新建沙箱），开两个会话：凑够两个标签可切。
    const first = await openTerminal(page);
    await expectTerminalConnected(page);
    const second = await openTerminal(page);
    await expectTerminalConnected(page);

    // 先切到第一个标签，再切到第二个（每次切换都是终端整块重挂载）
    await selectTerminal(page, first);
    await expectTerminalConnected(page);
    await selectTerminal(page, second);
    await expectTerminalConnected(page);

    // 焦点已经回到终端表面里：这一段全程没有点过终端表面。
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              document.activeElement?.closest(
                '[data-testid="page-sandbox-detail-terminal-surface"]',
              ) !== null,
          ),
        { timeout: 15_000, message: '切换标签后焦点没有回到终端表面里' },
      )
      .toBe(true);

    // 不点终端表面，直接敲命令：必须真的进到 pty（终端屏幕上有回显与输出）。
    await page.keyboard.type('echo AUTO_FOCUS_MARKER_42');
    await page.keyboard.press('Enter');
    await expectTerminalText(page, second, 'AUTO_FOCUS_MARKER_42');
  });

  // ── 会话表每 10 秒轻轮询一次：跨过一次轮询窗口，当前会话不能变、焦点不能丢。
  test('跨过一次 10 秒轮询窗口：当前会话不变，命令仍然敲得进', async ({ page }) => {
    await gotoDetail(page, SANDBOX_NAME);

    // 复用本沙箱既有的会话（不新建沙箱、不新建会话）
    // 标签条里至少得有一个标签。
    // （不能对 `.last()` 断言数量：它永远只匹配一条，断言恒真。）
    const tabs = page.getByTestId('page-sandbox-detail-terminal-tab');
    await expect(tabs.first()).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => tabs.count(), {
        timeout: 30_000,
        message: '标签条里一个会话标签都没有',
      })
      .toBeGreaterThan(0);
    const sessionId = (await tabs.last().getAttribute('data-session-id'))!;
    await selectTerminal(page, sessionId);
    await expectTerminalConnected(page);

    // 先把焦点放进终端（模拟用户正在终端里干活）
    await typeInTerminal(page, sessionId, 'echo POLL_BEFORE_MARKER_11');
    await expectTerminalText(page, sessionId, 'POLL_BEFORE_MARKER_11');

    // 跨过一次 10 秒轮询窗口：会话表会被重新拉一次
    await page.waitForTimeout(11_000);

    // 当前会话没变：标签仍是激活态，地址栏还带着会话标识
    await expect(
      page.locator(
        `[data-testid="page-sandbox-detail-terminal-tab"][data-session-id="${sessionId}"]`,
      ),
    ).toHaveAttribute('data-active', 'true');
    expect(page.url()).toContain(encodeURIComponent(sessionId));

    // 不点终端表面，直接敲命令：焦点没丢
    await page.keyboard.type('echo POLL_AFTER_MARKER_22');
    await page.keyboard.press('Enter');
    await expectTerminalText(page, sessionId, 'POLL_AFTER_MARKER_22');
  });

  // 放在最后一条：每个沙箱的终端会话数有上限（5 个），
  // 前面的用例各留了会话，这条只能排在它们后面。
  test('终端区域只有一根内部滚动条：外层不滚动、字符不出暗色面边缘', async ({ page }) => {
    await gotoDetail(page, SANDBOX_NAME);
    const sessionId = await openTerminal(page);
    await expectTerminalConnected(page);

    // 造出足够的回滚内容：xterm 内部那根滚动条必须真的能滚（不是摆设）。
    await typeInTerminal(page, sessionId, 'seq 1 300');
    await expect
      .poll(async () => (await terminalRows(page, sessionId)).length, { timeout: 30_000 })
      .toBeGreaterThan(20);

    // 等内部滚动条出现（viewport 的内容高度超过可视高度）。
    await expect
      .poll(
        async () => {
          const layout = await terminalLayout(page, sessionId);
          return layout.overflowing.some((item) => item.className.includes('xterm-viewport'));
        },
        { timeout: 30_000, message: 'xterm 内部 viewport 没有出现滚动条' },
      )
      .toBe(true);

    const layout = await terminalLayout(page, sessionId);

    // ① 挂载盒自身不溢出：终端正好落在可用空间里。
    expect(
      layout.mountScrollWidth,
      `挂载盒横向溢出：内容宽 ${layout.mountScrollWidth} > 可视宽 ${layout.mountClientWidth}`,
    ).toBeLessThanOrEqual(layout.mountClientWidth + 1);
    expect(
      layout.mountScrollHeight,
      `挂载盒纵向溢出：内容高 ${layout.mountScrollHeight} > 可视高 ${layout.mountClientHeight}`,
    ).toBeLessThanOrEqual(layout.mountClientHeight + 1);

    // ② 字符面不越过暗色面边缘。
    expect(
      layout.screenWidth,
      `终端字符面 ${layout.screenWidth} 宽，越过了挂载盒 ${layout.mountClientWidth} 的右边缘`,
    ).toBeLessThanOrEqual(layout.mountClientWidth);

    // ③ 终端表面外层不产生滚动条（一旦是 auto/scroll 就会多一根原生滚动条）。
    expect(layout.surfaceOverflowX).toBe('hidden');
    expect(layout.surfaceOverflowY).toBe('hidden');

    // ④ 终端区域内唯一能滚的就是 xterm 自己的 viewport。
    const extras = layout.overflowing.filter(
      (item) => !item.className.includes('xterm-viewport'),
    );
    expect(
      extras,
      `终端区域内出现了额外的溢出元素：${JSON.stringify(extras)}`,
    ).toEqual([]);

    // ⑤ 暗色定制滚动条真的接上了（无头浏览器不绘制滚动条，只能查样式表）。
    const rules = await terminalScrollbarRules(page, sessionId);
    expect(
      rules.some((rule) => rule.includes('::-webkit-scrollbar') && rule.includes('width: 8px')),
      `没有找到 8 像素宽的 .xterm-viewport 滚动条规则：${JSON.stringify(rules)}`,
    ).toBe(true);
    expect(
      rules.some((rule) => rule.includes('::-webkit-scrollbar-thumb')),
      `没有找到 .xterm-viewport 滚动条滑块规则：${JSON.stringify(rules)}`,
    ).toBe(true);

    // 留档：终端区域截图（人工确认滚动条形态）。
    // 路径相对本用例文件：tests/specs → tests/artifacts。
    await surfaceOf(page, sessionId).screenshot({
      path: path.resolve(test.info().file, '..', '..', 'artifacts', TERMINAL_SHOT),
    });
  });
});
