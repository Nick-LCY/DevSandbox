/**
 * 认证与连接配置验收（三期令牌化）。
 *
 * 覆盖的口径：
 * 一、无令牌访问后端 → 401（缺失与错误**不区分**：同一句文案、同一状态码）；
 * 二、错误令牌 → 401；
 * 三、正确令牌 → 200；
 * 四、终端 WebSocket 无票据 → 握手被拒（连不上，关闭码**精确判 1006**）；
 *    带有效票据 → 握手成功（**正向对照**：证明「连不上」确实是票据闸拒的，
 *    而不是地址写错 / 路由没挂 / 服务没起这类环境问题）；
 * 五、页面侧未配置连接 → 引导面板出现、**工作台不挂载**（页面状态，不是路由）；
 * 六、页面侧配置正确 → 工作台挂载（预置配置与引导面板里保存两条路都验）。
 *
 * 口径来源：
 * - 后端契约：`apps/web/backend/API.md` 第 14 章（令牌 / 票据 / 401 文案）；
 * - 令牌与失败文案：`helpers/auth.ts`（**单一来源**：服务进程注入、脚本直调、
 *   页面预置三处同一份令牌）；
 * - 页面侧的连接配置预置与清空：`helpers/connection.ts`（存储键与前端
 *   `src/lib/connection.ts` 对齐）。
 *
 * 注：本文件是**常驻**用例（不是临时验证脚本）——认证是后端的硬门禁，
 * 负向口径必须随每次回归一起跑。
 */

import { expect, test, type Page } from '@playwright/test';

import {
  AUTH_FAILED_DETAIL,
  TEST_TOKEN,
  authHeaders,
  bearerHeaders,
} from '../helpers/auth';
import {
  CONNECTION_STORAGE_KEY,
  clearConnection,
  connectionConfig,
  seedConnection,
} from '../helpers/connection';
import { gotoWorkbench, toastItem } from '../helpers/console';
import { readFixtures } from '../helpers/sandbox';

/** 后端基址（指向测试服务的实际端口）。 */
function backendBase(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * 终端 WebSocket 的地址（后端基址的 http→ws 推导，与前端同一口径）。
 *
 * 带票据时把票据放进查询参数（`?ticket=`）：浏览器 WebSocket 不能设自定义头，
 * 票据是唯一的握手凭据通道（契约见 `apps/web/backend/API.md` 第 14.3 节）。
 */
function terminalWsUrl(
  host: string,
  port: number,
  sessionId: string,
  ticket?: string,
): string {
  const base = `ws://${host}:${port}/api/terminal/sessions/${sessionId}`;
  return ticket === undefined ? base : `${base}?ticket=${encodeURIComponent(ticket)}`;
}

/**
 * 在页面上下文里探一次 WebSocket 握手。
 *
 * 返回 `{opened, code, reason}`：
 * - `opened`：握手有没有成功（`onopen` 触发 = 成功）；
 * - `code`：关闭码。**握手被拒时关闭码不送达客户端**——服务端在 accept 之前
 *   就拒了握手，生产环境（uvicorn）回 HTTP 403 拒绝响应，浏览器只能报
 *   「异常断开」1006；超时兜底是 -1（用来区分「压根没连上」与「被拒了」）。
 */
async function probeWebSocket(
  page: Page,
  url: string,
): Promise<{ opened: boolean; code: number; reason: string }> {
  return page.evaluate(
    ({ url }) =>
      new Promise<{ opened: boolean; code: number; reason: string }>((resolve) => {
        const socket = new WebSocket(url);
        const timer = window.setTimeout(() => {
          resolve({ opened: false, code: -1, reason: '握手既没连上也没关闭（超时）' });
        }, 15_000);
        socket.onopen = () => {
          window.clearTimeout(timer);
          socket.close();
          resolve({ opened: true, code: 1000, reason: '' });
        };
        socket.onerror = () => {
          // 握手被拒时浏览器只给一个泛化事件（不暴露状态码）：细节看关闭码。
        };
        socket.onclose = (event) => {
          window.clearTimeout(timer);
          resolve({ opened: false, code: event.code, reason: event.reason });
        };
      }),
    { url },
  );
}

test.describe('认证与连接配置', () => {
  test('无令牌访问后端 → 401（缺失与错误同一句文案，不回显令牌）', async ({ page }) => {
    const { port } = readFixtures();
    const base = backendBase(port);

    // ① 完全不带 Authorization 头
    const anonymous = await page.request.get(`${base}/api/health`);
    expect(anonymous.status(), '不带令牌访问 /api/health 不该通过').toBe(401);
    expect(anonymous.headers()['www-authenticate']).toBe('Bearer');
    const body = (await anonymous.json()) as { detail?: string };
    expect(body.detail).toBe(AUTH_FAILED_DETAIL);
    // 文案里不带令牌本体（缺失与错误不区分，也不回显）。
    expect(body.detail ?? '').not.toContain(TEST_TOKEN);

    // ② 头在、令牌为空：同样按认证失败处理
    const empty = await page.request.get(`${base}/api/health`, {
      headers: bearerHeaders(''),
    });
    expect(empty.status(), '空令牌不该通过').toBe(401);
    expect(((await empty.json()) as { detail?: string }).detail).toBe(AUTH_FAILED_DETAIL);

    // ③ 业务接口同样要令牌（不是只有健康自检被拦）
    const list = await page.request.get(`${base}/api/sandboxes`);
    expect(list.status(), '不带令牌访问业务接口不该通过').toBe(401);
    expect(((await list.json()) as { detail?: string }).detail).toBe(AUTH_FAILED_DETAIL);
  });

  test('错误令牌 → 401（与缺失不区分）', async ({ page }) => {
    const { port } = readFixtures();
    const base = backendBase(port);

    const wrong = await page.request.get(`${base}/api/health`, {
      headers: bearerHeaders('sbx_acc_wrong_token'),
    });
    expect(wrong.status(), '错误令牌不该通过').toBe(401);
    expect(((await wrong.json()) as { detail?: string }).detail).toBe(AUTH_FAILED_DETAIL);

    const list = await page.request.get(`${base}/api/sandboxes`, {
      headers: bearerHeaders('sbx_acc_wrong_token'),
    });
    expect(list.status(), '错误令牌访问业务接口不该通过').toBe(401);
  });

  test('正确令牌 → 200（健康自检与业务接口都通）', async ({ page }) => {
    const { port } = readFixtures();
    const base = backendBase(port);

    const health = await page.request.get(`${base}/api/health`, { headers: authHeaders() });
    expect(health.status()).toBe(200);
    expect(((await health.json()) as { status?: string }).status).toBe('ok');

    const list = await page.request.get(`${base}/api/sandboxes`, { headers: authHeaders() });
    expect(list.status()).toBe(200);
    expect(Array.isArray(await list.json())).toBe(true);
  });

  test('终端 WebSocket 无票据 → 握手被拒（连不上）', async ({ page }) => {
    const { port, host } = readFixtures();
    // 页面要有个已加载的文档（WebSocket 从页面上下文发起）。
    await page.goto('/');

    // 终端 WS 只认一次性票据（浏览器 WebSocket 不能带自定义头）。
    // 握手在 accept 之前被拒：生产环境对客户端表现为 HTTP 403 拒绝响应，
    // 关闭码不送达（浏览器侧看到的是「连不上」，close 码是 1006）。
    const outcome = await probeWebSocket(page, terminalWsUrl(host, port, 'a1b2c3d4'));

    expect(outcome.opened, '无票据的终端 WebSocket 握手不该成功').toBe(false);
    // **精确判 1006**：不能只判「不是 1000」——超时的兜底值 -1 也满足那个
    // 断言，会把「压根没连上（服务没起 / 地址写错）」蒙混成「被票据闸拒了」。
    // 1006 = 异常断开 = 握手没走完（服务端在 accept 之前拒的，关闭码不送达）。
    expect(outcome.code, `握手被拒时的关闭码不对：${outcome.reason}`).toBe(1006);
  });

  test('终端 WebSocket 带有效票据 → 握手成功（正向对照：连不上确实是票据闸拒的）', async ({
    page,
  }) => {
    const { port, host } = readFixtures();
    const base = backendBase(port);

    // 页面要有个已加载的文档（WebSocket 从页面上下文发起）。
    await page.goto('/');

    // 用 Bearer 令牌换一张一次性票据（30 秒有效、用过即废）。
    const ticketResponse = await page.request.post(`${base}/api/auth/ticket`, {
      headers: authHeaders(),
    });
    expect(ticketResponse.status(), '换票失败（票据接口本身受令牌保护）').toBe(200);
    const { ticket } = (await ticketResponse.json()) as {
      ticket?: string;
      expires_in?: number;
    };
    expect(ticket, '换票响应里没有票据').toBeTruthy();

    // 带票据连**同一个地址**（同一 host:port、同一个路由）：握手必须成功。
    // 这一条是上面那条负向用例的**正向对照**：唯一的差别是「带了票」——
    // 证明负向用例里的「连不上」是**票据闸拒的**，而不是地址写错、路由没挂、
    // 服务没起这类环境问题（否则负向用例恒绿，等于没验）。
    const outcome = await probeWebSocket(page, terminalWsUrl(host, port, 'a1b2c3d4', ticket));

    expect(outcome.opened, `带票据的终端 WebSocket 握手不该失败：${outcome.reason}`).toBe(true);
  });

  test('未配置连接：引导面板出现、工作台不挂载（页面状态，不是路由）', async ({ page }) => {
    const { port } = readFixtures();

    // 清掉预置的连接配置 → 令牌为空 = 未配置。
    await clearConnection(page);
    await page.goto('/');

    // 引导面板在
    await expect(page.getByTestId('page-connection-setup')).toBeVisible();
    await expect(page.getByTestId('page-connection-base-url-input')).toBeVisible();
    await expect(page.getByTestId('page-connection-token-input')).toBeVisible();
    await expect(page.getByTestId('page-connection-submit-button')).toBeVisible();

    // 工作台**不挂载**（不是「挂载后再隐藏」）：侧栏列表一个都不在。
    await expect(page.getByTestId('page-sandbox-list-title')).toHaveCount(0);
    await expect(page.getByTestId('page-sandbox-detail-empty')).toHaveCount(0);

    // 未配置态不是路由：地址栏里没有沙箱路由（工作台路由是 `#/`，
    // 首次进入时地址栏甚至可以没有哈希——引导面板不写路由）。
    const url = new URL(page.url());
    expect(url.pathname, '未配置态不是路由：不该落到别的路径').toBe('/');
    expect(url.hash, '未配置态不是路由：地址栏里不该有沙箱路由').not.toContain('#/sandboxes');

    // 存储里确实没有生效配置（引导态不落盘）。
    const stored = await page.evaluate(() =>
      window.localStorage.getItem('sandbox-console-connection'),
    );
    expect(stored, '未配置态不该有生效的连接配置').toBeNull();

    // 未配置时基址仍可编辑（决策 D：基址恒非空、允许改）。
    await expect(page.getByTestId('page-connection-base-url-input')).toHaveValue(
      'http://127.0.0.1:8000',
    );
    expect(port).toBeGreaterThan(0);
  });

  test('配置正确：工作台挂载、引导面板不出现（预置的连接配置）', async ({ page }) => {
    const { port } = readFixtures();

    // **不做任何运行期注入**：这一条要验的就是 `use.storageState` 预置通道——
    // `global-setup.ts` 按服务实际端口写的 `.runtime/storage-state.json`
    // 被浏览器注进 localStorage，页面一打开就是「已配置」态。
    // （早前这里多调了一次 `seedConnection`，它把预置覆盖成了同样的值，
    //   等于预置通道从没被真正验到。）

    // 页面发出去的每个请求都带令牌（前端接口层统一加）——预置的令牌真的被用上了。
    const healthRequest = page.waitForRequest(
      (request) => request.url().includes('/api/health') && request.method() === 'GET',
      { timeout: 30_000 },
    );
    await page.goto('/');
    const request = await healthRequest;
    expect((await request.allHeaders())['authorization']).toBe(`Bearer ${TEST_TOKEN}`);

    // 存储里确实是**预置的那一份**（基址指向服务实际端口 + 固定测试令牌）：
    // 预置通道真的生效了，不是运行期注入的。
    const stored = await page.evaluate(
      (key) => window.localStorage.getItem(key),
      CONNECTION_STORAGE_KEY,
    );
    expect(stored, '预置的连接配置没有进到页面存储里').not.toBeNull();
    expect(JSON.parse(stored!), '预置的连接配置内容不对').toEqual(connectionConfig(port));

    // 工作台挂载、引导面板不在。
    await expect(page.getByTestId('page-sandbox-list-title')).toBeVisible();
    await expect(page.getByTestId('page-connection-setup')).toHaveCount(0);

    // 真连上了：侧栏底部的健康自检是「正常」（不是「令牌无效」也不是「不可达」）。
    await expect(page.getByTestId('page-layout-health')).toHaveAttribute(
      'data-health-state',
      'ok',
      { timeout: 30_000 },
    );
  });

  test('引导面板里填对配置 → 保存并连接 → 工作台挂载', async ({ page }) => {
    const { port } = readFixtures();

    await clearConnection(page);
    await page.goto('/');
    await expect(page.getByTestId('page-connection-setup')).toBeVisible();

    // 基址与令牌都填对（基址指向测试服务的实际端口）。
    await page.getByTestId('page-connection-base-url-input').fill(backendBase(port));
    await page.getByTestId('page-connection-token-input').fill(TEST_TOKEN);
    await page.getByTestId('page-connection-submit-button').click();

    // 体检通过才保存：保存成功后工作台才挂载。
    await expect(page.getByTestId('page-sandbox-list-title')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('page-connection-setup')).toHaveCount(0);

    // 配置落盘（保存动作会写存储）。
    const stored = await page.evaluate(() =>
      window.localStorage.getItem('sandbox-console-connection'),
    );
    expect(stored, '保存并连接后配置没有落盘').not.toBeNull();
    const config = JSON.parse(stored!) as { backendBaseUrl: string; token: string };
    expect(config.backendBaseUrl).toBe(backendBase(port));
    expect(config.token).toBe(TEST_TOKEN);

    // 保存后重新打开页面仍是「已配置」态（配置真的落盘了）：
    // 用同一上下文的另一个页面（`clearConnection` 的清空只挂在原页面的
    // 导航上，另开一个页面走的是落盘后的存储）。
    const reopened = await page.context().newPage();
    await reopened.goto('/');
    await expect(reopened.getByTestId('page-sandbox-list-title')).toBeVisible();
    await expect(reopened.getByTestId('page-connection-setup')).toHaveCount(0);
    await reopened.close();
  });

  test('令牌无效时：健康自检显示「令牌无效」，与「后端不可达」分开', async ({ page }) => {
    const { port } = readFixtures();

    // 配置存在但令牌是错的：工作台会挂载（令牌非空 = 已配置），但接口全部 401。
    await seedConnection(page, {
      backendBaseUrl: backendBase(port),
      token: 'sbx_acc_wrong_token',
    });
    await page.goto('/');

    // 沙箱列表读不到：弹失败提示（来源 sandbox-list），文案是后端的原文。
    await expect(toastItem(page, 'error', 'sandbox-list')).toContainText(AUTH_FAILED_DETAIL, {
      timeout: 30_000,
    });

    const health = page.getByTestId('page-layout-health');
    await expect(health).toHaveAttribute('data-health-state', 'down', { timeout: 30_000 });
    // 令牌无效与后端不可达是两回事：文案带「令牌无效」前缀（ADR 0015 第 5 节）。
    await expect(health).toHaveAttribute('aria-label', /令牌无效/);
  });

  test('工作台在已配置态下正常加载（回归：既有用例依赖这条前提）', async ({ page }) => {
    // 不做任何注入：用例默认的 storageState 预置就是「已配置」态。
    await gotoWorkbench(page);
    await expect(page.getByTestId('page-sandbox-list-title')).toBeVisible();
    await expect(page.getByTestId('page-sandbox-detail-empty')).toBeVisible();
  });
});
