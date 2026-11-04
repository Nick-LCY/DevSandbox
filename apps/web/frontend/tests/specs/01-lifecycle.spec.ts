/**
 * 全流程验收：抽屉建沙箱（选镜像 + 填表）→ 侧栏选中 → 工作区头部启停
 * → 终端执行命令断言回显 → 删除（确认弹窗里点一次即删）→ 回空态。
 *
 * 全程只经网页操作，不碰命令行；每一步都有可判定的断言。
 *
 * 三期起后端对全部 `/api` 生效令牌认证：本文件里的接口直调走
 * `helpers/api.ts`（统一带认证头），页面侧的令牌由套件的 storageState 预置
 * （`helpers/connection.ts`）——用例本身不感知令牌，页面一打开就在工作台里。
 */

import { expect, test } from '@playwright/test';

import { createSandbox, deleteSandbox } from '../helpers/api';
import {
  confirmDelete,
  confirmStop,
  deleteRequestsSinceOpen,
  detailField,
  fillCreateForm,
  gotoDetail,
  gotoWorkbench,
  openCreateDialog,
  openDeleteDialog,
  openImagePicker,
  openSettingsDrawer,
  openStopDialog,
  searchImage,
  selectCreatedSandbox,
  selectSandbox,
  toastItem,
  waitDialogSettled,
  waitDrawerSettled,
} from '../helpers/console';
import { sandboxContainerState, userUid } from '../helpers/host';
import { readFixtures } from '../helpers/sandbox';
import { expectTerminalConnected, expectTerminalText, openTerminal, typeInTerminal } from '../helpers/terminal';
import { createWorkspace, fingerprintDir, removeWorkspace } from '../helpers/workspace';

const SANDBOX_NAME = 'acc-lifecycle';
/** 平台基础镜像：宿主已构建，属平台自建镜像，宿主导出注入即可。 */
const IMAGE = 'sandbox-platform/base:0.2.0';

test.describe('网页控制台全流程', () => {
  test('下拉选镜像 → 创建（带挂载）→ 终端执行命令 → 停止 → 再启动 → 删除', async ({ page }) => {
    readFixtures();
    const workspace = createWorkspace('/workspace');
    const fingerprintBefore = fingerprintDir(workspace.path);

    try {
      // ── ① 新建抽屉：镜像选择器里搜到宿主本地镜像
      await openCreateDialog(page);
      const imageInput = page.getByTestId('page-sandbox-create-image-select');
      await expect(imageInput).toBeVisible();
      await openImagePicker(page);
      await searchImage(page, IMAGE);
      // 搜索是前端本地筛选：只剩命中的这一条。
      const imageOptions = page.getByTestId('page-sandbox-create-image-option');
      await expect(imageOptions).toHaveCount(1);
      await expect(page.locator(`[data-image-reference="${IMAGE}"]`)).toHaveCount(1);
      await page.locator(`[data-image-reference="${IMAGE}"]`).click();
      await expect(imageInput).toHaveValue(IMAGE);

      // ── ② 填表并提交（含一条用户声明挂载）
      const elapsed = await fillCreateForm(page, {
        name: SANDBOX_NAME,
        image: IMAGE,
        mountHost: workspace.path,
        mountContainer: workspace.containerPath,
        command: 'sleep infinity',
      });
      test.info().annotations.push({ type: '创建耗时', description: `${elapsed} 毫秒` });

      // ── ③ 创建成功不再自动选中：从左侧边栏选中新沙箱
      await selectCreatedSandbox(page, SANDBOX_NAME);
      await expect(page.getByTestId('page-sandbox-detail-title')).toContainText(SANDBOX_NAME);
      await expect(page.getByTestId('page-sandbox-detail-state')).toHaveText('运行中');
      // 工作区头部摘要：镜像
      await expect(page.getByTestId('page-sandbox-detail-image')).toHaveText(IMAGE);
      // 完整字段在详情弹窗里读
      expect(await detailField(page, 'image')).toBe(IMAGE);
      expect(await detailField(page, 'image-source')).toBe('host');
      const mountText = await detailField(page, 'mounts');
      expect(mountText).toContain(workspace.path);
      expect(mountText).toContain(workspace.containerPath);

      const systemUser = await detailField(page, 'system-user');
      const containerName = await detailField(page, 'container-name');
      const uid = userUid(systemUser);
      expect(uid).toBeGreaterThan(0);

      // ── ④ 网页终端执行命令并断言回显
      const sessionId = await openTerminal(page);
      await expectTerminalConnected(page);
      await typeInTerminal(page, sessionId, 'echo ACC_LIFECYCLE_MARKER_42');
      await expectTerminalText(page, sessionId, 'ACC_LIFECYCLE_MARKER_42');

      // ── ⑤ 停止：先弹确认框，确认后容器真的停了，用户与家目录保留
      await openStopDialog(page);
      await confirmStop(page, SANDBOX_NAME);
      await expect(toastItem(page, 'success')).toContainText('已停止');
      await expect(page.getByTestId('page-sandbox-detail-state')).toHaveText('已停止');
      expect(sandboxContainerState(systemUser, uid, containerName)).toBe('exited');

      // ── ⑥ 再启动：同一个用户、同一个子 ID 段、同一个守护进程
      const subidBefore = await detailField(page, 'subid');
      await page.getByTestId('page-sandbox-detail-start-button').click();
      await expect(toastItem(page, 'success')).toContainText('已启动');
      await expect(page.getByTestId('page-sandbox-detail-state')).toHaveText('运行中');
      expect(sandboxContainerState(systemUser, uid, containerName)).toBe('running');
      expect(await detailField(page, 'subid')).toBe(subidBefore);

      // ── ⑦ 删除：确认弹窗里点一次就真删
      const dialog = await openDeleteDialog(page);
      await expect(page.getByTestId('page-sandbox-detail-delete-untouched-note')).toHaveText(
        '用户挂载的宿主机目录不受影响',
      );
      // 后果说明：删了会怎样。
      await expect(dialog).toContainText('此操作不可撤销');

      // 弹窗宽度口径：1920 视口下删除确认弹窗宽 400px（曾经一路撑到视口宽度）。
      const originViewport = page.viewportSize();
      await page.setViewportSize({ width: 1920, height: 1080 });
      await waitDialogSettled(page, 'page-sandbox-detail-delete-dialog');
      const wideBox = (await dialog.boundingBox())!;
      expect(
        Math.abs(wideBox.width - 400),
        `删除确认弹窗宽度应为 400px，实测 ${wideBox.width}px`,
      ).toBeLessThanOrEqual(2);
      // 窄屏（< 640px）不套断点变体：按视口留边（calc(100% - 3rem)）。
      await page.setViewportSize({ width: 600, height: 900 });
      await waitDialogSettled(page, 'page-sandbox-detail-delete-dialog');
      const narrowBox = (await dialog.boundingBox())!;
      expect(
        Math.abs(narrowBox.width - (600 - 48)),
        `窄屏下删除确认弹窗应为视口留边 552px，实测 ${narrowBox.width}px`,
      ).toBeLessThanOrEqual(2);
      if (originViewport) {
        await page.setViewportSize(originViewport);
      }

      // 取消一次：一个删除请求都不该发出去
      await page.getByTestId('page-sandbox-detail-delete-cancel-button').click();
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId('page-sandbox-detail-title')).toBeVisible();
      // 请求事件比点击晚几十毫秒落地：留一拍再判零。
      await page.waitForTimeout(300);
      expect(
        deleteRequestsSinceOpen(page),
        '取消删除后不应发出任何删除请求',
      ).toBe(0);

      // 再打开并确认删除（一次点即执行）
      await openDeleteDialog(page);
      await confirmDelete(page);
      await expect(page.getByTestId('page-sandbox-detail-empty')).toBeVisible({
        timeout: 120_000,
      });
      await expect(
        page.getByTestId('page-sandbox-list-item').filter({ hasText: SANDBOX_NAME }),
      ).toHaveCount(0);

      // ── ⑧ 用户声明挂载的外部目录原样存在、内容未变
      expect(fingerprintDir(workspace.path)).toBe(fingerprintBefore);
    } finally {
      removeWorkspace(workspace);
    }
  });

  test('新建弹窗能刷新宿主本地镜像列表', async ({ page }) => {
    await openCreateDialog(page);

    // 打开选择器并搜一个公共前缀：命中的条数就是候选条数。
    await openImagePicker(page);
    await searchImage(page, 'sandbox-platform/');
    const options = page.getByTestId('page-sandbox-create-image-option');
    await expect.poll(async () => options.count(), { timeout: 30_000 }).toBeGreaterThan(1);
    const before = await options.count();

    // 刷新镜像：等接口真的回来，再等按钮从「正在刷新」回到「刷新镜像」。
    const refreshed = page.waitForResponse(
      (response) =>
        response.url().includes('/api/images') && response.request().method() === 'GET',
      { timeout: 30_000 },
    );
    await page.getByTestId('page-sandbox-create-image-refresh-button').click();
    await refreshed;
    await expect(page.getByTestId('page-sandbox-create-image-refresh-button')).toHaveText('刷新镜像');

    // 刷新后重新展开选择器再搜一次：候选条数不变。
    await openImagePicker(page);
    await searchImage(page, 'sandbox-platform/');
    await expect.poll(async () => options.count(), { timeout: 30_000 }).toBe(before);
  });

  test('沙箱详情刷新后字段保持一致', async ({ page }) => {
    // 用一个独立的短命沙箱验证「详情 → 刷新 → 字段不变」
    await openCreateDialog(page);
    await fillCreateForm(page, {
      name: 'acc-refresh',
      image: IMAGE,
      command: 'sleep infinity',
    });
    await selectCreatedSandbox(page, 'acc-refresh');
    await expect(page.getByTestId('page-sandbox-detail-title')).toBeVisible();
    const image = await detailField(page, 'image');

    // 刷新必须真的打到后端：先挂上详情接口的响应监听，拿到响应再读字段。
    // （前后读的是同一份前端状态，刷新按钮彻底坏了也照样绿。）
    const detailResponse = page.waitForResponse(
      (response) =>
        response.url().includes('/api/sandboxes/acc-refresh') &&
        response.request().method() === 'GET',
      { timeout: 30_000 },
    );
    await page.getByTestId('page-sandbox-detail-refresh-button').click();
    try {
      await detailResponse;
    } catch (error) {
      throw new Error(
        `点击刷新后没有拿到详情接口（GET /api/sandboxes/acc-refresh）的响应：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await expect(page.getByTestId('page-sandbox-detail-state')).toHaveText('运行中');
    expect(await detailField(page, 'image')).toBe(image);
    await gotoDetail(page, 'acc-refresh');
    await expect(page.getByTestId('page-sandbox-detail-state')).toHaveText('运行中');
  });

  test('工作台首页：侧栏列表与右侧空态', async ({ page }) => {
    await gotoWorkbench(page);
    // 侧栏列表在，右侧是空态引导块
    await expect(page.getByTestId('page-sandbox-list-title')).toBeVisible();
    await expect(page.getByTestId('page-sandbox-detail-empty')).toBeVisible();
    // 空态里的「新建沙箱」按钮与侧栏的是两个挂载点，取第一个即可
    await expect(page.getByTestId('page-sandbox-list-create-button')).toHaveCount(2);
  });

  test('折叠侧栏：底部工具贴底、新建按钮仍在，展开恢复原状', async ({ page }) => {
    await gotoWorkbench(page);

    const sidebar = page.getByTestId('page-layout-sidebar');
    const collapseButton = page.getByTestId('page-layout-sidebar-collapse-button');
    const createButtons = page.getByTestId('page-sandbox-list-create-button');

    // 展开态：侧栏 + 空态引导块各一个「新建沙箱」按钮
    await expect(sidebar).toHaveAttribute('data-collapsed', 'false');
    await expect(createButtons).toHaveCount(2);

    // 折叠：只切样式，不卸 DOM
    await collapseButton.click();
    await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    // 页面恒有两个「新建沙箱」标识（折叠不卸 DOM）
    await expect(createButtons).toHaveCount(2);
    const sidebarCreate = createButtons.first();
    await expect(sidebarCreate).toBeVisible();
    await expect(sidebarCreate).toBeEnabled();

    // 折叠态的底部工具贴底：折叠按钮的 y 坐标明显在新建按钮之下，
    // 且落在视口的下半部分（不是浮到顶部去了）。
    const viewport = page.viewportSize()!;
    await expect
      .poll(
        async () => (await collapseButton.boundingBox())!.y,
        { timeout: 10_000, message: '折叠后底部工具没有落到侧栏底部' },
      )
      .toBeGreaterThan(viewport.height * 0.6);
    const collapseBox = (await collapseButton.boundingBox())!;
    const createBox = (await sidebarCreate.boundingBox())!;
    expect(
      collapseBox.y,
      `折叠按钮（y=${Math.round(collapseBox.y)}）没有在新建按钮（y=${Math.round(createBox.y)}）之下`,
    ).toBeGreaterThan(createBox.y);

    // 展开恢复原状：宽度回到 264px，底部工具仍在底部
    await collapseButton.click();
    await expect(sidebar).toHaveAttribute('data-collapsed', 'false');
    await expect(createButtons).toHaveCount(2);
    const expandedBox = (await collapseButton.boundingBox())!;
    expect(
      expandedBox.y,
      '展开后折叠按钮没有回到侧栏底部',
    ).toBeGreaterThan((await sidebarCreate.boundingBox())!.y);
  });

  test('抽屉宽度可拖拽，刷新后保持，三个抽屉共用一份宽度', async ({ page }) => {
    await openCreateDialog(page);
    const drawer = page.getByTestId('page-sandbox-create-dialog');
    const handle = page.getByTestId('page-drawer-resize-handle');
    await expect(handle).toBeVisible();
    // 等滑入动画结束再量位置：动画中间帧的坐标是错的。
    await waitDrawerSettled(page, 'page-sandbox-create-dialog');

    const before = (await drawer.boundingBox())!;
    expect(before.width).toBeGreaterThan(0);

    // 默认宽度是 40 视口百分比：1920 视口下应是 768px。
    const originViewport = page.viewportSize();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitDrawerSettled(page, 'page-sandbox-create-dialog');
    const defaultBox = (await drawer.boundingBox())!;
    expect(
      Math.abs(defaultBox.width - 1920 * 0.4),
      `抽屉默认宽度应为 40 视口百分比（768px），实测 ${defaultBox.width}px`,
    ).toBeLessThanOrEqual(2);
    if (originViewport) {
      await page.setViewportSize(originViewport);
      await waitDrawerSettled(page, 'page-sandbox-create-dialog');
    }
    const before2 = (await drawer.boundingBox())!;
    expect(before2.width).toBeGreaterThan(0);

    // 向左拖把手：面板变宽。
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();

    // 宽度是 React 状态：等它落到 DOM 上再量。
    await expect
      .poll(async () => (await drawer.boundingBox())!.width, {
        timeout: 10_000,
        message: '向左拖把手后面板没有变宽',
      })
      .toBeGreaterThan(before2.width + 50);
    const after = (await drawer.boundingBox())!;

    // 宽度写进共用存储键（三个抽屉共用一个）。
    const stored = await page.evaluate(() =>
      window.localStorage.getItem('sandbox-console-drawer-width'),
    );
    expect(stored, '拖拽后的宽度没有写进存储').not.toBeNull();
    expect(Number(stored)).toBeGreaterThan(40);

    // 刷新后重新打开抽屉：宽度保持。
    await page.reload();
    await openCreateDialog(page);
    await waitDrawerSettled(page, 'page-sandbox-create-dialog');
    const reopened = (await page.getByTestId('page-sandbox-create-dialog').boundingBox())!;
    expect(Math.abs(reopened.width - after.width)).toBeLessThan(2);

    // 另一个抽屉（代理设置）也是同一个宽度：共用一个存储键。
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('page-sandbox-create-dialog')).toBeHidden();
    await page.getByTestId('page-layout-settings-button').click();
    await expect(page.getByTestId('page-settings-dialog')).toBeVisible();
    await waitDrawerSettled(page, 'page-settings-dialog');
    const proxyWidth = (await page.getByTestId('page-settings-dialog').boundingBox())!.width;
    expect(Math.abs(proxyWidth - after.width)).toBeLessThan(2);
  });

  test('设置抽屉：刷新状态与重启代理两个按钮在代理设置区里', async ({ page }) => {
    await openSettingsDrawer(page);

    // 两个按钮从抽屉页脚搬进了第一区：就在代理设置区里，不再是全局页脚。
    const section = page.locator(
      '[data-testid="page-settings-dialog"] section[aria-label="代理设置"]',
    );
    const refresh = section.getByTestId('page-settings-refresh-button');
    const restart = section.getByTestId('page-settings-restart-button');
    await expect(refresh).toBeVisible();
    await expect(restart).toBeVisible();

    // 刷新状态：真打一次状态接口，字段照旧显示。
    const statusResponse = page.waitForResponse(
      (response) =>
        response.url().includes('/api/proxy/status') && response.request().method() === 'GET',
      { timeout: 30_000 },
    );
    await refresh.click();
    await statusResponse;
    await expect(page.getByTestId('page-settings-proxy-url')).toContainText('http://');

    // 重启代理：真重启一次（要十几秒），结果面板出来、结论如实展示。
    const restartResponse = page.waitForResponse(
      (response) =>
        response.url().includes('/api/proxy/restart') && response.request().method() === 'POST',
      { timeout: 120_000 },
    );
    await restart.click();
    expect((await restartResponse).ok(), '重启代理接口没有返回成功').toBe(true);
    await expect(page.getByTestId('page-settings-restart-result')).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId('page-settings-restarted')).toHaveText('已重启并恢复健康');
  });

  test('停止确认框取消时，后端没收到停止请求', async ({ page }) => {
    const name = 'acc-stopcancel';
    await createSandbox({ name, image: IMAGE, command: 'sleep infinity' });
    try {
      await gotoWorkbench(page);
      await selectSandbox(page, name);

      let stopRequests = 0;
      const countStop = (request: { method(): string; url(): string }): void => {
        if (request.method() === 'POST' && request.url().includes(`/api/sandboxes/${name}/stop`)) {
          stopRequests += 1;
        }
      };
      page.on('request', countStop);
      try {
        const dialog = await openStopDialog(page);
        await expect(dialog).toContainText(`停止沙箱 ${name}`);
        // 停止确认弹窗宽度口径：1280 视口下宽 400px。
        await waitDialogSettled(page, 'page-sandbox-detail-stop-dialog');
        const stopBox = (await dialog.boundingBox())!;
        expect(
          Math.abs(stopBox.width - 400),
          `停止确认弹窗宽度应为 400px，实测 ${stopBox.width}px`,
        ).toBeLessThanOrEqual(2);
        await page.getByTestId('page-sandbox-detail-stop-cancel-button').click();
        await expect(dialog).toBeHidden();
        // 等一拍再判零：请求事件比点击晚几十毫秒落地，不留窗口就等于没数。
        await page.waitForTimeout(1000);
        expect(stopRequests, '取消后不应发出任何停止请求').toBe(0);
      } finally {
        page.off('request', countStop);
      }

      // 沙箱还在运行：取消没有真的停。
      await expect(page.getByTestId('page-sandbox-detail-state')).toHaveText('运行中');
    } finally {
      await deleteSandbox(name);
    }
  });
});
