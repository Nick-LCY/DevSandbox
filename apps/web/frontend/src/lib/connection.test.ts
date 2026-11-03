/**
 * 连接配置的存取、基址推导与形态探测。
 *
 * 覆盖六类：
 * - 正常值往返（写入再读回一致）；
 * - 非法值回落默认（不是对象 / 字段类型不对 / JSON 坏掉）；
 * - 读取失败回落（存储句柄抛异常）；
 * - 存储不可用不抛异常（隐私模式：读回落默认、写静默忽略）；
 * - 基址推导（空基址 = 同源、尾部斜杠归一、补 scheme、ws/wss 映射）；
 * - 形态探测（`window.__TAURI_INTERNALS__` 特性探测）与未配置判定。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONNECTION_STORAGE_KEY,
  DEFAULT_CONNECTION_CONFIG,
  PENDING_CONNECTION_STORAGE_KEY,
  cacheConnectionConfig,
  clearPendingConnection,
  describeConnectionSource,
  describeHealthFailure,
  effectiveBackendBaseUrl,
  enforceRuntimeConfig,
  getConnectionConfig,
  isConnectionConfigured,
  isDesktopRuntime,
  normalizeBaseUrl,
  readPendingConnection,
  readStoredConnection,
  resetDesktopSyncState,
  resolveApiBaseUrl,
  setConnectionConfig,
  syncDesktopBackend,
  validateBaseUrl,
  writePendingConnection,
  writeStoredConnection,
} from './connection';

/** 一个内存里的 Storage 替身（可注入抛异常来模拟隐私模式）。 */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

/** 访问 localStorage 就抛异常的存储（隐私模式）。 */
function brokenStorage(): Storage {
  const boom = () => {
    throw new Error('storage unavailable');
  };
  return {
    get length(): number {
      return boom();
    },
    clear: boom,
    getItem: boom,
    key: boom,
    removeItem: boom,
    setItem: boom,
  };
}

afterEach(() => {
  // 内存缓存是模块级的：每个用例之间清掉，避免互相串味。
  cacheConnectionConfig({ ...DEFAULT_CONNECTION_CONFIG });
  resetDesktopSyncState();
  vi.unstubAllGlobals();
});

describe('连接配置的存取', () => {
  it('正常值往返：写入再读回一致', () => {
    const store = memoryStorage();
    writeStoredConnection({ backendBaseUrl: 'http://127.0.0.1:8000', token: 'sbx_abc' }, store);

    expect(readStoredConnection(store)).toEqual({
      backendBaseUrl: 'http://127.0.0.1:8000',
      token: 'sbx_abc',
    });
    // 存储键就是约定的那个。
    expect(store.getItem(CONNECTION_STORAGE_KEY)).toContain('sbx_abc');
  });

  it('非法值回落默认：不是对象 / 字段类型不对 / JSON 坏掉', () => {
    expect(readStoredConnection(memoryStorage({ [CONNECTION_STORAGE_KEY]: '"一个字符串"' }))).toEqual(
      DEFAULT_CONNECTION_CONFIG,
    );
    expect(readStoredConnection(memoryStorage({ [CONNECTION_STORAGE_KEY]: '[1,2]' }))).toEqual(
      DEFAULT_CONNECTION_CONFIG,
    );
    expect(
      readStoredConnection(
        memoryStorage({ [CONNECTION_STORAGE_KEY]: '{"backendBaseUrl":123,"token":true}' }),
      ),
    ).toEqual(DEFAULT_CONNECTION_CONFIG);
    expect(readStoredConnection(memoryStorage({ [CONNECTION_STORAGE_KEY]: '不是 JSON' }))).toEqual(
      DEFAULT_CONNECTION_CONFIG,
    );
  });

  it('读取失败回落默认：存储句柄抛异常', () => {
    expect(readStoredConnection(brokenStorage())).toEqual(DEFAULT_CONNECTION_CONFIG);
  });

  it('存储不可用不抛异常：读回落默认、写静默忽略', () => {
    expect(readStoredConnection(null)).toEqual(DEFAULT_CONNECTION_CONFIG);
    expect(() => writeStoredConnection({ backendBaseUrl: '', token: 'x' }, null)).not.toThrow();
    expect(() => writeStoredConnection({ backendBaseUrl: '', token: 'x' }, brokenStorage())).not.toThrow();
  });

  it('写的时候归一化：补 scheme、去尾部斜杠、令牌去空白', () => {
    const store = memoryStorage();
    writeStoredConnection({ backendBaseUrl: '127.0.0.1:8000/', token: '  sbx_abc  ' }, store);
    expect(readStoredConnection(store)).toEqual({
      backendBaseUrl: 'http://127.0.0.1:8000',
      token: 'sbx_abc',
    });
  });
});

describe('基址推导', () => {
  it('空基址 = 同源（返回空串，调用方拼相对路径）', () => {
    expect(resolveApiBaseUrl({ backendBaseUrl: '', token: 't' })).toBe('');
    expect(resolveApiBaseUrl({ backendBaseUrl: '   ', token: 't' })).toBe('');
  });

  it('尾部斜杠归一：基址后面直接拼 /api/... 不出双斜杠', () => {
    expect(resolveApiBaseUrl({ backendBaseUrl: 'http://127.0.0.1:8000/', token: 't' })).toBe(
      'http://127.0.0.1:8000',
    );
    expect(resolveApiBaseUrl({ backendBaseUrl: 'http://127.0.0.1:8000///', token: 't' })).toBe(
      'http://127.0.0.1:8000',
    );
    expect(normalizeBaseUrl('https://sandbox.example:8443/console/')).toBe(
      'https://sandbox.example:8443/console',
    );
  });

  it('没写 scheme 时按 http 补上', () => {
    expect(normalizeBaseUrl('127.0.0.1:8000')).toBe('http://127.0.0.1:8000');
    expect(normalizeBaseUrl('https://sandbox.example')).toBe('https://sandbox.example');
  });

  it('基址校验：空串合法，非法地址给出中文原因', () => {
    expect(validateBaseUrl('')).toBe('');
    expect(validateBaseUrl('http://127.0.0.1:8000')).toBe('');
    expect(validateBaseUrl('127.0.0.1:8000')).toBe('');
    expect(validateBaseUrl('ftp://host')).toContain('只支持 http 与 https');
    expect(validateBaseUrl('http://')).toContain('格式不对');
  });

  it('基址校验：带路径 / 参数 / 片段一律拒绝', () => {
    expect(validateBaseUrl('http://127.0.0.1:8000/console')).toBe(
      '后端地址不要带路径、参数或 #',
    );
    expect(validateBaseUrl('http://127.0.0.1:8000?token=x')).toBe(
      '后端地址不要带路径、参数或 #',
    );
    expect(validateBaseUrl('http://127.0.0.1:8000#frag')).toBe(
      '后端地址不要带路径、参数或 #',
    );
    // 根路径与根斜杠不算「带路径」：基址只到端口。
    expect(validateBaseUrl('http://127.0.0.1:8000/')).toBe('');
    expect(validateBaseUrl('https://sandbox.example')).toBe('');
  });
});

describe('按运行形态收敛配置', () => {
  it('web 形态：基址强制为空（同源），不只界面草稿层', () => {
    expect(
      enforceRuntimeConfig({ backendBaseUrl: 'http://10.0.0.5:8000', token: 'sbx' }, false),
    ).toEqual({ backendBaseUrl: '', token: 'sbx' });
  });

  it('桌面形态：基址保留并归一，令牌去空白', () => {
    expect(
      enforceRuntimeConfig({ backendBaseUrl: '10.0.0.5:8000/', token: ' sbx ' }, true),
    ).toEqual({ backendBaseUrl: 'http://10.0.0.5:8000', token: 'sbx' });
  });
});

describe('健康检查失败的原因文案', () => {
  it('401：令牌无效（带后端 detail 原文）', () => {
    const error = Object.assign(new Error('访问令牌无效或缺失'), { status: 401 });
    expect(describeHealthFailure(error)).toBe('令牌无效：访问令牌无效或缺失');
  });

  it('其它失败：后端不可达（与「令牌无效」不混）', () => {
    const error = Object.assign(new Error('无法连接后端服务'), { status: 0 });
    expect(describeHealthFailure(error)).toBe('后端不可达：无法连接后端服务');
  });

  it('说不清的失败：也有可读文案', () => {
    expect(describeHealthFailure(new Error('boom'))).toContain('后端不可达');
  });
});

describe('待验证配置（桌面形态首次配置）', () => {
  it('写入后能读回；读完清掉', () => {
    const store = memoryStorage();
    writePendingConnection({ backendBaseUrl: 'http://h:1', token: 'sbx' }, store);
    expect(readPendingConnection(store)).toEqual({
      backendBaseUrl: 'http://h:1',
      token: 'sbx',
    });
    expect(store.getItem(PENDING_CONNECTION_STORAGE_KEY)).toContain('sbx');
    clearPendingConnection(store);
    expect(readPendingConnection(store)).toBeNull();
  });

  it('没写 / 值非法 / 令牌为空：都当没有待验证配置', () => {
    expect(readPendingConnection(memoryStorage())).toBeNull();
    expect(
      readPendingConnection(memoryStorage({ [PENDING_CONNECTION_STORAGE_KEY]: '不是 JSON' })),
    ).toBeNull();
    expect(
      readPendingConnection(
        memoryStorage({ [PENDING_CONNECTION_STORAGE_KEY]: '{"token":"  "}' }),
      ),
    ).toBeNull();
  });

  it('这一轮要连的主机：待验证配置优先', () => {
    expect(
      effectiveBackendBaseUrl(
        { backendBaseUrl: 'http://old:1', token: 'sbx' },
        { backendBaseUrl: 'http://new:1', token: 'sbx' },
      ),
    ).toBe('http://new:1');
    expect(
      effectiveBackendBaseUrl({ backendBaseUrl: 'http://old:1', token: 'sbx' }, null),
    ).toBe('http://old:1');
  });
});

describe('桌面侧的动态 CSP 同步', () => {
  it('不是桌面形态：什么都不做', async () => {
    vi.stubGlobal('window', { location: { protocol: 'http:', host: 'h:1' } });
    await expect(syncDesktopBackend('http://h:1')).resolves.toBe('unavailable');
  });

  it('桌面形态：先送基址，再问要不要重载主文档', async () => {
    const invoke = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(false);
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: 'h:1' },
      __TAURI_INTERNALS__: { invoke },
    });

    await expect(syncDesktopBackend('http://10.0.0.5:8000')).resolves.toBe('synced');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0][0]).toBe('set_backend_base_url');
    expect(invoke.mock.calls[0][1]).toEqual({ backendBaseUrl: 'http://10.0.0.5:8000' });
    expect(invoke.mock.calls[1][0]).toBe('csp_needs_reload');
  });

  it('同一个基址只送一次（省掉重复 IPC）', async () => {
    const invoke = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(false);
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: 'h:1' },
      __TAURI_INTERNALS__: { invoke },
    });

    await syncDesktopBackend('http://10.0.0.5:8000');
    await syncDesktopBackend('http://10.0.0.5:8000');

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('桌面壳没有这些命令：静默忽略，不抛异常', async () => {
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: 'h:1' },
      __TAURI_INTERNALS__: {
        invoke: vi.fn().mockRejectedValue(new Error('unknown command')),
      },
    });

    await expect(syncDesktopBackend('http://h:1')).resolves.toBe('unavailable');
  });

  it('CSP 没跟上：重载主文档（顺序：先送基址，再问，最后才重载）', async () => {
    const reload = vi.fn();
    const invoke = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(true);
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: 'h:1', reload },
      __TAURI_INTERNALS__: { invoke },
    });

    await expect(syncDesktopBackend('http://10.0.0.5:8000')).resolves.toBe('reloading');
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      'set_backend_base_url',
      'csp_needs_reload',
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('形态探测与未配置判定', () => {
  it('不是桌面形态：window 上没有 __TAURI_INTERNALS__', () => {
    vi.stubGlobal('window', { location: { protocol: 'http:', host: 'h:1' } });
    expect(isDesktopRuntime()).toBe(false);
  });

  it('桌面形态：探测到 __TAURI_INTERNALS__', () => {
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: 'h:1' },
      __TAURI_INTERNALS__: { invoke: () => Promise.resolve() },
    });
    expect(isDesktopRuntime()).toBe(true);
  });

  it('未配置判定：令牌为空一律未配置', () => {
    expect(isConnectionConfigured({ backendBaseUrl: '', token: '' }, false)).toBe(false);
    expect(isConnectionConfigured({ backendBaseUrl: 'http://h:1', token: '' }, false)).toBe(false);
    expect(isConnectionConfigured({ backendBaseUrl: '', token: '' }, true)).toBe(false);
  });

  it('未配置判定：桌面形态下基址为空也算未配置，web 形态不看基址', () => {
    expect(isConnectionConfigured({ backendBaseUrl: '', token: 'sbx' }, true)).toBe(false);
    expect(isConnectionConfigured({ backendBaseUrl: '', token: 'sbx' }, false)).toBe(true);
    expect(isConnectionConfigured({ backendBaseUrl: 'http://h:1', token: 'sbx' }, true)).toBe(true);
  });

  it('形态说明文案：两种形态各有一句', () => {
    expect(describeConnectionSource(true)).toContain('桌面形态');
    expect(describeConnectionSource(false)).toContain('网页形态');
  });
});

describe('进程内配置缓存', () => {
  it('缓存优先于存储：存储读不到时仍能用内存里的配置', () => {
    cacheConnectionConfig({ backendBaseUrl: 'http://h:1', token: 'sbx' });
    expect(getConnectionConfig()).toEqual({ backendBaseUrl: 'http://h:1', token: 'sbx' });
  });

  it('保存配置：内存缓存与存储同时更新', () => {
    const store = memoryStorage();
    const original = globalThis.window;
    vi.stubGlobal('window', { ...original, localStorage: store });
    setConnectionConfig({ backendBaseUrl: 'http://h:1/', token: ' sbx ' });
    expect(getConnectionConfig()).toEqual({ backendBaseUrl: 'http://h:1', token: 'sbx' });
    expect(readStoredConnection(store)).toEqual({ backendBaseUrl: 'http://h:1', token: 'sbx' });
  });
});
