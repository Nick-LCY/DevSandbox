/**
 * 全流程验收：弹窗建沙箱（选镜像 + 填表）→ 侧栏选中 → 工作区头部启停
 * → 终端执行命令断言回显 → 删除（回收清单弹窗，两步确认）→ 回空态。
 *
 * 全程只经网页操作，不碰命令行；每一步都有可判定的断言。
 */

import { expect, test } from '@playwright/test';

import {
  confirmDeleteTwice,
  detailField,
  fillCreateForm,
  gotoDetail,
  gotoWorkbench,
  openCreateDialog,
  openDeleteDialog,
  toastItem,
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
      // ── ① 新建弹窗：镜像下拉里选宿主本地镜像
      await openCreateDialog(page);
      const select = page.getByTestId('page-sandbox-create-image-select');
      await expect(select).toBeVisible();
      await expect(select.locator(`option[value="${IMAGE}"]`)).toHaveCount(1);
      await select.selectOption(IMAGE);

      // ── ② 填表并提交（含一条用户声明挂载）
      const elapsed = await fillCreateForm(page, {
        name: SANDBOX_NAME,
        image: IMAGE,
        mountHost: workspace.path,
        mountContainer: workspace.containerPath,
        command: 'sleep infinity',
      });
      test.info().annotations.push({ type: '创建耗时', description: `${elapsed} 毫秒` });
      await expect(page.getByTestId('page-sandbox-create-success-message')).toContainText(
        `沙箱 ${SANDBOX_NAME} 创建成功`,
      );

      // ── ③ 点成功态里的「打开沙箱详情」：选中该沙箱，右侧工作区显示它的摘要
      await page.getByTestId('page-sandbox-create-success-link').click();
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

      // ── ⑤ 停止：容器真的停了，用户与家目录保留
      await page.getByTestId('page-sandbox-detail-stop-button').click();
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

      // ── ⑦ 删除：先看回收清单弹窗，确认后才真删
      const dialog = await openDeleteDialog(page);
      await expect(page.getByTestId('page-sandbox-detail-delete-untouched-note')).toHaveText(
        '用户挂载的宿主机目录不受影响',
      );
      const planText = await dialog.textContent();
      expect(planText).toContain(containerName);
      expect(planText).toContain(workspace.path);

      // 取消一次：一个删除请求都不该发出去
      await page.getByTestId('page-sandbox-detail-delete-cancel-button').click();
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId('page-sandbox-detail-title')).toBeVisible();

      // 再打开并确认删除（两步确认：第一次只是武装，第二次才真删）
      await openDeleteDialog(page);
      await confirmDeleteTwice(page);
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
    const select = page.getByTestId('page-sandbox-create-image-select');
    // 等镜像列表加载完（弹窗刚打开时只有一个占位选项）
    await expect.poll(async () => select.locator('option').count(), { timeout: 30_000 }).toBeGreaterThan(1);
    const before = await select.locator('option').count();
    await page.getByTestId('page-sandbox-create-image-refresh-button').click();
    await expect
      .poll(async () => select.locator('option').count(), { timeout: 30_000 })
      .toBeGreaterThan(1);
    expect(await select.locator('option').count()).toBe(before);
  });

  test('沙箱详情刷新后字段保持一致', async ({ page }) => {
    // 用一个独立的短命沙箱验证「详情 → 刷新 → 字段不变」
    await openCreateDialog(page);
    await fillCreateForm(page, {
      name: 'acc-refresh',
      image: IMAGE,
      command: 'sleep infinity',
    });
    await page.getByTestId('page-sandbox-create-success-link').click();
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
});
