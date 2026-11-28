/**
 * 测试用的 Worker 替身（**仅测试用**，生产代码不引用本文件）。
 *
 * 它把真实的 worker 实现（`highlightSource`，含真实 Shiki 语法）接到一个假的
 * `Worker` 上：这样组件测试既能断言「真的出现了 token」，又不需要浏览器环境。
 */
import { vi } from 'vitest';

import {
  highlightSource,
  type SyntaxHighlightRequest,
  type SyntaxHighlightResponse,
} from './syntax-highlight.worker';
import { resetSyntaxHighlightWorker } from './syntax-highlight';

/** 安装 Worker 替身；返回卸载函数。 */
export function installSyntaxWorkerStub(): () => void {
  class StubWorker {
    onmessage: ((event: MessageEvent<SyntaxHighlightResponse>) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    terminate(): void {}

    postMessage(message: SyntaxHighlightRequest): void {
      void highlightSource(message).then((response) => {
        this.onmessage?.({ data: response } as MessageEvent<SyntaxHighlightResponse>);
      });
    }
  }

  vi.stubGlobal('Worker', StubWorker);
  resetSyntaxHighlightWorker();
  return () => {
    resetSyntaxHighlightWorker();
    vi.unstubAllGlobals();
  };
}

/** 安装一个永远失败的 Worker 替身（用于断言纯文本回退）。 */
export function installFailingSyntaxWorkerStub(): () => void {
  class FailingWorker {
    onmessage: ((event: MessageEvent<SyntaxHighlightResponse>) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    terminate(): void {}

    postMessage(): void {
      this.onerror?.(new Error('worker failed'));
    }
  }

  vi.stubGlobal('Worker', FailingWorker);
  resetSyntaxHighlightWorker();
  return () => {
    resetSyntaxHighlightWorker();
    vi.unstubAllGlobals();
  };
}
