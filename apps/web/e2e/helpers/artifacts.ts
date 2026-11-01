import fs from 'node:fs';
import path from 'node:path';

import type { TestInfo } from '@playwright/test';

import { artifactsDir } from './config';

/** 截图落盘路径（产物目录在用户声明挂载的代码目录内）。 */
export function screenshotPath(testInfo: TestInfo, label: string): string {
  const dir = path.join(artifactsDir(), 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${label}-${testInfo.project.name}-w${testInfo.workerIndex}-${testInfo.testId.slice(0, 8)}.png`);
}
