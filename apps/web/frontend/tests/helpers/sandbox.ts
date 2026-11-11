/**
 * 验收用沙箱的公共约定：命名、清理、运行期信息读取。
 */

import fs from 'node:fs';
import path from 'node:path';

import { sandboxctl, sandboxctlList } from './cli';
import { RUNTIME_DIR } from './paths';

export const FIXTURES_FILE = path.join(RUNTIME_DIR, 'fixtures.json');

/** 验收沙箱的统一命名前缀：收尾清理只碰这个前缀的沙箱，不动别人的东西。 */
export const SANDBOX_PREFIX = 'acc-';

/** 平台数据根（默认与一期一致）。 */
export function platformHome(): string {
  return (process.env.SANDBOX_PLATFORM_HOME ?? '').trim() || '/var/lib/sandbox-platform';
}

/** 读运行期信息（端口、静态源端口、测试镜像）。 */
export function readFixtures(): {
  port: number;
  host: string;
  /** 静态源端口（页面基址所在处，与后端不同源）。 */
  staticPort: number;
  localImage: {
    reference: string;
    imageId: string;
    sizeBytes: number;
    buildMs: number;
    manifestProbe: string;
  };
} {
  if (!fs.existsSync(FIXTURES_FILE)) {
    throw new Error(`读不到运行期信息：${FIXTURES_FILE} 不存在`);
  }
  return JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf-8'));
}

/** 静态源基址（页面所在处：前端产物由它伺服，后端只提供 `/api`）。 */
export function staticBaseUrl(): string {
  const { staticPort } = readFixtures();
  return `http://127.0.0.1:${staticPort}`;
}

/** 删掉所有验收前缀的残留沙箱。 */
export async function cleanupLeftoverSandboxes(): Promise<string[]> {
  const removed: string[] = [];
  let items: Record<string, unknown>[] = [];
  try {
    items = sandboxctlList();
  } catch {
    return removed;
  }
  for (const item of items) {
    const name = String(item.name ?? '');
    if (!name.startsWith(SANDBOX_PREFIX)) {
      continue;
    }
    const result = sandboxctl(['delete', name, '--yes']);
    if (result.code === 0) {
      removed.push(name);
    }
  }
  return removed;
}

/**
 * 删掉验收沙箱遗留的终端会话记录。
 *
 * 会话表是持久化数据：服务正常退出时记录会留在表里（设计如此——服务启动时
 * 才统一把遗留记录标记为孤儿并清理）。验收收尾要把本轮产生的记录删干净，
 * 只删归属验收沙箱的记录，不碰别人的。
 */
export function cleanupTerminalSessions(): string[] {
  const directory = path.join(platformHome(), 'terminal-sessions');
  if (!fs.existsSync(directory)) {
    return [];
  }
  const removed: string[] = [];
  for (const file of fs.readdirSync(directory)) {
    if (!file.endsWith('.json')) {
      continue;
    }
    const full = path.join(directory, file);
    try {
      const record = JSON.parse(fs.readFileSync(full, 'utf-8')) as { sandbox_name?: string };
      const owner = String(record.sandbox_name ?? '');
      if (!owner.startsWith(SANDBOX_PREFIX)) {
        continue;
      }
      fs.rmSync(full, { force: true });
      removed.push(file);
    } catch {
      // 读不出来就跳过：记录损坏不该挡住收尾
    }
  }
  return removed;
}
