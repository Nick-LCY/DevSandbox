/**
 * Obsidian tab 的阅读器骨架：**全宽双栏**（左 vault 树 + 右预览区）+ vault 根管理。
 *
 * 口径来源：PRD「方案四 · Obsidian tab」+ 任务 06「Obsidian tab 骨架」。
 *
 * 本轮只落骨架：
 *
 * - **未设根** ⇒ 引导态（居中书本线框图标 + 「使用沙箱工作目录」描边按钮 +
 *   路径输入框 + 「打开」按钮），**两条入口都能设根**；
 * - **已设根** ⇒ 左栏顶部「vault 根：<路径>」+「更改」小按钮（回引导态并预填原根）；
 * - **vault 树**：树形展开风格（三角箭头旋转 + 缩进层级线），**只列目录与
 *   `.md` 文件**（过滤在 `src/lib/obsidian-vault.ts`），目录**懒展开**
 *   （复用 `api.listFiles`），**展开态按路径记 localStorage**；
 * - **右侧预览区**本轮只有占位（点 `.md` 文件先落选中态）——markdown 渲染与
 *   wikilink 在 07 轮，挂载点就是 `page-sandbox-detail-obsidian-preview`。
 *
 * 根与展开态都**按沙箱**记在前端本地（`localStorage`，不入后端）；组件在
 * `TerminalPanel` 里按沙箱名 `key` 重挂载，换沙箱即换一份状态。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronRight, FileText, Folder, Loader2 } from 'lucide-react';

import { api } from '../../api/client';
import type { FileListEntry } from '../../api/types';
import { cn } from '../../lib/cn';
import {
  filterVaultEntries,
  isPathWithinVaultRoot,
  normalizeVaultRoot,
  readStoredExpandedPaths,
  readStoredVaultRoot,
  vaultChildPath,
  writeStoredExpandedPaths,
  writeStoredVaultRoot,
} from '../../lib/obsidian-vault';

/** 目录列举的状态：还没读 / 读到了 / 读失败。 */
interface DirState {
  status: 'loading' | 'ready' | 'error';
  entries: FileListEntry[];
  error: string | null;
}

/** 当前选中的文件（右侧预览区的输入；07 轮据此渲染 markdown）。 */
export interface VaultSelectedFile {
  /** 文件绝对路径。 */
  path: string;
  /** 文件名（路径最后一段）。 */
  name: string;
  /** 字节数（后端列表条目的 `size`）。 */
  size: number;
}

export interface ObsidianWorkspaceProps {
  /** 沙箱名（目录列举端点挂在它下面；根与展开态按它记忆）。 */
  sandbox: string;
  /**
   * 沙箱工作目录（metadata `workdir`）。
   *
   * 引导态「使用沙箱工作目录」按钮**直接用它**；不可得（空 / 非法）时按钮禁用。
   */
  workdir: string;
}

/** 树节点与树容器之间传的状态与方法。 */
interface VaultTreeContext {
  dirs: Record<string, DirState>;
  expanded: ReadonlySet<string>;
  selectedPath: string | null;
  onToggleDir: (path: string) => void;
  onSelectFile: (file: VaultSelectedFile) => void;
}

function errorMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : '读取目录失败';
}

/* ------------------------------------------------------------ 树节点 */

/**
 * 一层的子节点：目录 + `.md` 文件（过滤与定序都在 `filterVaultEntries`）。
 *
 * **懒展开**：只有父目录展开时才会渲染这一层，父层在展开时触发列举。
 */
function VaultChildren({ dirPath, ctx }: { dirPath: string; ctx: VaultTreeContext }) {
  const state = ctx.dirs[dirPath];
  if (!state) {
    return null;
  }
  if (state.status === 'error') {
    return (
      <div
        role="alert"
        data-testid="page-sandbox-detail-obsidian-tree-error"
        className="px-2 py-1 text-[12px] text-destructive"
      >
        {state.error}
      </div>
    );
  }
  const entries = filterVaultEntries(state.entries);
  return (
    <>
      {state.status === 'loading' && state.entries.length === 0 && (
        <div className="px-2 py-1">
          <Loader2
            className="size-3.5 animate-spin text-muted-foreground"
            aria-hidden="true"
            data-testid="page-sandbox-detail-obsidian-tree-loading"
          />
        </div>
      )}
      {entries.map((entry) =>
        entry.kind === 'dir' ? (
          <VaultDirNode key={entry.name} parent={dirPath} entry={entry} ctx={ctx} />
        ) : (
          <VaultFileNode key={entry.name} parent={dirPath} entry={entry} ctx={ctx} />
        ),
      )}
    </>
  );
}

/** 目录节点：三角箭头旋转 90° 表示展开；子层用左侧竖线画层级线。 */
function VaultDirNode({
  parent,
  entry,
  ctx,
}: {
  parent: string;
  entry: FileListEntry;
  ctx: VaultTreeContext;
}) {
  const path = vaultChildPath(parent, entry.name);
  if (path === null) {
    return null;
  }
  const expanded = ctx.expanded.has(path);
  const loading = ctx.dirs[path]?.status === 'loading';
  return (
    <div data-testid="page-sandbox-detail-obsidian-tree-node" data-path={path}>
      <button
        type="button"
        onClick={() => ctx.onToggleDir(path)}
        aria-expanded={expanded}
        aria-label={entry.name}
        data-testid="page-sandbox-detail-obsidian-tree-dir"
        data-path={path}
        data-expanded={expanded ? 'true' : 'false'}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90',
          )}
          aria-hidden="true"
          data-testid="page-sandbox-detail-obsidian-tree-chevron"
        />
        <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate" title={entry.name}>
          {entry.name}
        </span>
        {loading && (
          <Loader2
            className="ml-auto size-3 shrink-0 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
        )}
      </button>
      {expanded && (
        <div
          data-testid="page-sandbox-detail-obsidian-tree-children"
          className="ml-[13px] border-l border-border pl-2"
        >
          <VaultChildren dirPath={path} ctx={ctx} />
        </div>
      )}
    </div>
  );
}

/** 文件节点（只有 `.md` 会走到这里）：点击落选中态（右侧渲染在 07 轮）。 */
function VaultFileNode({
  parent,
  entry,
  ctx,
}: {
  parent: string;
  entry: FileListEntry;
  ctx: VaultTreeContext;
}) {
  const path = vaultChildPath(parent, entry.name);
  if (path === null) {
    return null;
  }
  const active = ctx.selectedPath === path;
  return (
    <button
      type="button"
      onClick={() => ctx.onSelectFile({ path, name: entry.name, size: entry.size })}
      data-testid="page-sandbox-detail-obsidian-tree-file"
      data-path={path}
      data-active={active ? 'true' : 'false'}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] transition-colors',
        'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
        active
          ? 'bg-muted font-medium text-foreground'
          : 'text-foreground hover:bg-muted/60',
      )}
    >
      {/* 占位一个箭头宽度：文件行的图标与目录行的图标对齐。 */}
      <span className="size-3.5 shrink-0" aria-hidden="true" />
      <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="truncate" title={entry.name}>
        {entry.name}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------ 主组件 */

export function ObsidianWorkspace({ sandbox, workdir }: ObsidianWorkspaceProps) {
  /** vault 根（按沙箱记在 localStorage；`null` = 还没设）。 */
  const [root, setRoot] = useState<string | null>(() => readStoredVaultRoot(sandbox));
  /** 展开的目录绝对路径（按沙箱记在 localStorage）。 */
  const [expandedPaths, setExpandedPaths] = useState<string[]>(() =>
    readStoredExpandedPaths(sandbox),
  );
  /** 展开态的最新值：同一帧内连点两次也不会算出同一个结果。 */
  const expandedRef = useRef<string[]>(expandedPaths);
  /** 每个目录的列举结果（按绝对路径缓存）。 */
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  /** 引导态里正在编辑的根（「更改」会把已有根预填进来）。 */
  const [draftPath, setDraftPath] = useState('');
  /** 是否处在「更改根」的引导态（根还在，但右栏切回引导态）。 */
  const [changingRoot, setChangingRoot] = useState(false);
  /** 当前选中的 `.md` 文件（右侧渲染在 07 轮）。 */
  const [selected, setSelected] = useState<VaultSelectedFile | null>(null);
  /**
   * 列举结果的代次：换根 / 换沙箱时自增，旧响应回来一律丢弃
   * （否则旧根的目录会覆盖新根的树）。
   */
  const generationRef = useRef(0);
  /**
   * 已经发起过列举的目录路径（恢复展开态与懒展开共用）。
   *
   * 用 ref 而不是把 `dirs` 放进 effect 依赖：列举完成会更新 `dirs`，旧写法
   * 让「恢复展开态」effect 每列完一个目录就整轮重跑一遍（`!dirs[path]` 只
   * 免掉重复请求，循环本身仍在反复执行）。ref 只在真正发起列举时记一笔，
   * effect 便只在根 / 展开态变化时跑。换根时清空（新根要重新列举）。
   */
  const requestedPathsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    expandedRef.current = expandedPaths;
  }, [expandedPaths]);

  /** 列举一个目录（懒展开与根列举共用）。 */
  const loadDir = useCallback(
    async (dirPath: string) => {
      const generation = generationRef.current;
      setDirs((previous) => ({
        ...previous,
        [dirPath]: {
          status: 'loading',
          entries: previous[dirPath]?.entries ?? [],
          error: null,
        },
      }));
      try {
        const list = await api.listFiles(sandbox, dirPath);
        if (generation !== generationRef.current) {
          return;
        }
        setDirs((previous) => ({
          ...previous,
          [dirPath]: { status: 'ready', entries: list, error: null },
        }));
      } catch (exc) {
        if (generation !== generationRef.current) {
          return;
        }
        setDirs((previous) => ({
          ...previous,
          [dirPath]: { status: 'error', entries: [], error: errorMessage(exc) },
        }));
      }
    },
    [sandbox],
  );

  // 换根（或首次设根）：代次自增、清缓存与选中，重新列举根目录。
  useEffect(() => {
    generationRef.current += 1;
    requestedPathsRef.current.clear();
    setDirs({});
    setSelected(null);
    if (root === null) {
      return;
    }
    void loadDir(root);
  }, [root, loadDir]);

  /**
   * 刷新后恢复展开态：已记的展开目录在根之内、且还没列举过的，补一次列举。
   *
   * 根之外的旧展开项**不列举**（换过根之后它们已经不是 vault 的一部分）。
   */
  useEffect(() => {
    if (root === null) {
      return;
    }
    for (const path of expandedPaths) {
      if (path === root || !isPathWithinVaultRoot(root, path)) {
        continue;
      }
      if (requestedPathsRef.current.has(path)) {
        continue;
      }
      requestedPathsRef.current.add(path);
      void loadDir(path);
    }
  }, [root, expandedPaths, loadDir]);

  /** 目录展开 / 收起（落盘，刷新后仍在）。 */
  const toggleDir = useCallback(
    (path: string) => {
      const previous = expandedRef.current;
      const next = previous.includes(path)
        ? previous.filter((item) => item !== path)
        : [...previous, path];
      expandedRef.current = next;
      writeStoredExpandedPaths(sandbox, next);
      setExpandedPaths(next);
    },
    [sandbox],
  );

  /** 选中一个 `.md` 文件（右侧渲染在 07 轮）。 */
  const selectFile = useCallback((file: VaultSelectedFile) => {
    setSelected(file);
    setChangingRoot(false);
  }, []);

  /** 设根：归一并落盘，退出引导态。 */
  const applyRoot = useCallback(
    (candidate: string | null) => {
      const normalized = candidate === null ? null : normalizeVaultRoot(candidate);
      if (normalized === null) {
        return;
      }
      // 换根时把展开态裁到新根之内（state + localStorage）：旧根的展开路径
      // 不裁掉会永久滞留——新根更小时它们既不在树里、也永远不会被清掉。
      const kept = expandedRef.current.filter(
        (path) => path !== normalized && isPathWithinVaultRoot(normalized, path),
      );
      expandedRef.current = kept;
      writeStoredExpandedPaths(sandbox, kept);
      setExpandedPaths(kept);
      writeStoredVaultRoot(sandbox, normalized);
      setRoot(normalized);
      setDraftPath('');
      setChangingRoot(false);
    },
    [sandbox],
  );

  /** 「更改」：回引导态并预填原根。 */
  const changeRoot = useCallback(() => {
    setDraftPath(root ?? '');
    setChangingRoot(true);
  }, [root]);

  /** 引导态「打开」：路径非法时按钮本就是禁用的，这里再兜一次。 */
  const submitDraft = useCallback(() => {
    applyRoot(draftPath);
  }, [applyRoot, draftPath]);

  /** 沙箱工作目录能不能当根（不可得时「使用沙箱工作目录」禁用）。 */
  const workdirRoot = normalizeVaultRoot(workdir);
  /** 输入框里的值非法（非空提示，红字就地展示，不进 toast）。 */
  const draftInvalid = draftPath.trim() !== '' && normalizeVaultRoot(draftPath) === null;

  const expanded = useMemo(() => new Set(expandedPaths), [expandedPaths]);
  const treeContext = useMemo<VaultTreeContext>(
    () => ({
      dirs,
      expanded,
      selectedPath: selected?.path ?? null,
      onToggleDir: toggleDir,
      onSelectFile: selectFile,
    }),
    [dirs, expanded, selected, toggleDir, selectFile],
  );

  const onboarding = (
    <div
      data-testid="page-sandbox-detail-obsidian-onboarding"
      className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6"
    >
      <div className="flex w-full max-w-[420px] flex-col items-center gap-3">
        <BookOpen
          className="size-8 text-muted-foreground"
          strokeWidth={1.25}
          aria-hidden="true"
          data-testid="page-sandbox-detail-obsidian-onboarding-icon"
        />
        <p
          className="text-[13px] text-foreground"
          data-testid="page-sandbox-detail-obsidian-onboarding-title"
        >
          选择一个目录作为 vault 根
        </p>
        <button
          type="button"
          onClick={() => applyRoot(workdirRoot)}
          disabled={workdirRoot === null}
          title={workdirRoot ?? '沙箱工作目录不可用'}
          data-testid="page-sandbox-detail-obsidian-use-workdir-button"
          className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-transparent px-3 text-[13px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        >
          使用沙箱工作目录
        </button>
        <div className="flex w-full items-center gap-2">
          <input
            type="text"
            value={draftPath}
            onChange={(event) => {
              setDraftPath(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submitDraft();
              }
            }}
            placeholder="/path/to/vault"
            aria-label="vault 根路径"
            spellCheck={false}
            data-testid="page-sandbox-detail-obsidian-root-input"
            className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2.5 py-1 font-mono text-[12.5px] text-foreground transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <button
            type="button"
            onClick={submitDraft}
            disabled={normalizeVaultRoot(draftPath) === null}
            data-testid="page-sandbox-detail-obsidian-root-open-button"
            className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-transparent bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            打开
          </button>
        </div>
        {draftInvalid && (
          <p
            role="alert"
            data-testid="page-sandbox-detail-obsidian-root-error"
            className="w-full text-[12px] text-destructive"
          >
            请输入绝对路径
          </p>
        )}
      </div>
    </div>
  );

  // 还没设根：引导态占满整个 Obsidian 视图（没有树可列）。
  if (root === null) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card"
        data-testid="page-sandbox-detail-obsidian"
      >
        {onboarding}
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card"
      data-testid="page-sandbox-detail-obsidian"
    >
      {/* 左栏：vault 树（固定宽，不可拖拽）。 */}
      <aside
        className="flex min-h-0 w-[264px] flex-none flex-col"
        data-testid="page-sandbox-detail-obsidian-vault-tree"
      >
        <div
          className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2"
          data-testid="page-sandbox-detail-obsidian-vault-header"
        >
          <span
            className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground"
            title={root}
            data-testid="page-sandbox-detail-obsidian-vault-root"
          >
            vault 根：{root}
          </span>
          <button
            type="button"
            onClick={changeRoot}
            data-testid="page-sandbox-detail-obsidian-change-root-button"
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            更改
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1 pr-1">
          <VaultChildren dirPath={root} ctx={treeContext} />
        </div>
      </aside>

      {/* 中：一条细分隔线（纯展示，**不可拖拽**）。 */}
      <div
        aria-hidden="true"
        data-testid="page-sandbox-detail-obsidian-divider"
        className="w-px flex-none bg-border"
      />

      {/* 右：预览区（07 轮在这里落 markdown 渲染 / wikilink / 工具条）。 */}
      <section
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        data-testid="page-sandbox-detail-obsidian-preview"
        data-selected-path={selected?.path ?? ''}
      >
        {changingRoot ? (
          onboarding
        ) : selected === null ? (
          <div className="flex h-full items-center justify-center p-6">
            <span
              className="text-[13px] text-muted-foreground"
              data-testid="page-sandbox-detail-obsidian-preview-empty"
            >
              从左侧选择文件
            </span>
          </div>
        ) : (
          <div
            className="flex h-full items-center justify-center p-6"
            data-testid="page-sandbox-detail-obsidian-preview-placeholder"
          >
            <span className="max-w-full break-all font-mono text-[12px] text-muted-foreground">
              {selected.path}
            </span>
          </div>
        )}
      </section>
    </div>
  );
}
