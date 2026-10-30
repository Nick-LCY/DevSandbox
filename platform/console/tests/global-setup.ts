/**
 * 验收全局准备：构建前端产物 → 构建本地专属测试镜像 → 拉起控制台服务 → 清理残留沙箱。
 *
 * 产出的运行期信息（端口、测试镜像引用）落在 `.runtime/fixtures.json`，
 * 供各用例文件读取（Playwright 的 global setup 与用例不在同一个进程里）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildLocalOnlyImage, type BuiltImage } from './helpers/image';
import { CONSOLE_DIR, RUNTIME_DIR } from './helpers/paths';
import { DEFAULT_PORT, startConsoleServer } from './helpers/server';
import { cleanupLeftoverSandboxes, cleanupTerminalSessions } from './helpers/sandbox';

export const FIXTURES_FILE = path.join(RUNTIME_DIR, 'fixtures.json');

export interface Fixtures {
  port: number;
  host: string;
  localImage: BuiltImage;
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
  buildConsoleFrontend();

  const localImage = buildLocalOnlyImage();

  // 上一轮残留的验收沙箱先清掉：平台按名字独占资源，残留会让创建直接失败
  await cleanupLeftoverSandboxes();
  // 上一轮遗留的终端会话记录一并清掉（服务启动时也会统一清理，这里先收干净）
  cleanupTerminalSessions();

  const runtime = await startConsoleServer(DEFAULT_PORT);

  const fixtures: Fixtures = {
    port: runtime.port,
    host: runtime.host,
    localImage,
  };
  fs.writeFileSync(FIXTURES_FILE, JSON.stringify(fixtures, null, 2), 'utf-8');
}
