/**
 * 沙箱详情 + 转发记录的**合并轮询**（工作台里一拍刷两份数据）。
 *
 * 一拍 = 两个请求并行（详情 / 转发记录）。任一份读失败，这一拍就算失败；
 * **连续 3 次失败弹一条失败 toast**（口径与 `src/lib/poll.ts` 的失败计数一致），
 * 页面不可见时整拍跳过。
 *
 * 这里只放**纯函数**：一拍的结果怎么算失败、失败文案怎么拼。
 */

import { POLL_FAILURE_TOAST_THRESHOLD } from './poll';

/** 合并轮询的一拍结果。 */
export interface MergedPollResult {
  /** 沙箱详情读取失败原因（成功为 `null`）。 */
  detailError: string | null;
  /** 端口转发记录读取失败原因（成功为 `null`）。 */
  forwardsError: string | null;
}

/**
 * 这一拍算不算失败（**任一份数据读失败就算失败**）。
 *
 * **OR 语义是有意为之**：详情与转发记录是同一拍的整体数据，任一份读不到，
 * 这一拍拿到的就是半截数据（只刷到详情、转发记录还是旧的，或反过来）。
 * 拿半截数据继续算「这一拍成功」会让连续失败计数被稀释，界面上的旧数据
 * 会被当成新鲜的——所以**任一份失败即整拍失败**。
 *
 * 计数只统计「连续」：成功即清零（见 `nextPollFailure`）。
 */
export function mergedPollFailed(result: MergedPollResult): boolean {
  return result.detailError !== null || result.forwardsError !== null;
}

/**
 * 合并轮询连续失败时的失败文案。
 *
 * 两份数据分别报自己的原因（不另造说法）：后端 / 接口层给的原文直接跟上。
 *
 * **「（连续 N 次轮询）」放在冒号前**（与沙箱列表的口径同款：
 * 「读取沙箱列表失败（连续 3 次轮询）：X」）：失败原因原文跟在冒号后，
 * 连续次数挂在失败动作上，读起来是一句话。
 */
export function describeMergedPollFailure(result: MergedPollResult): string {
  const parts: string[] = [];
  if (result.detailError !== null) {
    parts.push(
      `读取沙箱详情失败（连续 ${POLL_FAILURE_TOAST_THRESHOLD} 次轮询）：${result.detailError}`,
    );
  }
  if (result.forwardsError !== null) {
    parts.push(
      `读取端口转发列表失败（连续 ${POLL_FAILURE_TOAST_THRESHOLD} 次轮询）：${result.forwardsError}`,
    );
  }
  if (parts.length === 0) {
    return '';
  }
  return parts.join('；');
}
