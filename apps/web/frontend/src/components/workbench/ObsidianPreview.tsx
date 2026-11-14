/**
 * Obsidian 阅读器的**右栏预览视图**：markdown 渲染 / 源码双态 + wikilink 跳转。
 *
 * 口径来源：PRD「方案四 · Obsidian tab」（OBS-06 ~ OBS-11）+ 任务 07。
 *
 * 构图：
 *
 * ```
 * <section page-sandbox-detail-obsidian-preview>            ← 挂载点在 ObsidianWorkspace
 *   [返回?] 文件名 大小 [渲染 | 源码] [复制]                    ← 工具条
 *   [链接目标不存在：<名> ×]                                    ← 就地错误条（可关）
 *   ┌─────────── max-w-620px 居中 ───────────┐
 *   │ markdown 渲染（react-markdown + gfm）   │               ← 渲染态
 *   │ 或 原文（等宽、frontmatter 可见）        │               ← 源码态
 *   └─────────────────────────────────────────┘
 * </section>
 * ```
 *
 * 几条硬口径：
 *
 * - **不放行原始 HTML**：react-markdown 默认即如此，**不装 `rehype-raw`**——
 *   源码里的 `<script>` 只是被转义成文本，不会变成标签、更不会执行；
 * - **frontmatter 渲染态隐藏、源码态可见**（剥离逻辑在 `src/lib/markdown.ts`）；
 * - **wikilink**：强调色 + 虚线下划线；hover 出黑底小 tooltip（内容是**解析后的
 *   目标路径**，定位走 `src/lib/tooltip-position.ts` 的防裁切计算）；点击**命中**
 *   由父组件沿历史栈压入目标（本组件只管回调），**未命中**在正文顶部就地给浅红
 *   错误条——**不跳转、不弹 toast**；
 * - **大文件（> 2 MB）**与文件窗格预览同口径：二次确认对话框与进度条都是**同一
 *   个共用组件**（`PreviewConfirmDialog` / `PreviewLoading`），确认与压栈由父组件
 *   统一做，本组件拿到的 `target` 一定是「已经确认过」的；
 * - **读取走 `api.readFile`**：`maxBytes` 传列表条目的 `size`（正常流程 = 请求
 *   全量）；二进制 / 非 UTF-8 / 读取中断的错误形态与文件窗格预览同款处理。
 */

import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, Copy, FileWarning, X } from 'lucide-react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { api, TextNotPreviewableError } from '../../api/client';
import { cn } from '../../lib/cn';
import { formatFileSize } from '../../lib/file-transfer';
import { isLargePreviewFile } from '../../lib/file-preview';
import { markdownBodyForRender } from '../../lib/markdown';
import {
  createWikilinkResolver,
  isSameWikilinkTarget,
  splitWikilinkSegments,
  type WikilinkParts,
  type WikilinkResolution,
} from '../../lib/wikilink';
import {
  computeTooltipPosition,
  type TooltipPosition,
  type TooltipRect,
  type TooltipViewport,
} from '../../lib/tooltip-position';
import { useToast } from '../Toast';
import { PreviewLoading } from './PreviewLoading';

/** 沙箱里选中的一个 `.md` 文件（与 `ObsidianWorkspace` 的 `VaultSelectedFile` 同形）。 */
export interface ObsidianPreviewTarget {
  /** 文件绝对路径。 */
  path: string;
  /** 文件名（工具条标题）。 */
  name: string;
  /** 字节数（进度条分母 / `max_bytes` / 大文件判定）。 */
  size: number;
}

export interface ObsidianPreviewProps {
  /** 沙箱名（读取与目录列举都挂在它下面）。 */
  sandbox: string;
  /** vault 根绝对路径（wikilink ②③ 级兜底的起点）。 */
  root: string;
  /** 当前显示的文件（历史栈栈顶）。 */
  target: ObsidianPreviewTarget;
  /** 历史栈里还有没有上一层（`false` 时**不渲染返回钮**）。 */
  canGoBack: boolean;
  /** 返回上一层（父组件弹栈）。 */
  onBack: () => void;
  /** wikilink 命中的目标：父组件负责压栈（大文件还要先走二次确认）。 */
  onOpenTarget: (target: ObsidianPreviewTarget) => void;
}

/** 渲染 / 源码双态。 */
type PreviewMode = 'render' | 'source';

/** 读取状态（与文件窗格预览同一套）。 */
type PreviewStatus = 'loading' | 'ready' | 'unsupported' | 'error';

interface PreviewView {
  status: PreviewStatus;
  /** 正文原文（`ready` 时有效）。**渲染态与源码态复制的都是它**。 */
  text: string;
  /** 已接收字节数（进度条分子）。 */
  loaded: number;
  /** 总字节数（进度条分母）。 */
  total: number | null;
  /** `unsupported` / `error` 的文案。 */
  message: string | null;
  /** 是否走大文件流程（加载时给进度条）。 */
  large: boolean;
}

const EMPTY_VIEW: PreviewView = {
  status: 'loading',
  text: '',
  loaded: 0,
  total: null,
  message: null,
  large: false,
};

/** 复制成功的对勾显示时长（毫秒）：与文件窗格预览同口径（约 1 秒后复原）。 */
const COPY_FEEDBACK_MS = 1000;

/** 二进制文件的固定文案（PRD PV-05 同一套）。 */
const BINARY_PREVIEW_MESSAGE = '二进制文件无法预览';

/** wikilink 解析状态（渲染用；`unknown` = 还没解析过）。 */
type WikilinkStatus = 'unknown' | 'found' | 'missing';

interface WikilinkRuntime {
  statusOf: (link: WikilinkParts) => WikilinkStatus;
  pathOf: (link: WikilinkParts) => string | null;
  activate: (link: WikilinkParts) => void;
  hover: (link: WikilinkParts, element: HTMLElement) => void;
  unhover: () => void;
}

const WikilinkContext = createContext<WikilinkRuntime | null>(null);

/** 一条 wikilink 在一份文档里的缓存键（目标 + 标题段）。 */
function linkKey(link: WikilinkParts): string {
  return `${link.target}\u0000${link.heading ?? ''}`;
}

function errorMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

function isAbortError(exc: unknown): boolean {
  return exc instanceof DOMException && exc.name === 'AbortError';
}

/* ------------------------------------------------- 行内 wikilink 渲染 */

/**
 * 一段纯文本 → react 节点（普通文本原样、wikilink 换成可点元素）。
 *
 * 语法切分在 `src/lib/wikilink.ts`（纯函数，单独单测），这里只负责组装。
 */
function renderInlineText(text: string): ReactNode {
  const segments = splitWikilinkSegments(text);
  if (segments.length === 0) {
    return text;
  }
  if (segments.length === 1 && segments[0].kind === 'text') {
    return segments[0].text;
  }
  return segments.map((segment, index) =>
    segment.kind === 'text' ? (
      <Fragment key={index}>{segment.text}</Fragment>
    ) : (
      <WikilinkLink key={index} link={segment.link} />
    ),
  );
}

/** 递归把 children 里的文本节点换成带 wikilink 的节点（元素节点原样穿透）。 */
function withWikilinks(children: ReactNode): ReactNode {
  if (typeof children === 'string') {
    return renderInlineText(children);
  }
  if (Array.isArray(children)) {
    return children.map((child, index) => (
      <Fragment key={index}>{withWikilinks(child)}</Fragment>
    ));
  }
  return children;
}

/** 一条 wikilink 的可点元素（强调色 + 虚线下划线；hover 交给上下文出 tooltip）。 */
function WikilinkLink({ link }: { link: WikilinkParts }) {
  const runtime = useContext(WikilinkContext);
  const status = runtime?.statusOf(link) ?? 'unknown';
  const resolvedPath = runtime?.pathOf(link) ?? null;
  return (
    <button
      type="button"
      data-testid="page-sandbox-detail-obsidian-preview-wikilink"
      data-target={link.target}
      data-status={status}
      data-resolved-path={resolvedPath ?? undefined}
      onClick={(event) => {
        event.preventDefault();
        runtime?.activate(link);
      }}
      onMouseEnter={(event) => runtime?.hover(link, event.currentTarget)}
      onMouseLeave={() => runtime?.unhover()}
      onFocus={(event) => runtime?.hover(link, event.currentTarget)}
      onBlur={() => runtime?.unhover()}
      className="inline cursor-pointer break-words text-primary underline decoration-dashed underline-offset-4 transition-colors hover:text-primary-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {link.display}
    </button>
  );
}

/* ------------------------------------------------- markdown 排版 */

const markdownComponents: Components = {
  p({ children }) {
    return (
      <p className="my-3 text-[13.5px] leading-7 text-foreground">{withWikilinks(children)}</p>
    );
  },
  h1({ children }) {
    return (
      <h1 className="mt-6 mb-3 border-b border-border pb-1.5 text-[20px] leading-8 font-semibold text-foreground">
        {withWikilinks(children)}
      </h1>
    );
  },
  h2({ children }) {
    return (
      <h2 className="mt-5 mb-2.5 text-[17px] leading-7 font-semibold text-foreground">
        {withWikilinks(children)}
      </h2>
    );
  },
  h3({ children }) {
    return (
      <h3 className="mt-4 mb-2 text-[15px] leading-6 font-semibold text-foreground">
        {withWikilinks(children)}
      </h3>
    );
  },
  h4({ children }) {
    return (
      <h4 className="mt-4 mb-2 text-[14px] leading-6 font-semibold text-foreground">
        {withWikilinks(children)}
      </h4>
    );
  },
  h5({ children }) {
    return (
      <h5 className="mt-3 mb-1.5 text-[13.5px] leading-6 font-semibold text-foreground">
        {withWikilinks(children)}
      </h5>
    );
  },
  h6({ children }) {
    return (
      <h6 className="mt-3 mb-1.5 text-[13px] leading-6 font-semibold text-muted-foreground">
        {withWikilinks(children)}
      </h6>
    );
  },
  ul({ className, children }) {
    const task = typeof className === 'string' && className.includes('contains-task-list');
    return (
      <ul
        className={cn(
          'my-3 space-y-1 text-[13.5px] leading-7',
          task ? 'list-none pl-1' : 'list-disc pl-5',
        )}
      >
        {children}
      </ul>
    );
  },
  ol({ children }) {
    return (
      <ol className="my-3 list-decimal space-y-1 pl-5 text-[13.5px] leading-7">{children}</ol>
    );
  },
  li({ className, children }) {
    const task = typeof className === 'string' && className.includes('task-list-item');
    return (
      <li className={cn('marker:text-muted-foreground', task && 'flex items-start gap-1.5')}>
        {withWikilinks(children)}
      </li>
    );
  },
  blockquote({ children }) {
    return (
      <blockquote className="my-3 border-l-2 border-border pl-3 text-[13.5px] leading-7 text-muted-foreground">
        {withWikilinks(children)}
      </blockquote>
    );
  },
  /* 行内码与围栏代码块共用 `code`：围栏块带 `language-*` 类名（块底色在 `pre` 上）。
     **代码里不做 wikilink 替换**——代码块里的 `[[x]]` 就是字面量。 */
  code({ className, children }) {
    const block = typeof className === 'string' && className.startsWith('language-');
    if (block) {
      return <code className={cn('font-mono', className)}>{children}</code>;
    }
    return (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12.5px] text-foreground">
        {children}
      </code>
    );
  },
  pre({ children }) {
    return (
      <pre className="my-3 overflow-x-auto rounded-lg bg-terminal-bg px-3 py-2.5 font-mono text-[12px] leading-5 text-terminal-fg">
        {children}
      </pre>
    );
  },
  strong({ children }) {
    return (
      <strong className="font-semibold text-foreground">{withWikilinks(children)}</strong>
    );
  },
  em({ children }) {
    return <em className="italic">{withWikilinks(children)}</em>;
  },
  del({ children }) {
    return (
      <del className="text-muted-foreground line-through">{withWikilinks(children)}</del>
    );
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="text-primary underline underline-offset-4 hover:text-primary-hover"
      >
        {children}
      </a>
    );
  },
  hr() {
    return <hr className="my-5 border-border" />;
  },
  table({ children }) {
    return (
      <div className="my-3 overflow-x-auto">
        <table className="w-full border-collapse text-[12.5px]">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="border border-border bg-muted px-2 py-1 text-left font-medium">
        {withWikilinks(children)}
      </th>
    );
  },
  td({ children }) {
    return (
      <td className="border border-border px-2 py-1 align-top">{withWikilinks(children)}</td>
    );
  },
  img({ src, alt }) {
    return <img src={src} alt={alt ?? ''} className="my-3 max-w-full rounded-lg" />;
  },
};

/* ------------------------------------------------- 主组件 */

export function ObsidianPreview({
  sandbox,
  root,
  target,
  canGoBack,
  onBack,
  onOpenTarget,
}: ObsidianPreviewProps) {
  const { show } = useToast();
  /** 渲染 / 源码：**每个文件回到渲染态**（渲染是主视图）。 */
  const [mode, setMode] = useState<PreviewMode>('render');
  const [view, setView] = useState<PreviewView>(EMPTY_VIEW);
  const [copied, setCopied] = useState(false);
  /** 「链接目标不存在：<名>」就地错误条的内容（`null` = 不显示）。 */
  const [linkError, setLinkError] = useState<string | null>(null);
  /** 正在 hover 的 wikilink（出 tooltip 用）。 */
  const [hover, setHover] = useState<{
    key: string;
    anchor: TooltipRect;
    viewport: TooltipViewport;
  } | null>(null);
  /** 已解析的 wikilink（渲染与 tooltip 都读它）。 */
  const [resolutions, setResolutions] = useState<Record<string, WikilinkResolution>>({});
  /** tooltip 量到的真实尺寸（量到之前按 0 算，见 `computeTooltipPosition`）。 */
  const [tooltipSize, setTooltipSize] = useState<TooltipViewport | null>(null);

  const aliveRef = useRef(true);
  const copyTimerRef = useRef<number | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  /** 解析缓存（同步去重；与 `resolutions` 同源，`resolutions` 只驱动渲染）。 */
  const resolutionRef = useRef(new Map<string, Promise<WikilinkResolution>>());
  /**
   * 换文件的代次：换文件时自增，旧文件的在途解析结果一律丢弃。
   *
   * 同一条 `[[目标]]` 在不同文件里走的是**不同的①同目录**，旧结果不能串过来。
   */
  const linkGenerationRef = useRef(0);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, []);

  /* 换根 / 换沙箱：目录缓存作废（wikilink 兜底要重新列举）。 */
  const resolver = useMemo(
    () => createWikilinkResolver({ list: (dir: string) => api.listFiles(sandbox, dir) }),
    [sandbox, root],
  );

  /* 读文件（换文件即重读；卸载 / 换文件 abort 在途请求）。 */
  useEffect(() => {
    setMode('render');
    setLinkError(null);
    setHover(null);
    setCopied(false);
    linkGenerationRef.current += 1;
    resolutionRef.current.clear();
    setResolutions({});

    const controller = new AbortController();
    let alive = true;
    const large = isLargePreviewFile(target.size);
    const total = target.size > 0 ? target.size : null;
    setView({ status: 'loading', text: '', loaded: 0, total, message: null, large });

    void (async () => {
      try {
        const result = await api.readFile(sandbox, target.path, {
          // 按列表 size 请求全量（0 字节文件不传上限）——正常流程永远看不到截断。
          maxBytes: target.size > 0 ? target.size : null,
          signal: controller.signal,
          onProgress: (loaded) => {
            if (!alive) {
              return;
            }
            setView((current) =>
              current.status === 'loading' ? { ...current, loaded } : current,
            );
          },
        });
        if (!alive) {
          return;
        }
        if (result.binary) {
          setView({
            status: 'unsupported',
            text: '',
            loaded: result.bytes,
            total: result.size ?? total,
            message: BINARY_PREVIEW_MESSAGE,
            large,
          });
          return;
        }
        setView({
          status: 'ready',
          text: result.text,
          loaded: result.bytes,
          total: result.size ?? total,
          message: null,
          large,
        });
      } catch (exc) {
        if (!alive || isAbortError(exc)) {
          return;
        }
        if (exc instanceof TextNotPreviewableError) {
          // 非 UTF-8：与二进制同一套「无法展示」空态（PRD PV-05 同口径）。
          setView({
            status: 'unsupported',
            text: '',
            loaded: 0,
            total,
            message: exc.message,
            large,
          });
          return;
        }
        // 读取失败是**视图状态**（就地错误态），不弹 toast（与 05 同口径）。
        setView({
          status: 'error',
          text: '',
          loaded: 0,
          total,
          message: errorMessage(exc),
          large,
        });
      }
    })();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [sandbox, target.path, target.size]);

  /** 解析一条 wikilink（同一条只解析一次；结果进 state 驱动渲染与 tooltip）。 */
  const ensureResolved = useCallback(
    (link: WikilinkParts): Promise<WikilinkResolution> => {
      const key = linkKey(link);
      const cached = resolutionRef.current.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const generation = linkGenerationRef.current;
      const pending = resolver.resolve(link, { currentPath: target.path, root });
      resolutionRef.current.set(key, pending);
      void pending.then((resolution) => {
        if (!aliveRef.current || generation !== linkGenerationRef.current) {
          return;
        }
        setResolutions((current) => ({ ...current, [key]: resolution }));
      });
      return pending;
    },
    [resolver, root, target.path],
  );

  const statusOf = useCallback(
    (link: WikilinkParts): WikilinkStatus => {
      const resolution = resolutions[linkKey(link)];
      if (resolution === undefined) {
        return 'unknown';
      }
      return resolution.status === 'found' ? 'found' : 'missing';
    },
    [resolutions],
  );

  const pathOf = useCallback(
    (link: WikilinkParts): string | null => {
      const resolution = resolutions[linkKey(link)];
      return resolution !== undefined && resolution.status === 'found' ? resolution.path : null;
    },
    [resolutions],
  );

  /** hover 开始：记锚点 + 起解析（解析到了才显示 tooltip，避免闪一个空壳）。 */
  const hoverLink = useCallback(
    (link: WikilinkParts, element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      setHover({
        key: linkKey(link),
        anchor: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
      void ensureResolved(link);
    },
    [ensureResolved],
  );

  const unhover = useCallback(() => {
    setHover(null);
  }, []);

  /** 点一条 wikilink：命中 ⇒ 交给父组件压栈；未命中 ⇒ 就地错误条（不跳转）。 */
  const activateLink = useCallback(
    (link: WikilinkParts) => {
      setHover(null);
      /*
       * 解析可能等上几秒（③ 全库 BFS 的看门狗预算）。点击时先快照代次，解析回来后
       * 比对：**用户在等待期间换了文件**（树上另点 / 已压栈别的目标）就整段作废——
       * 否则旧点击的续体会把旧目标压到新文件的栈顶，把导航劫持走。
       * 与 `ensureResolved` 里 `.then` 的代次守卫同款。
       */
      const generation = linkGenerationRef.current;
      void (async () => {
        const resolution = await ensureResolved(link);
        if (!aliveRef.current || generation !== linkGenerationRef.current) {
          return;
        }
        if (resolution.status === 'missing') {
          setLinkError(`链接目标不存在：${link.target !== '' ? link.target : `#${link.heading ?? ''}`}`);
          return;
        }
        if (isSameWikilinkTarget(resolution.path, target.path)) {
          // `[[#标题]]` / 指回自己：已经在读这一份了，不压栈（避免返回键原地踏步）。
          return;
        }
        onOpenTarget({ path: resolution.path, name: resolution.name, size: resolution.size });
      })();
    },
    [ensureResolved, onOpenTarget, target.path],
  );

  const runtime = useMemo<WikilinkRuntime>(
    () => ({ statusOf, pathOf, activate: activateLink, hover: hoverLink, unhover }),
    [statusOf, pathOf, activateLink, hoverLink, unhover],
  );

  /** 复制：**成功零 toast**（图标变对勾约 1 秒后复原）、失败才 toast。 */
  const copyText = useCallback(() => {
    if (view.status !== 'ready') {
      return;
    }
    const text = view.text;
    const reportFailure = (): void => {
      if (aliveRef.current) {
        show('error', '复制到系统剪贴板失败', { source: 'obsidian' });
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
  }, [show, view.status, view.text]);

  /* tooltip：解析结果到了才显示；位置走纯函数（越界翻转 / 水平钳位）。 */
  const tooltip = useMemo<{ text: string; position: TooltipPosition } | null>(() => {
    if (hover === null) {
      return null;
    }
    const resolved: WikilinkResolution | undefined = resolutions[hover.key];
    if (resolved === undefined) {
      return null;
    }
    const text = resolved.status === 'found' ? resolved.path : '链接目标不存在';
    return {
      text,
      position: computeTooltipPosition(hover.anchor, tooltipSize ?? { width: 0, height: 0 }, hover.viewport),
    };
  }, [hover, resolutions, tooltipSize]);

  /* 量 tooltip 真实尺寸（首帧按 0 算，量到后重算一次位置）。 */
  useLayoutEffect(() => {
    const element = tooltipRef.current;
    if (element === null) {
      return;
    }
    const rect = element.getBoundingClientRect();
    setTooltipSize((current) =>
      current !== null && current.width === rect.width && current.height === rect.height
        ? current
        : { width: rect.width, height: rect.height },
    );
  }, [tooltip?.text]);

  const toolButton =
    'grid size-7 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none';

  const renderedBody = markdownBodyForRender(view.text);
  const hasBody = renderedBody.trim() !== '';

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-mode={mode}>
      {/* 工具条：返回（历史栈）+ 文件名 / 大小 + 渲染 | 源码 + 复制 */}
      <div
        data-testid="page-sandbox-detail-obsidian-preview-toolbar"
        className="flex flex-none items-center gap-1.5 border-b border-border px-2.5 py-1.5"
      >
        {canGoBack && (
          <button
            type="button"
            onClick={onBack}
            title="返回"
            aria-label="返回"
            data-testid="page-sandbox-detail-obsidian-preview-back-button"
            className={toolButton}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </button>
        )}
        <span
          data-testid="page-sandbox-detail-obsidian-preview-title"
          title={target.name}
          className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground"
        >
          {target.name}
        </span>
        <span
          data-testid="page-sandbox-detail-obsidian-preview-size"
          className="flex-none font-mono text-[11.5px] tabular-nums text-muted-foreground"
        >
          {formatFileSize(target.size)}
        </span>
        <div
          role="group"
          aria-label="预览模式"
          className="flex flex-none items-center rounded-lg border border-border p-0.5"
        >
          <button
            type="button"
            aria-pressed={mode === 'render'}
            data-active={mode === 'render' ? 'true' : 'false'}
            data-testid="page-sandbox-detail-obsidian-preview-mode-render"
            onClick={() => setMode('render')}
            className={cn(
              'rounded-md px-2 py-0.5 text-[12px] transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              mode === 'render'
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            渲染
          </button>
          <button
            type="button"
            aria-pressed={mode === 'source'}
            data-active={mode === 'source' ? 'true' : 'false'}
            data-testid="page-sandbox-detail-obsidian-preview-mode-source"
            onClick={() => setMode('source')}
            className={cn(
              'rounded-md px-2 py-0.5 text-[12px] transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              mode === 'source'
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            源码
          </button>
        </div>
        <button
          type="button"
          onClick={copyText}
          disabled={view.status !== 'ready'}
          title={copied ? '已复制' : '复制'}
          aria-label={copied ? '已复制' : '复制'}
          data-testid="page-sandbox-detail-obsidian-preview-copy-button"
          className={cn(toolButton, 'disabled:pointer-events-none disabled:opacity-50')}
        >
          {copied ? (
            <Check className="size-4" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>

      {/* 正文顶部就地错误条（浅红）：链接目标不存在，可手动关闭，不弹 toast。 */}
      {linkError !== null && (
        <div
          role="alert"
          data-testid="page-sandbox-detail-obsidian-preview-wikilink-error"
          className="mx-2.5 mt-2 flex flex-none items-start gap-2 rounded-lg border border-destructive/40 bg-destructive-soft px-2.5 py-1.5 text-[12.5px] text-destructive"
        >
          <span className="min-w-0 flex-1 break-all">{linkError}</span>
          <button
            type="button"
            onClick={() => setLinkError(null)}
            title="关闭"
            aria-label="关闭"
            data-testid="page-sandbox-detail-obsidian-preview-wikilink-error-close-button"
            className="grid size-4 flex-none place-items-center rounded text-destructive transition-colors hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {view.status === 'loading' && (
          <PreviewLoading
            name={target.name}
            large={view.large}
            loaded={view.loaded}
            total={view.total}
            loadingTestId="page-sandbox-detail-obsidian-preview-loading"
            progressTestId="page-sandbox-detail-obsidian-preview-progress"
          />
        )}

        {view.status === 'error' && (
          <div
            role="alert"
            data-testid="page-sandbox-detail-obsidian-preview-error"
            className="rounded-lg border border-border bg-card px-3 py-4 text-[12.5px] text-destructive"
          >
            {view.message}
          </div>
        )}

        {view.status === 'unsupported' && (
          <div
            data-testid="page-sandbox-detail-obsidian-preview-unsupported"
            className="flex min-h-[180px] flex-col items-center justify-center gap-3 rounded-lg border border-border bg-card px-3 text-center"
          >
            <FileWarning className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-[13px] text-muted-foreground">{view.message}</p>
          </div>
        )}

        {view.status === 'ready' && mode === 'render' && (
          <div data-testid="page-sandbox-detail-obsidian-preview-body" data-mode="render">
            <div
              data-testid="page-sandbox-detail-obsidian-preview-content"
              className="mx-auto w-full max-w-[620px] pb-6"
            >
              {hasBody ? (
                <WikilinkContext.Provider value={runtime}>
                  <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {renderedBody}
                  </Markdown>
                </WikilinkContext.Provider>
              ) : (
                <p className="text-[13px] text-muted-foreground">空文件</p>
              )}
            </div>
          </div>
        )}

        {view.status === 'ready' && mode === 'source' && (
          <div
            data-testid="page-sandbox-detail-obsidian-preview-source"
            data-mode="source"
            className="mx-auto w-full max-w-[620px] whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-foreground"
          >
            {/* 源码态：**原文**（frontmatter 可见、wikilink 不做替换）。 */}
            {view.text}
          </div>
        )}
      </div>

      {tooltip !== null &&
        createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            data-testid="page-sandbox-detail-obsidian-preview-wikilink-tooltip"
            data-placement={tooltip.position.placement}
            style={{
              position: 'fixed',
              left: `${tooltip.position.left}px`,
              top: `${tooltip.position.top}px`,
            }}
            className="pointer-events-none z-[100] max-w-[360px] rounded-md bg-terminal-bg px-2 py-1 font-mono text-[11px] leading-4 break-all text-terminal-fg shadow-md"
          >
            {tooltip.text}
          </div>,
          document.body,
        )}
    </div>
  );
}
