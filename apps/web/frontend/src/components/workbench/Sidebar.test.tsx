// @vitest-environment jsdom
/**
 * 左侧边栏：列表项渲染、状态点配色、选中态、主题切换与新建入口。
 *
 * 覆盖五件事：
 * - 列表项渲染沙箱名、状态文案与镜像，状态点按四类状态取不同颜色类；
 * - 选中项只用背景色高亮，**不画左侧竖线**（侧栏是整块深色背景，竖线会刺眼）；
 * - 点列表项回调选中该沙箱；
 * - 主题切换按钮真的把亮 / 暗主题翻过来；
 * - 「新建沙箱」按钮回调打开新建弹窗。
 *
 * 外加折叠能力（侧栏自持状态，不入路由）：
 * - 折叠按钮在底部工具区最末（主题切换按钮之后）；
 * - 折叠后侧栏收窄到 56px、按钮可访问名变「展开侧栏」、状态落盘；
 * - 折叠态只藏样式不卸 DOM：标题 / 列表头文字仍在，新建按钮仍挂载；
 * - 折叠态底部工具区仍带贴底约束类（`mt-auto`）：不依赖列表撑高。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';

import type { SandboxSummary } from '../../api/types';
import { Sidebar } from './Sidebar';

afterEach(cleanup);

beforeEach(() => {
  // 主题存在 localStorage 里：每条用例从干净的亮色主题起步。
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
  delete document.documentElement.dataset.theme;
});

/** 造一个列表项。 */
function makeSummary(overrides: Partial<SandboxSummary> = {}): SandboxSummary {
  return {
    name: 'demo-01',
    state: 'running',
    state_label: '运行中',
    image: 'sandbox-platform/base:0.2.0',
    created_at: '2026-10-30T01:00:00+00:00',
    ...overrides,
  };
}

/** 渲染侧栏，默认给一个运行中的沙箱。 */
function renderSidebar(overrides: Partial<ComponentProps<typeof Sidebar>> = {}) {
  const props: ComponentProps<typeof Sidebar> = {
    sandboxes: [makeSummary()],
    selectedName: null,
    health: { state: 'ok', text: '服务正常（v0.2.0）' },
    onSelectSandbox: vi.fn(),
    onCreateClick: vi.fn(),
    onSettingsClick: vi.fn(),
    loading: false,
    onRefresh: vi.fn(),
    refreshing: false,
    ...overrides,
  };
  const view = render(<Sidebar {...props} />);
  return {
    props,
    ...view,
    /** 按新属性重渲染（属性级的 rerender，不必手写元素）。 */
    rerenderWith: (next: Partial<ComponentProps<typeof Sidebar>>) =>
      view.rerender(<Sidebar {...props} {...next} />),
  };
}

/** 列表项里的状态点（第一个圆点 span）。 */
function stateDotOf(item: HTMLElement): HTMLElement {
  const dot = item.querySelector('span[aria-hidden="true"]');
  if (!(dot instanceof HTMLElement)) {
    throw new Error('列表项里没有状态点');
  }
  return dot;
}

describe('Sidebar', () => {
  it('品牌块渲染 Box 图标（lucide）', () => {
    const { container } = renderSidebar();

    const icon = container.querySelector('svg.lucide-box');
    expect(icon, '品牌块里应当有 lucide Box 图标').not.toBeNull();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('列表项渲染沙箱名、状态文案与镜像', () => {
    renderSidebar({ sandboxes: [makeSummary({ name: 'acc-demo', state_label: '运行中' })] });

    const item = screen.getByTestId('page-sandbox-list-item');
    expect(item.getAttribute('data-sandbox-name')).toBe('acc-demo');
    expect(item.getAttribute('data-sandbox-state')).toBe('running');
    expect(screen.getByTestId('page-sandbox-list-item-name').textContent).toBe('acc-demo');
    expect(screen.getByTestId('page-sandbox-list-item-state').textContent).toBe('运行中');
    expect(screen.getByTestId('page-sandbox-list-item-image').textContent).toBe(
      'sandbox-platform/base:0.2.0',
    );
  });

  it('状态点按四类状态取颜色类（运行 / 忙碌 / 已停止 / 失败）', () => {
    const cases: { state: string; label: string; className: string }[] = [
      { state: 'running', label: '运行中', className: 'text-status-running' },
      { state: 'starting', label: '启动中', className: 'text-status-busy' },
      { state: 'stopping', label: '停止中', className: 'text-status-busy' },
      { state: 'stopped', label: '已停止', className: 'text-status-stopped' },
      { state: 'failed', label: '失败', className: 'text-status-failed' },
    ];

    for (const item of cases) {
      const { unmount } = renderSidebar({
        sandboxes: [makeSummary({ state: item.state, state_label: item.label })],
      });
      const dot = stateDotOf(screen.getByTestId('page-sandbox-list-item'));
      expect(dot.className, `状态 ${item.state} 的状态点配色不对`).toContain(item.className);
      unmount();
    }
  });

  it('选中项有选中背景，且没有左侧竖线样式', () => {
    renderSidebar({ sandboxes: [makeSummary()], selectedName: 'demo-01' });

    const item = screen.getByTestId('page-sandbox-list-item');
    expect(item.className).toContain('bg-sidebar-active');
    // 左侧竖线（border-l-*）与伪元素竖线（before:/after:）都不允许出现。
    // 查整棵列表项子树（含自身）的每一个 class：竖线画在子元素上也算竖线。
    const nodes = [item, ...item.querySelectorAll('*')];
    const classes = nodes.flatMap((node) => Array.from(node.classList));
    const offenders = classes.filter(
      (className) => /^border-l/.test(className) || /^(before|after):/.test(className),
    );
    expect(offenders, '列表项子树里不允许出现左侧竖线类').toEqual([]);
    expect(item.getAttribute('aria-current')).toBe('true');
  });

  it('未选中的列表项没有选中背景', () => {
    renderSidebar({ sandboxes: [makeSummary()], selectedName: null });

    const item = screen.getByTestId('page-sandbox-list-item');
    expect(item.className).not.toContain('bg-sidebar-active');
    expect(item.getAttribute('aria-current')).toBeNull();
  });

  it('点列表项回调选中该沙箱', () => {
    const { props } = renderSidebar({
      sandboxes: [makeSummary({ name: 'acc-pick' })],
    });

    fireEvent.click(screen.getByTestId('page-sandbox-list-item'));

    expect(props.onSelectSandbox).toHaveBeenCalledTimes(1);
    expect(props.onSelectSandbox).toHaveBeenCalledWith('acc-pick');
  });

  it('主题切换按钮把亮色翻成暗色，再翻回来', () => {
    renderSidebar();

    const toggle = screen.getByTestId('page-layout-theme-toggle');
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    fireEvent.click(toggle);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('sandbox-console-theme')).toBe('dark');

    fireEvent.click(toggle);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('「新建沙箱」按钮回调打开新建弹窗', () => {
    const { props } = renderSidebar();

    fireEvent.click(screen.getByTestId('page-sandbox-list-create-button'));

    expect(props.onCreateClick).toHaveBeenCalledTimes(1);
  });

  it('底部工具：设置与刷新各自回调', () => {
    const { props } = renderSidebar();

    fireEvent.click(screen.getByTestId('page-layout-settings-button'));
    fireEvent.click(screen.getByTestId('page-sandbox-list-refresh-button'));

    expect(props.onSettingsClick).toHaveBeenCalledTimes(1);
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('Sidebar 折叠', () => {
  it('没有存过折叠状态时默认展开（264px）', () => {
    renderSidebar();

    const aside = screen.getByTestId('page-layout-sidebar');
    expect(aside.className).toContain('w-[264px]');
    expect(aside.className).not.toContain('w-14');
    expect(aside.getAttribute('data-collapsed')).toBe('false');
    const collapse = screen.getByTestId('page-layout-sidebar-collapse-button');
    expect(collapse.getAttribute('aria-label')).toBe('收起侧栏');
    // 折叠按钮是「动作名随状态变化」的普通按钮：不带 aria-expanded。
    expect(collapse.getAttribute('aria-expanded')).toBeNull();
  });

  it('折叠按钮在底部工具区最末（主题切换按钮之后）', () => {
    renderSidebar();

    const themeToggle = screen.getByTestId('page-layout-theme-toggle');
    const collapse = screen.getByTestId('page-layout-sidebar-collapse-button');

    // 文档顺序上：折叠按钮在主题切换按钮之后。
    expect(
      themeToggle.compareDocumentPosition(collapse) & Node.DOCUMENT_POSITION_FOLLOWING,
      '折叠按钮应当排在主题切换按钮之后',
    ).toBeTruthy();
    // 底部工具区的最后一个子元素就是折叠按钮。
    expect(collapse.parentElement?.lastElementChild).toBe(collapse);
  });

  it('点折叠：侧栏收窄到 56px、可访问名变「展开侧栏」、状态落盘', () => {
    renderSidebar();

    const aside = screen.getByTestId('page-layout-sidebar');
    const collapse = screen.getByTestId('page-layout-sidebar-collapse-button');
    expect(aside.className).toContain('w-[264px]');

    fireEvent.click(collapse);

    expect(aside.className).toContain('w-14');
    expect(aside.className).not.toContain('w-[264px]');
    expect(aside.getAttribute('data-collapsed')).toBe('true');
    expect(collapse.getAttribute('aria-label')).toBe('展开侧栏');
    expect(collapse.getAttribute('title')).toBe('展开侧栏');
    expect(collapse.getAttribute('aria-expanded')).toBeNull();
    expect(window.localStorage.getItem('sandbox-console-sidebar-collapsed')).toBe('1');
  });

  it('再点一次展开回 264px，状态回落 0', () => {
    renderSidebar();

    const aside = screen.getByTestId('page-layout-sidebar');
    const collapse = screen.getByTestId('page-layout-sidebar-collapse-button');

    fireEvent.click(collapse);
    fireEvent.click(collapse);

    expect(aside.className).toContain('w-[264px]');
    expect(aside.className).not.toContain('w-14');
    expect(collapse.getAttribute('aria-label')).toBe('收起侧栏');
    expect(window.localStorage.getItem('sandbox-console-sidebar-collapsed')).toBe('0');
  });

  it('折叠态：标题与列表头文字只是隐藏，DOM 仍在', () => {
    renderSidebar();

    fireEvent.click(screen.getByTestId('page-layout-sidebar-collapse-button'));

    // 隐藏走样式切换，元素不卸载：取得到，且类名里带 hidden。
    const title = screen.getByTestId('page-layout-title');
    expect(title).toBeTruthy();
    expect(title.className).toContain('hidden');

    const listTitle = screen.getByTestId('page-sandbox-list-title');
    expect(listTitle).toBeTruthy();
    expect(listTitle.className).toContain('hidden');

    const refresh = screen.getByTestId('page-sandbox-list-refresh-button');
    expect(refresh).toBeTruthy();
    expect(refresh.className).toContain('hidden');
  });

  it('折叠态：「新建沙箱」按钮仍挂载，标识不变，仍能点', () => {
    const { props } = renderSidebar();

    fireEvent.click(screen.getByTestId('page-layout-sidebar-collapse-button'));

    const create = screen.getByTestId('page-sandbox-list-create-button');
    expect(create).toBeTruthy();
    expect(screen.getAllByTestId('page-sandbox-list-create-button')).toHaveLength(1);

    fireEvent.click(create);
    expect(props.onCreateClick).toHaveBeenCalledTimes(1);
  });

  it('折叠态：健康状态点保留，状态标识不变', () => {
    renderSidebar({ health: { state: 'ok', text: '服务正常' } });

    fireEvent.click(screen.getByTestId('page-layout-sidebar-collapse-button'));

    const health = screen.getByTestId('page-layout-health');
    expect(health.getAttribute('data-health-state')).toBe('ok');
    // 状态点还在（文字收起）。
    expect(health.querySelector('span[aria-hidden="true"]')).not.toBeNull();
    // 文字是视觉隐藏（sr-only），不能从可访问树里消失。
    const text = health.querySelector('span:not([aria-hidden="true"])');
    expect(text?.className).toContain('sr-only');
    expect(text?.textContent).toBe('服务正常');
  });

  it('健康状态对辅助技术可见：aria-label 跟着健康文案走', () => {
    const { rerenderWith } = renderSidebar({ health: { state: 'ok', text: '服务正常' } });

    const health = screen.getByTestId('page-layout-health');
    expect(health.getAttribute('aria-label')).toBe('后端健康：服务正常');

    // 折叠态文字收起来了，可访问名不能跟着丢。
    fireEvent.click(screen.getByTestId('page-layout-sidebar-collapse-button'));
    expect(screen.getByTestId('page-layout-health').getAttribute('aria-label')).toBe(
      '后端健康：服务正常',
    );

    // 健康状态变了，可访问名跟着变。
    rerenderWith({ health: { state: 'ok', text: '服务正常（v0.2.0）' } });
    expect(screen.getByTestId('page-layout-health').getAttribute('aria-label')).toBe(
      '后端健康：服务正常（v0.2.0）',
    );
  });

  it('底部工具区永远贴底：展开与折叠两态都带贴底约束类', () => {
    renderSidebar();

    // 底部工具区是折叠按钮的父容器。
    const tools = screen.getByTestId('page-layout-sidebar-collapse-button').parentElement;
    expect(tools).toBeTruthy();
    // 贴底靠 `mt-auto`（不依赖列表那个弹性元素撑高度）。
    expect(tools?.className).toContain('mt-auto');

    fireEvent.click(screen.getByTestId('page-layout-sidebar-collapse-button'));

    // 折叠态列表整体收起，底部工具区照样贴底。
    const collapsedTools = screen.getByTestId('page-layout-sidebar-collapse-button').parentElement;
    expect(collapsedTools?.className).toContain('mt-auto');
  });
});
