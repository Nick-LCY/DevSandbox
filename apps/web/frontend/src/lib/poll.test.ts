/**
 * 后台轮询失败计数的单元测试。
 *
 * 口径：连续失败到 3 次弹一条失败 toast，任一次成功即清零。
 */

import { describe, expect, it } from 'vitest';

import { POLL_FAILURE_TOAST_THRESHOLD, nextPollFailure } from './poll';

describe('轮询失败计数', () => {
  it('前两次连续失败：不弹', () => {
    const first = nextPollFailure(0, false);
    expect(first).toEqual({ count: 1, shouldToast: false });

    const second = nextPollFailure(first.count, false);
    expect(second).toEqual({ count: 2, shouldToast: false });
  });

  it('连续失败到阈值：弹一条并归零', () => {
    const step = nextPollFailure(POLL_FAILURE_TOAST_THRESHOLD - 1, false);
    expect(step.shouldToast).toBe(true);
    expect(step.count).toBe(0);
  });

  it('成功即清零', () => {
    expect(nextPollFailure(2, true)).toEqual({ count: 0, shouldToast: false });
  });

  it('中途成功一次：连续计数从头来', () => {
    let count = 0;
    count = nextPollFailure(count, false).count;
    count = nextPollFailure(count, false).count;
    expect(count).toBe(2);
    // 中间成功一次：计数清零。
    count = nextPollFailure(count, true).count;
    expect(count).toBe(0);
    // 再失败两次不到阈值。
    count = nextPollFailure(count, false).count;
    count = nextPollFailure(count, false).count;
    expect(count).toBe(2);
  });
});
