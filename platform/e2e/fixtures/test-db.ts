/**
 * 每用例独立数据库 fixture。
 *
 * 作用域是「每用例一库」：每个用例独占一个库，库名带用例标识
 * （用例 ID + 运行编号），由 `tools/new-test-db.sh` 以模板库克隆得到，
 * 用例结束后销毁。同一 worker 上的多个用例互不共享库，
 * 并行 worker 之间的库名也不同、互不影响。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { test as base, expect } from '@playwright/test';

import { artifactsDir, databaseUrl, e2eRoot, loadDependencies, testDatabasePrefix } from '../helpers/config';

/** 一个用例库。 */
export interface TestDatabase {
  /** 库名（每用例唯一，带用例标识）。 */
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

/** 用例库名：前缀 + 用例标识（用例 ID）+ 运行编号。 */
export function testDatabaseName(testId: string, token: string = runToken()): string {
  return `${testDatabasePrefix()}t${testId}_${token}`;
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

// testDb 声明在第一个类型参数里（用例级 fixture），第三个参数才是 testInfo；
// 声明在第二个类型参数里会被当成 worker 级 fixture，第三个参数是 workerInfo。
export const test = base.extend<{ testDb: TestDatabase }, {}>({
  testDb: [
    async ({}, use, testInfo) => {
      const dependencies = loadDependencies();
      const name = testDatabaseName(testInfo.testId);
      console.log(
        `[用例数据库] 用例=${testInfo.title} 标识=${testInfo.testId} worker=${testInfo.workerIndex} pid=${process.pid} 库名=${name}`,
      );
      runDbTool('create', name);
      recordUsage({
        testId: testInfo.testId,
        title: testInfo.title,
        worker: testInfo.workerIndex,
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
          testId: testInfo.testId,
          title: testInfo.title,
          worker: testInfo.workerIndex,
          pid: process.pid,
          database: name,
          event: 'dropped',
          ts: new Date().toISOString(),
        });
        console.log(`[用例数据库] 已销毁 ${name}`);
      }
    },
    { scope: 'test' },
  ],
});

export { expect };
