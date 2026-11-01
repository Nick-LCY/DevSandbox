/**
 * 宿主侧断言辅助。
 *
 * 这些检查不经过平台自己的接口，直接看宿主真实状态：
 * 系统用户、家目录、子 UID/GID 段、守护进程进程、容器、平台元数据。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 跑一条宿主命令。 */
export function run(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** 免密 sudo 跑一条命令。 */
export function sudo(args: string[]): CommandResult {
  return run('sudo', ['-n', ...args]);
}

/** 系统用户是否还在。 */
export function userExists(name: string): boolean {
  return run('id', ['-u', name]).code === 0;
}

/** 系统用户的 uid（不存在返回 -1）。 */
export function userUid(name: string): number {
  const result = run('id', ['-u', name]);
  if (result.code !== 0) {
    return -1;
  }
  const uid = Number.parseInt(result.stdout.trim(), 10);
  return Number.isNaN(uid) ? -1 : uid;
}

/** 宿主目录是否存在。 */
export function dirExists(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `/etc/subuid` 或 `/etc/subgid` 里是否有该用户的条目。 */
export function subidEntryExists(user: string, kind: 'uid' | 'gid'): boolean {
  const file = kind === 'uid' ? '/etc/subuid' : '/etc/subgid';
  const result = sudo(['grep', '-c', `^${user}:`, file]);
  if (result.code !== 0) {
    return false;
  }
  return Number.parseInt(result.stdout.trim(), 10) > 0;
}

/** 某 uid 名下是否还有守护进程（dockerd / containerd 等）。 */
export function daemonProcessesForUid(uid: number): string[] {
  const result = run('ps', ['-u', String(uid), '-o', 'pid=,args=']);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => /dockerd|containerd|rootlesskit|slirp4netns/.test(line));
}

/** 以沙箱用户身份跑一条命令（模拟用户在沙箱守护进程里操作）。 */
export function sandboxExec(
  user: string,
  uid: number,
  args: string[],
): CommandResult {
  return sudo([
    '-u',
    user,
    'env',
    `HOME=/home/${user}`,
    `USER=${user}`,
    `LOGNAME=${user}`,
    `XDG_RUNTIME_DIR=/run/user/${uid}`,
    `DOCKER_HOST=unix:///run/user/${uid}/docker.sock`,
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ...args,
  ]);
}

/** 宿主 root 守护进程里是否有同名容器。 */
export function hostContainerExists(name: string): boolean {
  return run('docker', ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'])
    .stdout.trim()
    .split('\n')
    .filter((line) => line.trim().length > 0).length > 0;
}

/** 沙箱守护进程里某容器的运行状态（`running` / `exited` / 不存在返回空串）。 */
export function sandboxContainerState(user: string, uid: number, container: string): string {
  const result = sandboxExec(user, uid, [
    'docker',
    'inspect',
    '--format',
    '{{.State.Status}}',
    container,
  ]);
  if (result.code !== 0) {
    return '';
  }
  return result.stdout.trim();
}

/** 平台元数据目录是否还在。 */
export function platformMetadataExists(sandboxName: string, home = '/var/lib/sandbox-platform'): boolean {
  return fs.existsSync(`${home}/sandboxes/${sandboxName}`);
}
