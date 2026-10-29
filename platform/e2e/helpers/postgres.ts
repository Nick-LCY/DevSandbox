/**
 * postgres 访问封装。
 *
 * 约定：连接串一律走容器名（沙箱内部网络中由 docker 内置 DNS 解析），
 * 不使用本机回环地址。
 */

import { Client } from 'pg';

/** 打开连接、执行、关闭。 */
export async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** 建库（先强制清掉残留连接再删）。 */
export async function dropDatabase(adminConnectionUrl: string, database: string): Promise<void> {
  await withClient(adminConnectionUrl, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  });
}

/** 建库。 */
export async function createDatabase(adminConnectionUrl: string, database: string): Promise<void> {
  await withClient(adminConnectionUrl, async (client) => {
    await client.query(`CREATE DATABASE "${database}"`);
  });
}

/** 建库并指定模板库。 */
export async function createDatabaseFromTemplate(
  adminConnectionUrl: string,
  database: string,
  template: string,
): Promise<void> {
  await withClient(adminConnectionUrl, async (client) => {
    await client.query(`CREATE DATABASE "${database}" TEMPLATE "${template}"`);
  });
}

/** 列库名。 */
export async function listDatabases(adminConnectionUrl: string, like: string): Promise<string[]> {
  return withClient(adminConnectionUrl, async (client) => {
    const result = await client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname',
      [like],
    );
    return result.rows.map((row) => row.datname);
  });
}

/** 种子指纹：行数 + 内容哈希，用于比对「同一版本在任意用例库载入结果一致」。 */
export interface SeedFingerprint {
  metaCount: number;
  metaVersions: string;
  itemCount: number;
  itemHash: string;
}

export async function seedFingerprint(url: string): Promise<SeedFingerprint> {
  return withClient(url, async (client) => {
    const result = await client.query<SeedFingerprint>(
      `SELECT
         (SELECT count(*)::int FROM seed_meta) AS "metaCount",
         (SELECT coalesce(string_agg(version, ',' ORDER BY version), '') FROM seed_meta) AS "metaVersions",
         (SELECT count(*)::int FROM seed_items) AS "itemCount",
         (SELECT md5(coalesce(string_agg(id::text || ':' || name || ':' || price_cents::text, ',' ORDER BY id), '')) FROM seed_items) AS "itemHash"`,
    );
    return result.rows[0];
  });
}
