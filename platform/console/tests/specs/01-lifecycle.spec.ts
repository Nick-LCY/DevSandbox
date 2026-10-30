/**
 * 全流程验收：镜像下拉选择 → 创建沙箱（含挂载声明）→ 终端执行命令断言回显
 * → 停止 → 再启动 → 删除（走回收清单确认弹窗）。
 *
 * 全程只经网页操作，不碰命令行；每一步都有可判定的断言。
 */

import { expect, test } from '@playwright/test';

import { detailField, fillCreateForm, gotoCreate, gotoDetail } from '../helpers/console';
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
      // ── ① 新建页：镜像下拉里选宿主本地镜像
      await gotoCreate(page);
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

      // ── ③ 进详情页核对创建结果
      await page.getByTestId('page-sandbox-create-success-link').click();
      await expect(page.getByTestId('page-sandbox-detail-title')).toContainText(SANDBOX_NAME);
      await expect(page.getByTestId('page-sandbox-detail-state')).toHaveText('运行中');
      expect(await detailField(page, 'page-sandbox-detail-image')).toBe(IMAGE);
      expect(await detailField(page, 'page-sandbox-detail-image-source')).toBe('host');
      const mountText = await detailField(page, 'page-sandbox-detail-mounts');
      expect(mountText).toContain(workspace.path);
      expect(mountText).toContain(workspace.containerPath);

      const systemUser = await detailField(page, 'page-sandbox-detail-system-user');
      const containerName = await detailField(page, 'page-sandbox-detail-container-name');
      const uid = userUid(systemUser);
      expect(uid).toBeGreaterThan(0);

      // ── ④ 网页终端执行命令并断言回显
      const sessionId = await openTerminal(page);
      await expectTerminalConnected(page);
      await typeInTerminal(page, sessionId, 'echo ACC_LIFECYCLE_MARKER_42');
      await expectTerminalText(page, sessionId, 'ACC_LIFECYCLE_MARKER_42');

      // ── ⑤ 停止：容器真的停了，用户与家目录保留
      await page.getByTestId('page-sandbox-detail-stop-button').click();
      await expect(page.getByTestId('page-sandbox-list-action-message')).toContainText('已停止');
      await expect(page.getByTestId('page-sandbox-detail-state')).toHaveText('已停止');
      expect(sandboxContainerState(systemUser, uid, containerName)).toBe('exited');

      // ── ⑥ 再启动：同一个用户、同一个子 ID 段、同一个守护进程
      const subidBefore = await detailField(page, 'page-sandbox-detail-subid');
      await page.getByTestId('page-sandbox-detail-start-button').click();
      await expect(page.getByTestId('page-sandbox-list-action-message')).toContainText('已启动');
      await expect(page.getByTestId('page-sandbox-detail-state')).toHaveText('运行中');
      expect(sandboxContainerState(systemUser, uid, containerName)).toBe('running');
      expect(await detailField(page, 'page-sandbox-detail-subid')).toBe(subidBefore);

      // ── ⑦ 删除：先看回收清单弹窗，确认后才真删
      await page.getByTestId('page-sandbox-detail-delete-button').click();
      const dialog = page.getByTestId('page-sandbox-detail-delete-dialog');
      await expect(dialog).toBeVisible();
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
      await page.getByTestId('page-sandbox-detail-delete-button').click();
      await expect(dialog).toBeVisible();
      await page.getByTestId('page-sandbox-detail-delete-confirm-button').click();
      await expect(page.getByTestId('page-sandbox-detail-delete-armed-hint')).toBeVisible();
      await page.getByTestId('page-sandbox-detail-delete-confirm-button').click();
      await expect(page.getByTestId('page-sandbox-list-title')).toBeVisible({ timeout: 120_000 });
      await expect(
        page.getByTestId('page-sandbox-list-item').filter({ hasText: SANDBOX_NAME }),
      ).toHaveCount(0);

      // ── ⑧ 用户声明挂载的外部目录原样存在、内容未变
      expect(fingerprintDir(workspace.path)).toBe(fingerprintBefore);
    } finally {
      removeWorkspace(workspace);
    }
  });

  test('新建页能刷新宿主本地镜像列表', async ({ page }) => {
    await gotoCreate(page);
    const select = page.getByTestId('page-sandbox-create-image-select');
    // 等镜像列表加载完（页面刚打开时只有一个占位选项）
    await expect.poll(async () => select.locator('option').count(), { timeout: 30_000 }).toBeGreaterThan(1);
    const before = await select.locator('option').count();
    await page.getByTestId('page-sandbox-create-image-refresh-button').click();
    await expect
      .poll(async () => select.locator('option').count(), { timeout: 30_000 })
      .toBeGreaterThan(1);
    expect(await select.locator('option').count()).toBe(before);
  });

  test('沙箱详情页刷新后字段保持一致', async ({ page }) => {
    // 用一个独立的短命沙箱验证「详情 → 刷新 → 字段不变」
    await gotoCreate(page);
    await fillCreateForm(page, {
      name: 'acc-refresh',
      image: IMAGE,
      command: 'sleep infinity',
    });
    await page.getByTestId('page-sandbox-create-success-link').click();
    await expect(page.getByTestId('page-sandbox-detail-title')).toBeVisible();
    const image = await detailField(page, 'page-sandbox-detail-image');
    await page.getByTestId('page-sandbox-detail-refresh-button').click();
    await expect(page.getByTestId('page-sandbox-detail-state')).toHaveText('运行中');
    expect(await detailField(page, 'page-sandbox-detail-image')).toBe(image);
    await gotoDetail(page, 'acc-refresh');
    await expect(page.getByTestId('page-sandbox-detail-state')).toHaveText('运行中');
  });
});
