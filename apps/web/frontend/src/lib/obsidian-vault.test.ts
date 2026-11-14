/**
 * Obsidian vault 纯逻辑：根路径归一、按沙箱存储、树过滤、路径判定。
 *
 * 口径来源：PRD「方案四 · Obsidian tab」+ 任务 06。
 *
 * 存储用内存替身（Node 环境没有 `window`）：逐条钉死「按沙箱隔离」「非法值
 * 回落」「写 null 即清键」「展开态去重 / 排序」。
 */

import { describe, expect, it } from 'vitest';

import type { FileListEntry } from '../api/types';
import {
  OBSIDIAN_VAULT_EXPANDED_STORAGE_PREFIX,
  OBSIDIAN_VAULT_ROOT_STORAGE_PREFIX,
  filterVaultEntries,
  isMarkdownFileName,
  isPathWithinVaultRoot,
  isVaultEntry,
  normalizeVaultRoot,
  readStoredExpandedPaths,
  readStoredVaultRoot,
  vaultChildPath,
  vaultExpandedStorageKey,
  vaultFileName,
  vaultRootStorageKey,
  writeStoredExpandedPaths,
  writeStoredVaultRoot,
} from './obsidian-vault';

/** 内存版 Storage（只实现用到的方法）。 */
class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function entry(overrides: Partial<FileListEntry>): FileListEntry {
  return { name: 'a.md', kind: 'file', size: 10, mtime: 1_700_000_000, ...overrides };
}

describe('vault 根归一', () => {
  it('去空白后必须是绝对路径', () => {
    expect(normalizeVaultRoot('  /home/dev/notes  ')).toBe('/home/dev/notes');
    expect(normalizeVaultRoot('/home/dev/notes/')).toBe('/home/dev/notes');
    expect(normalizeVaultRoot('relative/notes')).toBeNull();
    expect(normalizeVaultRoot('   ')).toBeNull();
    expect(normalizeVaultRoot('')).toBeNull();
    expect(normalizeVaultRoot(null)).toBeNull();
    expect(normalizeVaultRoot(undefined)).toBeNull();
  });

  it('拒 NUL 与 `.` / `..` 段（与文件窗格的路径校验同口径）', () => {
    expect(normalizeVaultRoot('/a/\u0000b')).toBeNull();
    expect(normalizeVaultRoot('/a/./b')).toBeNull();
    expect(normalizeVaultRoot('/a/../b')).toBeNull();
  });
});

describe('存储键：按沙箱记', () => {
  it('根与展开态的键都带沙箱后缀', () => {
    expect(vaultRootStorageKey('demo-1')).toBe(`${OBSIDIAN_VAULT_ROOT_STORAGE_PREFIX}demo-1`);
    expect(vaultExpandedStorageKey('demo-1')).toBe(
      `${OBSIDIAN_VAULT_EXPANDED_STORAGE_PREFIX}demo-1`,
    );
    expect(vaultRootStorageKey('demo-1')).not.toBe(vaultRootStorageKey('demo-2'));
  });
});

describe('vault 根存取', () => {
  it('写进去能读回来，换沙箱各自记忆（互不串）', () => {
    const storage = new MemoryStorage();
    writeStoredVaultRoot('demo-1', '/vault/one', storage);
    writeStoredVaultRoot('demo-2', '/vault/two', storage);

    expect(readStoredVaultRoot('demo-1', storage)).toBe('/vault/one');
    expect(readStoredVaultRoot('demo-2', storage)).toBe('/vault/two');
    expect(readStoredVaultRoot('demo-3', storage)).toBeNull();
  });

  it('写值先归一（尾部斜杠 / 空白不会落盘）', () => {
    const storage = new MemoryStorage();
    writeStoredVaultRoot('demo', '  /vault/notes/ ', storage);
    expect(storage.getItem(vaultRootStorageKey('demo'))).toBe('/vault/notes');
  });

  it('写非法值等于清掉（不留脏值）', () => {
    const storage = new MemoryStorage();
    writeStoredVaultRoot('demo', '/vault', storage);
    writeStoredVaultRoot('demo', 'relative/path', storage);
    expect(readStoredVaultRoot('demo', storage)).toBeNull();
  });

  it('写 null 清键（回引导态、不入存储）', () => {
    const storage = new MemoryStorage();
    writeStoredVaultRoot('demo', '/vault', storage);
    writeStoredVaultRoot('demo', null, storage);
    expect(storage.getItem(vaultRootStorageKey('demo'))).toBeNull();
  });

  it('存量脏值读的时候回落「没有根」', () => {
    const storage = new MemoryStorage();
    storage.setItem(vaultRootStorageKey('demo'), 'not-absolute');
    expect(readStoredVaultRoot('demo', storage)).toBeNull();
  });

  it('存储不可用（隐私模式）时读回落、写静默忽略', () => {
    const broken: Storage = {
      length: 0,
      clear: () => {
        throw new Error('nope');
      },
      getItem: () => {
        throw new Error('nope');
      },
      key: () => null,
      removeItem: () => {
        throw new Error('nope');
      },
      setItem: () => {
        throw new Error('nope');
      },
    };
    expect(readStoredVaultRoot('demo', broken)).toBeNull();
    expect(() => writeStoredVaultRoot('demo', '/vault', broken)).not.toThrow();
    expect(readStoredExpandedPaths('demo', broken)).toEqual([]);
    expect(() => writeStoredExpandedPaths('demo', ['/vault'], broken)).not.toThrow();
  });
});

describe('树展开态存取', () => {
  it('写进去是去重 + 排序后的绝对路径数组', () => {
    const storage = new MemoryStorage();
    writeStoredExpandedPaths('demo', ['/vault/b', '/vault/a', '/vault/b'], storage);
    expect(readStoredExpandedPaths('demo', storage)).toEqual(['/vault/a', '/vault/b']);
    expect(storage.getItem(vaultExpandedStorageKey('demo'))).toBe(
      JSON.stringify(['/vault/a', '/vault/b']),
    );
  });

  it('非法项被丢掉（非字符串 / 非绝对路径）', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      vaultExpandedStorageKey('demo'),
      JSON.stringify(['/vault/a', 1, 'relative', '/vault/../etc']),
    );
    expect(readStoredExpandedPaths('demo', storage)).toEqual(['/vault/a']);
  });

  it('没存过 / JSON 坏掉 / 不是数组都回落空数组', () => {
    const storage = new MemoryStorage();
    expect(readStoredExpandedPaths('demo', storage)).toEqual([]);

    storage.setItem(vaultExpandedStorageKey('demo'), '{oops');
    expect(readStoredExpandedPaths('demo', storage)).toEqual([]);

    storage.setItem(vaultExpandedStorageKey('demo'), JSON.stringify({ a: 1 }));
    expect(readStoredExpandedPaths('demo', storage)).toEqual([]);
  });

  it('按沙箱隔离', () => {
    const storage = new MemoryStorage();
    writeStoredExpandedPaths('demo-1', ['/vault/a'], storage);
    expect(readStoredExpandedPaths('demo-2', storage)).toEqual([]);
  });
});

describe('树过滤：只列目录与 .md 文件', () => {
  it('目录与 .md 留下，其余扩展名与 special 丢掉', () => {
    const entries = [
      entry({ name: 'notes', kind: 'dir' }),
      entry({ name: 'readme.md' }),
      entry({ name: 'README.MD' }),
      entry({ name: 'todo.txt' }),
      entry({ name: 'pipe', kind: 'special' }),
      entry({ name: 'md' }),
    ];
    expect(filterVaultEntries(entries).map((item) => item.name)).toEqual([
      'notes',
      'readme.md',
      'README.MD',
    ]);
  });

  it('目录在前，同类型按名称自然序（数字按数值比）', () => {
    const entries = [
      entry({ name: 'z.md' }),
      entry({ name: 'dir-10', kind: 'dir' }),
      entry({ name: 'dir-2', kind: 'dir' }),
      entry({ name: 'a.md' }),
      entry({ name: 'B.md' }),
    ];
    expect(filterVaultEntries(entries).map((item) => item.name)).toEqual([
      'dir-2',
      'dir-10',
      'a.md',
      'B.md',
      'z.md',
    ]);
  });

  it('不改原数组（返回新数组）', () => {
    const entries = [entry({ name: 'b.md' }), entry({ name: 'a.md' })];
    const filtered = filterVaultEntries(entries);
    expect(entries.map((item) => item.name)).toEqual(['b.md', 'a.md']);
    expect(filtered).not.toBe(entries);
  });

  it('扩展名判定严格（`.md` 结尾、大小写不敏感）', () => {
    expect(isMarkdownFileName('a.md')).toBe(true);
    expect(isMarkdownFileName('a.Md')).toBe(true);
    expect(isMarkdownFileName('a.md.bak')).toBe(false);
    expect(isMarkdownFileName('md')).toBe(false);
  });

  it('isVaultEntry 逐类判定', () => {
    expect(isVaultEntry(entry({ name: 'dir', kind: 'dir' }))).toBe(true);
    expect(isVaultEntry(entry({ name: 'x.MD', kind: 'file' }))).toBe(true);
    expect(isVaultEntry(entry({ name: 'x.txt', kind: 'file' }))).toBe(false);
    expect(isVaultEntry(entry({ name: 'sock', kind: 'special' }))).toBe(false);
  });
});

describe('路径拼接与根内判定', () => {
  it('子路径 = 父目录 + 条目名', () => {
    expect(vaultChildPath('/vault', 'notes')).toBe('/vault/notes');
    expect(vaultChildPath('/', 'notes')).toBe('/notes');
    expect(vaultChildPath('/vault/', 'a.md')).toBe('/vault/a.md');
  });

  it('条目名里带 `/`、NUL、`.`、`..` 一律跳过', () => {
    expect(vaultChildPath('/vault', 'a/b')).toBeNull();
    expect(vaultChildPath('/vault', 'a\u0000b')).toBeNull();
    expect(vaultChildPath('/vault', '.')).toBeNull();
    expect(vaultChildPath('/vault', '..')).toBeNull();
    expect(vaultChildPath('/vault', '')).toBeNull();
  });

  it('根内判定：根本身与后代为真，同名前缀的兄弟目录为假', () => {
    expect(isPathWithinVaultRoot('/vault', '/vault')).toBe(true);
    expect(isPathWithinVaultRoot('/vault', '/vault/notes')).toBe(true);
    expect(isPathWithinVaultRoot('/vault', '/vault/notes/deep')).toBe(true);
    expect(isPathWithinVaultRoot('/vault', '/vault2/notes')).toBe(false);
    expect(isPathWithinVaultRoot('/vault', '/other')).toBe(false);
    expect(isPathWithinVaultRoot('/', '/anything')).toBe(true);
    expect(isPathWithinVaultRoot('relative', '/anything')).toBe(false);
  });

  it('文件名取路径最后一段', () => {
    expect(vaultFileName('/vault/notes/a.md')).toBe('a.md');
    expect(vaultFileName('/a.md')).toBe('a.md');
    expect(vaultFileName('/')).toBe('/');
  });
});
