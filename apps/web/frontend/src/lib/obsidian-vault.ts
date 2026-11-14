/**
 * Obsidian tab 的 vault 纯逻辑：根路径归一 / 按沙箱存取 / 树过滤 / 子路径拼接。
 *
 * 口径来源：PRD「方案四 · Obsidian tab」+ 任务 06「Obsidian tab 骨架」。
 *
 * 这里只放**纯函数与存储读写**：不碰 DOM、不碰网络（目录列举由组件层调
 * `api.listFiles`）。收敛的五件事：
 *
 * 1. **vault 根归一**（`normalizeVaultRoot`）：绝对路径、拒 NUL、拒 `.` / `..`；
 * 2. **按沙箱记的存储**（根、展开态与**阅读位**）——换沙箱各自记忆，**不入后端**；
 * 3. **树过滤 / 定序**（`filterVaultEntries`）：**只列目录与 `.md` 文件**，
 *    目录在前、同类型按名称自然序；
 * 4. **子路径拼接**（`vaultChildPath`）与**根内判定**（`isPathWithinVaultRoot`）；
 * 5. **阅读位存取**（`readStoredSelection` / `writeStoredSelection`）：Obsidian tab
 *    与终端 tab 往返时把「在读哪一篇」记住（目录缓存不持久化）。
 *
 * 存储键惯例与 `src/lib/file-pane-collapsed.ts` / `src/lib/sidebar-collapsed.ts`
 * 同款：键前缀 `sandbox-console-`，**沙箱名做键的后缀**；读不到 / 值非法一律
 * 回落「没有根」/「没有展开项」，存储不可用（隐私模式）时静默忽略。
 */

import type { FileListEntry } from '../api/types';
import { childContainerPath, normalizeContainerPath } from './file-transfer';

/* ------------------------------------------------------------ 存储键 */

/** vault 根的存储键前缀：`<前缀><沙箱名>`（**按沙箱记**，换沙箱各自记忆）。 */
export const OBSIDIAN_VAULT_ROOT_STORAGE_PREFIX = 'sandbox-console-obsidian-vault-root:';

/** 树展开态的存储键前缀：`<前缀><沙箱名>`，值是绝对路径的 JSON 数组。 */
export const OBSIDIAN_VAULT_EXPANDED_STORAGE_PREFIX = 'sandbox-console-obsidian-expanded:';

/**
 * **阅读位**（当前在读的 `.md`）的存储键前缀：`<前缀><沙箱名>`。
 *
 * Obsidian tab 与终端 tab 之间往返时 `ObsidianWorkspace` 会整体重挂载（06 的
 * 二选一渲染），选中态不记就丢了——记下来，回来还停在原来那一篇（任务 07 的
 * 可选评估项）。目录缓存仍不持久化（成本高、收益低），回来按需重新列举。
 */
export const OBSIDIAN_SELECTED_STORAGE_PREFIX = 'sandbox-console-obsidian-selected:';

/** vault 根在 localStorage 里的键（按沙箱）。 */
export function vaultRootStorageKey(sandbox: string): string {
  return `${OBSIDIAN_VAULT_ROOT_STORAGE_PREFIX}${sandbox}`;
}

/** 树展开态在 localStorage 里的键（按沙箱）。 */
export function vaultExpandedStorageKey(sandbox: string): string {
  return `${OBSIDIAN_VAULT_EXPANDED_STORAGE_PREFIX}${sandbox}`;
}

/** 阅读位在 localStorage 里的键（按沙箱）。 */
export function vaultSelectedStorageKey(sandbox: string): string {
  return `${OBSIDIAN_SELECTED_STORAGE_PREFIX}${sandbox}`;
}

/* ------------------------------------------------------------ 根路径 */

/**
 * 归一用户给的 vault 根候选值。
 *
 * - 前后空白一律去掉（输入框里敲进来的路径，尾部空格是噪声）；
 * - 必须过 `normalizeContainerPath`：**绝对路径**、拒 NUL、拒 `.` / `..` 段；
 * - 空值与非法值都返回 `null`（= 没有可用的根）。
 */
export function normalizeVaultRoot(input: string | null | undefined): string | null {
  if (typeof input !== 'string') {
    return null;
  }
  const trimmed = input.trim();
  if (trimmed === '') {
    return null;
  }
  return normalizeContainerPath(trimmed);
}

/** 取存储句柄；隐私模式等场景下访问 localStorage 会抛异常。 */
function resolveStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) {
    return storage;
  }
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 读某个沙箱已记的 vault 根；没存过 / 值非法 / 读取失败都回落「没有根」。 */
export function readStoredVaultRoot(
  sandbox: string,
  storage?: Storage | null,
): string | null {
  const store = resolveStorage(storage);
  if (!store) {
    return null;
  }
  try {
    return normalizeVaultRoot(store.getItem(vaultRootStorageKey(sandbox)));
  } catch {
    return null;
  }
}

/** 写某个沙箱的 vault 根；传 `null` 表示清掉（回到引导态）。写不进就静默忽略。 */
export function writeStoredVaultRoot(
  sandbox: string,
  root: string | null,
  storage?: Storage | null,
): void {
  const store = resolveStorage(storage);
  if (!store) {
    return;
  }
  const key = vaultRootStorageKey(sandbox);
  try {
    if (root === null) {
      store.removeItem(key);
      return;
    }
    const normalized = normalizeVaultRoot(root);
    if (normalized === null) {
      store.removeItem(key);
      return;
    }
    store.setItem(key, normalized);
  } catch {
    // 忽略：存不下就算了，本次挂载内的状态仍然生效。
  }
}

/* ------------------------------------------------------------ 展开态 */

/**
 * 读某个沙箱已记的展开目录路径。
 *
 * 只认**绝对路径的字符串数组**：不是数组 / 解析失败 / 项非法一律丢弃；
 * 结果去重（同一路径只展开一次）。
 */
export function readStoredExpandedPaths(
  sandbox: string,
  storage?: Storage | null,
): string[] {
  const store = resolveStorage(storage);
  if (!store) {
    return [];
  }
  let parsed: unknown;
  try {
    const raw = store.getItem(vaultExpandedStorageKey(sandbox));
    if (raw === null) {
      return [];
    }
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== 'string') {
      continue;
    }
    const normalized = normalizeContainerPath(item);
    if (normalized === null) {
      continue;
    }
    seen.add(normalized);
  }
  return [...seen];
}

/** 写某个沙箱的展开目录路径（按字典序落盘，存储内容稳定、便于比对）。 */
export function writeStoredExpandedPaths(
  sandbox: string,
  paths: readonly string[],
  storage?: Storage | null,
): void {
  const store = resolveStorage(storage);
  if (!store) {
    return;
  }
  const normalized = [...new Set(
    paths
      .map((path) => normalizeContainerPath(path))
      .filter((path): path is string => path !== null),
  )].sort();
  try {
    store.setItem(vaultExpandedStorageKey(sandbox), JSON.stringify(normalized));
  } catch {
    // 忽略：存不下就算了，本次挂载内的展开态仍然生效。
  }
}

/* ------------------------------------------------------------ 阅读位 */

/** 记下来的阅读位（`.md` 文件的路径 / 名字 / 字节数）。 */
export interface VaultStoredSelection {
  /** 文件绝对路径（归一后的值）。 */
  path: string;
  /** 文件名（路径最后一段）。 */
  name: string;
  /** 字节数（大文件判定与 `max_bytes` 用）。 */
  size: number;
}

/**
 * 读某个沙箱记下来的阅读位。
 *
 * 只认形状完整的一条：`path` 归一后仍是绝对路径、`name` 是非空且不含 `/` 的
 * 字符串、`size` 是非负有限数。任何一项不合法都当作「没记过」。
 */
export function readStoredSelection(
  sandbox: string,
  storage?: Storage | null,
): VaultStoredSelection | null {
  const store = resolveStorage(storage);
  if (!store) {
    return null;
  }
  let parsed: unknown;
  try {
    const raw = store.getItem(vaultSelectedStorageKey(sandbox));
    if (raw === null) {
      return null;
    }
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const path = typeof record.path === 'string' ? normalizeContainerPath(record.path) : null;
  const name = record.name;
  const size = record.size;
  if (path === null || typeof name !== 'string' || name === '' || name.includes('/')) {
    return null;
  }
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    return null;
  }
  return { path, name, size };
}

/** 写某个沙箱的阅读位；传 `null` 表示清掉（没在读任何文件）。写不进就静默忽略。 */
export function writeStoredSelection(
  sandbox: string,
  selection: VaultStoredSelection | null,
  storage?: Storage | null,
): void {
  const store = resolveStorage(storage);
  if (!store) {
    return;
  }
  const key = vaultSelectedStorageKey(sandbox);
  try {
    if (selection === null) {
      store.removeItem(key);
      return;
    }
    const path = normalizeContainerPath(selection.path);
    if (path === null) {
      store.removeItem(key);
      return;
    }
    store.setItem(
      key,
      JSON.stringify({ path, name: selection.name, size: selection.size }),
    );
  } catch {
    // 忽略：存不下就算了，本次挂载内的状态仍然生效。
  }
}

/* ------------------------------------------------------------ 树过滤 */

/** 文件名是不是 Markdown（`.md`，大小写不敏感）。 */
export function isMarkdownFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.md');
}

/**
 * 这个条目要不要进 vault 树。
 *
 * **只列目录与 `.md` 文件**：`kind === 'dir'` 一律留；`kind === 'file'` 只在
 * 扩展名是 `.md` 时留；`special`（FIFO / 设备 / 套接字）一律不留。
 */
export function isVaultEntry(entry: FileListEntry): boolean {
  if (entry.kind === 'dir') {
    return true;
  }
  if (entry.kind === 'file') {
    return isMarkdownFileName(entry.name);
  }
  return false;
}

/**
 * vault 树的一层：过滤 + 定序。
 *
 * 定序口径与文件窗格一致（`sortFileEntries`）：**目录在前**，同类型按名称
 * 自然序（数字按数值比、大小写不敏感）。
 */
export function filterVaultEntries(entries: readonly FileListEntry[]): FileListEntry[] {
  return entries
    .filter(isVaultEntry)
    .sort((a, b) => {
      const aDir = a.kind === 'dir';
      const bDir = b.kind === 'dir';
      if (aDir !== bDir) {
        return aDir ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });
}

/* ------------------------------------------------------------ 路径 */

/**
 * 树节点的子路径（父目录 + 条目名）。
 *
 * 条目名里出现 `/`、NUL、`.`、`..` 时返回 `null`（这种名字不可能是 vault 树
 * 的合法节点，跳过即可）。
 */
export function vaultChildPath(parent: string, name: string): string | null {
  return childContainerPath(parent, name);
}

/**
 * 路径在不在 vault 根之下（含根本身）。
 *
 * 用来判断持久化的展开态是否仍然属于**当前**的根：换过根之后，旧根的展开项
 * 不该再去列举（那会把 vault 之外的目录也拉上来）。
 */
export function isPathWithinVaultRoot(root: string, path: string): boolean {
  const normalizedRoot = normalizeContainerPath(root);
  const normalizedPath = normalizeContainerPath(path);
  if (normalizedRoot === null || normalizedPath === null) {
    return false;
  }
  if (normalizedPath === normalizedRoot) {
    return true;
  }
  const prefix = normalizedRoot === '/' ? '/' : `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix);
}

/** 文件名（路径的最后一段；根目录返回 `/`）。 */
export function vaultFileName(path: string): string {
  const normalized = normalizeContainerPath(path);
  if (normalized === null || normalized === '/') {
    return '/';
  }
  const segments = normalized.split('/');
  return segments[segments.length - 1] ?? normalized;
}
