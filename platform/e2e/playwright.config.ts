/**
 * 端到端测试基建 —— Playwright 配置。
 *
 * 两个 project：
 *   scripted —— 跑 `tests/e2e` 下的脚本化用例，退出码即判定结果（0 = 通过）。
 *   explore  —— 跑 `explore` 目录下的探索会话，trace 全开、产出截图与 trace，
 *               退出码恒为 0，不参与判定。
 *
 * 两种模式都能用单条命令单独执行：
 *   pnpm run test:scripted
 *   pnpm run test:explore
 *
 * 产物（截图、trace、报告）一律落在用户声明挂载的代码目录 `artifacts/` 下，
 * 不写容器临时层、不上传外部服务。
 */

import { defineConfig, devices } from '@playwright/test';

const APP_URL = process.env.E2E_APP_URL ?? 'http://app:8000';
const ARTIFACTS = 'artifacts';
const WORKERS = Number(process.env.E2E_WORKERS ?? '2');

export default defineConfig({
  // testDir 取基建根目录，两个 project 各自用 testMatch 圈定自己的用例范围。
  testDir: './',
  outputDir: `${ARTIFACTS}/test-results`,
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: WORKERS,
  retries: 0,
  forbidOnly: true,
  reporter: [
    ['list'],
    ['json', { outputFile: `${ARTIFACTS}/results.json` }],
    ['html', { outputFolder: `${ARTIFACTS}/html-report`, open: 'never' }],
    ['./helpers/trace-archive-reporter.ts'],
  ],
  use: {
    baseURL: APP_URL,
    // 产物留存：每条用例都留 trace 与截图（失败用例自动留截图）。
    trace: 'on',
    screenshot: 'on',
    video: 'off',
    actionTimeout: 15_000,
    viewport: { width: 1280, height: 800 },
    // 沙箱内的静态页服务用自签证书；浏览器会对 http:// 导航自动改用 https://，
    // 不放行自签证书就会停在证书错误页上。
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'scripted',
      testMatch: 'tests/e2e/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'explore',
      testMatch: 'explore/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'], trace: 'on', screenshot: 'on' },
    },
  ],
});
