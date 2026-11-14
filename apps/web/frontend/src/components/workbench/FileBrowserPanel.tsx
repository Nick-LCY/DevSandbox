import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Copy,
  Crosshair,
  Eye,
  FileWarning,
  Folder,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Upload,
  X,
} from 'lucide-react';

import { api, TextNotPreviewableError } from '../../api/client';
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
  currentPreview,
  isLargePreviewFile,
  previewStackReducer,
  splitPreviewLines,
  type PreviewTarget,
} from '../../lib/file-preview';
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
import { isSameContainerPath, resolveFilePaneStartPath } from '../../lib/file-pane';
import { getSessionPwd, subscribeSessionPwd } from '../../lib/terminal-pwd';
import { useToast } from '../Toast';
import { ModalShell } from './ModalShell';
import { PreviewConfirmDialog } from './PreviewConfirmDialog';
import { PreviewLoading } from './PreviewLoading';

interface FileBrowserPanelProps {
  /** 沙箱名（三条文件端点都挂在它下面）。 */
  sandbox: string;
  /**
   * 锚定的终端会话标识。
   *
   * `null` = 没有终端会话 ⇒ **窗格整体不出现**（父组件不渲染本组件）。
   * 换会话 ⇒ 窗格重新按 fallback 链定位（窗格锚定当前激活的终端会话）。
   */
  sessionId: string | null;
  /** 沙箱工作目录（metadata `workdir`）：定位 fallback 链的第二级。 */
  workdir: string;
  /** 是否折叠（折叠 = 右缘 36px 纯图标竖条）。 */
  collapsed: boolean;
  /** 折叠 / 展开切换（父组件负责落盘）。 */
  onToggleCollapsed: () => void;
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

/** 复制成功的对勾显示时长（毫秒）：图标变对勾约 1 秒后复原。 */
const COPY_FEEDBACK_MS = 1000;

/** 二进制文件的固定文案（PRD PV-05）。 */
const BINARY_PREVIEW_MESSAGE = '二进制文件无法预览';

/** 预览（窗格内第二视图）的状态。 */
type PreviewStatus = 'loading' | 'ready' | 'unsupported' | 'error';

interface PreviewView {
  status: PreviewStatus;
  /** 正文文本（`ready` 时有效）。 */
  text: string;
  /** 已接收字节数（进度条分子）。 */
  loaded: number;
  /** 总字节数（进度条分母；列表条目的 `size` 或响应头 `X-File-Size`）。 */
  total: number | null;
  /** `unsupported` / `error` 的文案。 */
  message: string | null;
  /** 是否走大文件流程（> 2 MB ⇒ 加载时显示进度条）。 */
  large: boolean;
}

/** 预览视图的初始态（列表态不渲染它）。 */
const EMPTY_PREVIEW_VIEW: PreviewView = {
  status: 'loading',
  text: '',
  loaded: 0,
  total: null,
  message: null,
  large: false,
};

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

interface FilePreviewViewProps {
  /** 当前预览目标（栈顶）。 */
  target: PreviewTarget;
  /** 返回栈是否非空；**栈空（列表态）时隐藏返回钮**。 */
  canGoBack: boolean;
  /** 预览载荷状态。 */
  view: PreviewView;
  /** 复制成功的对勾是否在显示（约 1 秒后复原）。 */
  copied: boolean;
  onBack: () => void;
  onCopy: () => void;
  onDownload: () => void;
}

/**
 * 预览视图（**窗格内的第二视图**，不是弹层、不是抽屉）。
 *
 * 构图（PRD PV-02 / PV-03 / PV-04 / PV-05）：
 *
 * - 工具条 = **返回** + 文件名 / 大小 + **复制**；返回钮在栈空时**不渲染**；
 * - 正文 = **等宽字体 + 行号槽**，**全文渲染**（不做虚拟化：用户已拍板大文件
 *   全量加载进内存）；
 * - **`.md` 一律纯文本**（这里压根没有任何 markdown 渲染能力）；
 * - **大文件（> 2 MB）**：加载时给**进度条**（已接收字节 / 总大小）；小文件只有
 *   一行「正在读取…」，**不出现进度条**；
 * - **二进制 / 非 UTF-8**：空态构图（居中线框图标 + 文案 + 描边「下载文件」钮）。
 * - **不存在任何「文件过大，仅展示前 N KB」提示条**（PRD 明令删除）。
 */
function FilePreviewView({
  target,
  canGoBack,
  view,
  copied,
  onBack,
  onCopy,
  onDownload,
}: FilePreviewViewProps) {
  const lines = view.status === 'ready' ? splitPreviewLines(view.text) : [];
  const toolButton =
    'grid size-8 flex-none place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none';

  return (
    <div
      data-testid="page-file-preview"
      className="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-2"
    >
      {/* 工具条：返回 + 文件名 / 大小 + 复制 */}
      <div className="flex flex-none items-center gap-1.5">
        {canGoBack && (
          <button
            type="button"
            onClick={onBack}
            title="返回"
            aria-label="返回"
            data-testid="page-file-preview-back-button"
            className={toolButton}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </button>
        )}
        <span
          data-testid="page-file-preview-title"
          title={target.name}
          className="min-w-0 flex-1 truncate text-[13px] font-medium"
        >
          {target.name}
        </span>
        <span
          data-testid="page-file-preview-size"
          className="flex-none font-mono text-[11.5px] tabular-nums text-muted-foreground"
        >
          {formatFileSize(target.size)}
        </span>
        <button
          type="button"
          onClick={onCopy}
          disabled={view.status !== 'ready'}
          title={copied ? '已复制' : '复制'}
          aria-label={copied ? '已复制' : '复制'}
          data-testid="page-file-preview-copy-button"
          className={cn(
            toolButton,
            'disabled:pointer-events-none disabled:opacity-50',
          )}
        >
          {copied ? (
            <Check className="size-4" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>

      {view.status === 'loading' && (
        /* 大文件给进度条、小文件只有一行「正在读取…」（共用组件，口径见
           `PreviewLoading`；标识仍是文件窗格那一套）。 */
        <PreviewLoading
          name={target.name}
          large={view.large}
          loaded={view.loaded}
          total={view.total}
        />
      )}

      {view.status === 'error' && (
        <div
          role="alert"
          data-testid="page-file-preview-error"
          className="rounded-lg border border-border bg-card px-3 py-4 text-[12.5px] text-destructive"
        >
          {view.message}
        </div>
      )}

      {view.status === 'unsupported' && (
        /* 二进制 / 非 UTF-8：空态构图（居中线框图标 + 文案 + 描边「下载文件」） */
        <div
          data-testid="page-file-preview-unsupported"
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-border bg-card px-3 text-center"
        >
          <FileWarning className="size-8 text-muted-foreground" aria-hidden="true" />
          <p className="text-[13px] text-muted-foreground">{view.message}</p>
          <button
            type="button"
            onClick={onDownload}
            data-testid="page-file-preview-download-button"
            className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-[13px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            下载文件
          </button>
        </div>
      )}

      {view.status === 'ready' &&
        (lines.length === 0 ? (
          <div
            data-testid="page-file-preview-body"
            className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-card px-3 py-2 font-mono text-[12px] text-muted-foreground"
          >
            空文件
          </div>
        ) : (
          /* 全文渲染 + 行号槽（等宽字体；不做虚拟化） */
          <div
            data-testid="page-file-preview-body"
            className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-card py-1 font-mono text-[12px] leading-5"
          >
            {lines.map((line, index) => (
              <div key={index} className="flex">
                <span
                  aria-hidden="true"
                  data-testid="page-file-preview-line-number"
                  className="w-10 shrink-0 select-none border-r border-border pr-2 text-right text-[11px] tabular-nums text-faint"
                >
                  {index + 1}
                </span>
                <span
                  data-testid="page-file-preview-line"
                  className="whitespace-pre px-2 pr-3"
                >
                  {line}
                </span>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

/**
 * 运行期文件浏览面板（**终端旁的窗格**，不再是抽屉）。
 *
 * 形态口径（PRD「方案一 · 文件窗格」）：
 * - 窗格是**终端 tab 的伴生物**：只在「存在终端会话且激活的是终端 tab」时出现
 *   （入口条件由父组件判定，见 `shouldShowFilePane`）；
 * - 定位走 **会话 pwd → 沙箱 workdir → `/`** 的 fallback 链（只用来**首次定位**）；
 * - **无自动跟随**：shell 里 `cd` 之后窗格目录**一动不动**——唯一的联动入口是
 *   工具条上的「回跳」准星按钮；
 * - 折叠成右缘 **36px 纯图标竖条**（竖条上只有**顶部**的展开按钮）；
 *
 * 视觉合并（用户浏览器复验修复轮，2026-11-14）：窗格与终端**零间隙**贴成一块——
 * 窗格改**四边完整 border + 仅右侧圆角**（左缘直角贴终端），面板根不再自带
 * 内边距（padding 下放到工具条行）；列表态**拍平**：固定工具条 + 固定列表头，
 * 下方条目列表整块直通滚动、贴满窗格（行 hover 高亮满宽）。
 *
 * 面板自身的能力（沿用抽屉时期的那一套，行为不变）：
 * - 列表三列：图标 + 名称 / 大小 / 修改时间（无类型列）；文件夹在前、隐藏文件照常显示；
 * - **点击文件行本身即下载**（没有下载按钮）；
 * - 上传只进**当前浏览目录**（无路径输入框）；多文件排队逐个传，行内进度 + 可取消；
 * - 同名**文件**先弹覆盖确认；同名**目录**交给服务端 400（不弹确认框）；
 * - 面包屑**父级**可点击；**当前层级是纯文本**（不可点、无按钮样式）；
 * - 界面没有副标题 / 解释说明性文字。
 */
export function FileBrowserPanel({
  sandbox,
  sessionId,
  workdir,
  collapsed,
  onToggleCollapsed,
  desktop,
}: FileBrowserPanelProps) {
  const { show } = useToast();
  const [path, setPath] = useState<string>(() =>
    resolveFilePaneStartPath({
      pwd: sessionId ? getSessionPwd(sessionId) : null,
      workdir,
    }),
  );
  const [entries, setEntries] = useState<FileListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [downloads, setDownloads] = useState<Map<string, DownloadItem>>(() => new Map());
  const [overwriteName, setOverwriteName] = useState<string | null>(null);
  const [preparingUpload, setPreparingUpload] = useState(false);
  /** 预览返回栈（**空栈 = 列表态**）。 */
  const [previewStack, setPreviewStack] = useState<PreviewTarget[]>([]);
  /** 预览载荷（加载中 / 正文 / 二进制 / 失败）。 */
  const [previewView, setPreviewView] = useState<PreviewView>(EMPTY_PREVIEW_VIEW);
  /** 大文件二次确认的目标（`null` = 没有弹框）。 */
  const [previewConfirm, setPreviewConfirm] = useState<PreviewTarget | null>(null);
  /** 复制成功的对勾是否在显示（约 1 秒后复原）。 */
  const [copied, setCopied] = useState(false);
  /** 「刷新」按钮的瞬时 loading（旋转 + 禁用）：重读落地前按钮不重复响应。 */
  const [refreshing, setRefreshing] = useState(false);
  /**
   * 当前会话上报的工作目录（pwd）。
   *
   * **连会话标识一起存**：`sessionPwd` 是派生值（只有键对得上才算数）——
   * 换会话的那一提交里，state 里还是上一个会话的 pwd，不能拿它给新会话定位。
   * `null` = **该会话没上报**（如 `dash` / `sh` 会话）⇒ 回跳按钮禁用，
   * tooltip 改为「当前会话未上报工作目录」。
   */
  const [pwdState, setPwdState] = useState<{ sessionId: string | null; pwd: string | null }>(
    () => ({
      // 同步读缓存做初始值：pwd 已缓存时，挂载首帧就是正确状态
      // （否则会先闪一帧「当前会话未上报工作目录」，见下方 layout effect 注释）。
      sessionId,
      pwd: sessionId ? getSessionPwd(sessionId) : null,
    }),
  );
  const sessionPwd = pwdState.sessionId === sessionId ? pwdState.pwd : null;

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
  /** 在途的预览读取（换目录 / 换会话 / 卸载 / 换沙箱时 abort）。 */
  const previewControllerRef = useRef<AbortController | null>(null);
  /** 复制对勾的复原定时器。 */
  const copyTimerRef = useRef<number | null>(null);
  /** 组件是否还活着（卸载 / 换沙箱后不再提示、不再发请求）。 */
  const aliveRef = useRef(true);
  /** 换沙箱 / 卸载的代次：旧队列 / 旧确认框的后续逻辑据此退出。 */
  const generationRef = useRef(0);
  /** 当前 `entries` 是否来自当前目录的一次成功读取（否则不能用来判同名）。 */
  const listTrustedRef = useRef(false);
  const listPathRef = useRef<string | null>(null);
  /** 用户是否导航过（导航过之后就不再被 pwd 定位带走）。 */
  const userNavigatedRef = useRef(false);
  /** 是否已经用会话 pwd 定位过（**定位只做一次**，见 PRD FP-06）。 */
  const pwdPositionedRef = useRef(false);

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

  /**
   * 换会话时的 pwd 同步（**布局阶段**）。
   *
   * pwd 缓存是同步可读的：在 layout effect 里读，挂载 / 换会话的那一帧
   * 就显示正确的回跳目标，不会先闪一次「当前会话未上报工作目录」
   * （passive effect 要等绘制之后才跑，正好会露出这一帧）。
   */
  useLayoutEffect(() => {
    setPwdState((previous) => {
      const nextPwd = sessionId ? getSessionPwd(sessionId) : null;
      if (previous.sessionId === sessionId && previous.pwd === nextPwd) {
        // 初值已经从缓存同步读过：值没变就别多一次渲染。
        return previous;
      }
      return { sessionId, pwd: nextPwd };
    });
  }, [sessionId]);

  /**
   * 会话 pwd 的订阅。
   *
   * pwd 是**异步到达**的（shell 画提示符时才报上来）：订阅变化，
   * 回跳按钮的 tooltip 随它更新（PRD FP-07）。
   */
  useEffect(() => {
    if (!sessionId) {
      return undefined;
    }
    return subscribeSessionPwd(sessionId, () => {
      setPwdState({ sessionId, pwd: getSessionPwd(sessionId) });
    });
  }, [sessionId]);

  /** 换会话：定位状态复位（用户是否导航过 / 是否已用 pwd 定位过）。 */
  useEffect(() => {
    userNavigatedRef.current = false;
    pwdPositionedRef.current = false;
  }, [sessionId]);

  /**
   * 统一导航入口。
   *
   * **同路径必须强制重读**：`setPath` 传同值时 React 会 bail out（不重渲染），
   * 于是「当前目录变化就重读列表」的 effect 不会重跑——列表被清空成
   * 「空目录」（点根 crumb 回根、点当前层级 crumb 都会踩到：先 `setEntries([])`，
   * 路径又没变，列表就永远停在空数组上）。
   * 所以这里**不走「state 变化触发 effect」**：每次导航都**直接调
   * `loadDirectory`**，同路径也一样重读。
   *
   * `userInitiated` = 用户自己点的导航（点目录行 / 点面包屑 / 点回跳）：
   * 标记「用户导航过」⇒ 之后 pwd 再来也不把窗格带走（**无自动跟随**）。
   */
  const applyPath = useCallback(
    (next: string, options?: { userInitiated?: boolean }): void => {
      if (options?.userInitiated) {
        userNavigatedRef.current = true;
      }
      const target = normalizeContainerPath(next) ?? '/';
      if (target === pathRef.current) {
        // 同路径：绕开 setState，直接重读一次。
        void loadDirectory(target);
        return;
      }
      setEntries([]);
      // 清空的同时进加载态：不让「空目录」在换目录的间隙闪一下。
      setLoading(true);
      setPath(target);
      void loadDirectory(target);
    },
    [loadDirectory],
  );

  /**
   * 首次定位（fallback 链）：**会话 pwd → 沙箱 workdir → `/`**。
   *
   * 定位**只做一次**：
   * - 用户已经导航过 ⇒ 不动（用户的目录优先）；
   * - 已经用 pwd 定位过 ⇒ 不动（**无自动跟随**：pwd 变化绝不联动）；
   * - 沙箱 workdir 迟到（详情还没读到）⇒ 补定位一次。
   */
  useEffect(() => {
    if (userNavigatedRef.current || pwdPositionedRef.current) {
      return;
    }
    const pwd = sessionId ? getSessionPwd(sessionId) : null;
    if (pwd !== null) {
      // pwd 已经拿到 ⇒ 起点就是它，不必再定位一次。
      pwdPositionedRef.current = true;
    }
    applyPath(resolveFilePaneStartPath({ pwd, workdir }));
  }, [sessionId, workdir, applyPath]);

  /**
   * pwd 迟到时的补定位。
   *
   * pwd 是异步到达的：会话刚建起来时窗格先落在 workdir（或 `/`），
   * pwd 到了再挪一次——**只挪这一次**，且用户已经导航过就不挪。
   */
  useEffect(() => {
    if (pwdPositionedRef.current || userNavigatedRef.current) {
      return;
    }
    if (sessionPwd === null) {
      return;
    }
    pwdPositionedRef.current = true;
    applyPath(sessionPwd);
  }, [sessionPwd, applyPath]);

  /** 收掉全部在途传输（换沙箱 / 卸载时用；只动 ref，不碰状态）。 */
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
    // **预览收口**：在途的只读读取与复制定时器一并收掉。
    previewControllerRef.current?.abort();
    previewControllerRef.current = null;
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
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

  // 换沙箱：清空在途上传 / 下载、队列与确认框（上个沙箱的活儿不算数），
  // 同时清空列表与列表可信标记——旧沙箱的行绝不能挂到新沙箱的慢查询返回为止。
  // 主入口在 `TerminalPanel` 里按 `sandbox:session` 强制重挂载（path / entries /
  // 定位标记一起归零）；这里的清理是「直接改 `sandbox` prop」时的兜底。
  useEffect(() => {
    abortTransfers();
    setEntries([]);
    listTrustedRef.current = false;
    listPathRef.current = null;
    setUploads([]);
    setDownloads(new Map());
    setOverwriteName(null);
    setPreparingUpload(false);
    // 预览栈与载荷也要归零（旧沙箱的文件不能留在新沙箱的视图里）
    setPreviewStack([]);
    setPreviewView(EMPTY_PREVIEW_VIEW);
    setPreviewConfirm(null);
    setCopied(false);
  }, [sandbox, abortTransfers]);

  // 卸载同样收口（AbortController 与 reader 都不留）。
  useEffect(
    () => () => {
      aliveRef.current = false;
      abortTransfers();
    },
    [abortTransfers],
  );

  /* ---------------------------------------------------------------- 导航 */

  const goToPath = useCallback(
    (next: string): void => {
      applyPath(next, { userInitiated: true });
    },
    [applyPath],
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
          aliveRef.current &&
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
          aliveRef.current &&
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
      aliveRef.current && generation === generationRef.current;
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
      if (files.length === 0 || preparingRef.current || !aliveRef.current) {
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
            if (aliveRef.current) {
              show('error', '当前目录读取失败，已取消上传', { source: 'file-browser' });
            }
            return;
          }
          visible = loaded;
        } finally {
          preparingRef.current = false;
          setPreparingUpload(false);
        }
        if (!aliveRef.current || generation !== generationRef.current) {
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
        if (generation !== generationRef.current || !aliveRef.current) {
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
        if (generation !== generationRef.current || !aliveRef.current) {
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
            aliveRef.current &&
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
            aliveRef.current &&
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
        if (generation === generationRef.current && aliveRef.current) {
          show('error', errorMessage(exc), { source: 'file-browser' });
        }
      } finally {
        desktopPendingRef.current.delete(entry.name);
      }
    },
    [sandbox, show],
  );

  const startDownload = useCallback(
    async (entry: FileListEntry, targetPathOverride?: string): Promise<void> => {
      if (downloadControllersRef.current.has(entry.name)) {
        return;
      }
      // `targetPathOverride` 只给「预览空态里的下载钮」用（它手上的路径是**快照**）：
      // 列表行的下载路径**零改动**（仍是「当前目录 + 条目名」）。
      const targetPath =
        targetPathOverride ?? childContainerPath(pathRef.current, entry.name);
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
          aliveRef.current &&
          !controller.signal.aborted
        ) {
          show('success', `已下载 ${filename}`, { source: 'file-browser' });
        }
      } catch (exc) {
        if (
          generation === generationRef.current &&
          aliveRef.current &&
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

  /* ------------------------------------------------------------ 预览 */

  /** 栈顶预览目标（`null` = 列表态）。 */
  const activePreview = currentPreview(previewStack);
  /** 是否处于预览态（窗格内的第二视图）。 */
  const inPreview = activePreview !== null;

  /** 退出预览态（不发送任何请求；在途读取被 abort）。 */
  const clearPreview = useCallback((): void => {
    previewControllerRef.current?.abort();
    previewControllerRef.current = null;
    setPreviewStack((stack) => previewStackReducer(stack, { type: 'clear' }));
    setPreviewView(EMPTY_PREVIEW_VIEW);
    setCopied(false);
  }, []);

  /**
   * 发起一次预览读取（**只有确认 / 小文件才走到这里**）。
   *
   * 请求参数（PRD API-02）：`max_bytes` 传**列表条目的 `size`** ⇒ 正常流程请求
   * **全量**，因此前端正常路径**永远看不到截断声明**。
   */
  const startPreview = useCallback(
    async (target: PreviewTarget): Promise<void> => {
      previewControllerRef.current?.abort();
      const controller = new AbortController();
      previewControllerRef.current = controller;
      const generation = generationRef.current;
      const large = isLargePreviewFile(target.size);
      const total = target.size > 0 ? target.size : null;
      setPreviewStack((stack) => previewStackReducer(stack, { type: 'push', target }));
      setCopied(false);
      setPreviewView({
        status: 'loading',
        text: '',
        loaded: 0,
        total,
        message: null,
        large,
      });
      const alive = (): boolean =>
        aliveRef.current &&
        generation === generationRef.current &&
        !controller.signal.aborted;
      try {
        const result = await api.readFile(sandbox, target.path, {
          // 按列表 size 请求全量（0 字节文件不传上限）
          maxBytes: target.size > 0 ? target.size : null,
          signal: controller.signal,
          onProgress: (loaded) => {
            if (!alive()) {
              return;
            }
            setPreviewView((current) =>
              current.status === 'loading' ? { ...current, loaded } : current,
            );
          },
        });
        if (!alive()) {
          return;
        }
        if (result.binary) {
          setPreviewView({
            status: 'unsupported',
            text: '',
            loaded: result.bytes,
            total: result.size ?? total,
            message: BINARY_PREVIEW_MESSAGE,
            large,
          });
          return;
        }
        setPreviewView({
          status: 'ready',
          text: result.text,
          loaded: result.bytes,
          total: result.size ?? total,
          message: null,
          large,
        });
      } catch (exc) {
        if (!alive() || isAbortError(exc)) {
          return;
        }
        if (exc instanceof TextNotPreviewableError) {
          // 非 UTF-8：与二进制同一套空态（PRD PV-05）
          setPreviewView({
            status: 'unsupported',
            text: '',
            loaded: 0,
            total,
            message: exc.message,
            large,
          });
          return;
        }
        // 读取失败是**视图状态**（就地错误态），不弹 toast
        // （与「目录读取失败」同一口径）。
        setPreviewView({
          status: 'error',
          text: '',
          loaded: 0,
          total,
          message: errorMessage(exc),
          large,
        });
      } finally {
        if (previewControllerRef.current === controller) {
          previewControllerRef.current = null;
        }
      }
    },
    [sandbox],
  );

  /**
   * 点「预览」眼睛钮：**大文件先弹二次确认**（确认才发请求，取消一个请求都不发）。
   *
   * 目录行没有预览（目录不可预览）；条目名为空 / 含 `/` 时也静默不动作。
   */
  const requestPreview = useCallback(
    (entry: FileListEntry): void => {
      if (entry.kind !== 'file') {
        return;
      }
      const targetPath = childContainerPath(pathRef.current, entry.name);
      if (targetPath === null) {
        return;
      }
      const target: PreviewTarget = {
        path: targetPath,
        name: entry.name,
        size: entry.size,
      };
      if (isLargePreviewFile(entry.size)) {
        setPreviewConfirm(target);
        return;
      }
      void startPreview(target);
    },
    [startPreview],
  );

  /** 二次确认：**确认才发起读取**。 */
  const confirmLargePreview = useCallback((): void => {
    const target = previewConfirm;
    setPreviewConfirm(null);
    if (target !== null) {
      void startPreview(target);
    }
  }, [previewConfirm, startPreview]);

  /** 二次确认：**取消不发请求**（留在列表态）。 */
  const cancelLargePreview = useCallback((): void => {
    setPreviewConfirm(null);
  }, []);

  /** 返回（工具条返回钮与 `Esc` 等价）：退一层预览栈，栈空即回列表。 */
  const backFromPreview = useCallback((): void => {
    previewControllerRef.current?.abort();
    previewControllerRef.current = null;
    setPreviewStack((stack) => previewStackReducer(stack, { type: 'pop' }));
    setPreviewView(EMPTY_PREVIEW_VIEW);
    setCopied(false);
  }, []);

  /**
   * `Esc` 与返回钮等价（**只在预览态监听**；二次确认弹框开着时交给弹框自己）。
   */
  useEffect(() => {
    if (!inPreview) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || previewConfirm !== null) {
        return;
      }
      backFromPreview();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [inPreview, previewConfirm, backFromPreview]);

  /**
   * 复制预览正文：**成功零 toast**（图标变对勾约 1 秒后复原），**失败才 toast**
   * （与终端剪贴板同一套口径，来源标识用 `file-browser`）。
   */
  const copyPreviewText = useCallback((): void => {
    // 非 ready（loading / error / unsupported）不复制：否则会往剪贴板写空串，
    // 还亮对勾 1 秒。按钮本身已 disabled，这里做第二道防线。
    if (previewView.status !== 'ready') {
      return;
    }
    const text = previewView.text;
    const reportFailure = (): void => {
      if (aliveRef.current) {
        show('error', '复制到系统剪贴板失败', { source: 'file-browser' });
      }
    };
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== 'function') {
        reportFailure();
        return;
      }
      void clipboard
        .writeText(text)
        .then(() => {
          if (!aliveRef.current) {
            return;
          }
          setCopied(true);
          if (copyTimerRef.current !== null) {
            window.clearTimeout(copyTimerRef.current);
          }
          copyTimerRef.current = window.setTimeout(() => {
            copyTimerRef.current = null;
            setCopied(false);
          }, COPY_FEEDBACK_MS);
        })
        .catch(reportFailure);
    } catch {
      reportFailure();
    }
  }, [previewView.status, previewView.text, show]);

  /** 空态里的「下载文件」：走**既有下载通道**（路径用预览目标的快照）。 */
  const downloadPreviewedFile = useCallback((): void => {
    if (activePreview === null) {
      return;
    }
    void startDownload(
      {
        name: activePreview.name,
        kind: 'file',
        size: activePreview.size,
        mtime: 0,
      },
      activePreview.path,
    );
  }, [activePreview, startDownload]);

  /**
   * 点**根**面包屑：预览态下**先清预览栈**（PRD：点面包屑 = 返回该目录列表），
   * 再按**同路径强制重读**的既有约定重读该目录。
   */
  const navigateToRootCrumb = useCallback((): void => {
    if (previewStack.length > 0) {
      clearPreview();
    }
    navigateToRoot();
  }, [clearPreview, navigateToRoot, previewStack.length]);

  /** 点某个**层级**面包屑：预览态下先清预览栈（同上）。 */
  const navigateToDepthCrumb = useCallback(
    (depth: number): void => {
      if (previewStack.length > 0) {
        clearPreview();
      }
      navigateToDepth(depth);
    },
    [clearPreview, navigateToDepth, previewStack.length],
  );

  /* ------------------------------------------------------------ 回跳按钮 */

  /**
   * 回跳按钮（准星）的口径。
   *
   * - tooltip 固定格式「**跳转到终端当前目录：<路径>**」，路径随 pwd 订阅更新；
   * - 会话**没上报**工作目录（`null`）⇒ 禁用 + tooltip「**当前会话未上报工作目录**」；
   * - 窗格**已在目标目录** ⇒ 禁用（没什么可跳的）。
   */
  const jumpTarget = sessionPwd;
  const jumpDisabled = jumpTarget === null || isSameContainerPath(path, jumpTarget);
  const jumpHint =
    jumpTarget === null ? '当前会话未上报工作目录' : `跳转到终端当前目录：${jumpTarget}`;

  /** 点回跳：导航到目标目录（**强制重读**，即便已经在那里）。 */
  const jumpToSessionDir = useCallback(() => {
    if (jumpTarget === null) {
      return;
    }
    applyPath(jumpTarget, { userInitiated: true });
  }, [applyPath, jumpTarget]);

  /**
   * 刷新按钮（用户浏览器复验修复轮）：**强制重读当前目录**。
   *
   * 复用「同路径强制重读」通道——`applyPath` 遇同路径不走 setState，
   * 直接 `loadDirectory`；这里显式传当前路径并给按钮加瞬时 loading
   * （禁用 + 旋转），重读落地后复原。
   */
  const refreshDirectory = useCallback(() => {
    setRefreshing(true);
    void Promise.resolve(loadDirectory(pathRef.current)).finally(() => {
      setRefreshing(false);
    });
  }, [loadDirectory]);

  /* ---------------------------------------------------------------- 渲染 */

  /**
   * 折叠态：右缘一条 **36px 纯图标竖条**。
   *
   * 竖条上**只有顶部一个展开按钮**，**不显示任何文字**（用户浏览器复验修复轮：
   * 展开钮从底部移到顶部，与展开态工具条右端的折叠钮同一位置语义）。
   * 与终端同样**零间隙贴合**：完整 border、仅右侧圆角、左缘直角贴终端。
   */
  if (collapsed) {
    return (
      <div
        className="flex h-full min-h-0 w-full flex-col items-center overflow-hidden rounded-r-xl border border-border bg-card pt-2"
        data-testid="page-file-pane-collapsed"
      >
        <button
          type="button"
          onClick={onToggleCollapsed}
          title="展开文件窗格"
          aria-label="展开文件窗格"
          data-testid="page-file-pane-expand-button"
          className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <PanelRightOpen className="size-4" aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <>
      {/*
        面板根：**撑满分屏右侧那一格**（`h-full`）。
        视觉合并：四边完整 border + **仅右侧圆角**（左缘直角贴终端），
        `overflow-hidden` 让内部滚动内容裁进右侧圆角；内边距下放到工具条行，
        下方列表整块直通滚动贴满窗格。
      */}
      <div
        className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-r-xl border border-border bg-card"
        data-testid="page-file-pane-content"
      >
        {/* 顶部固定工具条：面包屑（占满剩余宽度）+ 回跳 / 上传 / 刷新 / 折叠（同高 h-8，折叠钮固定右端） */}
        <div className="flex flex-none items-center gap-1.5 px-2 py-2">
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
              {segments.length === 0 && !inPreview ? (
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
                  onClick={navigateToRootCrumb}
                  title="根目录"
                  aria-label="根目录"
                  aria-current={segments.length === 0 ? 'page' : undefined}
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
                  const isLast = index === segments.length - 1;
                  // **预览态下面包屑全部可点**（PRD FP-08：进预览后面包屑恢复可点，
                  // 点击 = 返回该目录列表并清预览栈）。
                  const isPlain = isLast && !inPreview;
                  return (
                    <span
                      key={`${index}-${segment}`}
                      className="flex min-w-0 items-center gap-1"
                    >
                      <span aria-hidden="true" className="shrink-0 text-faint">
                        /
                      </span>
                      {isPlain ? (
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
                        /*
                          父级：可点的链接样式钮（`text-primary` + hover 下划线）。
                          **预览态下当前层级也走这一支**（点它 = 回该目录列表），
                          此时补 `aria-current="page"`（e2e 断言依赖它）。
                        */
                        <button
                          type="button"
                          onClick={() => navigateToDepthCrumb(index)}
                          aria-current={isLast ? 'page' : undefined}
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

            {/*
              回跳 / 上传 / 刷新是**列表态**的操作：预览态（窗格内的第二视图）里
              不出现（预览只读，避免「预览着一个文件、却往它所在目录上传」的歧义）。
              折叠钮在两种视图下都在（窗格本身的开关），且固定在工具条**右端**。
            */}
            {!inPreview && (
              <>
            {/*
              回跳（准星）：跳到**当前会话上报的工作目录**。
              - tooltip 固定格式「跳转到终端当前目录：<路径>」，随 pwd 订阅更新；
              - 会话没上报 pwd ⇒ 禁用 + tooltip「当前会话未上报工作目录」；
              - 窗格已在目标目录 ⇒ 禁用。
              禁用按钮外面包一层带 title 的 span：Firefox 对 disabled 控件不弹 title。
            */}
            <span className="inline-flex" title={jumpHint}>
              <button
                type="button"
                onClick={jumpToSessionDir}
                disabled={jumpDisabled}
                title={jumpHint}
                aria-label={jumpHint}
                data-testid="page-file-pane-jump-button"
                className="grid size-8 flex-none place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
              >
                <Crosshair className="size-4" aria-hidden="true" />
              </button>
            </span>

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
            {/*
              刷新：**强制重读当前目录**（同路径重读通道）。loading 反馈 =
              按钮瞬时禁用 + 图标旋转（用户浏览器复验修复轮新增）。
            */}
            <button
              type="button"
              onClick={refreshDirectory}
              disabled={refreshing}
              aria-busy={refreshing}
              title="刷新"
              aria-label="刷新"
              data-testid="page-file-browser-refresh-button"
              className="grid size-8 flex-none place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
            >
              <RefreshCw
                className={cn('size-4', refreshing && 'animate-spin')}
                aria-hidden="true"
              />
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
              </>
            )}

            {/* 折叠：收成右缘 36px 纯图标竖条（竖条上只有**顶部**的展开按钮）；展开态固定在工具条右端。 */}
            <button
              type="button"
              onClick={onToggleCollapsed}
              title="折叠文件窗格"
              aria-label="折叠文件窗格"
              data-testid="page-file-pane-collapse-button"
              className="grid size-8 flex-none place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <PanelRightClose className="size-4" aria-hidden="true" />
            </button>
          </div>

          {/*
            **两种视图二选一**（不是弹层、不是抽屉）：
            - 预览态 ⇒ 窗格内的第二视图（工具条 + 行号正文 / 空态）；
            - 列表态 ⇒ 目录列表（下面的原有结构，行为零改动）。
          */}
          {inPreview && activePreview !== null ? (
            <FilePreviewView
              target={activePreview}
              canGoBack={previewStack.length > 0}
              view={previewView}
              copied={copied}
              onBack={backFromPreview}
              onCopy={copyPreviewText}
              onDownload={downloadPreviewedFile}
            />
          ) : (
          <>
            {/*
              列表**拍平**（用户浏览器复验修复轮）：列表头从滚动容器里拆出来、
              **固定**在窗格顶部，不再「窗格内 padding 包一层带边框的表格」。
            */}
            <div
              className={cn(
                rowGrid,
                'flex-none border-b border-border bg-card px-3 py-2 text-[11.5px] text-muted-foreground',
              )}
            >
              <span>名称</span>
              <span className="text-right font-mono tabular-nums">大小</span>
              <span className="text-right font-mono tabular-nums">修改时间</span>
            </div>

            {/*
              条目列表：**整块直通滚动**、贴满窗格（行 hover 高亮满宽）；
              容器不再自带边框 / 圆角 / 内边距（外壳归面板根）。
            */}
            <div
              data-testid="page-file-browser-list"
              className="min-h-0 flex-1 overflow-y-auto"
            >

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
                    // `group`：hover 整行时行尾浮现「预览」眼睛钮（`group-hover`）
                    'group cursor-pointer border-b border-border px-3 py-2 transition-colors last:border-b-0 hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
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
                  <div className="relative flex items-center justify-end">
                    <span
                      data-testid="page-file-browser-row-mtime"
                      className="text-right font-mono text-[11.5px] tabular-nums text-muted-foreground transition-opacity duration-150 group-hover:opacity-0"
                    >
                      {formatFileMtime(entry.mtime)}
                    </span>
                    {/*
                      「预览」眼睛钮：**行尾浮现**、约 150ms 淡入、**不带文字**。
                      - 行单击仍是**下载**（既有口径零改动）⇒ click 与 Enter / Space
                        都要 `stopPropagation`（否则行上的键盘处理器会把「预览」当成下载）；
                      - 目录行没有预览（目录不可预览）；
                      - 它盖在修改时间那一格上，hover 时时间文字淡出，不叠字。
                    */}
                    {entry.kind !== 'dir' && (
                      <button
                        type="button"
                        title="预览"
                        aria-label={`预览 ${entry.name}`}
                        data-testid="page-file-browser-row-preview-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          requestPreview(entry);
                        }}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                        }}
                        className="absolute right-0 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                      >
                        <Eye className="size-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            </div>
          </>
          )}
      </div>

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

      {/*
        大文件（> 2 MB）二次确认：**确认才发起读取**，**取消不发任何请求**
        （PRD PV-04）。对话框与 Obsidian 阅读器共用同一个组件
        （`PreviewConfirmDialog`），标识仍是文件窗格那一套。
      */}
      <PreviewConfirmDialog
        open={previewConfirm !== null}
        name={previewConfirm?.name ?? ''}
        size={previewConfirm?.size ?? 0}
        onConfirm={confirmLargePreview}
        onCancel={cancelLargePreview}
      />
    </>
  );
}
