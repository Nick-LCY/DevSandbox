import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Folder, Loader2, Upload, X } from 'lucide-react';

import { api } from '../../api/client';
import type { FileListEntry } from '../../api/types';
import { cn } from '../../lib/cn';
import {
  CANCELLED_MESSAGE,
  cancelDownload as cancelDesktopDownload,
  downloadToDisk,
  listenDownloadEvents,
  pickDownloadPath,
} from '../../lib/desktop-file';
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
  trimBreadcrumbLevels,
  type BreadcrumbTrim,
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
  /** 是否运行在桌面壳里（桌面形态下载 = 原生保存框 + Rust 落盘，见 `desktop-file.ts`）。 */
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

/**
 * 桌面下载标识的序号（**模块级**：面板重挂载后仍继续递增）。
 *
 * 不能放在组件 ref 里：卸载时取消是异步的（`cancel_download` 发出去就返回），
 * 重挂载再从 `dl-1` 开始会撞上「上一个 `dl-1` 还在收尾」——Rust 侧按标识登记
 * 在途任务，重复标识会直接报错。
 */
let desktopDownloadSeq = 0;

/**
 * 本次**页面会话**的随机前缀：整页刷新会重置模块级计数器，但 Rust 侧上一个
 * 下载可能还在收尾——加随机前缀保证「刷新前后」的下载标识也不撞。
 */
const desktopDownloadSessionPrefix = Math.random().toString(36).slice(2, 8);

function nextDesktopDownloadId(): string {
  desktopDownloadSeq += 1;
  return `dl-${desktopDownloadSessionPrefix}-${desktopDownloadSeq}`;
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
 * 面包屑层级之间的间距（`gap-1` = 0.25rem = 4px）。
 *
 * 量宽模型里要用到它（省略号也是一格，格子之间同样有间距），所以写成常量：
 * 改布局时**这里要跟着改**，否则裁剪口径与实际渲染对不上。
 */
const CRUMB_GAP_PX = 4;

/**
 * 面包屑里**可点元素**（根图标钮 / 父级层级钮 / 量宽行里的对应格）**共用**的
 * 类名片段。
 *
 * 抽成常量是为了消除手抄漂移：三处必须保持同一套焦点环与过渡节奏，
 * 改一处就要改三处。
 *
 * **只给可点元素用**：当前层级是**纯文本**（不可点、无焦点环、不进 tab 序），
 * 不挂这套类名。
 *
 * 两句口径（写在代码里，免得下次又踩）：
 * - **类名的书写顺序与谁覆盖谁无关**：Tailwind 变体之间的覆盖由**特异度**决定，
 *   不是看 className 里谁写在后面；
 * - **jsdom 用例只能钉类名字符串**，验不了视觉（下划线画没画出来、底色亮不亮
 *   都验不了）——所以单测只钉「关系」（同高、有变体、无第二套真值），
 *   视觉口径靠 e2e 与人眼。
 */
const CRUMB_LINK_CLASS =
  'transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none';

/**
 * 有文字的层级按钮的链接样式（可见行与量宽行共用）。
 *
 * **只给有文字的元素用**：`text-decoration` 不向 flex item 的后代传播，
 * 根图标钮（`inline-flex` + 纯图标）挂 `hover:underline` 也**画不出下划线**
 * ——根钮的 hover 反馈走 `hover:bg-muted hover:text-foreground`（底色 / 变色）。
 */
const CRUMB_TEXT_LINK_CLASS = 'text-primary underline-offset-4 hover:underline';

/**
 * **父级**层级（有文字、可点）的类名（可见行与量宽行**必须同一套**，
 * 量到的才是真实宽度）。
 *
 * 样式口径：
 * - **父级用链接样式**（`CRUMB_TEXT_LINK_CLASS`，对齐 `ui/button.tsx` 的
 *   link variant），不再用按钮底色 hover；
 * - **当前层级不用这套**（见 `CRUMB_CURRENT_TEXT_CLASS`）：当前级是纯文本，
 *   不可点 ⇒ 没有 hover / 下划线 / 底色 / 焦点环；
 * - 分隔符 `/` 与省略号用 `text-faint`。
 */
const CRUMB_BUTTON_CLASS =
  'max-w-48 truncate rounded-md px-1.5 py-0.5 ' + CRUMB_TEXT_LINK_CLASS;

/**
 * **当前层级**的纯文本样式（可见行与量宽行**必须同一套**，量到的才是真实宽度）。
 *
 * 口径（用户拍板）：当前层级**不是按钮**——不可点、无 hover / 无下划线 /
 * 无底色 / 无焦点环 / 不进 tab 序 ⇒ 只留可读文字色（`text-foreground`）与
 * `truncate`。
 *
 * **按钮的 padding（`px-1.5 py-0.5`）也一并去掉**：量宽行同步去掉（同一套
 * 类名）⇒ 两侧宽度基准一致，省略号的裁剪口径不漂。
 */
const CRUMB_CURRENT_TEXT_CLASS = 'max-w-48 truncate text-foreground';

/**
 * 运行期文件浏览面板（独立抽屉）。
 *
 * 口径：
 * - 列表三列：图标 + 名称 / 大小 / 修改时间（无类型列）；文件夹在前、隐藏文件照常显示；
 * - **点击文件行本身即下载**（没有下载按钮）；
 * - 上传只进**当前浏览目录**（无路径输入框）；多文件排队逐个传，行内进度 + 可取消；
 * - 同名**文件**先弹覆盖确认；同名**目录**交给服务端 400（不弹确认框）；
 * - 面包屑**父级**可点击；**当前层级是纯文本**（不可点、无按钮样式）；
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
  /** 桌面形态在途下载（文件名 → 下载标识 + 取消订阅）。 */
  const desktopDownloadsRef = useRef<Map<string, { id: string; unsubscribe: () => void }>>(
    new Map(),
  );
  /** 桌面形态正在弹保存框的文件名（防重复点击开出两个保存框）。 */
  const desktopPendingRef = useRef<Set<string>>(new Set());
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
    // 桌面形态在途下载：退掉进度订阅 + 让 Rust 侧停流并删临时文件。
    for (const item of desktopDownloadsRef.current.values()) {
      item.unsubscribe();
      void cancelDesktopDownload(item.id).catch(() => {
        // 收口阶段失败不提示：任务可能已经自己结束了（幂等取消）。
      });
    }
    desktopDownloadsRef.current.clear();
    desktopPendingRef.current.clear();
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

  /**
   * 统一导航入口。
   *
   * **同路径必须强制重读**：`setPath` 传同值时 React 会 bail out（不重渲染），
   * 于是「当前目录变化就重读列表」的 effect 不会重跑——列表被清空成
   * 「空目录」（点根 crumb 回根、点当前层级 crumb 都会踩到：先 `setEntries([])`，
   * 路径又没变，列表就永远停在空数组上）。
   * 所以同路径时**绕开 setState，直接重读一次**。
   */
  const goToPath = useCallback(
    (next: string): void => {
      const target = next === '' ? '/' : next;
      if (target === pathRef.current) {
        void loadDirectory(target);
        return;
      }
      setEntries([]);
      // 清空的同时进加载态：不让「空目录」在换目录的间隙闪一下。
      setLoading(true);
      setPath(target);
    },
    [loadDirectory],
  );

  const enterDirectory = useCallback(
    (name: string) => {
      const next = childContainerPath(pathRef.current, name);
      if (next !== null) {
        goToPath(next);
      }
    },
    [goToPath],
  );

  const navigateToDepth = useCallback(
    (depth: number) => {
      const current = splitContainerPath(pathRef.current);
      // depth < 0 = 根目录（显式归一，不靠 slice 的巧合）。
      const next = depth < 0 ? '/' : joinContainerPath(current.slice(0, depth + 1));
      goToPath(next);
    },
    [goToPath],
  );

  const navigateToRoot = useCallback(() => {
    goToPath('/');
  }, [goToPath]);

  const segments = splitContainerPath(path);

  /* ---------------------------------------------------------- 面包屑排版 */

  /** 可见层级区（同时是量宽基准）：`flex-1 min-w-0` → 宽度 = 导航行剩下的空间。 */
  const crumbLevelsRef = useRef<HTMLDivElement | null>(null);
  /** 量宽用的隐藏行：渲染**全部**层级，量完再决定可见行留哪些。 */
  const crumbMeasureRef = useRef<HTMLDivElement | null>(null);
  /** 观察可见层级区宽度变化的观察器（**节点挂上才建**、节点卸载就收）。 */
  const crumbObserverRef = useRef<ResizeObserver | null>(null);
  /** 量宽去抖的 rAF 句柄（拖拽调宽时每帧最多量一次）。 */
  const crumbFrameRef = useRef<number | null>(null);
  /** 最新的量宽函数（回调 ref 与观察器回调都读它）。 */
  const crumbLayoutRef = useRef<() => void>(() => {});
  const [crumbTrim, setCrumbTrim] = useState<BreadcrumbTrim | null>(null);

  /**
   * 量宽 → 裁剪（面包屑的溢出逻辑在 `trimBreadcrumbLevels` 里，这里只喂数据）。
   *
   * - 可用宽度：可见层级区的**边框盒宽度**（`getBoundingClientRect().width`）。
   *   用它而不是 `clientWidth`：后者是**取整的整数**，与下面量到的元素宽度
   *   （小数）不是同一口径，会带来 0.5px 级的误差；
   * - 各级宽度：隐藏量宽行里**同一套类名**的整格宽度。
   *   用 `offsetWidth` 而不是 `scrollWidth`：层级名带 `truncate`，
   *   `scrollWidth` 是**未截断**的内容宽度，量它会把长名字算宽。
   */
  const applyCrumbLayout = useCallback((): void => {
    const levelsBox = crumbLevelsRef.current;
    const measureBox = crumbMeasureRef.current;
    if (!levelsBox || !measureBox) {
      return;
    }
    const available = levelsBox.getBoundingClientRect().width;
    if (!Number.isFinite(available) || available <= 0) {
      // 宽度还没量出来（首帧 / 未布局）：不裁剪，等下一次量。
      return;
    }
    const widthOf = (node: HTMLElement | null): number => {
      if (!node) {
        return 0;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 ? rect.width : node.offsetWidth;
    };
    const widths: number[] = [];
    measureBox.querySelectorAll<HTMLElement>('[data-crumb-level]').forEach((node) => {
      widths.push(widthOf(node));
    });
    const next = trimBreadcrumbLevels(available, widths, {
      ellipsisWidth: widthOf(measureBox.querySelector<HTMLElement>('[data-crumb-ellipsis]')),
      gapWidth: CRUMB_GAP_PX,
    });
    setCrumbTrim((prev) => {
      if (prev === null) {
        return next;
      }
      return prev.start === next.start && prev.end === next.end && prev.ellipsis === next.ellipsis
        ? prev
        : next;
    });
  }, []);

  /**
   * 渲染期同步「最新量宽函数」。
   *
   * 为什么不能放进 effect：回调 ref 在 **commit 阶段**就跑（早于 passive effect），
   * 放进 effect 会让「节点一挂上就量一次」拿到的是**上一次**的实现。
   * 赋的是同一份稳定引用，渲染期赋值是幂等的。
   */
  crumbLayoutRef.current = applyCrumbLayout;

  /** 去抖后的量宽（拖拽调宽时每帧只量一次，避免每帧强制回流）。 */
  const scheduleCrumbLayout = useCallback((): void => {
    if (crumbFrameRef.current !== null) {
      return;
    }
    crumbFrameRef.current = window.requestAnimationFrame(() => {
      crumbFrameRef.current = null;
      crumbLayoutRef.current();
    });
  }, []);

  /**
   * 量宽基准节点的**回调 ref**。
   *
   * 为什么不能用 `useRef` + effect：抽屉关闭时 Base UI 的 portal **不渲染内容**
   * （`keepMounted=false`），而面板是**常驻挂载**的 ⇒ 面板挂载那一刻节点还不存在
   * ⇒ effect 里的 `ref.current` 恒为 `null` ⇒ 观察器**永远建不起来**，
   * 首次打开也不量宽（deps 再也不变 ⇒ effect 不会重跑）。
   *
   * 回调 ref 拿到的正是「节点真正出现的时刻」：
   * - 节点挂上（= 抽屉打开、DOM 出现）→ 挂观察器 + **立即量一次**；
   * - 节点卸载（= 抽屉关闭）→ `disconnect` 并清引用。
   */
  const attachLevelsBox = useCallback(
    (node: HTMLDivElement | null): void => {
      // 旧观察器收掉（节点换掉 / 抽屉关闭 / 量宽实现换了）。
      crumbObserverRef.current?.disconnect();
      crumbObserverRef.current = null;
      crumbLevelsRef.current = node;
      if (node === null) {
        return;
      }
      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => {
          scheduleCrumbLayout();
        });
        observer.observe(node);
        crumbObserverRef.current = observer;
      }
      // 节点刚出现：立刻量一次（不等 ResizeObserver 的首拍）。
      crumbLayoutRef.current();
    },
    [scheduleCrumbLayout],
  );

  /**
   * 量宽行的回调 ref：它与层级区是**兄弟节点**、挂得更晚 ⇒ 挂上时补量一次
   * （否则层级区先挂上那一刻量宽行还不存在，量不到任何东西）。
   */
  const attachMeasureBox = useCallback((node: HTMLDivElement | null): void => {
    crumbMeasureRef.current = node;
    if (node !== null) {
      crumbLayoutRef.current();
    }
  }, []);

  // 路径变了要重量一次（层级宽度变了）：先按「全部保留」画，再量。
  useLayoutEffect(() => {
    setCrumbTrim(null);
    applyCrumbLayout();
  }, [path, applyCrumbLayout]);

  /**
   * 量宽实现换了（依赖变化）→ **旧观察器换新**：用新实现重建观察器并重量一次。
   *
   * 当前 `applyCrumbLayout` 的依赖为空（实现是稳定的），这条路径平时不跑；
   * 但它保证了「实现变了就换观察器」这条约束不靠口头约定。
   */
  const prevCrumbLayoutRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const previous = prevCrumbLayoutRef.current;
    prevCrumbLayoutRef.current = applyCrumbLayout;
    if (previous === null || previous === applyCrumbLayout) {
      return;
    }
    const node = crumbLevelsRef.current;
    if (node === null) {
      return;
    }
    attachLevelsBox(node);
  }, [applyCrumbLayout, attachLevelsBox]);

  // 自托管字体 swap 晚到会让量到的宽度失真（量的是回退字形的宽度）：
  // 字体就绪后补量一次（照 TerminalView 的现成处理）。
  useEffect(() => {
    if (!document.fonts) {
      return;
    }
    let cancelled = false;
    void document.fonts.ready
      .then(() => {
        if (cancelled) {
          return;
        }
        applyCrumbLayout();
      })
      .catch(() => {
        // 字体加载失败：保持现状，等下一次观察器回调。
      });
    return () => {
      cancelled = true;
    };
  }, [applyCrumbLayout]);

  // 卸载时收掉 rAF（别让回调落在已卸载的组件上）。
  useEffect(
    () => () => {
      if (crumbFrameRef.current !== null) {
        window.cancelAnimationFrame(crumbFrameRef.current);
        crumbFrameRef.current = null;
      }
    },
    [],
  );

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

  /**
   * 桌面形态下载：原生保存框选路径 → Rust 带令牌流式下载落盘。
   *
   * - 保存框取消 = **静默返回**（不弹提示、不发下载命令）；
   * - 进度走同一个行内 `downloads` Map（事件驱动，载荷里带已写 / 总字节）；
   * - 成功 toast 带**落盘路径**；失败 toast 用 Rust 的固定中文文案；
   * - 关闭抽屉 / 切沙箱时由 `abortTransfers` 调 `cancel_download` 收口
   *   （临时文件由 Rust 侧删除，不留半截文件）。
   */
  const startDesktopDownload = useCallback(
    async (entry: FileListEntry, targetPath: string): Promise<void> => {
      if (desktopDownloadsRef.current.has(entry.name) || desktopPendingRef.current.has(entry.name)) {
        return;
      }
      desktopPendingRef.current.add(entry.name);
      const generation = generationRef.current;
      const downloadId = nextDesktopDownloadId();

      let target: string | null;
      try {
        target = await pickDownloadPath(entry.name);
        if (target === null) {
          // 用户取消保存框：静默返回。
          return;
        }
        if (generation !== generationRef.current || !openRef.current) {
          return;
        }

        // 先订阅事件再发命令：大文件的第一块可能在命令返回前就到了。
        let unsubscribe: () => void = () => {};
        try {
          unsubscribe = await listenDownloadEvents(sandbox, downloadId, (event) => {
            if (event.phase !== 'progress' && event.phase !== 'done') {
              return;
            }
            setDownloads((current) => {
              if (!current.has(entry.name)) {
                return current;
              }
              const next = new Map(current);
              next.set(entry.name, {
                name: entry.name,
                loaded: event.loaded,
                total: event.total,
              });
              return next;
            });
          });
        } catch (exc) {
          // 进度订阅失败不拦死下载：降级成「只有开始 / 结束」，但要留痕。
          console.warn(
            '[file-browser] 订阅桌面下载进度失败，进度显示降级（下载仍会执行）。',
            exc,
          );
        }

        // 订阅是 IPC 往返：这段窗口里抽屉可能已经关了 / 换了沙箱。此时**不发下载命令**
        // （否则会凭空起一个没人要的下载，也没人给它发取消），退订后直接退出。
        if (generation !== generationRef.current || !openRef.current) {
          unsubscribe();
          return;
        }

        const slot = { id: downloadId, unsubscribe };
        desktopDownloadsRef.current.set(entry.name, slot);
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
          const result = await downloadToDisk({
            sandbox,
            path: targetPath,
            targetPath: target,
            downloadId,
          });
          if (
            generation === generationRef.current &&
            openRef.current &&
            desktopDownloadsRef.current.get(entry.name) === slot
          ) {
            show('success', `已下载 ${entry.name} 到 ${result.target_path || target}`, {
              source: 'file-browser',
            });
          }
        } catch (exc) {
          // 抽屉关了 / 切了沙箱 / 主动取消：静默收口（Rust 的取消文案不弹失败 toast）。
          if (
            generation === generationRef.current &&
            openRef.current &&
            desktopDownloadsRef.current.get(entry.name) === slot &&
            errorMessage(exc) !== CANCELLED_MESSAGE
          ) {
            show('error', errorMessage(exc), { source: 'file-browser' });
          }
        } finally {
          unsubscribe();
          if (desktopDownloadsRef.current.get(entry.name) === slot) {
            desktopDownloadsRef.current.delete(entry.name);
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
      } catch (exc) {
        // 保存框自身失败（桌面壳缺 dialog 权限 / 老版本没有这条命令）。
        if (generation === generationRef.current && openRef.current) {
          show('error', errorMessage(exc), { source: 'file-browser' });
        }
      } finally {
        desktopPendingRef.current.delete(entry.name);
      }
    },
    [sandbox, show],
  );

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
        // 桌面形态：原生保存框 + Rust 落盘（见 `startDesktopDownload`）。
        void startDesktopDownload(entry, targetPath);
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
    [desktop, sandbox, show, startDesktopDownload],
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
        {/*
          面板根：**撑满抽屉正文**（`h-full`）+ 列表自己内部滚动，
          抽屉本体不再被内容撑出滚动条。
        */}
        <div className="flex h-full min-h-0 flex-col gap-3">
          {/* 行：面包屑（占满剩余宽度）+ 上传按钮（定宽，同高 h-8） */}
          <div className="flex flex-none items-center gap-2">
            <nav
              aria-label="路径"
              data-testid="page-file-browser-crumbs"
              className="relative flex h-8 min-w-0 flex-1 items-center gap-1 overflow-hidden rounded-lg border border-border bg-muted/40 px-2 text-[12.5px]"
            >
              {/*
                根目录：
                - **父级**（当前不在根）→ 可点按钮：hover 底色 / 变色
                  （纯图标钮挂不出下划线 ⇒ hover 反馈走底色 / 变色）；
                - **当前级**（当前就在根）→ **静态图标**（span 包 icon）：
                  不可点、无 hover 变色、无下划线、不进 tab 序；
                  `aria-current="page"` 仍留在 span 上（e2e 断言依赖它），
                  `data-testid` / `data-depth` 保持原值。
              */}
              {segments.length === 0 ? (
                <span
                  title="根目录"
                  aria-label="根目录"
                  aria-current="page"
                  data-testid="page-file-browser-crumb"
                  data-depth="-1"
                  className="inline-flex size-6 shrink-0 items-center justify-center text-foreground"
                >
                  <Folder className="size-3.5" aria-hidden="true" />
                </span>
              ) : (
                <button
                  type="button"
                  onClick={navigateToRoot}
                  title="根目录"
                  aria-label="根目录"
                  data-testid="page-file-browser-crumb"
                  data-depth="-1"
                  className={cn(
                    'inline-flex size-6 shrink-0 items-center justify-center rounded-md',
                    CRUMB_LINK_CLASS,
                    // 纯图标钮**挂不出下划线**（`text-decoration` 不向 flex item
                    // 的后代传播）→ hover 反馈走底色 / 变色。
                    'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Folder className="size-3.5" aria-hidden="true" />
                </button>
              )}

              {/*
                层级区：`flex-1 min-w-0` → 宽度 = 导航行剩下的空间（量宽基准）。
                放不下时浅层级收进省略号，**保留靠近当前目录的深层级**。
              */}
              <div
                ref={attachLevelsBox}
                className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
              >
                {crumbTrim?.ellipsis === true && (
                  <span
                    aria-hidden="true"
                    data-testid="page-file-browser-crumb-ellipsis"
                    className="shrink-0 text-faint"
                  >
                    …
                  </span>
                )}
                {segments.slice(crumbTrim?.start ?? 0).map((segment, offset) => {
                  const index = (crumbTrim?.start ?? 0) + offset;
                  const isCurrent = index === segments.length - 1;
                  return (
                    <span
                      key={`${index}-${segment}`}
                      className="flex min-w-0 items-center gap-1"
                    >
                      <span aria-hidden="true" className="shrink-0 text-faint">
                        /
                      </span>
                      {isCurrent ? (
                        /*
                          **当前层级**：纯文本（span）——不可点、无 hover /
                          下划线 / 底色 / 焦点环、不进 tab 序；
                          `aria-current="page"` 留在 span 上（e2e 断言依赖它），
                          `data-testid` / `data-depth` 保持原值。
                        */
                        <span
                          aria-current="page"
                          data-testid="page-file-browser-crumb"
                          data-depth={index}
                          className={CRUMB_CURRENT_TEXT_CLASS}
                        >
                          {segment}
                        </span>
                      ) : (
                        /* 父级：可点的链接样式钮（`text-primary` + hover 下划线）。 */
                        <button
                          type="button"
                          onClick={() => navigateToDepth(index)}
                          data-testid="page-file-browser-crumb"
                          data-depth={index}
                          className={cn(CRUMB_LINK_CLASS, CRUMB_BUTTON_CLASS)}
                        >
                          {segment}
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>

              {/*
                量宽用的隐藏行：渲染**全部**层级（可见行只留裁剪后的那些），
                量到的宽度与可见行同一套类名 ⇒ 同一套渲染宽度。
                `visibility: hidden` 不参与布局但保留盒子尺寸（可量）。

                a11y：整行 `aria-hidden` + `pointer-events-none`，里面**不放可聚焦
                元素**——层级名用 `<span>`（配 `inline-block` 与按钮同宽），
                不是真 `<button>`（`aria-hidden` 里有可聚焦元素是 a11y 硬伤）。

                **当前层级在量宽行里也用同一套纯文本类名**
                （`CRUMB_CURRENT_TEXT_CLASS`，与可见侧一致）⇒ 按钮 padding
                两侧都去掉，量到的宽度 = 真实渲染宽度，省略号口径不漂。
              */}
              <div
                ref={attachMeasureBox}
                aria-hidden="true"
                className="pointer-events-none invisible absolute left-0 top-0 flex h-0 w-max items-center gap-1 overflow-hidden"
              >
                <span data-crumb-ellipsis className="shrink-0 text-faint">
                  …
                </span>
                {segments.map((segment, index) => {
                  const isCurrent = index === segments.length - 1;
                  return (
                    <span
                      key={`measure-${index}-${segment}`}
                      data-crumb-level={index}
                      className="flex items-center gap-1"
                    >
                      <span aria-hidden="true" className="shrink-0 text-faint">
                        /
                      </span>
                      {isCurrent ? (
                        /*
                          当前层级：与可见侧**同一套**纯文本类名
                          （`CRUMB_CURRENT_TEXT_CLASS`）⇒ 量到的宽度 =
                          真实渲染宽度（按钮 padding 两侧都去掉了）。
                        */
                        <span className={CRUMB_CURRENT_TEXT_CLASS}>{segment}</span>
                      ) : (
                        <span
                          className={cn(CRUMB_LINK_CLASS, CRUMB_BUTTON_CLASS, 'inline-block')}
                        >
                          {segment}
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>
            </nav>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={preparingUpload}
              aria-busy={preparingUpload}
              data-testid="page-file-browser-upload-button"
              className="inline-flex h-8 flex-none items-center justify-center gap-1.5 rounded-lg border border-transparent bg-primary px-2.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
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

          {/*
            列表：**自己内部滚动**（`flex-1 min-h-0 overflow-y-auto`），
            表头 sticky 住（行内进度行随列表滚动，不固定）。
            横向用 `overflow-x-auto`（不是 `hidden`）：窄抽屉（1280px 视口下
            256px 宽）里 `hidden` 会把「修改时间」列直接切掉，滚动兜底更稳。
          */}
          <div
            data-testid="page-file-browser-list"
            className="min-h-0 flex-1 overflow-x-auto overflow-y-auto rounded-lg border border-border bg-card"
          >
            <div
              className={cn(
                rowGrid,
                'sticky top-0 z-10 border-b border-border bg-card px-3 py-2 text-[11.5px] text-muted-foreground',
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
