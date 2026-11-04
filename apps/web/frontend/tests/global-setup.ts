/**
 * 验收全局准备：同步 Python 工作区环境 → 构建前端产物 → 构建本地专属测试镜像 → 拉起控制台服务 → 清理残留沙箱。
 *
 * 产出的运行期信息（端口、测试镜像引用）落在 `.runtime/fixtures.json`，
 * 供各用例文件读取（Playwright 的 global setup 与用例不在同一个进程里）。
 *
 * 另外按**服务实际端口**写一份 `.runtime/storage-state.json`：
 * 预置页面侧的连接配置（令牌 + 基址），用例打开页面就直接在工作台里
 * （口径见 `helpers/connection.ts`）。
 * 写之前做**交叉断言**：这个端口必须与验收配置（`playwright.config.ts` 的
 * `CONSOLE_TEST_PORT`）一致，不一致直接抛错——storageState 按 origin 注入，
 * 端口对不上时浏览器不会注入那份预置，页面会静默落回「未配置」态。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildLocalOnlyImage, type BuiltImage } from './helpers/image';
import { APPS_DIR, CONSOLE_DIR, RUNTIME_DIR } from './helpers/paths';
import { writeStorageState } from './helpers/connection';
import { DEFAULT_PORT, startConsoleServer } from './helpers/server';
import { cleanupLeftoverSandboxes, cleanupTerminalSessions } from './helpers/sandbox';
import { CONSOLE_TEST_PORT } from './playwright.config';

export const FIXTURES_FILE = path.join(RUNTIME_DIR, 'fixtures.json');

export interface Fixtures {
  port: number;
  host: string;
  localImage: BuiltImage;
}

/**
 * 同步 Python 工作区环境（等价于 `cd apps && uv sync --all-packages --all-groups`）。
 *
 * 工作区两个成员（核心包、服务端包）共用同一个虚拟环境，按成员同步是
 * 精确对齐的（只同步一边会把另一边的依赖剪掉），两个成员来回跑就互相剪。
 * 这里一次性把两个成员的运行与测试依赖都装齐，后续取解释器一律加 `--no-sync`。
 */
function syncPythonWorkspace(): void {
  const result = spawnSync('uv', ['sync', '--all-packages', '--all-groups'], {
    cwd: APPS_DIR,
    encoding: 'utf-8',
    timeout: 600_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `同步 Python 工作区环境失败（退出码 ${result.status}）：${result.stderr || result.stdout}`,
    );
  }
}

/** 构建前端产物（`dist` 由后端在 `/` 路径托管）。 */
function buildConsoleFrontend(): void {
  const result = spawnSync('pnpm', ['run', 'build'], {
    cwd: CONSOLE_DIR,
    encoding: 'utf-8',
    timeout: 600_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `构建前端产物失败（退出码 ${result.status}）：${result.stderr || result.stdout}`,
    );
  }
}

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  syncPythonWorkspace();
  buildConsoleFrontend();

  const localImage = buildLocalOnlyImage();

  // 上一轮残留的验收沙箱先清掉：平台按名字独占资源，残留会让创建直接失败
  await cleanupLeftoverSandboxes();
  // 上一轮遗留的终端会话记录一并清掉（服务启动时也会统一清理，这里先收干净）
  cleanupTerminalSessions();

  const runtime = await startConsoleServer(DEFAULT_PORT);

  // **交叉断言**：写入 storageState 的端口必须与验收配置（playwright.config）的
  // `CONSOLE_TEST_PORT` 一致，不一致直接抛错。
  // 为什么这条不能省：storageState 的 localStorage 是按 **origin** 注入的
  // （键是 `http://127.0.0.1:<端口>`），端口对不上时浏览器**不会**注入这份预置
  // ——页面会落回「未配置」态（引导面板），工作台整片不挂载，既有用例全红，
  // 而报错现场（引导面板没出现）跟「端口写错了」根本看不出来。
  if (runtime.port !== CONSOLE_TEST_PORT) {
    throw new Error(
      `预置端口与验收配置端口不一致：服务实际端口 ${runtime.port}，` +
        `playwright.config 的 CONSOLE_TEST_PORT 是 ${CONSOLE_TEST_PORT}。` +
        `storageState 的 origin 键对不上，浏览器不会注入这份预置` +
        `（页面会落回「未配置」态，既有用例整片变红）。`,
    );
  }

  const fixtures: Fixtures = {
    port: runtime.port,
    host: runtime.host,
    localImage,
  };
  fs.writeFileSync(FIXTURES_FILE, JSON.stringify(fixtures, null, 2), 'utf-8');

  // 预置页面侧的连接配置：基址指向**服务实际监听的地址**，令牌是固定测试令牌。
  // 写在这里（服务起来之后）是因为端口要以实际值为准。
  writeStorageState(runtime.port);
}
