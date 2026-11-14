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
import { BookOpen, ChevronRight, FileText, Folder, Loader2, RefreshCw } from 'lucide-react';

import { api } from '../../api/client';
import type { FileListEntry } from '../../api/types';
import { cn } from '../../lib/cn';
import { isLargePreviewFile } from '../../lib/file-preview';
import {
  filterVaultEntries,
  isPathWithinVaultRoot,
  normalizeVaultRoot,
  readStoredExpandedPaths,
  readStoredSelection,
  readStoredVaultRoot,
  vaultChildPath,
  writeStoredExpandedPaths,
  writeStoredSelection,
  writeStoredVaultRoot,
} from '../../lib/obsidian-vault';
import { ObsidianPreview, OBSIDIAN_HEADER_CLASS } from './ObsidianPreview';
import { PreviewConfirmDialog } from './PreviewConfirmDialog';

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
  /**
   * 预览历史栈（**栈顶 = 当前在读的文件**）。
   *
   * - 点树上的文件 ⇒ **重置栈**（新的一次阅读）；
   * - 点 wikilink 命中 ⇒ **压栈**（返回键逐层退回）；
   * - 初值从按沙箱记的**阅读位**恢复：Obsidian tab 与终端 tab 往返时本组件整体
   *   重挂载（06 的二选一渲染），不恢复就丢了阅读位（任务 07 可选评估项）。
   *   大文件不自动恢复——恢复路径不该绕过「> 2 MB 先二次确认」的口径。
   */
  const [stack, setStack] = useState<VaultSelectedFile[]>(() => {
    const stored = readStoredSelection(sandbox);
    if (stored === null || root === null || !isPathWithinVaultRoot(root, stored.path)) {
      return [];
    }
    if (isLargePreviewFile(stored.size)) {
      return [];
    }
    return [stored];
  });
  /** 当前在读的文件（历史栈栈顶；`null` = 还没选）。 */
  const selected = stack.length === 0 ? null : stack[stack.length - 1];
  /**
   * 大文件二次确认的待办（`null` = 没有弹框）。
   *
   * 树里的文件与 wikilink 命中的目标**都从这里过**：> 2 MB 时**确认才读**、
   * 取消一个请求都不发（与文件窗格预览同一个对话框组件）。
   */
  const [confirmTarget, setConfirmTarget] = useState<{
    target: VaultSelectedFile;
    push: boolean;
  } | null>(null);
  /** 上一次的根：用来区分「挂载」与「真的换了根」（换根才清阅读位）。 */
  const previousRootRef = useRef<string | null>(root);
  /** 「刷新 vault 树」进行中：按钮瞬时禁用 + 旋转（用户浏览器复验修复轮）。 */
  const [refreshingTree, setRefreshingTree] = useState(false);
  /** 挂载那一拍不写存储（沿用根 / 展开态「挂载不写」的惯例）。 */
  const skipSelectionWriteRef = useRef(true);
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

  /**
   * 阅读位落盘：**状态变化后**写（不放副作用进 state updater，StrictMode
   * 双调用也不会重复写）；挂载那一拍跳过（读到什么就是什么）。
   */
  useEffect(() => {
    if (skipSelectionWriteRef.current) {
      skipSelectionWriteRef.current = false;
      return;
    }
    writeStoredSelection(sandbox, selected);
  }, [sandbox, selected]);

  // 换根（或首次设根）：代次自增、清缓存，重新列举根目录。
  useEffect(() => {
    generationRef.current += 1;
    // 刷新在途时换根：旧刷新 finally 的代次比对恒 false，按钮复位不能指望它——
    // 这里补一刀（换根本身已 bump 代次丢弃旧响应，这里只负责收按钮状态）。
    setRefreshingTree(false);
    requestedPathsRef.current.clear();
    setDirs({});
    // **只在真的换根时**清阅读位：挂载那一拍要把恢复的阅读位留住。
    if (previousRootRef.current !== root) {
      previousRootRef.current = root;
      setStack([]);
      writeStoredSelection(sandbox, null);
    }
    if (root === null) {
      return;
    }
    void loadDir(root);
  }, [root, loadDir, sandbox]);

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

  /**
   * 刷新 vault 树（左栏 header 的刷新按钮）。
   *
   * 口径（用户浏览器复验修复轮，2026-11-14）：**失效全部目录缓存**后按
   * **当前展开态**重拉（根 + 已展开目录），**保留当前选中与阅读位置**——
   * 不动历史栈、不重读正文（`readFile` 一个都不发），只重列目录。
   */
  const refreshTree = useCallback(() => {
    if (root === null) {
      return;
    }
    // 代次自增：在途的旧列举响应回来一律丢弃（与换根同一套护栏）。
    generationRef.current += 1;
    const generation = generationRef.current;
    requestedPathsRef.current.clear();
    const paths = [
      root,
      ...expandedRef.current.filter(
        (path) => path !== root && isPathWithinVaultRoot(root, path),
      ),
    ];
    for (const path of paths) {
      // 手动重拉的路径记回「已列举」：后续展开态 effect 不重复发请求。
      requestedPathsRef.current.add(path);
    }
    setRefreshingTree(true);
    void Promise.all(paths.map((path) => loadDir(path))).finally(() => {
      // 只收自己这一代：刷新途中又换了根就不再碰按钮状态——按钮复位已交给
      // 换根 effect（见上，代次比对恒 false 时本分支不执行）。
      if (generation === generationRef.current) {
        setRefreshingTree(false);
      }
    });
  }, [root, loadDir]);

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

  /** 真正落到栈上（**大文件已经确认过**才走到这里）。 */
  const applyOpen = useCallback((next: VaultSelectedFile, push: boolean) => {
    setStack((previous) => (push ? [...previous, next] : [next]));
    setChangingRoot(false);
  }, []);

  /**
   * 打开一个文件：**> 2 MB 先弹二次确认**（PRD OBS-11 与文件窗格预览同口径）。
   *
   * `push` = 沿历史栈前进（wikilink 命中），`false` = 重置栈（树里点文件）。
   */
  const openFile = useCallback(
    (next: VaultSelectedFile, push: boolean) => {
      if (isLargePreviewFile(next.size)) {
        setConfirmTarget({ target: next, push });
        return;
      }
      applyOpen(next, push);
    },
    [applyOpen],
  );

  /** 树里点 `.md`：重置历史栈（新的一次阅读）。 */
  const selectFile = useCallback(
    (file: VaultSelectedFile) => {
      openFile(file, false);
    },
    [openFile],
  );

  /** wikilink 命中：**压栈**（返回键能退回上一篇）。 */
  const openWikilinkTarget = useCallback(
    (file: VaultSelectedFile) => {
      openFile(file, true);
    },
    [openFile],
  );

  /** 返回上一层（栈底那层不渲染返回钮）。 */
  const backFromPreview = useCallback(() => {
    setStack((previous) => previous.slice(0, -1));
  }, []);

  /** 二次确认：**确认才发起读取**（压栈或重置栈）。 */
  const confirmLargePreview = useCallback(() => {
    const pending = confirmTarget;
    setConfirmTarget(null);
    if (pending !== null) {
      applyOpen(pending.target, pending.push);
    }
  }, [applyOpen, confirmTarget]);

  /** 二次确认：**取消不发请求**（留在原来的视图）。 */
  const cancelLargePreview = useCallback(() => {
    setConfirmTarget(null);
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
          className={cn(OBSIDIAN_HEADER_CLASS, 'px-3')}
          data-testid="page-sandbox-detail-obsidian-vault-header"
        >
          <span
            className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground"
            title={root}
            data-testid="page-sandbox-detail-obsidian-vault-root"
          >
            vault 根：{root}
          </span>
          {/*
            刷新：失效目录缓存后按当前展开态重拉 vault 树，**不重置阅读位**。
            loading 反馈 = 按钮瞬时禁用 + 图标旋转。
          */}
          <button
            type="button"
            onClick={refreshTree}
            disabled={refreshingTree}
            aria-busy={refreshingTree}
            title="刷新"
            aria-label="刷新"
            data-testid="page-sandbox-detail-obsidian-tree-refresh-button"
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            <RefreshCw
              className={cn('size-3.5', refreshingTree && 'animate-spin')}
              aria-hidden="true"
            />
          </button>
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
          /* 07 轮：占位换成真正的阅读器（markdown 渲染 / 源码 / wikilink 跳转）。 */
          <ObsidianPreview
            sandbox={sandbox}
            root={root}
            target={selected}
            canGoBack={stack.length > 1}
            onBack={backFromPreview}
            onOpenTarget={openWikilinkTarget}
          />
        )}
      </section>

      {/*
        大文件（> 2 MB）二次确认：**确认才发起读取**、**取消不发任何请求**。
        与文件窗格预览**同一个对话框组件**（PRD OBS-11），标识换成本页命名空间。
      */}
      <PreviewConfirmDialog
        open={confirmTarget !== null}
        name={confirmTarget?.target.name ?? ''}
        size={confirmTarget?.target.size ?? 0}
        onConfirm={confirmLargePreview}
        onCancel={cancelLargePreview}
        dialogTestId="page-sandbox-detail-obsidian-preview-confirm-dialog"
        confirmTestId="page-sandbox-detail-obsidian-preview-confirm-button"
        cancelTestId="page-sandbox-detail-obsidian-preview-confirm-cancel-button"
      />
    </div>
  );
}
