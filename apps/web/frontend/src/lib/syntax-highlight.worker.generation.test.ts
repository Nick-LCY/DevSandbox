import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('worker resource generations', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('shiki/engine/javascript', () => ({
      createJavaScriptRegexEngine: () => ({}) as never,
    }));
    vi.doMock('shiki/langs/javascript.mjs', () => ({ default: { name: 'javascript' } }));
    vi.doMock('shiki/themes/github-dark.mjs', () => ({ default: { name: 'github-dark' } }));
  });

  it('late resources from a failed generation cannot delete or poison a rebuilt generation', async () => {
    const oldThemeLoad = deferred<void>();
    const newThemeLoad = deferred<void>();
    let highlighterCount = 0;
    let languageLoadCount = 0;
    let themeLoadCount = 0;

    vi.doMock('shiki/core', () => ({
      createHighlighterCore: () => {
        const generation = ++highlighterCount;
        let themeLoaded = false;
        return Promise.resolve({
          loadLanguage: async () => {
            languageLoadCount += 1;
            if (generation === 1) {
              throw new Error('old language load failed');
            }
          },
          loadTheme: () => {
            themeLoadCount += 1;
            const pending = generation === 1 ? oldThemeLoad.promise : newThemeLoad.promise;
            return pending.then(() => {
              themeLoaded = true;
            });
          },
          codeToTokens: (source: string) => {
            if (!themeLoaded) {
              throw new Error('theme was not registered in this generation');
            }
            return {
              tokens: [[{ content: source }]],
            };
          },
        });
      },
    }));

    const { highlightSource } = await import('./syntax-highlight.worker');
    const first = highlightSource({
      requestId: 1,
      source: 'first',
      language: 'javascript',
      theme: 'github-dark',
    });
    // Let the first generation start both resource loads. Language failure resets it,
    // while the old theme load intentionally remains pending.
    await vi.waitFor(() => expect(languageLoadCount).toBe(1));
    await expect(first).resolves.toMatchObject({ ok: false });

    const second = highlightSource({
      requestId: 2,
      source: 'second',
      language: 'javascript',
      theme: 'github-dark',
    });
    await vi.waitFor(() => expect(themeLoadCount).toBe(2));

    // The old finally callback runs after the replacement generation has installed
    // its own same-key promise. It must not remove that new promise.
    oldThemeLoad.resolve();
    await Promise.resolve();
    const third = highlightSource({
      requestId: 3,
      source: 'third',
      language: 'javascript',
      theme: 'github-dark',
    });
    expect(themeLoadCount).toBe(2);

    newThemeLoad.resolve();
    await expect(second).resolves.toMatchObject({ ok: true });
    await expect(third).resolves.toMatchObject({ ok: true });
    expect(languageLoadCount).toBe(2);
    expect(themeLoadCount).toBe(2);
  });
});
