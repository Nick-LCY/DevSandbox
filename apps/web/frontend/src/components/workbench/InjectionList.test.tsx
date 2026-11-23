// @vitest-environment jsdom
/**
 * 详情抽屉里的「注入文件」清单。
 *
 * 覆盖本轮口径：
 * - **渲染**：每条一行（宿主源 → 容器目标 + 种类 + 只读），**不展开目录树、
 *   不展示正文**；
 * - **旧实例 / 空清单**：**不出现刷新入口**（整区不渲染）；
 * - **未运行（`can_refresh=false`）**：按钮禁用（停机沙箱不能刷新）；
 * - **写动作**：只按**条目标识**定位（`api.refreshInjection(沙箱, 条目标识)`），
 *   一个沙箱一次只做一个，**加载态禁重复触发**；
 * - **结果**：成功 / 失败都走右上角 toast（来源 `injection-refresh`），失败
 *   **直出后端 `detail` 原文**（含「可能部分更新」的语义）；
 * - **换沙箱 / 卸载**：在途结果一律丢弃（旧沙箱的反馈不落到新沙箱的界面上）。
 *
 * 「既有『刷新详情』是读操作、不触发刷新副本」那条在 `Workbench.test.tsx` 里
 * 钉（那是工作台头部的按钮，不在本组件里）。
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import type { InjectionInfo, SandboxDetail } from '../../api/types';
import { DEFAULT_BACKEND_BASE_URL, type ConnectionConfig } from '../../lib/connection';
import { ToastProvider } from '../Toast';
import { InjectionList } from './InjectionList';
import { SandboxDetailDialog } from './SandboxDetailDialog';

const mocks = vi.hoisted(() => ({
  refreshInjection: vi.fn(),
}));

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      refreshInjection: mocks.refreshInjection,
    },
  };
});

/** 一条注入声明。 */
function makeInjection(overrides?: Partial<InjectionInfo>): InjectionInfo {
  return {
    entry_id: 'inj-0-0123456789ab',
    source_path: '/home/user/notes.md',
    container_path: '/home/sandbox/notes.md',
    kind: 'file',
    read_only: true,
    can_refresh: true,
    ...overrides,
  };
}

/** 连接配置（详情抽屉的 props 需要它）。 */
const connection: ConnectionConfig = {
  backendBaseUrl: DEFAULT_BACKEND_BASE_URL,
  token: 'sbx_test',
};

/** 渲染带 Provider 的注入清单。 */
function renderList(injections: InjectionInfo[]): void {
  render(
    <ToastProvider>
      <InjectionList sandbox="demo-01" injections={injections} />
    </ToastProvider>,
  );
}

/** 某个条目的那一行。 */
function itemOf(entryId: string): HTMLElement {
  const item = screen
    .queryAllByTestId('page-sandbox-detail-injection-item')
    .find((node) => node.getAttribute('data-entry-id') === entryId);
  if (!item) {
    throw new Error(`找不到条目 ${entryId} 的行`);
  }
  return item;
}

/** 某个条目的「刷新副本」按钮。 */
function refreshButtonOf(entryId: string): HTMLButtonElement {
  return within(itemOf(entryId)).getByTestId(
    'page-sandbox-detail-injection-refresh',
  ) as HTMLButtonElement;
}

/** 一份够用的沙箱详情（字段与后端 `SandboxDetail` 对齐）。 */
function makeDetail(overrides?: Partial<SandboxDetail>): SandboxDetail {
  return {
    name: 'demo-01',
    state: 'running',
    state_label: '运行中',
    image: 'sandbox-platform/base:0.2.0',
    image_source: 'host',
    created_at: '2026-11-23T01:00:00+00:00',
    updated_at: '2026-11-23T01:00:00+00:00',
    system_user: 'demo-01',
    uid: 1000,
    gid: 1000,
    home: '/home/demo-01',
    subid_start: 100000,
    subid_length: 65536,
    socket_path: '/run/demo-01.sock',
    socket_mount_path: '/run/sandbox/demo-01.sock',
    container_name: 'sandbox-demo-01',
    container_id: 'abc',
    network_name: 'demo-01-net',
    network_owned: true,
    unit_path: '/etc/systemd/user/demo-01.service',
    mounts: [],
    dependency_containers: [],
    command: [],
    env: {},
    workdir: '',
    ...overrides,
  };
}

/** 渲染带 Provider 的详情抽屉。 */
function renderDialog(detail: SandboxDetail | null): void {
  render(
    <ToastProvider>
      <SandboxDetailDialog
        open
        onOpenChange={() => {}}
        detail={detail}
        loading={false}
        widthVw={40}
        onWidthChange={() => {}}
        desktop={false}
        connection={connection}
        forwards={[]}
        onForwardsChanged={() => {}}
      />
    </ToastProvider>,
  );
}

beforeEach(() => {
  mocks.refreshInjection.mockReset();
  mocks.refreshInjection.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe('注入文件清单：渲染', () => {
  it('每条一行：宿主源 → 容器目标 + 种类 + 只读（不展开目录树、不展示正文）', () => {
    renderList([
      makeInjection(),
      makeInjection({
        entry_id: 'inj-1-fedcba987654',
        source_path: '/home/user/conf',
        container_path: '/home/sandbox/conf',
        kind: 'directory',
      }),
    ]);

    const items = screen.getAllByTestId('page-sandbox-detail-injection-item');
    expect(items).toHaveLength(2);

    // 文件条目：源 → 目标、种类、只读。
    const file = items[0];
    expect(file.textContent).toContain('/home/user/notes.md');
    expect(file.textContent).toContain('/home/sandbox/notes.md');
    expect(file.textContent).toContain('文件');
    expect(file.textContent).toContain('只读');
    expect(file.getAttribute('data-kind')).toBe('file');

    // 目录条目：种类不同。
    const dir = items[1];
    expect(dir.textContent).toContain('/home/user/conf');
    expect(dir.textContent).toContain('/home/sandbox/conf');
    expect(dir.textContent).toContain('目录');
    expect(dir.getAttribute('data-kind')).toBe('directory');
  });

  it('旧实例（详情里没有 injections 字段）：整区不渲染，不出现刷新入口', () => {
    renderDialog(makeDetail());

    expect(screen.queryByTestId('page-sandbox-detail-injections')).toBeNull();
    expect(screen.queryByTestId('page-sandbox-detail-injection-refresh')).toBeNull();
  });

  it('空清单：整区不渲染，不出现刷新入口', () => {
    renderDialog(makeDetail({ injections: [] }));

    expect(screen.queryByTestId('page-sandbox-detail-injections')).toBeNull();
    expect(screen.queryByTestId('page-sandbox-detail-injection-refresh')).toBeNull();
  });

  it('有条目时：清单区出现在抽屉里（与「挂载」区同级）', async () => {
    renderDialog(makeDetail({ injections: [makeInjection()] }));

    await screen.findByTestId('page-sandbox-detail-injections');
    expect(screen.getAllByTestId('page-sandbox-detail-injection-item')).toHaveLength(1);
  });

  it('未运行（can_refresh=false）：按钮禁用（停机沙箱不能刷新）', () => {
    renderList([makeInjection({ can_refresh: false })]);

    const button = refreshButtonOf('inj-0-0123456789ab');
    expect(button.disabled).toBe(true);
  });
});

describe('注入文件清单：刷新副本', () => {
  it('点「刷新副本」：只按条目标识定位（不传路径）', async () => {
    renderList([makeInjection()]);

    fireEvent.click(refreshButtonOf('inj-0-0123456789ab'));

    await waitFor(() =>
      expect(mocks.refreshInjection).toHaveBeenCalledWith('demo-01', 'inj-0-0123456789ab'),
    );
  });

  it('成功：弹成功 toast（来源 injection-refresh）', async () => {
    renderList([makeInjection()]);

    fireEvent.click(refreshButtonOf('inj-0-0123456789ab'));

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.textContent).toContain('副本已刷新');
    expect(toast.getAttribute('data-toast-kind')).toBe('success');
    expect(toast.getAttribute('data-toast-source')).toBe('injection-refresh');
  });

  it('失败：弹失败 toast，后端 detail 原文（保留「可能部分更新」）', async () => {
    mocks.refreshInjection.mockRejectedValue(
      new ApiError('刷新写入阶段失败，副本可能部分更新，请修正后重试', 500),
    );
    renderList([makeInjection()]);

    fireEvent.click(refreshButtonOf('inj-0-0123456789ab'));

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.textContent).toContain('刷新写入阶段失败，副本可能部分更新，请修正后重试');
    expect(toast.getAttribute('data-toast-kind')).toBe('error');
    expect(toast.getAttribute('data-toast-source')).toBe('injection-refresh');
  });

  it('在途：按钮禁用 + 禁重复触发（连点两次只发一个请求）', async () => {
    // 永不 resolve：请求停在在途状态。
    mocks.refreshInjection.mockReturnValue(new Promise<void>(() => {}));
    renderList([makeInjection(), makeInjection({ entry_id: 'inj-1-fedcba987654' })]);

    const button = refreshButtonOf('inj-0-0123456789ab');
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));

    // 同一行连点：不再发第二个请求。
    fireEvent.click(button);
    // 别的行也点不动（一个沙箱一次只做一个）。
    const other = refreshButtonOf('inj-1-fedcba987654');
    expect(other.disabled).toBe(true);
    fireEvent.click(other);

    expect(mocks.refreshInjection).toHaveBeenCalledTimes(1);
  });

  it('换沙箱（组件卸载）：在途结果丢弃，不弹提示、不回写状态', async () => {
    // 手动兑现的 promise：请求停在在途状态，等我们说结束才结束。
    const deferred: { resolve: () => void } = { resolve: () => {} };
    mocks.refreshInjection.mockReturnValue(
      new Promise<void>((resolve) => {
        deferred.resolve = resolve;
      }),
    );
    const { unmount } = render(
      <ToastProvider>
        <InjectionList sandbox="demo-01" injections={[makeInjection()]} />
      </ToastProvider>,
    );

    fireEvent.click(refreshButtonOf('inj-0-0123456789ab'));
    await waitFor(() => expect(mocks.refreshInjection).toHaveBeenCalledTimes(1));

    // 抽屉关掉 / 换沙箱：组件卸载。
    unmount();
    deferred.resolve();

    await waitFor(() => expect(screen.queryByTestId('page-toast-item')).toBeNull());
  });
});
