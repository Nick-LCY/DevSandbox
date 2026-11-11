/**
 * 验收收尾：停静态源 → 停服务 → 清理残留沙箱 → 删掉测试镜像 → 清运行期目录。
 */

import fs from 'node:fs';

import { removeImage } from './helpers/image';
import { RUNTIME_DIR } from './helpers/paths';
import { readServerRuntime, stopConsoleServer } from './helpers/server';
import { readStaticRuntime, stopStaticServer } from './helpers/static';
import { cleanupLeftoverSandboxes, cleanupTerminalSessions } from './helpers/sandbox';

export default async function globalTeardown(): Promise<void> {
  // 静态源先停（页面还在被用例用着的话会先报连不上——但收尾阶段已经没有了）。
  const staticRuntime = readStaticRuntime();
  if (staticRuntime) {
    await stopStaticServer(staticRuntime).catch(() => undefined);
  }
  const runtime = readServerRuntime();
  if (runtime) {
    await stopConsoleServer(runtime).catch(() => undefined);
  }
  await cleanupLeftoverSandboxes().catch(() => undefined);
  cleanupTerminalSessions();
  const fixturesFile = `${RUNTIME_DIR}/fixtures.json`;
  if (fs.existsSync(fixturesFile)) {
    try {
      const fixtures = JSON.parse(fs.readFileSync(fixturesFile, 'utf-8')) as {
        localImage?: { reference?: string };
      };
      if (fixtures.localImage?.reference) {
        removeImage(fixtures.localImage.reference);
      }
    } catch {
      // 读不到就跳过删镜像：不影响判定
    }
  }
  fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
}
