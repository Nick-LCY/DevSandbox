/**
 * 全栈示例的端到端用例。
 *
 * 覆盖一条完整业务链路：
 *   Logto 登录页真实输入 → 授权码回调 → 后端校验 id_token → 写 Postgres → 传 MinIO → 列表展示 → 下载校验。
 *
 * 数据库隔离：每个 worker 独占一个用例库（由 fixtures/test-db.ts 克隆自模板库），
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
