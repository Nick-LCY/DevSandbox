/**
 * 接口层：请求基址拼接、`Authorization` 头、票据获取与「未配置不发请求」。
 *
 * 这是连接层的硬要求所在：每个请求都带 Bearer；令牌缺失时一个请求都不发。
 * **请求恒为绝对地址**（决策 D：基址恒非空，不再有「同源 = 相对路径」的分支）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_BACKEND_BASE_URL,
  cacheConnectionConfig,
  setConnectionConfig,
} from '../lib/connection';
import { ApiError, ConnectionNotConfiguredError, api, fetchAuthTicket } from './client';

/** fetch 的替身。 */
const fetchMock = vi.fn();

/** 一个够用的响应。 */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  // 默认：默认后端地址 + 有令牌。
  setConnectionConfig({ backendBaseUrl: DEFAULT_BACKEND_BASE_URL, token: 'sbx_test' });
});

afterEach(() => {
  cacheConnectionConfig({ backendBaseUrl: DEFAULT_BACKEND_BASE_URL, token: '' });
  vi.unstubAllGlobals();
});

describe('请求基址与凭据', () => {
  it('每个请求都带 Authorization: Bearer <token>', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    await api.listSandboxes();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_BACKEND_BASE_URL}/api/sandboxes`);
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer sbx_test');
  });

  it('基址为空：归一为默认地址，请求走绝对地址（不再拼相对路径）', async () => {
    setConnectionConfig({ backendBaseUrl: '', token: 'sbx_test' });
    fetchMock.mockResolvedValue(jsonResponse({ version: '0.2.0' }));

    await api.health();

    expect(fetchMock.mock.calls[0][0]).toBe(`${DEFAULT_BACKEND_BASE_URL}/api/health`);
  });

  it('基址非空：请求走绝对地址（连远端后端）', async () => {
    setConnectionConfig({ backendBaseUrl: 'http://10.0.0.5:8000', token: 'sbx_test' });
    fetchMock.mockResolvedValue(jsonResponse({ version: '0.2.0' }));

    await api.health();

    expect(fetchMock.mock.calls[0][0]).toBe('http://10.0.0.5:8000/api/health');
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer sbx_test');
  });

  it('基址可配：网页形态填了远端地址也走绝对地址（两种形态一个口径）', async () => {
    // 连接层不再按形态收敛：网页端也能指向远端后端。
    setConnectionConfig({ backendBaseUrl: 'https://sandbox.example:8443', token: 'sbx_test' });
    fetchMock.mockResolvedValue(jsonResponse({ version: '0.2.0' }));

    await api.health();

    expect(fetchMock.mock.calls[0][0]).toBe('https://sandbox.example:8443/api/health');
  });

  it('令牌缺失：一个请求都不发，抛「未配置」错误', async () => {
    setConnectionConfig({ backendBaseUrl: '', token: '' });

    await expect(api.health()).rejects.toBeInstanceOf(ConnectionNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('后端报错：直接取 detail 文案', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: '访问令牌无效或缺失' }, 401));

    await expect(api.health()).rejects.toMatchObject({
      name: 'ApiError',
      message: '访问令牌无效或缺失',
      status: 401,
    });
  });

  it('网络不可达：报「无法连接后端服务」', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(api.health()).rejects.toBeInstanceOf(ApiError);
  });

  it('健康检查超时：报「连接后端超时」，不把加载态挂死', async () => {
    vi.useFakeTimers();
    // 后端不回应也不断开：请求一直挂着。
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    const pending = api.health();
    // 先挂上拒绝断言再推进计时器：否则拒绝发生时还没有处理器，会报未处理的 rejections。
    const assertion = expect(pending).rejects.toThrow('连接后端超时');
    await vi.advanceTimersByTimeAsync(10000);

    await assertion;
    vi.useRealTimers();
  });
});

describe('一次性票据', () => {
  it('换票：POST /api/auth/ticket，带 Bearer，返回票据本体', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ticket: 'sbxt_abc', expires_in: 30 }));

    const ticket = await fetchAuthTicket();

    expect(ticket).toBe('sbxt_abc');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_BACKEND_BASE_URL}/api/auth/ticket`);
    expect(init.method).toBe('POST');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer sbx_test');
  });

  it('每次现取，不缓存：连着取两次就是两个请求', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ticket: 'sbxt_abc', expires_in: 30 }));

    await api.fetchAuthTicket();
    await api.fetchAuthTicket();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/* ---------------------------------------------------------------- 文件传输 */

/** XHR 的替身：只实现文件上传用到的接口。 */
class FakeEventTarget {
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class FakeXhr extends FakeEventTarget {
  static instances: FakeXhr[] = [];

  upload = new FakeEventTarget();
  status = 0;
  responseText = '';
  aborted = false;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;

  constructor() {
    super();
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: unknown): void {
    this.body = body;
  }

  abort(): void {
    this.aborted = true;
    this.emit('abort');
  }
}

describe('文件传输接口', () => {
  it('目录列表走既有 JSON 通道：路径放在 query 里并百分号编码', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    await api.listFiles('demo-01', '/home/中文 dir');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${DEFAULT_BACKEND_BASE_URL}/api/sandboxes/demo-01/files/list?path=${encodeURIComponent(
        '/home/中文 dir',
      )}`,
    );
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer sbx_test');
  });

  it('上传走 XHR：显式 octet-stream、Bearer、raw File body、进度事件', async () => {
    FakeXhr.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest);
    const file = new File(['abc'], 'a.txt', { type: 'text/plain' });
    const progress: Array<{ loaded: number; total: number | null }> = [];

    const pending = api.uploadFile('demo-01', '/home/acc-demo/a.txt', file, {
      onProgress: (event) => progress.push(event),
    });
    const xhr = FakeXhr.instances[0];
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe(
      `${DEFAULT_BACKEND_BASE_URL}/api/sandboxes/demo-01/files/upload?path=${encodeURIComponent(
        '/home/acc-demo/a.txt',
      )}`,
    );
    expect(xhr.headers['Authorization']).toBe('Bearer sbx_test');
    expect(xhr.headers['Content-Type']).toBe('application/octet-stream');
    expect(xhr.body).toBe(file);

    xhr.upload.emit('progress', { lengthComputable: true, loaded: 5, total: 10 });
    expect(progress).toEqual([{ loaded: 5, total: 10 }]);

    xhr.status = 200;
    xhr.responseText = JSON.stringify({ path: '/home/acc-demo/a.txt', bytes: 3 });
    xhr.emit('load');

    await expect(pending).resolves.toEqual({ path: '/home/acc-demo/a.txt', bytes: 3 });
  });

  it('上传失败：取后端 detail 原文', async () => {
    FakeXhr.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest);

    const pending = api.uploadFile('demo-01', '/x', new File(['abc'], 'a.txt'));
    const xhr = FakeXhr.instances[0];
    xhr.status = 400;
    xhr.responseText = JSON.stringify({ detail: '目标是一个目录，不能作为上传目标' });
    xhr.emit('load');

    await expect(pending).rejects.toMatchObject({
      name: 'ApiError',
      message: '目标是一个目录，不能作为上传目标',
      status: 400,
    });
  });

  it('上传停滞看门狗：连续 120 秒没有任何 progress 就 abort 并报可读文案', async () => {
    vi.useFakeTimers();
    FakeXhr.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest);

    const pending = api.uploadFile('demo-01', '/x', new File(['abc'], 'a.txt'));
    const assertion = expect(pending).rejects.toThrow('上传停滞，已取消');
    const xhr = FakeXhr.instances[0];

    await vi.advanceTimersByTimeAsync(119_000);
    expect(xhr.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(xhr.aborted).toBe(true);
    await assertion;
    vi.useRealTimers();
  });

  it('慢速但持续有进度的上传：看门狗随 progress 重置，不会被误杀', async () => {
    vi.useFakeTimers();
    FakeXhr.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest);

    const pending = api.uploadFile('demo-01', '/x', new File(['abc'], 'a.txt'));
    const xhr = FakeXhr.instances[0];

    // 每 100 秒才来一次进度：总时长超过 120 秒，但两次进度间隔没超过阈值。
    await vi.advanceTimersByTimeAsync(100_000);
    xhr.upload.emit('progress', { lengthComputable: true, loaded: 1, total: 3 });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(xhr.aborted).toBe(false);

    xhr.status = 200;
    xhr.responseText = JSON.stringify({ path: '/x', bytes: 3 });
    xhr.emit('load');
    await expect(pending).resolves.toEqual({ path: '/x', bytes: 3 });
    vi.useRealTimers();
  });

  it('令牌缺失：上传不发 XHR', async () => {
    FakeXhr.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest);
    setConnectionConfig({ backendBaseUrl: DEFAULT_BACKEND_BASE_URL, token: '' });

    await expect(
      api.uploadFile('demo-01', '/x', new File(['abc'], 'a.txt')),
    ).rejects.toBeInstanceOf(ConnectionNotConfiguredError);
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it('下载走 fetch 流式读：按 Content-Length 报进度，返回 Blob 与原始 Content-Disposition', async () => {
    fetchMock.mockResolvedValue(
      new Response('hello world', {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '11',
          'Content-Disposition': 'attachment; filename="a.txt"',
        },
      }),
    );
    const progress: Array<{ loaded: number; total: number | null }> = [];

    const result = await api.downloadFile('demo-01', '/home/acc-demo/a.txt', {
      onProgress: (event) => progress.push(event),
    });

    expect(await result.blob.text()).toBe('hello world');
    expect(result.contentDisposition).toBe('attachment; filename="a.txt"');
    expect(progress.at(-1)).toEqual({ loaded: 11, total: 11 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${DEFAULT_BACKEND_BASE_URL}/api/sandboxes/demo-01/files/download?path=${encodeURIComponent(
        '/home/acc-demo/a.txt',
      )}`,
    );
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer sbx_test');
  });

  it('进度回调抛错：先 cancel reader 释放连接，再抛原始错误', async () => {
    const cancel = vi.fn(async () => {});
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([1]) })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel,
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Length': '1' }),
      body: { getReader: () => reader },
    } as unknown as Response);

    await expect(
      api.downloadFile('demo-01', '/x', {
        onProgress: () => {
          throw new Error('进度回调炸了');
        },
      }),
    ).rejects.toThrow('进度回调炸了');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('下载失败：取后端 detail 原文', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: '文件不存在' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(api.downloadFile('demo-01', '/nope')).rejects.toMatchObject({
      name: 'ApiError',
      message: '文件不存在',
      status: 404,
    });
  });
});
