/**
 * 一期命令行 `sandboxctl` 的调用封装。
 *
 * 验收里用它做「网页 vs 命令行」等价性对账：同一套参数分别走网页与命令行，
 * 比对两边产生的状态。
 *
 * 命令行是单文件薄壳、不是工作区成员：用核心包项目（apps/core）的解释器跑它。
 */

import { spawnSync } from 'node:child_process';

import { CLI_PATH, CORE_PROJECT_DIR } from './paths';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  output: string;
}

/** 取核心包项目环境里的 Python 解释器。 */
function cliPython(): string {
  const result = spawnSync(
    'uv',
    ['run', '--project', CORE_PROJECT_DIR, 'python', '-c', 'import sys; print(sys.executable)'],
    { encoding: 'utf-8', cwd: CORE_PROJECT_DIR },
  );
  if (result.status !== 0) {
    throw new Error(
      `取核心包 Python 解释器失败（退出码 ${result.status}）：${result.stderr || result.stdout}`,
    );
  }
  const executable = result.stdout.trim();
  if (!executable) {
    throw new Error('取核心包 Python 解释器失败：输出为空');
  }
  return executable;
}

/** 跑一次 `sandboxctl`。 */
export function sandboxctl(args: string[]): CliResult {
  const result = spawnSync(cliPython(), [CLI_PATH, ...args], {
    cwd: CORE_PROJECT_DIR,
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
