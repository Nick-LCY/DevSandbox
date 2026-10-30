/**
 * 一期命令行 `sandboxctl` 的调用封装。
 *
 * 验收里用它做「网页 vs 命令行」等价性对账：同一套参数分别走网页与命令行，
 * 比对两边产生的状态。
 */

import { spawnSync } from 'node:child_process';

import { CLI_PATH, PLATFORM_DIR } from './paths';
import { platformPython } from './server';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  output: string;
}

/** 跑一次 `sandboxctl`。 */
export function sandboxctl(args: string[]): CliResult {
  const result = spawnSync(platformPython(), [CLI_PATH, ...args], {
    cwd: PLATFORM_DIR,
    encoding: 'utf-8',
    timeout: 900_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

/** 跑一次 `sandboxctl list --json` 并解析。 */
export function sandboxctlList(): Record<string, unknown>[] {
  const result = sandboxctl(['list', '--json']);
  if (result.code !== 0) {
    throw new Error(`sandboxctl list --json 失败（退出码 ${result.code}）：${result.output}`);
  }
  return JSON.parse(result.stdout) as Record<string, unknown>[];
}

/** 取某个沙箱的元数据（命令行口径）。 */
export function sandboxctlMetadata(name: string): Record<string, unknown> | null {
  const items = sandboxctlList();
  const found = items.find((item) => item.name === name);
  return found ?? null;
}
