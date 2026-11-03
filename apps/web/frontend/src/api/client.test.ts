/**
 * 接口层：请求基址拼接、`Authorization` 头、票据获取与「未配置不发请求」。
 *
 * 这是连接层的硬要求所在：每个请求都带 Bearer；令牌缺失时一个请求都不发。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheConnectionConfig, setConnectionConfig } from '../lib/connection';
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
  // 默认：同源 + 有令牌。
  setConnectionConfig({ backendBaseUrl: '', token: 'sbx_test' });
});

afterEach(() => {
  cacheConnectionConfig({ backendBaseUrl: '', token: '' });
  vi.unstubAllGlobals();
});

describe('请求基址与凭据', () => {
  it('每个请求都带 Authorization: Bearer <token>', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    await api.listSandboxes();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/sandboxes');
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer sbx_test');
  });

  it('基址为空 = 同源：请求走相对路径', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    await api.health();

    expect(fetchMock.mock.calls[0][0]).toBe('/api/health');
  });

  it('基址非空：请求走绝对地址（连远端后端）', async () => {
    setConnectionConfig({ backendBaseUrl: 'http://10.0.0.5:8000', token: 'sbx_test' });
    fetchMock.mockResolvedValue(jsonResponse({ version: '0.2.0', console_mounted: true }));

    await api.health();

    expect(fetchMock.mock.calls[0][0]).toBe('http://10.0.0.5:8000/api/health');
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer sbx_test');
  });

  it('基址可配：网页形态填了远端地址也走绝对地址（两种形态一个口径）', async () => {
    // 连接层不再按形态收敛：网页端也能指向远端后端。
    setConnectionConfig({ backendBaseUrl: 'https://sandbox.example:8443', token: 'sbx_test' });
    fetchMock.mockResolvedValue(jsonResponse({ version: '0.2.0', console_mounted: true }));

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
    expect(url).toBe('/api/auth/ticket');
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
