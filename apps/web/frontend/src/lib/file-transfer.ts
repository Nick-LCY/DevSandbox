/**
 * 运行期文件传输的纯逻辑：容器内路径拼接、`Content-Disposition` 文件名解析、
 * 大小 / 修改时间格式化、目录列表排序、图标映射与传输百分比。
 *
 * 这里不碰 DOM、不碰网络：面板组件只负责把结果画出来。
 * 图标映射返回的是**资产名**（如 `typescript` / `folder`），真正的 URL
 * 由 `src/lib/file-icon-assets.ts` 在构建期从本地资产目录解析——运行时零 CDN。
 */

import type { FileListEntry } from '../api/types';

/* ------------------------------------------------------------------ 路径 */

/**
 * 词法归一化容器内绝对路径。
 *
 * 只做前端能确定的事：必须是绝对路径、不含 NUL、不出现 `.` / `..` 段。
 * **不解析符号链接**（后端也不解析，口径一致）。返回 `null` 表示非法。
 */
export function normalizeContainerPath(path: string): string | null {
  if (typeof path !== 'string') {
    return null;
  }
  // 只吃前导空白：后端承诺条目名保真，**尾部空白可能是名字的一部分**
  // （如以空格 / 换行结尾的文件），整串 trim 会把名字改掉。
  const leadingTrimmed = path.replace(/^\s+/, '');
  if (!leadingTrimmed.startsWith('/') || leadingTrimmed.includes('\0')) {
    return null;
  }
  const segments = leadingTrimmed.split('/').filter((segment) => segment !== '');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return null;
  }
  return `/${segments.join('/')}`;
}

/** 绝对路径是否合法（`normalizeContainerPath` 的非空结果）。 */
export function isAbsoluteContainerPath(path: string): boolean {
  return normalizeContainerPath(path) !== null;
}

/** 把绝对路径拆成段（根目录返回空数组；非法路径也返回空数组，由调用方先校验）。 */
export function splitContainerPath(path: string): string[] {
  const normalized = normalizeContainerPath(path);
  if (normalized === null) {
    return [];
  }
  return normalized.split('/').filter((segment) => segment !== '');
}

/** 把段拼回绝对路径（空数组 = 根目录 `/`）。 */
export function joinContainerPath(segments: readonly string[]): string {
  const safe = segments.filter((segment) => segment !== '');
  return safe.length === 0 ? '/' : `/${safe.join('/')}`;
}

/** 从当前目录与条目名拼子路径；条目名里出现 `/` 或 NUL 时返回 `null`。 */
export function childContainerPath(directory: string, name: string): string | null {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    return null;
  }
  const base = normalizeContainerPath(directory);
  if (base === null) {
    return null;
  }
  return joinContainerPath([...splitContainerPath(base), name]);
}

/** 上一级目录（根目录的上一级仍是根目录）。 */
export function parentContainerPath(path: string): string {
  const segments = splitContainerPath(path);
  return joinContainerPath(segments.slice(0, -1));
}

/* -------------------------------------------------------------- 面包屑排版 */

/**
 * 面包屑溢出裁剪的结果。
 *
 * `start` / `end` 是**保留区间**（含两端）：浅层级被收进省略号时 `start > 0`，
 * `end` 恒为最后一级（当前目录）。
 */
export interface BreadcrumbTrim {
  /** 保留区间的起始下标（含）。 */
  start: number;
  /** 保留区间的结束下标（含）；恒为最后一级（当前目录）。 */
  end: number;
  /** 左侧是否显示省略号（被收起来的浅层级的标记，纯展示、不可点）。 */
  ellipsis: boolean;
}

/** 面包屑排版的可调参数（单位：像素）。 */
export interface BreadcrumbTrimOptions {
  /** 省略号标记自身的宽度。 */
  ellipsisWidth?: number;
  /** 格子之间的间距（flex gap）。 */
  gapWidth?: number;
}

/**
 * 面包屑溢出裁剪：**宽度不够时优先保留右侧（靠近当前目录的深层级）**，
 * 左侧浅层级逐步收进省略号「…」。
 *
 * 宽度口径：
 * - `levelWidths[i]` 是第 i 级（浅 → 深）的**整格宽度**（含它自己的分隔符）；
 * - 一行的总宽 = 各格宽度之和 + 格子之间的间距 × (格子数 - 1)，
 *   **省略号本身也算一格**；
 * - `availableWidth ≤ 0`（宽度未知 / 还没布局）时**不裁剪**：全部保留
 *   （宁可多显示，也不要在没量到宽度时先把浅层级收起来）；
 * - 当前级（最后一级）**永远保留**：实在放不下时也留着（配合 CSS 截断兜底）；
 * - 极窄（连「省略号 + 当前级」都放不下）时：**只留当前级，但保留省略号提示**
 *   ——浅层级确实被收起来了，提示不能丢；当前级由 CSS 截断兜底
 *   （宁可当前级被 truncate，也不丢「还有浅层级」的提示）。
 */
export function trimBreadcrumbLevels(
  availableWidth: number,
  levelWidths: readonly number[],
  options?: BreadcrumbTrimOptions,
): BreadcrumbTrim {
  const widths = levelWidths.map((width) =>
    typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : 0,
  );
  const end = widths.length - 1;
  if (end < 0) {
    return { start: 0, end: -1, ellipsis: false };
  }
  const limit =
    typeof availableWidth === 'number' && Number.isFinite(availableWidth) && availableWidth > 0
      ? availableWidth
      : 0;
  if (limit <= 0) {
    // 宽度未知：不做裁剪。
    return { start: 0, end, ellipsis: false };
  }
  const ellipsisWidth =
    typeof options?.ellipsisWidth === 'number' &&
    Number.isFinite(options.ellipsisWidth) &&
    options.ellipsisWidth > 0
      ? options.ellipsisWidth
      : 0;
  const gapWidth =
    typeof options?.gapWidth === 'number' && Number.isFinite(options.gapWidth) && options.gapWidth > 0
      ? options.gapWidth
      : 0;

  /** 保留 `[start, end]` 时这一行要占的宽度。 */
  const widthOf = (start: number): number => {
    let sum = 0;
    for (let index = start; index <= end; index += 1) {
      sum += widths[index];
    }
    const cells = end - start + 1 + (start > 0 ? 1 : 0);
    return sum + (start > 0 ? ellipsisWidth : 0) + gapWidth * (cells - 1);
  };

  // 从浅到深逐级试：**第一个放得下的起点**就是最终保留区间
  // （放不下就往右收，浅层级退进省略号）。
  for (let start = 0; start <= end; start += 1) {
    if (widthOf(start) <= limit) {
      return { start, end, ellipsis: start > 0 };
    }
  }
  // 连当前级都放不下（极窄）：只留当前级。
  // **省略号仍要留**：浅层级确实被收起来了（提示不能丢），当前级由 CSS 截断兜底。
  // 只有一级时没有浅层级可收 → 不出省略号。
  return { start: end, end, ellipsis: end > 0 };
}

/* -------------------------------------------------------------- 文件名解析 */

/**
 * 从 `Content-Disposition` 里取文件名。
 *
 * **优先 `filename*`**（RFC 5987：`charset'lang'百分号编码`，UTF-8 中文名走这里），
 * 取不到再退回 ASCII 的 `filename="..."`。都取不到返回 `null`。
 */
export function parseContentDispositionFilename(
  header: string | null | undefined,
): string | null {
  if (!header) {
    return null;
  }

  const extended = /filename\*\s*=\s*([^']*)'([^']*)'([^;]+)/i.exec(header);
  if (extended) {
    const raw = extended[3].trim().replace(/^"(.*)"$/, '$1');
    if (raw !== '') {
      try {
        return decodeURIComponent(raw);
      } catch {
        // 百分号编码坏了：原样返回，至少不是空文件名。
        return raw;
      }
    }
  }

  const plain = /filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]+))/i.exec(header);
  if (plain) {
    const raw = (plain[1] ?? plain[2] ?? '').trim();
    if (raw !== '') {
      return raw.replace(/\\(["\\])/g, '$1');
    }
  }

  return null;
}

/* ------------------------------------------------------------------ 格式化 */

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** 文件大小：B / KB / MB / GB / TB（1024 进制，保留一位小数）。 */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${SIZE_UNITS[unitIndex]}`;
}

/** 修改时间（Unix epoch 秒）→ 本地 `YYYY-MM-DD HH:mm`。非法值显示占位符。 */
export function formatFileMtime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return '—';
  }
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  const pad = (part: number): string => String(part).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/* -------------------------------------------------------------------- 排序 */

/**
 * 目录列表排序：**文件夹在前**，同类按名称排（numeric + 忽略大小写）。
 *
 * 隐藏文件（`.` 开头）不特殊处理：照常显示、照常参与排序。
 */
export function sortFileEntries(entries: readonly FileListEntry[]): FileListEntry[] {
  return entries.slice().sort((a, b) => {
    const aDir = a.kind === 'dir';
    const bDir = b.kind === 'dir';
    if (aDir !== bDir) {
      return aDir ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

/* ---------------------------------------------------------------- 图标映射 */

/** 扩展名 → 图标资产名（口径对齐 material-icon-theme 的 fileIcons.ts）。 */
export const EXT_ICON: Record<string, string> = {
  ts: 'typescript', tsx: 'react_ts', mts: 'typescript', cts: 'typescript',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'react', json: 'json', jsonc: 'json', json5: 'json',
  py: 'python', pyi: 'python', ipynb: 'jupyter',
  md: 'markdown', mdx: 'mdx', markdown: 'markdown',
  html: 'html', htm: 'html', css: 'css', scss: 'sass', sass: 'sass', less: 'less',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'settings', conf: 'settings',
  sh: 'console', bash: 'console', zsh: 'console', fish: 'console',
  ps1: 'powershell', bat: 'powershell', cmd: 'console',
  sql: 'database', db: 'database', sqlite: 'database', sqlite3: 'database',
  log: 'log', txt: 'document', csv: 'table', tsv: 'table',
  lock: 'lock', env: 'tune',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'favicon',
  svg: 'svg', zip: 'zip', tar: 'zip', gz: 'zip', tgz: 'zip', bz2: 'zip', xz: 'zip', '7z': 'zip', rar: 'zip',
  pdf: 'pdf', xml: 'xml', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', vue: 'vue', php: 'php',
  woff: 'font', woff2: 'font', ttf: 'font', mp4: 'video', mov: 'video', mp3: 'audio', wav: 'audio',
  tf: 'terraform', tfvars: 'terraform', graphql: 'graphql', gql: 'graphql', prisma: 'prisma',
  tex: 'tex', rst: 'document', rb: 'ruby', swift: 'swift', cs: 'csharp', nix: 'nix',
};

/** 文件名（精确匹配）→ 图标资产名。 */
export const NAME_ICON: Record<string, string> = {
  dockerfile: 'docker',
  'dockerfile.dev': 'docker',
  'dockerfile.prod': 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  'compose.yml': 'docker',
  makefile: 'makefile',
  readme: 'readme',
  license: 'license',
  'package.json': 'nodejs',
  'package-lock.json': 'nodejs',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'readme.md': 'readme',
  'poetry.lock': 'poetry',
  'uv.lock': 'uv',
  'requirements.txt': 'python-misc',
  'pyproject.toml': 'python-misc',
  'cargo.toml': 'rust',
  'cargo.lock': 'rust',
  'go.mod': 'go-mod',
  'go.sum': 'go-mod',
  'tsconfig.json': 'tsconfig',
  'vite.config.ts': 'vite',
  'vite.config.js': 'vite',
  'next.config.js': 'next',
  'next.config.mjs': 'next',
  'jest.config.js': 'jest',
  'eslint.config.js': 'eslint',
  '.eslintrc.json': 'eslint',
  'biome.json': 'biome',
  'nginx.conf': 'nginx',
  'tauri.conf.json': 'tauri',
  'favicon.ico': 'favicon',
  'robots.txt': 'robots',
  '.editorconfig': 'editorconfig',
  '.npmrc': 'npm',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitkeep': 'git',
  '.dockerignore': 'docker',
  'schema.prisma': 'prisma',
  'main.tf': 'terraform',
  'variables.tf': 'terraform',
};

/** 目录名 → 图标资产名（匹配不到回落通用 `folder`）。 */
export const FOLDER_ICON: Record<string, string> = {
  src: 'folder-src', source: 'folder-src', app: 'folder-app', web: 'folder-app',
  components: 'folder-components', config: 'folder-config', routes: 'folder-routes',
  services: 'folder-server', backend: 'folder-server', api: 'folder-api',
  lib: 'folder-lib', utils: 'folder-utils',
  hooks: 'folder-hook', types: 'folder-typescript', models: 'folder-database',
  tests: 'folder-test', test: 'folder-test', unit: 'folder-test', e2e: 'folder-test',
  fixtures: 'folder-test', __tests__: 'folder-test',
  scripts: 'folder-scripts', bin: 'folder-scripts',
  docs: 'folder-docs', doc: 'folder-docs', adr: 'folder-docs',
  images: 'folder-images', img: 'folder-images', assets: 'folder-images',
  brand: 'folder-images', icons: 'folder-images', media: 'folder-images',
  public: 'folder-public', static: 'folder-public', styles: 'folder-css',
  css: 'folder-css', scss: 'folder-sass', sass: 'folder-sass',
  data: 'folder-database', db: 'folder-database', database: 'folder-database',
  cache: 'folder-database', sql: 'folder-database', var: 'folder-log', logs: 'folder-log',
  storage: 'folder-archive', files: 'folder-archive', uploads: 'folder-upload',
  download: 'folder-download',
  dist: 'folder-dist', build: 'folder-dist', out: 'folder-dist', coverage: 'folder-coverage',
  node_modules: 'folder-node', '.vscode': 'folder-vscode', '.github': 'folder-github',
  '.git': 'folder-git', git: 'folder-git', store: 'folder-store',
  deploy: 'folder-container', deployment: 'folder-container', docker: 'folder-container',
  terraform: 'folder-terraform', helm: 'folder-kubernetes', k8s: 'folder-kubernetes',
  mail: 'folder-mail', templates: 'folder-template', template: 'folder-template',
  python: 'folder-python', windows: 'folder-windows',
  linux: 'folder-linux', home: 'folder-home', json: 'folder-json', markdown: 'folder-markdown',
};

/** 一个条目的图标解析结果。`fallback` 表示用的是用户提供的通用兜底图标。 */
export interface EntryIcon {
  /** 资产名（不含 `.svg`）。 */
  icon: string;
  /** 是否走了通用兜底（`folder` / `file`）。 */
  fallback: boolean;
}

/** 文件 / 特殊文件的图标资产名（未知扩展名一律回落 `file`）。 */
export function resolveFileIconName(name: string): string {
  const lower = name.toLowerCase();
  const exact = NAME_ICON[lower];
  if (exact) {
    return exact;
  }
  if (lower.startsWith('.env')) {
    return 'tune';
  }
  if (lower.startsWith('.git')) {
    return 'git';
  }
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tar.bz2')) {
    return 'zip';
  }
  const dot = lower.lastIndexOf('.');
  if (dot > 0) {
    const ext = lower.slice(dot + 1);
    const mapped = EXT_ICON[ext];
    if (mapped) {
      return mapped;
    }
  }
  return 'file';
}

/** 目录的图标资产名（没有语义变体时回落 `folder`）。 */
export function resolveFolderIconName(name: string): string {
  return FOLDER_ICON[name.toLowerCase()] ?? 'folder';
}

/** 按条目类型解析图标。 */
export function resolveEntryIcon(entry: Pick<FileListEntry, 'name' | 'kind'>): EntryIcon {
  const icon = entry.kind === 'dir' ? resolveFolderIconName(entry.name) : resolveFileIconName(entry.name);
  return { icon, fallback: icon === 'folder' || icon === 'file' };
}

/* ------------------------------------------------------------------ 进度 */

/** 传输百分比（0~100 整数）；总长度未知时返回 `null`。 */
export function transferPercent(loaded: number, total: number | null): number | null {
  if (total === null || !Number.isFinite(total) || total <= 0 || !Number.isFinite(loaded)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.floor((loaded / total) * 100)));
}
