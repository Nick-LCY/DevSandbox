/**
 * 文件注入真机验收。
 *
 * 三条口径：
 * 1. 注入 0600 宿主文件 → 容器内读到副本 → 只读写入失败 → 宿主原件零变化；
 * 2. 删除沙箱后注入副本随家目录消失、宿主原件仍在；
 * 3. 模板里带文件声明 → 保存 → 回填 → 真机全流程（用模板建沙箱，容器内读到副本）。
 *
 * 注入源是宿主上的真实文件（0700 目录里的 0600 文件）：平台以特权身份把它
 * 复制成沙箱用户拥有的副本、只读挂进容器。宿主原件的权限、内容、修改时间
 * 都不该被碰；副本随沙箱家目录同寿。
 *
 * 三期起后端对全部 `/api` 生效令牌认证：接口直取走 `helpers/api.ts`
 * （统一带认证头），页面侧的令牌由套件的 storageState 预置
 * （`helpers/connection.ts`）。
 */

import fs from 'node:fs';

import { expect, test } from '@playwright/test';

import { deleteSandbox, deleteTemplate, getSandbox, listTemplates } from '../helpers/api';
import {
  addFileRow,
  applyTemplate,
  confirmDelete,
  fillCreateForm,
  openCreateDialog,
  openDeleteDialog,
  saveTemplateFromCreateDialog,
  selectCreatedSandbox,
  selectImage,
} from '../helpers/console';
import { fileMode, pathExists, sandboxHome } from '../helpers/host';
import {
  expectTerminalConnected,
  expectTerminalText,
  openTerminal,
  typeInTerminal,
} from '../helpers/terminal';
import { createSecretFile, removeSecretFile } from '../helpers/workspace';

/** 平台基础镜像（宿主已有）：注入用例只关心文件行为，不依赖任何个人镜像。 */
const IMAGE = 'sandbox-platform/base:0.3.0';
/** 注入副本在容器内的落点。 */
const CONTAINER_PATH = '/run/injected/key';
/** 注入源在沙箱用户家目录里的暂存目录名（与核心包的常量一致）。 */
const STAGING_DIRNAME = '.sandbox-files';
/** 模板名前缀：收尾清理只碰验收前缀的模板。 */
const TEMPLATE_PREFIX = 'acc-模板';
/** 带文件声明的模板名。 */
const TEMPLATE_NAME = `${TEMPLATE_PREFIX}-含注入文件`;

/** 删掉本轮可能留下的验收模板（只碰验收前缀的）。 */
async function cleanupTemplates(): Promise<void> {
  const templates = await listTemplates();
  for (const template of templates) {
    if (template.name.startsWith(TEMPLATE_PREFIX)) {
      await deleteTemplate(template.id);
    }
  }
}

test.describe('文件注入', () => {
  test('注入 0600 宿主文件 → 容器内读到副本 → 只读写入失败 → 原件零变化', async ({ page }) => {
    const name = 'acc-file-inject';
    const secret = createSecretFile();
    const mtimeBefore = fs.statSync(secret.path).mtimeMs;
    try {
      // ── ① 抽屉里建沙箱：声明区加一条文件注入（宿主路径 → 容器内路径）
      await openCreateDialog(page);
      await fillCreateForm(page, {
        name,
        image: IMAGE,
        fileHost: secret.path,
        fileContainer: CONTAINER_PATH,
        command: 'sleep infinity',
      });
      await selectCreatedSandbox(page, name);
      await expect(page.getByTestId('page-sandbox-detail-title')).toContainText(name);

      // ── ② 详情里的注入副本清单：只读、落在沙箱用户家目录的暂存目录里
      const detail = await getSandbox(name);
      expect(detail.files, '沙箱详情里没有注入副本清单').toHaveLength(1);
      expect(detail.files[0].container_path).toBe(CONTAINER_PATH);
      expect(detail.files[0].read_only, '注入副本不是只读挂载').toBe(true);
      expect(detail.files[0].host_path).toContain(STAGING_DIRNAME);
      expect(detail.files[0].host_path).toContain(sandboxHome(detail.system_user));
      test.info().annotations.push({
        type: '注入副本',
        description: `${detail.files[0].host_path} → ${detail.files[0].container_path}（只读）`,
      });

      // ── ③ 网页终端读副本：内容与原件一字不差
      const sessionId = await openTerminal(page);
      await expectTerminalConnected(page);
      await typeInTerminal(page, sessionId, `cat ${CONTAINER_PATH}`);
      await expectTerminalText(page, sessionId, secret.content);

      // ── ④ 副本只读：写入必须失败（内核回 EROFS，shell 报只读文件系统）
      await typeInTerminal(page, sessionId, `echo x > ${CONTAINER_PATH}`);
      await expectTerminalText(page, sessionId, 'Read-only file system');

      // ── ⑤ 原件零变化：权限、内容、修改时间都没被碰过
      expect(fileMode(secret.path), '注入原件的权限被改了').toBe('600');
      expect(fs.readFileSync(secret.path, 'utf-8'), '注入原件的内容被改了').toBe(
        secret.content,
      );
      expect(fs.statSync(secret.path).mtimeMs, '注入原件的修改时间被改了').toBe(mtimeBefore);
    } finally {
      await deleteSandbox(name).catch(() => undefined);
      removeSecretFile(secret);
    }
  });

  test('删除沙箱后注入副本消失、宿主原件仍在', async ({ page }) => {
    const name = 'acc-file-gone';
    const secret = createSecretFile();
    try {
      // ── ① 建沙箱（带一条文件注入）
      await openCreateDialog(page);
      await fillCreateForm(page, {
        name,
        image: IMAGE,
        fileHost: secret.path,
        fileContainer: CONTAINER_PATH,
        command: 'sleep infinity',
      });
      await selectCreatedSandbox(page, name);

      const detail = await getSandbox(name);
      const staging = `${sandboxHome(detail.system_user)}/${STAGING_DIRNAME}`;
      // 副本确实落在沙箱用户家目录里（删之前先看一眼它在）。
      expect(pathExists(staging), '注入副本的暂存目录不在沙箱用户家目录里').toBe(true);
      test.info().annotations.push({
        type: '副本暂存目录',
        description: staging,
      });

      // ── ② 经工作台删除：侧栏选中 → 头部「删除」→ 弹窗里点一次确认
      const deleted = page.waitForResponse(
        (response) =>
          response.url().includes(`/api/sandboxes/${name}`) &&
          response.request().method() === 'DELETE',
        { timeout: 120_000 },
      );
      await openDeleteDialog(page);
      await confirmDelete(page);
      expect((await deleted).status(), '删除接口没有返回成功').toBe(200);
      await expect(page.getByTestId('page-sandbox-detail-empty')).toBeVisible({
        timeout: 120_000,
      });

      // ── ③ 副本随家目录一起消失
      expect(pathExists(staging), '删除沙箱后注入副本还在').toBe(false);
      // ── ④ 宿主原件不受影响：还在，内容一字未变
      expect(pathExists(secret.path), '删除沙箱后宿主原件被删了').toBe(true);
      expect(fs.readFileSync(secret.path, 'utf-8'), '删除沙箱后宿主原件内容变了').toBe(
        secret.content,
      );
      expect(fileMode(secret.path)).toBe('600');
    } finally {
      await deleteSandbox(name).catch(() => undefined);
      removeSecretFile(secret);
    }
  });

  test('模板含文件声明：保存 → 回填 → 用模板建沙箱 → 容器内读到副本', async ({ page }) => {
    const secret = createSecretFile();
    const name = 'acc-file-tpl';
    await cleanupTemplates();
    try {
      // ── ① 新建抽屉：填一条文件声明，存成模板
      await openCreateDialog(page);
      await page.getByTestId('page-sandbox-create-name-input').fill(name);
      await selectImage(page, IMAGE);
      await addFileRow(page, secret.path, CONTAINER_PATH);
      await page.getByTestId('page-sandbox-create-command-input').fill('sleep infinity');
      await saveTemplateFromCreateDialog(page, TEMPLATE_NAME);

      // 落盘核对：模板里存的就是表单里的**原文**（声明原样存取）。
      const saved = (await listTemplates()).find((item) => item.name === TEMPLATE_NAME);
      expect(saved, '模板没有落盘').toBeTruthy();
      expect(saved!.config.files).toEqual([`${secret.path}:${CONTAINER_PATH}`]);

      // ── ② 重新打开抽屉：选中模板即回填，文件行被整体回填
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('page-sandbox-create-dialog')).toBeHidden();
      await openCreateDialog(page);
      await page.getByTestId('page-sandbox-create-name-input').fill(name);
      await applyTemplate(page, TEMPLATE_NAME);

      const fileRows = page.getByTestId('page-sandbox-create-file-item');
      await expect(fileRows, '模板里的文件声明没有回填').toHaveCount(1);
      await expect(
        page.getByTestId('page-sandbox-create-file-host-input'),
        '回填的宿主路径与模板里写的不一致',
      ).toHaveValue(secret.path);
      await expect(
        page.getByTestId('page-sandbox-create-file-container-input'),
        '回填的容器路径与模板里写的不一致',
      ).toHaveValue(CONTAINER_PATH);

      // ── ③ 用这份回填的表单建沙箱
      await fillCreateForm(page, {
        name,
        image: IMAGE,
        command: 'sleep infinity',
      });
      await selectCreatedSandbox(page, name);
      await expect(page.getByTestId('page-sandbox-detail-title')).toContainText(name);

      const detail = await getSandbox(name);
      expect(detail.files, '沙箱详情里没有注入副本清单').toHaveLength(1);
      expect(detail.files[0].container_path).toBe(CONTAINER_PATH);

      // ── ④ 容器内读到副本内容：与宿主原件一致
      const sessionId = await openTerminal(page);
      await expectTerminalConnected(page);
      await typeInTerminal(page, sessionId, `cat ${CONTAINER_PATH}`);
      await expectTerminalText(page, sessionId, secret.content);
    } finally {
      await deleteSandbox(name).catch(() => undefined);
      await cleanupTemplates().catch(() => undefined);
      removeSecretFile(secret);
    }
  });
});
