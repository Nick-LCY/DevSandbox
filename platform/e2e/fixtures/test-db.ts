/**
 * 每用例独立数据库 fixture。
 *
 * 每个 worker 独占一个用例库：用 worker 序号 + 运行编号命名，
 * 由 `tools/new-test-db.sh` 以模板库克隆得到，用例结束后销毁。
 * 并行 worker 之间的库名不同、互不影响。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { test as base, expect } from '@playwright/test';

import { artifactsDir, databaseUrl, e2eRoot, loadDependencies, testDatabasePrefix } from '../helpers/config';

/** 一个用例库。 */
export interface TestDatabase {
  /** 库名（并行隔离的佐证）。 */
  name: string;
  /** 该库的连接串。 */
  url: string;
}

/** 运行编号：优先取全局 setup 写入的环境变量，取不到就本地生成。 */
export function runToken(): string {
  const runId = process.env.E2E_RUN_ID;
  if (runId) return runId.replace(/^run_/, '');
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 调 `tools/new-test-db.sh`。 */
export function runDbTool(action: 'create' | 'drop', database: string): string {
  const script = path.join(e2eRoot(), 'tools', 'new-test-db.sh');
  const result = spawnSync('bash', [script, action, database], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `new-test-db.sh ${action} ${database} 失败（退出码 ${result.status}）：${result.stderr || result.stdout}`,
    );
  }
  return (result.stdout || '').trim();
}

/** 把库使用情况追加到产物目录，作为并行隔离的日志佐证。 */
function recordUsage(entry: Record<string, unknown>): void {
  const dir = artifactsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'db-usage.log'), `${JSON.stringify(entry)}\n`);
}

export const test = base.extend<{}, { testDb: TestDatabase }>({
  testDb: [
    async ({}, use, workerInfo) => {
      const dependencies = loadDependencies();
      const name = `${testDatabasePrefix()}w${workerInfo.workerIndex}_${runToken()}`;
      console.log(`[用例数据库] worker=${workerInfo.workerIndex} pid=${process.pid} 库名=${name}`);
      runDbTool('create', name);
      recordUsage({
        worker: workerInfo.workerIndex,
        pid: process.pid,
        database: name,
        event: 'created',
        ts: new Date().toISOString(),
      });
      const database: TestDatabase = { name, url: databaseUrl(dependencies, name) };
      try {
        await use(database);
      } finally {
        runDbTool('drop', name);
        recordUsage({
          worker: workerInfo.workerIndex,
          pid: process.pid,
          database: name,
          event: 'dropped',
          ts: new Date().toISOString(),
        });
        console.log(`[用例数据库] worker=${workerInfo.workerIndex} 已销毁 ${name}`);
      }
    },
    { scope: 'worker' },
  ],
});

export { expect };
