/**
 * 控制台页面的通用操作。
 *
 * 控制台是单页工作台：沙箱列表在左侧边栏，选中沙箱后右侧是工作区；
 * 新建沙箱 / 沙箱详情 / 代理设置都是弹窗。
 */

import { expect, type Page } from '@playwright/test';

/** 打开工作台（沙箱列表在左侧边栏）。 */
export async function gotoList(page: Page): Promise<void> {
  await page.goto('/#/');
  await expect(page.getByTestId('page-sandbox-list-title')).toBeVisible();
}

/** 打开新建沙箱弹窗。 */
export async function gotoCreate(page: Page): Promise<void> {
  await page.goto('/#/');
  // 侧栏与空态各有一个「新建沙箱」按钮，取第一个即可。
  await page.getByTestId('page-sandbox-list-create-button').first().click();
  await expect(page.getByTestId('page-sandbox-create-dialog')).toBeVisible();
}

/** 打开某个沙箱的工作区（右侧显示摘要与终端会话标签）。 */
export async function gotoDetail(page: Page, name: string): Promise<void> {
  await page.goto(`/#/sandboxes/${encodeURIComponent(name)}`);
  await expect(page.getByTestId('page-sandbox-detail-title')).toContainText(name);
}

/** 在新建弹窗里填一份完整的创建表单并提交，返回提交后等待成功提示的耗时（毫秒）。 */
export async function fillCreateForm(
  page: Page,
  options: {
    name: string;
    image: string;
    mountHost?: string;
    mountContainer?: string;
    readOnly?: boolean;
    command?: string;
    env?: string;
  },
): Promise<number> {
  await page.getByTestId('page-sandbox-create-name-input').fill(options.name);
  await page.getByTestId('page-sandbox-create-image-select').selectOption(options.image);
  if (options.mountHost) {
    await page.getByTestId('page-sandbox-create-mount-add-button').click();
    const row = page.getByTestId('page-sandbox-create-mount-item').last();
    await row.getByTestId('page-sandbox-create-mount-host-input').fill(options.mountHost);
    await row.getByTestId('page-sandbox-create-mount-container-input').fill(
      options.mountContainer ?? '/workspace',
    );
    if (options.readOnly) {
      await row.getByTestId('page-sandbox-create-mount-readonly-checkbox').check();
    }
  }
  if (options.command !== undefined) {
    await page.getByTestId('page-sandbox-create-command-input').fill(options.command);
  }
  if (options.env !== undefined) {
    await page.getByTestId('page-sandbox-create-env-input').fill(options.env);
  }
  const started = Date.now();
  await page.getByTestId('page-sandbox-create-submit-button').click();
  await expect(page.getByTestId('page-sandbox-create-success')).toBeVisible({ timeout: 300_000 });
  return Date.now() - started;
}

/**
 * 弹窗字段的标识映射。
 *
 * 与工作区头部重名的四个字段在弹窗里换了标识（避免 Playwright 严格模式
 * 撞车）；其余字段只在弹窗里出现，标识不变。
 */
const DIALOG_FIELD_IDS: Record<string, string> = {
  state: 'page-sandbox-detail-dialog-state',
  image: 'page-sandbox-detail-dialog-image',
  'created-at': 'page-sandbox-detail-dialog-created-at',
  'updated-at': 'page-sandbox-detail-dialog-updated-at',
};

/** 字段名 → 弹窗里的定位标识。 */
function dialogFieldId(field: string): string {
  return DIALOG_FIELD_IDS[field] ?? `page-sandbox-detail-${field}`;
}

/** 打开沙箱详情弹窗（完整字段在弹窗里）。 */
export async function openDetailDialog(page: Page): Promise<void> {
  await page.getByTestId('page-sandbox-detail-detail-button').click();
  await expect(page.getByTestId('page-sandbox-detail-dialog')).toBeVisible();
}

/**
 * 取沙箱详情弹窗里的某个字段文本。
 *
 * 完整字段（镜像来源 / 系统用户 / 容器名 / 挂载 / 子 ID 段…）只在详情弹窗里，
 * 所以先确保弹窗是开着的；读完顺手关掉，免得与工作区头部的同名字段撞车。
 *
 * 字段名传字段本身（`image` / `image-source`），不传完整标识：
 * 与工作区头部重名的四个字段（状态 / 镜像 / 创建时间 / 更新时间）在弹窗里
 * 换了标识（`page-sandbox-detail-dialog-*`），映射关系只在本文件里维护。
 */
export async function detailField(page: Page, field: string): Promise<string> {
  const dialog = page.getByTestId('page-sandbox-detail-dialog');
  const opened = !(await dialog.isVisible());
  if (opened) {
    await openDetailDialog(page);
  }
  const text = ((await dialog.getByTestId(dialogFieldId(field)).textContent()) ?? '').trim();
  if (opened) {
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }
  return text;
}
