// @vitest-environment node
/**
 * wikilink 纯逻辑：**语法切分**（三条语法 + 边界）与**三级解析兜底**
 * （同目录 → vault 根相对 → 全库递归同名匹配，带看门狗超时）。
 *
 * 口径来源：PRD「方案四 · Obsidian tab」OBS-08 / OBS-09 + 任务 07。
 * 目录列举全部注入假的 `list`：兜底顺序、超时与归一逐条钉死，不走网络。
 */

import { describe, expect, it, vi } from 'vitest';

import type { FileListEntry } from '../api/types';
import {
  collectWikilinks,
  createWikilinkResolver,
  isSameWikilinkTarget,
  parseWikilink,
  splitWikilinkSegments,
  WIKILINK_WATCHDOG_MS,
  wikilinkFileCandidates,
  type WikilinkParts,
  type WikilinkResolution,
} from './wikilink';

function entry(name: string, overrides: Partial<FileListEntry> = {}): FileListEntry {
  const dir = name.endsWith('/');
  return {
    name: dir ? name.slice(0, -1) : name,
    kind: dir ? 'dir' : 'file',
    size: dir ? 0 : 10,
    mtime: 1_700_000_000,
    ...overrides,
  };
}

function dir(name: string): FileListEntry {
  return entry(`${name}/`);
}

/** 假 vault：`路径 → 条目`，没配的目录一律 reject（模拟读不了的目录）。 */
function makeLister(tree: Record<string, FileListEntry[]>) {
  return vi.fn((path: string) => {
    const entries = tree[path];
    if (entries === undefined) {
      return Promise.reject(new Error(`读不到目录：${path}`));
    }
    return Promise.resolve(entries);
  });
}

function link(inner: string): WikilinkParts {
  const parsed = parseWikilink(inner);
  if (parsed === null) {
    throw new Error(`不是合法 wikilink：${inner}`);
  }
  return parsed;
}

function resolvedPath(resolution: WikilinkResolution): string {
  expect(resolution.status).toBe('found');
  return resolution.status === 'found' ? resolution.path : '';
}

/* ---------------------------------------------------------------- 语法 */

describe('wikilink 语法解析', () => {
  it('[[目标]]：目标、无别名、无标题', () => {
    expect(parseWikilink('目标')).toEqual({
      raw: '[[目标]]',
      target: '目标',
      alias: null,
      heading: null,
      display: '目标',
    });
  });

  it('[[目标|别名]]：别名只作显示文案', () => {
    const parts = link('目标|别名');
    expect(parts.target).toBe('目标');
    expect(parts.alias).toBe('别名');
    expect(parts.display).toBe('别名');
  });

  it('[[#标题]]：纯标题链接（目标为空串）', () => {
    const parts = link('#标题');
    expect(parts.target).toBe('');
    expect(parts.heading).toBe('标题');
    expect(parts.display).toBe('#标题');
  });

  it('[[目标#标题]]：目标照常解析，标题段只保留在 heading', () => {
    const parts = link('目标#第一节');
    expect(parts.target).toBe('目标');
    expect(parts.heading).toBe('第一节');
    expect(parts.display).toBe('目标');
  });

  it('两侧空白被去掉（含别名里的空白）', () => {
    const parts = link('  目标  |  别名  ');
    expect(parts.target).toBe('目标');
    expect(parts.alias).toBe('别名');
  });

  it('别名留空 / 内文全空白都不是链接', () => {
    expect(link('目标|').alias).toBeNull();
    expect(parseWikilink('')).toBeNull();
    expect(parseWikilink('   ')).toBeNull();
    expect(parseWikilink('|')).toBeNull();
    expect(parseWikilink('#')).toBeNull();
  });

  it('保留 .md 扩展名原样（归一交给解析层）', () => {
    expect(link('a.md').target).toBe('a.md');
    expect(wikilinkFileCandidates('a.md')).toEqual(['a.md']);
    expect(wikilinkFileCandidates('a')).toEqual(['a', 'a.md']);
    expect(wikilinkFileCandidates('  ')).toEqual([]);
  });
});

describe('wikilink 语法切分', () => {
  it('普通文本 / 链接 / 别名 / 纯标题混排', () => {
    const segments = splitWikilinkSegments('见 [[a]] 与 [[b|别名]]，还有 [[#h]]。');
    expect(segments.map((segment) => segment.kind)).toEqual([
      'text',
      'wikilink',
      'text',
      'wikilink',
      'text',
      'wikilink',
      'text',
    ]);
    expect(segments[0]).toEqual({ kind: 'text', text: '见 ' });
    expect(segments[3]).toMatchObject({ kind: 'wikilink', link: { target: 'b', alias: '别名' } });
    expect(segments[5]).toMatchObject({ kind: 'wikilink', link: { target: '', heading: 'h' } });
    expect(segments[6]).toEqual({ kind: 'text', text: '。' });
  });

  it('没有链接 / 空串', () => {
    expect(splitWikilinkSegments('纯文本')).toEqual([{ kind: 'text', text: '纯文本' }]);
    expect(splitWikilinkSegments('')).toEqual([]);
  });

  it('不是链接的写法原样当文本：未闭合、嵌套方括号、跨行、空内文', () => {
    for (const text of ['[[未闭合', '[[a[b]]', '[[a\nb]]', '[[  ]]']) {
      expect(splitWikilinkSegments(text)).toEqual([{ kind: 'text', text }]);
    }
  });

  it('collectWikilinks 只收链接', () => {
    expect(collectWikilinks('[[a]] x [[b|c]]').map((item) => item.target)).toEqual(['a', 'b']);
  });
});

/* ---------------------------------------------------------------- 解析 */

const ROOT = '/vault';

describe('wikilink 解析：三级兜底顺序', () => {
  it('① 同目录命中：不再看 vault 根，也不扫全库', async () => {
    const list = makeLister({
      '/vault/notes': [entry('b.md', { size: 12 })],
      '/vault': [entry('b.md', { size: 99 })],
    });
    const resolver = createWikilinkResolver({ list });

    const resolution = await resolver.resolve(link('b'), {
      currentPath: '/vault/notes/a.md',
      root: ROOT,
    });

    expect(resolution).toEqual({ status: 'found', path: '/vault/notes/b.md', name: 'b.md', size: 12 });
    // 同目录命中即返回：根目录根本没被列举。
    expect(list).toHaveBeenCalledWith('/vault/notes');
    expect(list).not.toHaveBeenCalledWith('/vault');
  });

  it('② vault 根相对路径（含子目录段）', async () => {
    const list = makeLister({
      '/vault/notes': [entry('other.md')],
      '/vault': [entry('top.md', { size: 20 }), dir('sub')],
      '/vault/sub': [entry('c.md', { size: 30 })],
    });
    const resolver = createWikilinkResolver({ list });

    expect(
      resolvedPath(
        await resolver.resolve(link('top'), { currentPath: '/vault/notes/a.md', root: ROOT }),
      ),
    ).toBe('/vault/top.md');
    expect(
      resolvedPath(
        await resolver.resolve(link('sub/c'), { currentPath: '/vault/notes/a.md', root: ROOT }),
      ),
    ).toBe('/vault/sub/c.md');
  });

  it('③ 全库递归同名匹配（BFS 层序，找到即停）', async () => {
    const list = makeLister({
      '/vault/notes': [entry('a.md')],
      '/vault': [dir('x'), dir('y')],
      '/vault/x': [dir('deep')],
      '/vault/x/deep': [entry('target.md', { size: 7 })],
      '/vault/y': [entry('target.md', { size: 8 })],
    });
    const resolver = createWikilinkResolver({ list });

    const resolution = await resolver.resolve(link('target'), {
      currentPath: '/vault/notes/a.md',
      root: ROOT,
    });

    // **BFS 层序**：第 2 层（/vault/x、/vault/y）先于第 3 层（/vault/x/deep）
    // 被扫到 ⇒ 命中 /vault/y 的那一份（不是先深挖 x/deep）。
    expect(resolution).toEqual({
      status: 'found',
      path: '/vault/y/target.md',
      name: 'target.md',
      size: 8,
    });
  });

  it('同名文件多处出现：取 BFS 里先遇到的那一份（层序确定）', async () => {
    const list = makeLister({
      '/vault': [dir('a'), entry('dup.md', { size: 1 })],
      '/vault/a': [entry('dup.md', { size: 2 })],
    });
    const resolver = createWikilinkResolver({ list });

    const resolution = await resolver.resolve(link('dup'), {
      currentPath: '/vault/a/note.md',
      root: ROOT,
    });
    // ① 同目录先命中（/vault/a/dup.md）。
    expect(resolvedPath(resolution)).toBe('/vault/a/dup.md');
  });

  it('全库都没有 ⇒ missing / not-found（不抛错）', async () => {
    const list = makeLister({ '/vault': [entry('a.md')], '/vault/notes': [entry('b.md')] });
    const resolver = createWikilinkResolver({ list });

    expect(
      await resolver.resolve(link('nope'), { currentPath: '/vault/notes/b.md', root: ROOT }),
    ).toEqual({ status: 'missing', reason: 'not-found' });
  });

  it('读不了的目录不影响兜底链（当空目录跳过）', async () => {
    const list = makeLister({
      '/vault/notes': [entry('a.md')],
      '/vault': [dir('locked'), dir('ok')],
      '/vault/ok': [entry('found.md', { size: 5 })],
    });
    // `/vault/locked` 没有配 ⇒ list reject
    const resolver = createWikilinkResolver({ list });
    expect(
      resolvedPath(
        await resolver.resolve(link('found'), { currentPath: '/vault/notes/a.md', root: ROOT }),
      ),
    ).toBe('/vault/ok/found.md');
  });

  it('[[#标题]] 解析为当前文件自身（别名 / 标题不影响）', async () => {
    const list = makeLister({
      '/vault': [dir('notes'), entry('index.md')],
      '/vault/notes': [entry('a.md')],
    });
    const resolver = createWikilinkResolver({ list });

    const pure = await resolver.resolve(link('#第一节'), {
      currentPath: '/vault/notes/a.md',
      root: ROOT,
    });
    expect(pure).toEqual({
      status: 'found',
      path: '/vault/notes/a.md',
      name: 'a.md',
      size: 0,
    });
    expect(isSameWikilinkTarget(resolvedPath(pure), '/vault/notes/a.md')).toBe(true);

    // `[[目标#标题]]` 走正常目标解析（标题段不参与匹配）。
    expect(
      resolvedPath(
        await resolver.resolve(link('a#某节'), { currentPath: '/vault/x/b.md', root: ROOT }),
      ),
    ).toBe('/vault/notes/a.md');
  });

  it('别名只影响显示：解析仍按目标走', async () => {
    const list = makeLister({ '/vault': [entry('note.md', { size: 3 })] });
    const resolver = createWikilinkResolver({ list });
    expect(
      resolvedPath(
        await resolver.resolve(link('note|随便叫'), {
          currentPath: '/vault/index.md',
          root: ROOT,
        }),
      ),
    ).toBe('/vault/note.md');
  });

  it('带 .md 与不带 .md 都能命中同一个文件', async () => {
    const list = makeLister({ '/vault': [entry('note.md', { size: 3 })] });
    const resolver = createWikilinkResolver({ list });
    for (const target of ['note', 'note.md']) {
      expect(
        resolvedPath(
          await resolver.resolve(link(target), {
            currentPath: '/vault/index.md',
            root: ROOT,
          }),
        ),
      ).toBe('/vault/note.md');
    }
  });

  it('解析结果过 normalizeContainerPath：多斜杠被归一，根外路径不落地', async () => {
    const list = makeLister({
      '/vault': [dir('sub'), entry('top.md', { size: 9 })],
      '/vault/sub': [entry('c.md', { size: 4 })],
    });
    const resolver = createWikilinkResolver({ list });

    expect(
      resolvedPath(
        await resolver.resolve(link('/sub//c'), {
          currentPath: '/vault/index.md',
          root: ROOT,
        }),
      ),
    ).toBe('/vault/sub/c.md');
  });

  it('`..` / 相对路径 / 非法根一律不解析（不逃出 vault）', async () => {
    const list = makeLister({ '/vault': [entry('a.md')], '/etc': [entry('passwd.md')] });
    const resolver = createWikilinkResolver({ list });

    expect(
      await resolver.resolve(link('../etc/passwd'), {
        currentPath: '/vault/a.md',
        root: ROOT,
      }),
    ).toEqual({ status: 'missing', reason: 'not-found' });
    expect(
      await resolver.resolve(link('a'), { currentPath: '/vault/a.md', root: 'relative/root' }),
    ).toEqual({ status: 'missing', reason: 'not-found' });
    expect(list).not.toHaveBeenCalledWith('/etc');
  });

  it('只解析 .md：指向非 markdown 名字的目标按未找到处理', async () => {
    const list = makeLister({ '/vault': [entry('pic.png'), entry('note.md')] });
    const resolver = createWikilinkResolver({ list });
    expect(
      await resolver.resolve(link('pic.png'), { currentPath: '/vault/note.md', root: ROOT }),
    ).toEqual({ status: 'missing', reason: 'not-found' });
  });

  it('目录列举按路径缓存：两条链接共用一次列举', async () => {
    const list = makeLister({ '/vault': [entry('b.md'), entry('c.md')] });
    const resolver = createWikilinkResolver({ list });
    const context = { currentPath: '/vault/index.md', root: ROOT };

    await resolver.resolve(link('b'), context);
    await resolver.resolve(link('c'), context);

    expect(list.mock.calls.filter(([path]) => path === '/vault')).toHaveLength(1);

    resolver.invalidate();
    await resolver.resolve(link('b'), context);
    expect(list.mock.calls.filter(([path]) => path === '/vault')).toHaveLength(2);
  });
});

describe('wikilink 解析：看门狗超时', () => {
  it('目录列举不返回时按未找到（timeout）收场，不挂死', async () => {
    const list = vi.fn(() => new Promise<FileListEntry[]>(() => {}));
    const resolver = createWikilinkResolver({
      list,
      timeoutMs: 50,
      // 注入的计时器**立刻**触发：模拟预算耗尽（真实实现里是 setTimeout）。
      setTimer: (handler) => {
        handler();
        return 1;
      },
      clearTimer: () => {},
    });

    const resolution = await resolver.resolve(link('stuck'), {
      currentPath: '/vault/a.md',
      root: ROOT,
    });
    expect(resolution).toEqual({ status: 'missing', reason: 'timeout' });
  });

  it('预算在递归途中耗尽：同样按未找到（timeout）', async () => {
    let clock = 0;
    const list = makeLister({
      '/vault/notes': [entry('a.md')],
      '/vault': [dir('one'), dir('two')],
      '/vault/one': [],
      '/vault/two': [],
    });
    const resolver = createWikilinkResolver({
      list,
      timeoutMs: 100,
      // 每次取时刻前进 60ms：前两步还能跑，第三层必然越界。
      now: () => {
        clock += 60;
        return clock;
      },
    });

    const resolution = await resolver.resolve(link('deep-missing'), {
      currentPath: '/vault/notes/a.md',
      root: ROOT,
    });
    expect(resolution.status).toBe('missing');
    expect(resolution.status === 'missing' ? resolution.reason : null).toBe('timeout');
  });

  it('默认预算是个正数（口径常量存在且被用上）', () => {
    expect(WIKILINK_WATCHDOG_MS).toBeGreaterThan(0);
  });
});
