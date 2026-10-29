import { databaseUrl, loadDependencies, testDatabasePrefix } from '../../helpers/config';
import { seedFingerprint, withClient } from '../../helpers/postgres';
import { runDbTool, test, expect } from '../../fixtures/test-db';

/** 期望的种子行数（与 seeds/v1.sql、seeds/v2.sql 对齐）。 */
const EXPECTED_ITEM_COUNT = 5;
const EXPECTED_RECORD_COUNT = 2;
const EXPECTED_VERSION = 'v1,v2';

test.describe('用例隔离与种子一致性', () => {
  test('两个用例库库名不同、互不影响；同一版本种子在任何用例库结果一致', async ({ testDb }, testInfo) => {
    const dependencies = loadDependencies();
    console.log(`[用例] 用例库=${testDb.name} worker=${testInfo.workerIndex}`);

    // ① 库名带 worker 序号：并行 worker 之间库名必然不同
    expect(testDb.name).toMatch(new RegExp(`^${testDatabasePrefix()}w\\d+_`));

    // ② 种子行数与版本（行数校验佐证）
    const fingerprintA = await seedFingerprint(testDb.url);
    expect(fingerprintA.metaCount).toBe(2);
    expect(fingerprintA.metaVersions).toBe(EXPECTED_VERSION);
    expect(fingerprintA.itemCount).toBe(EXPECTED_ITEM_COUNT);
    expect(fingerprintA.recordCount).toBe(EXPECTED_RECORD_COUNT);

    // ③ 再克隆一个库，比对「同一版本在任何用例库载入结果一致」
    const peer = `${testDatabasePrefix()}peer_${testInfo.workerIndex}_${Date.now().toString(36)}`;
    runDbTool('create', peer);
    try {
      const peerUrl = databaseUrl(dependencies, peer);
      const fingerprintB = await seedFingerprint(peerUrl);
      expect(fingerprintB.itemCount).toBe(fingerprintA.itemCount);
      expect(fingerprintB.itemHash).toBe(fingerprintA.itemHash);
      expect(fingerprintB.recordCount).toBe(fingerprintA.recordCount);
      expect(fingerprintB.recordHash).toBe(fingerprintA.recordHash);
      expect(fingerprintB.metaVersions).toBe(fingerprintA.metaVersions);
      expect(peer).not.toBe(testDb.name);

      // ④ 在自己的库里写一行标记，peer 库必须看不到
      const markerId = 900001;
      await withClient(testDb.url, async (client) => {
        await client.query(
          'INSERT INTO seed_items(id, name, price_cents) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
          [markerId, `marker-${testDb.name}`, 1],
        );
      });
      const peerRows = await withClient(peerUrl, async (client) => {
        const result = await client.query('SELECT id FROM seed_items WHERE id = $1', [markerId]);
        return result.rows;
      });
      expect(peerRows).toHaveLength(0);
      console.log(`[用例] 隔离校验通过：本用例库=${testDb.name}，对照库=${peer}`);
    } finally {
      runDbTool('drop', peer);
    }
  });
});
