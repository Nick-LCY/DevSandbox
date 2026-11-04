/**
 * 启动模板验收：保存模板 → 新建抽屉加载回填（镜像与挂载）→ 设置抽屉
 * 重命名 → 删除 → 刷新不复活。
 *
 * 全程只经网页操作；接口直取只用来核对落盘结果（模板标识、配置原文）
 * 与收尾清理。
 *
 * 口径：模板声明**原样透传**——不做任何占位符替换，回填与提交都是模板里
 * 写的内容（平台只做既有校验）。
 *
 * 三期起后端对全部 `/api` 生效令牌认证：接口直取走 `helpers/api.ts`
 * （统一带认证头），页面侧的令牌由套件的 storageState 预置
 * （`helpers/connection.ts`）。
 */

import { expect, type Locator, type Page, test } from '@playwright/test';

import { deleteTemplate, listTemplates } from '../helpers/api';
import {
  applyTemplate,
  deleteTemplate as deleteTemplateFromDrawer,
  openCreateDialog,
  openSettingsDrawer,
  renameTemplate,
  saveTemplateFromCreateDialog,
  selectImage,
} from '../helpers/console';
import { readFixtures } from '../helpers/sandbox';

/** 模板名：验收用例统一用这个前缀（收尾清理只碰它）。 */
const TEMPLATE_PREFIX = 'acc-模板';
const TEMPLATE_NAME = `${TEMPLATE_PREFIX}-开发环境`;
const RENAMED_TEMPLATE_NAME = `${TEMPLATE_PREFIX}-开发环境-改名`;
/** 回填时用的沙箱名（模板声明不受它影响：原样透传）。 */
const SANDBOX_NAME = 'acc-tpl-demo';
/** 模板里的挂载宿主路径（模板内容原样存取，不做任何替换）。 */
const TEMPLATE_MOUNT_HOST = '/data/acc-tpl-demo';

/** 删掉本轮可能留下的验收模板（只碰验收前缀的）。 */
async function cleanupTemplates(): Promise<void> {
  const templates = await listTemplates();
  for (const template of templates) {
    if (template.name.startsWith(TEMPLATE_PREFIX)) {
      await deleteTemplate(template.id);
    }
  }
}

/**
 * 设置抽屉里按模板名定位的那一行。
 *
 * 走 `data-template-name` 属性（行内重命名时行内文字会被输入框替掉）。
 * **不断言整张列表的条数**：宿主数据根里可能有用户自己建的模板，
 * 用例只关心「自己那一行」在不在。
 */
function templateRow(page: Page, name: string): Locator {
  const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return page.locator(`[data-testid="page-settings-template-item"][data-template-name="${escaped}"]`);
}

test.describe('启动模板', () => {
  test('保存模板 → 新建抽屉加载回填（镜像与挂载）→ 重命名 → 删除 → 刷新不复活', async ({
    page,
  }) => {
    readFixtures();
    await cleanupTemplates();

    try {
      // ── ① 新建抽屉：填一份表单，存成模板
      await openCreateDialog(page);
      await page.getByTestId('page-sandbox-create-name-input').fill(SANDBOX_NAME);
      await selectImage(page, readFixtures().localImage.reference);
      await page.getByTestId('page-sandbox-create-mount-add-button').click();
      const mountRow = page.getByTestId('page-sandbox-create-mount-item').last();
      await mountRow.getByTestId('page-sandbox-create-mount-host-input').fill(TEMPLATE_MOUNT_HOST);
      await mountRow.getByTestId('page-sandbox-create-mount-container-input').fill('/workspace');
      await page.getByTestId('page-sandbox-create-command-input').fill('sleep infinity');
      await page.getByTestId('page-sandbox-create-env-input').fill('APP=demo');
      await saveTemplateFromCreateDialog(page, TEMPLATE_NAME);

      // 落盘核对：模板里存的就是表单里的**原文**（服务端不替换、不改写）。
      const saved = (await listTemplates()).find((item) => item.name === TEMPLATE_NAME);
      expect(saved, '模板没有落盘').toBeTruthy();
      expect(saved!.config.mounts).toEqual([`${TEMPLATE_MOUNT_HOST}:/workspace`]);
      expect(saved!.config.env).toEqual({ APP: 'demo' });
      expect(saved!.config.command).toBe('sleep infinity');

      // ── ② 重新打开新建抽屉：选中模板即回填（声明原样回填）
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('page-sandbox-create-dialog')).toBeHidden();
      await openCreateDialog(page);
      await page.getByTestId('page-sandbox-create-name-input').fill(SANDBOX_NAME);
      await applyTemplate(page, TEMPLATE_NAME);

      // 回填口径：出现的字段整体替换，模板声明原样回填。
      await expect(page.getByTestId('page-sandbox-create-mount-host-input')).toHaveValue(
        TEMPLATE_MOUNT_HOST,
      );
      await expect(page.getByTestId('page-sandbox-create-mount-container-input')).toHaveValue(
        '/workspace',
      );
      await expect(page.getByTestId('page-sandbox-create-command-input')).toHaveValue('sleep infinity');
      await expect(page.getByTestId('page-sandbox-create-env-input')).toHaveValue('APP=demo');
      // 镜像也在宿主本地镜像列表里：一并回填。
      await expect(page.getByTestId('page-sandbox-create-image-select')).toHaveValue(
        readFixtures().localImage.reference,
      );

      // ── ③ 设置抽屉：行内重命名（标识不变，名字变）
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('page-sandbox-create-dialog')).toBeHidden();
      await openSettingsDrawer(page);
      await renameTemplate(page, TEMPLATE_NAME, RENAMED_TEMPLATE_NAME);

      const renamed = (await listTemplates()).find((item) => item.name === RENAMED_TEMPLATE_NAME);
      expect(renamed, '重命名没有生效').toBeTruthy();
      // 标识与名称解耦：重命名不改标识。
      expect(renamed!.id).toBe(saved!.id);
      expect(renamed!.config.mounts).toEqual([`${TEMPLATE_MOUNT_HOST}:/workspace`]);

      // ── ④ 删除：走确认弹窗，文案写明不影响已建沙箱
      await deleteTemplateFromDrawer(page, RENAMED_TEMPLATE_NAME);
      expect(
        (await listTemplates()).some((item) => item.name === RENAMED_TEMPLATE_NAME),
        '模板没有删掉',
      ).toBe(false);

      // ── ⑤ 刷新不复活：重新加载页面，删掉的模板不再出现
      await page.reload();
      await openSettingsDrawer(page);
      await expect(templateRow(page, RENAMED_TEMPLATE_NAME)).toHaveCount(0);
      expect(
        (await listTemplates()).some((item) => item.name === RENAMED_TEMPLATE_NAME),
        '删掉的模板刷新后又回来了',
      ).toBe(false);
    } finally {
      await cleanupTemplates();
    }
  });

  test('模板合并语义：出现的字段整体替换，没出现的保持现状', async ({ page }) => {
    readFixtures();
    await cleanupTemplates();

    try {
      // ── ① 存一个「只有命令」的模板：镜像、挂载、工作目录、环境变量都没填，
      //    它们不进配置（加载时保持表单现状）。
      await openCreateDialog(page);
      await page.getByTestId('page-sandbox-create-name-input').fill(SANDBOX_NAME);
      await page.getByTestId('page-sandbox-create-command-input').fill('sleep infinity');
      await saveTemplateFromCreateDialog(page, `${TEMPLATE_PREFIX}-仅命令`);

      const saved = (await listTemplates()).find((item) => item.name === `${TEMPLATE_PREFIX}-仅命令`);
      expect(saved, '模板没有落盘').toBeTruthy();
      expect(saved!.config.command).toBe('sleep infinity');
      expect(saved!.config.image).toBeUndefined();
      expect(saved!.config.mounts).toBeUndefined();

      // ── ② 换一份表单：先手填一条挂载，再加载「仅命令」模板
      await page.keyboard.press('Escape');
      await openCreateDialog(page);
      await page.getByTestId('page-sandbox-create-name-input').fill(SANDBOX_NAME);
      await page.getByTestId('page-sandbox-create-mount-add-button').click();
      const manualRow = page.getByTestId('page-sandbox-create-mount-item').last();
      await manualRow.getByTestId('page-sandbox-create-mount-host-input').fill('/data/手填的');
      await manualRow.getByTestId('page-sandbox-create-mount-container-input').fill('/manual');
      await applyTemplate(page, `${TEMPLATE_PREFIX}-仅命令`);

      // 命令被替换（模板里出现了它）；挂载保持现状（模板里没有它）。
      await expect(page.getByTestId('page-sandbox-create-command-input')).toHaveValue('sleep infinity');
      await expect(page.getByTestId('page-sandbox-create-mount-host-input')).toHaveValue('/data/手填的');
    } finally {
      await cleanupTemplates();
    }
  });

  test('模板下拉：箭头在输入框内、候选项是指针、空列表不留空白带', async ({ page }) => {
    readFixtures();
    await cleanupTemplates();

    try {
      // 先存一个模板：下拉里得有候选，才能验指针光标。
      await openCreateDialog(page);
      await page.getByTestId('page-sandbox-create-name-input').fill(SANDBOX_NAME);
      await saveTemplateFromCreateDialog(page, TEMPLATE_NAME);

      const input = page.getByTestId('page-sandbox-create-template-select');
      const arrow = page.getByTestId('page-sandbox-create-template-trigger');

      // 箭头贴在输入框**内部**右侧、垂直居中：不可点、对外隐藏。
      await expect(arrow).toBeVisible();
      await expect(arrow).toHaveAttribute('aria-hidden', 'true');
      await expect(arrow).toHaveCSS('pointer-events', 'none');
      const inputBox = (await input.boundingBox())!;
      const arrowBox = (await arrow.boundingBox())!;
      expect(arrowBox.x, '箭头不在输入框左侧').toBeGreaterThanOrEqual(inputBox.x);
      expect(
        arrowBox.x + arrowBox.width,
        '箭头不在输入框右侧之内',
      ).toBeLessThanOrEqual(inputBox.x + inputBox.width + 1);
      expect(
        Math.abs(
          arrowBox.y + arrowBox.height / 2 - (inputBox.y + inputBox.height / 2),
        ),
        '箭头没有垂直居中',
      ).toBeLessThanOrEqual(2);

      // 收起时朝下；展开后转 180°。
      await expect(arrow).toHaveCSS('rotate', 'none');
      await input.click();
      await expect(page.getByTestId('page-sandbox-create-template-popup')).toBeVisible();
      await expect(arrow).toHaveCSS('rotate', '180deg');

      // 候选项逐项给指针光标。
      const option = page.locator(`[data-template-name="${TEMPLATE_NAME}"]`);
      await expect(option).toHaveCount(1);
      await expect(option).toHaveCSS('cursor', 'pointer');

      // 搜不到时：弹层高度贴合空态提示，底部不多出空白带。
      await input.fill('');
      await input.fill('zzz-没有这个模板');
      await expect(page.getByTestId('page-sandbox-create-template-no-match')).toBeVisible();
      const popupBox = (await page
        .getByTestId('page-sandbox-create-template-popup')
        .boundingBox())!;
      const emptyBox = (await page
        .getByTestId('page-sandbox-create-template-no-match')
        .boundingBox())!;
      expect(
        popupBox.height - emptyBox.height,
        `空列表时弹层底部多出 ${popupBox.height - emptyBox.height}px 空白`,
      ).toBeLessThanOrEqual(2);
    } finally {
      await cleanupTemplates();
    }
  });

  test('删除模板走确认弹窗：文案写明只删模板、不影响已创建的沙箱', async ({ page }) => {
    readFixtures();
    await cleanupTemplates();

    try {
      await openCreateDialog(page);
      await page.getByTestId('page-sandbox-create-name-input').fill(SANDBOX_NAME);
      await saveTemplateFromCreateDialog(page, TEMPLATE_NAME);

      await page.keyboard.press('Escape');
      await openSettingsDrawer(page);

      const row = templateRow(page, TEMPLATE_NAME);
      await expect(row).toHaveCount(1);
      await row.getByTestId('page-settings-template-delete-button').click();

      const dialog = page.getByTestId('page-settings-template-delete-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(`删除模板 ${TEMPLATE_NAME}`);
      await expect(page.getByTestId('page-settings-template-delete-untouched-note')).toHaveText(
        '只删模板，不影响已创建的沙箱',
      );

      // 取消：模板还在。
      await page.getByTestId('page-settings-template-delete-cancel-button').click();
      await expect(dialog).toBeHidden();
      await expect(templateRow(page, TEMPLATE_NAME)).toHaveCount(1);

      // 再打开并确认删除：模板没了。
      await row.getByTestId('page-settings-template-delete-button').click();
      await page.getByTestId('page-settings-template-delete-confirm-button').click();
      await expect(templateRow(page, TEMPLATE_NAME)).toHaveCount(0);
      expect((await listTemplates()).some((item) => item.name === TEMPLATE_NAME)).toBe(false);
    } finally {
      await cleanupTemplates();
    }
  });
});
