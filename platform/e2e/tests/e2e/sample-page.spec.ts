import { screenshotPath } from '../../helpers/artifacts';
import { test, expect } from '../../fixtures/test-db';

/**
 * 最小端到端样例：打开应用首页 → 断言 data-testid 元素存在 → 截图。
 *
 * 只断言 page-home-title：这一个标识在「基建自检用的最小静态页」与
 * 「全栈示例应用」上都存在，因此本用例在两种流程下都成立。
 * 静态页更细的断言在探索模式里做（不参与判定）。
 */
test.describe('最小端到端样例', () => {
  test('打开示例页 → 断言 data-testid 元素存在 → 截图', async ({ page, testDb }, testInfo) => {
    console.log(`[用例] 用例库=${testDb.name} worker=${testInfo.workerIndex}`);

    const response = await page.goto('/');
    expect(response?.status()).toBe(200);

    await expect(page.getByTestId('page-home-title')).toBeVisible();

    const file = screenshotPath(testInfo, 'sample-page');
    await page.screenshot({ path: file, fullPage: true });
    console.log(`[用例] 截图已保存：${file}`);
  });
});
