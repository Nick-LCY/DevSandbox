/**
 * 连接配置的存取、基址推导与形态探测。
 *
 * 覆盖六类：
 * - 正常值往返（写入再读回一致）；
 * - 非法值回落默认（不是对象 / 字段类型不对 / JSON 坏掉）；
 * - 读取失败回落（存储句柄抛异常）；
 * - 存储不可用不抛异常（隐私模式：读回落默认、写静默忽略）；
 * - 基址推导（**基址恒非空**：空值归一为默认地址、尾部斜杠归一、补 scheme）；
 * - 形态探测（`window.__TAURI_INTERNALS__` 特性探测）与未配置判定。
 *
 * **决策 D：基址恒非空**——默认值 `http://127.0.0.1:8000`，允许编辑、不允许置空；
 * 「空 = 同源」语义废除（请求恒为绝对地址），未配置只看令牌（两种形态一个口径）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONNECTION_STORAGE_KEY,
  DEFAULT_BACKEND_BASE_URL,
  DEFAULT_CONNECTION_CONFIG,
  PENDING_CONNECTION_STORAGE_KEY,
  cacheConnectionConfig,
  clearPendingConnection,
  describeHealthFailure,
  effectiveBackendBaseUrl,
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

  it('存量配置里的空基址：读到时归一为默认地址', () => {
    // 决策 D 之前允许基址为空（同源）：那些存量数据读到时归一为默认地址，
    // 不会因为「存储里基址是空串」而连不上后端。
    const store = memoryStorage({
      [CONNECTION_STORAGE_KEY]: JSON.stringify({ backendBaseUrl: '', token: 'sbx_abc' }),
    });

    expect(readStoredConnection(store)).toEqual({
      backendBaseUrl: DEFAULT_BACKEND_BASE_URL,
      token: 'sbx_abc',
    });
    // 基址字段整个缺失：同样落回默认地址。
    expect(
      readStoredConnection(
        memoryStorage({ [CONNECTION_STORAGE_KEY]: JSON.stringify({ token: 'sbx_abc' }) }),
      ),
    ).toEqual({ backendBaseUrl: DEFAULT_BACKEND_BASE_URL, token: 'sbx_abc' });
  });

  it('默认配置与默认地址常量：基址恒非空', () => {
    expect(DEFAULT_BACKEND_BASE_URL).toBe('http://127.0.0.1:8000');
    expect(DEFAULT_CONNECTION_CONFIG).toEqual({
      backendBaseUrl: DEFAULT_BACKEND_BASE_URL,
      token: '',
    });
  });
});

describe('基址推导', () => {
  it('基址恒非空：空值归一为默认地址（不再是「同源」的空串）', () => {
    expect(resolveApiBaseUrl('')).toBe(DEFAULT_BACKEND_BASE_URL);
    expect(resolveApiBaseUrl('   ')).toBe(DEFAULT_BACKEND_BASE_URL);
    expect(normalizeBaseUrl('')).toBe(DEFAULT_BACKEND_BASE_URL);
  });

  it('尾部斜杠归一：基址后面直接拼 /api/... 不出双斜杠', () => {
    expect(resolveApiBaseUrl('http://127.0.0.1:8000/')).toBe('http://127.0.0.1:8000');
    expect(resolveApiBaseUrl('http://127.0.0.1:8000///')).toBe('http://127.0.0.1:8000');
    expect(normalizeBaseUrl('https://sandbox.example:8443/console/')).toBe(
      'https://sandbox.example:8443/console',
    );
  });

  it('没写 scheme 时按 http 补上', () => {
    expect(normalizeBaseUrl('127.0.0.1:8000')).toBe('http://127.0.0.1:8000');
    expect(normalizeBaseUrl('https://sandbox.example')).toBe('https://sandbox.example');
  });

  it('基址校验：空串非法（必填），非法地址给出中文原因', () => {
    expect(validateBaseUrl('')).toBe('请填写后端地址');
    expect(validateBaseUrl('   ')).toBe('请填写后端地址');
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

describe('两种形态在连接配置上不再有差别', () => {
  it('基址可填：填了就用，不会被形态收敛掉', () => {
    // 网页形态也能指向远端后端（不再强制同源）。
    cacheConnectionConfig({ backendBaseUrl: 'http://10.0.0.5:8000', token: 'sbx' });

    expect(getConnectionConfig()).toEqual({
      backendBaseUrl: 'http://10.0.0.5:8000',
      token: 'sbx',
    });
    expect(resolveApiBaseUrl(getConnectionConfig().backendBaseUrl)).toBe('http://10.0.0.5:8000');
  });

  it('基址为空：归一为默认地址（不再有「空 = 同源」）', () => {
    cacheConnectionConfig({ backendBaseUrl: '', token: 'sbx' });

    expect(getConnectionConfig()).toEqual({
      backendBaseUrl: DEFAULT_BACKEND_BASE_URL,
      token: 'sbx',
    });
    expect(resolveApiBaseUrl(getConnectionConfig().backendBaseUrl)).toBe(
      DEFAULT_BACKEND_BASE_URL,
    );
  });

  it('配置归一：基址补 scheme / 去尾部斜杠，令牌去空白', () => {
    cacheConnectionConfig({ backendBaseUrl: '10.0.0.5:8000/', token: ' sbx ' });

    expect(getConnectionConfig()).toEqual({
      backendBaseUrl: 'http://10.0.0.5:8000',
      token: 'sbx',
    });
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

  it('送出去的基址恒为「非空且已归一」：存量空基址归一为默认地址', async () => {
    // 决策 D 之前允许基址为空（同源）：那些存量数据归一为默认地址再送出去。
    // Rust 侧拿它 `Url::parse`——送空串会解析不出主机，CSP 静默拦死那台主机。
    const invoke = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(false);
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: 'h:1' },
      __TAURI_INTERNALS__: { invoke },
    });

    await expect(syncDesktopBackend('')).resolves.toBe('synced');
    expect(invoke.mock.calls[0][0]).toBe('set_backend_base_url');
    expect(invoke.mock.calls[0][1]).toEqual({ backendBaseUrl: 'http://127.0.0.1:8000' });
  });

  it('漏了 scheme 的基址：送出去的是补好 scheme 的地址', async () => {
    // 用户填 `10.0.0.5:8000`：原串送进 Rust 侧的 `Url::parse` 会解析失败 →
    // `connect-src` 少掉那台主机 → 跨主机请求全被 CSP 拦死（界面上看不出原因）。
    const invoke = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(false);
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: 'h:1' },
      __TAURI_INTERNALS__: { invoke },
    });

    await expect(syncDesktopBackend('10.0.0.5:8000')).resolves.toBe('synced');
    expect(invoke.mock.calls[0][1]).toEqual({ backendBaseUrl: 'http://10.0.0.5:8000' });
  });

  it('去重按归一值比较：写法不同但同一个基址只送一次', async () => {
    const invoke = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(false);
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: 'h:1' },
      __TAURI_INTERNALS__: { invoke },
    });

    await syncDesktopBackend('10.0.0.5:8000');
    await syncDesktopBackend('http://10.0.0.5:8000/');

    // 只有第一轮的两步（送基址 + 问要不要重载）。
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

  it('未配置判定：只看令牌（基址不参与，两种形态一个口径）', () => {
    expect(isConnectionConfigured({ backendBaseUrl: '', token: '' })).toBe(false);
    expect(isConnectionConfigured({ backendBaseUrl: 'http://h:1', token: '' })).toBe(false);
    // 基址恒有默认值，不影响「已配置」的判定。
    expect(isConnectionConfigured({ backendBaseUrl: '', token: 'sbx' })).toBe(true);
    expect(isConnectionConfigured({ backendBaseUrl: 'http://h:1', token: 'sbx' })).toBe(true);
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
