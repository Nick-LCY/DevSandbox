// @vitest-environment jsdom
/**
 * Obsidian 阅读器骨架：vault 根引导态 / 根记忆 / vault 树（过滤 + 懒展开 +
 * 展开态持久）/ 选中态。
 *
 * 口径来源：PRD「方案四 · Obsidian tab」的 OBS-03 / OBS-04 / OBS-05。
 * markdown 渲染与 wikilink 在 07 轮，这里只断言「选中路径先搭好」。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FileListEntry } from '../../api/types';
import {
  readStoredExpandedPaths,
  readStoredVaultRoot,
  vaultExpandedStorageKey,
  vaultRootStorageKey,
  writeStoredExpandedPaths,
  writeStoredVaultRoot,
} from '../../lib/obsidian-vault';
import { ObsidianWorkspace } from './ObsidianWorkspace';

const mocks = vi.hoisted(() => ({
  listFiles: vi.fn(),
}));

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listFiles: mocks.listFiles,
    },
  };
});

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
    <ObsidianWorkspace sandbox={props.sandbox ?? 'demo'} workdir={props.workdir ?? '/work'} />,
  );
}

/** 树里某个路径的节点。 */
function treeNode(testId: string, path: string): HTMLElement | undefined {
  return screen
    .queryAllByTestId(testId)
    .find((node) => node.getAttribute('data-path') === path);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.listFiles.mockReset();
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

    render(<ObsidianWorkspace sandbox="demo-b" workdir="/work" />);

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

  it('右侧预览区先落占位：默认「从左侧选择文件」，点 .md 后带上选中路径', async () => {
    mockVault();
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
    expect(
      screen.getByTestId('page-sandbox-detail-obsidian-preview-placeholder').textContent,
    ).toBe('/vault/index.md');
  });
});

describe('沙箱键一致性', () => {
  it('存储键名与 lib 里的一致（避免两处各写一串）', () => {
    expect(vaultRootStorageKey('demo')).toBe('sandbox-console-obsidian-vault-root:demo');
    expect(vaultExpandedStorageKey('demo')).toBe('sandbox-console-obsidian-expanded:demo');
    expect(window.localStorage.getItem(vaultRootStorageKey('demo'))).toBeNull();
  });
});
