/**
 * 页面侧的连接配置预置。
 *
 * 三期起页面走「连接配置」（`src/lib/connection.ts`）：**令牌为空 = 未配置**，
 * 未配置时不挂载工作台、整页是引导面板（`page-connection-setup`）。
 * 验收套件要在 token 模式下继续跑既有用例，就不能让人工去点引导面板——
 * 所以页面一打开就处于「已配置」态。
 *
 * 口径（与前端 `src/lib/connection.ts` 一一对应）：
 * - 存储键 `sandbox-console-connection`，值是 `{backendBaseUrl, token}`；
 * - **基址恒非空**（ADR 0015 决策 D：「空 = 同源」语义已废除）：
 *   这里写测试服务的**实际地址** `http://127.0.0.1:<测试端口>`，
 *   不写空串、也不写产品默认的 `http://127.0.0.1:8000`（宿主 8000 被无关进程占用）；
 * - 令牌用 `helpers/auth.ts` 的固定测试令牌（与服务进程注入的是同一份）。
 *
 * 预置方式有两条，本文件都提供：
 * - **`storageState` 预置**（既有 9 条用例走这条）：`global-setup.ts` 按**静态源**
 *   的 origin 与**后端**的实际端口写一份 storageState 文件，
 *   `playwright.config.ts` 的 `use.storageState` 读它——页面一打开就已配置，
 *   既有用例直接进工作台，不用在每条用例里多写一步「先配置再操作」；
 * - **运行期注入**（负向用例走这条）：`seedConnection` / `clearConnection`
 *   用 `addInitScript` 在页面脚本运行前写 / 删 localStorage，
 *   用来构造「未配置」与「指定令牌」两种态。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { TEST_TOKEN } from './auth';
import { STORAGE_STATE_FILE } from './paths';

/** 连接配置的存储键（与前端 `CONNECTION_STORAGE_KEY` 对齐）。 */
export const CONNECTION_STORAGE_KEY = 'sandbox-console-connection';

/** 连接配置（与前端 `ConnectionConfig` 同形）。 */
export interface ConnectionConfig {
  /** 后端基址（**恒非空**：指向测试服务的实际地址）。 */
  backendBaseUrl: string;
  /** 访问令牌（空串 = 未配置）。 */
  token: string;
}

/**
 * 按端口生成一份连接配置。
 *
 * 基址指向**测试服务的实际地址**（端口由 `global-setup` 起服务时确定），
 * 令牌用固定测试令牌。
 */
export function connectionConfig(port: number): ConnectionConfig {
  return {
    backendBaseUrl: `http://127.0.0.1:${port}`,
    token: TEST_TOKEN,
  };
}

/**
 * 写预置用的 storageState 文件（`playwright.config.ts` 的 `use.storageState` 读它）。
 *
 * **两个 origin 刻意不同源**：
 * - `pageOrigin` = **静态源**（页面所在处）：storageState 的 localStorage
 *   是按 origin 注入的，这个键必须与 `baseURL` 的 origin 一致，否则浏览器
 *   **不注入**这份预置（页面静默落回「未配置」态）；
 * - `backendPort` = **后端**：预置内容里的 `backendBaseUrl` 指向它
 *   （页面在静态源上，接口在另一个 origin 上——这正是生产形态）。
 *
 * 后端端口取服务起来之后的**实际端口**（不是猜的默认值）：预置的基址必须与
 * 服务实际监听的地址一致，否则页面会去连一台不存在的后端。
 */
export function writeStorageState(options: { pageOrigin: string; backendPort: number }): string {
  const { pageOrigin, backendPort } = options;
  const payload = {
    cookies: [],
    origins: [
      {
        origin: pageOrigin,
        localStorage: [
          {
            name: CONNECTION_STORAGE_KEY,
            value: JSON.stringify(connectionConfig(backendPort)),
          },
        ],
      },
    ],
  };
  fs.mkdirSync(path.dirname(STORAGE_STATE_FILE), { recursive: true });
  fs.writeFileSync(STORAGE_STATE_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  return STORAGE_STATE_FILE;
}

/**
 * 往页面里塞一份连接配置（覆盖 storageState 预置）。
 *
 * 用 `addInitScript`：页面脚本运行前就写好 localStorage，
 * 前端首次读存储时拿到的就是这份配置（工作台直接挂载）。
 */
export async function seedConnection(page: Page, config: ConnectionConfig): Promise<void> {
  await page.addInitScript(
    (payload: { key: string; value: string }) => {
      try {
        window.localStorage.setItem(payload.key, payload.value);
      } catch {
        // 存储不可用（隐私模式等）：忽略，交给用例自己的断言去判红。
      }
    },
    { key: CONNECTION_STORAGE_KEY, value: JSON.stringify(config) },
  );
}

/**
 * 清掉页面里的连接配置（构造「未配置」态）。
 *
 * 同样走 `addInitScript`：每次导航前都清一次，页面读到的存储是空的。
 */
export async function clearConnection(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // 忽略：存储不可用时页面本来就是「未配置」态。
    }
  }, CONNECTION_STORAGE_KEY);
}
