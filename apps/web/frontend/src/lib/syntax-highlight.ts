import { useEffect, useState } from 'react';

import type { SyntaxLanguage } from './syntax-language';
import type {
  SyntaxHighlightRequest,
  SyntaxHighlightResponse,
  SyntaxHighlightTheme,
  SyntaxHighlightToken,
} from './syntax-highlight.worker';

export type { SyntaxHighlightTheme, SyntaxHighlightToken } from './syntax-highlight.worker';

/** Map the applied application theme onto the Shiki theme used for token colors. */
export function syntaxThemeFor(theme: 'light' | 'dark'): SyntaxHighlightTheme {
  return theme === 'dark' ? 'github-dark' : 'github-light';
}

/**
 * Completed token results are bounded independently by count and estimated UTF-16
 * bytes. The source is part of the cache key, so keeping both key and tokens is
 * roughly two copies of the highlighted text; these limits cap that retained
 * memory at a useful size while still allowing normal preview reuse.
 */
export const MAX_SYNTAX_CACHE_ENTRIES = 32;
export const MAX_SYNTAX_CACHE_BYTES = 16 * 1024 * 1024;
/** A stuck Worker request must not remain pending forever. */
export const SYNTAX_REQUEST_TIMEOUT_MS = 30_000;

export type SyntaxHighlightState =
  | { key: string; status: 'loading'; tokens: null }
  | { key: string; status: 'ready'; tokens: SyntaxHighlightToken[][] }
  | { key: string; status: 'error'; tokens: null; error: Error };

class SyntaxHighlightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyntaxHighlightError';
  }
}

interface PendingRequest {
  key: string;
  requestId: number;
  worker: Worker;
  resolve: (tokens: SyntaxHighlightToken[][]) => void;
  reject: (error: Error) => void;
  promise: Promise<SyntaxHighlightToken[][]>;
  consumers: number;
  settled: boolean;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface CompletedCacheEntry {
  tokens: SyntaxHighlightToken[][];
  estimatedBytes: number;
}

let worker: Worker | null = null;
let nextRequestId = 0;
const pendingById = new Map<number, PendingRequest>();
const pendingByKey = new Map<string, PendingRequest>();
/** Completed results only. In-flight requests live in pendingByKey instead. */
const completedCache = new Map<string, CompletedCacheEntry>();
let completedCacheBytes = 0;

function workerUnavailable(): SyntaxHighlightError {
  return new SyntaxHighlightError('语法高亮 Worker 不可用');
}

function requestCancelled(): SyntaxHighlightError {
  return new SyntaxHighlightError('语法高亮请求已取消');
}

function syntaxCacheKey(
  theme: SyntaxHighlightTheme,
  language: SyntaxLanguage,
  source: string,
): string {
  return `${theme}\u0000${language}\u0000${source}`;
}

function estimateTokenBytes(key: string, tokens: SyntaxHighlightToken[][]): number {
  // UTF-16 characters are two bytes; fixed costs cover Map/token/line metadata.
  let bytes = key.length * 2 + 64;
  for (const line of tokens) {
    bytes += 16;
    for (const token of line) {
      bytes += token.content.length * 2 + 48;
    }
  }
  return bytes;
}

function getCompleted(key: string): SyntaxHighlightToken[][] | undefined {
  const entry = completedCache.get(key);
  if (!entry) {
    return undefined;
  }
  // Map insertion order is the LRU order.
  completedCache.delete(key);
  completedCache.set(key, entry);
  return entry.tokens;
}

function storeCompleted(key: string, tokens: SyntaxHighlightToken[][]): void {
  const estimatedBytes = estimateTokenBytes(key, tokens);
  if (estimatedBytes > MAX_SYNTAX_CACHE_BYTES) {
    // A single huge result is still rendered, but does not make the cache exceed
    // its byte budget by itself.
    return;
  }
  const previous = completedCache.get(key);
  if (previous) {
    completedCacheBytes -= previous.estimatedBytes;
    completedCache.delete(key);
  }
  completedCache.set(key, { tokens, estimatedBytes });
  completedCacheBytes += estimatedBytes;

  while (
    completedCache.size > MAX_SYNTAX_CACHE_ENTRIES ||
    completedCacheBytes > MAX_SYNTAX_CACHE_BYTES
  ) {
    const oldest = completedCache.keys().next().value as string | undefined;
    if (oldest === undefined) {
      break;
    }
    const entry = completedCache.get(oldest);
    completedCache.delete(oldest);
    completedCacheBytes -= entry?.estimatedBytes ?? 0;
  }
}

function settlePending(
  request: PendingRequest,
  outcome: { ok: true; tokens: SyntaxHighlightToken[][] } | { ok: false; error: Error },
): void {
  if (request.settled || pendingById.get(request.requestId) !== request) {
    return;
  }
  request.settled = true;
  clearTimeout(request.timeoutId);
  pendingById.delete(request.requestId);
  if (pendingByKey.get(request.key) === request) {
    pendingByKey.delete(request.key);
  }
  if (outcome.ok) {
    storeCompleted(request.key, outcome.tokens);
    request.resolve(outcome.tokens);
  } else {
    // Failed results deliberately never enter completedCache. A later request
    // can therefore retry a failed dynamic grammar/theme load.
    request.reject(outcome.error);
  }
  // Successful responses and structured failures can both leave the Worker idle.
  // Terminating here releases the Worker and its grammar memory after this request;
  // a later request will create a fresh Worker.
  stopWorkerIfIdle(request.worker);
}

function stopWorkerIfIdle(instance: Worker): void {
  if (worker !== instance) {
    return;
  }
  for (const request of pendingById.values()) {
    if (request.worker === instance) {
      return;
    }
  }
  instance.terminate();
  worker = null;
}

function cancelPending(request: PendingRequest, error: Error): void {
  if (request.settled || pendingById.get(request.requestId) !== request) {
    return;
  }
  settlePending(request, { ok: false, error });
  stopWorkerIfIdle(request.worker);
}

function rejectPendingForWorker(instance: Worker, error: Error): void {
  for (const request of [...pendingById.values()]) {
    if (request.worker === instance) {
      settlePending(request, { ok: false, error });
    }
  }
}

function ensureWorker(): Worker {
  if (worker !== null) {
    return worker;
  }
  if (typeof Worker === 'undefined') {
    throw workerUnavailable();
  }
  try {
    const instance = new Worker(new URL('./syntax-highlight.worker.ts', import.meta.url), {
      type: 'module',
    });
    instance.onmessage = (event: MessageEvent<SyntaxHighlightResponse>) => {
      // An old Worker can deliver an event after it was terminated/replaced.
      // Check identity before touching any current pending request.
      if (worker !== instance) {
        return;
      }
      const response = event.data;
      const request = pendingById.get(response.requestId);
      if (!request || request.worker !== instance) {
        return;
      }
      if (response.ok) {
        settlePending(request, { ok: true, tokens: response.lines });
      } else {
        settlePending(request, {
          ok: false,
          error: new SyntaxHighlightError(response.error.message),
        });
      }
    };
    instance.onerror = () => {
      // Check identity first: a late error from an old instance must not reject
      // requests belonging to the replacement Worker.
      if (worker !== instance) {
        return;
      }
      const error = workerUnavailable();
      rejectPendingForWorker(instance, error);
      instance.terminate();
      worker = null;
    };
    worker = instance;
    return instance;
  } catch {
    throw workerUnavailable();
  }
}

interface SyntaxHighlightSubscription {
  promise: Promise<SyntaxHighlightToken[][]>;
  release: () => void;
}

function acquireSyntaxHighlight(
  source: string,
  language: SyntaxLanguage,
  theme: SyntaxHighlightTheme,
): SyntaxHighlightSubscription {
  const key = syntaxCacheKey(theme, language, source);
  const cached = getCompleted(key);
  if (cached) {
    return { promise: Promise.resolve(cached), release: () => undefined };
  }

  const existing = pendingByKey.get(key);
  if (existing) {
    existing.consumers += 1;
    return {
      promise: new Promise<SyntaxHighlightToken[][]>((resolve, reject) => {
        // Shared requests resolve through the single underlying promise below.
        void existing.promise.then(resolve, reject);
      }),
      release: () => releasePending(existing),
    };
  }

  let instance: Worker;
  try {
    instance = ensureWorker();
  } catch (error) {
    const failed = Promise.reject(error instanceof Error ? error : workerUnavailable());
    failed.catch(() => undefined);
    return { promise: failed, release: () => undefined };
  }

  let resolvePromise!: (tokens: SyntaxHighlightToken[][]) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<SyntaxHighlightToken[][]>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  promise.catch(() => undefined);
  const request = {} as PendingRequest;
  request.key = key;
  request.requestId = ++nextRequestId;
  request.worker = instance;
  request.resolve = resolvePromise;
  request.reject = rejectPromise;
  request.promise = promise;
  request.consumers = 1;
  request.settled = false;
  request.timeoutId = setTimeout(() => {
    cancelPending(request, new SyntaxHighlightError('语法高亮请求超时'));
  }, SYNTAX_REQUEST_TIMEOUT_MS);
  pendingById.set(request.requestId, request);
  pendingByKey.set(key, request);

  const message: SyntaxHighlightRequest = { requestId: request.requestId, source, language, theme };
  try {
    instance.postMessage(message);
  } catch (error) {
    cancelPending(request, error instanceof Error ? error : workerUnavailable());
  }

  return { promise, release: () => releasePending(request) };
}

function releasePending(request: PendingRequest): void {
  if (request.settled || request.consumers === 0) {
    return;
  }
  request.consumers -= 1;
  if (request.consumers !== 0) {
    return;
  }
  // Let an immediate StrictMode remount or another component subscribing to the
  // same key reclaim the request before cancelling it.
  queueMicrotask(() => {
    if (!request.settled && request.consumers === 0) {
      cancelPending(request, requestCancelled());
    }
  });
}

/** Request full-source tokenization. Only successful results enter the LRU cache. */
export function requestSyntaxHighlight(
  source: string,
  language: SyntaxLanguage,
  theme: SyntaxHighlightTheme,
): Promise<SyntaxHighlightToken[][]> {
  const subscription = acquireSyntaxHighlight(source, language, theme);
  // Direct callers do not have a lifecycle cleanup callback, so their temporary
  // consumer is released as soon as the request settles.
  void subscription.promise.then(subscription.release, subscription.release);
  return subscription.promise;
}

function stateKey(
  source: string,
  language: SyntaxLanguage | null,
  theme: SyntaxHighlightTheme,
): string {
  return `${theme}\u0000${language ?? 'plain'}\u0000${source}`;
}

function initialState(
  key: string,
  language: SyntaxLanguage | null,
): SyntaxHighlightState {
  return language === null
    ? { key, status: 'error', tokens: null, error: new SyntaxHighlightError('未识别的语法语言') }
    : { key, status: 'loading', tokens: null };
}

/** Hook used by both preview surfaces. Unknown languages never create a Worker request. */
export function useSyntaxHighlight(
  source: string,
  language: SyntaxLanguage | null,
  theme: SyntaxHighlightTheme,
): SyntaxHighlightState {
  const key = stateKey(source, language, theme);
  const [state, setState] = useState<SyntaxHighlightState>(() => initialState(key, language));

  useEffect(() => {
    let active = true;
    if (language === null) {
      setState(initialState(key, language));
      return () => {
        active = false;
      };
    }

    const subscription = acquireSyntaxHighlight(source, language, theme);
    setState({ key, status: 'loading', tokens: null });
    void subscription.promise.then(
      (tokens) => {
        if (active) {
          setState({ key, status: 'ready', tokens });
        }
      },
      (error: unknown) => {
        if (active) {
          setState({
            key,
            status: 'error',
            tokens: null,
            error: error instanceof Error ? error : new SyntaxHighlightError(String(error)),
          });
        }
      },
    );
    return () => {
      active = false;
      subscription.release();
    };
  }, [key, language, source, theme]);

  // Effects run after paint. During the render immediately following an input
  // change, do not expose ready tokens belonging to the previous key.
  if (state.key !== key) {
    return initialState(key, language);
  }
  return state;
}

/** Test isolation helper; production callers should never need to clear this cache. */
export function clearSyntaxHighlightCache(): void {
  completedCache.clear();
  completedCacheBytes = 0;
}

/** Test-only observability for LRU and failure-eviction coverage. */
export function getSyntaxHighlightCacheStats(): {
  entries: number;
  estimatedBytes: number;
  pending: number;
} {
  return {
    entries: completedCache.size,
    estimatedBytes: completedCacheBytes,
    pending: pendingByKey.size,
  };
}

/** Test isolation helper: drop the worker instance so a new Worker stub can be used. */
export function resetSyntaxHighlightWorker(): void {
  const instance = worker;
  if (instance) {
    rejectPendingForWorker(instance, workerUnavailable());
    instance.terminate();
  }
  worker = null;
  clearSyntaxHighlightCache();
}
