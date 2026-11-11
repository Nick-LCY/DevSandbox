/**
 * 网页控制台端到端验收配置。
 *
 * 全部用例跑在真实浏览器里，驱动真实的控制台服务与真实的沙箱：
 * 每一步都有可判定的断言，失败自动留截图与 trace，退出码即判定结果。
 *
 * 一条命令跑完：
 *   cd apps/web/frontend && pnpm run test:acceptance
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

import { STORAGE_STATE_FILE } from './helpers/paths';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.join(HERE, 'artifacts');

/**
 * 验收服务的端口（默认 8100；宿主 8000 端口被无关进程占用）。
 *
 * 这是**验收配置侧的口径**：预置连接配置的**后端基址**按它算。
 * `global-setup.ts` 起服务后会拿实际端口与它做**交叉断言**——
 * 两边对不上时直接抛错（storageState 的 origin 键对不上，浏览器不会注入
 * 那份预置，页面会落回「未配置」态，既有用例整片变红且报错现场难懂）。
 */
export const CONSOLE_TEST_PORT = Number(process.env.CONSOLE_TEST_PORT ?? '8100');

/**
 * 静态源的端口（默认 8200；与后端的 8100 **刻意错开**）。
 *
 * 后端只提供 `/api`、不托管前端，前端产物由独立静态源伺服（生产形态：
 * Cloudflare Workers 独立托管前端）。页面基址按它算，**与后端不同源**——
 * 这正是要验的形态：页面在静态源上，接口在另一个 origin 上。
 *
 * `--strictPort` 是硬要求：静默换端口会毁掉这里的 origin。
 */
export const CONSOLE_STATIC_PORT = Number(process.env.CONSOLE_STATIC_PORT ?? '8200');

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
    // 页面基址 = **静态源**（后端只提供 /api，不托管前端）。
    baseURL: `http://127.0.0.1:${CONSOLE_STATIC_PORT}`,
    // 预置连接配置：页面一打开就是「已配置」态，直接进工作台。
    // 三期起未配置（令牌为空）时整页是引导面板、工作台不挂载——既有 9 条用例
    // 假定自己就在工作台里，所以这里按测试服务的实际端口预置一份
    // `{backendBaseUrl, token}`（口径见 `helpers/connection.ts`）。
    // 文件由 `global-setup.ts` 在服务起来之后写（端口取实际值）。
    // **负向用例用 `addInitScript` 覆盖这份预置**：`seedConnection` /
    // `clearConnection` 在页面脚本运行前改写 localStorage，用来构造
    // 「未配置」与「指定令牌」两种态（不碰这份预置文件本身）。
    //
    // **storageState 的 origin 键 = 静态源**（页面 localStorage 注入的依据），
    // 而预置内容里的 `backendBaseUrl` = 后端地址（另一个 origin）：两者刻意不同源。
    storageState: STORAGE_STATE_FILE,
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
