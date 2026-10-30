/**
 * 外部挂载目录的准备与指纹核对。
 *
 * 用户声明挂载的宿主目录由用户自己管理：平台不创建、不删除、不修改。
 * 验收要证明的就是「删除沙箱前后，这个目录原样存在、内容一字未变」。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Workspace {
  /** 宿主目录路径。 */
  path: string;
  /** 容器内路径。 */
  containerPath: string;
  /** 建目录时写入的标记文件内容。 */
  marker: string;
}

/** 目录内容指纹：文件清单 + 每个文件内容的摘要，按路径排序后取摘要。 */
export function fingerprintDir(dir: string): string {
  const hash = crypto.createHash('sha256');
  const entries: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, item.name);
      const relative = `${prefix}/${item.name}`;
      if (item.isDirectory()) {
        entries.push(`d ${relative}`);
        walk(full, relative);
      } else if (item.isFile()) {
        const content = fs.readFileSync(full);
        entries.push(`f ${relative} ${crypto.createHash('sha256').update(content).digest('hex')}`);
      }
    }
  };
  walk(dir, '');
  for (const entry of entries) {
    hash.update(entry);
    hash.update('\n');
  }
  return hash.digest('hex');
}

/** 建一个外部挂载目录，写入标记文件并记录初始指纹。 */
export function createWorkspace(containerPath = '/workspace'): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-acceptance-mount-'));
  fs.chmodSync(dir, 0o777);
  const marker = `console-acceptance-${Date.now()}`;
  fs.writeFileSync(path.join(dir, 'marker.txt'), `${marker}\n`, 'utf-8');
  fs.chmodSync(path.join(dir, 'marker.txt'), 0o666);
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
  fs.chmodSync(path.join(dir, 'nested'), 0o777);
  fs.writeFileSync(path.join(dir, 'nested', 'data.bin'), 'nested-content\n', 'utf-8');
  fs.chmodSync(path.join(dir, 'nested', 'data.bin'), 0o666);
  return { path: dir, containerPath, marker };
}

/** 删掉外部挂载目录（验收收尾清理）。 */
export function removeWorkspace(workspace: Workspace): void {
  fs.rmSync(workspace.path, { recursive: true, force: true });
}
