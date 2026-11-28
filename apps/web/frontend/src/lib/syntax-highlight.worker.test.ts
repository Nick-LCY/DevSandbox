import { describe, expect, it } from 'vitest';

import { splitPreviewLines } from './preview-lines';
import { highlightSource } from './syntax-highlight.worker';

describe('syntax highlight worker line semantics', () => {
  it('uses the shared CRLF / empty-line / trailing-newline semantics', async () => {
    const source = 'const x = 1;\r\n\r\nreturn x;\r\n';
    const response = await highlightSource({
      requestId: 1,
      source,
      language: 'javascript',
      theme: 'github-dark',
    });

    expect(response.ok).toBe(true);
    if (!response.ok) {
      return;
    }
    const expectedLines = splitPreviewLines(source);
    expect(response.lines.map((line) => line.map((token) => token.content).join(''))).toEqual(
      expectedLines,
    );
    expect(response.lines).toHaveLength(expectedLines.length);
  });
});
