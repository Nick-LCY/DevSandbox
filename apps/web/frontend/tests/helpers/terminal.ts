/**
 * 网页终端的操作与断言。
 *
 * **标签 = 会话**：标签条的数据源就是后端的会话表，一个标签一个会话。
 * 点标签即附着到该会话（服务端回放现场缓冲）。
 *
 * xterm.js 用 DOM 渲染器，行文本落在 `.xterm-rows` 里：
 * 用 `textContent()` 读（`innerText()` 对隐藏元素返回空串，切换标签时会踩坑）。
 * 注意 `.xterm-rows` 的每个子 div 是**一行**，但 `textContent()` 会把各行
 * 首尾相接拼成一段没有换行的字符串——要按行数东西必须逐行读（`terminalRows`）。
 */

import { expect, type Page } from '@playwright/test';

const SURFACE = 'page-sandbox-detail-terminal-surface';

/** 某个会话的终端表面。 */
export function surfaceOf(page: Page, sessionId: string) {
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
 * 点击之前先确认「这次点击不是空操作」。
 *
 * 面板在路由不带会话标识时会自动选中第一个标签，那种情况下目标标签的
 * `data-active="true"` 在点击前就成立，点成空操作断言照样绿（单独重跑一条
 * 用例最容易踩）。所以点击前必须把目标标签处在「点一下会变」的状态：
 * - 它本来就不是激活态：直接点；
 * - 它已经是激活态：会话表里有别的标签就点别的标签，把它挤下去再回来点它；
 * - 它已经是激活态且会话表里只有它一个：面板必然自动选它，能证明「点击不是
 *   空操作」的只剩地址栏——点击前地址栏必须还不带该会话标识。
 */
async function expectClickIsNotNoop(page: Page, sessionId: string): Promise<void> {
  const tab = tabOf(page, sessionId);
  if ((await tab.getAttribute('data-active')) === 'false') {
    await expect(tab).toHaveAttribute('data-active', 'false');
    return;
  }
  // 已经是激活态：切到别的标签，把它挤下去。
  const other = page.locator(
    `[data-testid="page-sandbox-detail-terminal-tab"]:not([data-session-id="${sessionId}"])`,
  );
  if ((await other.count()) > 0) {
    await other.first().getByTestId('page-sandbox-detail-terminal-tab-select').click();
    await expect(tab).toHaveAttribute('data-active', 'false');
    return;
  }
  // 会话表里只有它一个：面板必然自动选它，只能拿地址栏当证据。
  expect(
    page.url(),
    '会话表里只有这一个会话（面板必然把它自动选成激活态）：点击前地址栏必须还不带该会话标识',
  ).not.toContain(encodeURIComponent(sessionId));
}

/**
 * 点某个会话的标签（标签 = 会话，点标签就是附着到这个会话）。
 *
 * 两道关都过才算附着成功：
 * ① 点击前目标标签必须处在「点一下会变」的状态（见 `expectClickIsNotNoop`）；
 * ② 点击后地址栏必须带上该会话标识（编码后比对）——附着真的发生了。
 */
async function clickTab(page: Page, sessionId: string): Promise<void> {
  const tab = tabOf(page, sessionId);
  await expect(tab).toHaveCount(1, { timeout: 30_000 });
  await expectClickIsNotNoop(page, sessionId);
  await tab.getByTestId('page-sandbox-detail-terminal-tab-select').click();
  await expect
    .poll(() => page.url(), {
      timeout: 30_000,
      message: `点标签之后地址栏没有带上会话 ${sessionId}`,
    })
    .toContain(encodeURIComponent(sessionId));
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
 * 读终端当前屏幕上的文本（各行首尾相接，没有换行）。
 */
export async function terminalText(page: Page, sessionId: string): Promise<string> {
  const rows = surfaceOf(page, sessionId).locator('.xterm-rows');
  return (await rows.textContent()) ?? '';
}

/**
 * 读终端当前屏幕上的**逐行**文本。
 *
 * `.xterm-rows` 的每个子 div 就是一行；`textContent()` 会把它们拼成一段没有
 * 换行的字符串，按行数东西（数输出行、数提示符）必须逐行读。
 */
export async function terminalRows(page: Page, sessionId: string): Promise<string[]> {
  const rows = surfaceOf(page, sessionId).locator('.xterm-rows > div');
  return await rows.evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''));
}

/**
 * 提示符行数：整行去掉空白后以 `$` 或 `#` 结尾的行。
 */
export function countPromptRows(rows: string[]): number {
  return rows.filter((row) => /[$#]$/.test(row.trim())).length;
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
 * 终端区域的布局实测：滚动条与出界判定用。
 *
 * 「挂载盒」= xterm 根元素（`.xterm`）的直接父元素，也就是 xterm 挂载、
 * fit 测量用的那个盒子。修复后它是表面内层的测量盒（无内边距、无边框），
 * fit 量到的就是真实可用空间。
 */
export interface TerminalLayout {
  /** 挂载盒的可视宽高（clientWidth / clientHeight）。 */
  mountClientWidth: number;
  mountClientHeight: number;
  /** 挂载盒的内容尺寸（scrollWidth / scrollHeight）：大于可视尺寸即溢出。 */
  mountScrollWidth: number;
  mountScrollHeight: number;
  /** 终端字符面的宽度（`.xterm-screen`）：超过挂载盒可视宽度即字符越界。 */
  screenWidth: number;
  /** 终端表面外层的 overflow 取值（外层一旦是 auto/scroll 就会多一根滚动条）。 */
  surfaceOverflowX: string;
  surfaceOverflowY: string;
  /** 终端区域内内容溢出的元素清单（类名 + 尺寸）。 */
  overflowing: {
    className: string;
    clientWidth: number;
    scrollWidth: number;
    clientHeight: number;
    scrollHeight: number;
  }[];
}

/**
 * 实测终端区域的布局：挂载盒尺寸、字符面宽度、外层 overflow、溢出元素清单。
 *
 * 溢出的判定口径：内容尺寸比可视尺寸大 1 像素以上就算溢出。
 * `.xterm-helpers` 排除在外——xterm 把输入法辅助层故意挪到屏幕外
 * （left: -9999em），它天然「溢出」，但不是滚动条。
 */
export async function terminalLayout(page: Page, sessionId: string): Promise<TerminalLayout> {
  const surface = surfaceOf(page, sessionId);
  return surface.evaluate((element) => {
    const host = element as HTMLElement;
    const xterm = host.querySelector('.xterm');
    const mount = (xterm?.parentElement ?? host) as HTMLElement;
    const screen = host.querySelector('.xterm-screen') as HTMLElement | null;
    const style = window.getComputedStyle(host);
    const overflowing: TerminalLayout['overflowing'] = [];
    const walk = (node: Element): void => {
      if (node instanceof HTMLElement && !node.classList.contains('xterm-helpers')) {
        if (
          node.scrollWidth > node.clientWidth + 1 ||
          node.scrollHeight > node.clientHeight + 1
        ) {
          overflowing.push({
            className: node.className,
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
          });
        }
      }
      for (const child of node.children) {
        walk(child);
      }
    };
    walk(host);
    return {
      mountClientWidth: mount.clientWidth,
      mountClientHeight: mount.clientHeight,
      mountScrollWidth: mount.scrollWidth,
      mountScrollHeight: mount.scrollHeight,
      screenWidth: screen ? screen.getBoundingClientRect().width : 0,
      surfaceOverflowX: style.overflowX,
      surfaceOverflowY: style.overflowY,
      overflowing,
    };
  });
}

/**
 * 读出页面里与 `.xterm-viewport` 相关的滚动条规则原文。
 *
 * 为什么要查规则而不是看渲染结果：验收跑在无头浏览器里，而无头 Chromium
 * 用的是**覆盖式滚动条**（宽度 0、不绘制），截图里根本看不到滚动条。
 * 只能直接查样式表，证明暗色定制样式真的接上了。
 */
export async function terminalScrollbarRules(page: Page, sessionId: string): Promise<string[]> {
  const surface = surfaceOf(page, sessionId);
  return surface.evaluate(() => {
    const found: string[] = [];
    const visit = (rules: CSSRuleList): void => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          if (rule.selectorText.includes('.xterm-viewport')) {
            found.push(`${rule.selectorText} { ${rule.style.cssText} }`);
          }
          continue;
        }
        const nested = (rule as CSSGroupingRule).cssRules;
        if (nested) {
          visit(nested);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        visit(sheet.cssRules);
      } catch {
        // 跨域样式表读不到规则：跳过（控制台自己的样式表都是同源的）。
      }
    }
    return found;
  });
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
 * 断言终端屏幕上有一行**整行就是**某段文本。
 *
 * 比 `expectTerminalText`（整屏包含）更严：命令回显行里也含这段文本，
 * 拿它当证据会把「命令敲进去了」误判成「命令执行了」。
 */
export async function expectTerminalRow(
  page: Page,
  sessionId: string,
  text: string,
  timeoutMs = 30_000,
): Promise<void> {
  await expect
    .poll(
      async () => (await terminalRows(page, sessionId)).some((row) => row.trim() === text),
      { timeout: timeoutMs, message: `终端 ${sessionId.slice(0, 8)} 的屏幕上没有整行就是「${text}」的行` },
    )
    .toBe(true);
}

/**
 * 断言 Ctrl+C 真的送到了容器内的 shell。
 *
 * 两道证据：
 * ① **中断本身**：终端里出现 `^C` 回显（伪终端把控制字符回显成 `^C`），
 *    或者提示符行数比中断前多了一条（shell 回到了提示符）。
 *    原来的 `[$#]\s*$` 是恒真条件——屏幕末尾本来就是提示符，等于没断言。
 * ② **硬证据**：shell 立刻能执行下一条命令，且上一条命令的退出码是 130
 *    （128 + SIGINT）。Ctrl+C 没到 shell 的话，shell 还卡在前台命令里，
 *    后面的 echo 根本不会执行。
 *
 * `beforeRows` 是中断前的屏幕快照（逐行），用来对比提示符行数；不给就只认
 * `^C` 回显这一条。
 */
export async function expectInterruptReachedShell(
  page: Page,
  sessionId: string,
  beforeRows: string[] = [],
  timeoutMs = 30_000,
): Promise<void> {
  // ① 中断证据：^C 回显，或者提示符行数比中断前多。
  const promptBefore = countPromptRows(beforeRows);
  await expect
    .poll(
      async () => {
        const rows = await terminalRows(page, sessionId);
        if (rows.some((row) => row.includes('^C'))) {
          return 'interrupted';
        }
        if (beforeRows.length > 0 && countPromptRows(rows) > promptBefore) {
          return 'interrupted';
        }
        return 'no-evidence';
      },
      {
        timeout: timeoutMs,
        message: 'Ctrl+C 之后终端既没有 ^C 回显，提示符行数也没有增加',
      },
    )
    .toBe('interrupted');

  // ② 硬证据：shell 立刻能执行下一条命令，上一条命令的退出码是 130。
  await typeInTerminal(page, sessionId, 'echo ACC_CTRL_C_STATUS_$?');
  await expectTerminalText(page, sessionId, 'ACC_CTRL_C_STATUS_130', timeoutMs);
}
