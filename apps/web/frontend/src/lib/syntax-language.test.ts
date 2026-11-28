import { describe, expect, it } from 'vitest';

import { resolveFileSyntaxLanguage, resolveFenceSyntaxLanguage } from './syntax-language';

describe('resolveFileSyntaxLanguage', () => {
  it('resolves common extensions case-insensitively', () => {
    expect(resolveFileSyntaxLanguage('src/App.JSX')).toBe('jsx');
    expect(resolveFileSyntaxLanguage('main.TS')).toBe('typescript');
    expect(resolveFileSyntaxLanguage('config.JSONC')).toBe('json');
    expect(resolveFileSyntaxLanguage('deploy.YAML')).toBe('yaml');
    expect(resolveFileSyntaxLanguage('script.SH')).toBe('bash');
    expect(resolveFileSyntaxLanguage('README.MD')).toBe('markdown');
  });

  it('recognizes special basenames', () => {
    expect(resolveFileSyntaxLanguage('Dockerfile')).toBe('dockerfile');
    expect(resolveFileSyntaxLanguage('/tmp/Dockerfile.dev')).toBe('dockerfile');
    expect(resolveFileSyntaxLanguage('Makefile')).toBe('makefile');
    expect(resolveFileSyntaxLanguage('GNUmakefile')).toBe('makefile');
    expect(resolveFileSyntaxLanguage('makefile')).toBe('makefile');
  });

  it('keeps markdown and text boundaries explicit', () => {
    expect(resolveFileSyntaxLanguage('notes.markdown')).toBe('markdown');
    expect(resolveFileSyntaxLanguage('notes.txt')).toBeNull();
    expect(resolveFileSyntaxLanguage('notes.text')).toBeNull();
    expect(resolveFileSyntaxLanguage('README')).toBeNull();
    expect(resolveFileSyntaxLanguage('unknown.xyz')).toBeNull();
  });
});

describe('resolveFenceSyntaxLanguage', () => {
  it('normalizes language-* identifiers and aliases', () => {
    expect(resolveFenceSyntaxLanguage('language-JAVASCRIPT')).toBe('javascript');
    expect(resolveFenceSyntaxLanguage('language-shell')).toBe('bash');
    expect(resolveFenceSyntaxLanguage('bash')).toBe('bash');
    expect(resolveFenceSyntaxLanguage('c++')).toBe('cpp');
    expect(resolveFenceSyntaxLanguage('language-md')).toBe('markdown');
  });

  it('returns null for text and unknown identifiers', () => {
    expect(resolveFenceSyntaxLanguage('language-text')).toBeNull();
    expect(resolveFenceSyntaxLanguage('txt')).toBeNull();
    expect(resolveFenceSyntaxLanguage('language-nope')).toBeNull();
    expect(resolveFenceSyntaxLanguage('')).toBeNull();
  });
});
