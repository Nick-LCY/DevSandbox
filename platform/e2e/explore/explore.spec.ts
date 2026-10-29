import fs from 'node:fs';
import path from 'node:path';

import { test } from '@playwright/test';

import { artifactsDir } from '../helpers/config';

const APP_URL = process.env.E2E_APP_URL ?? 'http://app:8000';

/**
 * 探索会话：agent 现场走查页面时用这个 project。
 *
 * 约定：
 *   - trace 全开、每一步都截图，产物落在 `artifacts/` 下；
 *   - 本 project 不参与判定：不作断言，走查中断只记录不报错；
 *   - 退出码由 `tools/run-explore.sh` 统一压成 0。
 */
test('探索会话：走查样例页并留存截图与 trace', async ({ page }, testInfo) => {
  const dir = path.join(artifactsDir(), 'explore');
  fs.mkdirSync(dir, { recursive: true });
  const shots: string[] = [];

  const capture = async (label: string): Promise<void> => {
    const file = path.join(dir, `${label}.png`);
    await page.screenshot({ path: file, fullPage: true });
    shots.push(file);
    console.log(`[探索] 截图：${file}`);
  };

  try {
    await page.goto(APP_URL);
    await page.getByTestId('page-home-title').waitFor({ state: 'visible' });
    await capture('01-home');

    await page.getByTestId('page-home-summary-text').click();
    await page.getByTestId('page-home-details-body').waitFor({ state: 'visible' });
    await capture('02-details-opened');
  } catch (error) {
    const message = (error as Error).message;
    console.warn(`[探索] 走查中断（探索模式不参与判定）：${message}`);
    testInfo.annotations.push({ type: 'explore-issue', description: message });
    await capture('99-interrupted').catch(() => undefined);
  }

  console.log(`[探索] 本次会话产出截图 ${shots.length} 张；trace 见 artifacts/test-results`);
});
