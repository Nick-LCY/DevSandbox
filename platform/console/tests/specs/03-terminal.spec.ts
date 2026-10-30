/**
 * 网页终端验收：
 * 一、同一沙箱开两个终端并行可用，两端互不串扰；
 * 二、断开浏览器后重连，终端现场（已输出内容与仍在运行的进程）不丢；
 * 三、重启服务后旧会话失效，且页面给出明确提示；
 * 四、终端聚焦时 Ctrl+C 真的送到了容器内的 shell。
 */

import { expect, test, type Page } from '@playwright/test';

import { createSandbox, listSandboxes } from '../helpers/api';
import { gotoDetail } from '../helpers/console';
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
  terminalText,
  typeInTerminal,
} from '../helpers/terminal';
import { restartConsoleServer } from '../helpers/server';

const SANDBOX_NAME = 'acc-term';
const IMAGE = 'sandbox-platform/base:0.2.0';

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
  });

  test('终端聚焦时 Ctrl+C 到达容器内的 shell', async ({ page }) => {
    await gotoDetail(page, SANDBOX_NAME);

    const sessionId = await openTerminal(page);
    await expectTerminalConnected(page);

    // 让 shell 跑一条前台长命令：它会阻塞住终端
    await typeInTerminal(page, sessionId, 'sleep 300');
    await expectTerminalText(page, sessionId, 'sleep 300');
    // 等 shell 真的进了 sleep（命令回显早于进程启动）
    await page.waitForTimeout(1000);

    // 发 Ctrl+C：浏览器不能抢走这个键，它必须编码后送进容器内的 pty
    await page.keyboard.press('Control+C');

    // 提示符回归（或 ^C 回显）+ 退出码 130（128 + SIGINT）
    await expectInterruptReachedShell(page, sessionId, 60_000);
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

    // ── 页面明确提示会话失效，并停止重连
    await expect(page.getByTestId('page-sandbox-detail-terminal-message')).toContainText(
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
});
