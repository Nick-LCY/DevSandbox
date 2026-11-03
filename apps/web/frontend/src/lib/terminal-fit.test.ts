/**
 * 终端尺寸自适应去抖器的单元测试。
 *
 * 口径：尾沿去抖——去抖窗口内的多次触发合并成**最后一次**（窗口过后只跑
 * 一次）。这是「侧栏宽度过渡期间不逐帧回打 pty 尺寸」的保证。
 */

import { describe, expect, it, vi } from 'vitest';

import { createFitDebouncer, type FitScheduler } from './terminal-fit';

/** 一套假定时器口：手动推进时间，不依赖真实时间。 */
function fakeScheduler(): { scheduler: FitScheduler; advance: () => void } {
  const tasks = new Map<number, () => void>();
  let seq = 0;
  return {
    scheduler: {
      setTimeout: (handler) => {
        seq += 1;
        tasks.set(seq, handler);
        return seq;
      },
      clearTimeout: (handle) => {
        tasks.delete(handle);
      },
    },
    advance: () => {
      const pending = [...tasks.entries()];
      tasks.clear();
      for (const [, handler] of pending) {
        handler();
      }
    },
  };
}

describe('终端尺寸自适应去抖', () => {
  it('窗口内连续触发多次：只跑一次（只发一次 resize）', () => {
    const { scheduler, advance } = fakeScheduler();
    const run = vi.fn();
    const debouncer = createFitDebouncer(100, run, scheduler);

    // 模拟侧栏宽度过渡期间 ResizeObserver 逐帧触发
    debouncer.schedule();
    debouncer.schedule();
    debouncer.schedule();

    advance();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('窗口过后再触发：各跑一次', () => {
    const { scheduler, advance } = fakeScheduler();
    const run = vi.fn();
    const debouncer = createFitDebouncer(100, run, scheduler);

    debouncer.schedule();
    advance();
    expect(run).toHaveBeenCalledTimes(1);

    debouncer.schedule();
    advance();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('cancel 之后挂起的那次不跑', () => {
    const { scheduler, advance } = fakeScheduler();
    const run = vi.fn();
    const debouncer = createFitDebouncer(100, run, scheduler);

    debouncer.schedule();
    debouncer.cancel();
    advance();

    expect(run).not.toHaveBeenCalled();
  });

  it('flush：立刻跑掉挂起的那次，且不再重复', () => {
    const { scheduler, advance } = fakeScheduler();
    const run = vi.fn();
    const debouncer = createFitDebouncer(100, run, scheduler);

    debouncer.schedule();
    debouncer.flush();
    expect(run).toHaveBeenCalledTimes(1);

    advance();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('没有挂起时 flush 不跑', () => {
    const { scheduler } = fakeScheduler();
    const run = vi.fn();
    const debouncer = createFitDebouncer(100, run, scheduler);

    debouncer.flush();

    expect(run).not.toHaveBeenCalled();
  });
});
