/**
 * 全局 teardown：清理残留的用例库与基准库。
 *
 * 正常情况下每个 worker 的 fixture 都会自己删掉自己的库；
 * 这里兜底处理上一轮崩溃留下的残留，避免残留库堆积。
 */

import { adminUrl, loadDependencies, testDatabasePrefix } from './helpers/config';
import { dropDatabase, listDatabases } from './helpers/postgres';

export default async function globalTeardown(): Promise<void> {
  try {
    const dependencies = loadDependencies();
    const admin = adminUrl(dependencies);
    const prefixes = [testDatabasePrefix(), 'e2e_bench_'];
    for (const prefix of prefixes) {
      const leftovers = await listDatabases(admin, `${prefix}%`);
      for (const name of leftovers) {
        await dropDatabase(admin, name);
        console.log(`[清理] 已删除残留用例库 ${name}`);
      }
    }
  } catch (error) {
    console.warn(`[清理] 残留库清理跳过：${(error as Error).message}`);
  }
}
