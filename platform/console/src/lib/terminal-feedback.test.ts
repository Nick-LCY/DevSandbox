/**
 * 终端状态提示的口径与去重规则（纯函数单测）。
 *
 * 去重规则单独测：面板那边去重一旦失效，服务端反复推同一个错误帧
 * 就会把提示刷屏——而面板级用例曾经测不出来（mock 只上报一次状态）。
 */
import { describe, expect, it } from 'vitest';

import {
  claimFeedback,
  clearFeedback,
  createFeedbackLedger,
  feedbackForState,
  feedbackKey,
} from './terminal-feedback';

describe('feedbackForState', () => {
  it('会话失效与服务端告警：失败提示，文案用状态里的原文', () => {
    expect(feedbackForState({ status: 'invalid', message: '终端会话已失效' })).toEqual({
      kind: 'error',
      text: '终端会话已失效',
    });
    expect(feedbackForState({ status: 'warning', message: '容器内命令失败' })).toEqual({
      kind: 'error',
      text: '容器内命令失败',
    });
  });

  it('正常退出（退出码 0）：提示色，文案不带退出码', () => {
    expect(feedbackForState({ status: 'closed', message: '已退出', exitCode: 0 })).toEqual({
      kind: 'info',
      text: '终端会话已结束',
    });
  });

  it('异常退出（退出码非 0）：失败提示，文案带退出码', () => {
    expect(feedbackForState({ status: 'closed', message: '已退出', exitCode: 1 })).toEqual({
      kind: 'error',
      text: '终端会话异常结束（退出码 1）',
    });
  });

  it('异常退出但退出码未知：失败提示，文案说明退出码未知', () => {
    expect(feedbackForState({ status: 'closed', message: '已退出', exitCode: null })).toEqual({
      kind: 'error',
      text: '终端会话异常结束（退出码未知）',
    });
  });

  it('退避重连中：提示色，文案带退避秒数', () => {
    expect(
      feedbackForState({ status: 'reconnecting', message: '连接断开，4 秒后自动重连…', retryDelaySeconds: 4 }),
    ).toEqual({ kind: 'info', text: '连接断开，4 秒后自动重连…' });
  });

  it('连接中 / 已连接 / 没有退避秒数的重连中间态：不提示', () => {
    expect(feedbackForState({ status: 'connecting', message: '连接中' })).toBeNull();
    expect(feedbackForState({ status: 'connected', message: '已连接' })).toBeNull();
    expect(feedbackForState({ status: 'reconnecting', message: '连接断开' })).toBeNull();
  });
});

describe('feedbackKey', () => {
  it('同一个状态进同一个键（退避秒数进键，档位变了才换键）', () => {
    expect(feedbackKey({ status: 'failed', message: '重连失败' })).toBe('failed');
    expect(feedbackKey({ status: 'closed', message: 'x', exitCode: 1 })).toBe('closed:1');
    expect(feedbackKey({ status: 'closed', message: 'x', exitCode: null })).toBe('closed:unknown');
    expect(feedbackKey({ status: 'reconnecting', message: 'x', retryDelaySeconds: 4 })).toBe(
      'reconnecting:4',
    );
    expect(feedbackKey({ status: 'warning', message: '告警原文' })).toBe('warning:告警原文');
  });
});

describe('claimFeedback（去重登记表）', () => {
  it('同一会话的同一条键：只弹一次', () => {
    const ledger = createFeedbackLedger();

    expect(claimFeedback(ledger, 'sess-a', 'failed')).toBe(true);
    // 再来一次同样的状态：不许再弹。
    expect(claimFeedback(ledger, 'sess-a', 'failed')).toBe(false);
    expect(claimFeedback(ledger, 'sess-a', 'failed')).toBe(false);
  });

  it('不同会话互不影响', () => {
    const ledger = createFeedbackLedger();

    expect(claimFeedback(ledger, 'sess-a', 'failed')).toBe(true);
    expect(claimFeedback(ledger, 'sess-b', 'failed')).toBe(true);
  });

  it('同一会话的不同键：各弹一次', () => {
    const ledger = createFeedbackLedger();

    expect(claimFeedback(ledger, 'sess-a', 'failed')).toBe(true);
    expect(claimFeedback(ledger, 'sess-a', 'warning:别的告警')).toBe(true);
    expect(claimFeedback(ledger, 'sess-a', 'failed')).toBe(false);
  });

  it('连接恢复清掉记录后，下一轮失败能重新提示', () => {
    const ledger = createFeedbackLedger();

    expect(claimFeedback(ledger, 'sess-a', 'failed')).toBe(true);
    expect(claimFeedback(ledger, 'sess-a', 'failed')).toBe(false);

    clearFeedback(ledger, 'sess-a');

    expect(claimFeedback(ledger, 'sess-a', 'failed')).toBe(true);
  });

  it('清记录只影响那一个会话', () => {
    const ledger = createFeedbackLedger();

    claimFeedback(ledger, 'sess-a', 'failed');
    claimFeedback(ledger, 'sess-b', 'failed');

    clearFeedback(ledger, 'sess-a');

    expect(claimFeedback(ledger, 'sess-a', 'failed')).toBe(true);
    expect(claimFeedback(ledger, 'sess-b', 'failed')).toBe(false);
  });
});
