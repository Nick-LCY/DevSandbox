/**
 * 控制台页面的通用操作。
 */

import { expect, type Page } from '@playwright/test';

/** 打开沙箱列表页。 */
export async function gotoList(page: Page): Promise<void> {
  await page.goto('/#/');
  await expect(page.getByTestId('page-sandbox-list-title')).toBeVisible();
}

/** 打开新建沙箱页。 */
export async function gotoCreate(page: Page): Promise<void> {
  await page.goto('/#/new');
  await expect(page.getByTestId('page-sandbox-create-title')).toBeVisible();
}

/** 打开沙箱详情页。 */
export async function gotoDetail(page: Page, name: string): Promise<void> {
  await page.goto(`/#/sandboxes/${encodeURIComponent(name)}`);
  await expect(page.getByTestId('page-sandbox-detail-title')).toBeVisible();
}

/** 在新建页填一份完整的创建表单并提交，返回提交后等待成功提示的耗时（毫秒）。 */
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

/** 取沙箱详情页上的某个字段文本。 */
export async function detailField(page: Page, testId: string): Promise<string> {
  return ((await page.getByTestId(testId).textContent()) ?? '').trim();
}
