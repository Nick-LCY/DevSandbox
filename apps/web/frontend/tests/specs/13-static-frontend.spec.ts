/**
 * 静态源与后端的分工验收。
 *
 * 后端退化成**纯 API 服务**：只提供 `/api`，不托管前端静态资源
 * （根路径 `/` 返回 404）。前端产物由**独立静态源**伺服——生产形态是
 * Cloudflare Workers 独立托管前端，验收环境里是本地 `vite preview`。
 *
 * 两条用例把这条分工钉死：
 * - **静态源根 → 200**，且出页面（含 `page-layout-title`）；
 * - **后端根 → 404**，且响应体不是 HTML。
 *
 * 第一条同时是第二条的**正向对照**：没有它，「后端根 404」可能恒绿
 * （静态源压根没起时它也成立——404 与「压根没东西在跑」分不开）。
 */

import { expect, test } from '@playwright/test';

import { backendBaseUrl } from '../helpers/api';
import { staticBaseUrl } from '../helpers/sandbox';

test.describe('静态源与后端的分工', () => {
  test('静态源根：200 且出页面', async ({ page }) => {
    const response = await page.request.get(staticBaseUrl());
    expect(response.status(), '静态源根路径该出页面').toBe(200);
    expect(await response.text(), '静态源根页面不该缺 page-layout-title').toContain(
      'page-layout-title',
    );

    // 浏览器里真的能打开：页面在静态源上，工作台照常挂载。
    await page.goto('/');
    await expect(page.getByTestId('page-layout-title')).toBeVisible();
  });

  test('后端根：404 且不是 HTML', async ({ page }) => {
    const response = await page.request.get(`${backendBaseUrl()}/`);
    expect(response.status(), '后端根路径不该返回页面').toBe(404);
    expect((await response.text()).toLowerCase(), '后端根路径不该吐 HTML').not.toContain(
      '<html',
    );
  });
});
