/**
 * 网页控制台端到端验收配置。
 *
 * 全部用例跑在真实浏览器里，驱动真实的控制台服务与真实的沙箱：
 * 每一步都有可判定的断言，失败自动留截图与 trace，退出码即判定结果。
 *
 * 一条命令跑完：
 *   cd platform/console && pnpm run test:acceptance
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.join(HERE, 'artifacts');
const PORT = Number(process.env.CONSOLE_TEST_PORT ?? '8100');

export default defineConfig({
  testDir: path.join(HERE, 'specs'),
  outputDir: path.join(ARTIFACTS, 'test-results'),
  globalSetup: path.join(HERE, 'global-setup.ts'),
  globalTeardown: path.join(HERE, 'global-teardown.ts'),
  // 真机沙箱操作每次数十秒（创建沙箱约 30 秒，删除约 10 秒），超时给足
  timeout: 600_000,
  expect: { timeout: 30_000 },
  // 用例之间有共享状态（服务进程、沙箱资源、镜像代理），必须串行
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(ARTIFACTS, 'results.json') }],
    ['html', { outputFolder: path.join(ARTIFACTS, 'html-report'), open: 'never' }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // 产物留存：每条用例都留 trace 与截图，失败现场可回溯
    trace: 'on',
    screenshot: 'on',
    video: 'off',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'acceptance',
      testMatch: '**/*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
