// @vitest-environment jsdom
/**
 * 桌面 IPC 桥（端口转发）的关键口径。
 *
 * - **invoke 的拒绝值可能是裸字符串**：Rust 侧命令返回 `Result<_, String>`，
 *   到了前端就是字符串（不是 `Error`）。不收口的话，调用方的
 *   `exc instanceof Error` 恒为假，Rust 侧的固定中文文案会被兜底文案顶掉。
 * - **事件订阅的 `target` 是对象**：Rust 侧的 `EventTarget` 是带标签的枚举
 *   （`#[serde(tag = "kind")]`），「任意目标」是 `{"kind":"Any"}`——
 *   传裸字符串 `"Any"` 会被反序列化拒掉（事件通道直接不通）。
 * - **订阅失败不静默**：降级时打一条 `console.warn`（别把「事件通道整体不通」
 *   这种问题藏死）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { listenForwardEvents, startForwardListener, toError } from './desktop-forward';

/** 注入桌面壳的 IPC 替身。 */
function injectRuntime(invoke: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: { invoke, transformCallback: (cb: (payload: unknown) => void) => cb as unknown as number },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe('invoke 的失败值收口', () => {
  it('裸字符串 → Error（message 是原文）', () => {
    const error = toError('本机端口 80 小于 1024，当前系统不允许普通用户绑定低端口');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('本机端口 80 小于 1024，当前系统不允许普通用户绑定低端口');
  });

  it('已经是 Error → 原样返回', () => {
    const original = new Error('原样返回');
    expect(toError(original)).toBe(original);
  });

  it('对象 → JSON 文本', () => {
    expect(toError({ code: 1008 }).message).toBe('{"code":1008}');
  });
});

describe('startForwardListener', () => {
  it('invoke 拒绝裸字符串 → 抛出的 Error 带着那段原文', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValue('本机端口 80 小于 1024，当前系统不允许普通用户绑定低端口');
    injectRuntime(invoke);

    await expect(
      startForwardListener({
        forwardId: 'abc123',
        backendBaseUrl: 'http://127.0.0.1:8000',
        token: 'sbx_test',
        containerPort: 8080,
        localPort: 80,
      }),
    ).rejects.toThrow('本机端口 80 小于 1024，当前系统不允许普通用户绑定低端口');
  });

  it('invoke 拒绝裸字符串 → 抛出的值确实是 Error（instanceof 成立）', async () => {
    const invoke = vi.fn().mockRejectedValue('令牌无效');
    injectRuntime(invoke);

    const error = await startForwardListener({
      forwardId: 'abc123',
      backendBaseUrl: 'http://127.0.0.1:8000',
      token: 'sbx_test',
      containerPort: 8080,
    }).catch((exc: unknown) => exc);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('令牌无效');
  });
});

describe('事件订阅', () => {
  it('target 传对象（{"kind":"Any"}），不是裸字符串', async () => {
    const invoke = vi.fn().mockResolvedValue(1);
    injectRuntime(invoke);

    await listenForwardEvents({});

    expect(invoke).toHaveBeenCalledTimes(2);
    const [, args] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.event).toBe('forward://state');
    expect(args.target).toEqual({ kind: 'Any' });
    const [, args2] = invoke.mock.calls[1] as [string, Record<string, unknown>];
    expect(args2.event).toBe('forward://connection');
    expect(args2.target).toEqual({ kind: 'Any' });
  });

  it('订阅失败 → 打降级标记（console.warn），不抛错', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const invoke = vi.fn().mockRejectedValue('not allowed by ACL');
    injectRuntime(invoke);

    const dispose = await listenForwardEvents({});

    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('core:event');
    // 降级也要能安全退订（空函数）。
    expect(() => dispose()).not.toThrow();
  });

  it('第二条订阅失败 → 第一条退掉，不留悬挂监听', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(11)
      .mockRejectedValueOnce('第二条失败')
      .mockResolvedValue(undefined);
    injectRuntime(invoke);

    await listenForwardEvents({});

    expect(invoke).toHaveBeenCalledWith('plugin:event|unlisten', {
      event: 'forward://state',
      eventId: 11,
    });
  });
});
