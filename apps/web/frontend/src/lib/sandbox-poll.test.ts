/**
 * 沙箱详情 + 转发记录的**合并轮询**纯逻辑单测。
 *
 * 覆盖两条口径：
 * - **一拍两份数据**：任一份读失败，这一拍就算失败（连续计数只统计「连续」）；
 * - **失败文案**：两份数据分别报自己的原因，「（连续 3 次轮询）」放在冒号前
 *   （口径与沙箱列表同款：「读取沙箱详情失败（连续 3 次轮询）：X」）。
 */

import { describe, expect, it } from 'vitest';

import { describeMergedPollFailure, mergedPollFailed } from './sandbox-poll';

describe('合并轮询的一拍结果', () => {
  it('两份都成功：这一拍不算失败', () => {
    expect(mergedPollFailed({ detailError: null, forwardsError: null })).toBe(false);
  });

  it('任一份失败：这一拍就算失败', () => {
    expect(mergedPollFailed({ detailError: '读取沙箱详情失败', forwardsError: null })).toBe(true);
    expect(mergedPollFailed({ detailError: null, forwardsError: '读取端口转发列表失败' })).toBe(true);
  });
});

describe('合并轮询的失败文案', () => {
  it('详情失败：说清是详情读取失败，「（连续 N 次轮询）」放在冒号前', () => {
    const text = describeMergedPollFailure({
      detailError: '后端不可达',
      forwardsError: null,
    });
    expect(text).toContain('读取沙箱详情失败');
    expect(text).toContain('后端不可达');
    expect(text).toContain('连续 3 次轮询');
    // 口径与沙箱列表同款：「…失败（连续 3 次轮询）：原因」。
    expect(text).toBe('读取沙箱详情失败（连续 3 次轮询）：后端不可达');
  });

  it('转发记录失败：说清是转发列表读取失败，「（连续 N 次轮询）」放在冒号前', () => {
    const text = describeMergedPollFailure({
      detailError: null,
      forwardsError: '后端不可达',
    });
    expect(text).toContain('读取端口转发列表失败');
    expect(text).toContain('连续 3 次轮询');
    expect(text).toBe('读取端口转发列表失败（连续 3 次轮询）：后端不可达');
  });

  it('两份都失败：两条原因都报（各自带连续次数）', () => {
    const text = describeMergedPollFailure({
      detailError: '详情原因',
      forwardsError: '转发原因',
    });
    expect(text).toContain('详情原因');
    expect(text).toContain('转发原因');
    expect(text).toBe(
      '读取沙箱详情失败（连续 3 次轮询）：详情原因；读取端口转发列表失败（连续 3 次轮询）：转发原因',
    );
  });

  it('没失败：没有文案', () => {
    expect(describeMergedPollFailure({ detailError: null, forwardsError: null })).toBe('');
  });
});
