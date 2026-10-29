/**
 * 健康检查门禁 —— 全局 setup。
 *
 * 顺序固定，不可调换：
 *   ① 等待依赖健康（每个依赖有明确判据，单依赖等待上限 120 秒）
 *   ② 执行数据库迁移（迁移进模板库）
 *   ③ 载入种子数据（种进模板库）
 * 三步全过才允许开始跑用例；任一步失败立即整体失败，并打印失败依赖名与判据。
 *
 * 模板库是每用例独立数据库的克隆源：用例库由 `CREATE DATABASE ... TEMPLATE ...` 得到。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  adminUrl,
  artifactsDir,
  databaseUrl,
  e2eRoot,
  loadDependencies,
  postgresDependency,
  templateDatabase,
  withDatabase,
  DependencySpec,
} from './helpers/config';
import { checkDependency } from './helpers/health';
import { createDatabase, dropDatabase, withClient } from './helpers/postgres';

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

/** 按文件名排序取 SQL 文件。 */
function sqlFiles(dirName: string): string[] {
  const dir = path.join(e2eRoot(), dirName);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.sql'))
    .sort()
    .map((name) => path.join(dir, name));
}

/** 第 ② 步：重建模板库并执行迁移。 */
async function runMigrations(admin: string, template: string): Promise<void> {
  await dropDatabase(admin, template);
  await createDatabase(admin, template);
  const templateUrl = withDatabase(admin, template);
  const files = sqlFiles('migrations');
  if (files.length === 0) throw new Error('migrations 目录里没有迁移脚本');
  await withClient(templateUrl, async (client) => {
    for (const file of files) {
      await client.query(fs.readFileSync(file, 'utf8'));
      log(`迁移已执行：${path.basename(file)}`);
    }
  });
}

/** 第 ③ 步：载入种子数据。 */
async function loadSeed(admin: string, template: string): Promise<void> {
  const templateUrl = withDatabase(admin, template);
  const files = sqlFiles('seeds');
  if (files.length === 0) throw new Error('seeds 目录里没有种子脚本');
  await withClient(templateUrl, async (client) => {
    for (const file of files) {
      await client.query(fs.readFileSync(file, 'utf8'));
      log(`种子已载入：${path.basename(file)}`);
    }
    const versions = await client.query<{ version: string }>('SELECT version FROM seed_meta ORDER BY version');
    log(`模板库 ${template} 的种子版本：${versions.rows.map((row) => row.version).join(', ') || '（空）'}`);
  });
}

export default async function globalSetup(): Promise<void> {
  const runId = `run_${Date.now().toString(36)}`;
  process.env.E2E_RUN_ID = runId;

  fs.mkdirSync(artifactsDir(), { recursive: true });

  const dependencies = loadDependencies();
  const admin = adminUrl(dependencies);
  const template = templateDatabase();
  const pgDep = postgresDependency(dependencies);

  log(`运行编号 ${runId}；模板库 ${template}；依赖 ${dependencies.map((d) => d.name).join('、')}`);
  log('第 ① 步：等待依赖健康');
  for (const dep of dependencies) {
    await waitForDependency(dep);
  }

  log('第 ② 步：执行数据库迁移');
  await runMigrations(admin, template);

  log('第 ③ 步：载入种子数据');
  await loadSeed(admin, template);

  log(`门禁通过（postgres 连接串 ${pgDep.url}），开始执行用例`);
}
