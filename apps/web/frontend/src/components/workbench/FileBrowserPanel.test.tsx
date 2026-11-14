// @vitest-environment jsdom
/**
 * 文件浏览面板：入口在 Workbench（另测），这里只测面板本身。
 *
 * 覆盖用户拍板的交互口径：
 * - 三列列表：文件夹在前、隐藏文件显示；点击文件行即下载（没有下载按钮）；
 * - 面包屑**父级**可点击、**当前层级是纯文本**（不可点、无按钮样式）；
 * - 上传只进当前目录、多文件逐个传、行内进度 + 取消；
 * - 同名普通文件先弹覆盖确认（确认 / 取消跳过并 toast）；同名目录不弹框，
 *   服务端 400 的 detail 原样 toast；
 * - 下载进度按 `Content-Length` 算，web 落 blob → a[download]（不导航 blob: URL）；
 * - 桌面分支：原生保存框（取消静默 / 确认后 invoke Rust 落盘）、进度事件、失败 toast；
 *   关闭抽屉取消在途下载。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  IncompleteReadError,
  TextNotPreviewableError,
  type DownloadFileResult,
  type ReadFileResult,
  type TransferProgress,
} from '../../api/client';
import type { FileListEntry } from '../../api/types';
import { clearSessionPwd, setSessionPwd } from '../../lib/terminal-pwd';
import { ToastProvider } from '../Toast';
import { FileBrowserPanel } from './FileBrowserPanel';

const mocks = vi.hoisted(() => ({
  listFiles: vi.fn(),
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  readFile: vi.fn(),
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
      readFile: mocks.readFile,
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
  sandbox?: string;
  sessionId?: string | null;
  workdir?: string;
  collapsed?: boolean;
  desktop?: boolean;
  onToggleCollapsed?: () => void;
}

function panelElement(overrides?: PanelOverrides) {
  return (
    <ToastProvider>
      <FileBrowserPanel
        sandbox={overrides?.sandbox ?? 'demo-01'}
        sessionId={overrides?.sessionId ?? 'sess-1'}
        workdir={overrides?.workdir ?? '/home/acc-demo'}
        collapsed={overrides?.collapsed ?? false}
        onToggleCollapsed={overrides?.onToggleCollapsed ?? (() => {})}
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
  mocks.readFile.mockReset();
  mocks.readFile.mockResolvedValue({
    text: 'hello',
    binary: false,
    size: 5,
    bytes: 5,
    truncated: false,
  } satisfies ReadFileResult);
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
  // pwd 缓存是模块级的：用例之间清掉（免得串到下一条）。
  clearSessionPwd('sess-1');
  clearSessionPwd('sess-2');
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

  it('面包屑父级可点击，点上级目录重新读取列表', async () => {
    renderPanel();
    expect(screen.getAllByTestId('page-file-browser-crumb')).toHaveLength(3);
    expect(crumbAt(-1).getAttribute('aria-current')).toBeNull();
    expect(crumbAt(1).getAttribute('aria-current')).toBe('page');

    // 父级仍是按钮（当前层级已是纯文本 span）。
    expect(crumbAt(0).tagName).toBe('BUTTON');

    fireEvent.click(crumbAt(0));

    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenLastCalledWith('demo-01', '/home'),
    );
  });

  it('面包屑与上传按钮同一行、同高；当前级是纯文本（无按钮样式）', () => {
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

    // **当前层级去按钮化**：纯文本（span）——不可点、无 hover / 无下划线 /
    // 无底色 / 无焦点环 / 不进 tab 序；只留可读文字色与截断。
    const current = crumbAt(1);
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(current.tagName).toBe('SPAN');
    const currentTokens = classTokens(current);
    expect(
      currentTokens.filter((token) => token.startsWith('hover:')),
      `当前级不该有 hover 样式：${current.className}`,
    ).toEqual([]);
    expect(
      currentTokens.filter((token) => token.startsWith('focus-visible:')),
      `当前级不该有焦点环：${current.className}`,
    ).toEqual([]);
    expect(
      currentTokens.some((token) => token.includes('underline')),
      `当前级不该有下划线：${current.className}`,
    ).toBe(false);
    expect(
      currentTokens.some((token) => /^bg-/.test(token)),
      `当前级不该有底色：${current.className}`,
    ).toBe(false);
    // 按钮的 padding 也去掉了（量宽行同步去掉 ⇒ 宽度基准一致）。
    expect(
      currentTokens.some((token) => /^p[xy]-/.test(token)),
      `当前级不该有按钮 padding：${current.className}`,
    ).toBe(false);
    // 只读样式：可读文字色 + 截断。
    expect(currentTokens).toContain('text-foreground');
    expect(currentTokens).toContain('truncate');

    // 父级仍是按钮（可点），走链接样式（不是按钮底色 hover）。
    const parent = crumbAt(0);
    expect(parent.getAttribute('aria-current')).toBeNull();
    expect(parent.tagName).toBe('BUTTON');
    expect(classTokens(parent)).not.toContain('hover:bg-muted');

    // 链接样式（`text-primary` + `hover:underline`）在**有文字**的层级按钮上。
    expect(classTokens(parent)).toContain('text-primary');
    expect(classTokens(parent)).toContain('hover:underline');

    // 根图标钮是纯图标：下划线**画不出来**（`text-decoration` 不向 flex item
    // 的后代传播）⇒ 不挂 hover:underline，hover 反馈走底色 / 变色。
    // （当前不在根时根 crumb 是**父级** ⇒ 维持现状：按钮 + hover 反馈。）
    const root = crumbAt(-1);
    const rootTokens = classTokens(root);
    expect(root.tagName).toBe('BUTTON');
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

  it('量宽基准节点挂上即挂观察器并量宽；卸载时 disconnect', async () => {
    const observer = stubResizeObserver();
    const rect = stubCrumbLayout();
    /** 观察了某个节点的观察器实例（Base UI 自己的观察器不算）。 */
    const observersOf = (node: Element) =>
      observer.instances.filter((record) => record.observed.includes(node));

    const view = renderPanel();

    // 窗格一直挂着（不再有「抽屉打开才渲染内容」那一层）：
    // 回调 ref 在节点出现时触发 ⇒ 挂观察器 + 立即量一次。
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

    // 卸载：DOM 卸载 ⇒ 回调 ref 收到 null ⇒ disconnect。
    view.unmount();
    await waitFor(() => expect(observersOf(levelsBox)[0].disconnected).toBe(true));
  });

  it('回归：当前已是根目录时根 crumb 是静态（不可点）——点它不重读，列表不清空', async () => {
    // 口径：**当前层级去按钮化**（纯文本、不可点）⇒ 「当前就是根目录」时
    // 根 crumb 也是静态元素，**不再有**「点根 crumb 变空目录」这条交互路径。
    mocks.listFiles.mockResolvedValue([entry({ name: 'workspace', kind: 'dir' })]);
    renderPanel({ workdir: '/' });

    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));
    expect(mocks.listFiles).toHaveBeenCalledTimes(1);
    expect(mocks.listFiles).toHaveBeenLastCalledWith('demo-01', '/');

    // 根 crumb = 当前层级 ⇒ 静态 span（不是按钮），`aria-current` 仍在。
    const root = crumbAt(-1);
    expect(root.tagName).toBe('SPAN');
    expect(root.getAttribute('aria-current')).toBe('page');
    // 静态：没有 hover 样式、没有焦点环、不进 tab 序。
    const rootTokens = classTokens(root);
    expect(rootTokens.filter((token) => token.startsWith('hover:'))).toEqual([]);
    expect(rootTokens.filter((token) => token.startsWith('focus-visible:'))).toEqual([]);
    expect(root.getAttribute('tabindex')).toBeNull();

    // 点它**不触发**任何请求（不可点），列表也不被清空。
    fireEvent.click(root);
    expect(mocks.listFiles).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1);
    expect(screen.queryByTestId('page-file-browser-empty')).toBeNull();
  });

  it('回归：进入子目录后当前层级 crumb 是纯文本（不可点）——点它不重读，列表不变', async () => {
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
    // 当前层级 crumb = 最深一级（aria-current="page"）：**纯文本 span**，不可点。
    const current = crumbAt(2);
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(current.tagName).toBe('SPAN');

    // 点它**不触发**任何请求（不可点），列表不被清空。
    fireEvent.click(current);
    expect(mocks.listFiles).toHaveBeenCalledTimes(2);
    expect(mocks.listFiles).toHaveBeenLastCalledWith('demo-01', '/home/acc-demo/sub');
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

describe('卸载与切换收口', () => {
  it('卸载窗格：abort 在途上传、清空队列；换沙箱不显示上一个沙箱的行', async () => {
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

    // 窗格消失（会话没了 / 切到别的 tab）⇒ 在途上传收口。
    view.unmount();

    await waitFor(() => expect(firstSignal?.aborted).toBe(true));
    await waitFor(() =>
      expect(screen.queryAllByTestId('page-file-browser-upload-row')).toHaveLength(0),
    );
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('换沙箱：上一个沙箱的排队行不能残留，也不继续上传', async () => {
    mocks.uploadFile.mockImplementation(
      () => new Promise(() => {}),
    );
    const view = renderPanel();
    await screen.findByTestId('page-file-browser-list');

    chooseFiles(new File(['a'], 'one.txt', { type: 'text/plain' }));
    await waitFor(() =>
      expect(screen.getAllByTestId('page-file-browser-upload-row')).toHaveLength(1),
    );
    await waitFor(() => expect(mocks.uploadFile).toHaveBeenCalledTimes(1));

    // 换沙箱：窗格重新定位到新沙箱的 workdir，上一个沙箱的活儿全部收掉。
    view.rerender(panelElement({ sandbox: 'demo-02', workdir: '/home/acc-other' }));
    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenLastCalledWith('demo-02', '/home/acc-other'),
    );
    expect(screen.queryAllByTestId('page-file-browser-upload-row')).toHaveLength(0);
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('换沙箱（同起点 `/`）：旧沙箱的行立即清空，新沙箱慢查询返回前绝不残留', async () => {
    let resolveNew: ((entries: FileListEntry[]) => void) | undefined;
    mocks.listFiles.mockImplementation((sandbox: string) => {
      if (sandbox === 'demo-01') {
        return Promise.resolve([entry({ name: 'old.txt' })]);
      }
      return new Promise<FileListEntry[]>((resolve) => {
        resolveNew = resolve;
      });
    });

    // 两边都没 pwd / workdir ⇒ 同一起点 `/`（旧实现会走 applyPath 的同路径分支，
    // 不碰 entries，旧行一直挂到新沙箱的慢查询返回）。
    const view = renderPanel({ sandbox: 'demo-01', workdir: '' });
    await waitFor(() => expect(rowOf('old.txt')).toBeTruthy());

    view.rerender(panelElement({ sandbox: 'demo-02', workdir: '' }));
    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenLastCalledWith('demo-02', '/'),
    );

    // 新列表还没回来：窗格必须已经空掉，绝不显示旧沙箱的条目。
    expect(screen.queryAllByTestId('page-file-browser-row')).toHaveLength(0);
    expect(screen.queryByText('old.txt')).toBeNull();
    expect(screen.getByTestId('page-file-browser-loading')).toBeTruthy();

    await act(async () => {
      resolveNew?.([entry({ name: 'new.txt' })]);
    });
    await waitFor(() => expect(rowOf('new.txt')).toBeTruthy());
    expect(screen.queryByText('old.txt')).toBeNull();
  });

  it('卸载窗格：在途下载的 AbortController 也被取消，行内进度清掉', async () => {
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

    view.unmount();

    await waitFor(() => expect(downloadSignal?.aborted).toBe(true));
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

  it('桌面形态：窗格被卸载 → 取消在途下载并退掉进度订阅（不留半截文件）', async () => {
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

    view.unmount();

    await waitFor(() =>
      expect(desktopMocks.cancelDesktopDownload).toHaveBeenCalledWith(downloadId),
    );
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('桌面形态：订阅 IPC 往返期间窗格被卸载 → 退订且不发下载命令', async () => {
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

    // 订阅还没回来，用户就把窗格关了（会话没了 / 切走了）。
    view.unmount();
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

describe('窗格定位（fallback 链）与无自动跟随', () => {
  it('会话 pwd 可得 ⇒ 从 pwd 起读目录', async () => {
    setSessionPwd('sess-1', '/workspace/src');

    renderPanel();

    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenCalledWith('demo-01', '/workspace/src'),
    );
  });

  it('会话没上报 pwd ⇒ 从沙箱 workdir 起读目录', async () => {
    renderPanel({ workdir: '/home/acc-demo/work' });

    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenCalledWith('demo-01', '/home/acc-demo/work'),
    );
  });

  it('pwd 与 workdir 都不可得 ⇒ 兜底到容器根目录', async () => {
    renderPanel({ workdir: '' });

    await waitFor(() => expect(mocks.listFiles).toHaveBeenCalledWith('demo-01', '/'));
  });

  it('pwd 迟到：补定位一次；之后 pwd 再变也**不再联动**', async () => {
    renderPanel();

    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenCalledWith('demo-01', '/home/acc-demo'),
    );
    expect(mocks.listFiles).toHaveBeenCalledTimes(1);

    // pwd 迟到（shell 刚画提示符才报上来）⇒ 补定位一次。
    act(() => {
      setSessionPwd('sess-1', '/workspace');
    });
    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenLastCalledWith('demo-01', '/workspace'),
    );
    expect(mocks.listFiles).toHaveBeenCalledTimes(2);

    // 之后再变：窗格**一动不动**（无自动跟随）。
    act(() => {
      setSessionPwd('sess-1', '/elsewhere');
    });
    await waitFor(() => expect(mocks.listFiles).toHaveBeenCalledTimes(2));
    expect(mocks.listFiles).not.toHaveBeenCalledWith('demo-01', '/elsewhere');
  });

  it('用户已经导航过：pwd 来了也不把窗格带走', async () => {
    mocks.listFiles.mockImplementation((_sandbox: string, directory: string) =>
      Promise.resolve(
        directory === '/home/acc-demo'
          ? [entry({ name: 'sub', kind: 'dir' })]
          : [],
      ),
    );

    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    // 用户自己进了子目录。
    fireEvent.click(rowOf('sub'));
    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenLastCalledWith('demo-01', '/home/acc-demo/sub'),
    );

    // pwd 这时才到：不动（用户的目录优先）。
    act(() => {
      setSessionPwd('sess-1', '/workspace');
    });
    await waitFor(() => expect(mocks.listFiles).toHaveBeenCalledTimes(2));
    expect(mocks.listFiles).not.toHaveBeenCalledWith('demo-01', '/workspace');
  });

  it('换会话：A 里导航到子目录后切到 B，落 B 的 fallback 起点（不留在 A 的子目录）', async () => {
    setSessionPwd('sess-1', '/from-a');
    mocks.listFiles.mockImplementation((_sandbox: string, directory: string) =>
      Promise.resolve(
        directory === '/from-a' ? [entry({ name: 'a-sub', kind: 'dir' })] : [],
      ),
    );

    const view = renderPanel({ sessionId: 'sess-1', workdir: '/workdir' });
    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenCalledWith('demo-01', '/from-a'),
    );

    // 用户在会话 A 里导航走了。
    fireEvent.click(rowOf('a-sub'));
    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenLastCalledWith('demo-01', '/from-a/a-sub'),
    );

    // 切到会话 B（没上报 pwd）：窗格必须按 B 的 fallback 链重新定位，
    // 绝不留在 A 里用户去的目录（userNavigatedRef 已随会话复位）。
    mocks.listFiles.mockClear();
    view.rerender(panelElement({ sessionId: 'sess-2', workdir: '/workdir' }));
    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenLastCalledWith('demo-01', '/workdir'),
    );
    expect(
      mocks.listFiles.mock.calls.some(([, directory]) => directory === '/from-a/a-sub'),
    ).toBe(false);
    expect(screen.queryByText('a-sub')).toBeNull();
  });
});

describe('回跳按钮', () => {
  it('pwd 已缓存：挂载首帧就显示回跳目标（不先闪「未上报」）', () => {
    setSessionPwd('sess-1', '/workspace');
    // 列表挂住不返回：只看首帧的回跳口径，不让异步列表掩盖问题。
    mocks.listFiles.mockReturnValue(new Promise(() => {}));

    renderPanel();

    const jump = screen.getByTestId('page-file-pane-jump-button');
    expect(jump.getAttribute('title')).toBe('跳转到终端当前目录：/workspace');
    expect((jump as HTMLButtonElement).disabled).toBe(true); // 已在目标目录
  });

  it('会话没上报工作目录：禁用 + tooltip「当前会话未上报工作目录」', async () => {
    renderPanel();

    const jump = await screen.findByTestId('page-file-pane-jump-button');
    expect((jump as HTMLButtonElement).disabled).toBe(true);
    expect(jump.getAttribute('title')).toBe('当前会话未上报工作目录');
  });

  it('有 pwd：tooltip 是「跳转到终端当前目录：<路径>」，点击即导航', async () => {
    setSessionPwd('sess-1', '/workspace');
    mocks.listFiles.mockImplementation((_sandbox: string, directory: string) =>
      Promise.resolve(
        directory === '/workspace' ? [entry({ name: 'sub', kind: 'dir' })] : [],
      ),
    );

    renderPanel();

    await waitFor(() => expect(mocks.listFiles).toHaveBeenCalledWith('demo-01', '/workspace'));
    const jump = await screen.findByTestId('page-file-pane-jump-button');
    expect(jump.getAttribute('title')).toBe('跳转到终端当前目录：/workspace');

    // 先走到别的目录，回跳按钮就能用了。
    fireEvent.click(rowOf('sub'));
    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenLastCalledWith('demo-01', '/workspace/sub'),
    );
    expect((jump as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(jump);
    await waitFor(() => expect(mocks.listFiles).toHaveBeenLastCalledWith('demo-01', '/workspace'));
  });

  it('窗格已在目标目录：回跳按钮禁用', async () => {
    setSessionPwd('sess-1', '/workspace');

    renderPanel();

    await waitFor(() => expect(mocks.listFiles).toHaveBeenCalledWith('demo-01', '/workspace'));
    const jump = await screen.findByTestId('page-file-pane-jump-button');
    expect((jump as HTMLButtonElement).disabled).toBe(true);
    expect(jump.getAttribute('title')).toBe('跳转到终端当前目录：/workspace');
  });

  it('pwd 变化：tooltip 跟着更新', async () => {
    renderPanel();

    const jump = await screen.findByTestId('page-file-pane-jump-button');
    expect(jump.getAttribute('title')).toBe('当前会话未上报工作目录');

    act(() => {
      setSessionPwd('sess-1', '/workspace');
    });

    await waitFor(() =>
      expect(screen.getByTestId('page-file-pane-jump-button').getAttribute('title')).toBe(
        '跳转到终端当前目录：/workspace',
      ),
    );
  });
});

describe('折叠态', () => {
  it('折叠：右缘竖条上只有展开按钮，没有任何文字', async () => {
    renderPanel({ collapsed: true });

    const collapsed = await screen.findByTestId('page-file-pane-collapsed');
    expect(collapsed.querySelectorAll('button')).toHaveLength(1);
    expect(collapsed.textContent).toBe('');
    expect(screen.getByTestId('page-file-pane-expand-button')).toBeTruthy();
    // 折叠态不渲染列表（竖条就是全部）。
    expect(screen.queryByTestId('page-file-browser-list')).toBeNull();
  });

  it('点展开按钮：回调父组件切回展开', async () => {
    const onToggleCollapsed = vi.fn();
    renderPanel({ collapsed: true, onToggleCollapsed });

    fireEvent.click(await screen.findByTestId('page-file-pane-expand-button'));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });
});

describe('预览（窗格内的第二视图）', () => {
  function previewButtonOf(name: string): HTMLElement {
    return within(rowOf(name)).getByTestId('page-file-browser-row-preview-button');
  }

  function stubClipboard(writeText: (text: string) => Promise<void>): void {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  }

  it('hover 文件行时行尾浮现「预览」眼睛钮：不带文字、带 aria-label、150ms 淡入', async () => {
    mocks.listFiles.mockResolvedValue([
      entry({ name: 'a.txt', kind: 'file' }),
      entry({ name: 'sub', kind: 'dir', size: 0 }),
    ]);
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(2));

    const button = previewButtonOf('a.txt');
    // 不带文字（纯图标）
    expect(button.textContent).toBe('');
    expect(button.getAttribute('aria-label')).toBe('预览 a.txt');
    expect(button.getAttribute('title')).toBe('预览');
    const tokens = classTokens(button);
    // 约 150ms 淡入：默认透明、整行 hover 时浮现
    expect(tokens).toContain('opacity-0');
    expect(tokens).toContain('transition-opacity');
    expect(tokens).toContain('duration-150');
    expect(tokens).toContain('group-hover:opacity-100');
    // 行本身有 group（hover 的锚）
    expect(classTokens(rowOf('a.txt'))).toContain('group');
    // **行尾**：眼睛钮挂在「修改时间」那一格（hover 时时间文字淡出，不叠字）
    expect(
      within(button.parentElement as HTMLElement).getByTestId('page-file-browser-row-mtime'),
    ).toBeTruthy();
    // 目录行没有预览钮
    expect(
      within(rowOf('sub')).queryByTestId('page-file-browser-row-preview-button'),
    ).toBeNull();
  });

  it('行单击仍是下载（既有通道零改动）；点眼睛才读取预览', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt', size: 5 })]);
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(rowOf('a.txt'));
    await waitFor(() => expect(mocks.downloadFile).toHaveBeenCalledTimes(1));
    // 行单击**没有**触发预览读取
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('点眼睛：按列表 size 请求读取、渲染等宽正文 + 行号、工具条齐全', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.md', size: 9 })]);
    mocks.readFile.mockResolvedValue({
      text: '# 标题\n正文\n',
      binary: false,
      size: 9,
      bytes: 9,
      truncated: false,
    } satisfies ReadFileResult);
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(previewButtonOf('a.md'));
    await waitFor(() => expect(mocks.readFile).toHaveBeenCalledTimes(1));

    // 请求参数：沙箱 / 绝对路径 / **max_bytes = 列表条目的 size**（请求全量）
    expect(mocks.readFile.mock.calls[0][0]).toBe('demo-01');
    expect(mocks.readFile.mock.calls[0][1]).toBe('/home/acc-demo/a.md');
    expect(mocks.readFile.mock.calls[0][2]).toMatchObject({ maxBytes: 9 });

    // 预览是窗格内的第二视图：列表让位（不是弹层 / 抽屉）
    await waitFor(() => expect(screen.queryByTestId('page-file-browser-row')).toBeNull());
    expect(screen.getByTestId('page-file-preview')).toBeTruthy();
    // 工具条 = 返回 + 文件名 / 大小 + 复制
    expect(screen.getByTestId('page-file-preview-back-button')).toBeTruthy();
    expect(screen.getByTestId('page-file-preview-title').textContent).toBe('a.md');
    expect(screen.getByTestId('page-file-preview-size').textContent).toBe('9 B');
    expect(screen.getByTestId('page-file-preview-copy-button')).toBeTruthy();
    // 预览态里列表态的操作（回跳 / 上传）不出现，折叠钮还在
    expect(screen.queryByTestId('page-file-browser-upload-button')).toBeNull();
    expect(screen.queryByTestId('page-file-pane-jump-button')).toBeNull();
    expect(screen.getByTestId('page-file-pane-collapse-button')).toBeTruthy();

    // 正文：等宽 + 行号槽 + **纯文本**（`.md` 不渲染 markdown）
    const body = screen.getByTestId('page-file-preview-body');
    expect(classTokens(body)).toContain('font-mono');
    const lines = screen.getAllByTestId('page-file-preview-line').map((node) => node.textContent);
    expect(lines).toEqual(['# 标题', '正文']);
    expect(
      screen.getAllByTestId('page-file-preview-line-number').map((node) => node.textContent),
    ).toEqual(['1', '2']);
    expect(document.querySelector('h1')).toBeNull();
    expect(document.querySelector('strong')).toBeNull();
    expect(document.querySelector('pre code')).toBeNull();
  });

  it('Esc 与返回钮等价：退回列表；列表态没有返回钮', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt' })]);
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(previewButtonOf('a.txt'));
    await waitFor(() => expect(screen.getByTestId('page-file-preview')).toBeTruthy());

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('page-file-preview')).toBeNull());
    expect(screen.getByTestId('page-file-browser-row')).toBeTruthy();
    // 列表态（返回栈为空）：返回钮不出现
    expect(screen.queryByTestId('page-file-preview-back-button')).toBeNull();

    // 再进一次，用返回钮退出
    fireEvent.click(previewButtonOf('a.txt'));
    await waitFor(() => expect(screen.getByTestId('page-file-preview')).toBeTruthy());
    fireEvent.click(screen.getByTestId('page-file-preview-back-button'));
    await waitFor(() => expect(screen.queryByTestId('page-file-preview')).toBeNull());
  });

  it('复制：成功零 toast、图标变对勾约 1 秒后复原', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt' })]);
    mocks.readFile.mockResolvedValue({
      text: 'line-1\nline-2',
      binary: false,
      size: 13,
      bytes: 13,
      truncated: false,
    } satisfies ReadFileResult);
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(previewButtonOf('a.txt'));
    await waitFor(() =>
      expect(screen.getAllByTestId('page-file-preview-line')).toHaveLength(2),
    );

    // 换假计时器只为钉「约 1 秒复原」（不用 waitFor，纯推进时间）
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(screen.getByTestId('page-file-preview-copy-button'));
      });
      expect(writeText).toHaveBeenCalledWith('line-1\nline-2');
      // 对勾态：可访问名跟着变
      expect(
        screen.getByTestId('page-file-preview-copy-button').getAttribute('aria-label'),
      ).toBe('已复制');
      // **成功零 toast**
      expect(toastsOf('success')).toHaveLength(0);
      expect(toastsOf('error')).toHaveLength(0);

      act(() => {
        vi.advanceTimersByTime(999);
      });
      expect(
        screen.getByTestId('page-file-preview-copy-button').getAttribute('aria-label'),
      ).toBe('已复制');
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(
        screen.getByTestId('page-file-preview-copy-button').getAttribute('aria-label'),
      ).toBe('复制');
    } finally {
      vi.useRealTimers();
    }
  });

  it('复制失败：失败才 toast（来源 file-browser），图标不变对勾', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt' })]);
    stubClipboard(() => Promise.reject(new Error('denied')));
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(previewButtonOf('a.txt'));
    await waitFor(() => expect(screen.getByTestId('page-file-preview')).toBeTruthy());

    fireEvent.click(screen.getByTestId('page-file-preview-copy-button'));
    await waitFor(() =>
      expect(
        toastsOf('error').some(
          (node) =>
            node.textContent?.includes('复制到系统剪贴板失败') &&
            node.getAttribute('data-toast-source') === 'file-browser',
        ),
      ).toBe(true),
    );
    expect(
      screen.getByTestId('page-file-preview-copy-button').getAttribute('aria-label'),
    ).toBe('复制');
  });

  it('大文件（> 2 MB）：先二次确认（取消不发请求），确认后进度条加载并渲染全文', async () => {
    const big = 3 * 1024 * 1024;
    mocks.listFiles.mockResolvedValue([entry({ name: 'big.txt', size: big })]);
    let reportProgress: ((loaded: number) => void) | undefined;
    let resolveRead: ((value: ReadFileResult) => void) | undefined;
    mocks.readFile.mockImplementation(
      (
        _sandbox: string,
        _path: string,
        options?: { onProgress?: (loaded: number) => void },
      ) => {
        reportProgress = options?.onProgress;
        return new Promise<ReadFileResult>((resolve) => {
          resolveRead = resolve;
        });
      },
    );
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    // 点预览 ⇒ 先弹二次确认，**一个请求都没发**
    fireEvent.click(previewButtonOf('big.txt'));
    await waitFor(() => expect(screen.getByTestId('page-file-preview-confirm-dialog')).toBeTruthy());
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(screen.getByTestId('page-file-preview-confirm-dialog').textContent).toContain('超过 2 MB');

    // 取消：不发请求、留在列表态
    fireEvent.click(screen.getByTestId('page-file-preview-confirm-cancel-button'));
    await waitFor(() =>
      expect(screen.queryByTestId('page-file-preview-confirm-dialog')).toBeNull(),
    );
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1);

    // 再点 + 确认：这时才发起读取
    fireEvent.click(previewButtonOf('big.txt'));
    await waitFor(() => expect(screen.getByTestId('page-file-preview-confirm-dialog')).toBeTruthy());
    fireEvent.click(screen.getByTestId('page-file-preview-confirm-button'));
    await waitFor(() => expect(mocks.readFile).toHaveBeenCalledTimes(1));
    expect(mocks.readFile.mock.calls[0][2]).toMatchObject({ maxBytes: big });

    // 进度条：已接收字节 / size（transferPercent）
    act(() => reportProgress?.(Math.floor(big / 2)));
    await waitFor(() =>
      expect(
        screen.getByTestId('page-file-preview-progress').getAttribute('aria-valuenow'),
      ).toBe('50'),
    );

    // 加载完：全文渲染、进度条消失、**没有任何「文件过大」提示条**
    act(() =>
      resolveRead?.({
        text: 'line-1\nline-2\nline-3',
        binary: false,
        size: big,
        bytes: big,
        truncated: false,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getAllByTestId('page-file-preview-line').map((node) => node.textContent),
      ).toEqual(['line-1', 'line-2', 'line-3']),
    );
    expect(screen.queryByTestId('page-file-preview-progress')).toBeNull();
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('文件过大');
    expect(text).not.toContain('仅展示前');
  });

  it('二次确认框开着按 Esc：只关框，不发起读取、也不退出列表态', async () => {
    const big = 3 * 1024 * 1024;
    mocks.listFiles.mockResolvedValue([entry({ name: 'big.txt', size: big })]);
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(previewButtonOf('big.txt'));
    await waitFor(() => expect(screen.getByTestId('page-file-preview-confirm-dialog')).toBeTruthy());

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByTestId('page-file-preview-confirm-dialog')).toBeNull(),
    );
    // 只关框：留在列表态（预览栈未被动过），一个请求都没发
    expect(screen.queryByTestId('page-file-preview')).toBeNull();
    expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1);
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('小文件：直接加载、不出现进度条', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt', size: 300 })]);
    mocks.readFile.mockImplementation(() => new Promise<ReadFileResult>(() => {}));
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(previewButtonOf('a.txt'));
    await waitFor(() => expect(mocks.readFile).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('page-file-preview-loading')).toBeTruthy();
    expect(screen.queryByTestId('page-file-preview-progress')).toBeNull();
    // 没有二次确认
    expect(screen.queryByTestId('page-file-preview-confirm-dialog')).toBeNull();
  });

  it('二进制：空态构图（居中线框图标 + 文案 + 描边「下载文件」钮，点击走既有下载）', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.bin', size: 16 })]);
    mocks.readFile.mockResolvedValue({
      text: '',
      binary: true,
      size: 16,
      bytes: 0,
      truncated: false,
    } satisfies ReadFileResult);
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(previewButtonOf('a.bin'));
    const empty = await waitFor(() => screen.getByTestId('page-file-preview-unsupported'));
    expect(empty.textContent).toContain('二进制文件无法预览');
    expect(screen.queryByTestId('page-file-preview-body')).toBeNull();
    // 按钮是描边样式（border + background 类，不是主色实心）
    const downloadButton = screen.getByTestId('page-file-preview-download-button');
    expect(downloadButton.textContent).toBe('下载文件');
    const tokens = classTokens(downloadButton);
    expect(tokens).toContain('border');
    expect(tokens.some((token) => token.startsWith('bg-primary'))).toBe(false);

    // 点击走**既有下载通道**（同一路径）
    fireEvent.click(downloadButton);
    await waitFor(() => expect(mocks.downloadFile).toHaveBeenCalledTimes(1));
    expect(mocks.downloadFile.mock.calls[0][1]).toBe('/home/acc-demo/a.bin');
  });

  it('非 UTF-8（解码失败）：同样按「无法展示」处理（空态 + 下载钮）', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt', size: 16 })]);
    mocks.readFile.mockRejectedValue(new TextNotPreviewableError());
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(previewButtonOf('a.txt'));
    const empty = await waitFor(() => screen.getByTestId('page-file-preview-unsupported'));
    expect(empty.textContent).toContain('文件不是 UTF-8 文本，无法预览');
    expect(screen.getByTestId('page-file-preview-download-button')).toBeTruthy();
    // 视图状态不是操作结果：不弹 toast
    expect(toastsOf('error')).toHaveLength(0);
  });

  it('读取失败：就地错误态（role=alert），不弹 toast', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt' })]);
    mocks.readFile.mockRejectedValue(new ApiError('文件不存在：/home/acc-demo/a.txt', 404));
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(previewButtonOf('a.txt'));
    const alert = await waitFor(() => screen.getByTestId('page-file-preview-error'));
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('文件不存在');
    expect(toastsOf('error')).toHaveLength(0);
  });

  it('流提前结束（IncompleteReadError）：就地错误态，不当合法空文件渲染', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt', size: 10 })]);
    mocks.readFile.mockRejectedValue(new IncompleteReadError());
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(previewButtonOf('a.txt'));
    const alert = await waitFor(() => screen.getByTestId('page-file-preview-error'));
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('读取中断，文件不完整');
    // **不是**空文件：不渲染正文 / 行号，也不弹 toast
    expect(screen.queryByTestId('page-file-preview-body')).toBeNull();
    expect(screen.queryAllByTestId('page-file-preview-line')).toHaveLength(0);
    expect(toastsOf('error')).toHaveLength(0);
  });

  it('复制钮只在 ready 态可用：loading / error / unsupported 均 disabled', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt', size: 5 })]);
    let rejectRead: ((reason?: unknown) => void) | undefined;
    mocks.readFile.mockImplementation(
      () =>
        new Promise<ReadFileResult>((_resolve, reject) => {
          rejectRead = reject;
        }),
    );
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    const copyButton = (): HTMLButtonElement =>
      screen.getByTestId('page-file-preview-copy-button') as HTMLButtonElement;

    // loading：不可复制（不然会复制空串还亮对勾）
    fireEvent.click(previewButtonOf('a.txt'));
    await waitFor(() => expect(screen.getByTestId('page-file-preview-loading')).toBeTruthy());
    expect(copyButton().disabled).toBe(true);

    // error：仍不可复制
    await act(async () => {
      rejectRead?.(new ApiError('读取失败', 500));
    });
    await waitFor(() => expect(screen.getByTestId('page-file-preview-error')).toBeTruthy());
    expect(copyButton().disabled).toBe(true);

    // unsupported（二进制）：仍不可复制
    mocks.readFile.mockResolvedValue({
      text: '',
      binary: true,
      size: 5,
      bytes: 0,
      truncated: false,
    } satisfies ReadFileResult);
    fireEvent.click(screen.getByTestId('page-file-preview-back-button'));
    await waitFor(() => expect(screen.queryByTestId('page-file-preview')).toBeNull());
    fireEvent.click(previewButtonOf('a.txt'));
    await waitFor(() =>
      expect(screen.getByTestId('page-file-preview-unsupported')).toBeTruthy(),
    );
    expect(copyButton().disabled).toBe(true);

    // ready：才可复制
    mocks.readFile.mockResolvedValue({
      text: 'hello',
      binary: false,
      size: 5,
      bytes: 5,
      truncated: false,
    } satisfies ReadFileResult);
    fireEvent.click(screen.getByTestId('page-file-preview-back-button'));
    await waitFor(() => expect(screen.queryByTestId('page-file-preview')).toBeNull());
    fireEvent.click(previewButtonOf('a.txt'));
    await waitFor(() =>
      expect(screen.getAllByTestId('page-file-preview-line')).toHaveLength(1),
    );
    expect(copyButton().disabled).toBe(false);
  });

  it('面包屑联动：预览态下当前层级恢复可点，点它回该目录列表并强制重读', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt' })]);
    renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    // 列表态：当前层级是纯文本（不可点）
    const before = screen
      .getAllByTestId('page-file-browser-crumb')
      .find((node) => node.getAttribute('data-depth') === '1');
    expect(before?.tagName).toBe('SPAN');

    fireEvent.click(previewButtonOf('a.txt'));
    await waitFor(() => expect(screen.getByTestId('page-file-preview')).toBeTruthy());

    // 预览态：当前层级恢复为可点按钮
    const current = screen
      .getAllByTestId('page-file-browser-crumb')
      .find((node) => node.getAttribute('data-depth') === '1');
    expect(current?.tagName).toBe('BUTTON');
    expect(current?.getAttribute('aria-current')).toBe('page');

    const callsBefore = mocks.listFiles.mock.calls.length;
    fireEvent.click(current as HTMLElement);
    await waitFor(() => expect(screen.queryByTestId('page-file-preview')).toBeNull());
    // **同路径强制重读**：点当前目录也重新拉数据
    await waitFor(() =>
      expect(mocks.listFiles.mock.calls.length).toBeGreaterThan(callsBefore),
    );
    expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1);
  });

  it('卸载窗格：在途预览读取被 abort（换会话 / 换沙箱靠重挂载收口）', async () => {
    mocks.listFiles.mockResolvedValue([entry({ name: 'a.txt' })]);
    let signal: AbortSignal | undefined;
    mocks.readFile.mockImplementation(
      (_sandbox: string, _path: string, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return new Promise<ReadFileResult>(() => {});
      },
    );
    const view = renderPanel();
    await waitFor(() => expect(screen.getAllByTestId('page-file-browser-row')).toHaveLength(1));

    fireEvent.click(previewButtonOf('a.txt'));
    await waitFor(() => expect(mocks.readFile).toHaveBeenCalledTimes(1));
    expect(signal?.aborted).toBe(false);

    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
