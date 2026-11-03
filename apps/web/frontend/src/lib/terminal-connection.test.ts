/**
 * 终端连接的失败策略：取票失败分类、要不要继续重连、退避节奏、提示文案与去重。
 *
 * 纯逻辑（`src/lib/terminal-connection.ts`），每条口径单独钉死。
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_RECONNECT_FAILURES,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  classifyTicketFailure,
  reconnectDelayMs,
  stopsAutoReconnect,
  ticketFailureStatusText,
  ticketFailureToastKey,
  unauthorizedStatusText,
} from './terminal-connection';

/** 造一个带 HTTP 状态码的错误（接口层的 ApiError 就是这个形状）。 */
function apiError(status: number, message: string): Error {
  const error = new Error(message);
  Object.assign(error, { name: 'ApiError', status });
  return error;
}

describe('取票失败分类', () => {
  it('401 / 403：令牌无效', () => {
    const failure = classifyTicketFailure(apiError(401, '访问令牌无效或缺失'));
    expect(failure.kind).toBe('unauthorized');
    expect(failure.message).toBe('访问令牌无效或缺失');
  });

  it('没配令牌（未配置连接）：也算令牌无效', () => {
    const error = new Error('尚未配置后端连接：请先填写访问令牌');
    error.name = 'ConnectionNotConfiguredError';
    const failure = classifyTicketFailure(error);
    expect(failure.kind).toBe('unauthorized');
  });

  it('网络不可达（状态码 0）：后端不可达', () => {
    const failure = classifyTicketFailure(apiError(0, '无法连接后端服务，请确认控制台服务已启动'));
    expect(failure.kind).toBe('unreachable');
    expect(failure.message).toContain('无法连接后端服务');
  });

  it('后端 500：未知失败（仍可重试）', () => {
    const failure = classifyTicketFailure(apiError(500, '内部错误'));
    expect(failure.kind).toBe('unknown');
  });

  it('说不清的异常：按后端不可达处理，不丢原因', () => {
    const failure = classifyTicketFailure(new Error('boom'));
    expect(failure.kind).toBe('unreachable');
    expect(failure.message).toBe('boom');
  });

  it('不是异常对象：也给出可读的原因', () => {
    const failure = classifyTicketFailure(undefined);
    expect(failure.kind).toBe('unreachable');
    expect(failure.message).toContain('无法连接后端服务');
  });
});

describe('要不要继续自动重连', () => {
  it('令牌无效：停（重试多少次都是 401）', () => {
    expect(stopsAutoReconnect({ kind: 'unauthorized', message: '访问令牌无效或缺失' })).toBe(
      true,
    );
  });

  it('后端不可达 / 未知失败：继续退避重试', () => {
    expect(stopsAutoReconnect({ kind: 'unreachable', message: 'x' })).toBe(false);
    expect(stopsAutoReconnect({ kind: 'unknown', message: 'x' })).toBe(false);
  });
});

describe('重连退避节奏', () => {
  it('指数退避，封顶 8 秒', () => {
    expect(reconnectDelayMs(1)).toBe(RECONNECT_BASE_DELAY_MS);
    expect(reconnectDelayMs(2)).toBe(1000);
    expect(reconnectDelayMs(3)).toBe(2000);
    expect(reconnectDelayMs(10)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(reconnectDelayMs(99)).toBe(RECONNECT_MAX_DELAY_MS);
  });

  it('连续失败上限是 10 次', () => {
    expect(MAX_RECONNECT_FAILURES).toBe(10);
  });
});

describe('状态与提示文案', () => {
  it('取票失败：状态文案单列（不说「连接断开」）', () => {
    const text = ticketFailureStatusText({ kind: 'unreachable', message: '无法连接后端服务' }, 3);
    expect(text).toContain('取不到终端票据');
    expect(text).toContain('无法连接后端服务');
    expect(text).toContain('3 秒后自动重连');
    expect(text).not.toContain('连接断开');
  });

  it('令牌无效：状态文案指向设置抽屉', () => {
    const text = unauthorizedStatusText({ kind: 'unauthorized', message: '访问令牌无效或缺失' });
    expect(text).toContain('令牌无效');
    expect(text).toContain('访问令牌无效或缺失');
    expect(text).toContain('设置抽屉');
  });

  it('提示去重键：同一句同一个键，不同原因不同键', () => {
    const a = ticketFailureToastKey({ kind: 'unreachable', message: '无法连接后端服务' });
    const b = ticketFailureToastKey({ kind: 'unreachable', message: '无法连接后端服务' });
    const c = ticketFailureToastKey({ kind: 'unauthorized', message: '无法连接后端服务' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
