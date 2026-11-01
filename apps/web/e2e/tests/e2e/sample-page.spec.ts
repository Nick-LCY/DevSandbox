import { test, expect } from '@playwright/test';

import { screenshotPath } from '../../helpers/artifacts';

/**
 * 最小端到端冒烟：打开静态页首页 → 断言 data-testid 元素存在 → 截图。
 *
 * 只断言 page-home-title：这一个标识是静态页底座的稳定契约，
 * 断言它就等于断言「页面可达 + 定位入口可用」。
 */
test.describe('最小端到端冒烟', () => {
  test('打开静态页 → 断言 data-testid 元素存在 → 截图', async ({ page }, testInfo) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);

    await expect(page.getByTestId('page-home-title')).toBeVisible();

    const file = screenshotPath(testInfo, 'sample-page');
    await page.screenshot({ path: file, fullPage: true });
    console.log(`[用例] 截图已保存：${file}`);
  });
});
