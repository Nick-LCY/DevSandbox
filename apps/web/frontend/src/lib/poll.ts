/**
 * 后台轮询的失败计数。
 *
 * 轮询失败的口径：**连续**失败到阈值才弹一条失败 toast，任一次成功即清零。
 *
 * 为什么不能逐次弹：沙箱列表 5 秒一轮、终端会话表 10 秒一轮，后端持续不可达时
 * 会一直失败，逐次弹就是刷屏。为什么不能一直不弹：侧栏底部的健康自检只兜得住
 * 「后端整体不可达」，端点级失败（列表接口 500）它兜不住，必须另有提示。
 */

/** 后台轮询连续失败多少次弹一条失败 toast。 */
export const POLL_FAILURE_TOAST_THRESHOLD = 3;

/** 计数器的下一步。 */
export interface PollFailureStep {
  /** 新的连续失败次数（成功或弹过一条后都归零）。 */
  count: number;
  /** 这一步要不要弹失败 toast。 */
  shouldToast: boolean;
}

/**
 * 推进一次轮询失败计数。
 *
 * @param count 当前的连续失败次数
 * @param ok 本轮轮询是否成功
 */
export function nextPollFailure(count: number, ok: boolean): PollFailureStep {
  if (ok) {
    // 成功即清零：计数只统计「连续」。
    return { count: 0, shouldToast: false };
  }
  const next = count + 1;
  if (next >= POLL_FAILURE_TOAST_THRESHOLD) {
    // 到阈值弹一条，然后归零：下一轮连续失败又是 3 次才弹。
    return { count: 0, shouldToast: true };
  }
  return { count: next, shouldToast: false };
}
