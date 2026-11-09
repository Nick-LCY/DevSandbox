// @vitest-environment jsdom
/**
 * 桌面下载落盘 IPC 桥（`desktop-file.ts`）的关键口径：
 *
 * - 保存框走 `plugin:dialog|save`，参数形状 `{ options: { defaultPath } }`，
 *   取消（null / 空串）→ `null`（调用方静默返回）；
 * - 下载命令的参数名按 Tauri 的 camelCase 约定；**后端基址与令牌从连接配置现取**
 *   （未配置时一个 IPC 都不发）；
 * - 事件名带沙箱作用域 + 下载标识（防串扰），`target` 是对象 `{"kind":"Any"}`；
 * - 失败值（裸字符串）一律收口成 `Error`（Rust 的固定中文文案要能到 toast）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionNotConfiguredError } from '../api/client';
import { cacheConnectionConfig } from './connection';
import {
  CANCELLED_MESSAGE,
  cancelDownload,
  downloadEventName,
  downloadEventScope,
  downloadToDisk,
  listenDownloadEvents,
  pickDownloadPath,
} from './desktop-file';

/** 注入桌面壳的 IPC 替身。 */
function injectRuntime(invoke: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: {
      invoke,
      transformCallback: (cb: (payload: unknown) => void) => cb as unknown as number,
    },
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  cacheConnectionConfig({
    backendBaseUrl: 'http://10.0.0.5:8000/',
    token: 'sbx_test',
  });
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe('保存框', () => {
  it('调 plugin:dialog|save，默认文件名 = 条目名，返回所选路径', async () => {
    const invoke = vi.fn().mockResolvedValue('C:\\Users\\me\\报告.txt');
    injectRuntime(invoke);

    await expect(pickDownloadPath('报告.txt')).resolves.toBe('C:\\Users\\me\\报告.txt');
    expect(invoke).toHaveBeenCalledWith('plugin:dialog|save', {
      options: { defaultPath: '报告.txt' },
    });
  });

  it('用户取消（null / 空串）→ null，不编造路径', async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    injectRuntime(invoke);
    await expect(pickDownloadPath('a.txt')).resolves.toBeNull();

    invoke.mockResolvedValue('   ');
    await expect(pickDownloadPath('a.txt')).resolves.toBeNull();
  });

  it('路径不做 trim：只有全空白才算取消', async () => {
    const invoke = vi.fn().mockResolvedValue('C:\\Users\\me\\ 带空格的名字 .txt ');
    injectRuntime(invoke);
    // 首尾空格可能是用户文件名的一部分，原样交给 Rust。
    await expect(pickDownloadPath('a.txt')).resolves.toBe(
      'C:\\Users\\me\\ 带空格的名字 .txt ',
    );
  });

  it('保存框失败（裸字符串）→ Error 带着原文', async () => {
    injectRuntime(vi.fn().mockRejectedValue('dialog 权限未放行'));
    const error = await pickDownloadPath('a.txt').catch((exc: unknown) => exc);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('dialog 权限未放行');
  });
});

describe('下载命令', () => {
  it('参数走 camelCase，基址与令牌来自连接配置', async () => {
    const invoke = vi.fn().mockResolvedValue({ target_path: 'C:\\out\\a.txt', bytes: 12 });
    injectRuntime(invoke);

    await expect(
      downloadToDisk({
        sandbox: 'demo-01',
        path: '/home/acc-demo/a.txt',
        targetPath: 'C:\\out\\a.txt',
        downloadId: 'dl-1',
      }),
    ).resolves.toEqual({ target_path: 'C:\\out\\a.txt', bytes: 12 });

    expect(invoke).toHaveBeenCalledWith('download_to_disk', {
      sandbox: 'demo-01',
      path: '/home/acc-demo/a.txt',
      targetPath: 'C:\\out\\a.txt',
      backendBaseUrl: 'http://10.0.0.5:8000',
      token: 'sbx_test',
      downloadId: 'dl-1',
    });
  });

  it('未配置（令牌为空）→ 一个 IPC 都不发', async () => {
    const invoke = vi.fn();
    injectRuntime(invoke);
    cacheConnectionConfig({ backendBaseUrl: 'http://10.0.0.5:8000', token: '' });

    const error = await downloadToDisk({
      sandbox: 'demo-01',
      path: '/a.txt',
      targetPath: 'C:\\a.txt',
      downloadId: 'dl-1',
    }).catch((exc: unknown) => exc);

    expect(error).toBeInstanceOf(ConnectionNotConfiguredError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('失败（裸字符串）→ Error（固定中文文案原样上来）', async () => {
    injectRuntime(vi.fn().mockRejectedValue('访问令牌无效，请检查连接配置'));
    const error = await downloadToDisk({
      sandbox: 'demo-01',
      path: '/a.txt',
      targetPath: 'C:\\a.txt',
      downloadId: 'dl-1',
    }).catch((exc: unknown) => exc);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('访问令牌无效，请检查连接配置');
  });

  it('取消命令带 downloadId，幂等（Rust 找不到标识不报错）', async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    injectRuntime(invoke);
    await cancelDownload('dl-9');
    expect(invoke).toHaveBeenCalledWith('cancel_download', { downloadId: 'dl-9' });
  });
});

describe('事件名与订阅', () => {
  it('取消文案与 Rust 侧一致，供面板静默收口', () => {
    expect(CANCELLED_MESSAGE).toBe('下载已取消');
  });

  it('沙箱作用域与 Rust 侧规则一致（只留 ASCII 字母数字与 - _）', () => {
    expect(downloadEventScope('demo-01')).toBe('demo-01');
    expect(downloadEventScope('my box.v2')).toBe('my_box_v2');
    expect(downloadEventScope('沙箱一')).toBe('___');
    // 星平面字符（这里用 emoji）按**一个字符**替换，与 Rust 的 `char` 口径一致。
    expect(downloadEventScope('a😀b')).toBe('a_b');
    expect(downloadEventName('my box', 'dl-1')).toBe('download://my_box/dl-1');
  });

  it('订阅：事件名带沙箱 + 下载标识，target 是对象；只收本次标识的载荷', async () => {
    const invoke = vi.fn().mockResolvedValue('evt-1');
    injectRuntime(invoke);

    const events: unknown[] = [];
    await listenDownloadEvents('demo-01', 'dl-1', (event) => events.push(event));

    expect(invoke).toHaveBeenCalledWith('plugin:event|listen', {
      event: 'download://demo-01/dl-1',
      target: { kind: 'Any' },
      handler: expect.any(Function),
    });

    const handler = (invoke.mock.calls[0][1] as { handler: (raw: unknown) => void }).handler;
    handler({
      payload: {
        download_id: 'dl-1',
        sandbox: 'demo-01',
        path: '/a.txt',
        phase: 'progress',
        loaded: 5,
        total: 10,
        message: '',
        target_path: null,
      },
    });
    handler({
      payload: {
        download_id: 'dl-2',
        sandbox: 'demo-01',
        path: '/b.txt',
        phase: 'progress',
        loaded: 5,
        total: 10,
        message: '',
        target_path: null,
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ download_id: 'dl-1', loaded: 5, total: 10 });
  });

  it('退订走 plugin:event|unlisten（同一条事件名 + eventId）', async () => {
    const invoke = vi.fn().mockResolvedValue('evt-1');
    injectRuntime(invoke);

    const off = await listenDownloadEvents('demo-01', 'dl-1', () => {});
    off();
    off();

    const unlistenCalls = invoke.mock.calls.filter(
      ([cmd]) => cmd === 'plugin:event|unlisten',
    );
    expect(unlistenCalls).toHaveLength(1);
    expect(unlistenCalls[0][1]).toEqual({ event: 'download://demo-01/dl-1', eventId: 'evt-1' });
  });

  it('订阅失败向上抛（调用方按「进度降级」处理，不拦死下载）', async () => {
    injectRuntime(vi.fn().mockRejectedValue('not allowed by ACL'));
    await expect(listenDownloadEvents('demo-01', 'dl-1', () => {})).rejects.toThrow(
      'not allowed by ACL',
    );
  });
});
