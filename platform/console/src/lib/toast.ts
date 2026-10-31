/**
 * 全局操作反馈（toast）的类型与配色口径。
 *
 * 三种类型：成功（品牌绿）/ 失败（红）/ 提示（蓝）。
 * 颜色一律走语义令牌（`--app-success` / `--app-destructive` / `--app-info`
 * 及其 soft 底色），组件里不写裸色值。
 */

/** 反馈类型。 */
export type ToastKind = 'success' | 'error' | 'info';

/**
 * toast 自动消失的时长（毫秒）。
 *
 * 倒计时圆环的动画时长必须与它一致：圆环画满即 toast 消失。
 * 圆环的时长由组件把这个值写进 CSS 变量，不在 CSS 里另写一份 5s。
 */
export const TOAST_DURATION_MS = 5000;

/** 倒计时圆环的半径（SVG 用户单位）。 */
export const TOAST_RING_RADIUS = 11;

/** 倒计时圆环的周长：`stroke-dasharray` 与 `stroke-dashoffset` 都用它。 */
export const TOAST_RING_LENGTH = Number((2 * Math.PI * TOAST_RING_RADIUS).toFixed(3));

/**
 * 按反馈类型选 toast 的配色类名。
 *
 * 类名是字面量 Tailwind 串：Tailwind 的内容扫描靠源码里的完整类名，
 * 拼接出来的类名扫不到，样式会整个丢掉。
 */
export function toastKindClass(kind: ToastKind): string {
  switch (kind) {
    case 'success':
      return 'border-success/40 bg-success-soft text-success';
    case 'error':
      return 'border-destructive/40 bg-destructive-soft text-destructive';
    case 'info':
      return 'border-info/40 bg-info-soft text-info';
    default:
      return 'border-info/40 bg-info-soft text-info';
  }
}
