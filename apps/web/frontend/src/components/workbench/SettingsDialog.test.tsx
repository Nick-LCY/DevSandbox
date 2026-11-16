// @vitest-environment jsdom
/**
 * 设置抽屉：**代理 / 模板 / 后端配置**三个 tab。
 *
 * 覆盖几件事：
 * - 三个 tab 就位：代理默认激活，切到模板 tab 后 TemplateManager 在场；
 *   三个区（代理设置 / 启动模板 / 连接配置）各自可寻址；
 * - 重启成功：弹成功 toast；
 * - 重启失败：弹失败 toast；随后那次状态刷新也失败时，**不能**再弹一条
 *   「读取代理状态失败」把更具体的「重启代理失败」顶掉；
 * - 缓存镜像清单：表格四列（IMAGE / ID / SIZE / CACHED TIME）、多标签展开
 *   成多行、十进制人读大小、12 位短摘要（title 带完整 digest）、UTC 时间与
 *   生成时间戳渲染；本地搜索过滤（输入 → 行数变化 → 清空 → 恢复）与摘要
 *   命中整组显示；两种空态分开（清单为空 / 搜索无命中）；端点失败弹 toast +
 *   就地说明且抽屉其余区照常渲染（不白屏）；手动刷新触发重取；刷新失败保留
 *   旧清单（不清空、就地 role=status 说明、空态不误显）；零轮询（静态源码
 *   断言 + 行为推进时钟断言，双保险）；清单走 `tags=only` 视图；
 * - 模板列表渲染（名称 + 更新时间）与空态；
 * - 行内重命名：回车提交、Esc 取消、空名禁提交；
 * - 删除走确认弹窗，文案写明只删模板、不影响已创建的沙箱；
 * - 删除结果说「没删掉」时提示「记录已不存在」，不谎报已删除；
 * - 模板管理区不再挂说明段（模板是什么由文档讲，界面不重复）；
 * - 「刷新状态」与「重启代理」两个按钮在代理设置区里（抽屉不再有全局页脚）。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_BACKEND_BASE_URL, type ConnectionConfig } from '../../lib/connection';
import { ToastProvider } from '../Toast';
import { SettingsDialog } from './SettingsDialog';

const mocks = vi.hoisted(() => ({
  proxyStatus: vi.fn(),
  restartProxy: vi.fn(),
  cacheImages: vi.fn(),
  listTemplates: vi.fn(),
  renameTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  health: vi.fn(),
}));

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      proxyStatus: mocks.proxyStatus,
      restartProxy: mocks.restartProxy,
      cacheImages: mocks.cacheImages,
      listTemplates: mocks.listTemplates,
      renameTemplate: mocks.renameTemplate,
      deleteTemplate: mocks.deleteTemplate,
      health: mocks.health,
    },
  };
});

/** 一份够用的代理状态。 */
function makeStatus() {
  return {
    container: { exists: true, running: true },
    healthy: true,
    tcp_ok: true,
    ca_fetchable: true,
    cache_size_bytes: 1024,
    certificate_ready: true,
    proxy_url: 'http://127.0.0.1:3128',
    detail: '正常',
  };
}

/** 一份够用的重启结果。 */
function makeRestartResult() {
  return {
    ...makeStatus(),
    restarted: true,
    ca_changed: false,
    ca_reinstalled: false,
    message: '重启成功，代理已恢复健康',
    reinstalled_users: [],
    failed_users: [],
  };
}

/** 「保存配置」回调的替身。 */
const onConnectionChange = vi.fn();

/**
 * 一份够用的缓存镜像清单载荷（字段与后端 `to_payload()` 逐字段对应）。
 *
 * 缺省两条：一条带两个标签（展开成两行），一条带一个标签。清单走
 * `tags=only` 视图（只展示有标签的镜像），所以载荷里不出现无标签条目。
 */
function makeCachePayload(
  options: { generatedAt?: string; images?: unknown[] } = {},
): unknown {
  return {
    generated_at: options.generatedAt ?? '2026-11-15T06:00:00+00:00',
    images:
      options.images ??
      [
        {
          repo: 'library/nginx',
          tags: ['1.27', 'latest'],
          digest:
            'sha256:aa27bb3390799fefbf6b0ea27ff75b6b44d21beb6f8be93919fedcb0e60b3ea2',
          total_size_bytes: 1610612736,
          cached_at: '2026-11-14T10:30:00+00:00',
        },
        {
          repo: 'quay.io/example/app',
          tags: ['v1'],
          digest:
            'sha256:bbb8f4dcd8b9a1e26ee1e2d1f5c7a03e9d4b1a2c3d4e5f60718293a4b5c6d7e8f',
          total_size_bytes: 2048,
          cached_at: '2026-11-14T11:00:00+00:00',
        },
      ],
    total_files: 140,
    blob_files: 135,
    skipped_files: 5,
  };
}

/** 渲染带 Provider 的设置抽屉。 */
function renderDialog(options?: { connection?: ConnectionConfig }): void {
  render(
    <ToastProvider>
      <SettingsDialog
        open
        onOpenChange={vi.fn()}
        widthVw={40}
        onWidthChange={vi.fn()}
        connection={
          options?.connection ?? { backendBaseUrl: DEFAULT_BACKEND_BASE_URL, token: 'sbx_test' }
        }
        onConnectionChange={onConnectionChange}
      />
    </ToastProvider>,
  );
}

/**
 * 注入桌面壳的 IPC 替身（`isDesktopRuntime()` 靠 `window.__TAURI_INTERNALS__` 探测）。
 *
 * **必须在渲染前注入**：抽屉里的「桌面形态」判定是首渲染时算好的。
 */
function injectDesktopRuntime(): { invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn();
  invoke.mockResolvedValue(undefined);
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: { invoke },
    configurable: true,
    writable: true,
  });
  return { invoke };
}

/** 一条模板记录。 */
function makeTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tpl_0123456789ab',
    name: '开发环境',
    config: { image: 'sandbox-platform/base:0.3.0' },
    created_at: '2026-10-31T01:00:00+00:00',
    updated_at: '2026-10-31T02:00:00+00:00',
    ...overrides,
  };
}

/** 切到某个 tab（点 tab 按钮）。 */
function switchTab(
  tab: 'page-settings-tab-proxy' | 'page-settings-tab-templates' | 'page-settings-tab-backend',
): void {
  fireEvent.click(screen.getByTestId(tab));
}

/**
 * 当前激活的 tab 面板（Base UI 的 tabpanel：未激活的面板挂 `hidden`）。
 *
 * 面板一律 `keepMounted`（隐藏的不卸载），所以「在场」不等于「激活」——
 * 断言可见性要看它是不是当前激活的那个面板。
 */
function activePanel(): HTMLElement | null {
  const panels = Array.from(document.querySelectorAll<HTMLElement>('[role="tabpanel"]'));
  return panels.find((panel) => !panel.hasAttribute('hidden')) ?? null;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.proxyStatus.mockReset();
  mocks.restartProxy.mockReset();
  mocks.cacheImages.mockReset();
  mocks.listTemplates.mockReset();
  mocks.renameTemplate.mockReset();
  mocks.deleteTemplate.mockReset();
  mocks.health.mockReset();
  // 桌面形态的探测标记（模块外注入，测试之间清掉）。
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

// 默认：代理状态读得到、缓存清单为空、模板列表为空（各用例自己覆盖需要的那一项）。
beforeEach(() => {
  mocks.proxyStatus.mockResolvedValue(makeStatus());
  mocks.cacheImages.mockResolvedValue(makeCachePayload({ images: [] }));
  mocks.listTemplates.mockResolvedValue([]);
  mocks.health.mockResolvedValue({ version: '0.2.0' });
});

describe('代理重启反馈', () => {
  it('刷新与重启两个按钮在代理设置区里（抽屉不再有全局页脚）', async () => {
    renderDialog();

    await screen.findByTestId('page-settings-cache-size');
    const section = screen.getByLabelText('代理设置');
    expect(section.contains(screen.getByTestId('page-settings-refresh-button'))).toBe(true);
    expect(section.contains(screen.getByTestId('page-settings-restart-button'))).toBe(true);

    // 抽屉页脚（按钮区）整个没了。
    const drawer = screen.getByTestId('page-settings-dialog');
    const footers = Array.from(drawer.querySelectorAll('div')).filter((element) =>
      (element.getAttribute('class') ?? '').includes('bg-muted/40'),
    );
    expect(footers).toHaveLength(0);
  });

  it('重启成功：弹成功 toast', async () => {
    mocks.proxyStatus.mockResolvedValue(makeStatus());
    mocks.restartProxy.mockResolvedValue(makeRestartResult());

    renderDialog();

    await screen.findByTestId('page-settings-cache-size');
    fireEvent.click(screen.getByTestId('page-settings-restart-button'));

    await waitFor(() => {
      const toast = screen.getByTestId('page-toast-item');
      expect(toast.getAttribute('data-toast-kind')).toBe('success');
    });
  });

  it('重启失败：弹失败 toast，状态刷新也失败时不顶掉它', async () => {
    // 首次读状态成功；重启后的那次状态刷新失败。
    mocks.proxyStatus.mockResolvedValueOnce(makeStatus());
    mocks.proxyStatus.mockRejectedValue(new Error('读取代理状态失败'));
    mocks.restartProxy.mockRejectedValue(new Error('重启代理失败：容器起不来'));

    renderDialog();

    await screen.findByTestId('page-settings-cache-size');
    fireEvent.click(screen.getByTestId('page-settings-restart-button'));

    await waitFor(() => {
      const toast = screen.getByTestId('page-toast-item');
      expect(toast.getAttribute('data-toast-kind')).toBe('error');
      expect(toast.textContent).toContain('重启代理失败：容器起不来');
    });
    // 等重启后的那次状态刷新也跑完：失败提示不能被它顶掉。
    await waitFor(() => expect(mocks.proxyStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('page-toast-item').textContent).toContain('重启代理失败：容器起不来');
    expect(screen.getByTestId('page-toast-item').textContent).not.toContain('读取代理状态失败');
  });
});

describe('设置抽屉的三个 tab', () => {
  it('三个 tab 就位：代理默认激活', async () => {
    renderDialog();

    const tabs = await screen.findByTestId('page-settings-tabs');
    expect(tabs.getAttribute('role')).toBe('tablist');
    expect(screen.getByTestId('page-settings-tab-proxy').textContent).toBe('代理');
    expect(screen.getByTestId('page-settings-tab-templates').textContent).toBe('模板');
    expect(screen.getByTestId('page-settings-tab-backend').textContent).toBe('后端配置');

    // 代理 tab 默认激活（激活态是主色下划线那一条）。
    expect(screen.getByTestId('page-settings-tab-proxy').getAttribute('data-active')).toBe('');
    expect(activePanel()?.contains(screen.getByLabelText('代理设置'))).toBe(true);
  });

  it('切到模板 tab：启动模板管理在场，代理区不在激活面板里', async () => {
    mocks.listTemplates.mockResolvedValue([makeTemplate()]);

    renderDialog();

    await screen.findByTestId('page-settings-tabs');
    switchTab('page-settings-tab-templates');

    const panel = activePanel();
    expect(panel?.contains(screen.getByLabelText('启动模板'))).toBe(true);
    expect(panel?.contains(screen.getByLabelText('代理设置'))).toBe(false);
    // 模板管理区在模板 tab 里可用。
    expect(panel?.contains(screen.getByTestId('page-settings-template-item'))).toBe(true);
  });

  it('切到后端配置 tab：连接配置区在场', async () => {
    renderDialog();

    await screen.findByTestId('page-settings-tabs');
    switchTab('page-settings-tab-backend');

    const panel = activePanel();
    expect(panel?.contains(screen.getByLabelText('连接配置'))).toBe(true);
    expect(
      panel?.contains(screen.getByTestId('page-settings-connection-base-url-input')),
    ).toBe(true);
  });

  it('面板 keepMounted：没激活的 tab 也已挂载（打开抽屉即全量加载）', async () => {
    renderDialog();

    // 模板 tab 没激活，但模板管理区已经挂载并加载过（打开抽屉那一次）。
    await screen.findByTestId('page-settings-template-empty');
    expect(screen.getByTestId('page-settings-tab-templates').getAttribute('data-active')).toBeNull();
    expect(mocks.listTemplates).toHaveBeenCalledTimes(1);
  });
});

describe('设置抽屉的缓存镜像清单区', () => {
  it('表格渲染：IMAGE / ID / SIZE / CACHED TIME，多标签展开成多行', async () => {
    mocks.cacheImages.mockResolvedValue(makeCachePayload());

    renderDialog();

    // 区在代理 tab 里（独立 section，aria-label 可寻址），刷新按钮在内。
    const section = await screen.findByLabelText('缓存镜像清单');
    expect(
      section.contains(screen.getByTestId('page-settings-cache-images-refresh-button')),
    ).toBe(true);

    // 表头四列（与服务端 tags=only 表格同列）。
    const head = screen.getByTestId('page-settings-cache-images-head');
    expect(head.textContent).toContain('IMAGE');
    expect(head.textContent).toContain('ID');
    expect(head.textContent).toContain('SIZE');
    expect(head.textContent).toContain('CACHED TIME');

    // 一个镜像的两个标签展开成两行（ID / 大小 / 时间逐行重复）+ 一条单标签的。
    const rows = await screen.findAllByTestId('page-settings-cache-images-row');
    expect(rows).toHaveLength(3);
    // 行按 (repo, tag) 排序。
    expect(rows[0].getAttribute('data-image-repo')).toBe('library/nginx');
    expect(rows[0].getAttribute('data-image-tag')).toBe('1.27');
    expect(rows[1].getAttribute('data-image-tag')).toBe('latest');
    expect(rows[2].getAttribute('data-image-repo')).toBe('quay.io/example/app');

    // IMAGE 列 = repo:tag。
    expect(screen.getAllByTestId('page-settings-cache-images-image')[0].textContent).toBe(
      'library/nginx:1.27',
    );

    // ID 列 = 去 sha256: 前缀后的前 12 位十六进制；完整 digest 挂 title。
    const id = screen.getAllByTestId('page-settings-cache-images-id')[0];
    expect(id.textContent).toBe('aa27bb339079');
    expect(id.getAttribute('title')).toBe(
      'sha256:aa27bb3390799fefbf6b0ea27ff75b6b44d21beb6f8be93919fedcb0e60b3ea2',
    );

    // SIZE 列 = 十进制人读大小（1000 进制，不是二进制 KiB/MiB）。
    expect(screen.getAllByTestId('page-settings-cache-images-size')[0].textContent).toBe('1.6GB');
    expect(screen.getAllByTestId('page-settings-cache-images-size')[2].textContent).toBe('2kB');

    // CACHED TIME 列 = UTC 口径（不是本地时区）。
    expect(screen.getAllByTestId('page-settings-cache-images-time')[0].textContent).toBe(
      '2026-11-14 10:30:00',
    );
    expect(screen.getAllByTestId('page-settings-cache-images-time')[2].textContent).toBe(
      '2026-11-14 11:00:00',
    );

    // 清单生成时间戳随数据一起展示（手动刷新后能看到新鲜度）。
    expect(screen.getByTestId('page-settings-cache-images-generated-at').textContent).toContain(
      '清单生成时间：2026-11-15 06:00:00',
    );
  });

  it('清单走 tags=only 视图（只展示有标签的镜像）', async () => {
    mocks.cacheImages.mockResolvedValue(makeCachePayload());

    renderDialog();

    await screen.findAllByTestId('page-settings-cache-images-row');
    expect(mocks.cacheImages).toHaveBeenCalledWith({ tagsOnly: true });
  });

  it('代理 tab 顶部区自己有界滚动（矮视口下重启结果够得着，不被裁掉）', async () => {
    renderDialog();

    const section = await screen.findByTestId('page-settings-proxy-section');
    // 自己滚（overflow-y-auto）+ 允许收缩（min-h-0）+ 有界（max-h）：
    // 重启结果把顶部区撑高时，滚这一块而不是把底部裁掉。
    expect(section.getAttribute('aria-label')).toBe('代理设置');
    expect(section.className).toContain('overflow-y-auto');
    expect(section.className).toContain('min-h-0');
    expect(section.className).toContain('max-h-');
  });

  it('清单表格有独立的滚动容器（表头吸顶靠它）', async () => {
    mocks.cacheImages.mockResolvedValue(makeCachePayload());

    renderDialog();

    const scroller = await screen.findByTestId('page-settings-cache-images-scroll');
    const table = screen.getByTestId('page-settings-cache-images-table');
    // 表格在滚动容器里（容器自己滚，表头吸顶）。
    expect(scroller.contains(table)).toBe(true);
    expect(scroller.className).toContain('overflow-auto');
    // 分离边框模式（collapse 模式下 Chromium 的 sticky 表头底边会随内容滚走）。
    expect(table.className).toContain('border-separate');
    expect(table.className).not.toContain('border-collapse');
  });

  it('空清单：给空态文案，不误报错误', async () => {
    renderDialog();

    const empty = await screen.findByTestId('page-settings-cache-images-empty');
    // 文案口径：数据源已是 tags=only（空表 = 没有**带标签**的镜像），
    // 不是「没有拉取过的镜像」（digest 直拉条目可能仍在缓存里）。
    expect(empty.textContent).toContain('还没有带标签的镜像');
    expect(empty.textContent).not.toContain('还没有拉取过的镜像');
    expect(screen.queryByTestId('page-settings-cache-images-status')).toBeNull();
    expect(screen.queryByTestId('page-settings-cache-images-table')).toBeNull();
    // 清单本身为空时，搜索无命中那种空态不出现（两种空态分开）。
    expect(screen.queryByTestId('page-settings-cache-images-search-empty')).toBeNull();
  });

  it('本地搜索过滤：输入 → 行数变化 → 清空 → 恢复（不发请求）', async () => {
    mocks.cacheImages.mockResolvedValue(makeCachePayload());

    renderDialog();

    await screen.findAllByTestId('page-settings-cache-images-row');
    expect(mocks.cacheImages).toHaveBeenCalledTimes(1);

    const search = screen.getByTestId(
      'page-settings-cache-images-search-input',
    ) as HTMLInputElement;
    expect(search.getAttribute('placeholder')).toBe('搜索镜像');
    expect(search.getAttribute('aria-label')).toBe('搜索镜像');

    // 子串匹配 repo:tag（大小写不敏感）。
    fireEvent.change(search, { target: { value: 'NGINX' } });
    expect(screen.getAllByTestId('page-settings-cache-images-row')).toHaveLength(2);

    // 命不中：另一种空态（与「清单本身为空」分开）。
    fireEvent.change(search, { target: { value: '不存在的镜像' } });
    expect(screen.queryAllByTestId('page-settings-cache-images-row')).toHaveLength(0);
    expect(screen.getByTestId('page-settings-cache-images-search-empty')).toBeTruthy();
    // 清单本身非空，空态文案不误显。
    expect(screen.queryByTestId('page-settings-cache-images-empty')).toBeNull();

    // 清空 → 全部回来。
    fireEvent.change(search, { target: { value: '' } });
    expect(screen.getAllByTestId('page-settings-cache-images-row')).toHaveLength(3);

    // 纯本地过滤：一个请求都不多发。
    expect(mocks.cacheImages).toHaveBeenCalledTimes(1);
  });

  it('搜索命中摘要：该镜像整组行都显示（带不带 sha256: 前缀都认）', async () => {
    mocks.cacheImages.mockResolvedValue(makeCachePayload());

    renderDialog();

    await screen.findAllByTestId('page-settings-cache-images-row');

    const search = screen.getByTestId('page-settings-cache-images-search-input');

    // 不带前缀：命中多标签镜像时整组两行都显示。
    fireEvent.change(search, { target: { value: 'aa27bb339079' } });
    expect(screen.getAllByTestId('page-settings-cache-images-row')).toHaveLength(2);

    // 带前缀：同样命中。
    fireEvent.change(search, { target: { value: 'sha256:bbb8f4dcd8b9' } });
    expect(screen.getAllByTestId('page-settings-cache-images-row')).toHaveLength(1);
  });

  it('端点失败：弹失败 toast + 就地说明，抽屉其余区照常渲染（不白屏）', async () => {
    mocks.cacheImages.mockRejectedValue(
      new Error('镜像缓存清单不可用（缓存扫描失败或超时），请稍后重试'),
    );

    renderDialog();

    const status = await screen.findByTestId('page-settings-cache-images-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toContain('缓存镜像清单读取失败');
    expect(status.textContent).toContain('镜像缓存清单不可用（缓存扫描失败或超时），请稍后重试');

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('error');
    expect(toast.getAttribute('data-toast-source')).toBe('settings-cache-images');

    // 不白屏：三个区都还在（切 tab 后各自可寻址）。
    expect(screen.getByLabelText('代理设置')).toBeTruthy();
    switchTab('page-settings-tab-templates');
    expect(activePanel()?.contains(screen.getByLabelText('启动模板'))).toBe(true);
    switchTab('page-settings-tab-backend');
    expect(activePanel()?.contains(screen.getByLabelText('连接配置'))).toBe(true);
  });

  it('手动刷新触发重取：清单与生成时间戳都换成新数据', async () => {
    mocks.cacheImages.mockResolvedValueOnce(makeCachePayload());
    mocks.cacheImages.mockResolvedValueOnce(
      makeCachePayload({
        generatedAt: '2026-11-15T06:30:00+00:00',
        images: [
          {
            repo: 'docker.io/library/postgres',
            tags: ['16'],
            digest:
              'sha256:ccc5d1a3b8e1f8f5a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef90',
            total_size_bytes: 3221225472,
            cached_at: '2026-11-15T06:20:00+00:00',
          },
        ],
      }),
    );

    renderDialog();

    await screen.findAllByTestId('page-settings-cache-images-row');
    expect(mocks.cacheImages).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('page-settings-cache-images-refresh-button'));

    await waitFor(() => expect(mocks.cacheImages).toHaveBeenCalledTimes(2));
    // 刷新后清单被替换成新数据（不是追加）。
    const image = await screen.findByTestId('page-settings-cache-images-image');
    expect(image.textContent).toBe('docker.io/library/postgres:16');
    expect(screen.getAllByTestId('page-settings-cache-images-row')).toHaveLength(1);
    expect(screen.getAllByTestId('page-settings-cache-images-size')[0].textContent).toBe('3.2GB');
    expect(screen.getByTestId('page-settings-cache-images-generated-at').textContent).toContain(
      '清单生成时间：2026-11-15 06:30:00',
    );
  });

  it('刷新失败保留旧清单：条目不清空 + 就地说明（role=status）+ 空态不误显', async () => {
    // 首次加载成功（默认载荷两条镜像）；随后手动刷新失败。
    mocks.cacheImages.mockResolvedValueOnce(makeCachePayload());
    mocks.cacheImages.mockRejectedValue(
      new Error('镜像缓存清单不可用（缓存扫描失败或超时），请稍后重试'),
    );

    renderDialog();

    const rows = await screen.findAllByTestId('page-settings-cache-images-row');
    expect(rows).toHaveLength(3);
    expect(rows[0].getAttribute('data-image-repo')).toBe('library/nginx');

    fireEvent.click(screen.getByTestId('page-settings-cache-images-refresh-button'));

    await waitFor(() => expect(mocks.cacheImages).toHaveBeenCalledTimes(2));
    // 旧清单原样保留：还是那三行，没有被清空或替换。
    expect(screen.getAllByTestId('page-settings-cache-images-row')).toHaveLength(3);
    expect(screen.getAllByTestId('page-settings-cache-images-image')[0].textContent).toBe(
      'library/nginx:1.27',
    );
    expect(screen.getByTestId('page-settings-cache-images-table')).toBeTruthy();

    // 就地失败说明走环境状态口径（role=status），写明原因见右上角提示。
    const status = screen.getByTestId('page-settings-cache-images-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toContain('缓存镜像清单读取失败');
    expect(status.textContent).toContain('镜像缓存清单不可用（缓存扫描失败或超时），请稍后重试');

    // 失败 toast 照常弹（来源 settings-cache-images）。
    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('error');
    expect(toast.getAttribute('data-toast-source')).toBe('settings-cache-images');

    // 有旧数据在场，空态文案不能误显。
    expect(screen.queryByTestId('page-settings-cache-images-empty')).toBeNull();
  });

  it('零轮询（静态）：组件源码零 setInterval、零 setTimeout', () => {
    // vitest 恒从包根跑（vitest.config.ts 所在目录），直接从 cwd 解析源码路径。
    // 清单组件已抽到独立文件，两处都要覆盖。
    for (const relative of [
      'src/components/workbench/SettingsDialog.tsx',
      'src/components/workbench/CacheImagesTable.tsx',
    ]) {
      const source = readFileSync(resolve(process.cwd(), relative), 'utf8');
      expect(source, relative).not.toContain('setInterval');
      expect(source, relative).not.toContain('setTimeout');
    }
  });

  it('零轮询（行为）：推进 10 分钟不会自动重取，只有打开抽屉那一次', async () => {
    vi.useFakeTimers();
    try {
      renderDialog();
      // 打开抽屉那一次加载：flush 掉 effect 与已 resolve 的 promise。
      await act(async () => {});
      expect(mocks.cacheImages).toHaveBeenCalledTimes(1);

      // 推进 10 分钟：不出现任何自动重取（清单新鲜度只由手动刷新表达）。
      await act(async () => {
        vi.advanceTimersByTime(10 * 60 * 1000);
      });
      await act(async () => {});
      expect(mocks.cacheImages).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('设置抽屉的模板管理区', () => {
  it('模板列表渲染：名称与最近更新时间', async () => {
    mocks.listTemplates.mockResolvedValue([makeTemplate()]);

    renderDialog();

    const item = await screen.findByTestId('page-settings-template-item');
    expect(item.getAttribute('data-template-name')).toBe('开发环境');
    expect(screen.getByTestId('page-settings-template-name').textContent).toBe('开发环境');
    expect(screen.getByTestId('page-settings-template-updated-at').textContent).toContain('更新于');
  });

  it('一个模板都没有：给空态说明', async () => {
    renderDialog();

    const empty = await screen.findByTestId('page-settings-template-empty');
    expect(empty.textContent).toContain('还没有模板');
  });

  it('模板管理区不再挂说明段', async () => {
    renderDialog();

    await screen.findByTestId('page-settings-template-empty');
    expect(document.body.textContent).not.toContain('模板是一份沙箱启动配置');
  });

  it('读不到模板列表：弹失败 toast（来源 settings-template）', async () => {
    mocks.listTemplates.mockRejectedValue(new Error('读取模板列表失败'));

    renderDialog();

    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('error');
    expect(toast.getAttribute('data-toast-source')).toBe('settings-template');
    expect(toast.textContent).toContain('读取模板列表失败');
  });

  it('行内重命名：回车提交，成功弹 toast', async () => {
    mocks.listTemplates.mockResolvedValue([makeTemplate()]);
    mocks.renameTemplate.mockResolvedValue(makeTemplate({ name: '开发环境 A' }));

    renderDialog();

    await screen.findByTestId('page-settings-template-item');
    fireEvent.click(screen.getByTestId('page-settings-template-rename-button'));

    const input = screen.getByTestId('page-settings-template-rename-input') as HTMLInputElement;
    expect(input.value).toBe('开发环境');
    fireEvent.change(input, { target: { value: '开发环境 A' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mocks.renameTemplate).toHaveBeenCalledTimes(1));
    expect(mocks.renameTemplate.mock.calls[0][0]).toBe('tpl_0123456789ab');
    expect(mocks.renameTemplate.mock.calls[0][1]).toBe('开发环境 A');
    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('success');
    expect(toast.getAttribute('data-toast-source')).toBe('settings-template');
  });

  it('行内重命名：Esc 取消，不发请求', async () => {
    mocks.listTemplates.mockResolvedValue([makeTemplate()]);

    renderDialog();

    await screen.findByTestId('page-settings-template-item');
    fireEvent.click(screen.getByTestId('page-settings-template-rename-button'));

    const input = screen.getByTestId('page-settings-template-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '改了一半' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(mocks.renameTemplate).not.toHaveBeenCalled();
    // 回到只读的一行：输入框没了。
    expect(screen.queryByTestId('page-settings-template-rename-input')).toBeNull();
    expect(screen.getByTestId('page-settings-template-name').textContent).toBe('开发环境');
  });

  it('行内重命名：空名禁提交（按钮禁用）', async () => {
    mocks.listTemplates.mockResolvedValue([makeTemplate()]);

    renderDialog();

    await screen.findByTestId('page-settings-template-item');
    fireEvent.click(screen.getByTestId('page-settings-template-rename-button'));

    const input = screen.getByTestId('page-settings-template-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });

    const save = screen.getByTestId('page-settings-template-rename-save-button') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(mocks.renameTemplate).not.toHaveBeenCalled();
  });

  it('删除走确认弹窗：文案写明只删模板、不影响已建沙箱', async () => {
    mocks.listTemplates.mockResolvedValue([makeTemplate()]);
    mocks.deleteTemplate.mockResolvedValue({ id: 'tpl_0123456789ab', deleted: true });

    renderDialog();

    await screen.findByTestId('page-settings-template-item');
    fireEvent.click(screen.getByTestId('page-settings-template-delete-button'));

    const dialog = await screen.findByTestId('page-settings-template-delete-dialog');
    expect(dialog.textContent).toContain('删除模板 开发环境');
    expect(screen.getByTestId('page-settings-template-delete-untouched-note').textContent).toBe(
      '只删模板，不影响已创建的沙箱',
    );
    // 确认前一个删除请求都不发。
    expect(mocks.deleteTemplate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('page-settings-template-delete-confirm-button'));
    await waitFor(() => expect(mocks.deleteTemplate).toHaveBeenCalledWith('tpl_0123456789ab'));
    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('success');
    expect(toast.getAttribute('data-toast-source')).toBe('settings-template');
  });

  it('删除结果说没删掉：提示「记录已不存在」，不谎报已删除', async () => {
    mocks.listTemplates.mockResolvedValue([makeTemplate()]);
    mocks.deleteTemplate.mockResolvedValue({ id: 'tpl_0123456789ab', deleted: false });

    renderDialog();

    await screen.findByTestId('page-settings-template-item');
    fireEvent.click(screen.getByTestId('page-settings-template-delete-button'));
    fireEvent.click(
      await screen.findByTestId('page-settings-template-delete-confirm-button'),
    );

    await waitFor(() => expect(mocks.deleteTemplate).toHaveBeenCalledTimes(1));
    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('info');
    expect(toast.getAttribute('data-toast-source')).toBe('settings-template');
    expect(toast.textContent).toContain('记录已不存在（可能已被删除）');
    expect(toast.textContent).not.toContain('已删除');
  });
});

describe('设置抽屉的连接配置区', () => {
  it('「连接配置」区在抽屉里，网页形态下后端地址也能填', async () => {
    renderDialog();

    const section = await screen.findByLabelText('连接配置');
    expect(section.contains(screen.getByTestId('page-settings-connection-base-url-input'))).toBe(
      true,
    );
    expect(section.contains(screen.getByTestId('page-settings-connection-token-input'))).toBe(true);
    expect(section.contains(screen.getByTestId('page-settings-connection-test-button'))).toBe(true);
    expect(section.contains(screen.getByTestId('page-settings-connection-save-button'))).toBe(true);

    // 网页形态：后端地址不再是只读（与桌面形态一个口径）。
    const baseUrl = screen.getByTestId(
      'page-settings-connection-base-url-input',
    ) as HTMLInputElement;
    expect(baseUrl.readOnly).toBe(false);
  });

  it('地址框预填默认地址（基址恒非空）', async () => {
    renderDialog();

    const baseUrl = await screen.findByTestId(
      'page-settings-connection-base-url-input',
    ) as HTMLInputElement;
    expect(baseUrl.value).toBe(DEFAULT_BACKEND_BASE_URL);
  });

  it('「测试连接」成功：弹成功 toast（来源 connection）', async () => {
    renderDialog();

    await screen.findByTestId('page-settings-connection-test-button');
    fireEvent.click(screen.getByTestId('page-settings-connection-test-button'));

    await waitFor(() => expect(mocks.health).toHaveBeenCalledTimes(1));
    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('success');
    expect(toast.getAttribute('data-toast-source')).toBe('connection');
  });

  it('「测试连接」失败：弹失败 toast（来源 connection），文案带原因', async () => {
    mocks.health.mockRejectedValue(new Error('访问令牌无效或缺失'));

    renderDialog();

    await screen.findByTestId('page-settings-connection-test-button');
    fireEvent.click(screen.getByTestId('page-settings-connection-test-button'));

    await waitFor(() => expect(mocks.health).toHaveBeenCalledTimes(1));
    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('error');
    expect(toast.getAttribute('data-toast-source')).toBe('connection');
    expect(toast.textContent).toContain('访问令牌无效或缺失');
  });

  it('「保存配置」：把草稿交出去并弹成功 toast', async () => {
    renderDialog();

    const token = await screen.findByTestId('page-settings-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_new' } });
    fireEvent.click(screen.getByTestId('page-settings-connection-save-button'));

    await waitFor(() => expect(onConnectionChange).toHaveBeenCalledTimes(1));
    expect(onConnectionChange.mock.calls[0][0]).toEqual({
      backendBaseUrl: DEFAULT_BACKEND_BASE_URL,
      token: 'sbx_new',
    });
    const toast = await screen.findByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('success');
    expect(toast.getAttribute('data-toast-source')).toBe('connection');
  });

  it('「保存配置」：填了后端地址就带上（网页形态也能连远端后端）', async () => {
    renderDialog();

    const base = await screen.findByTestId('page-settings-connection-base-url-input');
    fireEvent.change(base, { target: { value: 'http://10.0.0.5:8000' } });
    fireEvent.click(screen.getByTestId('page-settings-connection-save-button'));

    await waitFor(() => expect(onConnectionChange).toHaveBeenCalledTimes(1));
    expect(onConnectionChange.mock.calls[0][0]).toEqual({
      backendBaseUrl: 'http://10.0.0.5:8000',
      token: 'sbx_test',
    });
  });

  it('后端地址非法：就地红字，不发请求也不保存', async () => {
    renderDialog();

    const base = await screen.findByTestId('page-settings-connection-base-url-input');
    fireEvent.change(base, { target: { value: 'ftp://host' } });
    fireEvent.click(screen.getByTestId('page-settings-connection-test-button'));

    const error = await screen.findByTestId('page-settings-connection-error');
    expect(error.textContent).toContain('只支持 http 与 https');
    expect(mocks.health).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('page-settings-connection-save-button'));
    expect(onConnectionChange).not.toHaveBeenCalled();
  });

  it('令牌为空：就地红字，不发请求也不保存', async () => {
    renderDialog();

    const token = await screen.findByTestId('page-settings-connection-token-input');
    fireEvent.change(token, { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('page-settings-connection-test-button'));

    const error = await screen.findByTestId('page-settings-connection-error');
    expect(error.textContent).toContain('请填写访问令牌');
    expect(mocks.health).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('page-settings-connection-save-button'));
    expect(onConnectionChange).not.toHaveBeenCalled();
  });

  it('校验红字带 role="alert"（读屏能播报）', async () => {
    renderDialog();

    const token = await screen.findByTestId('page-settings-connection-token-input');
    fireEvent.change(token, { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('page-settings-connection-test-button'));

    const error = await screen.findByTestId('page-settings-connection-error');
    expect(error.getAttribute('role')).toBe('alert');
  });

  it('桌面形态：后端地址留空 → 同样就地红字（通用必填校验，桌面网页一个口径）', async () => {
    // 基址恒非空：留空由通用必填校验拦下，不再有桌面特判的专属文案。
    const { invoke } = injectDesktopRuntime();

    renderDialog();

    const base = await screen.findByTestId('page-settings-connection-base-url-input');
    fireEvent.change(base, { target: { value: '' } });
    await screen.findByTestId('page-settings-connection-save-button');
    fireEvent.click(screen.getByTestId('page-settings-connection-save-button'));

    const error = await screen.findByTestId('page-settings-connection-error');
    expect(error.textContent).toContain('请填写后端地址');
    expect(error.getAttribute('role')).toBe('alert');
    // 不落盘、不弹成功 toast、不同步 CSP（那一步会重载主文档）。
    expect(onConnectionChange).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.queryByTestId('page-toast-item')).toBeNull();
  });

  it('网页形态：后端地址留空 → 同样就地红字，不保存（基址必填）', async () => {
    renderDialog();

    const base = await screen.findByTestId('page-settings-connection-base-url-input');
    fireEvent.change(base, { target: { value: '   ' } });
    await screen.findByTestId('page-settings-connection-save-button');
    fireEvent.click(screen.getByTestId('page-settings-connection-save-button'));

    const error = await screen.findByTestId('page-settings-connection-error');
    expect(error.textContent).toContain('请填写后端地址');
    expect(onConnectionChange).not.toHaveBeenCalled();
  });

  it('桌面形态：填了漏 scheme 的地址 → 同步给桌面壳的是补好 scheme 的地址', async () => {
    // 用户填 `10.0.0.5:8000`：原串送进 Rust 侧的 `Url::parse` 会解析失败 →
    // `connect-src` 少掉那台主机 → 跨主机请求全被 CSP 拦死（界面上看不出原因）。
    const { invoke } = injectDesktopRuntime();
    // `csp_needs_reload` 返回 false（不用重载主文档）；其余命令返回 undefined。
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'csp_needs_reload' ? false : undefined),
    );

    renderDialog();

    const base = await screen.findByTestId('page-settings-connection-base-url-input');
    fireEvent.change(base, { target: { value: '10.0.0.5:8000' } });
    fireEvent.click(screen.getByTestId('page-settings-connection-save-button'));

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    // 保存配置时**先重启已开启的本机监听**（forward_listeners），再同步 CSP，
    // 所以不能假设第一条 invoke 就是同步命令。
    const syncCall = invoke.mock.calls.find((call) => call[0] === 'set_backend_base_url');
    expect(syncCall).toBeTruthy();
    expect(syncCall?.[1]).toEqual({ backendBaseUrl: 'http://10.0.0.5:8000' });
  });

  it('桌面形态：存量空基址 → 表单回填与同步都是归一后的默认地址', async () => {
    // 决策 D 之前允许基址为空（同源）：那些存量数据归一为默认地址再送出去。
    const { invoke } = injectDesktopRuntime();
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'csp_needs_reload' ? false : undefined),
    );

    renderDialog({ connection: { backendBaseUrl: '', token: 'sbx_test' } });

    const base = await screen.findByTestId('page-settings-connection-base-url-input');
    expect((base as HTMLInputElement).value).toBe('http://127.0.0.1:8000');
    fireEvent.click(screen.getByTestId('page-settings-connection-save-button'));

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    const syncCall = invoke.mock.calls.find((call) => call[0] === 'set_backend_base_url');
    expect(syncCall).toBeTruthy();
    expect(syncCall?.[1]).toEqual({ backendBaseUrl: 'http://127.0.0.1:8000' });
  });

  it('桌面形态：保存连接配置 → 已开启的本机监听用新凭据重启（同端口）', async () => {
    // 令牌与基址是**开启监听那一刻的快照**：改了配置不重启，旧监听仍拿着
    // 旧凭据，隧道会以 1008（策略违规）收场。
    const { invoke } = injectDesktopRuntime();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'forward_listeners') {
        return Promise.resolve([
          {
            forward_id: 'abc123def456',
            container_port: 8080,
            local_port: 18000,
            state: 'listening',
          },
        ]);
      }
      if (cmd === 'csp_needs_reload') {
        return Promise.resolve(false);
      }
      return Promise.resolve(undefined);
    });

    renderDialog();

    const token = await screen.findByTestId('page-settings-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_new' } });
    fireEvent.click(screen.getByTestId('page-settings-connection-save-button'));

    // 先停后开，且用**新令牌 + 同一个本机端口**重开。
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('stop_forward', { forwardId: 'abc123def456' }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('start_forward', {
        forwardId: 'abc123def456',
        backendBaseUrl: 'http://127.0.0.1:8000',
        token: 'sbx_new',
        containerPort: 8080,
        localPort: 18000,
      }),
    );
    // 顺序：stop 在 start 之前。
    const stopIndex = invoke.mock.calls.findIndex((call) => call[0] === 'stop_forward');
    const startIndex = invoke.mock.calls.findIndex((call) => call[0] === 'start_forward');
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThan(stopIndex);
  });

  it('桌面形态：某条监听重启失败 → 弹失败提示，其余流程不中断', async () => {
    const { invoke } = injectDesktopRuntime();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'forward_listeners') {
        return Promise.resolve([
          {
            forward_id: 'abc123def456',
            container_port: 8080,
            local_port: 18000,
            state: 'listening',
          },
        ]);
      }
      if (cmd === 'stop_forward') {
        return Promise.reject('本机监听停止失败');
      }
      if (cmd === 'csp_needs_reload') {
        return Promise.resolve(false);
      }
      return Promise.resolve(undefined);
    });

    renderDialog();

    const token = await screen.findByTestId('page-settings-connection-token-input');
    fireEvent.change(token, { target: { value: 'sbx_new' } });
    fireEvent.click(screen.getByTestId('page-settings-connection-save-button'));

    const toast = await screen.findByTestId('page-toast-item');
    // toast 同时只留最新一条：失败提示弹在成功提示之后，最终看到的是它。
    await waitFor(() => expect(toast.textContent).toContain('本机监听重启失败'));
    // 失败不中断：配置照样保存成功。
    await waitFor(() => expect(onConnectionChange).toHaveBeenCalled());
  });
});
