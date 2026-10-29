import { screenshotPath } from '../../helpers/artifacts';
import { test, expect } from '../../fixtures/test-db';

const APP_URL = process.env.E2E_APP_URL ?? 'http://app:8000';

test.describe('最小端到端样例', () => {
  test('打开示例页 → 断言 data-testid 元素存在 → 截图', async ({ page, testDb }, testInfo) => {
    console.log(`[用例] 用例库=${testDb.name} worker=${testInfo.workerIndex}`);

    const response = await page.goto(APP_URL);
    expect(response?.status()).toBe(200);

    await expect(page.getByTestId('page-home-title')).toBeVisible();
    await expect(page.getByTestId('page-home-summary')).toBeVisible();
    await expect(page.getByTestId('page-home-item')).toHaveCount(3);

    const file = screenshotPath(testInfo, 'sample-page');
    await page.screenshot({ path: file, fullPage: true });
    console.log(`[用例] 截图已保存：${file}`);
  });
});
