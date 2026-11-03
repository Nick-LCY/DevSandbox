/**
 * 终端尺寸自适应的去抖器。
 *
 * 背景：侧栏折叠 / 展开带 200 毫秒宽度过渡，过渡期间主列宽度**逐帧**变化，
 * 终端挂载盒的 `ResizeObserver` 也就逐帧触发；每帧都 fit + sendResize 会把
 * 一串尺寸帧逐个回打到 pty（服务端每收到一帧都要改一次伪终端窗口大小）。
 *
 * 口径：**尾沿去抖**——去抖窗口内的多次触发合并成**最后一次**（窗口过后只发
 * 一次 resize），窗口内不发送。这样一次宽度过渡只回打一帧尺寸。
 *
 * 定时器口可注入：单元测试里换一套假口，不必依赖真实时间。
 */

/** 定时器口（注入用，便于单测）。 */
export interface FitScheduler {
  setTimeout: (handler: () => void, delayMs: number) => number;
  clearTimeout: (handle: number) => void;
}

/** 默认定时器口：走 window。 */
const windowScheduler: FitScheduler = {
  setTimeout: (handler, delayMs) => window.setTimeout(handler, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

/** 一个去抖器。 */
export interface FitDebouncer {
  /** 记一次触发：窗口内的多次触发只保留最后一次。 */
  schedule: () => void;
  /** 立刻执行挂起的那次触发（并清掉挂起）。 */
  flush: () => void;
  /** 丢掉挂起的那次触发（组件卸载时用）。 */
  cancel: () => void;
}

/**
 * 造一个尾沿去抖器。
 *
 * @param delayMs  去抖窗口（毫秒）
 * @param run      窗口过后要跑的那一次（通常是一次 fit + sendResize）
 * @param scheduler 定时器口（默认走 window；单测注入假口）
 */
export function createFitDebouncer(
  delayMs: number,
  run: () => void,
  scheduler: FitScheduler = windowScheduler,
): FitDebouncer {
  let handle: number | null = null;
  let pending = false;

  return {
    schedule() {
      pending = true;
      if (handle !== null) {
        scheduler.clearTimeout(handle);
      }
      handle = scheduler.setTimeout(() => {
        handle = null;
        if (!pending) {
          return;
        }
        pending = false;
        run();
      }, delayMs);
    },
    flush() {
      if (handle !== null) {
        scheduler.clearTimeout(handle);
        handle = null;
      }
      if (!pending) {
        return;
      }
      pending = false;
      run();
    },
    cancel() {
      if (handle !== null) {
        scheduler.clearTimeout(handle);
        handle = null;
      }
      pending = false;
    },
  };
}
