/**
 * 边界验收：
 * 一、沙箱内的依赖镜像拉取仍统一经统一镜像代理（代理访问日志 + 守护进程单元环境变量取证）；
 * 二、控制台服务只监听回环地址、接口要令牌、不暴露公网；
 * 三、后端只提供 `/api`：根路径与静态资源路径一律 404，前端由独立静态源托管。
 *
 * 注：二期口径是「不做认证」，三期起后端对全部 `/api` 生效令牌认证
 * （`apps/web/backend/API.md` 第 14 章）——「不带凭据也能拿到数据」那条口径
 * 已作废，改为「不带凭据 = 401，带令牌 = 200」。
 */

import { expect, test } from '@playwright/test';

import { backendBaseUrl, createSandbox, health, listSandboxes } from '../helpers/api';
import { AUTH_FAILED_DETAIL, authHeaders } from '../helpers/auth';
import { gotoDetail } from '../helpers/console';
import { run, sandboxExec, userUid } from '../helpers/host';
import { readFixtures, staticBaseUrl } from '../helpers/sandbox';

const SANDBOX_NAME = 'acc-proxy';
const IMAGE = 'sandbox-platform/base:0.2.0';
/** 拉一个沙箱内没有的小镜像：拉取必然要出网，出网只可能经代理。 */
const PULL_IMAGE = 'busybox:1.37';
const PROXY_CONTAINER = 'sandbox-platform-registry-proxy';

test.describe('边界', () => {
  test('沙箱内依赖镜像拉取统一经镜像代理', async () => {
    readFixtures();
    const existing = (await listSandboxes()).find((item) => item.name === SANDBOX_NAME);
    if (!existing) {
      await createSandbox({ name: SANDBOX_NAME, image: IMAGE, command: 'sleep infinity' });
    }
    const detail = (await listSandboxes()).find((item) => item.name === SANDBOX_NAME);
    expect(detail).toBeTruthy();

    // ① 沙箱守护进程的单元里注入了代理环境变量与合并 CA 束
    const unitEnv = sandboxExec('sandbox-acc-proxy', userUid('sandbox-acc-proxy'), [
      'systemctl',
      '--user',
      'show',
      'docker.service',
      '--property=Environment',
      '--value',
    ]);
    expect(unitEnv.code, unitEnv.stderr).toBe(0);
    expect(unitEnv.stdout).toContain('HTTPS_PROXY=http://127.0.0.1:3128');
    expect(unitEnv.stdout).toContain('HTTP_PROXY=http://127.0.0.1:3128');
    expect(unitEnv.stdout).toContain('NO_PROXY=');
    expect(unitEnv.stdout).toContain('SSL_CERT_FILE=');

    // ② 代理日志的行数基线
    const before = run('docker', ['logs', PROXY_CONTAINER]).stdout.split('\n').length;

    // ③ 沙箱容器内拉一个外部小镜像（经沙箱守护进程，守护进程带代理环境变量）
    const pull = sandboxExec('sandbox-acc-proxy', userUid('sandbox-acc-proxy'), [
      'docker',
      'exec',
      'sandbox-acc-proxy',
      'docker',
      'pull',
      PULL_IMAGE,
    ]);
    const pullOutput = `${pull.stdout}${pull.stderr}`;
    expect(pullOutput).toMatch(/Pull complete|Status: Downloaded/);

    // ④ 取证：代理的访问日志里有这条拉取，且主机是上游仓库
    await expect
      .poll(
        async () => {
          const logs = run('docker', ['logs', PROXY_CONTAINER]).stdout;
          return logs.split('\n').length;
        },
        { timeout: 60_000, message: '代理访问日志没有新增记录' },
      )
      .toBeGreaterThan(before);
    const logs = run('docker', ['logs', PROXY_CONTAINER]).stdout;
    const lines = logs.split('\n').filter((line) => line.includes('/v2/library/busybox/'));
    expect(lines.length, '代理访问日志里没有 busybox 的拉取记录').toBeGreaterThan(0);
    expect(lines.some((line) => line.includes('"host":"registry-1.docker.io"'))).toBe(true);
    expect(lines.some((line) => line.includes('"upstream_cache_status":"HIT"'))).toBe(true);
  });

  test('服务只监听回环地址、接口要令牌、不暴露接口文档', async ({ page }) => {
    const { port } = readFixtures();

    // ① 监听地址：只有回环，没有 0.0.0.0
    const listening = run('ss', ['-ltnp']).stdout;
    const own = listening.split('\n').filter((line) => line.includes(`:${port}`));
    expect(own.length, `没有找到监听 ${port} 的套接字`).toBeGreaterThan(0);
    for (const line of own) {
      expect(line, `服务监听在非回环地址上：${line}`).toContain('127.0.0.1');
    }

    // ② 令牌是准入门槛：不带凭据拿不到数据（401），带令牌才拿得到
    //    （三期起全部 `/api` 生效令牌认证，`/api/health` 不豁免）
    const anonymous = await page.request.get(`${backendBaseUrl()}/api/sandboxes`);
    expect(anonymous.status()).toBe(401);
    const anonymousBody = (await anonymous.json()) as { detail?: string };
    expect(anonymousBody.detail ?? '').toBe(AUTH_FAILED_DETAIL);

    const response = await page.request.get(`${backendBaseUrl()}/api/sandboxes`, {
      headers: authHeaders(),
    });
    expect(response.status()).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
    expect((await health()).status).toBe('ok');

    // ③ 不暴露接口清单：默认不开 /docs 与 /openapi.json
    expect((await page.request.get(`${backendBaseUrl()}/docs`)).status()).toBe(404);
    expect((await page.request.get(`${backendBaseUrl()}/openapi.json`)).status()).toBe(404);

    // ④ 后端只提供 /api：根路径与静态资源路径一律 404（前端由独立静态源托管）
    const root = await page.request.get(`${backendBaseUrl()}/`);
    expect(root.status(), '后端根路径不该返回页面').toBe(404);
    expect((await root.text()).toLowerCase(), '后端根路径不该吐 HTML').not.toContain('<html');

    const asset = await page.request.get(`${backendBaseUrl()}/assets/whatever.js`);
    expect(asset.status(), '后端不该提供静态资源').toBe(404);

    // ⑤ **正向对照**：静态源根确实出页面（防上面两条负向断言恒绿——
    //    「后端返回 404」也可能只是「静态源压根没起」造成的）
    const staticRoot = await page.request.get(staticBaseUrl());
    expect(staticRoot.status(), '静态源根路径该出页面').toBe(200);
    expect(await staticRoot.text(), '静态源根页面不该缺 page-layout-title').toContain(
      'page-layout-title',
    );

    // ⑥ 页面照常进沙箱详情（页面 origin 已是静态源，与后端**不同源**）
    await gotoDetail(page, SANDBOX_NAME);
    await expect(page.getByTestId('page-sandbox-detail-title')).toBeVisible();
  });
});
