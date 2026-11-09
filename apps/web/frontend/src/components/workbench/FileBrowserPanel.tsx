import { useCallback, useEffect, useRef, useState } from 'react';
import { Folder, Loader2, Upload, X } from 'lucide-react';

import { api } from '../../api/client';
import type { FileListEntry } from '../../api/types';
import { cn } from '../../lib/cn';
import { fileIconUrl } from '../../lib/file-icon-assets';
import {
  childContainerPath,
  formatFileMtime,
  formatFileSize,
  joinContainerPath,
  normalizeContainerPath,
  parseContentDispositionFilename,
  resolveEntryIcon,
  resolveFileIconName,
  sortFileEntries,
  splitContainerPath,
  transferPercent,
} from '../../lib/file-transfer';
import { useToast } from '../Toast';
import { DrawerShell } from './DrawerShell';
import { ModalShell } from './ModalShell';

interface FileBrowserPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 沙箱名（三条文件端点都挂在它下面）。 */
  sandbox: string;
  /** 首次打开时的目录（沙箱的容器内 workdir；缺省为根目录）。 */
  initialPath: string;
  /** 抽屉宽度（视口宽度的百分比）。 */
  widthVw: number;
  /** 宽度变化回调（工作台负责持久化）。 */
  onWidthChange: (vw: number) => void;
  /** 是否运行在桌面壳里（桌面下载分支在 05 轮接通，本轮留桩）。 */
  desktop: boolean;
}

/** 上传行（排队中 / 上传中）。 */
interface UploadItem {
  id: string;
  name: string;
  size: number;
  dirPath: string;
  loaded: number;
  total: number | null;
  status: 'queued' | 'uploading';
}

/** 排队中的一次上传（选文件时的目标目录与同名冲突快照）。 */
interface QueuedUpload {
  id: string;
  file: File;
  dirPath: string;
  existing: FileListEntry | null;
}

/** 正在下载的文件（行内进度）。 */
interface DownloadItem {
  name: string;
  loaded: number;
  total: number | null;
}

let uploadSeq = 0;

function nextUploadId(): string {
  uploadSeq += 1;
  return `upload-${uploadSeq}`;
}

function errorMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

function isAbortError(exc: unknown): boolean {
  return exc instanceof DOMException && exc.name === 'AbortError';
}

/** web 形态落盘：Blob → a[download]。**不导航 blob: URL**（桌面 CSP 只放行 img-src 的 blob）。 */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 延迟回收而不是 0ms：Firefox / Safari 在点击后的下一个任务里仍要读这个 URL，
  // 立刻 revoke 可能让下载拿不到内容。
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const rowGrid = 'grid grid-cols-[minmax(0,1fr)_86px_126px] items-center gap-3';

/**
 * 运行期文件浏览面板（独立抽屉）。
 *
 * 口径：
 * - 列表三列：图标 + 名称 / 大小 / 修改时间（无类型列）；文件夹在前、隐藏文件照常显示；
 * - **点击文件行本身即下载**（没有下载按钮）；
 * - 上传只进**当前浏览目录**（无路径输入框）；多文件排队逐个传，行内进度 + 可取消；
 * - 同名**文件**先弹覆盖确认；同名**目录**交给服务端 400（不弹确认框）；
 * - 面包屑各级可点击，**不重复展示纯文本当前目录**；
 * - 界面没有副标题 / 解释说明性文字。
 */
export function FileBrowserPanel({
  open,
  onOpenChange,
  sandbox,
  initialPath,
  widthVw,
  onWidthChange,
  desktop,
}: FileBrowserPanelProps) {
  const { show } = useToast();
  const [path, setPath] = useState(() => normalizeContainerPath(initialPath) ?? '/');
  const [entries, setEntries] = useState<FileListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [downloads, setDownloads] = useState<Map<string, DownloadItem>>(() => new Map());
  const [overwriteName, setOverwriteName] = useState<string | null>(null);
  const [preparingUpload, setPreparingUpload] = useState(false);

  const pathRef = useRef(path);
  const entriesRef = useRef(entries);
  const uploadsRef = useRef(uploads);
  const requestIdRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const queueRef = useRef<QueuedUpload[]>([]);
  const processingRef = useRef(false);
  const preparingRef = useRef(false);
  const cancelledRef = useRef<Set<string>>(new Set());
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const downloadControllersRef = useRef<Map<string, AbortController>>(new Map());
  const overwriteResolverRef = useRef<((ok: boolean) => void) | null>(null);
  const overwriteItemIdRef = useRef<string | null>(null);
  /** 抽屉是否还开着（异步收尾时判断要不要再弹提示）。 */
  const openRef = useRef(open);
  /** 抽屉会话代次：关闭时自增，旧队列 / 旧确认框的后续逻辑据此退出。 */
  const generationRef = useRef(0);
  /** 当前 `entries` 是否来自当前目录的一次成功读取（否则不能用来判同名）。 */
  const listTrustedRef = useRef(false);
  const listPathRef = useRef<string | null>(null);

  pathRef.current = path;
  entriesRef.current = entries;
  uploadsRef.current = uploads;

  /* -------------------------------------------------------------- 目录读取 */

  const loadDirectory = useCallback(
    async (directory: string): Promise<FileListEntry[] | null> => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setLoading(true);
      setError(null);
      // 列表读取中 / 读取失败时快照不可信：入队前必须重新读一次。
      listTrustedRef.current = false;
      try {
        const list = sortFileEntries(await api.listFiles(sandbox, directory));
        if (requestId !== requestIdRef.current) {
          return list;
        }
        setEntries(list);
        listPathRef.current = directory;
        listTrustedRef.current = true;
        return list;
      } catch (exc) {
        if (requestId === requestIdRef.current) {
          const message = errorMessage(exc);
          setEntries([]);
          setError(message);
          listPathRef.current = directory;
          listTrustedRef.current = false;
        }
        return null;
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [sandbox],
  );

  // 每次打开都回到沙箱的起始目录；换沙箱同理。
  useEffect(() => {
    if (!open) {
      return;
    }
    setEntries([]);
    listTrustedRef.current = false;
    setPath(normalizeContainerPath(initialPath) ?? '/');
  }, [open, sandbox, initialPath]);

  // 当前目录变化（含首次打开）就重读列表。
  useEffect(() => {
    if (!open) {
      return;
    }
    void loadDirectory(path);
  }, [open, path, loadDirectory]);

  /** 收掉全部在途传输（关闭抽屉 / 卸载时用；只动 ref，不碰状态）。 */
  const abortTransfers = useCallback((): void => {
    generationRef.current += 1;
    for (const controller of abortControllersRef.current.values()) {
      controller.abort();
    }
    abortControllersRef.current.clear();
    for (const controller of downloadControllersRef.current.values()) {
      controller.abort();
    }
    downloadControllersRef.current.clear();
    queueRef.current = [];
    cancelledRef.current.clear();
    processingRef.current = false;
    preparingRef.current = false;
    const resolver = overwriteResolverRef.current;
    overwriteResolverRef.current = null;
    overwriteItemIdRef.current = null;
    resolver?.(false);
  }, []);

  // 抽屉关闭（含切沙箱前的收口）：清空在途上传 / 下载、队列与确认框。
  useEffect(() => {
    openRef.current = open;
    if (open) {
      return;
    }
    abortTransfers();
    setUploads([]);
    setDownloads(new Map());
    setOverwriteName(null);
    setPreparingUpload(false);
  }, [open, abortTransfers]);

  // 卸载同样收口（AbortController 与 reader 都不留）。
  useEffect(
    () => () => {
      openRef.current = false;
      abortTransfers();
    },
    [abortTransfers],
  );

  /* ---------------------------------------------------------------- 导航 */

  const enterDirectory = useCallback((name: string) => {
    const next = childContainerPath(pathRef.current, name);
    if (next !== null) {
      setEntries([]);
      setPath(next);
    }
  }, []);

  const navigateToDepth = useCallback((depth: number) => {
    const segments = splitContainerPath(pathRef.current);
    setEntries([]);
    setPath(joinContainerPath(segments.slice(0, depth + 1)));
  }, []);

  const navigateToRoot = useCallback(() => {
    setEntries([]);
    setPath('/');
  }, []);

  const segments = splitContainerPath(path);

  /* ---------------------------------------------------------------- 上传 */

  const updateUpload = useCallback((id: string, patch: Partial<UploadItem>) => {
    setUploads((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }, []);

  const removeUpload = useCallback((id: string) => {
    setUploads((current) => current.filter((item) => item.id !== id));
  }, []);

  const askOverwrite = useCallback((name: string, id: string): Promise<boolean> => {
    setOverwriteName(name);
    overwriteItemIdRef.current = id;
    return new Promise<boolean>((resolve) => {
      overwriteResolverRef.current = resolve;
    });
  }, []);

  const settleOverwrite = useCallback((ok: boolean) => {
    setOverwriteName(null);
    overwriteItemIdRef.current = null;
    const resolver = overwriteResolverRef.current;
    overwriteResolverRef.current = null;
    resolver?.(ok);
  }, []);

  const runUpload = useCallback(
    async (item: QueuedUpload, targetPath: string): Promise<void> => {
      const controller = new AbortController();
      const generation = generationRef.current;
      abortControllersRef.current.set(item.id, controller);
      updateUpload(item.id, { status: 'uploading' });

      try {
        await api.uploadFile(sandbox, targetPath, item.file, {
          signal: controller.signal,
          onProgress: (progress) => {
            updateUpload(item.id, { loaded: progress.loaded, total: progress.total });
          },
        });
        removeUpload(item.id);
        if (
          generation === generationRef.current &&
          openRef.current &&
          !cancelledRef.current.has(item.id)
        ) {
          show('success', `已上传 ${item.file.name}`, { source: 'file-browser' });
          if (pathRef.current === item.dirPath) {
            void loadDirectory(item.dirPath);
          }
        }
      } catch (exc) {
        removeUpload(item.id);
        if (
          generation === generationRef.current &&
          openRef.current &&
          !cancelledRef.current.has(item.id) &&
          !isAbortError(exc)
        ) {
          // 后端 detail 原样展示（如「目标是一个目录，不能作为上传目标」）。
          show('error', errorMessage(exc), { source: 'file-browser' });
        }
      } finally {
        abortControllersRef.current.delete(item.id);
        cancelledRef.current.delete(item.id);
      }
    },
    [loadDirectory, removeUpload, sandbox, show, updateUpload],
  );

  const drainQueue = useCallback(async (): Promise<void> => {
    if (processingRef.current) {
      return;
    }
    processingRef.current = true;
    const generation = generationRef.current;
    const active = (): boolean =>
      openRef.current && generation === generationRef.current;
    try {
      while (queueRef.current.length > 0) {
        if (!active()) {
          break;
        }
        const item = queueRef.current.shift();
        if (!item || cancelledRef.current.has(item.id)) {
          continue;
        }

        // 同名**普通文件**：先弹覆盖确认；取消则跳过并提示。
        // 同名**目录**不弹框：交给服务端 400（target_is_dir），错误 toast 原样展示。
        if (item.existing !== null && item.existing.kind !== 'dir') {
          const overwrite = await askOverwrite(item.file.name, item.id);
          // 等确认期间抽屉关了 / 切了会话：静默收口，不再提示。
          if (!active()) {
            removeUpload(item.id);
            cancelledRef.current.delete(item.id);
            break;
          }
          if (!overwrite || cancelledRef.current.has(item.id)) {
            const cancelledByUser = cancelledRef.current.has(item.id);
            removeUpload(item.id);
            cancelledRef.current.delete(item.id);
            if (!cancelledByUser) {
              show('info', `已跳过 ${item.file.name}`, { source: 'file-browser' });
            }
            continue;
          }
        }

        if (!active()) {
          removeUpload(item.id);
          cancelledRef.current.delete(item.id);
          break;
        }

        const targetPath = childContainerPath(item.dirPath, item.file.name);
        if (targetPath === null) {
          removeUpload(item.id);
          show('error', `文件名不合法：${item.file.name}`, { source: 'file-browser' });
          continue;
        }
        await runUpload(item, targetPath);
      }
    } finally {
      if (generation === generationRef.current) {
        processingRef.current = false;
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [askOverwrite, removeUpload, runUpload, show]);

  const enqueueFiles = useCallback(
    async (files: File[]): Promise<void> => {
      if (files.length === 0 || preparingRef.current || !openRef.current) {
        return;
      }
      const directory = pathRef.current;
      const generation = generationRef.current;
      let visible = entriesRef.current;

      // 列表还在读 / 读失败时，当前快照**不能用来判同名**（空列表会静默覆盖）。
      // 入队前先把这个目录重新读一遍，拿到可信列表再决定要不要弹确认框。
      const trusted =
        listTrustedRef.current && listPathRef.current === directory && !loading && error === null;
      if (!trusted) {
        preparingRef.current = true;
        setPreparingUpload(true);
        try {
          const loaded = await loadDirectory(directory);
          if (loaded === null) {
            if (openRef.current) {
              show('error', '当前目录读取失败，已取消上传', { source: 'file-browser' });
            }
            return;
          }
          visible = loaded;
        } finally {
          preparingRef.current = false;
          setPreparingUpload(false);
        }
        if (!openRef.current || generation !== generationRef.current) {
          return;
        }
      }

      const queued: QueuedUpload[] = files.map((file) => ({
        id: nextUploadId(),
        file,
        dirPath: directory,
        existing: visible.find((entry) => entry.name === file.name) ?? null,
      }));
      queueRef.current.push(...queued);
      setUploads((current) => [
        ...current,
        ...queued.map((item) => ({
          id: item.id,
          name: item.file.name,
          size: item.file.size,
          dirPath: item.dirPath,
          loaded: 0,
          total: item.file.size > 0 ? item.file.size : null,
          status: 'queued' as const,
        })),
      ]);
      void drainQueue();
    },
    [drainQueue, error, loading, loadDirectory, show],
  );

  const cancelUpload = useCallback(
    (id: string) => {
      const item = uploadsRef.current.find((candidate) => candidate.id === id);
      if (!item) {
        return;
      }
      cancelledRef.current.add(id);
      // 覆盖确认框正等着这个文件：按「取消」收口并关框，不再多发「已跳过」。
      if (overwriteItemIdRef.current === id) {
        settleOverwrite(false);
      }
      queueRef.current = queueRef.current.filter((queued) => queued.id !== id);
      abortControllersRef.current.get(id)?.abort();
      removeUpload(id);
      show('info', `已取消上传：${item.name}`, { source: 'file-browser' });
    },
    [removeUpload, settleOverwrite, show],
  );

  /* ---------------------------------------------------------------- 下载 */

  const startDownload = useCallback(
    async (entry: FileListEntry): Promise<void> => {
      if (downloadControllersRef.current.has(entry.name)) {
        return;
      }
      const targetPath = childContainerPath(pathRef.current, entry.name);
      if (targetPath === null) {
        return;
      }

      if (desktop) {
        // TODO(05): 桌面形态下载 = 原生「保存为」对话框（tauri-plugin-dialog）
        // → Rust 侧带令牌下载落盘。本轮只留分支位，不写死行为。
        return;
      }

      const controller = new AbortController();
      const generation = generationRef.current;
      downloadControllersRef.current.set(entry.name, controller);
      setDownloads((current) => {
        const next = new Map(current);
        next.set(entry.name, {
          name: entry.name,
          loaded: 0,
          total: entry.size > 0 ? entry.size : null,
        });
        return next;
      });
      try {
        const { blob, contentDisposition } = await api.downloadFile(sandbox, targetPath, {
          signal: controller.signal,
          onProgress: (progress) => {
            setDownloads((current) => {
              if (!current.has(entry.name)) {
                return current;
              }
              const next = new Map(current);
              next.set(entry.name, {
                name: entry.name,
                loaded: progress.loaded,
                total: progress.total,
              });
              return next;
            });
          },
        });
        const filename = parseContentDispositionFilename(contentDisposition) ?? entry.name;
        if (generation === generationRef.current && !controller.signal.aborted) {
          saveBlob(blob, filename);
        }
        if (
          generation === generationRef.current &&
          openRef.current &&
          !controller.signal.aborted
        ) {
          show('success', `已下载 ${filename}`, { source: 'file-browser' });
        }
      } catch (exc) {
        if (
          generation === generationRef.current &&
          openRef.current &&
          !controller.signal.aborted &&
          !isAbortError(exc)
        ) {
          show('error', errorMessage(exc), { source: 'file-browser' });
        }
      } finally {
        // 只收自己这一槽：旧会话的 finally 不能把重开后的同名下载清掉。
        if (downloadControllersRef.current.get(entry.name) === controller) {
          downloadControllersRef.current.delete(entry.name);
          setDownloads((current) => {
            if (!current.has(entry.name)) {
              return current;
            }
            const next = new Map(current);
            next.delete(entry.name);
            return next;
          });
        }
      }
    },
    [desktop, sandbox, show],
  );

  const activateEntry = useCallback(
    (entry: FileListEntry) => {
      if (entry.kind === 'dir') {
        enterDirectory(entry.name);
        return;
      }
      void startDownload(entry);
    },
    [enterDirectory, startDownload],
  );

  /* ---------------------------------------------------------------- 渲染 */

  return (
    <>
      <DrawerShell
        open={open}
        title="文件"
        testId="page-file-browser-dialog"
        onOpenChange={onOpenChange}
        widthVw={widthVw}
        onWidthChange={onWidthChange}
      >
        <div className="flex min-h-0 flex-col gap-3">
          <nav
            aria-label="路径"
            data-testid="page-file-browser-crumbs"
            className="flex flex-wrap items-center gap-1 text-[12.5px]"
          >
            <button
              type="button"
              onClick={navigateToRoot}
              title="根目录"
              aria-label="根目录"
              aria-current={segments.length === 0 ? 'page' : undefined}
              data-testid="page-file-browser-crumb"
              data-depth="-1"
              className={cn(
                'inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                segments.length === 0 && 'bg-muted text-foreground',
              )}
            >
              <Folder className="size-3.5" aria-hidden="true" />
            </button>
            {segments.map((segment, index) => (
              <span key={`${index}-${segment}`} className="flex items-center gap-1">
                <span aria-hidden="true" className="text-faint">
                  /
                </span>
                <button
                  type="button"
                  onClick={() => navigateToDepth(index)}
                  aria-current={index === segments.length - 1 ? 'page' : undefined}
                  data-testid="page-file-browser-crumb"
                  data-depth={index}
                  className={cn(
                    'max-w-48 truncate rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                    index === segments.length - 1 && 'bg-muted text-foreground',
                  )}
                >
                  {segment}
                </button>
              </span>
            ))}
          </nav>

          <div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={preparingUpload}
              aria-busy={preparingUpload}
              data-testid="page-file-browser-upload-button"
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-primary px-2.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              {preparingUpload ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Upload className="size-4" aria-hidden="true" />
              )}
              上传
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              data-testid="page-file-browser-file-input"
              onChange={(event) => {
                void enqueueFiles(Array.from(event.target.files ?? []));
              }}
            />
          </div>

          <div
            data-testid="page-file-browser-list"
            className="overflow-hidden rounded-lg border border-border bg-card"
          >
            <div
              className={cn(
                rowGrid,
                'border-b border-border bg-muted/50 px-3 py-2 text-[11.5px] text-muted-foreground',
              )}
            >
              <span>名称</span>
              <span className="text-right font-mono tabular-nums">大小</span>
              <span className="text-right font-mono tabular-nums">修改时间</span>
            </div>

            {loading && entries.length === 0 && (
              <div
                data-testid="page-file-browser-loading"
                className="flex items-center gap-2 px-3 py-6 text-[12.5px] text-muted-foreground"
              >
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                正在读取…
              </div>
            )}

            {!loading && error !== null && (
              <div
                role="alert"
                data-testid="page-file-browser-error"
                className="px-3 py-6 text-[12.5px] text-destructive"
              >
                {error}
              </div>
            )}

            {uploads.map((item) => {
              const percent = transferPercent(item.loaded, item.total);
              const icon = resolveFileIconName(item.name);
              return (
                <div
                  key={item.id}
                  data-testid="page-file-browser-upload-row"
                  data-upload-name={item.name}
                  data-state={item.status}
                  className={cn(rowGrid, 'border-b border-border px-3 py-2 last:border-b-0')}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <img
                      src={fileIconUrl(icon) ?? fileIconUrl('file') ?? ''}
                      alt=""
                      loading="lazy"
                      className={cn(
                        'size-4 shrink-0',
                        (icon === 'file' || icon === 'folder') && 'opacity-70 dark:invert',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px]">{item.name}</span>
                        {percent !== null && (
                          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                            {percent}%
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => cancelUpload(item.id)}
                          title="取消上传"
                          aria-label={`取消上传 ${item.name}`}
                          data-testid="page-file-browser-upload-cancel-button"
                          className="ml-auto grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                        >
                          <X className="size-3" aria-hidden="true" />
                        </button>
                      </div>
                      <div
                        role="progressbar"
                        aria-label={`上传 ${item.name}`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={percent ?? undefined}
                        data-testid="page-file-browser-upload-progress"
                        className="mt-1 h-1 overflow-hidden rounded-full bg-muted"
                      >
                        <div
                          className="h-full rounded-full bg-primary transition-[width]"
                          style={{ width: `${percent ?? 0}%` }}
                        />
                      </div>
                    </div>
                  </div>
                  <span className="text-right font-mono text-[11.5px] tabular-nums text-muted-foreground">
                    {formatFileSize(item.size)}
                  </span>
                  <span className="text-right font-mono text-[11.5px] tabular-nums text-muted-foreground">
                    —
                  </span>
                </div>
              );
            })}

            {!loading &&
              error === null &&
              entries.length === 0 &&
              uploads.length === 0 && (
                <div
                  data-testid="page-file-browser-empty"
                  className="flex flex-col items-center gap-2 px-3 py-10 text-[12.5px] text-muted-foreground"
                >
                  <Folder className="size-6" aria-hidden="true" />
                  <span>空目录</span>
                </div>
              )}

            {entries.map((entry) => {
              const icon = resolveEntryIcon(entry);
              const generic = entry.kind === 'dir' ? 'folder' : 'file';
              const download = downloads.get(entry.name);
              const downloading = download !== undefined;
              const percent = download
                ? transferPercent(download.loaded, download.total)
                : null;
              return (
                <div
                  key={entry.name}
                  role="button"
                  tabIndex={0}
                  onClick={() => activateEntry(entry)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      activateEntry(entry);
                    }
                  }}
                  data-testid="page-file-browser-row"
                  data-name={entry.name}
                  data-kind={entry.kind}
                  className={cn(
                    rowGrid,
                    'cursor-pointer border-b border-border px-3 py-2 transition-colors last:border-b-0 hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <img
                      src={fileIconUrl(icon.icon) ?? fileIconUrl(generic) ?? ''}
                      alt=""
                      loading="lazy"
                      data-testid="page-file-browser-row-icon"
                      className={cn(
                        'size-4 shrink-0',
                        icon.fallback && 'opacity-70 dark:invert',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className="truncate text-[13px]"
                          title={entry.name}
                          data-testid="page-file-browser-row-name"
                        >
                          {entry.name}
                        </span>
                        {downloading && percent !== null && (
                          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                            {percent}%
                          </span>
                        )}
                      </div>
                      {downloading && (
                        <div
                          role="progressbar"
                          aria-label={`下载 ${entry.name}`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={percent ?? undefined}
                          data-testid="page-file-browser-download-progress"
                          className="mt-1 h-1 overflow-hidden rounded-full bg-muted"
                        >
                          <div
                            className="h-full rounded-full bg-primary transition-[width]"
                            style={{ width: `${percent ?? 0}%` }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                  <span
                    data-testid="page-file-browser-row-size"
                    className="text-right font-mono text-[11.5px] tabular-nums text-muted-foreground"
                  >
                    {entry.kind === 'dir' ? '—' : formatFileSize(entry.size)}
                  </span>
                  <span
                    data-testid="page-file-browser-row-mtime"
                    className="text-right font-mono text-[11.5px] tabular-nums text-muted-foreground"
                  >
                    {formatFileMtime(entry.mtime)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </DrawerShell>

      <ModalShell
        open={overwriteName !== null}
        title="覆盖文件"
        testId="page-file-browser-overwrite-dialog"
        onOpenChange={(next) => {
          if (!next) {
            settleOverwrite(false);
          }
        }}
        maxWidthPx={400}
        footer={
          <>
            <button
              type="button"
              onClick={() => settleOverwrite(false)}
              data-testid="page-file-browser-overwrite-cancel-button"
              className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-[13px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => settleOverwrite(true)}
              data-testid="page-file-browser-overwrite-confirm-button"
              className="inline-flex h-8 items-center justify-center rounded-lg border border-transparent bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              覆盖
            </button>
          </>
        }
      >
        <p className="text-[13px]">「{overwriteName}」已存在，确认覆盖？</p>
      </ModalShell>
    </>
  );
}
