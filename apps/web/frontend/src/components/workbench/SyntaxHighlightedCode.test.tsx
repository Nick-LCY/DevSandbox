// @vitest-environment jsdom
/**
 * 语法高亮渲染组件：先原文后 token、失败回退、行语义、主题切换。
 *
 * Worker 用替身接真实的 Shiki 实现（`syntax-highlight.test-helpers.ts`）。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installFailingSyntaxWorkerStub,
  installSyntaxWorkerStub,
} from '../../lib/syntax-highlight.test-helpers';
import { applyTheme } from '../../lib/theme';
import {
  SyntaxHighlightedCodeBlock,
  SyntaxHighlightedLines,
} from './SyntaxHighlightedCode';

let uninstall: (() => void) | null = null;

beforeEach(() => {
  uninstall = installSyntaxWorkerStub();
});

afterEach(() => {
  cleanup();
  uninstall?.();
  uninstall = null;
  vi.restoreAllMocks();
});

describe('SyntaxHighlightedLines', () => {
  it('加载中先显示原文，加载完成后出现 token 且文本不变', async () => {
    render(
      <SyntaxHighlightedLines
        lines={['const a = 1;', 'const b = 2;']}
        language="javascript"
        theme="github-light"
        lineTestId="line"
      />,
    );

    // 首帧就是原文（不是空白）。
    expect(screen.getAllByTestId('line').map((node) => node.textContent)).toEqual([
      'const a = 1;',
      'const b = 2;',
    ]);
    expect(document.querySelectorAll('.shiki-token').length).toBe(0);

    await waitFor(() =>
      expect(document.querySelectorAll('.shiki-token').length).toBeGreaterThan(0),
    );

    // token 渲染后文本与原文逐字一致。
    expect(screen.getAllByTestId('line').map((node) => node.textContent)).toEqual([
      'const a = 1;',
      'const b = 2;',
    ]);
  });

  it('空行保留且不插可见字符', async () => {
    render(
      <SyntaxHighlightedLines
        lines={['a', '', 'b']}
        language="javascript"
        theme="github-light"
        lineTestId="line"
      />,
    );

    await waitFor(() =>
      expect(document.querySelectorAll('.shiki-token').length).toBeGreaterThan(0),
    );

    const lines = screen.getAllByTestId('line');
    expect(lines).toHaveLength(3);
    expect(lines[1].textContent).toBe('');
    expect(lines[1].querySelectorAll('.shiki-token').length).toBe(0);
  });

  it('主题切换会重新高亮（token 重新生成）', async () => {
    const view = render(
      <SyntaxHighlightedLines
        lines={['const a = 1;']}
        language="javascript"
        theme="github-light"
        lineTestId="line"
      />,
    );

    await waitFor(() =>
      expect(document.querySelectorAll('.shiki-token').length).toBeGreaterThan(0),
    );

    view.rerender(
      <SyntaxHighlightedLines
        lines={['const a = 1;']}
        language="javascript"
        theme="github-dark"
        lineTestId="line"
      />,
    );

    await waitFor(() =>
      expect(document.querySelectorAll('.shiki-token').length).toBeGreaterThan(0),
    );
    expect(screen.getByTestId('line').textContent).toBe('const a = 1;');
  });

  it('Worker 失败时回退纯文本（正文仍可见）', async () => {
    uninstall?.();
    uninstall = installFailingSyntaxWorkerStub();

    render(
      <SyntaxHighlightedLines
        lines={['const a = 1;']}
        language="javascript"
        theme="github-light"
        lineTestId="line"
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('line').textContent).toBe('const a = 1;'),
    );
    expect(document.querySelectorAll('.shiki-token').length).toBe(0);
  });
});

describe('SyntaxHighlightedCodeBlock', () => {
  it('未知语言保持纯文本，不产生 token', async () => {
    render(<SyntaxHighlightedCodeBlock source="const a = 1;" language={null} />);

    await waitFor(() => expect(document.querySelector('code')?.textContent).toBe('const a = 1;'));
    expect(document.querySelectorAll('.shiki-token').length).toBe(0);
    // `plain` = 没有可识别语言（与「识别了但高亮失败」的 `error` 区分）
    expect(document.querySelector('code')?.getAttribute('data-syntax-state')).toBe('plain');
  });

  it('已识别语言渲染 token，主题固定 github-dark', async () => {
    render(<SyntaxHighlightedCodeBlock source="const a = 1;" language="javascript" />);

    await waitFor(() =>
      expect(document.querySelectorAll('.shiki-token').length).toBeGreaterThan(0),
    );
    expect(document.querySelector('code')?.getAttribute('data-syntax-theme')).toBe('github-dark');
    expect(document.querySelector('code')?.textContent).toBe('const a = 1;');
  });

  it('CRLF 与末尾换行按预览口径处理', async () => {
    render(<SyntaxHighlightedCodeBlock source={'a\r\nb\r\n'} language="javascript" />);

    await waitFor(() =>
      expect(document.querySelectorAll('.shiki-token').length).toBeGreaterThan(0),
    );
    // CR 归一为 LF；末尾换行保留（不额外生成一行）。
    expect(document.querySelector('code')?.textContent).toBe('a\nb\n');
    expect(document.querySelectorAll('[data-syntax-line]').length).toBe(2);
  });
});

describe('主题工具与语法主题的关系', () => {
  it('applyTheme 变更会被应用主题订阅者看到', async () => {
    const { getAppliedTheme } = await import('../../lib/theme');
    applyTheme('dark');
    expect(getAppliedTheme()).toBe('dark');
    applyTheme('light');
    expect(getAppliedTheme()).toBe('light');
  });
});
