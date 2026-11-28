// @vitest-environment jsdom
/**
 * 高亮客户端（`syntax-highlight.ts`）的行为约定。
 *
 * 覆盖：请求缓存命中（同一 theme + language + source 只发一次）、过期 /
 * 未知响应被丢弃、Worker 不可用与 Worker 报错时的纯文本回退。
 */
import { StrictMode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearSyntaxHighlightCache,
  getSyntaxHighlightCacheStats,
  MAX_SYNTAX_CACHE_ENTRIES,
  MAX_SYNTAX_CACHE_BYTES,
  requestSyntaxHighlight,
  resetSyntaxHighlightWorker,
  useSyntaxHighlight,
} from './syntax-highlight';
import type { SyntaxHighlightTheme } from './syntax-highlight';

interface PostedMessage {
  requestId: number;
  source: string;
  language: string;
  theme: string;
}

/** 收到的请求（按顺序）。 */
let posted: PostedMessage[] = [];
/** 最近创建的 Worker 替身实例（测试用它手动派发响应）。 */
let lastWorker: StubWorker | null = null;

class StubWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;
  terminate(): void {
    this.terminated = true;
  }

  postMessage(message: PostedMessage): void {
    posted.push(message);
  }

  /** 手动派发一条 Worker 响应。 */
  respond(response: unknown): void {
    this.onmessage?.({ data: response } as MessageEvent<unknown>);
  }
}

beforeEach(() => {
  posted = [];
  lastWorker = null;
  vi.stubGlobal(
    'Worker',
    class extends StubWorker {
      constructor() {
        super();
        lastWorker = this;
      }
    },
  );
  resetSyntaxHighlightWorker();
});

afterEach(() => {
  resetSyntaxHighlightWorker();
  clearSyntaxHighlightCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('高亮客户端', () => {
  it('相同 theme + language + source 只发一次请求（缓存命中）', async () => {
    const first = requestSyntaxHighlight('const a = 1;', 'javascript', 'github-dark');
    const second = requestSyntaxHighlight('const a = 1;', 'javascript', 'github-dark');
    expect(posted).toHaveLength(1);

    lastWorker?.respond({
      requestId: posted[0].requestId,
      ok: true,
      lines: [[{ content: 'const a = 1;' }]],
    });

    await expect(first).resolves.toEqual([[{ content: 'const a = 1;' }]]);
    await expect(second).resolves.toEqual([[{ content: 'const a = 1;' }]]);
  });

  it('不同主题 / 语言 / 源码各发一次请求', () => {
    requestSyntaxHighlight('x', 'javascript', 'github-dark');
    requestSyntaxHighlight('x', 'javascript', 'github-light');
    requestSyntaxHighlight('x', 'typescript', 'github-dark');
    requestSyntaxHighlight('y', 'javascript', 'github-dark');
    expect(posted).toHaveLength(4);
  });

  it('过期响应（requestId 对不上）被丢弃，不影响当前请求', async () => {
    const promise = requestSyntaxHighlight('const b = 2;', 'javascript', 'github-dark');
    const currentId = posted[0].requestId;

    // 一条**过期**响应：requestId 不是当前请求的
    lastWorker?.respond({ requestId: currentId + 99, ok: true, lines: [[{ content: 'stale' }]] });
    lastWorker?.respond({ requestId: currentId, ok: true, lines: [[{ content: 'const b = 2;' }]] });

    await expect(promise).resolves.toEqual([[{ content: 'const b = 2;' }]]);
  });

  it('Worker 报错时请求以错误结束（调用方回退纯文本）', async () => {
    const promise = requestSyntaxHighlight('const c = 3;', 'javascript', 'github-dark');
    lastWorker?.onerror?.(new Error('boom'));
    await expect(promise).rejects.toThrow();
  });

  it('旧 Worker 晚到 error 不会清掉新 Worker 的 pending', async () => {
    const first = requestSyntaxHighlight('first', 'javascript', 'github-dark');
    const oldWorker = lastWorker;
    oldWorker?.onerror?.(new Error('old worker failed'));
    await expect(first).rejects.toThrow();

    const second = requestSyntaxHighlight('second', 'javascript', 'github-dark');
    const newWorker = lastWorker;
    expect(newWorker).not.toBe(oldWorker);
    oldWorker?.onerror?.(new Error('late old worker failed'));
    newWorker?.respond({
      requestId: posted[posted.length - 1].requestId,
      ok: true,
      lines: [[{ content: 'second' }]],
    });
    await expect(second).resolves.toEqual([[{ content: 'second' }]]);
  });

  it('失败结果不进缓存，后续同 key 请求可以重试', async () => {
    const first = requestSyntaxHighlight('retry me', 'javascript', 'github-dark');
    lastWorker?.respond({
      requestId: posted[0].requestId,
      ok: false,
      error: { code: 'load-failed', message: 'temporary failure' },
    });
    await expect(first).rejects.toThrow();
    expect(getSyntaxHighlightCacheStats().entries).toBe(0);

    const second = requestSyntaxHighlight('retry me', 'javascript', 'github-dark');
    expect(posted).toHaveLength(2);
    lastWorker?.respond({
      requestId: posted[1].requestId,
      ok: true,
      lines: [[{ content: 'retry me' }]],
    });
    await expect(second).resolves.toEqual([[{ content: 'retry me' }]]);
  });

  it('完成结果只保留在预算内，超过 16 MiB 的单项不入缓存', async () => {
    const source = 'x'.repeat(MAX_SYNTAX_CACHE_BYTES);
    const promise = requestSyntaxHighlight(source, 'javascript', 'github-dark');
    lastWorker?.respond({
      requestId: posted[0].requestId,
      ok: true,
      lines: [[{ content: source }]],
    });
    await expect(promise).resolves.toEqual([[{ content: source }]]);
    expect(getSyntaxHighlightCacheStats()).toMatchObject({ entries: 0, estimatedBytes: 0, pending: 0 });
  });

  it('访问缓存项会刷新 LRU 顺序后再淘汰', async () => {
    const complete = async (source: string) => {
      const promise = requestSyntaxHighlight(source, 'javascript', 'github-dark');
      lastWorker?.respond({
        requestId: posted[posted.length - 1].requestId,
        ok: true,
        lines: [[{ content: source }]],
      });
      await expect(promise).resolves.toEqual([[{ content: source }]]);
    };
    for (let index = 0; index < MAX_SYNTAX_CACHE_ENTRIES; index += 1) {
      await complete(`lru-${index}`);
    }
    const requestsBeforeHit = posted.length;
    await expect(requestSyntaxHighlight('lru-0', 'javascript', 'github-dark')).resolves.toEqual([
      [{ content: 'lru-0' }],
    ]);
    expect(posted).toHaveLength(requestsBeforeHit);

    await complete('lru-new');
    const requestsBeforeOldestRetry = posted.length;
    const oldestRetry = requestSyntaxHighlight('lru-1', 'javascript', 'github-dark');
    lastWorker?.respond({
      requestId: posted[posted.length - 1].requestId,
      ok: true,
      lines: [[{ content: 'lru-1' }]],
    });
    await expect(oldestRetry).resolves.toEqual([
      [{ content: 'lru-1' }],
    ]);
    expect(posted).toHaveLength(requestsBeforeOldestRetry + 1);
    expect(getSyntaxHighlightCacheStats().entries).toBe(MAX_SYNTAX_CACHE_ENTRIES);
  });

  it('30 秒超时会清理 pending、缓存并终止 Worker', async () => {
    vi.useFakeTimers();
    const promise = requestSyntaxHighlight('timeout', 'javascript', 'github-dark');
    const timedOutWorker = lastWorker;
    const expectation = expect(promise).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(30_000);
    await expectation;
    expect(getSyntaxHighlightCacheStats()).toEqual({ entries: 0, estimatedBytes: 0, pending: 0 });
    expect(timedOutWorker?.terminated).toBe(true);
    vi.useRealTimers();
  });

  it('最后消费者取消后，迟到成功响应不进入缓存', async () => {
    const { unmount } = renderHook(() =>
      useSyntaxHighlight('cancelled', 'javascript', 'github-dark'),
    );
    const cancelledWorker = lastWorker;
    const requestId = posted[0].requestId;
    unmount();
    await Promise.resolve();
    expect(getSyntaxHighlightCacheStats().pending).toBe(0);
    cancelledWorker?.respond({ requestId, ok: true, lines: [[{ content: 'cancelled' }]] });
    expect(getSyntaxHighlightCacheStats()).toMatchObject({ entries: 0, pending: 0 });
    expect(cancelledWorker?.terminated).toBe(true);
  });

  it('成功与结构化失败后都终止空闲 Worker', async () => {
    const success = requestSyntaxHighlight('success', 'javascript', 'github-dark');
    const successWorker = lastWorker;
    successWorker?.respond({ requestId: posted[0].requestId, ok: true, lines: [[{ content: 'success' }]] });
    await expect(success).resolves.toEqual([[{ content: 'success' }]]);
    expect(successWorker?.terminated).toBe(true);

    const failure = requestSyntaxHighlight('failure', 'javascript', 'github-dark');
    const failureWorker = lastWorker;
    failureWorker?.respond({
      requestId: posted[1].requestId,
      ok: false,
      error: { code: 'tokenize-failed', message: 'structured failure' },
    });
    await expect(failure).rejects.toThrow('structured failure');
    expect(failureWorker?.terminated).toBe(true);
  });

  it('完成结果按 entry 数量有界淘汰旧缓存', async () => {
    for (let index = 0; index < MAX_SYNTAX_CACHE_ENTRIES + 3; index += 1) {
      const source = `source-${index}`;
      const promise = requestSyntaxHighlight(source, 'javascript', 'github-dark');
      lastWorker?.respond({
        requestId: posted[posted.length - 1].requestId,
        ok: true,
        lines: [[{ content: source }]],
      });
      await expect(promise).resolves.toEqual([[{ content: source }]]);
    }
    const stats = getSyntaxHighlightCacheStats();
    expect(stats.entries).toBe(MAX_SYNTAX_CACHE_ENTRIES);
    expect(stats.estimatedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it('Worker 不可用时请求以错误结束（调用方回退纯文本）', async () => {
    vi.unstubAllGlobals();
    const promise = requestSyntaxHighlight('const d = 4;', 'javascript', 'github-dark');
    await expect(promise).rejects.toThrow();
  });
});

describe('useSyntaxHighlight', () => {
  it('输入切换后同步回退 loading，迟到的 A 响应不会覆盖 B', async () => {
    const { result, rerender } = renderHook(
      ({ source }) => useSyntaxHighlight(source, 'javascript', 'github-dark'),
      { initialProps: { source: 'A' } },
    );
    const firstId = posted[0].requestId;

    rerender({ source: 'B' });
    expect(result.current.status).toBe('loading');
    expect(result.current.key.endsWith('\u0000B')).toBe(true);
    const secondId = posted[1].requestId;

    lastWorker?.respond({ requestId: firstId, ok: true, lines: [[{ content: 'A' }]] });
    expect(result.current.status).toBe('loading');

    lastWorker?.respond({ requestId: secondId, ok: true, lines: [[{ content: 'B' }]] });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.tokens).toEqual([[{ content: 'B' }]]);
  });

  it('主题切换同步回退，并以新主题参数发起请求', async () => {
    const { result, rerender } = renderHook(
      ({ theme }) => useSyntaxHighlight('theme', 'javascript', theme),
      { initialProps: { theme: 'github-light' as SyntaxHighlightTheme } },
    );
    expect(posted[0].theme).toBe('github-light');

    rerender({ theme: 'github-dark' });
    expect(result.current.status).toBe('loading');
    expect(posted[1].theme).toBe('github-dark');
    lastWorker?.respond({
      requestId: posted[1].requestId,
      ok: true,
      lines: [[{ content: 'theme' }]],
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('StrictMode 双挂载复用同一个 pending 请求', () => {
    renderHook(() => useSyntaxHighlight('strict', 'javascript', 'github-dark'), {
      wrapper: StrictMode,
    });
    expect(posted).toHaveLength(1);
  });

  it('卸载后响应不会更新状态，且最后一个订阅会取消 pending', async () => {
    const { unmount } = renderHook(() =>
      useSyntaxHighlight('unmounted', 'javascript', 'github-dark'),
    );
    const requestId = posted[0].requestId;
    unmount();
    await Promise.resolve();
    expect(getSyntaxHighlightCacheStats().pending).toBe(0);
    lastWorker?.respond({ requestId, ok: true, lines: [[{ content: 'unmounted' }]] });
    expect(getSyntaxHighlightCacheStats().pending).toBe(0);
  });

  it('语言为 null 时不创建 Worker 请求，直接落到错误态（纯文本回退）', () => {
    const { result } = renderHook(() => useSyntaxHighlight('x', null, 'github-light'));
    expect(result.current.status).toBe('error');
    expect(posted).toHaveLength(0);
  });

  it('已识别语言：加载中先返回 loading，拿到 token 后转 ready', async () => {
    const { result } = renderHook(() =>
      useSyntaxHighlight('const a = 1;', 'javascript', 'github-dark'),
    );
    expect(result.current.status).toBe('loading');
    expect(posted).toHaveLength(1);

    lastWorker?.respond({
      requestId: posted[0].requestId,
      ok: true,
      lines: [[{ content: 'const a = 1;' }]],
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.tokens).toEqual([[{ content: 'const a = 1;' }]]);
  });

  it('高亮失败：状态落到 error（调用方保持纯文本）', async () => {
    const { result } = renderHook(() =>
      useSyntaxHighlight('const a = 1;', 'javascript', 'github-dark'),
    );
    expect(posted).toHaveLength(1);

    lastWorker?.respond({
      requestId: posted[0].requestId,
      ok: false,
      error: { code: 'tokenize-failed', message: 'boom' },
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.tokens).toBeNull();
  });
});
