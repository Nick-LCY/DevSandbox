/**
 * Obsidian wikilink 的纯逻辑：**语法切分** + **三级解析兜底**（同目录 → vault 根
 * 相对 → 全库递归同名匹配）。
 *
 * 口径来源：PRD「方案四 · Obsidian tab」的 wikilink 段 + 任务 07。
 *
 * 这里不碰 DOM、不碰网络：目录列举由调用方注入（组件层传
 * `(dir) => api.listFiles(sandbox, dir)`），因此**兜底顺序、超时与归一都能单测**。
 * 收敛的四件事：
 *
 * 1. **语法**：`[[目标]]` / `[[目标|别名]]` / `[[#标题]]`（另兼容
 *    `[[目标#标题]]` 与带扩展名的写法）——切分结果供渲染层组装 react 节点；
 * 2. **三级兜底**：① 同目录 → ② vault 根相对路径 → ③ 全库递归同名匹配（BFS）；
 * 3. **看门狗超时**：BFS 有总预算（默认 5 秒，`setTimer` / `now` 可注入），
 *    **超时按「未找到」处理**（`reason: 'timeout'`），绝不挂死；
 * 4. **归一**：解析结果（与候选路径）一律过既有的 `normalizeContainerPath`，
 *    `..` / NUL / 相对路径一律不可能落地。
 */

import type { FileListEntry } from '../api/types';
import { normalizeContainerPath, parentContainerPath } from './file-transfer';
import {
  isMarkdownFileName,
  isPathWithinVaultRoot,
  vaultChildPath,
  vaultFileName,
} from './obsidian-vault';

/* ------------------------------------------------------------ 语法切分 */

/** 一条 wikilink 拆出来的各段（都是**去空白之后**的值）。 */
export interface WikilinkParts {
  /** 原始文本（含双方括号，如 `[[目标|别名]]`）。 */
  raw: string;
  /** 目标文件（`[[#标题]]` 时为空串）。 */
  target: string;
  /** 别名（`[[目标|别名]]` 的右边）；没有别名为 `null`。 */
  alias: string | null;
  /** `#` 之后的标题（没有为 `null`；`[[#标题]]` 时是纯标题链接）。 */
  heading: string | null;
  /** 显示文案：别名优先，其次目标，纯标题链接显示 `#标题`。 */
  display: string;
}

/** 切分结果的一段：普通文本，或一条 wikilink。 */
export type WikilinkSegment =
  | { kind: 'text'; text: string }
  | { kind: 'wikilink'; link: WikilinkParts };

/**
 * wikilink 的匹配式。
 *
 * 内文**不允许**出现 `[` / `]` / 换行：`[[a[b]]` 这类不是合法 wikilink，
 * 交给普通文本渲染（宁可少认，也不要把半截语法吞掉）。
 */
const WIKILINK_PATTERN = /\[\[([^[\]\n]+)\]\]/g;

/**
 * 解析一条 wikilink 的**内文**（两个双方括号之间的内容）。
 *
 * 语法口径：
 * - `目标` —— 普通链接；
 * - `目标|别名` —— 别名只作显示文案，不生成别名页（PRD 非目标）；
 * - `#标题` —— **纯标题链接**：目标为空、解析为**当前文件自身**；
 * - `目标#标题` —— 目标照常解析，标题段只保留在 `heading` 里（本轮不做滚动定位）；
 * - 内文全空白 / 只有一个别名分隔符（`[[|]]`）⇒ `null`（不是链接）。
 *
 * **不做路径归一**：`target` 原样保留（解析层再逐级归一），否则 `[[a.md]]` 与
 * `[[a]]` 的差异会在这一步就丢掉。
 */
export function parseWikilink(inner: string): WikilinkParts | null {
  const raw = `[[${inner}]]`;
  const body = inner.trim();
  if (body === '') {
    return null;
  }

  let alias: string | null = null;
  let head = body;
  const pipeIndex = body.indexOf('|');
  if (pipeIndex >= 0) {
    head = body.slice(0, pipeIndex).trim();
    const aliasRaw = body.slice(pipeIndex + 1).trim();
    alias = aliasRaw === '' ? null : aliasRaw;
  }

  let target = head;
  let heading: string | null = null;
  const hashIndex = head.indexOf('#');
  if (hashIndex >= 0) {
    target = head.slice(0, hashIndex).trim();
    const headingRaw = head.slice(hashIndex + 1).trim();
    heading = headingRaw === '' ? null : headingRaw;
  }

  if (target === '' && heading === null) {
    return null;
  }

  const display = alias ?? (target !== '' ? target : `#${heading}`);
  return { raw, target, alias, heading, display };
}

/**
 * 把一段 markdown 文本切成「普通文本 / wikilink」两类片段。
 *
 * 渲染层拿它组装 react 节点（普通文本原样、wikilink 换成可点元素）；空串返回
 * 空数组（不产出一个空文本片段）。
 */
export function splitWikilinkSegments(text: string): WikilinkSegment[] {
  if (text === '') {
    return [];
  }
  const segments: WikilinkSegment[] = [];
  let cursor = 0;
  WIKILINK_PATTERN.lastIndex = 0;
  for (;;) {
    const match = WIKILINK_PATTERN.exec(text);
    if (match === null) {
      break;
    }
    const parsed = parseWikilink(match[1]);
    if (parsed === null) {
      // 不是链接（`[[   ]]`）：连同括号一起交给普通文本。
      continue;
    }
    if (match.index > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, match.index) });
    }
    segments.push({ kind: 'wikilink', link: parsed });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ kind: 'text', text: text.slice(cursor) });
  }
  return segments;
}

/** 一段文本里所有 wikilink 的目标（渲染前预解析 / 测试用）。 */
export function collectWikilinks(text: string): WikilinkParts[] {
  return splitWikilinkSegments(text)
    .filter((segment): segment is { kind: 'wikilink'; link: WikilinkParts } =>
      segment.kind === 'wikilink',
    )
    .map((segment) => segment.link);
}

/* ------------------------------------------------------------ 解析兜底 */

/** 解析成「没找到」的原因：全库都没有，或递归列举超预算。 */
export type WikilinkMissReason = 'not-found' | 'timeout';

/** 一次 wikilink 解析的结果。 */
export type WikilinkResolution =
  /** 命中：`path` 已过 `normalizeContainerPath`，`size` 取列表条目的字节数。 */
  | { status: 'found'; path: string; name: string; size: number }
  /** 没命中：`reason` 区分「全库没有」与「看门狗超时」（**超时按未找到处理**）。 */
  | { status: 'missing'; reason: WikilinkMissReason };

/** 解析所需的上下文（当前文件 + vault 根，都是绝对路径）。 */
export interface WikilinkResolveContext {
  /** 当前正在阅读的文件绝对路径（① 同目录、`[[#标题]]` 用它）。 */
  currentPath: string;
  /** vault 根绝对路径（②③ 的起点）。 */
  root: string;
}

/** 解析依赖（**全部可注入**，单测不需要真网络 / 真计时器）。 */
export interface WikilinkResolverDeps {
  /** 列一个目录（失败会被当作「空目录」，不打断兜底链）。 */
  list: (dir: string) => Promise<FileListEntry[]>;
  /** 全库递归匹配的总预算（毫秒），默认 `WIKILINK_WATCHDOG_MS`。 */
  timeoutMs?: number;
  /** 当前时刻（毫秒）；默认 `Date.now`。 */
  now?: () => number;
  /** 定时器（看门狗用）；默认 `setTimeout`。 */
  setTimer?: (handler: () => void, ms: number) => unknown;
  /** 清定时器；默认 `clearTimeout`。 */
  clearTimer?: (handle: unknown) => void;
}

/**
 * 全库递归同名匹配的**默认**看门狗预算（毫秒）。
 *
 * 5 秒：正常 vault 的目录数在几百以内，BFS 一遍足够；真遇到巨大 vault 时宁可
 * 按「未找到」收场（错误条可手动关掉），也不要把界面挂在「解析中」。
 */
export const WIKILINK_WATCHDOG_MS = 5000;

/** 解析句柄：`resolve` 走三级兜底，`invalidate` 清目录缓存（换根 / 换沙箱时用）。 */
export interface WikilinkResolver {
  resolve: (
    link: WikilinkParts,
    context: WikilinkResolveContext,
  ) => Promise<WikilinkResolution>;
  /** 清掉跨次解析的目录缓存（目录结构可能变了 / 换了根）。 */
  invalidate: () => void;
}

/** 一条 wikilink 可能的文件候选名：原样 + 补 `.md`（去重、保序）。 */
export function wikilinkFileCandidates(target: string): string[] {
  const trimmed = target.trim();
  if (trimmed === '') {
    return [];
  }
  const names = [trimmed];
  if (!trimmed.toLowerCase().endsWith('.md')) {
    names.push(`${trimmed}.md`);
  }
  return [...new Set(names)];
}

/** 目标里的最后一段（全库同名匹配只认文件名，不认路径）。 */
function wikilinkBaseName(target: string): string {
  const segments = target.trim().split('/');
  return segments[segments.length - 1] ?? '';
}

/** 目标里有没有 `.` / `..` 段（有就不可能是 vault 里的文件，直接按未找到处理）。 */
function hasDotSegments(target: string): boolean {
  return target
    .split('/')
    .some((segment) => segment === '.' || segment === '..');
}

/**
 * 在一层条目里找同名文件（`kind === 'file'`、**必须是 `.md`**、名字精确匹配）。
 *
 * wikilink 只指向笔记：`[[图片.png]]` 这类不解析（PRD 非目标里也没有图片内嵌）。
 */
function findFileEntry(
  entries: readonly FileListEntry[],
  names: readonly string[],
): FileListEntry | null {
  for (const entry of entries) {
    if (entry.kind !== 'file' || !isMarkdownFileName(entry.name)) {
      continue;
    }
    if (names.includes(entry.name)) {
      return entry;
    }
  }
  return null;
}

/** 校验目录筛选 / 定序：按名字的自然序（BFS 顺序必须确定，单测才能钉住）。 */
function sortEntries(entries: readonly FileListEntry[]): FileListEntry[] {
  return [...entries].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  );
}

/**
 * 造一个 wikilink 解析器。
 *
 * 目录列举按路径缓存（**跨次解析共享**）：同一个目录不重复列举，连续 hover 多条
 * 链接时只有第一次会真的走网络。缓存的生命周期由调用方掌握（换根 / 换沙箱时
 * 调 `invalidate()`，或直接重建一个 resolver）。
 *
 * 兜底顺序（PRD 明令，不得调换）：
 *
 * 1. **同目录**：`父目录(当前文件) + 目标名`；
 * 2. **vault 根相对**：`根 + 目标路径`（目标里可以带子目录）；
 * 3. **全库递归同名匹配**：从根开始 BFS，按层序找**文件名**同名的文件。
 *
 * 每次 `resolve` 有自己的看门狗预算；预算耗尽 ⇒ `{status:'missing',
 * reason:'timeout'}`（**按未找到处理**，不挂死）。
 */
export function createWikilinkResolver(deps: WikilinkResolverDeps): WikilinkResolver {
  const now = deps.now ?? (() => Date.now());
  const setTimer =
    deps.setTimer ??
    ((handler: () => void, ms: number) => setTimeout(handler, ms) as unknown);
  const clearTimer =
    deps.clearTimer ??
    ((handle: unknown) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  const timeoutMs = deps.timeoutMs ?? WIKILINK_WATCHDOG_MS;

  const cache = new Map<string, Promise<FileListEntry[]>>();

  /** 列举一个目录（失败 ⇒ 空目录；同一路径只发一次）。 */
  const listCached = (dir: string): Promise<FileListEntry[]> => {
    const cached = cache.get(dir);
    if (cached !== undefined) {
      return cached;
    }
    const pending = deps
      .list(dir)
      .then((entries) => (Array.isArray(entries) ? entries : []))
      .catch(() => [] as FileListEntry[]);
    cache.set(dir, pending);
    return pending;
  };

  type ListOutcome = { kind: 'entries'; entries: FileListEntry[] } | { kind: 'timeout' };

  /** 带预算的列举：预算耗尽（或列举迟迟不返回）⇒ `{kind:'timeout'}`。 */
  const listWithinBudget = async (dir: string, deadline: number): Promise<ListOutcome> => {
    const remaining = deadline - now();
    if (remaining <= 0) {
      return { kind: 'timeout' };
    }
    let handle: unknown = null;
    const timeout = new Promise<ListOutcome>((resolve) => {
      handle = setTimer(() => resolve({ kind: 'timeout' }), remaining);
    });
    try {
      return await Promise.race<ListOutcome>([
        listCached(dir).then((entries) => ({ kind: 'entries', entries })),
        timeout,
      ]);
    } finally {
      if (handle !== null) {
        clearTimer(handle);
      }
    }
  };

  const resolve = async (
    link: WikilinkParts,
    context: WikilinkResolveContext,
  ): Promise<WikilinkResolution> => {
    const deadline = now() + timeoutMs;
    const root = normalizeContainerPath(context.root);
    if (root === null) {
      return { status: 'missing', reason: 'not-found' };
    }
    const currentPath = normalizeContainerPath(context.currentPath);

    // 纯标题链接（`[[#标题]]`）：解析为**当前文件自身**。
    if (link.target === '' && link.heading !== null) {
      if (currentPath === null) {
        return { status: 'missing', reason: 'not-found' };
      }
      return {
        status: 'found',
        path: currentPath,
        name: vaultFileName(currentPath),
        size: 0,
      };
    }

    const target = link.target.trim();
    if (target === '' || hasDotSegments(target)) {
      return { status: 'missing', reason: 'not-found' };
    }
    const names = wikilinkFileCandidates(target);
    if (names.length === 0) {
      return { status: 'missing', reason: 'not-found' };
    }

    const found = (dir: string, entry: FileListEntry): WikilinkResolution | null => {
      const path = vaultChildPath(dir, entry.name);
      const normalized = path === null ? null : normalizeContainerPath(path);
      if (normalized === null || !isPathWithinVaultRoot(root, normalized)) {
        return null;
      }
      return { status: 'found', path: normalized, name: entry.name, size: entry.size };
    };

    /* ① 同目录 */
    if (currentPath !== null) {
      const dir = parentContainerPath(currentPath);
      const outcome = await listWithinBudget(dir, deadline);
      if (outcome.kind === 'timeout') {
        return { status: 'missing', reason: 'timeout' };
      }
      const entry = findFileEntry(outcome.entries, names);
      if (entry !== null) {
        const hit = found(dir, entry);
        if (hit !== null) {
          return hit;
        }
      }
    }

    /* ② vault 根相对路径（目标里可以带子目录） */
    for (const name of names) {
      const segments = name.split('/').filter((segment) => segment !== '');
      if (segments.length === 0) {
        continue;
      }
      const dirSegments = segments.slice(0, -1);
      const fileName = segments[segments.length - 1];
      let dir = root;
      for (const segment of dirSegments) {
        const child = vaultChildPath(dir, segment);
        if (child === null) {
          dir = '';
          break;
        }
        dir = child;
      }
      if (dir === '' || !isPathWithinVaultRoot(root, dir)) {
        continue;
      }
      const outcome = await listWithinBudget(dir, deadline);
      if (outcome.kind === 'timeout') {
        return { status: 'missing', reason: 'timeout' };
      }
      const entry = findFileEntry(outcome.entries, [fileName]);
      if (entry !== null) {
        const hit = found(dir, entry);
        if (hit !== null) {
          return hit;
        }
      }
    }

    /* ③ 全库递归同名匹配（BFS，带看门狗） */
    const baseNames = wikilinkFileCandidates(wikilinkBaseName(target));
    const visited = new Set<string>();
    const queue: string[] = [root];
    while (queue.length > 0) {
      if (now() >= deadline) {
        return { status: 'missing', reason: 'timeout' };
      }
      const dir = queue.shift() as string;
      if (visited.has(dir)) {
        continue;
      }
      visited.add(dir);
      const outcome = await listWithinBudget(dir, deadline);
      if (outcome.kind === 'timeout') {
        return { status: 'missing', reason: 'timeout' };
      }
      const entries = sortEntries(outcome.entries);
      const entry = findFileEntry(entries, baseNames);
      if (entry !== null) {
        const hit = found(dir, entry);
        if (hit !== null) {
          return hit;
        }
      }
      for (const item of entries) {
        if (item.kind !== 'dir') {
          continue;
        }
        const child = vaultChildPath(dir, item.name);
        if (child !== null) {
          queue.push(child);
        }
      }
    }

    return { status: 'missing', reason: 'not-found' };
  };

  return {
    resolve,
    invalidate: () => {
      cache.clear();
    },
  };
}

/** 这条链接是不是「当前文件自身」（`[[#标题]]` 或解析回当前路径）。 */
export function isSameWikilinkTarget(path: string, currentPath: string): boolean {
  const normalizedPath = normalizeContainerPath(path);
  const normalizedCurrent = normalizeContainerPath(currentPath);
  return normalizedPath !== null && normalizedPath === normalizedCurrent;
}
