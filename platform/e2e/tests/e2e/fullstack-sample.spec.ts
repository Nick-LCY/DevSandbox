/**
 * 全栈示例的端到端用例。
 *
 * 覆盖一条完整业务链路：
 *   Logto 登录页真实输入 → 授权码回调 → 后端校验 id_token → 写 Postgres → 传 MinIO → 列表展示 → 下载校验。
 *
 * 数据库隔离：每个用例独占一个用例库（由 fixtures/test-db.ts 克隆自模板库），
 * 用例通过 x-sample-database 请求头告诉后端本次请求用哪个库，
 * 因此「写进 Postgres」这一步是落在本用例自己的库里的。
 */

import fs from 'node:fs/promises';

import { screenshotPath } from '../../helpers/artifacts';
import { signInWithLogto } from '../../helpers/logto-signin';
import { withClient } from '../../helpers/postgres';
import { test, expect } from '../../fixtures/test-db';
const LOGTO_USERNAME = process.env.E2E_LOGTO_USERNAME ?? 'sampleuser';
const LOGTO_PASSWORD = process.env.E2E_LOGTO_PASSWORD ?? 'SamplePass123!';

/**
 * 删除本用例自己新建的记录，把用例库恢复到用例进来时的样子。
 *
 * 为什么需要：用例库虽然按用例分配（每用例一库），但本用例新建的记录
 * 不清理会留在库里，影响复跑与人工排查时的数据核对。
 */
async function removeOwnRecords(databaseUrl: string, marker: string): Promise<void> {
  await withClient(databaseUrl, async (client) => {
    await client.query('DELETE FROM sample_records WHERE title LIKE $1', [`${marker}%`]);
  });
}

test.describe('全栈示例：登录 → 写库 → 传文件 → 列表', () => {
  test('Logto 登录 → 新建记录（带附件）→ 列表展示 → 下载校验', async ({ page, testDb }, testInfo) => {
    console.log(`[用例] 用例库=${testDb.name} worker=${testInfo.workerIndex}`);

    // 让后端把这次请求落到本用例独占的数据库上。
    await page.setExtraHTTPHeaders({ 'x-sample-database': testDb.name });

    // ① 打开应用首页
    await page.goto('/');
    await expect(page.getByTestId('page-home-title')).toBeVisible();
    await expect(page.getByTestId('page-home-login-button')).toBeVisible();

    // ② 走 Logto 真实登录页（浏览器里真实输入用户名与口令）
    await page.getByTestId('page-home-login-button').click();
    await signInWithLogto(page, LOGTO_USERNAME, LOGTO_PASSWORD);

    // ③ 回调落地后前端回到首页，用户信息可见
    await page.waitForURL((url) => !url.pathname.startsWith('/auth/callback'), { timeout: 45_000 });
    await expect(page.getByTestId('page-home-user-name')).toBeVisible();
    await expect(page.getByTestId('page-home-logout-button')).toBeVisible();

    const userName = (await page.getByTestId('page-home-user-name').innerText()).trim();
    expect(userName.length).toBeGreaterThan(0);

    // ④ 提交数据（写 Postgres）并同时上传附件（进 MinIO）
    const title = `端到端记录-${testDb.name}`;
    const content = `由端到端用例写入，用例库 ${testDb.name}`;
    const fileContent = `附件内容-${testDb.name}`;

    await page.getByTestId('page-home-record-title-input').fill(title);
    await page.getByTestId('page-home-record-content-input').fill(content);
    await page.getByTestId('page-home-record-file-input').setInputFiles({
      name: 'evidence.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(fileContent, 'utf-8'),
    });
    await page.getByTestId('page-home-record-submit-button').click();

    // ⑤ 列表页展示这条记录
    await expect(page.getByTestId('page-home-record-submit-status')).toContainText(title);
    const itemTitle = page.getByTestId('page-home-record-list-item-title').filter({ hasText: title });
    await expect(itemTitle).toHaveCount(1);

    const screenshot = screenshotPath(testInfo, 'fullstack-record-created');
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log(`[用例] 截图已保存：${screenshot}`);

    // ⑥ 记录真的写进了本用例独占的数据库（隔离佐证）
    const rows = await withClient(testDb.url, async (client) => {
      const result = await client.query<{ title: string; owner_id: string }>(
        'SELECT title, owner_id FROM sample_records WHERE title = $1',
        [title],
      );
      return result.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_id.length).toBeGreaterThan(0);

    // ⑦ 附件真的进了 MinIO：下载回来的字节与上传的一致（S3 协议往返）
    const downloadLink = page.getByTestId('page-home-record-list-item-file-link');
    await expect(downloadLink).toHaveCount(1);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadLink.click(),
    ]);
    const downloaded = await download.path();
    expect(downloaded).not.toBeNull();
    const bytes = await fs.readFile(downloaded as string, 'utf-8');
    expect(bytes).toBe(fileContent);
  });

  test('未登录时记录接口拒绝访问，登录后可以读写', async ({ page, request, testDb }) => {
    // ① 未登录：记录列表接口返回 401
    const anonymous = await request.get('/api/records');
    expect(anonymous.status()).toBe(401);

    // ② 登录后可以读到列表（种子里已有两条初始记录）
    await page.setExtraHTTPHeaders({ 'x-sample-database': testDb.name });
    await page.goto('/');
    await page.getByTestId('page-home-login-button').click();
    await signInWithLogto(page, LOGTO_USERNAME, LOGTO_PASSWORD);
    await page.waitForURL((url) => !url.pathname.startsWith('/auth/callback'), { timeout: 45_000 });

    await expect(page.getByTestId('page-home-record-list-item')).toHaveCount(2);
  });
});

/**
 * 下一轮需求 R1：记录列表按关键字过滤。
 *
 * 判据（来自 BRIEF-NEXT.md 的 R1）：
 *   1. 只看标题与内容两个字段，不区分大小写的子串匹配；
 *   2. 关键字为空（空串或只有空格）时，过滤结果等于全量列表；
 *   3. 过滤只影响列表展示，后端接口 GET /api/records 仍返回全量；
 *   4. 过滤状态在列表重新加载（新建记录后刷新列表）后保持，关键字不清空；
 *   5. 清除按钮等价于「把关键字置空后再点过滤」。
 */
test.describe('全栈示例：列表过滤与提交加载态', () => {
  test('列表页按关键字过滤', async ({ page, testDb }, testInfo) => {
    console.log(`[用例] 用例库=${testDb.name}（R1 列表过滤）`);

    await page.setExtraHTTPHeaders({ 'x-sample-database': testDb.name });

    // ① 登录
    await page.goto('/');
    await page.getByTestId('page-home-login-button').click();
    await signInWithLogto(page, LOGTO_USERNAME, LOGTO_PASSWORD);
    await page.waitForURL((url) => !url.pathname.startsWith('/auth/callback'), { timeout: 45_000 });
    // 列表是登录后异步拉取的，先等它加载出来再取条数快照；
    // 用例库按用例分配，进来时种子里已有两条初始记录，
    // 因此后面一律用相对条数断言（BRIEF-NEXT.md 的 R1 也推荐相对判断）。
    await expect
      .poll(async () => page.getByTestId('page-home-record-list-item').count())
      .toBeGreaterThanOrEqual(2);
    const baseCount = await page.getByTestId('page-home-record-list-item').count();

    // ② 新建三条记录：标题命中关键字 / 与关键字无关 / 关键字只在内容里且大小写不同
    const hitTitle = `R1 过滤靶标-${testDb.name}`;
    await page.getByTestId('page-home-record-title-input').fill(hitTitle);
    await page.getByTestId('page-home-record-content-input').fill('R1 命中标题关键字');
    await page.getByTestId('page-home-record-submit-button').click();
    await expect(page.getByTestId('page-home-record-submit-status')).toContainText(hitTitle);
    await expect(
      page.getByTestId('page-home-record-list-item-title').filter({ hasText: hitTitle }),
    ).toHaveCount(1);

    const plainTitle = `R1 普通记录-${testDb.name}`;
    await page.getByTestId('page-home-record-title-input').fill(plainTitle);
    await page.getByTestId('page-home-record-content-input').fill('R1 与关键字无关的内容');
    await page.getByTestId('page-home-record-submit-button').click();
    await expect(page.getByTestId('page-home-record-submit-status')).toContainText(plainTitle);
    await expect(
      page.getByTestId('page-home-record-list-item-title').filter({ hasText: plainTitle }),
    ).toHaveCount(1);

    const mixedTitle = `R1 Case Probe-${testDb.name}`;
    await page.getByTestId('page-home-record-title-input').fill(mixedTitle);
    await page.getByTestId('page-home-record-content-input').fill('R1 内容里带 MIXEDCASE 标记');
    await page.getByTestId('page-home-record-submit-button').click();
    await expect(page.getByTestId('page-home-record-submit-status')).toContainText(mixedTitle);
    await expect(
      page.getByTestId('page-home-record-list-item-title').filter({ hasText: mixedTitle }),
    ).toHaveCount(1);

    const total = await page.getByTestId('page-home-record-list-item').count();
    expect(total).toBe(baseCount + 3);

    // ③ 标题命中：填关键字 → 点过滤 → 只剩 1 条
    await page.getByTestId('page-home-record-filter-input').fill('过滤靶标');
    await page.getByTestId('page-home-record-filter-button').click();
    await expect(page.getByTestId('page-home-record-list-item')).toHaveCount(1);
    await expect(
      page.getByTestId('page-home-record-list-item-title').filter({ hasText: '过滤靶标' }),
    ).toHaveCount(1);

    // 过滤后的界面留一张截图（给人看的证据）
    // 先等提交按钮恢复可点（上一条记录的 300 毫秒最短加载窗口结束了），截图才干净
    await expect(page.getByTestId('page-home-record-submit-button')).toBeEnabled();
    const filteredShot = screenshotPath(testInfo, 'record-filtered');
    await page.screenshot({ path: filteredShot, fullPage: true });
    console.log(`[用例] 截图已保存：${filteredShot}`);

    // ④ 过滤只影响列表展示：后端接口仍返回全量
    const apiResponse = await page.request.get('/api/records');
    expect(apiResponse.status()).toBe(200);
    const apiBody = (await apiResponse.json()) as { records: unknown[] };
    expect(apiBody.records.length).toBe(total);

    // ⑤ 过滤状态在列表重新加载后保持（新建记录触发刷新，关键字不清空）
    const duringFilterTitle = `R1 过滤期间新建-${testDb.name}`;
    await page.getByTestId('page-home-record-title-input').fill(duringFilterTitle);
    await page.getByTestId('page-home-record-content-input').fill('R1 过滤期间新建的内容');
    await page.getByTestId('page-home-record-submit-button').click();
    await expect(page.getByTestId('page-home-record-submit-status')).toContainText(duringFilterTitle);
    await expect(page.getByTestId('page-home-record-filter-input')).toHaveValue('过滤靶标');
    await expect(page.getByTestId('page-home-record-list-item')).toHaveCount(1);

    // ⑥ 清除按钮：清空关键字并恢复全量列表
    await page.getByTestId('page-home-record-filter-clear-button').click();
    await expect(page.getByTestId('page-home-record-filter-input')).toHaveValue('');
    await expect(page.getByTestId('page-home-record-list-item')).toHaveCount(total + 1);
    // 过滤期间新建的那条记录，清除后确实出现在列表里
    await expect(
      page.getByTestId('page-home-record-list-item-title').filter({ hasText: duringFilterTitle }),
    ).toHaveCount(1);

    // ⑦ 只看标题与内容，且不区分大小写：内容里的 MIXEDCASE 用小写关键字命中
    await page.getByTestId('page-home-record-filter-input').fill('mixedcase');
    await page.getByTestId('page-home-record-filter-button').click();
    await expect(page.getByTestId('page-home-record-list-item')).toHaveCount(1);
    await expect(
      page.getByTestId('page-home-record-list-item-title').filter({ hasText: 'Case Probe' }),
    ).toHaveCount(1);

    // ⑧ 关键字为空（只有空格）时，过滤结果等于全量列表
    await page.getByTestId('page-home-record-filter-input').fill('   ');
    await page.getByTestId('page-home-record-filter-button').click();
    await expect(page.getByTestId('page-home-record-list-item')).toHaveCount(total + 1);

    // 清理本用例新建的记录，把用例库恢复原样
    await removeOwnRecords(testDb.url, 'R1 ');
  });

  /**
   * 下一轮需求 R2：提交过程有加载态。
   *
   * 判据（来自 BRIEF-NEXT.md 的 R2）：
   *   1. 提交（含附件上传）进行期间，页面出现可见的加载指示元素；
   *   2. 提交结束后该元素从页面上消失；
   *   3. 提交进行期间提交按钮保持 disabled；
   *   4. 加载元素最短显示 300 毫秒（请求很快返回时也不立刻消失）。
   */
  test('提交过程有加载态', async ({ page, testDb }, testInfo) => {
    console.log(`[用例] 用例库=${testDb.name}（R2 提交加载态）`);

    await page.setExtraHTTPHeaders({ 'x-sample-database': testDb.name });

    // ① 登录
    await page.goto('/');
    await page.getByTestId('page-home-login-button').click();
    await signInWithLogto(page, LOGTO_USERNAME, LOGTO_PASSWORD);
    await page.waitForURL((url) => !url.pathname.startsWith('/auth/callback'), { timeout: 45_000 });

    // ② 填好表单并带上附件
    const title = `R2 加载态记录-${testDb.name}`;
    await page.getByTestId('page-home-record-title-input').fill(title);
    await page.getByTestId('page-home-record-content-input').fill('R2 用例写入的内容');
    await page.getByTestId('page-home-record-file-input').setInputFiles({
      name: 'loading-evidence.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(`R2 附件内容-${testDb.name}`, 'utf-8'),
    });

    // ③ 点提交
    const submitButton = page.getByTestId('page-home-record-submit-button');
    const loading = page.getByTestId('page-home-record-upload-loading');
    await submitButton.click();

    // ④ 提交过程中：加载态可见、提交按钮保持置灰
    await expect(loading).toBeVisible();
    await expect(submitButton).toBeDisabled();

    // 加载态的界面留一张截图（给人看的证据）：截表单区域，
    // 能同时看到加载指示元素与置灰的提交按钮。
    const loadingShot = screenshotPath(testInfo, 'record-upload-loading');
    try {
      await page.screenshot({ path: loadingShot, timeout: 5000 });
      console.log(`[用例] 截图已保存：${loadingShot}`);
    } catch (error) {
      await page.getByTestId('page-home-record-form').screenshot({ path: loadingShot, timeout: 5000 });
      console.log(
        `[用例] 整页截图未取到，改截表单：${loadingShot}（${(error as Error).message.split('\n')[0]}）`,
      );
    }

    // ⑤ 提交结束后：加载态消失、记录出现在列表里
    await expect(loading).toBeHidden();
    await expect(
      page.getByTestId('page-home-record-list-item-title').filter({ hasText: title }),
    ).toHaveCount(1);

    // 清理本用例新建的记录，把用例库恢复原样
    await removeOwnRecords(testDb.url, 'R2 ');
  });
});
