/**
 * 运行期文件传输的纯逻辑：路径、文件名解析、格式化、排序、图标映射与进度。
 *
 * 这些口径直接决定面板怎么显示，逐条钉死；组件层只负责画。
 */
import { describe, expect, it } from 'vitest';

import type { FileListEntry } from '../api/types';
import { FILE_ICON_URLS } from './file-icon-assets';
import {
  EXT_ICON,
  FOLDER_ICON,
  NAME_ICON,
  childContainerPath,
  formatFileMtime,
  formatFileSize,
  isAbsoluteContainerPath,
  joinContainerPath,
  normalizeContainerPath,
  parentContainerPath,
  parseContentDispositionFilename,
  resolveEntryIcon,
  resolveFileIconName,
  resolveFolderIconName,
  sortFileEntries,
  splitContainerPath,
  transferPercent,
} from './file-transfer';

function entry(overrides: Partial<FileListEntry>): FileListEntry {
  return {
    name: 'a.txt',
    kind: 'file',
    size: 10,
    mtime: 1_700_000_000,
    ...overrides,
  };
}

describe('容器内路径', () => {
  it('归一化绝对路径：折叠多余斜杠、去掉尾部斜杠', () => {
    expect(normalizeContainerPath('/home//acc-demo/')).toBe('/home/acc-demo');
    expect(normalizeContainerPath('/')).toBe('/');
  });

  it('保留条目名尾随空白（名称保真），只吃整串的前导空白', () => {
    expect(normalizeContainerPath('/home/logs ')).toBe('/home/logs ');
    expect(normalizeContainerPath('/home/logs\n')).toBe('/home/logs\n');
    expect(normalizeContainerPath('  /home/acc-demo')).toBe('/home/acc-demo');
    expect(splitContainerPath('/home/logs ')).toEqual(['home', 'logs ']);
    expect(childContainerPath('/home', 'logs ')).toBe('/home/logs ');
    expect(joinContainerPath(['home', 'logs '])).toBe('/home/logs ');
  });

  it('拒绝相对路径、空串、NUL 与 . / .. 段', () => {
    expect(normalizeContainerPath('home/acc')).toBeNull();
    expect(normalizeContainerPath('')).toBeNull();
    expect(normalizeContainerPath('/a\0b')).toBeNull();
    expect(normalizeContainerPath('/a/../b')).toBeNull();
    expect(normalizeContainerPath('/a/./b')).toBeNull();
    expect(isAbsoluteContainerPath('/ok')).toBe(true);
    expect(isAbsoluteContainerPath('nope')).toBe(false);
  });

  it('拆分 / 拼接 / 子路径 / 上级路径', () => {
    expect(splitContainerPath('/home/acc-demo')).toEqual(['home', 'acc-demo']);
    expect(splitContainerPath('/')).toEqual([]);
    expect(joinContainerPath([])).toBe('/');
    expect(joinContainerPath(['home', 'acc-demo'])).toBe('/home/acc-demo');
    expect(childContainerPath('/home/acc-demo', 'a.txt')).toBe('/home/acc-demo/a.txt');
    expect(childContainerPath('/', 'a.txt')).toBe('/a.txt');
    expect(parentContainerPath('/home/acc-demo')).toBe('/home');
    expect(parentContainerPath('/')).toBe('/');
  });

  it('子路径拒绝带斜杠 / NUL / 点段的条目名', () => {
    expect(childContainerPath('/home', 'a/b')).toBeNull();
    expect(childContainerPath('/home', '..')).toBeNull();
    expect(childContainerPath('/home', 'a\0b')).toBeNull();
  });
});

describe('Content-Disposition 文件名解析', () => {
  it('优先 filename*（UTF-8 百分号编码，中文名正确）', () => {
    const header =
      'attachment; filename="____.txt"; filename*=UTF-8\'\'%E4%B8%AD%E6%96%87%20%E5%90%8D.txt';
    expect(parseContentDispositionFilename(header)).toBe('中文 名.txt');
  });

  it('没有 filename* 时退回 ASCII filename（去引号与转义）', () => {
    expect(parseContentDispositionFilename('attachment; filename="a.txt"')).toBe('a.txt');
    expect(parseContentDispositionFilename('attachment; filename=a.txt')).toBe('a.txt');
    expect(parseContentDispositionFilename('attachment; filename="a\\"b.txt"')).toBe('a"b.txt');
  });

  it('空头 / 取不到文件名返回 null', () => {
    expect(parseContentDispositionFilename(null)).toBeNull();
    expect(parseContentDispositionFilename('attachment')).toBeNull();
    expect(parseContentDispositionFilename('attachment; filename=""')).toBeNull();
  });
});

describe('格式化', () => {
  it('文件大小：B / KB / MB / GB，非法值显示占位符', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(1023)).toBe('1023 B');
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.0 GB');
    expect(formatFileSize(-1)).toBe('—');
    expect(formatFileSize(Number.NaN)).toBe('—');
    expect(formatFileSize(null)).toBe('—');
  });

  it('修改时间：Unix 秒 → 本地 YYYY-MM-DD HH:mm；0 / 非法值显示占位符', () => {
    const local = new Date(2026, 10, 9, 1, 2, 3);
    expect(formatFileMtime(local.getTime() / 1000)).toBe('2026-11-09 01:02');
    expect(formatFileMtime(0)).toBe('—');
    expect(formatFileMtime(Number.NaN)).toBe('—');
  });

  it('传输百分比：夹在 0~100；总长度未知返回 null', () => {
    expect(transferPercent(0, 100)).toBe(0);
    expect(transferPercent(50, 100)).toBe(50);
    expect(transferPercent(120, 100)).toBe(100);
    expect(transferPercent(10, null)).toBeNull();
    expect(transferPercent(10, 0)).toBeNull();
  });
});

describe('目录列表排序', () => {
  it('文件夹在前，同类按名称（numeric + 忽略大小写）；隐藏文件照常参与', () => {
    const sorted = sortFileEntries([
      entry({ name: 'b.txt', kind: 'file' }),
      entry({ name: 'alpha', kind: 'dir' }),
      entry({ name: '.env', kind: 'file' }),
      entry({ name: 'zeta', kind: 'dir' }),
      entry({ name: 'a.txt', kind: 'file' }),
    ]);
    expect(sorted.map((item) => item.name)).toEqual(['alpha', 'zeta', '.env', 'a.txt', 'b.txt']);
  });

  it('不修改入参数组', () => {
    const input = [entry({ name: 'b' }), entry({ name: 'a' })];
    sortFileEntries(input);
    expect(input.map((item) => item.name)).toEqual(['b', 'a']);
  });
});

describe('图标映射', () => {
  it('文件名精确匹配优先于扩展名', () => {
    expect(resolveFileIconName('package.json')).toBe('nodejs');
    expect(resolveFileIconName('Dockerfile')).toBe('docker');
    expect(resolveFileIconName('README.md')).toBe('readme');
  });

  it('扩展名映射与特殊前缀', () => {
    expect(resolveFileIconName('app.tsx')).toBe('react_ts');
    expect(resolveFileIconName('main.py')).toBe('python');
    expect(resolveFileIconName('.env.local')).toBe('tune');
    expect(resolveFileIconName('.gitignore')).toBe('git');
    expect(resolveFileIconName('backup.tar.gz')).toBe('zip');
  });

  it('未知扩展名回落通用 file；目录未知回落通用 folder', () => {
    expect(resolveFileIconName('mystery.qqq')).toBe('file');
    expect(resolveFileIconName('no-extension')).toBe('file');
    expect(resolveFolderIconName('src')).toBe('folder-src');
    expect(resolveFolderIconName('whatever')).toBe('folder');
  });

  it('按条目类型解析，并标出是否走了通用兜底', () => {
    expect(resolveEntryIcon(entry({ name: 'src', kind: 'dir' }))).toEqual({
      icon: 'folder-src',
      fallback: false,
    });
    expect(resolveEntryIcon(entry({ name: 'mystery.qqq' }))).toEqual({
      icon: 'file',
      fallback: true,
    });
    expect(resolveEntryIcon(entry({ name: 'things', kind: 'dir' }))).toEqual({
      icon: 'folder',
      fallback: true,
    });
  });

  it('映射名与资产文件双向一致（新增映射漏放 SVG / 多了孤儿资产都会红）', () => {
    const mapped = new Set<string>(['file', 'folder']);
    for (const table of [EXT_ICON, NAME_ICON, FOLDER_ICON]) {
      for (const icon of Object.values(table)) {
        mapped.add(icon);
      }
    }

    expect(Object.keys(FILE_ICON_URLS).sort()).toEqual([...mapped].sort());
  });

  it('映射到的图标资产已 vendor 进本地资产目录（含通用兜底）', () => {
    for (const icon of [
      'typescript',
      'python',
      'folder-src',
      'folder',
      'file',
      'tune',
      'zip',
    ]) {
      expect(FILE_ICON_URLS[icon], `缺少图标资产：${icon}`).toBeTruthy();
    }
  });
});
