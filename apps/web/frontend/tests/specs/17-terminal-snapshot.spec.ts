/**
 * 网页终端的「屏幕快照恢复」验收。
 *
 * 背景：服务端常驻一份终端模拟器，附着时下发**屏幕快照**（VT 恢复流），
 * 前端按它恢复画面与终端模式——快照里没有探测，不会再有应答。旧实现靠
 * 「回放服务端的历史字节」恢复现场，两个后果：
 *
 * - **终端模式丢失**：pi 全屏时开的 DEC 私有模式（鼠标 1000/1002/1003/1006、
 *   焦点上报 1004、括号粘贴 2004、备用屏 1049）挂在 xterm 实例上，实例重建即
 *   归零，pi 侧不知情也不重发 ⇒ 鼠标、焦点事件、括号粘贴全部失效；
 * - **历史里的探测被再应答**：pi 启动时发过两包终端探测，历史回放时新 xterm
 *   实例把探测当新请求**再答一遍**，应答经 WS 写进 PTY 输入 ⇒ pi 退出后
 *   bash 把应答当键盘输入回显成乱码。
 *
 * **为什么用例必须强制重挂载**：终端实例自 6379e7e 起**常驻**——切标签只是把
 * 旧实例 `display:none` 藏起来，被验的那份实例全程存活，模式 / 画面 / 应答计数
 * 天然不变。若用例还按「切走再切回」取证，快照恢复路径一次都不会执行（假绿）。
 * 所以取证动作换成真正销毁旧实例、重新走 attach → snapshot 链路的操作：
 * **page.reload()**（旧 xterm 连同 DOM 全销毁，页面按路由重新附着，是最强的
 * 重挂载动作）。切到 Obsidian tab 再切回也能整块卸载分屏（既有约定），本轮
 * 统一用 reload。
 *
 * 四条口径（动作都是「重新附着后」）：
 *
 * 1. **重新附着后括号粘贴仍在**：`^[[200~…^[[201~` 包裹；
 * 2. **重新附着后鼠标上报仍在**：SGR 序列 `^[[<0;…`；
 * 3. **重新附着不再触发探测再应答**：屏幕上的 `1;2c` 次数**不变**（旧实现会多）；
 * 4. **重新附着后画面仍在**：快照恢复屏幕内容。
 *
 * **取证的三条约定**（都写在用例里，别改）：
 *
 * - **控制序列要看得见**：终端把 `ESC [ …` 当控制序列吃掉，屏幕上什么也没有。
 *   所以让容器内跑 `cat -v`（它把控制字符显示成 `^[` 记号）**并把 tty 切成
 *   非 canonical**（`stty -icanon -echo`）：非 canonical 才把字节立刻交给
 *   读取方（canonical 模式要等换行才交），`-echo` 免得 tty 自己回显一份，
 *   让证据只剩一份。
 * - **敲命令不点表面**：鼠标上报模式开着时，一次点击会被编码成鼠标序列
 *   **注入 PTY 输入**，把命令行搞脏。所以一律「聚焦 textarea + 敲键盘」。
 * - **模式必须由后台进程打开**（见 `startCatVWithMode`）：bash 的 readline
 *   在**提交命令行的那一刻**会发一包 `ESC[?2004l`（把括号粘贴模式关掉，
 *   免得命令自己的输出被裹进去）。前台 `printf '\033[?2004h'` 开出来的
 *   模式当场就被它关掉了 ⇒ 前台开模式等于没开。模式要等 readline 退场
 *   （前台命令跑起来）之后再开，所以只能由**后台进程**开。
 *
 * 本轮**不新增 data-testid**：沿用既有的终端表面与标签定位。
 */

import { expect, test, type Page } from '@playwright/test';

import { clearTerminalSessions, createSandbox, listSandboxes } from '../helpers/api';
import { gotoDetail } from '../helpers/console';
import { readFixtures } from '../helpers/sandbox';
import {
  countTerminalMatches,
  expectTerminalConnected,
  expectTerminalMatches,
  expectTerminalText,
  focusTerminal,
  openTerminal,
  pasteIntoTerminal,
  selectTerminal,
  surfaceOf,
  typeInTerminalWithoutClick,
} from '../helpers/terminal';

/** 验收沙箱名（acc- 前缀：收尾清理只碰这个前缀）。 */
const SANDBOX_NAME = 'acc-snapshot';
/** 平台基础镜像（宿主已有）：本用例只关心终端现场，不依赖任何个人镜像。 */
const IMAGE = 'sandbox-platform/base:0.3.0';

/**
 * 后台进程打出来的「模式序列已送达」记号。
 *
 * 它紧跟在模式序列**之后**写进 PTY：xterm 按字节顺序处理，记号出现在屏幕上
 * 时，模式序列早已被解析 ⇒ 模式确已生效（而不是「printf 敲进去了」）。
 */
const MODE_MARK = 'ACC_MODE_MARK';

/**
 * 被验的那条会话（建一次就复用：每个沙箱的终端会话数有上限，5 个）。
 */
let mainSessionId = '';

/**
 * 准备一条会话（建一次就复用），并附着到它。
 *
 * 每个沙箱的终端会话数有上限（5 个）：会话建一次就够，测试之间不再新建。
 */
async function prepareSession(page: Page): Promise<string> {
  await gotoDetail(page, SANDBOX_NAME);
  if (!mainSessionId) {
    // 首次建会话：新建后它已经是激活态（路由也带上了标识）——不能再「点一次」
    // （单会话时点击前的空操作检查要求地址栏还没带这个标识，见 selectTerminal）。
    mainSessionId = await openTerminal(page);
    await expectTerminalConnected(page);
    return mainSessionId;
  }
  await selectTerminal(page, mainSessionId);
  await expectTerminalConnected(page);
  return mainSessionId;
}

/**
 * 把终端恢复到「干净起点」：回到提示符、清屏、复位全部 DEC 私有模式。
 *
 * - `Ctrl+C`：打断前台程序（上一条用例可能留了 `cat -v` 在前台）并丢掉半截命令行；
 * - `stty icanon echo`：**把 tty 的行规程复位**。shell 跑完前台命令后
 *   **不恢复** tty 设置，上一条用例的 `stty -icanon -echo` 会**漏给下一条**
 *   ⇒ 命令不再回显、字节也不再按行交付。用例之间共用一条会话，必须显式复位；
 * - `printf '\033c'`（RIS）：清屏 **并** 复位终端模式（鼠标上报、括号粘贴）。
 *
 * 少了 RIS，上一条用例留下的鼠标上报模式会让本用例的**点击**往 PTY 里注入
 * 鼠标序列，把命令行搞脏。
 */
async function resetTerminal(page: Page, sessionId: string): Promise<void> {
  await focusTerminal(page, sessionId);
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(1000);
  await typeInTerminalWithoutClick(page, sessionId, 'stty icanon echo');
  await page.waitForTimeout(500);
  await typeInTerminalWithoutClick(page, sessionId, "printf '\\033c'");
  await page.waitForTimeout(1000);
}

/**
 * 让容器内跑起 `cat -v`（非 canonical、不回显），并**由后台进程**打开终端模式。
 *
 * 为什么要后台开模式：bash 的 readline 在**提交命令行的那一刻**会发一包
 * `ESC[?2004l`（关掉括号粘贴，免得命令自己的输出被裹进去）——前台
 * `printf '\033[?2004h'` 开出来的模式当场就被它关掉了。后台进程等 readline
 * 退场（前台命令已经跑起来）之后再开，才是真的开着。
 *
 * 这一条同时给出两个可靠的判据（**不用**「屏幕上出现命令原文」那种弱判据——
 * 命令回显在命令执行前就有，那时 `cat -v` 还没进前台）：
 *
 * ① **模式序列已送达**：`ACC_MODE_MARK` 紧跟在模式序列后面写进 PTY，
 *    xterm 按字节顺序处理 ⇒ 记号上屏时模式已生效；
 * ② **`cat -v` 真在前台**：后台进程顺手发一包 DA1 探测（`ESC [ c`），
 *    xterm 的应答（`ESC [ ? 1 ; 2 c`）是写进 **PTY 输入** 的，只有**前台
 *    进程**能读到它并显示出来 ⇒ 屏幕上出现 `1;2c` 就证明前台是 `cat -v`
 *    （canonical 模式下应答会卡在 tty 的行缓冲里，压根不会上屏）。
 *
 * @param modeArg 交给容器内 `printf` 的模式序列（shell 记法，如 `\033[?2004h`）。
 */
async function startCatVWithMode(
  page: Page,
  sessionId: string,
  modeArg: string,
): Promise<void> {
  const command =
    `(sleep 1; printf '${modeArg}'; printf '${MODE_MARK}'; printf '\\033[c') ` +
    '& stty -icanon -echo; cat -v';
  await typeInTerminalWithoutClick(page, sessionId, command);
  // ① 模式序列已送达（记号在它后面 ⇒ 模式已生效）
  await expectTerminalMatches(page, sessionId, new RegExp(MODE_MARK), 60_000);
  // ② cat -v 真在前台（DA1 的应答只有前台进程读得到）
  await expectTerminalMatches(page, sessionId, /1;2c/, 60_000);
}

/**
 * 强制重挂载终端实例（page.reload）并等快照恢复落定。
 *
 * 依赖重挂载动作：**page.reload()**。原因：实例常驻之后「切标签」只是
 * `display:none`，被验实例全程存活，模式 / 画面 / 应答计数天然不变——快照恢复
 * 路径一次都不会执行。reload 会把旧 xterm 连同 DOM 一起销毁，页面按路由重新
 * 附着，走完整 attach → snapshot 链路，这才是要验的路径。
 *
 * @param marker 重挂载后屏幕上**必须重新出现**的内容（快照落定的证据）：
 *   新实例的屏幕在快照到达前是空的，marker 出现才说明快照已经应用。
 */
async function reloadAndWaitSnapshot(
  page: Page,
  sessionId: string,
  marker: RegExp,
): Promise<void> {
  await page.reload();
  await expectTerminalConnected(page);
  // **等快照落定**：屏幕上重新出现重挂载前的内容 = 快照已应用
  await expectTerminalMatches(page, sessionId, marker, 60_000);
}

test.describe('网页终端的屏幕快照恢复', () => {
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
    // **清场**：会话记录是宿主侧持久资源，同一沙箱的会话数有上限（5 条），
    // 满了再新建就建不出来。worker 重启（浏览器崩过）后模块级变量会丢，
    // 再新建就撞上限 ⇒ 先把上一轮留下的会话清干净（14/15/16 同一口径）。
    await clearTerminalSessions(SANDBOX_NAME);
  });

  test('重新附着后括号粘贴仍在（reload → 快照恢复了 2004 模式）', async ({ page }) => {
    const sessionId = await prepareSession(page);
    await resetTerminal(page, sessionId);

    // 开括号粘贴模式（2004）：**必须由后台进程开**（readline 会当场关掉前台开的那次）
    await startCatVWithMode(page, sessionId, '\\033[?2004h');

    // 依赖重挂载动作：page.reload()（切标签不销毁实例，快照路径不会执行）。
    // 重挂载后模式全靠快照恢复。
    await reloadAndWaitSnapshot(page, sessionId, new RegExp(MODE_MARK));

    // 派发一次粘贴：括号粘贴模式在 ⇒ 内容被 ^[[200~ … ^[[201~ 包裹
    await focusTerminal(page, sessionId);
    await pasteIntoTerminal(page, sessionId, 'ACC_PASTE_AFTER_SWITCH');
    // 补一个回车：canonical 模式要等换行才把这一行交给 cat -v
    await page.keyboard.press('Enter');
    await expectTerminalMatches(
      page,
      sessionId,
      /\^\[\[200~ACC_PASTE_AFTER_SWITCH\^\[\[201~/,
      60_000,
    );
  });

  test('重新附着后鼠标上报仍在（reload → 快照恢复了 1000/1006 模式）', async ({ page }) => {
    const sessionId = await prepareSession(page);
    await resetTerminal(page, sessionId);

    // 开鼠标上报（1000 = 按键上报、1006 = SGR 编码）
    await startCatVWithMode(page, sessionId, '\\033[?1000h\\033[?1006h');

    // 依赖重挂载动作：page.reload()（切标签不销毁实例，快照路径不会执行）。
    await reloadAndWaitSnapshot(page, sessionId, new RegExp(MODE_MARK));

    // 点终端表面：鼠标上报模式在 ⇒ 容器里能收到 SGR 序列
    await surfaceOf(page, sessionId).click();
    await expectTerminalMatches(page, sessionId, /\^\[\[<0;/, 60_000);
  });

  test('重新附着不再触发探测再应答（reload → DA1 的应答次数不变）', async ({ page }) => {
    const sessionId = await prepareSession(page);
    await resetTerminal(page, sessionId);

    // 起一个后台子进程：1 秒后吐出终端探测（kitty 键盘查询 + DA1）。
    // 前台的 cat -v 负责把 DA1 的应答显示出来（应答是写进 PTY 输入的字节）。
    await typeInTerminalWithoutClick(
      page,
      sessionId,
      "(sleep 1; printf '\\033[>7u\\033[c') & stty -icanon -echo; cat -v",
    );
    // 应答被写进 PTY 输入，cat -v 显示出来（屏幕上能看到 1;2c）
    // ——它出现在屏幕上还顺带证明了 cat -v 真的在前台。
    await expect
      .poll(async () => await countTerminalMatches(page, sessionId, '1;2c'), {
        timeout: 30_000,
        message: 'DA1 的应答没有出现在屏幕上（探测没生效，用例无从验证）',
      })
      .toBeGreaterThan(0);
    const before = await countTerminalMatches(page, sessionId, '1;2c');

    // 依赖重挂载动作：page.reload()（切标签不销毁实例，快照路径不会执行）。
    // 旧实现回放历史字节 ⇒ 探测被再答一遍（次数变多）；快照只恢复画面，不再应答。
    await reloadAndWaitSnapshot(page, sessionId, /1;2c/);
    // 给迟到应答留观察窗口：新实例若把探测当新请求，应答会在这段时间内上屏。
    await page.waitForTimeout(2000);

    const after = await countTerminalMatches(page, sessionId, '1;2c');
    expect(
      after,
      `重新附着后 DA1 的应答次数变了（重挂载前 ${before}、重挂载后 ${after}）：历史里的探测被再应答了`,
    ).toBe(before);
  });

  test('重新附着后画面仍在（reload → 快照恢复屏幕内容）', async ({ page }) => {
    const sessionId = await prepareSession(page);
    await resetTerminal(page, sessionId);

    await typeInTerminalWithoutClick(page, sessionId, 'seq 1 200');
    await expectTerminalText(page, sessionId, '200', 60_000);

    // 依赖重挂载动作：page.reload()（切标签不销毁实例，快照路径不会执行）。
    await reloadAndWaitSnapshot(page, sessionId, /200/);

    // 快照恢复的是「当前屏幕」：末尾的序号仍然看得见
    await expectTerminalText(page, sessionId, '200', 60_000);
  });
});
