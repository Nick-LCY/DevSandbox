// @vitest-environment jsdom
/**
 * Obsidian 阅读器骨架：vault 根引导态 / 根记忆 / vault 树（过滤 + 懒展开 +
 * 展开态持久）/ 选中态。
 *
 * 口径来源：PRD「方案四 · Obsidian tab」的 OBS-03 / OBS-04 / OBS-05。
 * markdown 渲染与 wikilink 在 07 轮，这里只断言「选中路径先搭好」。
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TextNotPreviewableError, type ReadFileResult } from '../../api/client';
import type { FileListEntry } from '../../api/types';
import {
  readStoredExpandedPaths,
  readStoredSelection,
  readStoredVaultRoot,
  vaultExpandedStorageKey,
  vaultRootStorageKey,
  writeStoredExpandedPaths,
  writeStoredSelection,
  writeStoredVaultRoot,
} from '../../lib/obsidian-vault';
import { ToastProvider } from '../Toast';
import { ObsidianWorkspace } from './ObsidianWorkspace';

const mocks = vi.hoisted(() => ({
  listFiles: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listFiles: mocks.listFiles,
      readFile: mocks.readFile,
    },
  };
});

/** 假文件内容（`path → 原文`）：`readFile` 的默认实现从这里取。 */
const FILE_CONTENTS = new Map<string, string>();

function setFile(path: string, text: string): void {
  FILE_CONTENTS.set(path, text);
}

function entry(overrides: Partial<FileListEntry>): FileListEntry {
  return { name: 'a.md', kind: 'file', size: 10, mtime: 1_700_000_000, ...overrides };
}

const ROOT = '/vault';

/** 造一棵最小 vault：一个子目录 + 若干 md / 非 md / special 条目。 */
function mockVault(): void {
  mocks.listFiles.mockImplementation((_sandbox: string, path: string) => {
    if (path === ROOT) {
      return Promise.resolve([
        entry({ name: 'notes', kind: 'dir' }),
        entry({ name: 'index.md', size: 128 }),
        entry({ name: 'todo.txt' }),
        entry({ name: 'pipe', kind: 'special' }),
        entry({ name: 'media', kind: 'dir' }),
      ]);
    }
    if (path === '/vault/notes') {
      return Promise.resolve([
        entry({ name: 'deep', kind: 'dir' }),
        entry({ name: 'daily.md', size: 64 }),
        entry({ name: 'image.png' }),
      ]);
    }
    if (path === '/vault/notes/deep') {
      return Promise.resolve([entry({ name: 'idea.md', size: 8 })]);
    }
    return Promise.resolve([]);
  });
}

function renderWorkspace(props: { sandbox?: string; workdir?: string } = {}) {
  return render(
    <ToastProvider>
      <ObsidianWorkspace sandbox={props.sandbox ?? 'demo'} workdir={props.workdir ?? '/work'} />
    </ToastProvider>,
  );
}

/** 树里某个路径的节点。 */
function treeNode(testId: string, path: string): HTMLElement | undefined {
  return screen
    .queryAllByTestId(testId)
    .find((node) => node.getAttribute('data-path') === path);
}

beforeEach(() => {
  // `readFile` 默认按 `FILE_CONTENTS` 返回全文（每个用例可自行覆盖）。
  mocks.readFile.mockImplementation((_sandbox: string, path: string) => {
    const text = FILE_CONTENTS.get(path);
    if (text === undefined) {
      return Promise.reject(new Error(`读不到文件：${path}`));
    }
    return Promise.resolve({
      text,
      binary: false,
      size: text.length,
      bytes: text.length,
      truncated: false,
    } satisfies ReadFileResult);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.listFiles.mockReset();
  mocks.readFile.mockReset();
  FILE_CONTENTS.clear();
  window.localStorage.clear();
});

describe('引导态（未设根）', () => {
  it('显示书本线框图标 + 标题 + 两条设根入口', () => {
    renderWorkspace();

    expect(screen.getByTestId('page-sandbox-detail-obsidian-onboarding-icon')).toBeTruthy();
    expect(
      screen.getByTestId('page-sandbox-detail-obsidian-onboarding-title').textContent,
    ).toBe('选择一个目录作为 vault 根');
    expect(screen.getByTestId('page-sandbox-detail-obsidian-use-workdir-button').textContent).toBe(
      '使用沙箱工作目录',
    );
    expect(screen.getByTestId('page-sandbox-detail-obsidian-root-input')).toBeTruthy();
    expect(screen.getByTestId('page-sandbox-detail-obsidian-root-open-button').textContent).toBe(
      '打开',
    );
    // 没有根：不列目录、也没有左栏树干。
    expect(mocks.listFiles).not.toHaveBeenCalled();
    expect(screen.queryByTestId('page-sandbox-detail-obsidian-vault-tree')).toBeNull();
  });

  it('沙箱工作目录不可得时「使用沙箱工作目录」禁用', () => {
    renderWorkspace({ workdir: '' });
    const button = screen.getByTestId(
      'page-sandbox-detail-obsidian-use-workdir-button',
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('沙箱工作目录不可用');
  });

  it('入口一：点「使用沙箱工作目录」设根（按沙箱落盘 + 左栏列出树）', async () => {
    mockVault();

    renderWorkspace({ sandbox: 'demo-a', workdir: '/home/dev/project' });

    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-use-workdir-button'));

    const rootLabel = await screen.findByTestId('page-sandbox-detail-obsidian-vault-root');
    expect(rootLabel.textContent).toBe('vault 根：/home/dev/project');
    expect(readStoredVaultRoot('demo-a')).toBe('/home/dev/project');
    expect(readStoredVaultRoot('demo-b')).toBeNull();
    expect(mocks.listFiles).toHaveBeenCalledWith('demo-a', '/home/dev/project');
  });

  it('入口二：输入框敲路径后点「打开」设根（回车同样生效）', async () => {
    mockVault();

    renderWorkspace({ sandbox: 'demo-a' });

    const input = screen.getByTestId('page-sandbox-detail-obsidian-root-input') as HTMLInputElement;
    const openButton = screen.getByTestId(
      'page-sandbox-detail-obsidian-root-open-button',
    ) as HTMLButtonElement;
    // 没填 / 填了非法路径：按钮禁用。
    expect(openButton.disabled).toBe(true);
    expect(screen.queryByTestId('page-sandbox-detail-obsidian-root-error')).toBeNull();

    fireEvent.change(input, { target: { value: 'relative/path' } });
    expect(openButton.disabled).toBe(true);
    expect(screen.getByTestId('page-sandbox-detail-obsidian-root-error').textContent).toBe(
      '请输入绝对路径',
    );

    fireEvent.change(input, { target: { value: ROOT } });
    expect(openButton.disabled).toBe(false);
    fireEvent.click(openButton);

    expect(
      (await screen.findByTestId('page-sandbox-detail-obsidian-vault-root')).textContent,
    ).toBe(`vault 根：${ROOT}`);
    expect(readStoredVaultRoot('demo-a')).toBe(ROOT);

    // 回车也是一条入口：清掉根再敲一次。
    cleanup();
    mocks.listFiles.mockReset();
    mockVault();
    window.localStorage.clear();
    renderWorkspace({ sandbox: 'demo-a' });
    const input2 = screen.getByTestId('page-sandbox-detail-obsidian-root-input');
    fireEvent.change(input2, { target: { value: '/vault-two' } });
    fireEvent.keyDown(input2, { key: 'Enter' });
    expect(
      (await screen.findByTestId('page-sandbox-detail-obsidian-vault-root')).textContent,
    ).toBe('vault 根：/vault-two');
    expect(readStoredVaultRoot('demo-a')).toBe('/vault-two');
  });

  it('根按沙箱隔离：另一个沙箱仍是引导态，原沙箱的根不受影响', async () => {
    mockVault();
    writeStoredVaultRoot('demo-a', ROOT);

    render(
      <ToastProvider>
        <ObsidianWorkspace sandbox="demo-b" workdir="/work" />
      </ToastProvider>,
    );

    expect(screen.getByTestId('page-sandbox-detail-obsidian-onboarding')).toBeTruthy();
    expect(readStoredVaultRoot('demo-a')).toBe(ROOT);
    expect(readStoredVaultRoot('demo-b')).toBeNull();
  });

  it('已存根时直接进树视图（刷新后仍在）', async () => {
    mockVault();
    writeStoredVaultRoot('demo', ROOT);

    renderWorkspace();

    expect(
      (await screen.findByTestId('page-sandbox-detail-obsidian-vault-root')).textContent,
    ).toBe(`vault 根：${ROOT}`);
    expect(mocks.listFiles).toHaveBeenCalledWith('demo', ROOT);
  });
});

describe('双栏分隔把手（复验修复轮·第二批 #4：左树可拖拽）', () => {
  function pointerEvent(type: string, clientX: number, pointerId: number): Event {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    return event;
  }

  async function renderWithRoot(): Promise<HTMLElement> {
    mockVault();
    writeStoredVaultRoot('demo', ROOT);
    renderWorkspace();
    await screen.findByTestId('page-sandbox-detail-obsidian-vault-root');
    return screen.getByTestId('page-sandbox-detail-obsidian');
  }

  it('分隔把手：role=separator + 数值可读（默认树宽 264、下限 180）', async () => {
    await renderWithRoot();

    const handle = screen.getByTestId('page-sandbox-detail-obsidian-divider');
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-label')).toBe('调整 vault 树宽度');
    expect(handle.getAttribute('aria-valuemin')).toBe('180');
    // jsdom 量不到容器宽 ⇒ 上限就是绝对最大宽 520
    expect(handle.getAttribute('aria-valuemax')).toBe('520');
    expect(handle.getAttribute('aria-valuenow')).toBe('264');
    // a11y 增强（复验修复轮·第二批审查）：数值带单位（两处调用共用）
    expect(handle.getAttribute('aria-valuetext')).toBe('264px');
    // 左树按当前宽度渲染（默认 264px），预览区吃剩余宽度（flex-1）
    const tree = screen.getByTestId('page-sandbox-detail-obsidian-vault-tree');
    expect(tree.style.width).toBe('264px');
  });

  it('把手常显且直角（与文件窗格骑缝把手同一份共用组件）', async () => {
    await renderWithRoot();

    const handle = screen.getByTestId('page-sandbox-detail-obsidian-divider');
    const tokens = handle.className.split(/\s+/).filter(Boolean);
    // 常显：把手带静置有底色（不再「hover 才显形」）
    expect(tokens).toContain('bg-muted');
    expect(tokens).not.toContain('bg-transparent');
    // hover 高亮保留；本体与高亮都直角（无任何圆角 token）
    expect(tokens).toContain('hover:bg-primary/30');
    expect(tokens.filter((token) => token.includes('rounded'))).toEqual([]);
    // 抓握图标静置可见（不再是半透明 /40）
    const icon = handle.querySelector('svg');
    expect(icon).toBeTruthy();
    const iconTokens = (icon as unknown as SVGElement).getAttribute('class')?.split(/\s+/) ?? [];
    expect(iconTokens).toContain('text-muted-foreground');
    expect(iconTokens.some((token) => token.includes('/40'))).toBe(false);
  });

  it('指针拖拽：树在左 ⇒ 往右拖树变宽、往左拖树变窄', async () => {
    await renderWithRoot();
    const handle = screen.getByTestId('page-sandbox-detail-obsidian-divider');

    fireEvent(handle, pointerEvent('pointerdown', 500, 1));
    fireEvent(handle, pointerEvent('pointermove', 600, 1));
    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-detail-obsidian-vault-tree').style.width).toBe(
        '364px',
      ),
    );
    // aria 同步跟随
    expect(handle.getAttribute('aria-valuenow')).toBe('364');

    fireEvent(handle, pointerEvent('pointermove', 200, 1));
    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-detail-obsidian-vault-tree').style.width).toBe(
        '180px',
      ),
    );
    expect(handle.getAttribute('aria-valuenow')).toBe('180');
  });

  it('方向键调宽：→ 变宽 16px、← 变窄 16px（树在左，方向与文件窗格相反）', async () => {
    await renderWithRoot();
    const handle = screen.getByTestId('page-sandbox-detail-obsidian-divider');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    await waitFor(() => expect(handle.getAttribute('aria-valuenow')).toBe('280'));

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    await waitFor(() => expect(handle.getAttribute('aria-valuenow')).toBe('264'));
  });

  it('宽度是会话内内存态：重挂载回默认（不入 localStorage）', async () => {
    const split = await renderWithRoot();
    const handle = screen.getByTestId('page-sandbox-detail-obsidian-divider');

    fireEvent(handle, pointerEvent('pointerdown', 500, 1));
    fireEvent(handle, pointerEvent('pointermove', 600, 1));
    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-detail-obsidian-vault-tree').style.width).toBe(
        '364px',
      ),
    );
    expect(split).toBeTruthy();

    // 卸载重挂（换沙箱 / 刷新即重挂）：宽度回默认，存储里什么都没写
    cleanup();
    mockVault();
    writeStoredVaultRoot('demo', ROOT);
    renderWorkspace();
    await screen.findByTestId('page-sandbox-detail-obsidian-vault-root');
    expect(screen.getByTestId('page-sandbox-detail-obsidian-vault-tree').style.width).toBe(
      '264px',
    );
    /*
     * 这条 localStorage 断言只是个**哨兵**：仅防后人「顺手给树宽加持久化」的
     * 回归（一旦真写了这个 key 就红）。**宽度的实质保障是上一行**——重挂后
     * 回默认 264px；key 名与「有没有写」都不是契约本体，别为迁就这条断言改
     * 存储口径（复验修复轮·第二批审查 #6）。
     */
    expect(window.localStorage.getItem('sandbox-console-obsidian-tree-width')).toBeNull();
  });
});

describe('vault 树', () => {
  it('只列目录与 .md 文件（txt / special 不出现）', async () => {
    mockVault();
    writeStoredVaultRoot('demo', ROOT);

    renderWorkspace();

    await waitFor(() => expect(treeNode('page-sandbox-detail-obsidian-tree-dir', '/vault/notes')).toBeTruthy());
    expect(treeNode('page-sandbox-detail-obsidian-tree-dir', '/vault/media')).toBeTruthy();
    expect(treeNode('page-sandbox-detail-obsidian-tree-file', '/vault/index.md')).toBeTruthy();
    expect(screen.queryAllByTestId('page-sandbox-detail-obsidian-tree-file')).toHaveLength(1);
    expect(screen.queryByText('todo.txt')).toBeNull();
    expect(screen.queryByText('pipe')).toBeNull();
  });

  it('目录懒展开：点了才列举子目录，三角箭头旋转 90°', async () => {
    mockVault();
    writeStoredVaultRoot('demo', ROOT);

    renderWorkspace();

    const dir = await waitFor(() => {
      const node = treeNode('page-sandbox-detail-obsidian-tree-dir', '/vault/notes');
      expect(node).toBeTruthy();
      return node as HTMLElement;
    });
    expect(dir.getAttribute('data-expanded')).toBe('false');
    expect(mocks.listFiles).not.toHaveBeenCalledWith('demo', '/vault/notes');

    fireEvent.click(dir);

    await waitFor(() => expect(treeNode('page-sandbox-detail-obsidian-tree-file', '/vault/notes/daily.md')).toBeTruthy());
    expect(mocks.listFiles).toHaveBeenCalledWith('demo', '/vault/notes');
    const expandedDir = treeNode('page-sandbox-detail-obsidian-tree-dir', '/vault/notes');
    expect(expandedDir?.getAttribute('data-expanded')).toBe('true');
    expect(
      expandedDir
        ?.querySelector('[data-testid="page-sandbox-detail-obsidian-tree-chevron"]')
        ?.getAttribute('class'),
    ).toContain('rotate-90');
    // 子目录也过滤掉了非 md 文件。
    expect(screen.queryByText('image.png')).toBeNull();
  });

  it('展开态按路径落盘；再点收起即从存储里移除', async () => {
    mockVault();
    writeStoredVaultRoot('demo', ROOT);

    renderWorkspace();

    const dir = await waitFor(() => {
      const node = treeNode('page-sandbox-detail-obsidian-tree-dir', '/vault/notes');
      expect(node).toBeTruthy();
      return node as HTMLElement;
    });
    fireEvent.click(dir);
    await waitFor(() => expect(readStoredExpandedPaths('demo')).toEqual(['/vault/notes']));

    fireEvent.click(dir);
    await waitFor(() => expect(readStoredExpandedPaths('demo')).toEqual([]));
    expect(treeNode('page-sandbox-detail-obsidian-tree-file', '/vault/notes/daily.md')).toBeUndefined();
  });

  it('刷新后展开态仍在（持久化的展开项会补列举子目录）', async () => {
    mockVault();
    writeStoredVaultRoot('demo', ROOT);
    writeStoredExpandedPaths('demo', ['/vault/notes']);

    renderWorkspace();

    await waitFor(() =>
      expect(treeNode('page-sandbox-detail-obsidian-tree-file', '/vault/notes/daily.md')).toBeTruthy(),
    );
    expect(
      treeNode('page-sandbox-detail-obsidian-tree-dir', '/vault/notes')?.getAttribute('data-expanded'),
    ).toBe('true');
    expect(mocks.listFiles).toHaveBeenCalledWith('demo', '/vault/notes');
  });

  it('目录读取失败：就地错误态（role=alert），不弹 toast', async () => {
    mocks.listFiles.mockRejectedValue(new Error('容器未运行'));
    writeStoredVaultRoot('demo', ROOT);

    renderWorkspace();

    const error = await screen.findByTestId('page-sandbox-detail-obsidian-tree-error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toBe('容器未运行');
  });

  it('半开：展开父目录后再展开子目录，层级线随层出现', async () => {
    mockVault();
    writeStoredVaultRoot('demo', ROOT);

    renderWorkspace();

    const notesDir = await waitFor(() => {
      const node = treeNode('page-sandbox-detail-obsidian-tree-dir', '/vault/notes');
      expect(node).toBeTruthy();
      return node as HTMLElement;
    });
    fireEvent.click(notesDir);
    const deep = await waitFor(() => {
      const node = treeNode('page-sandbox-detail-obsidian-tree-dir', '/vault/notes/deep');
      expect(node).toBeTruthy();
      return node as HTMLElement;
    });
    fireEvent.click(deep);

    await waitFor(() =>
      expect(treeNode('page-sandbox-detail-obsidian-tree-file', '/vault/notes/deep/idea.md')).toBeTruthy(),
    );
    expect(readStoredExpandedPaths('demo')).toEqual(['/vault/notes', '/vault/notes/deep']);
    expect(screen.getAllByTestId('page-sandbox-detail-obsidian-tree-children')).toHaveLength(2);
  });
});

describe('更改根与选中态', () => {
  it('「更改」回引导态并预填原根；改完左栏换新根', async () => {
    mockVault();
    writeStoredVaultRoot('demo', ROOT);

    renderWorkspace();

    await screen.findByTestId('page-sandbox-detail-obsidian-vault-root');
    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-change-root-button'));

    const input = screen.getByTestId('page-sandbox-detail-obsidian-root-input') as HTMLInputElement;
    expect(input.value).toBe(ROOT);
    // 左栏树干还在（更改只是右栏回引导态）。
    expect(screen.getByTestId('page-sandbox-detail-obsidian-vault-tree')).toBeTruthy();

    fireEvent.change(input, { target: { value: '/vault-two' } });
    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-root-open-button'));

    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-detail-obsidian-vault-root').textContent).toBe(
        'vault 根：/vault-two',
      ),
    );
    expect(readStoredVaultRoot('demo')).toBe('/vault-two');
    expect(mocks.listFiles).toHaveBeenCalledWith('demo', '/vault-two');
  });

  it('换到更小的根：旧根下的展开项被裁掉（state + 存储），不再列举界外目录', async () => {
    mockVault();
    writeStoredVaultRoot('demo', ROOT);
    writeStoredExpandedPaths('demo', ['/vault/notes', '/vault/media']);

    renderWorkspace();

    // 初始恢复：两个展开项都会补列举（并发恢复是设计如此）。
    await waitFor(() => expect(mocks.listFiles).toHaveBeenCalledWith('demo', '/vault/notes'));
    await waitFor(() => expect(mocks.listFiles).toHaveBeenCalledWith('demo', '/vault/media'));
    const mediaCallsBefore = mocks.listFiles.mock.calls.filter(
      ([, path]) => path === '/vault/media',
    ).length;

    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-change-root-button'));
    const input = screen.getByTestId('page-sandbox-detail-obsidian-root-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/vault/notes/deep' } });
    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-root-open-button'));

    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-detail-obsidian-vault-root').textContent).toBe(
        'vault 根：/vault/notes/deep',
      ),
    );
    // `/vault/notes` 与 `/vault/media` 都在新根之外 ⇒ 展开态与存储都裁空。
    expect(readStoredExpandedPaths('demo')).toEqual([]);
    await waitFor(() =>
      expect(
        treeNode('page-sandbox-detail-obsidian-tree-file', '/vault/notes/deep/idea.md'),
      ).toBeTruthy(),
    );
    expect(
      mocks.listFiles.mock.calls.filter(([, path]) => path === '/vault/media').length,
    ).toBe(mediaCallsBefore);
  });

  it('右侧预览区：默认「从左侧选择文件」，点 .md 后进入阅读器并带上选中路径', async () => {
    mockVault();
    setFile('/vault/index.md', '# 首页\n');
    writeStoredVaultRoot('demo', ROOT);

    renderWorkspace();

    expect(
      (await screen.findByTestId('page-sandbox-detail-obsidian-preview-empty')).textContent,
    ).toBe('从左侧选择文件');

    const file = await waitFor(() => {
      const node = treeNode('page-sandbox-detail-obsidian-tree-file', '/vault/index.md');
      expect(node).toBeTruthy();
      return node as HTMLElement;
    });
    fireEvent.click(file);

    const preview = screen.getByTestId('page-sandbox-detail-obsidian-preview');
    expect(preview.getAttribute('data-selected-path')).toBe('/vault/index.md');
    expect(treeNode('page-sandbox-detail-obsidian-tree-file', '/vault/index.md')?.getAttribute('data-active')).toBe(
      'true',
    );
    expect(screen.queryByTestId('page-sandbox-detail-obsidian-preview-empty')).toBeNull();
    // 07 轮：占位（`-preview-placeholder`）退役，换成真正的阅读器。
    expect((await screen.findByTestId('page-sandbox-detail-obsidian-preview-title')).textContent).toBe(
      'index.md',
    );
    expect(screen.queryByTestId('page-sandbox-detail-obsidian-preview-placeholder')).toBeNull();
  });
});

describe('沙箱键一致性', () => {
  it('存储键名与 lib 里的一致（避免两处各写一串）', () => {
    expect(vaultRootStorageKey('demo')).toBe('sandbox-console-obsidian-vault-root:demo');
    expect(vaultExpandedStorageKey('demo')).toBe('sandbox-console-obsidian-expanded:demo');
    expect(window.localStorage.getItem(vaultRootStorageKey('demo'))).toBeNull();
  });
});

/* ---------------------------------------------------- 07 轮：阅读器 */

const READER_INDEX = [
  '---',
  'title: 文档',
  'tags: [a]',
  '---',
  '',
  '# 标题一',
  '',
  '## 标题二',
  '',
  '段落：**粗体**、`行内码`、[[target]]、[[notes/deep|别名]]、[[#小节]]、[[missing]]。',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
  '- [ ] 待办',
  '- [x] 已办',
  '',
  '> 引用块',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '<script>window.__pwn = 1;</script>',
  '',
].join('\n');

/** 阅读器用的 vault：根上 index / target / big，子目录 notes。 */
function mockReaderVault(options: { bigSize?: number; linkBig?: boolean } = {}): void {
  const rootEntries: FileListEntry[] = [
    entry({ name: 'notes', kind: 'dir' }),
    entry({ name: 'index.md', size: READER_INDEX.length }),
    entry({ name: 'target.md', size: 40 }),
  ];
  if (options.bigSize !== undefined) {
    rootEntries.push(entry({ name: 'big.md', size: options.bigSize }));
  }
  mocks.listFiles.mockImplementation((_sandbox: string, path: string) => {
    if (path === ROOT) {
      return Promise.resolve(rootEntries);
    }
    if (path === '/vault/notes') {
      return Promise.resolve([entry({ name: 'deep.md', size: 30 })]);
    }
    return Promise.resolve([]);
  });
  setFile(
    '/vault/index.md',
    options.linkBig === true ? `${READER_INDEX}\n[[big]]\n` : READER_INDEX,
  );
  setFile('/vault/target.md', '# 目标\n\n被链接到的目标文件。\n');
  setFile('/vault/notes/deep.md', '# 深\n');
  setFile('/vault/big.md', '# 大文件正文\n');
}

/** 点树上的根级文件（阅读器用例都在根上取文件）。 */
async function openReaderFile(path: string): Promise<void> {
  const node = await waitFor(() => {
    const found = treeNode('page-sandbox-detail-obsidian-tree-file', path);
    expect(found).toBeTruthy();
    return found as HTMLElement;
  });
  fireEvent.click(node);
}

/** 渲染态里 data-target 对得上的那条 wikilink。 */
async function wikilinkOf(target: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = screen
      .queryAllByTestId('page-sandbox-detail-obsidian-preview-wikilink')
      .find((node) => node.getAttribute('data-target') === target);
    expect(found).toBeTruthy();
    return found as HTMLElement;
  });
}

function toasts(): HTMLElement[] {
  return screen.queryAllByTestId('page-toast-item');
}

describe('阅读器：工具条与渲染 / 源码双态（OBS-06 / OBS-07）', () => {
  it('工具条 = 文件名 / 大小 / 渲染·源码分段 / 复制；栈底不渲染返回钮', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', ROOT);
    renderWorkspace();

    await openReaderFile('/vault/index.md');

    expect((await screen.findByTestId('page-sandbox-detail-obsidian-preview-title')).textContent).toBe(
      'index.md',
    );
    expect(
      screen.getByTestId('page-sandbox-detail-obsidian-preview-size').textContent,
    ).toBe(`${READER_INDEX.length} B`);

    const renderMode = screen.getByTestId('page-sandbox-detail-obsidian-preview-mode-render');
    const sourceMode = screen.getByTestId('page-sandbox-detail-obsidian-preview-mode-source');
    expect(renderMode.textContent).toBe('渲染');
    expect(sourceMode.textContent).toBe('源码');
    expect(renderMode.getAttribute('aria-pressed')).toBe('true');
    expect(sourceMode.getAttribute('aria-pressed')).toBe('false');
    expect(renderMode.getAttribute('data-active')).toBe('true');

    // 只有一层历史：返回钮不渲染。
    expect(screen.queryByTestId('page-sandbox-detail-obsidian-preview-back-button')).toBeNull();
    expect(screen.getByTestId('page-sandbox-detail-obsidian-preview-copy-button')).toBeTruthy();
  });

  it('左右两栏 header 复用同一高度令牌（结构性齐平，不靠像素断言）', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', ROOT);
    renderWorkspace();

    await openReaderFile('/vault/index.md');

    // 用户反馈两侧 header 高度差几个 px：修复口径是「同一 class 常量」——
    // vault header 与预览工具条都挂 OBSIDIAN_HEADER_CLASS（同一 h-* + border-b），
    // 这里钉的是**结构性保证**（两侧都含同一高度令牌），不写脆弱的像素断言。
    const header = screen.getByTestId('page-sandbox-detail-obsidian-vault-header');
    const toolbar = screen.getByTestId('page-sandbox-detail-obsidian-preview-toolbar');
    expect(header.className).toContain('h-10');
    expect(toolbar.className).toContain('h-10');
    expect(header.className).toContain('border-b');
    expect(toolbar.className).toContain('border-b');
  });

  it('渲染态：内容列填满预览区宽度 + 标题 / 深底代码块 / 列表 / 任务列表 / 引用 / 行内码 / 粗体；frontmatter 隐藏', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', ROOT);
    renderWorkspace();

    await openReaderFile('/vault/index.md');
    const body = await screen.findByTestId('page-sandbox-detail-obsidian-preview-body');
    expect(body.getAttribute('data-mode')).toBe('render');

    const content = within(body).getByTestId('page-sandbox-detail-obsidian-preview-content');
    // 内容列**填满预览区宽度**（不再 620px 居中限宽，用户浏览器复验修复轮）：
    // 满宽、无上限、无水平居中。
    expect(content.className).toContain('w-full');
    expect(content.className).not.toContain('max-w-[620px]');
    expect(content.className).not.toContain('mx-auto');

    // 标题层级
    expect(within(content).getByRole('heading', { level: 1 }).textContent).toBe('标题一');
    expect(within(content).getByRole('heading', { level: 2 }).textContent).toBe('标题二');

    // 深底代码块（终端恒定深色令牌）
    const pre = content.querySelector('pre');
    expect(pre).toBeTruthy();
    expect(pre?.className).toContain('bg-terminal-bg');
    expect(pre?.textContent).toContain('const a = 1;');

    // 列表 + 任务列表（静态不可勾）
    expect(content.querySelectorAll('ul li').length).toBeGreaterThanOrEqual(4);
    const checkboxes = content.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(2);
    for (const box of checkboxes) {
      expect((box as HTMLInputElement).disabled).toBe(true);
    }

    // 引用块 / 行内码 / 粗体
    expect(content.querySelector('blockquote')?.textContent).toContain('引用块');
    expect(content.querySelectorAll('code').length).toBeGreaterThanOrEqual(2);
    expect(content.querySelector('strong')?.textContent).toBe('粗体');

    // frontmatter：渲染态隐藏
    expect(content.textContent).not.toContain('title: 文档');
    expect(content.textContent).not.toContain('tags: [a]');
  });

  it('不放行原始 HTML：<script> 不渲染为标签、不执行', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', ROOT);
    renderWorkspace();

    await openReaderFile('/vault/index.md');
    const body = await screen.findByTestId('page-sandbox-detail-obsidian-preview-body');

    expect(body.querySelector('script')).toBeNull();
    expect((window as unknown as { __pwn?: number }).__pwn).toBeUndefined();
    // 原文被转义成文本（不是标签）
    expect(body.textContent).toContain('<script>window.__pwn = 1;</script>');
  });

  it('源码态：原文（frontmatter 可见）、不做 markdown 渲染', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', ROOT);
    renderWorkspace();

    await openReaderFile('/vault/index.md');
    await screen.findByTestId('page-sandbox-detail-obsidian-preview-body');

    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-preview-mode-source'));
    const source = await screen.findByTestId('page-sandbox-detail-obsidian-preview-source');
    expect(source.getAttribute('data-mode')).toBe('source');
    // 源码态同样**填满预览区宽度**（无 620px 上限、无居中）。
    expect(source.className).toContain('w-full');
    expect(source.className).not.toContain('max-w-[620px]');
    expect(source.className).not.toContain('mx-auto');
    expect(source.textContent).toContain('title: 文档');
    expect(source.textContent).toContain('---');
    expect(source.textContent).toContain('# 标题一');
    // 源码态没有渲染产物
    expect(screen.queryByTestId('page-sandbox-detail-obsidian-preview-body')).toBeNull();
    expect(
      screen.getByTestId('page-sandbox-detail-obsidian-preview-mode-source').getAttribute(
        'aria-pressed',
      ),
    ).toBe('true');
    // 切回渲染态
    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-preview-mode-render'));
    expect(await screen.findByTestId('page-sandbox-detail-obsidian-preview-body')).toBeTruthy();
  });

  it('复制：渲染态与源码态都复制 markdown 源文；成功零 toast、图标约 1 秒后复原', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', ROOT);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderWorkspace();
    await openReaderFile('/vault/index.md');
    await screen.findByTestId('page-sandbox-detail-obsidian-preview-body');

    // 换假计时器只为钉「约 1 秒复原」（不用 waitFor，纯推进时间）
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-preview-copy-button'));
      });
      expect(writeText).toHaveBeenCalledTimes(1);
      // 渲染态复制的是 markdown 源文（不是渲染后的纯文本）
      expect(writeText.mock.calls[0][0]).toBe(READER_INDEX);
      expect(
        screen.getByTestId('page-sandbox-detail-obsidian-preview-copy-button').getAttribute(
          'aria-label',
        ),
      ).toBe('已复制');
      expect(toasts()).toHaveLength(0);

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(
        screen.getByTestId('page-sandbox-detail-obsidian-preview-copy-button').getAttribute(
          'aria-label',
        ),
      ).toBe('复制');
    } finally {
      vi.useRealTimers();
    }

    // 源码态复制的也是原文
    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-preview-mode-source'));
    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-preview-copy-button'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText.mock.calls[1][0]).toBe(READER_INDEX);
  });

  it('复制失败：失败才 toast（来源 obsidian）', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', ROOT);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });

    renderWorkspace();
    await openReaderFile('/vault/index.md');
    await screen.findByTestId('page-sandbox-detail-obsidian-preview-body');

    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-preview-copy-button'));
    await waitFor(() =>
      expect(
        toasts().some(
          (node) =>
            node.textContent?.includes('复制到系统剪贴板失败') &&
            node.getAttribute('data-toast-source') === 'obsidian',
        ),
      ).toBe(true),
    );
  });
});

describe('vault 树刷新（左栏 header 刷新按钮，用户浏览器复验修复轮）', () => {
  it('点刷新：失效缓存后按当前展开态重拉目录；选中与阅读位不动（不重读正文）', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', ROOT);
    renderWorkspace();

    // 展开子目录：notes 进入展开态（触发一次列举）
    const dir = await waitFor(() => {
      const found = treeNode('page-sandbox-detail-obsidian-tree-dir', '/vault/notes');
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    fireEvent.click(dir);
    await waitFor(() =>
      expect(mocks.listFiles).toHaveBeenCalledWith('demo', '/vault/notes'),
    );

    // 打开一篇文件：readFile 恰好调用一次
    await openReaderFile('/vault/index.md');
    await screen.findByTestId('page-sandbox-detail-obsidian-preview-body');
    const readCallsBefore = mocks.readFile.mock.calls.length;

    mocks.listFiles.mockClear();
    const button = screen.getByTestId(
      'page-sandbox-detail-obsidian-tree-refresh-button',
    ) as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('刷新');
    fireEvent.click(button);

    // 根 + 当前展开目录各重拉一次（缓存已失效，不是沿用旧 dirs）
    await waitFor(() => expect(mocks.listFiles).toHaveBeenCalledWith('demo', '/vault'));
    await waitFor(() => expect(mocks.listFiles).toHaveBeenCalledWith('demo', '/vault/notes'));

    // **阅读位置保留**：正文一个都没重读，标题不变，选中态还在
    expect(mocks.readFile.mock.calls.length).toBe(readCallsBefore);
    expect(
      (screen.getByTestId('page-sandbox-detail-obsidian-preview-title').textContent
      ),
    ).toBe('index.md');
    const fileNode = treeNode('page-sandbox-detail-obsidian-tree-file', '/vault/index.md');
    expect(fileNode?.getAttribute('data-active')).toBe('true');

    // loading 收口：按钮恢复可用
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it('刷新中按钮瞬时禁用（loading 反馈）', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', ROOT);
    renderWorkspace();

    await waitFor(() => expect(mocks.listFiles).toHaveBeenCalledWith('demo', '/vault'));

    // 让下一轮列举挂起：按钮应立即进入禁用 + aria-busy
    let resolvePending: (value: FileListEntry[]) => void = () => {};
    mocks.listFiles.mockImplementationOnce(
      () =>
        new Promise<FileListEntry[]>((resolve) => {
          resolvePending = resolve;
        }),
    );
    const button = screen.getByTestId(
      'page-sandbox-detail-obsidian-tree-refresh-button',
    ) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');

    resolvePending([]);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(button.getAttribute('aria-busy')).toBe('false');
  });

  it('刷新在途时经「更改」换根：刷新钮立即复位，旧刷新不污染新根的树', async () => {
    mockVault();
    writeStoredVaultRoot('demo', ROOT);
    renderWorkspace();

    await waitFor(() => expect(mocks.listFiles).toHaveBeenCalledWith('demo', '/vault'));

    // 挂住刷新的列举请求（在途）
    let resolveStale: (value: FileListEntry[]) => void = () => {};
    mocks.listFiles.mockImplementationOnce(
      () =>
        new Promise<FileListEntry[]>((resolve) => {
          resolveStale = resolve;
        }),
    );
    const button = screen.getByTestId(
      'page-sandbox-detail-obsidian-tree-refresh-button',
    ) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');

    // 刷新在途时经「更改」换根（树干保持挂载，刷新钮还在）
    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-change-root-button'));
    const input = screen.getByTestId('page-sandbox-detail-obsidian-root-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/vault-two' } });
    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-root-open-button'));

    // 修复点：换根 effect 补 setRefreshingTree(false)——按钮不用等旧刷新回来就复位
    //（修复前旧刷新 finally 的代次比对恒 false，按钮永久禁用 + 旋转）
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(mocks.listFiles).toHaveBeenCalledWith('demo', '/vault-two');

    // 旧根的在途响应回来（带一个只属于旧根的条目）：不污染新根的树
    resolveStale([entry({ name: 'stale.md', size: 3 })]);
    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-detail-obsidian-vault-root').textContent).toBe(
        'vault 根：/vault-two',
      ),
    );
    expect(screen.queryByText('stale.md')).toBeNull();
  });
});

describe('wikilink 渲染、tooltip 与跳转（OBS-08 / OBS-09 / OBS-10）', () => {
  it('样式：强调色 + 虚线下划线；别名当作显示文案', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', ROOT);
    renderWorkspace();

    await openReaderFile('/vault/index.md');

    const plain = await wikilinkOf('target');
    expect(plain.textContent).toBe('target');
    expect(plain.className).toContain('text-primary');
    expect(plain.className).toContain('underline');
    expect(plain.className).toContain('decoration-dashed');

    const aliased = await wikilinkOf('notes/deep');
    expect(aliased.textContent).toBe('别名');

    // `[[#标题]]` 也是个 wikilink 元素
    expect((await wikilinkOf('')).textContent).toBe('#小节');
  });

  it('hover：黑底小 tooltip，内容 = 解析后的目标路径；离开即消失', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', ROOT);
    renderWorkspace();

    await openReaderFile('/vault/index.md');
    const link = await wikilinkOf('target');

    expect(screen.queryByTestId('page-sandbox-detail-obsidian-preview-wikilink-tooltip')).toBeNull();
    fireEvent.mouseOver(link);

    const tooltip = await screen.findByTestId(
      'page-sandbox-detail-obsidian-preview-wikilink-tooltip',
    );
    expect(tooltip.textContent).toBe('/vault/target.md');
    expect(tooltip.getAttribute('role')).toBe('tooltip');
    expect(tooltip.className).toContain('bg-terminal-bg');
    // 定位走 position: fixed（防裁切），且落在视口内
    expect(tooltip.style.position).toBe('fixed');
    expect(Number.parseFloat(tooltip.style.left)).toBeGreaterThanOrEqual(0);
    expect(Number.parseFloat(tooltip.style.top)).toBeGreaterThanOrEqual(0);
    expect(link.getAttribute('data-status')).toBe('found');
    expect(link.getAttribute('data-resolved-path')).toBe('/vault/target.md');

    fireEvent.mouseOut(link);
    await waitFor(() =>
      expect(
        screen.queryByTestId('page-sandbox-detail-obsidian-preview-wikilink-tooltip'),
      ).toBeNull(),
    );
  });

  it('点击存在的目标：沿历史栈推入渲染视图，返回键可退回', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', ROOT);
    renderWorkspace();

    await openReaderFile('/vault/index.md');
    fireEvent.click(await wikilinkOf('target'));

    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-detail-obsidian-preview-title').textContent).toBe(
        'target.md',
      ),
    );
    const preview = screen.getByTestId('page-sandbox-detail-obsidian-preview');
    expect(preview.getAttribute('data-selected-path')).toBe('/vault/target.md');
    expect(
      (await screen.findByTestId('page-sandbox-detail-obsidian-preview-content')).textContent,
    ).toContain('被链接到的目标文件');

    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-preview-back-button'));
    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-detail-obsidian-preview-title').textContent).toBe(
        'index.md',
      ),
    );
    expect(preview.getAttribute('data-selected-path')).toBe('/vault/index.md');
    // 栈底：返回钮消失
    expect(screen.queryByTestId('page-sandbox-detail-obsidian-preview-back-button')).toBeNull();
  });

  it('斜体（em）里的 wikilink 同样可点，点击照常压栈', async () => {
    mockReaderVault();
    // 斜体 / 粗体两种强调包着的同一条 wikilink：都要过 wikilink 渲染。
    setFile('/vault/index.md', '# 强调\n\n这是 *[[target]]* 与 **[[target]]**。\n');
    writeStoredVaultRoot('demo', ROOT);
    renderWorkspace();

    await openReaderFile('/vault/index.md');

    const links = await waitFor(() => {
      const found = screen
        .queryAllByTestId('page-sandbox-detail-obsidian-preview-wikilink')
        .filter((node) => node.getAttribute('data-target') === 'target');
      expect(found).toHaveLength(2);
      return found;
    });
    const italic = links[0];
    expect(italic.closest('em')).not.toBeNull();
    expect(italic.textContent).toBe('target');
    expect(links[1].closest('strong')).not.toBeNull();

    // 斜体里的那条可点：命中后照常压栈。
    fireEvent.click(italic);
    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-detail-obsidian-preview-title').textContent).toBe(
        'target.md',
      ),
    );
    expect(
      screen.getByTestId('page-sandbox-detail-obsidian-preview').getAttribute('data-selected-path'),
    ).toBe('/vault/target.md');
  });

  it('解析还没回来时在树上另点了文件：旧点击作废，不把旧目标压到新栈顶', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', ROOT);
    renderWorkspace();

    await openReaderFile('/vault/index.md');

    // 先把 notes 展开（这步列举走真实 mock，不挂住）。
    const notesDir = await waitFor(() => {
      const node = treeNode('page-sandbox-detail-obsidian-tree-dir', '/vault/notes');
      expect(node).toBeTruthy();
      return node as HTMLElement;
    });
    fireEvent.click(notesDir);
    await waitFor(() =>
      expect(
        treeNode('page-sandbox-detail-obsidian-tree-file', '/vault/notes/deep.md'),
      ).toBeTruthy(),
    );

    // 让 wikilink 的「① 同目录」列举挂住（真实解析最长可能等 5 秒）。
    const realListFiles = mocks.listFiles.getMockImplementation();
    let releaseRoot: ((entries: FileListEntry[]) => void) | undefined;
    mocks.listFiles.mockImplementation((sandbox: string, path: string) => {
      if (path === ROOT) {
        return new Promise<FileListEntry[]>((resolve) => {
          releaseRoot = resolve;
        });
      }
      return realListFiles?.(sandbox, path) ?? Promise.resolve([]);
    });

    fireEvent.click(await wikilinkOf('target'));
    await waitFor(() => expect(typeof releaseRoot).toBe('function'));

    // 解析回来之前，用户在树上点了另一个文件（重置栈）。
    await openReaderFile('/vault/notes/deep.md');
    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-detail-obsidian-preview-title').textContent).toBe(
        'deep.md',
      ),
    );

    // 迟到的解析结果：旧点击的续体必须整段作废（代次变了）。
    await act(async () => {
      releaseRoot?.([
        entry({ name: 'notes', kind: 'dir' }),
        entry({ name: 'index.md', size: READER_INDEX.length }),
        entry({ name: 'target.md', size: 40 }),
      ]);
      await Promise.resolve();
    });

    const preview = screen.getByTestId('page-sandbox-detail-obsidian-preview');
    expect(preview.getAttribute('data-selected-path')).toBe('/vault/notes/deep.md');
    expect(screen.getByTestId('page-sandbox-detail-obsidian-preview-title').textContent).toBe(
      'deep.md',
    );
    // 没有额外的压栈（栈只有重置后的这一层）。
    expect(screen.queryByTestId('page-sandbox-detail-obsidian-preview-back-button')).toBeNull();
    expect(
      screen.queryByTestId('page-sandbox-detail-obsidian-preview-wikilink-error'),
    ).toBeNull();
  });

  it('点树上另一个文件 = 重置历史栈（返回钮随之消失）', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', ROOT);
    renderWorkspace();

    await openReaderFile('/vault/index.md');
    fireEvent.click(await wikilinkOf('target'));
    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-detail-obsidian-preview-back-button')).toBeTruthy(),
    );

    await openReaderFile('/vault/index.md');
    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-detail-obsidian-preview-title').textContent).toBe(
        'index.md',
      ),
    );
    expect(screen.queryByTestId('page-sandbox-detail-obsidian-preview-back-button')).toBeNull();
  });

  it('点击不存在的目标：正文顶部就地浅红错误条，可关闭、不跳转、不弹 toast', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', ROOT);
    renderWorkspace();

    await openReaderFile('/vault/index.md');
    fireEvent.click(await wikilinkOf('missing'));

    const bar = await screen.findByTestId('page-sandbox-detail-obsidian-preview-wikilink-error');
    expect(bar.getAttribute('role')).toBe('alert');
    expect(bar.textContent).toBe('链接目标不存在：missing');
    expect(bar.className).toContain('bg-destructive-soft');
    // 不跳转、不弹 toast
    expect(
      screen.getByTestId('page-sandbox-detail-obsidian-preview').getAttribute('data-selected-path'),
    ).toBe('/vault/index.md');
    expect(toasts()).toHaveLength(0);

    fireEvent.click(
      screen.getByTestId('page-sandbox-detail-obsidian-preview-wikilink-error-close-button'),
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId('page-sandbox-detail-obsidian-preview-wikilink-error'),
      ).toBeNull(),
    );
  });

  it('[[#标题]] 指回当前文件自身：不压栈、不报错', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', ROOT);
    renderWorkspace();

    await openReaderFile('/vault/index.md');
    const selfLink = await wikilinkOf('');
    fireEvent.click(selfLink);

    await waitFor(() => expect(selfLink.getAttribute('data-status')).toBe('found'));
    expect(
      screen.getByTestId('page-sandbox-detail-obsidian-preview').getAttribute('data-selected-path'),
    ).toBe('/vault/index.md');
    expect(screen.queryByTestId('page-sandbox-detail-obsidian-preview-back-button')).toBeNull();
    expect(
      screen.queryByTestId('page-sandbox-detail-obsidian-preview-wikilink-error'),
    ).toBeNull();
  });
});

describe('大文件与读取错误（OBS-11）', () => {
  const BIG = 3 * 1024 * 1024;

  it('>2 MB：复用同一套二次确认 + 进度条；取消不发请求、确认后渲染全文', async () => {
    mockReaderVault({ bigSize: BIG });
    writeStoredVaultRoot('demo', ROOT);
    renderWorkspace();

    await openReaderFile('/vault/big.md');

    const dialog = await screen.findByTestId(
      'page-sandbox-detail-obsidian-preview-confirm-dialog',
    );
    expect(dialog.textContent).toContain('超过 2 MB');
    expect(dialog.textContent).toContain('big.md');
    expect(mocks.readFile).not.toHaveBeenCalled();

    // 取消：一个请求都不发，右栏仍是空态
    fireEvent.click(
      screen.getByTestId('page-sandbox-detail-obsidian-preview-confirm-cancel-button'),
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId('page-sandbox-detail-obsidian-preview-confirm-dialog'),
      ).toBeNull(),
    );
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(screen.getByTestId('page-sandbox-detail-obsidian-preview-empty')).toBeTruthy();

    // 确认：这时才读，且按列表 size 请求全量
    await openReaderFile('/vault/big.md');
    await screen.findByTestId('page-sandbox-detail-obsidian-preview-confirm-dialog');
    let reportProgress: ((loaded: number) => void) | undefined;
    let resolveRead: ((value: ReadFileResult) => void) | undefined;
    mocks.readFile.mockImplementation(
      (_sandbox: string, _path: string, options?: { onProgress?: (loaded: number) => void }) => {
        reportProgress = options?.onProgress;
        return new Promise<ReadFileResult>((resolve) => {
          resolveRead = resolve;
        });
      },
    );
    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-preview-confirm-button'));
    await waitFor(() => expect(mocks.readFile).toHaveBeenCalledTimes(1));
    expect(mocks.readFile.mock.calls[0][1]).toBe('/vault/big.md');
    expect(mocks.readFile.mock.calls[0][2]).toMatchObject({ maxBytes: BIG });

    // 进度条：已接收字节 / size
    expect(
      screen.getByTestId('page-sandbox-detail-obsidian-preview-progress'),
    ).toBeTruthy();
    reportProgress?.(Math.floor(BIG / 2));
    await waitFor(() =>
      expect(
        screen.getByTestId('page-sandbox-detail-obsidian-preview-progress').getAttribute(
          'aria-valuenow',
        ),
      ).toBe('50'),
    );

    resolveRead?.({
      text: '# 大文件正文\n\n全文都渲染。\n',
      binary: false,
      size: BIG,
      bytes: BIG,
      truncated: false,
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('page-sandbox-detail-obsidian-preview-content').textContent,
      ).toContain('全文都渲染'),
    );
    expect(screen.queryByTestId('page-sandbox-detail-obsidian-preview-progress')).toBeNull();
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('文件过大');
    expect(text).not.toContain('仅展示前');
  });

  it('wikilink 命中大文件：同样先二次确认，确认后压栈（返回键可退回）', async () => {
    mockReaderVault({ bigSize: BIG, linkBig: true });
    writeStoredVaultRoot('demo', ROOT);
    renderWorkspace();

    await openReaderFile('/vault/index.md');
    fireEvent.click(await wikilinkOf('big'));

    const dialog = await screen.findByTestId(
      'page-sandbox-detail-obsidian-preview-confirm-dialog',
    );
    expect(dialog.textContent).toContain('big.md');
    expect(mocks.readFile).toHaveBeenCalledTimes(1); // 只有 index.md 那一次
    expect(
      screen.getByTestId('page-sandbox-detail-obsidian-preview').getAttribute('data-selected-path'),
    ).toBe('/vault/index.md');

    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-preview-confirm-button'));
    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-detail-obsidian-preview-title').textContent).toBe(
        'big.md',
      ),
    );
    expect(mocks.readFile.mock.calls[1][1]).toBe('/vault/big.md');
    expect(mocks.readFile.mock.calls[1][2]).toMatchObject({ maxBytes: BIG });
    expect(
      (await screen.findByTestId('page-sandbox-detail-obsidian-preview-content')).textContent,
    ).toContain('大文件正文');

    // 压栈进来的：返回键存在，退回 index.md
    fireEvent.click(screen.getByTestId('page-sandbox-detail-obsidian-preview-back-button'));
    await waitFor(() =>
      expect(screen.getByTestId('page-sandbox-detail-obsidian-preview-title').textContent).toBe(
        'index.md',
      ),
    );
  });

  it('小文件：直接加载，不出现进度条、不弹确认框', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', ROOT);
    mocks.readFile.mockImplementation(() => new Promise<ReadFileResult>(() => {}));
    renderWorkspace();

    await openReaderFile('/vault/index.md');
    await screen.findByTestId('page-sandbox-detail-obsidian-preview-loading');
    expect(mocks.readFile).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('page-sandbox-detail-obsidian-preview-progress')).toBeNull();
    expect(
      screen.queryByTestId('page-sandbox-detail-obsidian-preview-confirm-dialog'),
    ).toBeNull();
  });

  it('非 UTF-8：按「无法展示」的空态处理（与文件窗格预览同款）', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', ROOT);
    mocks.readFile.mockRejectedValue(new TextNotPreviewableError());
    renderWorkspace();

    await openReaderFile('/vault/index.md');
    const unsupported = await screen.findByTestId(
      'page-sandbox-detail-obsidian-preview-unsupported',
    );
    expect(unsupported.textContent).toContain('无法预览');
  });

  it('读取失败：就地错误态（role=alert），不弹 toast', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', ROOT);
    mocks.readFile.mockRejectedValue(new Error('读取中断，文件不完整'));
    renderWorkspace();

    await openReaderFile('/vault/index.md');
    const error = await screen.findByTestId('page-sandbox-detail-obsidian-preview-error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toBe('读取中断，文件不完整');
    expect(toasts()).toHaveLength(0);
  });
});

describe('阅读位持久化（07 可选评估项）', () => {
  it('Obsidian ↔ 终端 tab 往返（组件重挂载）后仍停在原来那一篇', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', ROOT);

    const first = renderWorkspace();
    await openReaderFile('/vault/index.md');
    await screen.findByTestId('page-sandbox-detail-obsidian-preview-content');
    expect(readStoredSelection('demo')).toEqual({
      path: '/vault/index.md',
      name: 'index.md',
      size: READER_INDEX.length,
    });

    // 模拟切到终端 tab：组件卸载（06 的二选一渲染），再切回来重挂载。
    first.unmount();
    renderWorkspace();

    expect(
      (await screen.findByTestId('page-sandbox-detail-obsidian-preview-title')).textContent,
    ).toBe('index.md');
    expect(mocks.readFile).toHaveBeenCalledWith('demo', '/vault/index.md', expect.anything());
  });

  it('大文件不自动恢复阅读位（不绕过「> 2 MB 先二次确认」）', async () => {
    mockReaderVault({ bigSize: 3 * 1024 * 1024 });
    writeStoredVaultRoot('demo', ROOT);
    writeStoredSelection('demo', {
      path: '/vault/big.md',
      name: 'big.md',
      size: 3 * 1024 * 1024,
    });

    renderWorkspace();

    expect(screen.getByTestId('page-sandbox-detail-obsidian-preview-empty')).toBeTruthy();
    expect(
      screen.queryByTestId('page-sandbox-detail-obsidian-preview-confirm-dialog'),
    ).toBeNull();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('根之外的旧阅读位不恢复（换过根就当没记过）', async () => {
    mockReaderVault();
    writeStoredVaultRoot('demo', '/vault/notes');
    writeStoredSelection('demo', { path: '/vault/index.md', name: 'index.md', size: 10 });

    renderWorkspace();

    expect(screen.getByTestId('page-sandbox-detail-obsidian-preview-empty')).toBeTruthy();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });
});
