/**
 * 文件窗格（终端右侧分屏）真机验收。
 *
 * 需求：`docs/prds/file-pane-obsidian.md`「验收标准」文件窗格（FP）一节；
 * 任务：`docs/tasks/file-pane-obsidian/04-file-pane-split.md`（分屏骨架）与
 * 08（验收）——本 spec 对应 PRD 的 **QA-01 主链路**里「文件窗格分屏 / 折叠 /
 * 空态」三项。
 *
 * 钉的行为（全部在真浏览器 + 真沙箱上跑）：
 *
 * 一、**分屏三段式**：左终端面板 + 中接缝拖拽把手 + 右文件窗格，三者**零间隙贴合成
 *    一块带边框的面板**（用户浏览器复验修复轮：把手骑在接缝上、不再占布局宽度）；
 *    窗格默认宽 340px，把手可拖拽（往左变宽、往右变窄）与方向键调宽，窗格有最小宽度
 *    240px、上限 720px，且**终端面板有最小宽度钳位**（拖到最窄时终端不被压没）；
 * 二、**折叠**：折叠为右缘 **36px 纯图标竖条**，竖条上**不显示任何文字**、
 *    **只有顶部一个展开按钮**（不再在底部，与展开态工具条右端的折叠钮同一位置
 *    语义）；折叠态记在前端本地（localStorage），**刷新后保持**；
 *    展开即回到原宽度；
 * 三、**入口随会话**：关闭全部会话 ⇒ 窗格**整体消失**（连分隔条一起），内容区显示
 *    空态（标题「没有终端会话」+ 新建会话入口）；点入口新建会话后窗格恢复，
 *    且**折叠态与关闭前一致**；
 * 四、**pwd 通道的可见产物**：回跳准星按钮的 tooltip 随会话 pwd 更新、窗格已在
 *    目标目录时禁用、点击即回到会话目录（PRD FP-07 的界面侧证据）；
 * 五、**抽屉退役**：工作区头部不再有「文件」按钮、全局文件抽屉标识不复存在
 *    （PRD FP-02；退役标识见前端 README 的「退役标识」段）。
 *
 * 镜像：`sandbox-platform/base:0.3.1`（本轮 base image，含 OSC 1337 pwd 注入）。
 * 沙箱走既有的接口直建通道（`helpers/api.createSandbox`），用例结束必删。
 *
 * 口径说明（折叠态的持久化）：折叠态按**应用**记在 localStorage
 * （`sandbox-console-file-pane-collapsed`，与侧栏折叠同一套惯例），Playwright
 * 每条用例一个全新 context，所以本 spec 里的「刷新后保持」用**同一条用例内
 * 重新导航**来验（刷新一次页面即新一次挂载），不靠跨用例残留。
 */

import { expect, test, type Page } from '@playwright/test';

import { clearTerminalSessions, createSandbox, deleteSandbox, uploadSandboxFile } from '../helpers/api';
import { gotoDetail } from '../helpers/console';
import {
  crumbs,
  expectPaneAt,
  filePane,
  openFilePane,
  paneCollapsed,
  paneContent,
  paneHandle,
  splitTerminal,
} from '../helpers/file-pane';
import { readFixtures } from '../helpers/sandbox';
import { openTerminal } from '../helpers/terminal';

/** 本轮 base image（0.3.1：locale ENV + bashrc OSC 1337 pwd 注入）。 */
const IMAGE = 'sandbox-platform/base:0.3.1';
/** 主链路沙箱。 */
const SANDBOX = 'acc-pane';
/** 容器内 workdir（显式给，起手目录确定）。 */
const WORKSPACE = '/workspace';

/** 折叠态竖条的宽度（前端契约副本，故意各留一份：改了要红）。 */
const COLLAPSED_WIDTH_PX = 36;
/** 窗格默认宽度（同上）。 */
const DEFAULT_WIDTH_PX = 340;
/** 窗格最小宽度（同上）。 */
const MIN_WIDTH_PX = 240;
/** 终端面板的最小宽度（同上）。 */
const MIN_TERMINAL_WIDTH_PX = 320;

/** 量一个元素的整数化宽度。 */
async function widthOf(page: Page, testId: string): Promise<number> {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box, `量不到 ${testId} 的位置`).not.toBeNull();
  return Math.round(box!.width);
}

/** 拖分隔条：从当前指针位置拖到 `offsetX`（相对起点，负数 = 往左 = 窗格变宽）。 */
async function dragHandle(page: Page, offsetX: number): Promise<void> {
  const box = await paneHandle(page).boundingBox();
  expect(box, '量不到分隔条的位置').not.toBeNull();
  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + offsetX, startY, { steps: 8 });
  await page.mouse.up();
}

test.describe('文件窗格（终端右侧分屏）', () => {
  test.beforeAll(async () => {
    readFixtures();
    // 「先删再建」：容器从干净状态开始（残留的会话 / 文件会让分屏断言失真）。
    await deleteSandbox(SANDBOX).catch(() => undefined);
    await createSandbox({
      name: SANDBOX,
      image: IMAGE,
      command: 'sleep infinity',
      workdir: WORKSPACE,
    });
  });

  test.afterAll(async () => {
    await deleteSandbox(SANDBOX).catch(() => undefined);
  });

  /*
   * 会话记录是**宿主侧持久资源**（同一沙箱上限 5 个，满了新建会报错）：
   * 同一沙箱的多条用例会看到彼此留下的会话。每条用例开始前清场，
   * 「零会话 / 一条会话」这类断言才不依赖用例执行顺序。
   */
  test.beforeEach(async () => {
    await clearTerminalSessions(SANDBOX);
  });

  test('分屏三段式：左终端 + 分隔条 + 右窗格，默认 340px，可拖拽 / 方向键调宽，终端有最小宽度钳位', async ({
    page,
  }) => {
    await gotoDetail(page, SANDBOX);
    await openFilePane(page);
    await expectPaneAt(page, ['workspace']);

    // ── ① 三段式：三块都在，且**从左到右**依次排开（同一行）
    const split = page.getByTestId('page-terminal-split');
    await expect(split).toBeVisible();
    await expect(splitTerminal(page)).toBeVisible();
    await expect(paneHandle(page)).toBeVisible();
    await expect(filePane(page)).toBeVisible();
    await expect(paneContent(page)).toBeVisible();

    const termBox = await splitTerminal(page).boundingBox();
    const handleBox = await paneHandle(page).boundingBox();
    const paneBox = await filePane(page).boundingBox();
    expect(termBox, '量不到终端面板').not.toBeNull();
    expect(handleBox, '量不到分隔条').not.toBeNull();
    expect(paneBox, '量不到文件窗格').not.toBeNull();
    expect(termBox!.x, '终端面板不在分隔条左侧').toBeLessThan(handleBox!.x);
    expect(handleBox!.x, '分隔条不在文件窗格左侧').toBeLessThan(paneBox!.x);
    // 三块在**同一行**（纵向坐标相近：分屏是横向排布的）
    expect(Math.abs(termBox!.y - paneBox!.y), '终端面板与文件窗格不在同一行').toBeLessThan(4);
    // 窗格默认宽约 340px（README 契约 + PRD FP-01）
    expect(Math.round(paneBox!.width), '文件窗格默认宽度不是 340px').toBe(DEFAULT_WIDTH_PX);

    // ── ①b 视觉合并：终端与窗格**零间隙**贴成一块，把手骑在接缝上
    //（用户浏览器复验修复轮：不再有分隔条占出的透明间隙）
    const seamGap = paneBox!.x - (termBox!.x + termBox!.width);
    expect(seamGap, '终端与文件窗格之间有间隙（应零间隙贴合成一块）').toBeLessThanOrEqual(2);
    const seamX = termBox!.x + termBox!.width;
    const handleCenterX = handleBox!.x + handleBox!.width / 2;
    expect(
      Math.abs(handleCenterX - seamX),
      '拖拽把手不在终端与窗格的接缝上',
    ).toBeLessThanOrEqual(8);

    // ── ② 分隔条是**可拖拽的接缝把手**：role=separator + 竖直方向 + 数值可读
    await expect(paneHandle(page)).toHaveAttribute('role', 'separator');
    await expect(paneHandle(page)).toHaveAttribute('aria-orientation', 'vertical');
    await expect(paneHandle(page)).toHaveAttribute('aria-valuemin', String(MIN_WIDTH_PX));
    await expect(paneHandle(page)).toHaveAttribute(
      'aria-valuenow',
      String(DEFAULT_WIDTH_PX),
    );

    // ── ③ 方向键调宽：← 变宽 16px、→ 变窄 16px（键盘可用性）
    await paneHandle(page).focus();
    await paneHandle(page).press('ArrowLeft');
    await expect(paneHandle(page)).toHaveAttribute(
      'aria-valuenow',
      String(DEFAULT_WIDTH_PX + 16),
    );
    expect(await widthOf(page, 'page-file-pane')).toBe(DEFAULT_WIDTH_PX + 16);
    await paneHandle(page).press('ArrowRight');
    await expect(paneHandle(page)).toHaveAttribute('aria-valuenow', String(DEFAULT_WIDTH_PX));

    // ── ④ 指针拖拽：往左 100px ⇒ 窗格变宽约 100px
    await dragHandle(page, -100);
    const widened = await widthOf(page, 'page-file-pane');
    expect(widened, `往左拖 100px 后窗格宽应在 ${DEFAULT_WIDTH_PX + 90}~${DEFAULT_WIDTH_PX + 110} 之间`)
      .toBeGreaterThanOrEqual(DEFAULT_WIDTH_PX + 90);
    expect(widened).toBeLessThanOrEqual(DEFAULT_WIDTH_PX + 110);

    // ── ⑤ 最小宽度钳位：往右猛拖 ⇒ 窗格钳到 240px，**终端面板不被压没**
    await dragHandle(page, 400);
    const shrunk = await widthOf(page, 'page-file-pane');
    expect(shrunk, `往右拖到底后窗格宽应钳到 ${MIN_WIDTH_PX}px`).toBe(MIN_WIDTH_PX);
    await expect(paneHandle(page)).toHaveAttribute('aria-valuenow', String(MIN_WIDTH_PX));
    const terminalWidth = await widthOf(page, 'page-terminal-split-terminal');
    expect(
      terminalWidth,
      `窗格拖到最窄后终端面板被压到 ${terminalWidth}px（最小宽度钳位失效）`,
    ).toBeGreaterThanOrEqual(MIN_TERMINAL_WIDTH_PX);

    // ── ⑥ 抽屉退役（PRD FP-02）：工作区头部没有「文件」按钮、全局抽屉标识不复存在
    await expect(
      page.getByTestId('page-sandbox-detail-files-button'),
      '工作区头部仍有已退役的「文件」按钮',
    ).toHaveCount(0);
    await expect(
      page.getByTestId('page-file-browser-dialog'),
      '全局文件抽屉仍在渲染（抽屉形态应已退役）',
    ).toHaveCount(0);
  });

  test('折叠：36px 纯图标竖条（无文字、只有一个展开按钮），刷新后保持，展开恢复', async ({
    page,
  }) => {
    await gotoDetail(page, SANDBOX);
    const sessionId = await openFilePane(page);
    await expectPaneAt(page, ['workspace']);

    // ── ① 折叠：竖条出现、面板根消失、分隔条一起收掉
    await page.getByTestId('page-file-pane-collapse-button').click();
    await expect(paneCollapsed(page)).toBeVisible();
    await expect(paneContent(page), '折叠后展开态的面板根仍然存在').toHaveCount(0);
    await expect(paneHandle(page), '折叠后分隔条仍然存在').toHaveCount(0);

    // ── ② 竖条是 **36px** 宽，且**不显示任何文字**
    expect(await widthOf(page, 'page-file-pane'), '折叠态竖条宽度不是 36px').toBe(
      COLLAPSED_WIDTH_PX,
    );
    const collapsedText = (await paneCollapsed(page).textContent()) ?? '';
    expect(collapsedText.trim(), `折叠态竖条上出现了文字：「${collapsedText}」`).toBe('');

    // ── ③ 竖条**顶部**只有一个按钮（展开，与展开态工具条右端的折叠钮同一位置
    // 语义），没有回跳 / 上级目录等其它按钮
    const barButtons = paneCollapsed(page).locator('button');
    await expect(barButtons).toHaveCount(1);
    await expect(barButtons.first()).toHaveAttribute('aria-label', '展开文件窗格');
    await expect(paneCollapsed(page).getByTestId('page-file-pane-expand-button')).toBeVisible();
    await expect(
      paneCollapsed(page).getByTestId('page-file-pane-jump-button'),
      '折叠竖条上出现了回跳按钮（非目标：竖条上只留展开按钮）',
    ).toHaveCount(0);
    // 展开钮在竖条**顶部**（用户浏览器复验修复轮：不再贴底）
    const barBox = await paneCollapsed(page).boundingBox();
    const expandBox = await paneCollapsed(page)
      .getByTestId('page-file-pane-expand-button')
      .boundingBox();
    expect(barBox, '量不到折叠竖条').not.toBeNull();
    expect(expandBox, '量不到展开按钮').not.toBeNull();
    expect(
      expandBox!.y - barBox!.y,
      '展开按钮不在竖条顶部（应贴近竖条顶端）',
    ).toBeLessThanOrEqual(12);

    // ── ④ 折叠态**前端本地记忆**：重新打开工作区（刷新一次页面）仍然是折叠态
    await gotoDetail(page, SANDBOX);
    // 面板在路由不带会话标识时自动选中已有会话，窗格随之恢复（折叠态）
    await expect(paneCollapsed(page), '刷新后折叠态没有保持').toBeVisible({ timeout: 60_000 });
    expect(await widthOf(page, 'page-file-pane')).toBe(COLLAPSED_WIDTH_PX);

    // ── ⑤ 展开：回到展开态，宽度回到默认（未被持久化的宽度值也不越界）
    await page.getByTestId('page-file-pane-expand-button').click();
    await expect(paneContent(page)).toBeVisible();
    await expect(paneCollapsed(page)).toHaveCount(0);
    const expandedWidth = await widthOf(page, 'page-file-pane');
    expect(expandedWidth, '展开后的窗格宽度不合理').toBeGreaterThanOrEqual(MIN_WIDTH_PX);
    expect(expandedWidth).toBe(DEFAULT_WIDTH_PX);
    // 展开后分隔条回来了（终端 tab 的三段式恢复）
    await expect(paneHandle(page)).toBeVisible();
    // 会话还在（折叠 / 展开不影响终端）
    await expect(
      page.locator(
        `[data-testid="page-sandbox-detail-terminal-tab"][data-session-id="${sessionId}"]`,
      ),
    ).toHaveCount(1);
  });

  test('关闭全部会话：窗格消失 + 空态「没有终端会话」+ 新建入口恢复且折叠态保持', async ({
    page,
  }) => {
    await gotoDetail(page, SANDBOX);
    const sessionId = await openFilePane(page);
    await expectPaneAt(page, ['workspace']);

    // 先折叠：关掉会话再新建，窗格要按**原来的折叠态**恢复（PRD FP-03 / FP-04）
    await page.getByTestId('page-file-pane-collapse-button').click();
    await expect(paneCollapsed(page)).toBeVisible();

    // 关掉唯一的会话（走确认弹窗：运行中的会话要先确认）
    await page
      .locator(`[data-testid="page-sandbox-detail-terminal-tab"][data-session-id="${sessionId}"]`)
      .getByTestId('page-sandbox-detail-terminal-tab-close')
      .click();
    await expect(page.getByTestId('page-sandbox-detail-terminal-remove-confirm')).toBeVisible();
    await page.getByTestId('page-sandbox-detail-terminal-remove-confirm-button').click();

    // ── ① 空态：标题「没有终端会话」+ 新建会话入口
    await expect(page.getByTestId('page-sandbox-detail-terminal-placeholder')).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId('page-sandbox-detail-terminal-empty-title')).toHaveText(
      '没有终端会话',
    );
    await expect(page.getByTestId('page-sandbox-detail-terminal-empty-create-button')).toBeVisible();

    // ── ② 窗格**整体消失**（连分隔条一起）
    await expect(filePane(page), '没有会话时文件窗格仍然存在').toHaveCount(0);
    await expect(paneHandle(page), '没有会话时分隔条仍然存在').toHaveCount(0);
    await expect(paneContent(page)).toHaveCount(0);
    await expect(paneCollapsed(page)).toHaveCount(0);

    // ── ③ 点空态的新建入口：会话回来、窗格恢复且**仍是折叠态**
    await page.getByTestId('page-sandbox-detail-terminal-empty-create-button').click();
    await expect(
      page.getByTestId('page-sandbox-detail-terminal-tab'),
      '点空态入口后没有新建出会话',
    ).toHaveCount(1, { timeout: 60_000 });
    await expect(paneCollapsed(page), '新建会话后窗格没有按原折叠态恢复').toBeVisible({
      timeout: 60_000,
    });
    expect(await widthOf(page, 'page-file-pane')).toBe(COLLAPSED_WIDTH_PX);

    // 展开后列表照常可用（窗格不是「假恢复」）
    await page.getByTestId('page-file-pane-expand-button').click();
    await expect(paneContent(page)).toBeVisible();
    await expect(page.getByTestId('page-file-browser-list')).toBeVisible();
    await expect(crumbs(page).first()).toBeVisible();
  });

  test('回跳准星：tooltip 随会话 pwd 更新，已在目标目录时禁用，点击回到会话目录', async ({
    page,
  }) => {
    await gotoDetail(page, SANDBOX);
    await openFilePane(page);
    await expectPaneAt(page, ['workspace']);

    const jump = page.getByTestId('page-file-pane-jump-button');
    await expect(jump).toBeVisible();

    // ── ① pwd 通道的界面产物：tooltip 从「当前会话未上报工作目录」变成
    //    「跳转到终端当前目录：<路径>」（bash 画提示符时经 OSC 1337 上报）
    await expect(jump, '会话始终没有上报工作目录（OSC 1337 通道没通）').toHaveAttribute(
      'title',
      /^跳转到终端当前目录：\//,
      { timeout: 60_000 },
    );
    const title = (await jump.getAttribute('title')) ?? '';
    const pwd = title.replace('跳转到终端当前目录：', '');
    expect(pwd, `会话上报的目录不是沙箱工作目录：${pwd}`).toBe(WORKSPACE);

    // ── ② 窗格已在目标目录 ⇒ 按钮禁用
    await expect(jump, '窗格已在会话目录时回跳按钮没有禁用').toBeDisabled();

    // ── ③ 走到根目录（点面包屑的根 crumb）⇒ 按钮可用
    await crumbs(page).first().click();
    await expect(crumbs(page)).toHaveCount(1);
    await expect(jump, '离开目标目录后回跳按钮仍然禁用').toBeEnabled();

    // ── ④ 点回跳 ⇒ 回到会话目录（强制定位到 pwd）
    await jump.click();
    await expectPaneAt(page, ['workspace']);
    await expect(jump, '回到目标目录后回跳按钮没有禁用').toBeDisabled();
  });

  test('无自动跟随：终端里 cd 到别处，窗格目录一动不动', async ({ page }) => {
    await gotoDetail(page, SANDBOX);
    const sessionId = await openFilePane(page);
    await expectPaneAt(page, ['workspace']);

    // 窗格先导航到根目录（此时与 pwd 不同）
    await crumbs(page).first().click();
    await expect(crumbs(page)).toHaveCount(1);
    const jump = page.getByTestId('page-file-pane-jump-button');
    await expect(jump).toHaveAttribute('title', /^跳转到终端当前目录：\//, {
      timeout: 60_000,
    });

    // 在终端里 cd 到 /tmp（shell 会重新上报 pwd）
    const surface = page.locator(
      `[data-testid="page-sandbox-detail-terminal-surface"][data-session-id="${sessionId}"]`,
    );
    await surface.click();
    await surface.locator('textarea').first().focus();
    await page.keyboard.type('cd /tmp && echo ACC_CD_DONE');
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => (await surface.locator('.xterm-rows').textContent()) ?? '', {
        timeout: 30_000,
        message: '终端里 cd 没有执行完',
      })
      .toContain('ACC_CD_DONE');

    // 回跳按钮的 tooltip 跟着 pwd 更新成 /tmp（证明 pwd 真的变了）
    await expect(jump).toHaveAttribute('title', '跳转到终端当前目录：/tmp', {
      timeout: 30_000,
    });
    // 但窗格**一动不动**：仍在根目录（PRD FP-06 无自动跟随）
    await expect(crumbs(page)).toHaveCount(1);
    await expect(page.getByTestId('page-file-browser-crumb').first()).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('刷新按钮：同路径强制重读当前目录，不导航也能看到新文件', async ({ page }) => {
    await gotoDetail(page, SANDBOX);
    await openFilePane(page);
    await expectPaneAt(page, ['workspace']);

    const refresh = page.getByTestId('page-file-browser-refresh-button');
    await expect(refresh).toBeVisible();
    await expect(refresh).toHaveAttribute('aria-label', '刷新');

    // 直接从后端通道往当前目录放一个新文件（不经前端，模拟「目录被别人改了」）
    await uploadSandboxFile(SANDBOX, `${WORKSPACE}/acc-pane-refresh-probe.txt`,
      Buffer.from('ACC_REFRESH\n', 'utf-8'));

    // 不导航，只点刷新（同路径强制重读通道）：新文件行出现
    await refresh.click();
    await expect(
      page.locator('[data-testid="page-file-browser-row"][data-name="acc-pane-refresh-probe.txt"]'),
      '点刷新后新文件没有出现（同路径强制重读没生效）',
    ).toBeVisible({ timeout: 30_000 });
    // 列表头仍在窗格顶部（拍平后固定，不随条目滚动）：结构断言——
    // ① 「名称」表头不是 list 容器的后代（是容器外的同级固定头）；
    // ② 表头顶端不高于列表容器（位置在列表上方，不是被推到列表内部）。
    const listHeader = page.getByText('名称', { exact: true });
    await expect(listHeader).toBeVisible();
    const headerInsideList = await listHeader.evaluate(
      (el) => el.closest('[data-testid="page-file-browser-list"]') !== null,
    );
    expect(headerInsideList, '「名称」表头应固定在列表容器之外，而不是随条目滚动的后代').toBe(
      false,
    );
    const [headerBox, listBox] = await Promise.all([
      listHeader.boundingBox(),
      page.getByTestId('page-file-browser-list').boundingBox(),
    ]);
    expect(headerBox, '量不到「名称」表头').not.toBeNull();
    expect(listBox, '量不到列表容器').not.toBeNull();
    expect(headerBox!.y, '「名称」表头应位于列表容器上方').toBeLessThanOrEqual(listBox!.y);
  });

  test('会话切换：新的终端会话带自己的窗格，折叠态跨会话保持', async ({ page }) => {
    await gotoDetail(page, SANDBOX);
    const first = await openFilePane(page);
    await expectPaneAt(page, ['workspace']);
    // 折叠起来：换会话之后应当仍是折叠态（PRD FP-03「跨会话关闭 / 重开保持」）
    await page.getByTestId('page-file-pane-collapse-button').click();
    await expect(paneCollapsed(page)).toBeVisible();

    // 第二个会话（点 + 新建）：窗格按折叠态出现
    const second = await openTerminal(page);
    expect(second).not.toBe(first);
    await expect(paneCollapsed(page)).toBeVisible({ timeout: 60_000 });
    // 展开后是新会话的窗格（挂载按「沙箱:会话」重来，列表落到新会话的起点）
    await page.getByTestId('page-file-pane-expand-button').click();
    await expect(paneContent(page)).toBeVisible();
    await expectPaneAt(page, ['workspace']);
  });
});
