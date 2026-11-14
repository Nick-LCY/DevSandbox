// @vitest-environment node
/**
 * frontmatter 识别与剥离（渲染态隐藏、源码态可见的纯逻辑）。
 *
 * 边界逐条钉死：**文件以 `---` 开头才识别**、**未闭合不识别**、围栏行必须整行
 * 就是 `---`（`----` / `--- title` 都不算）、CRLF 与行尾空白、BOM。
 */

import { describe, expect, it } from 'vitest';

import { markdownBodyForRender, splitFrontmatter } from './markdown';

describe('splitFrontmatter', () => {
  it('标准 frontmatter：原文含围栏、正文去掉整块', () => {
    const text = '---\ntitle: 笔记\ntags: [a, b]\n---\n\n# 标题\n正文\n';
    const split = splitFrontmatter(text);
    expect(split.frontmatter).toBe('---\ntitle: 笔记\ntags: [a, b]\n---');
    expect(split.body).toBe('\n# 标题\n正文\n');
  });

  it('空 frontmatter（两条围栏紧挨着）', () => {
    expect(splitFrontmatter('---\n---\nbody')).toEqual({
      frontmatter: '---\n---',
      body: 'body',
    });
  });

  it('没有 frontmatter 的文件原样返回', () => {
    const text = '# 标题\n\n正文\n';
    expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
    expect(splitFrontmatter('')).toEqual({ frontmatter: null, body: '' });
  });

  it('文件不是以 `---` 开头 ⇒ 不识别（正文里出现分隔线不算）', () => {
    const text = '# 标题\n\n---\ntitle: x\n---\n';
    expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });

  it('首行不是整行 `---` ⇒ 不识别（`----` / `--- title`）', () => {
    for (const text of ['----\ntitle: x\n---\n', '--- title: x\n---\nbody']) {
      expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
    }
  });

  it('未闭合 ⇒ 不识别（不把整个文件吞掉）', () => {
    const text = '---\ntitle: x\n\n正文没有闭合围栏\n';
    expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
    // 只有一个 `---` 行（整个文件就这一行）同样不识别。
    expect(splitFrontmatter('---')).toEqual({ frontmatter: null, body: '---' });
    expect(splitFrontmatter('---\n')).toEqual({ frontmatter: null, body: '---\n' });
  });

  it('CRLF 与行尾空白照常识别', () => {
    const split = splitFrontmatter('---  \r\ntitle: x\r\n---\t\r\nbody\r\n');
    expect(split.frontmatter).toBe('---  \r\ntitle: x\r\n---\t');
    expect(split.body).toBe('body\r\n');
  });

  it('BOM 不影响识别', () => {
    expect(splitFrontmatter('\uFEFF---\ntitle: x\n---\nbody')).toEqual({
      frontmatter: '---\ntitle: x\n---',
      body: 'body',
    });
  });

  it('正文里再出现 `---` 只当分隔线（frontmatter 只认第一块）', () => {
    const split = splitFrontmatter('---\na: 1\n---\n正文\n---\n尾\n');
    expect(split.frontmatter).toBe('---\na: 1\n---');
    expect(split.body).toBe('正文\n---\n尾\n');
  });
});

describe('markdownBodyForRender', () => {
  it('剥掉 frontmatter，并去掉正文开头的空行', () => {
    expect(markdownBodyForRender('---\na: 1\n---\n\n\n# 标题')).toBe('# 标题');
  });

  it('没有 frontmatter 时只去开头空行', () => {
    expect(markdownBodyForRender('\n\n# 标题')).toBe('# 标题');
    expect(markdownBodyForRender('# 标题\n\n正文')).toBe('# 标题\n\n正文');
  });
});
