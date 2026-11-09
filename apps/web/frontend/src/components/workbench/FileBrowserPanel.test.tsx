// @vitest-environment jsdom
/**
 * 文件浏览面板：入口在 Workbench（另测），这里只测面板本身。
 *
 * 覆盖用户拍板的交互口径：
 * - 三列列表：文件夹在前、隐藏文件显示；点击文件行即下载（没有下载按钮）；
 * - 面包屑各级可点击、不重复展示纯文本当前目录；
 * - 上传只进当前目录、多文件逐个传、行内进度 + 取消；
 * - 同名普通文件先弹覆盖确认（确认 / 取消跳过并 toast）；同名目录不弹框，
 *   服务端 400 的 detail 原样 toast；
 * - 下载进度按 `Content-Length` 算，web 落 blob → a[download]（不导航 blob: URL）；
 * - 桌面分支：原生保存框（取消静默 / 确认后 invoke Rust 落盘）、进度事件、失败 toast；
 *   关闭抽屉取消在途下载。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type DownloadFileResult, type TransferProgress } from '../../api/client';
import type { FileListEntry } from '../../api/types';
import { ToastProvider } from '../Toast';
import { FileBrowserPanel } from './FileBrowserPanel';

const mocks = vi.hoisted(() => ({
  listFiles: vi.fn(),
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
}));

/**
 * 桌面分支的 IPC 替身。面板只关心「调用链」，invoke 的真实形状在
 * `src/lib/desktop-file.test.ts` 里逐条钉。
 */
const desktopMocks = vi.hoisted(() => ({
  pickDownloadPath: vi.fn(),
  downloadToDisk: vi.fn(),
  listenDownloadEvents: vi.fn(),
  cancelDesktopDownload: vi.fn(),
}));

vi.mock('../../lib/desktop-file', () => ({
  CANCELLED_MESSAGE: '下载已取消',
  pickDownloadPath: desktopMocks.pickDownloadPath,
  downloadToDisk: desktopMocks.downloadToDisk,
  listenDownloadEvents: desktopMocks.listenDownloadEvents,
  cancelDownload: desktopMocks.cancelDesktopDownload,
}));

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listFiles: mocks.listFiles,
      uploadFile: mocks.uploadFile,
      downloadFile: mocks.downloadFile,
    },
  };
});

function entry(overrides: Partial<FileListEntry>): FileListEntry {
  return {
    name: 'a.txt',
    kind: 'file',
    size: 10,
    mtime: 1_700_000_000,
    ...overrides,
  };
}

interface PanelOverrides {
  open?: boolean;
  initialPath?: string;
  desktop?: boolean;
  sandbox?: string;
}

function panelElement(overrides?: PanelOverrides) {
  return (
    <ToastProvider>
      <FileBrowserPanel
        open={overrides?.open ?? true}
        onOpenChange={() => {}}
        sandbox={overrides?.sandbox ?? 'demo-01'}
        initialPath={overrides?.initialPath ?? '/home/acc-demo'}
        widthVw={40}
        onWidthChange={() => {}}
        desktop={overrides?.desktop ?? false}
      />
    </ToastProvider>
  );
}

function renderPanel(overrides?: PanelOverrides) {
  return render(panelElement(overrides));
}

function toastsOf(kind: 'success' | 'error' | 'info'): HTMLElement[] {
  return screen
    .queryAllByTestId('page-toast-item')
    .filter((node) => node.getAttribute('data-toast-kind') === kind);
}

function rowOf(name: string): HTMLElement {
  const row = screen
    .queryAllByTestId('page-file-browser-row')
    .find((node) => node.getAttribute('data-name') === name);
  if (!row) {
    throw new Error(`找不到文件行：${name}`);
  }
  return row;
}

function crumbAt(depth: number): HTMLElement {
  const crumb = screen
    .getAllByTestId('page-file-browser-crumb')
    .find((node) => node.getAttribute('data-depth') === String(depth));
  if (!crumb) {
    throw new Error(`找不到面包屑层级：${depth}`);
  }
  return crumb;
}

function chooseFiles(...files: File[]): void {
  fireEvent.change(screen.getByTestId('page-file-browser-file-input'), {
    target: { files },
  });
}

/** className 拆成 token 列表（断言只认 token，不认整串）。 */
function classTokens(node: Element): string[] {
  return node.className.split(/\s+/).filter(Boolean);
}

/**
 * jsdom 没有布局：所有元素的 `getBoundingClientRect()` 都是 0。
 *
 * 这里按「角色」给一份假尺寸，让量宽逻辑能跑出**可判定**的结果：
 * - 可见层级区（`aria-label="路径"` 的 nav 的直接子 div）= 100px
 *   （放不下两级 60px ⇒ 浅层级收进省略号）；
 * - 量宽行里的每个层级格 = 60px、省略号 = 16px。
 */
function stubCrumbLayout(): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: Element) {
      let width = 300;
      if (this.hasAttribute('data-crumb-level')) {
        width = 60;
      } else if (this.hasAttribute('data-crumb-ellipsis')) {
        width = 16;
      } else if (this.parentElement?.getAttribute('aria-label') === '路径') {
        width = 100;
      }
      return {
        width,
        height: 20,
        top: 0,
        left: 0,
        right: width,
        bottom: 20,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
}

/**
 * 可观测的 `ResizeObserver` 替身（jsdom 没有实现）。
 *
 * **按实例留档**：Base UI 的抽屉自己也在用 ResizeObserver（量弹层与视口），
 * 所以不能只看「全局调用了几次」——要按实例分辨**谁观察了哪个节点**、
 * **谁被 disconnect 了**。
 */
function stubResizeObserver(): {
  instances: Array<{ observed: Element[]; disconnected: boolean }>;
} {
  const instances: Array<{ observed: Element[]; disconnected: boolean }> = [];
  class FakeResizeObserver {
    private readonly record = { observed: [] as Element[], disconnected: false };
    constructor() {
      instances.push(this.record);
    }
    observe(node: Element): void {
      this.record.observed.push(node);
    }
    unobserve(): void {}
    disconnect(): void {
      this.record.disconnected = true;
    }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  return { instances };
}

let clickedAnchors: HTMLAnchorElement[] = [];

beforeEach(() => {
  mocks.listFiles.mockReset();
  mocks.uploadFile.mockReset();
  mocks.downloadFile.mockReset();
  desktopMocks.pickDownloadPath.mockReset();
  desktopMocks.downloadToDisk.mockReset();
  desktopMocks.listenDownloadEvents.mockReset();
  desktopMocks.cancelDesktopDownload.mockReset();
  desktopMocks.pickDownloadPath.mockResolvedValue(null);
  desktopMocks.downloadToDisk.mockResolvedValue({
    target_path: 'C:\\Users\\me\\a.txt',
    bytes: 1,
  });
  desktopMocks.listenDownloadEvents.mockResolvedValue(() => {});
  desktopMocks.cancelDesktopDownload.mockResolvedValue(undefined);
  mocks.listFiles.mockResolvedValue([]);
  mocks.uploadFile.mockResolvedValue({ path: '/home/acc-demo/a.txt', bytes: 3 });
  mocks.downloadFile.mockResolvedValue({
    blob: new Blob(['hello']),
    contentDisposition: 'attachment; filename="a.txt"',
  } satisfies DownloadFileResult);

  clickedAnchors = [];
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(() => 'blob:mock'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clickedAnchors.push(this);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('列表与导航', () => {
  it('三列：文件夹在前按名称排序、隐藏文件显示、大小与时间等宽', async () => {
    mocks.listFiles.mockResolvedValue([
      entry({ name: 'b.txt', kind: 'file', size: 1536 }),
      entry({ name: 'alpha', kind: 'dir', mtime: 1_700_000_000 }),
      entry({ name: '.env', kind: 'file' }),
      entry({ name: 'a.txt', kind: 'file' }),
    ]);
    renderPanel();

    await screen.findByTestId('page-file-browser-list');
    await waitFor(() =>
      expect(screen.getAllByTestId('page-file-browser-row').length).toBe(4),
    );

    expect(
      screen.getAllByTestId('page-file-browser-row').map((node) => node.getAttribute('data-name')),
    ).toEqual(['alpha', '.env', 'a.txt', 'b.txt']);

    // 目录大小显示占位符；文件大小格式化。
    expect(within(rowOf('alpha')).getByTestId('page-file-browser-row-size').textContent).toBe('—');
    expect(within(rowOf('b.txt')).getByTestId('page-file-browser-row-size').textContent).toBe(
      '1.5 KB',
    );

    // 没有类型列，也没有下载按钮 / 说明文字。
    expect(screen.queryByText('类型')).toBeNull();
    expect(screen.queryByRole('button', { name: '下载' })).toBeNull();
    expect(screen.queryByText('选中文件后可下载')).toBeNull();
    expect(screen.queryByText(/上传文件到当前目录/)).toBeNull();
  });

  it('面包屑各级可点击，点上级目录重新读取列表', async () => {
    renderPanel();
    expect(screen.getAllByTestId('page-file-browser-crumb')).toHaveLength(3);
    expect(crumbAt(-1).getAttribute('aria-current')).toBeNull();
    expect(crumbAt(1).getAttribute('aria-current')).toBe('page');

    fireEvent.click(crumbAt(0));

    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenLastCalledWith('demo-01', '/home'),
    );
  });

  it('面包屑与上传按钮同一行、同高；当前级高亮只由 aria-current 变体驱动', () => {
    renderPanel();
    const nav = screen.getByTestId('page-file-browser-crumbs');
    const upload = screen.getByTestId('page-file-browser-upload-button');

    // 同一行 = 同一个父容器（面包屑 flex-1 占剩余宽度，上传按钮 flex-none 定宽）。
    expect(upload.parentElement).toBe(nav.parentElement);

    // 两者**同高**：各自 className 里抽高度类（`h-*` 一类）必须相等。
    // 只钉「相等」这个关系，不钉死具体数值（钉死数值 = 钉死实现细节）。
    const heightClassOf = (node: HTMLElement): string | undefined =>
      classTokens(node).find((token) => /^h-\S+$/.test(token));
    expect(heightClassOf(nav)).toBeDefined();
    expect(heightClassOf(upload)).toBeDefined();
    expect(heightClassOf(nav)).toBe(heightClassOf(upload));

    // 面包屑区域**固定底色**（不靠 hover 出底色）：存在**非 hover 条件**的
    // 底色类（`bg-muted/40` 一类）。
    expect(
      classTokens(nav).some((token) => /^bg-muted/.test(token) && !token.includes(':')),
      `面包屑没有固定底色类：${nav.className}`,
    ).toBe(true);

    // 当前级高亮**只**由 aria-current 变体驱动：JS 侧不再另写一套
    // 「是不是当前级」的样式真值 ⇒ 当前级与父级的 className **完全一致**，
    // 差异只来自 `aria-current` 属性。
    const current = crumbAt(1);
    expect(current.getAttribute('aria-current')).toBe('page');
    const parent = crumbAt(0);
    expect(parent.getAttribute('aria-current')).toBeNull();
    expect([...classTokens(current)].sort()).toEqual([...classTokens(parent)].sort());
    // 变体在（当前级的高亮样式确实存在）。
    expect(
      classTokens(current).some((token) => token.startsWith('aria-[current=page]:')),
      `当前级没有 aria-current 变体：${current.className}`,
    ).toBe(true);
    // 父级走链接样式（不是按钮底色 hover）。
    expect(classTokens(parent)).not.toContain('hover:bg-muted');

    // 链接样式（`text-primary` + `hover:underline`）在**有文字**的层级按钮上。
    expect(classTokens(parent)).toContain('text-primary');
    expect(classTokens(parent)).toContain('hover:underline');

    // 根图标钮是纯图标：下划线**画不出来**（`text-decoration` 不向 flex item
    // 的后代传播）⇒ 不挂 hover:underline，hover 反馈走底色 / 变色。
    const root = crumbAt(-1);
    const rootTokens = classTokens(root);
    expect(rootTokens).not.toContain('hover:underline');
    expect(
      rootTokens.some((token) => /^hover:(bg|text)-/.test(token)),
      `根图标钮没有 hover 反馈：${root.className}`,
    ).toBe(true);

    // 分隔符保持 text-faint。
    const separators = Array.from(
      nav.querySelectorAll<HTMLSpanElement>('span[aria-hidden="true"]'),
    ).filter((node) => node.textContent === '/');
    expect(separators.length).toBeGreaterThan(0);
    expect(classTokens(separators[0])).toContain('text-faint');
  });

  it('量宽行是内部隐藏行：aria-hidden + 不可聚焦 + 不含交互元素', () => {
    renderPanel();
    const nav = screen.getByTestId('page-file-browser-crumbs');
    // 量宽行 = 挂着 `data-crumb-level` 的那些格子的父节点。
    const measureRow = nav.querySelector('[data-crumb-level]')?.parentElement;
    expect(measureRow, '找不到量宽行').toBeTruthy();
    expect(measureRow?.getAttribute('aria-hidden')).toBe('true');
    expect(classTokens(measureRow as Element)).toContain('pointer-events-none');
    // `aria-hidden` 的子树里不能有可聚焦元素（量宽行原来放的是真 `<button>`）。
    expect(measureRow?.querySelectorAll('button').length).toBe(0);
    expect(measureRow?.querySelectorAll('a, [tabindex]').length).toBe(0);
    // 量宽属性只出现在量宽行里，不漏到可见行。
    const levelCells = Array.from(nav.querySelectorAll('[data-crumb-level]'));
    expect(levelCells.length).toBeGreaterThan(0);
    expect(levelCells.every((cell) => measureRow?.contains(cell))).toBe(true);
  });

  it('量宽基准节点后到（抽屉关闭时面板已挂载）：首次打开即挂观察器并量宽；关闭再打开会重挂', async () => {
    const observer = stubResizeObserver();
    const rect = stubCrumbLayout();
    /** 观察了某个节点的观察器实例（Base UI 自己的观察器不算）。 */
    const observersOf = (node: Element) =>
      observer.instances.filter((record) => record.observed.includes(node));

    const view = renderPanel({ open: false });

    // 抽屉关闭：Base UI 的 portal **不渲染内容** ⇒ 量宽基准节点还不存在，
    // 观察器也就无处可挂（修前：面板常驻挂载 ⇒ 观察器**永远建不起来**）。
    expect(screen.queryByTestId('page-file-browser-crumbs')).toBeNull();

    // 打开：DOM 出现 ⇒ 回调 ref 触发 ⇒ 挂观察器 + 立即量一次。
    view.rerender(panelElement({ open: true }));
    await screen.findByTestId('page-file-browser-crumbs');

    const levelsBox = crumbAt(1).parentElement?.parentElement as Element;
    expect(levelsBox, '找不到可见层级区').toBeTruthy();
    await waitFor(() => expect(observersOf(levelsBox)).toHaveLength(1));
    expect(observersOf(levelsBox)[0].disconnected).toBe(false);

    // 量宽真的跑了：可用宽度 100px 放不下两级（60 + 60 + 4）⇒ 浅层级收进省略号。
    expect(
      rect.mock.instances.some((instance) => instance === levelsBox),
      '量宽函数没有在可见层级区上跑过',
    ).toBe(true);
    expect(screen.getByTestId('page-file-browser-crumb-ellipsis')).toBeTruthy();
    expect(
      screen.getAllByTestId('page-file-browser-crumb').map((node) => node.getAttribute('data-depth')),
    ).toEqual(['-1', '1']);

    // 关闭：DOM 卸载 ⇒ 回调 ref 收到 null ⇒ disconnect。
    view.rerender(panelElement({ open: false }));
    await waitFor(() => expect(observersOf(levelsBox)[0].disconnected).toBe(true));

    // 再打开：重新 observe（不是拿已断开的旧观察器凑数）。
    view.rerender(panelElement({ open: true }));
    await screen.findByTestId('page-file-browser-crumbs');
    const reopenedBox = crumbAt(1).parentElement?.parentElement as Element;
    await waitFor(() => expect(observersOf(reopenedBox)).toHaveLength(1));
    expect(observersOf(reopenedBox)[0].disconnected).toBe(false);
  });

  it('回归：当前已是根目录时点根 crumb → 强制重读列表，不出「空目录」', async () => {
    // 根因：`setPath('/')` 传同值时 React bailout → 加载 effect 不重跑，
    // 而 `setEntries([])` 已经把列表清空了 ⇒ 停在「空目录」。
    mocks.listFiles.mockResolvedValue([entry({ name: 'workspace', kind: 'dir' })]);
    renderPanel({ initialPath: '/' });

    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));
    expect(mocks.listFiles).toHaveBeenCalledTimes(1);
    expect(mocks.listFiles).toHaveBeenLastCalledWith('demo-01', '/');

    fireEvent.click(crumbAt(-1));

    // 同路径点击必须**再读一次**（参数不变）。
    await waitFor(() => expect(mocks.listFiles).toHaveBeenCalledTimes(2));
    expect(mocks.listFiles).toHaveBeenLastCalledWith('demo-01', '/');
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));
    expect(screen.queryByTestId('page-file-browser-empty')).toBeNull();
  });

  it('回归：进入子目录后点当前层级 crumb → 重读该目录，列表不变', async () => {
    mocks.listFiles.mockImplementation((_sandbox: string, directory: string) =>
      Promise.resolve(
        directory === '/home/acc-demo/sub'
          ? [entry({ name: 'inner.txt', kind: 'file' })]
          : [entry({ name: 'sub', kind: 'dir' })],
      ),
    );
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(rowOf('sub'));
    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenLastCalledWith('demo-01', '/home/acc-demo/sub'),
    );
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));
    expect(rowOf('inner.txt')).toBeTruthy();
    // 当前层级 crumb = 最深一级（aria-current="page"）。
    expect(crumbAt(2).getAttribute('aria-current')).toBe('page');

    fireEvent.click(crumbAt(2));

    // 当前层级也要能点：重读该目录（参数不变），列表不被清空。
    await waitFor(() => expect(mocks.listFiles).toHaveBeenCalledTimes(3));
    expect(mocks.listFiles).toHaveBeenLastCalledWith('demo-01', '/home/acc-demo/sub');
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));
    expect(rowOf('inner.txt')).toBeTruthy();
    expect(screen.queryByTestId('page-file-browser-empty')).toBeNull();
  });

  it('目录行点击进入；文件行点击下载（行本身就是操作）', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'sub', kind: 'dir' })]);
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(rowOf('sub'));

    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenLastCalledWith('demo-01', '/home/acc-demo/sub'),
    );
  });

  it('列表读取失败：只在就地错误态显示后端 detail（面板状态不走 toast）', async () => {
    mocks.listFiles.mockRejectedValue(new ApiError('目标不是目录，不能列目录', 400));
    renderPanel();

    const error = await screen.findByTestId('page-file-browser-error');
    expect(error.textContent).toContain('目标不是目录，不能列目录');
    expect(toastsOf('error')).toHaveLength(0);
  });

  it('以空格结尾的目录名导航时不被 trim（原样发给后端，不 404）', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'logs ', kind: 'dir' })]);
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(rowOf('logs '));

    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenLastCalledWith('demo-01', '/home/acc-demo/logs '),
    );
  });
});

describe('上传', () => {
  it('选文件即上传到当前目录：调用参数、行内进度与完成后的列表刷新', async () => {
    let reportProgress: ((progress: TransferProgress) => void) | undefined;
    let resolveUpload: ((value: { path: string; bytes: number }) => void) | undefined;
    mocks.uploadFile.mockImplementation(
      (
        _sandbox: string,
        _path: string,
        _file: File,
        options?: { onProgress?: (progress: TransferProgress) => void },
      ) => {
        reportProgress = options?.onProgress;
        return new Promise((resolve) => {
          resolveUpload = resolve;
        });
      },
    );
    renderPanel();
    await screen.findByTestId('page-file-browser-list');

    chooseFiles(new File(['abc'], 'a.txt', { type: 'text/plain' }));

    const uploadRow = await screen.findByTestId('page-file-browser-upload-row');
    expect(uploadRow.getAttribute('data-upload-name')).toBe('a.txt');
    await waitFor(() => expect(mocks.uploadFile).toHaveBeenCalledTimes(1));
    expect(mocks.uploadFile.mock.calls[0][0]).toBe('demo-01');
    expect(mocks.uploadFile.mock.calls[0][1]).toBe('/home/acc-demo/a.txt');

    act(() => reportProgress?.({ loaded: 5, total: 10 }));
    await waitFor(() =>
      expect(
        within(uploadRow)
          .getByTestId('page-file-browser-upload-progress')
          .getAttribute('aria-valuenow'),
      ).toBe('50'),
    );

    act(() => resolveUpload?.({ path: '/home/acc-demo/a.txt', bytes: 3 }));
    await waitFor(() =>
      expect(screen.queryByTestId('page-file-browser-upload-row')).toBeNull(),
    );
    expect(toastsOf('success').some((node) => node.textContent?.includes('已上传 a.txt'))).toBe(
      true,
    );

    // 上传成功后重新读当前目录。
    expect(mocks.listFiles.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('多文件逐个排队上传', async () => {
    mocks.uploadFile.mockResolvedValue({ path: '/x', bytes: 1 });
    renderPanel();
    await screen.findByTestId('page-file-browser-list');

    chooseFiles(
      new File(['a'], 'one.txt', { type: 'text/plain' }),
      new File(['b'], 'two.txt', { type: 'text/plain' }),
    );

    await waitFor(() => expect(mocks.uploadFile).toHaveBeenCalledTimes(2));
    expect(mocks.uploadFile.mock.calls[0][2]).toMatchObject({ name: 'one.txt' });
    expect(mocks.uploadFile.mock.calls[1][2]).toMatchObject({ name: 'two.txt' });
  });

  it('取消上传：abort 信号被触发、行移除、弹提示 toast', async () => {
    let signal: AbortSignal | undefined;
    mocks.uploadFile.mockImplementation(
      (
        _sandbox: string,
        _path: string,
        _file: File,
        options?: { signal?: AbortSignal },
      ) =>
        new Promise((_resolve, reject) => {
          signal = options?.signal;
          options?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    renderPanel();
    await screen.findByTestId('page-file-browser-list');

    chooseFiles(new File(['abc'], 'a.txt', { type: 'text/plain' }));
    const uploadRow = await screen.findByTestId('page-file-browser-upload-row');
    fireEvent.click(within(uploadRow).getByTestId('page-file-browser-upload-cancel-button'));

    await waitFor(() => expect(signal?.aborted).toBe(true));
    await waitFor(() =>
      expect(screen.queryByTestId('page-file-browser-upload-row')).toBeNull(),
    );
    expect(toastsOf('info').some((node) => node.textContent?.includes('已取消上传：a.txt'))).toBe(
      true,
    );
    expect(toastsOf('error')).toHaveLength(0);
  });

  it('同名普通文件：先弹覆盖确认，确认后才上传', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt', kind: 'file' })]);
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    chooseFiles(new File(['abc'], 'a.txt', { type: 'text/plain' }));
    const dialog = await screen.findByTestId('page-file-browser-overwrite-dialog');
    expect(dialog.textContent).toContain('a.txt');
    expect(mocks.uploadFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('page-file-browser-overwrite-confirm-button'));

    await waitFor(() => expect(mocks.uploadFile).toHaveBeenCalledTimes(1));
  });

  it('覆盖确认取消：跳过该文件并弹提示 toast', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt', kind: 'file' })]);
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    chooseFiles(new File(['abc'], 'a.txt', { type: 'text/plain' }));
    await screen.findByTestId('page-file-browser-overwrite-dialog');
    fireEvent.click(screen.getByTestId('page-file-browser-overwrite-cancel-button'));

    await waitFor(() =>
      expect(screen.queryByTestId('page-file-browser-overwrite-dialog')).toBeNull(),
    );
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(toastsOf('info').some((node) => node.textContent?.includes('已跳过 a.txt'))).toBe(true);
  });

  it('列表还在加载时入队：先重新加载该目录，同名仍弹覆盖确认（不静默覆盖）', async () => {
    let resolveInitial: ((value: FileListEntry[]) => void) | undefined;
    let resolveReload: ((value: FileListEntry[]) => void) | undefined;
    mocks.listFiles
      .mockImplementationOnce(
        () =>
          new Promise<FileListEntry[]>((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<FileListEntry[]>((resolve) => {
            resolveReload = resolve;
          }),
      );
    renderPanel();

    chooseFiles(new File(['abc'], 'a.txt', { type: 'text/plain' }));

    // 列表不可信（还在加载）⇒ 入队前必须再读一次该目录。
    await waitFor(() => expect(mocks.listFiles).toHaveBeenCalledTimes(2));
    expect(mocks.listFiles).toHaveBeenLastCalledWith('demo-01', '/home/acc-demo');
    const uploadButton = screen.getByTestId('page-file-browser-upload-button');
    await waitFor(() => expect((uploadButton as HTMLButtonElement).disabled).toBe(true));
    expect(screen.queryByTestId('page-file-browser-overwrite-dialog')).toBeNull();

    act(() => resolveReload?.([entry({ name: 'a.txt', kind: 'file' })]));

    // 重新读到的列表里有同名文件：照常弹确认框，而不是直接覆盖。
    const dialog = await screen.findByTestId('page-file-browser-overwrite-dialog');
    expect(dialog.textContent).toContain('a.txt');
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    await waitFor(() => expect((uploadButton as HTMLButtonElement).disabled).toBe(false));

    // 首次（被打断的）读取即使随后返回，也不能再改写当前列表。
    act(() => resolveInitial?.([]));
    fireEvent.click(screen.getByTestId('page-file-browser-overwrite-confirm-button'));
    await waitFor(() => expect(mocks.uploadFile).toHaveBeenCalledTimes(1));
  });

  it('覆盖确认框等待时取消上传：关框、只弹取消提示，不多发「已跳过」', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt', kind: 'file' })]);
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    chooseFiles(new File(['abc'], 'a.txt', { type: 'text/plain' }));
    await screen.findByTestId('page-file-browser-overwrite-dialog');
    const uploadRow = screen.getByTestId('page-file-browser-upload-row');

    fireEvent.click(within(uploadRow).getByTestId('page-file-browser-upload-cancel-button'));

    await waitFor(() =>
      expect(screen.queryByTestId('page-file-browser-overwrite-dialog')).toBeNull(),
    );
    await waitFor(() =>
      expect(toastsOf('info').some((node) => node.textContent?.includes('已取消上传：a.txt'))).toBe(
        true,
      ),
    );
    expect(toastsOf('info').some((node) => node.textContent?.includes('已跳过'))).toBe(false);
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it('同名目录：不弹覆盖确认，服务端 400 的 detail 原样 toast', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'target', kind: 'dir' })]);
    mocks.uploadFile.mockRejectedValue(new ApiError('目标是一个目录，不能作为上传目标', 400));
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    chooseFiles(new File(['abc'], 'target', { type: 'text/plain' }));

    await waitFor(() => expect(mocks.uploadFile).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('page-file-browser-overwrite-dialog')).toBeNull();
    await waitFor(() =>
      expect(
        toastsOf('error').some((node) =>
          node.textContent?.includes('目标是一个目录，不能作为上传目标'),
        ),
      ).toBe(true),
    );
  });

  it('上传失败：错误 toast 用后端 detail 原文，进度行结束', async () => {
    mocks.uploadFile.mockRejectedValue(new ApiError('目标目录不可写', 400));
    renderPanel();
    await screen.findByTestId('page-file-browser-list');

    chooseFiles(new File(['abc'], 'a.txt', { type: 'text/plain' }));

    await waitFor(() =>
      expect(toastsOf('error').some((node) => node.textContent?.includes('目标目录不可写'))).toBe(
        true,
      ),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('page-file-browser-upload-row')).toBeNull(),
    );
  });
});

describe('关闭与切换收口', () => {
  it('关闭抽屉：abort 在途上传、清空队列；重开不显示上一个沙箱的行', async () => {
    let firstSignal: AbortSignal | undefined;
    mocks.uploadFile.mockImplementation(
      (
        _sandbox: string,
        _path: string,
        _file: File,
        options?: { signal?: AbortSignal },
      ) =>
        new Promise((_resolve, reject) => {
          firstSignal = options?.signal;
          options?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const view = renderPanel();
    await screen.findByTestId('page-file-browser-list');

    chooseFiles(
      new File(['a'], 'one.txt', { type: 'text/plain' }),
      new File(['b'], 'two.txt', { type: 'text/plain' }),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('page-file-browser-upload-row')).toHaveLength(2),
    );
    await waitFor(() => expect(mocks.uploadFile).toHaveBeenCalledTimes(1));

    view.rerender(panelElement({ open: false }));

    await waitFor(() => expect(firstSignal?.aborted).toBe(true));
    await waitFor(() =>
      expect(screen.queryAllByTestId('page-file-browser-upload-row')).toHaveLength(0),
    );

    // 重开到另一个沙箱：上一个沙箱的排队行不能残留，也不能继续上传。
    view.rerender(panelElement({ open: true, sandbox: 'demo-02' }));
    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenLastCalledWith('demo-02', '/home/acc-demo'),
    );
    expect(screen.queryAllByTestId('page-file-browser-upload-row')).toHaveLength(0);
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('关闭抽屉：在途下载的 AbortController 也被取消，行内进度清掉', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt', kind: 'file' })]);
    let downloadSignal: AbortSignal | undefined;
    mocks.downloadFile.mockImplementation(
      (_sandbox: string, _path: string, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          downloadSignal = options?.signal;
          options?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const view = renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(rowOf('a.txt'));
    await waitFor(() => expect(mocks.downloadFile).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        within(rowOf('a.txt')).getByTestId('page-file-browser-download-progress'),
      ).toBeTruthy(),
    );

    view.rerender(panelElement({ open: false }));

    await waitFor(() => expect(downloadSignal?.aborted).toBe(true));
    await waitFor(() =>
      expect(screen.queryByTestId('page-file-browser-download-progress')).toBeNull(),
    );
    expect(toastsOf('error')).toHaveLength(0);
  });
});

describe('下载', () => {
  it('点击文件行：按 Content-Length 报进度，完成后 blob → a[download]（不导航 blob: URL）', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt', kind: 'file', size: 100 })]);
    let reportProgress: ((progress: TransferProgress) => void) | undefined;
    let resolveDownload: ((value: DownloadFileResult) => void) | undefined;
    mocks.downloadFile.mockImplementation(
      (
        _sandbox: string,
        _path: string,
        options?: { onProgress?: (progress: TransferProgress) => void },
      ) => {
        reportProgress = options?.onProgress;
        return new Promise((resolve) => {
          resolveDownload = resolve;
        });
      },
    );
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(rowOf('a.txt'));
    await waitFor(() => expect(mocks.downloadFile).toHaveBeenCalledTimes(1));
    expect(mocks.downloadFile.mock.calls[0][1]).toBe('/home/acc-demo/a.txt');

    act(() => reportProgress?.({ loaded: 50, total: 100 }));
    await waitFor(() =>
      expect(
        within(rowOf('a.txt'))
          .getByTestId('page-file-browser-download-progress')
          .getAttribute('aria-valuenow'),
      ).toBe('50'),
    );

    const beforeHref = window.location.href;
    act(() =>
      resolveDownload?.({
        blob: new Blob(['hello']),
        contentDisposition:
          "attachment; filename=\"a.txt\"; filename*=UTF-8''%E4%B8%AD%E6%96%87.txt",
      }),
    );

    await waitFor(() => expect(clickedAnchors).toHaveLength(1));
    expect(clickedAnchors[0].download).toBe('中文.txt');
    expect(clickedAnchors[0].href).toContain('blob:mock');
    expect(window.location.href).toBe(beforeHref);
    expect(window.location.href).not.toContain('blob:');
  });

  it('多个文件并行下载：各自行内进度互不覆盖，完成各自清理', async () => {
    mocks.listFiles.mockResolvedValue([
      entry({ name: 'a.txt', kind: 'file', size: 100 }),
      entry({ name: 'b.txt', kind: 'file', size: 100 }),
    ]);
    const progress = new Map<string, (event: TransferProgress) => void>();
    const resolvers = new Map<string, (value: DownloadFileResult) => void>();
    mocks.downloadFile.mockImplementation(
      (
        _sandbox: string,
        path: string,
        options?: { onProgress?: (event: TransferProgress) => void },
      ) =>
        new Promise<DownloadFileResult>((resolve) => {
          if (options?.onProgress) {
            progress.set(path, options.onProgress);
          }
          resolvers.set(path, resolve);
        }),
    );
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(2));

    fireEvent.click(rowOf('a.txt'));
    fireEvent.click(rowOf('b.txt'));
    await waitFor(() => expect(mocks.downloadFile).toHaveBeenCalledTimes(2));

    act(() => {
      progress.get('/home/acc-demo/a.txt')?.({ loaded: 50, total: 100 });
      progress.get('/home/acc-demo/b.txt')?.({ loaded: 20, total: 100 });
    });
    await waitFor(() =>
      expect(
        within(rowOf('a.txt'))
          .getByTestId('page-file-browser-download-progress')
          .getAttribute('aria-valuenow'),
      ).toBe('50'),
    );
    expect(
      within(rowOf('b.txt'))
        .getByTestId('page-file-browser-download-progress')
        .getAttribute('aria-valuenow'),
    ).toBe('20');

    act(() =>
      resolvers.get('/home/acc-demo/a.txt')?.({
        blob: new Blob(['a']),
        contentDisposition: 'attachment; filename="a.txt"',
      }),
    );
    await waitFor(() =>
      expect(
        within(rowOf('a.txt')).queryByTestId('page-file-browser-download-progress'),
      ).toBeNull(),
    );
    expect(
      within(rowOf('b.txt'))
        .getByTestId('page-file-browser-download-progress')
        .getAttribute('aria-valuenow'),
    ).toBe('20');

    act(() =>
      resolvers.get('/home/acc-demo/b.txt')?.({
        blob: new Blob(['b']),
        contentDisposition: 'attachment; filename="b.txt"',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('page-file-browser-download-progress')).toBeNull(),
    );
    expect(clickedAnchors).toHaveLength(2);
  });

  it('下载失败：错误 toast 用后端 detail 原文', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt', kind: 'file' })]);
    mocks.downloadFile.mockRejectedValue(new ApiError('文件不存在', 404));
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(rowOf('a.txt'));

    await waitFor(() =>
      expect(toastsOf('error').some((node) => node.textContent?.includes('文件不存在'))).toBe(
        true,
      ),
    );
  });

  it('桌面形态：保存框取消 → 静默返回，不发下载命令、不弹 toast', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt', kind: 'file' })]);
    renderPanel({ desktop: true });
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(rowOf('a.txt'));

    await waitFor(() => expect(desktopMocks.pickDownloadPath).toHaveBeenCalledWith('a.txt'));
    expect(desktopMocks.downloadToDisk).not.toHaveBeenCalled();
    expect(mocks.downloadFile).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId('page-toast-item')).toHaveLength(0);
    expect(screen.queryByTestId('page-file-browser-download-progress')).toBeNull();
  });

  it('桌面形态：保存框确认 → invoke 参数正确、进度事件走到行内、成功 toast 带落盘路径', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: '报告.txt', kind: 'file', size: 200 })]);
    desktopMocks.pickDownloadPath.mockResolvedValue('C:\\Users\\me\\报告.txt');
    let report: ((event: unknown) => void) | undefined;
    desktopMocks.listenDownloadEvents.mockImplementation(
      (_sandbox: string, _id: string, handler: (event: unknown) => void) => {
        report = handler;
        return Promise.resolve(() => {});
      },
    );
    let resolveDownload: ((value: { target_path: string; bytes: number }) => void) | undefined;
    desktopMocks.downloadToDisk.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDownload = resolve;
        }),
    );

    renderPanel({ desktop: true });
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(rowOf('报告.txt'));

    await waitFor(() => expect(desktopMocks.listenDownloadEvents).toHaveBeenCalledTimes(1));
    const [sandboxArg, idArg] = desktopMocks.listenDownloadEvents.mock.calls[0] as [string, string];
    expect(sandboxArg).toBe('demo-01');
    expect(idArg).toMatch(/^dl-/);

    await waitFor(() => expect(desktopMocks.downloadToDisk).toHaveBeenCalledTimes(1));
    expect(desktopMocks.downloadToDisk).toHaveBeenCalledWith({
      sandbox: 'demo-01',
      path: '/home/acc-demo/报告.txt',
      targetPath: 'C:\\Users\\me\\报告.txt',
      downloadId: idArg,
    });
    expect(mocks.downloadFile).not.toHaveBeenCalled();

    act(() =>
      report?.({
        download_id: idArg,
        sandbox: 'demo-01',
        path: '/home/acc-demo/报告.txt',
        phase: 'progress',
        loaded: 80,
        total: 200,
        message: '',
        target_path: null,
      }),
    );
    await waitFor(() =>
      expect(
        within(rowOf('报告.txt'))
          .getByTestId('page-file-browser-download-progress')
          .getAttribute('aria-valuenow'),
      ).toBe('40'),
    );

    act(() =>
      resolveDownload?.({
        target_path: 'C:\\Users\\me\\报告.txt',
        bytes: 200,
      }),
    );
    await waitFor(() =>
      expect(
        toastsOf('success').some((node) =>
          node.textContent?.includes('C:\\Users\\me\\报告.txt'),
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('page-file-browser-download-progress')).toBeNull(),
    );
  });

  it('桌面形态：下载失败 → 失败 toast 用 Rust 固定中文文案', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt', kind: 'file' })]);
    desktopMocks.pickDownloadPath.mockResolvedValue('C:\\Users\\me\\a.txt');
    desktopMocks.downloadToDisk.mockRejectedValue(new Error('访问令牌无效，请检查连接配置'));

    renderPanel({ desktop: true });
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(rowOf('a.txt'));

    await waitFor(() =>
      expect(
        toastsOf('error').some((node) =>
          node.textContent?.includes('访问令牌无效，请检查连接配置'),
        ),
      ).toBe(true),
    );
  });

  it('桌面形态：关闭抽屉 → 取消在途下载并退掉进度订阅（不留半截文件）', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt', kind: 'file' })]);
    desktopMocks.pickDownloadPath.mockResolvedValue('C:\\Users\\me\\a.txt');
    const unsubscribe = vi.fn();
    desktopMocks.listenDownloadEvents.mockResolvedValue(unsubscribe);
    desktopMocks.downloadToDisk.mockImplementation(() => new Promise(() => {}));

    const view = renderPanel({ desktop: true });
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));
    fireEvent.click(rowOf('a.txt'));
    await waitFor(() => expect(desktopMocks.downloadToDisk).toHaveBeenCalledTimes(1));
    const downloadId = (
      desktopMocks.downloadToDisk.mock.calls[0][0] as { downloadId: string }
    ).downloadId;

    view.rerender(panelElement({ desktop: true, open: false }));

    await waitFor(() =>
      expect(desktopMocks.cancelDesktopDownload).toHaveBeenCalledWith(downloadId),
    );
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('桌面形态：订阅 IPC 往返期间关闭抽屉 → 退订且不发下载命令', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt', kind: 'file' })]);
    desktopMocks.pickDownloadPath.mockResolvedValue('C:\\Users\\me\\a.txt');
    const unsubscribe = vi.fn();
    let resolveListen: ((off: () => void) => void) | undefined;
    desktopMocks.listenDownloadEvents.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          resolveListen = resolve;
        }),
    );

    const view = renderPanel({ desktop: true });
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));
    fireEvent.click(rowOf('a.txt'));
    await waitFor(() => expect(desktopMocks.listenDownloadEvents).toHaveBeenCalledTimes(1));

    // 订阅还没回来，用户就把抽屉关了。
    view.rerender(panelElement({ desktop: true, open: false }));
    await act(async () => {
      resolveListen?.(unsubscribe);
    });

    await waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
    expect(desktopMocks.downloadToDisk).not.toHaveBeenCalled();
    expect(desktopMocks.cancelDesktopDownload).not.toHaveBeenCalled();
  });

  it('桌面形态：以「下载已取消」收口 → 静默，不弹失败 toast', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt', kind: 'file' })]);
    desktopMocks.pickDownloadPath.mockResolvedValue('C:\\Users\\me\\a.txt');
    desktopMocks.downloadToDisk.mockRejectedValue(new Error('下载已取消'));

    renderPanel({ desktop: true });
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));
    fireEvent.click(rowOf('a.txt'));

    await waitFor(() => expect(desktopMocks.downloadToDisk).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByTestId('page-file-browser-download-progress')).toBeNull(),
    );
    expect(toastsOf('error')).toHaveLength(0);
  });
});
