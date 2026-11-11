/**
 * 静态源与后端的分工验收。
 *
 * 后端退化成**纯 API 服务**：只提供 `/api`，不托管前端静态资源
 * （根路径 `/` 返回 404）。前端产物由**独立静态源**伺服——生产形态是
 * Cloudflare Workers 独立托管前端，验收环境里是本地 `vite preview`。
 *
 * 两条用例把这条分工钉死：
 * - **静态源根 → 200**，且页面真的能打开（React 挂载后工作台照常在）；
 * - **后端根 → 404**，且响应体不是 HTML。
 *
 * 第一条同时是第二条的**正向对照**：没有它，「后端根 404」可能恒绿
 * （静态源压根没起时它也成立——404 与「压根没东西在跑」分不开）。
 *
 * **静态外壳的占位标识证明不了 React 挂载**：`index.html` 自带
 * `<h1 data-testid="page-layout-title">` 占位（React 挂载后才被替换），
 * 拿它断言「工作台在」恒真。工作台的证据一律用 **React 渲染后才存在**的
 * 标识：已配置态是 `page-sandbox-list-title`（侧栏沙箱列表标题），
 * 未配置态是 `page-connection-setup`（引导面板）。
 */

import { expect, test } from '@playwright/test';

import { backendBaseUrl } from '../helpers/api';
import { staticBaseUrl } from '../helpers/sandbox';

test.describe('静态源与后端的分工', () => {
  test('静态源根：200 且出页面', async ({ page }) => {
    const response = await page.request.get(staticBaseUrl());
    expect(response.status(), '静态源根路径该出页面').toBe(200);
    // 辅助证据：静态源吐出的是 index.html 静态外壳。
    // **只证明「静态源在吐页面」**——外壳自带同名占位标识，证明不了 React 挂载。
    expect(await response.text(), '静态源根页面该是 index.html 静态外壳').toContain(
      'page-layout-title',
    );

    // 浏览器里真的能打开：等 **React 渲染后才有**的标识出现（工作台挂载的证据）。
    await page.goto('/');
    await expect
      .poll(
        async () =>
          (await page.getByTestId('page-sandbox-list-title').count()) +
          (await page.getByTestId('page-connection-setup').count()),
        {
          timeout: 30_000,
          message: 'React 没挂载：沙箱列表标题与引导面板都没出现',
        },
      )
      .toBeGreaterThan(0);

    // 验收套件预置了连接配置（storageState），页面该是「已配置」态：
    // 工作台挂载（侧栏沙箱列表标题可见），引导面板不出现。
    await expect(page.getByTestId('page-sandbox-list-title')).toBeVisible();
    await expect(page.getByTestId('page-connection-setup')).toHaveCount(0);
  });

  test('后端根：404 且不是 HTML', async ({ page }) => {
    const response = await page.request.get(`${backendBaseUrl()}/`);
    expect(response.status(), '后端根路径不该返回页面').toBe(404);
    expect((await response.text()).toLowerCase(), '后端根路径不该吐 HTML').not.toContain(
      '<html',
    );
  });
});
