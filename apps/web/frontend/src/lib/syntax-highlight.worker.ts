import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { LanguageRegistration, ThemeRegistrationAny, TokenStyles } from 'shiki/core';

import type { SyntaxLanguage } from './syntax-language';
import { splitPreviewLines } from './preview-lines';

export type SyntaxHighlightTheme = 'github-light' | 'github-dark';

export interface SyntaxHighlightRequest {
  requestId: number;
  source: string;
  language: SyntaxLanguage;
  theme: SyntaxHighlightTheme;
}

export interface SyntaxHighlightToken {
  content: string;
  color?: string;
  fontStyle?: number;
}

export interface SyntaxHighlightSuccess {
  requestId: number;
  ok: true;
  lines: SyntaxHighlightToken[][];
}

export interface SyntaxHighlightFailure {
  requestId: number;
  ok: false;
  error: {
    code: 'unsupported-language' | 'load-failed' | 'tokenize-failed';
    message: string;
  };
}

export type SyntaxHighlightResponse = SyntaxHighlightSuccess | SyntaxHighlightFailure;

type LanguageLoader = () => Promise<{ default: LanguageRegistration | LanguageRegistration[] }>;
type ThemeLoader = () => Promise<{ default: ThemeRegistrationAny }>;

/*
 * Explicit per-grammar imports: every grammar stays its own dynamic chunk and is
 * only fetched when a file actually needs that language.
 */
const languageLoaders: Record<SyntaxLanguage, LanguageLoader> = {
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  r: () => import('shiki/langs/r.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  astro: () => import('shiki/langs/astro.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  makefile: () => import('shiki/langs/makefile.mjs'),
};

const themeLoaders: Record<SyntaxHighlightTheme, ThemeLoader> = {
  'github-light': () => import('shiki/themes/github-light.mjs'),
  'github-dark': () => import('shiki/themes/github-dark.mjs'),
};

interface ResourceState {
  /** Monotonically increasing generation; replacing this object invalidates old callbacks. */
  generation: number;
  highlighterPromise: ReturnType<typeof createHighlighterCore> | null;
  loadedLanguages: Set<SyntaxLanguage>;
  loadedThemes: Set<SyntaxHighlightTheme>;
  /** Concurrent first loads share one promise instead of racing registration calls. */
  languageLoadPromises: Map<SyntaxLanguage, Promise<void>>;
  themeLoadPromises: Map<SyntaxHighlightTheme, Promise<void>>;
}

function createResourceState(generation: number): ResourceState {
  return {
    generation,
    highlighterPromise: null,
    loadedLanguages: new Set(),
    loadedThemes: new Set(),
    languageLoadPromises: new Map(),
    themeLoadPromises: new Map(),
  };
}

/**
 * All mutable highlighter resources belong to one generation. A failed load replaces the
 * entire object; promises still running against the old object can therefore finish without
 * adding a grammar/theme to the replacement highlighter.
 */
let nextGeneration = 0;
let resourceState = createResourceState(nextGeneration);

function highlighter(state: ResourceState): ReturnType<typeof createHighlighterCore> {
  state.highlighterPromise ??= createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    warnings: false,
  });
  return state.highlighterPromise;
}

function tokenStyles(token: TokenStyles): Pick<SyntaxHighlightToken, 'color' | 'fontStyle'> {
  return {
    ...(token.color ? { color: token.color } : {}),
    ...(token.fontStyle !== undefined ? { fontStyle: token.fontStyle } : {}),
  };
}

function loadLanguage(language: SyntaxLanguage, state: ResourceState): Promise<void> {
  if (state.loadedLanguages.has(language)) {
    return Promise.resolve();
  }
  const existing = state.languageLoadPromises.get(language);
  if (existing) {
    return existing;
  }
  const loading = (async () => {
    const instance = await highlighter(state);
    const registration = (await languageLoaders[language]()).default;
    await instance.loadLanguage(registration);
    state.loadedLanguages.add(language);
  })().finally(() => {
    // A failure may have replaced resourceState while this import was pending. Only
    // remove the map entry if it still points at this exact promise.
    if (state.languageLoadPromises.get(language) === loading) {
      state.languageLoadPromises.delete(language);
    }
  });
  state.languageLoadPromises.set(language, loading);
  return loading;
}

function loadTheme(theme: SyntaxHighlightTheme, state: ResourceState): Promise<void> {
  if (state.loadedThemes.has(theme)) {
    return Promise.resolve();
  }
  const existing = state.themeLoadPromises.get(theme);
  if (existing) {
    return existing;
  }
  const loading = (async () => {
    const instance = await highlighter(state);
    const registration = (await themeLoaders[theme]()).default;
    await instance.loadTheme(registration);
    state.loadedThemes.add(theme);
  })().finally(() => {
    // See loadLanguage: reset can create a new promise for the same key before this
    // old promise settles, so an unconditional delete would delete the new promise.
    if (state.themeLoadPromises.get(theme) === loading) {
      state.themeLoadPromises.delete(theme);
    }
  });
  state.themeLoadPromises.set(theme, loading);
  return loading;
}

/** A failed highlighter resource load must not poison later requests. */
function resetHighlighterAfterFailure(failedState: ResourceState): void {
  // An older request can fail after a newer generation has already been installed.
  // It must not reset that newer generation.
  if (resourceState !== failedState || resourceState.generation !== failedState.generation) {
    return;
  }
  resourceState = createResourceState(++nextGeneration);
}

/** Tokenize a whole source. Failures are returned as structured errors, never thrown. */
export async function highlightSource(
  request: SyntaxHighlightRequest,
): Promise<SyntaxHighlightResponse> {
  const languageLoader = languageLoaders[request.language];
  const themeLoader = themeLoaders[request.theme];
  if (!languageLoader || !themeLoader) {
    return {
      requestId: request.requestId,
      ok: false,
      error: { code: 'unsupported-language', message: '不支持的语法语言' },
    };
  }

  const state = resourceState;
  try {
    const instance = await highlighter(state);
    await Promise.all([
      loadLanguage(request.language, state),
      loadTheme(request.theme, state),
    ]);
    const tokenLines = instance.codeToTokens(request.source, {
      lang: request.language,
      theme: request.theme,
    }).tokens;
    const sourceLines = splitPreviewLines(request.source);
    const lines = sourceLines.map((sourceLine, lineIndex) => {
      const rawTokens = tokenLines[lineIndex] ?? [];
      const tokens = rawTokens.map((token) => ({
        content: token.content,
        ...tokenStyles(token),
      }));
      // Shiki normally preserves the line text verbatim. If a grammar ever returns a
      // diverging token stream, fall back to the plain line so the preview stays
      // faithful to the file content.
      const rendered = tokens.map((token) => token.content).join('');
      return rendered === sourceLine ? tokens : [{ content: sourceLine }];
    });
    return { requestId: request.requestId, ok: true, lines };
  } catch (error) {
    resetHighlighterAfterFailure(state);
    return {
      requestId: request.requestId,
      ok: false,
      error: {
        code: 'tokenize-failed',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<SyntaxHighlightRequest>) => void) | null;
  postMessage(message: SyntaxHighlightResponse): void;
}

/*
 * Only wire the message handler inside a real worker scope: the same module is
 * imported by unit tests in a DOM environment, where `self` is the window.
 */
const workerGlobal = globalThis as typeof globalThis & {
  WorkerGlobalScope?: new () => unknown;
};

const isWorkerScope =
  typeof workerGlobal.WorkerGlobalScope === 'function' &&
  typeof self !== 'undefined' &&
  self instanceof workerGlobal.WorkerGlobalScope;

if (isWorkerScope) {
  const workerScope = self as unknown as WorkerScope;
  workerScope.onmessage = (event) => {
    void highlightSource(event.data).then((response) => workerScope.postMessage(response));
  };
}
