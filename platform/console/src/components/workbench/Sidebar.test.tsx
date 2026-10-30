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
    onProxyClick: vi.fn(),
    error: '',
    loading: false,
    updatedAt: null,
    onRefresh: vi.fn(),
    refreshing: false,
    ...overrides,
  };
  return { props, ...render(<Sidebar {...props} />) };
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
    // 左侧竖线（border-l-*）与伪元素竖线都不允许出现。
    expect(item.className).not.toMatch(/border-l/);
    expect(item.className).not.toMatch(/\b(before|after):/);
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

  it('底部工具：代理设置与刷新各自回调', () => {
    const { props } = renderSidebar();

    fireEvent.click(screen.getByTestId('page-layout-proxy-button'));
    fireEvent.click(screen.getByTestId('page-sandbox-list-refresh-button'));

    expect(props.onProxyClick).toHaveBeenCalledTimes(1);
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
  });
});
