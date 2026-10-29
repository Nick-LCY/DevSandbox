/**
 * 产物归档 reporter —— 把每条用例的 trace 复制到 `artifacts/traces/`。
 *
 * 原因：Playwright 每次运行都会清空 `outputDir`，后一次运行会覆盖前一次运行的 trace。
 * 这里额外留一份按「模式 + 用例」命名的副本，脚本模式与探索模式的 trace 可以同时保留。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

import { artifactsDir } from './config';

function safeName(text: string): string {
  return text.replace(/[^\w.-]+/g, '_').slice(0, 60);
}

export default class TraceArchiveReporter implements Reporter {
  onTestEnd(test: TestCase, result: TestResult): void {
    const trace = result.attachments.find((attachment) => attachment.name === 'trace' && attachment.path);
    if (!trace?.path || !fs.existsSync(trace.path)) return;
    const dir = path.join(artifactsDir(), 'traces');
    fs.mkdirSync(dir, { recursive: true });
    const project = test.parent.project()?.name ?? 'unknown';
    const file = path.join(dir, `${project}-${safeName(test.title)}-${test.id}.zip`);
    fs.copyFileSync(trace.path, file);
    console.log(`[产物] trace 已归档：${file}`);
  }

  onEnd(_result: FullResult): void {
    // 判定由 playwright 自身给出，这里不做任何干预。
  }
}
