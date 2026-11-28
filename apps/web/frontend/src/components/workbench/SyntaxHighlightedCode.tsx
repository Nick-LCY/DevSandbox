import { useEffect, type CSSProperties, type ReactNode } from 'react';

import { splitPreviewLines } from '../../lib/preview-lines';
import {
  useSyntaxHighlight,
  type SyntaxHighlightTheme,
  type SyntaxHighlightToken,
} from '../../lib/syntax-highlight';
import type { SyntaxLanguage } from '../../lib/syntax-language';

interface SyntaxHighlightedLinesProps {
  lines: readonly string[];
  language: SyntaxLanguage;
  theme: SyntaxHighlightTheme;
  /**
   * 高亮用的完整源码。
   *
   * 缺省用 `lines.join('\n')`；**调用方有原文时应当传原文**——逐行切分与
   * 「末尾连续换行」这类边界上，`lines.join('\n')` 不能还原原文的切分结果，
   * 会让 token 与行号错位（例如原文 `"a\n\n"` 的行是 `['a', '']`，拼回去是
   * `"a\n"`、再切只剩一行）。
   */
  source?: string;
  /** Optional styling/identifier for the line containers owned by the caller's layout. */
  lineClassName?: string;
  lineTestId?: string;
  /** Let the caller own the line container markup (file pane keeps its own row layout). */
  renderLineContainer?: (index: number, content: ReactNode) => ReactNode;
  /** Report the highlight state so callers can expose it as a data attribute. */
  onStateChange?: (state: 'loading' | 'ready' | 'error') => void;
}

function tokenStyle(token: SyntaxHighlightToken): CSSProperties | undefined {
  const style: CSSProperties = {};
  if (token.color) {
    style.color = token.color;
  }
  const fontStyle = token.fontStyle ?? 0;
  if (fontStyle & 1) {
    style.fontStyle = 'italic';
  }
  if (fontStyle & 2) {
    style.fontWeight = 'bold';
  }
  if (fontStyle & 4) {
    style.textDecoration = 'underline';
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

function renderLine(tokens: readonly SyntaxHighlightToken[] | undefined, source: string): ReactNode {
  if (!tokens) {
    return source;
  }
  return tokens.map((token, index) => (
    <span key={index} className="shiki-token" style={tokenStyle(token)}>
      {token.content}
    </span>
  ));
}

/** Render already split preview lines while preserving empty lines and line ownership. */
export function SyntaxHighlightedLines({
  lines,
  language,
  theme,
  source,
  lineClassName,
  lineTestId,
  renderLineContainer,
  onStateChange,
}: SyntaxHighlightedLinesProps) {
  const highlightSource = source ?? lines.join('\n');
  const state = useSyntaxHighlight(highlightSource, language, theme);
  const tokens = state.status === 'ready' ? state.tokens : null;
  useEffect(() => {
    onStateChange?.(state.status);
  }, [onStateChange, state.status]);
  if (renderLineContainer) {
    return (
      <>
        {lines.map((line, index) =>
          renderLineContainer(index, renderLine(tokens?.[index], line)),
        )}
      </>
    );
  }
  return (
    <>
      {lines.map((line, index) => (
        <span
          key={index}
          className={lineClassName}
          data-testid={lineTestId}
          data-syntax-line={index}
        >
          {renderLine(tokens?.[index], line)}
        </span>
      ))}
    </>
  );
}

interface SyntaxHighlightedCodeBlockProps {
  source: string;
  language: SyntaxLanguage | null;
  /** Code blocks intentionally use a fixed terminal-dark theme. */
  theme?: 'github-dark';
  className?: string;
}

/**
 * A fenced Markdown code block that stays readable throughout asynchronous loading.
 *
 * The rendered text always equals the block body (line endings normalized to `\n`);
 * tokens only replace the plain text inside each line.
 */
export function SyntaxHighlightedCodeBlock({
  source,
  language,
  theme = 'github-dark',
  className,
}: SyntaxHighlightedCodeBlockProps) {
  const normalizedSource = source.replace(/\r\n?/g, '\n');
  const lines = splitPreviewLines(normalizedSource);
  const hasTrailingNewline = normalizedSource.endsWith('\n');
  const state = useSyntaxHighlight(normalizedSource, language, theme);
  const tokens = state.status === 'ready' ? state.tokens : null;

  const rendered = lines.flatMap((line, index) => [
    ...(index > 0 ? ['\n'] : []),
    <span key={index} data-syntax-line={index}>
      {renderLine(tokens?.[index], line)}
    </span>,
  ]);

  return (
    <code
      className={className}
      /* `plain` = 该块没有可识别的语言（压根不进高亮路径），与 `error`（识别了但失败）分开。 */
      data-syntax-state={language === null ? 'plain' : state.status}
      data-syntax-theme={theme}
    >
      {rendered}
      {hasTrailingNewline ? '\n' : ''}
    </code>
  );
}
