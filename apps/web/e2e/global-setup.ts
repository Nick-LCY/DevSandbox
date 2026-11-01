/**
 * 健康检查门禁 —— 全局 setup。
 *
 * 单步：等待静态页健康。判据数据驱动（`config/dependencies.json`），
 * 单依赖等待上限 120 秒；判据通过才允许开始跑用例，
 * 失败立即整体失败，并打印失败依赖名与判据。
 */

import fs from 'node:fs';

import { artifactsDir, loadDependencies, DependencySpec } from './helpers/config';
import { checkDependency } from './helpers/health';

/** 单依赖等待上限（毫秒）。 */
const MAX_WAIT_MS = 120_000;

/** 两次探测之间的间隔（毫秒）。 */
const PROBE_INTERVAL_MS = 1_000;

function log(message: string): void {
  console.log(`[门禁] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等待单个依赖满足判据。 */
async function waitForDependency(dep: DependencySpec): Promise<void> {
  const budget = Math.min(dep.timeoutSeconds * 1000, MAX_WAIT_MS);
  const deadline = Date.now() + budget;
  let lastError: Error | undefined;
  let attempt = 0;
  log(`等待依赖「${dep.name}」就绪；判据：${dep.criterion}；上限 ${budget / 1000} 秒`);
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      await checkDependency(dep);
      log(`依赖「${dep.name}」已就绪（第 ${attempt} 次探测通过）`);
      return;
    } catch (error) {
      lastError = error as Error;
      await sleep(PROBE_INTERVAL_MS);
    }
  }
  const reason = lastError ? lastError.message : '未获得任何探测结果';
  throw new Error(
    `依赖「${dep.name}」等待超时；判据：${dep.criterion}；上限 ${budget / 1000} 秒；最后原因：${reason}`,
  );
}

export default async function globalSetup(): Promise<void> {
  const runId = `run_${Date.now().toString(36)}`;
  process.env.E2E_RUN_ID = runId;

  fs.mkdirSync(artifactsDir(), { recursive: true });

  const dependencies = loadDependencies();

  log(`运行编号 ${runId}；依赖 ${dependencies.map((d) => d.name).join('、')}`);
  log('第 ① 步：等待静态页健康');
  for (const dep of dependencies) {
    await waitForDependency(dep);
  }

  log('门禁通过，开始执行用例');
}
