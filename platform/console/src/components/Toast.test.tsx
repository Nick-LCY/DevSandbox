// @vitest-environment jsdom
/**
 * 全局 toast 反馈的组件测试。
 *
 * 覆盖九件事：
 * - 类型 → 配色类名的映射（成功绿 / 失败红 / 提示蓝）；
 * - 5 秒后自动消失（假定时器）；
 * - 关闭键可以提前关闭；
 * - 关闭键外围的倒计时圆环：动画类名与时长都是 5 秒，与自动消失同步；
 * - 悬停 / 点视口 / 触摸按下都不许暂停倒计时（否则圆环画满但 toast 不消失）；
 * - 聚焦提示区不许暂停倒计时（Base UI 的聚焦处理必须被拦）；
 * - 按 F6 不许触发 Base UI 的 F6 接管（真机上它会把提示区聚焦并冻住倒计时）；
 * - 窗口失焦：倒计时停表、圆环停画；回前台：两者整体重走 5 秒；
 * - 新的反馈顶掉旧的：条目数恒为 1，旧计时被重置，倒计时圆环重新画满。
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TOAST_DURATION_MS, TOAST_RING_LENGTH, toastKindClass, type ToastKind } from '../lib/toast';
import { ToastProvider, useToast } from './Toast';

/** 触发按钮：把反馈接口暴露成可点的动作。 */
function Trigger({ kind, text }: { kind: ToastKind; text: string }) {
  const { show } = useToast();
  return (
    <button type="button" onClick={() => show(kind, text)}>
      触发反馈
    </button>
  );
}

/** 渲染带 Provider 的控制台片段。 */
function renderWithToast(kind: ToastKind, text: string): void {
  render(
    <ToastProvider>
      <Trigger kind={kind} text={text} />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: '触发反馈' }));
}

/** 提示区（右上角视口）。 */
function region(): HTMLElement {
  return screen.getByTestId('page-toast-region');
}

/** 圆环元素（倒计时动画挂在它身上）。 */
function ring(): SVGElement | null {
  return within(screen.getByTestId('page-toast-item')).getByTestId('page-toast-close').querySelector('circle');
}

/**
 * 派发窗口级失焦 / 回前台。
 *
 * 派发到 document 上（浏览器里窗口级焦点事件的目标是 window 或 document）：
 * 派发到 window 上会让 Base UI 的窗口处理器在 jsdom 里报
 * 「contains 的参数不是 Node」（jsdom 的 window 与 vitest 全局的 window 不是同一个对象）。
 */
function fireWindowBlur(): void {
  act(() => {
    document.dispatchEvent(new FocusEvent('blur'));
  });
}

function fireWindowFocus(): void {
  act(() => {
    document.dispatchEvent(new FocusEvent('focus'));
  });
}

/**
 * 手动派发一个带 `pointerType` 的 pointerdown。
 *
 * jsdom 没有实现 PointerEvent，`fireEvent.pointerDown` 造出来的事件不带
 * `pointerType` / `button`，Base UI 的处理器会直接走不到「暂停计时」那条分支，
 * 测不出真实行为。这里自己造事件并补上这两个字段。
 */
function firePointerDown(element: Element, pointerType: 'touch' | 'mouse'): void {
  const event = new MouseEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  act(() => {
    element.dispatchEvent(event);
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('toast 配色', () => {
  it('三种类型取各自的语义令牌配色（成功绿 / 失败红 / 提示蓝）', () => {
    expect(toastKindClass('success')).toContain('text-success');
    expect(toastKindClass('success')).toContain('bg-success-soft');
    expect(toastKindClass('success')).toContain('border-success/40');

    expect(toastKindClass('error')).toContain('text-destructive');
    expect(toastKindClass('error')).toContain('bg-destructive-soft');
    expect(toastKindClass('error')).toContain('border-destructive/40');

    expect(toastKindClass('info')).toContain('text-info');
    expect(toastKindClass('info')).toContain('bg-info-soft');
    expect(toastKindClass('info')).toContain('border-info/40');
  });

  it('toast 条目带上类型属性，样式类跟着类型走', () => {
    renderWithToast('error', '启动沙箱失败');

    const toast = screen.getByTestId('page-toast-item');
    expect(toast.getAttribute('data-toast-kind')).toBe('error');
    expect(toast.className).toContain('text-destructive');
    expect(toast.textContent).toContain('启动沙箱失败');
  });
});

describe('toast 生命周期', () => {
  it('5 秒后自动消失', async () => {
    vi.useFakeTimers();
    renderWithToast('success', '沙箱 demo 已启动');

    expect(screen.getByTestId('page-toast-item')).toBeTruthy();

    // 差 1 毫秒还在：不是提前消失。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOAST_DURATION_MS - 1);
    });
    expect(screen.getByTestId('page-toast-item')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.queryByTestId('page-toast-item')).toBeNull();
  });

  it('点关闭键：提前关掉', async () => {
    renderWithToast('info', '记录已不存在（可能已被删除）');

    const toast = screen.getByTestId('page-toast-item');
    fireEvent.click(within(toast).getByTestId('page-toast-close'));

    await waitFor(() => expect(screen.queryByTestId('page-toast-item')).toBeNull());
  });

  it('新的反馈顶掉上一条：同屏只留最新一条', async () => {
    const { rerender } = render(
      <ToastProvider>
        <Trigger kind="error" text="第一条" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '触发反馈' }));
    expect(screen.getByTestId('page-toast-item').textContent).toContain('第一条');

    // 换一条文案再点：新的反馈顶掉旧的，条目数恒为 1，文案换成新的。
    rerender(
      <ToastProvider>
        <Trigger kind="error" text="第二条" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '触发反馈' }));

    await waitFor(() => expect(screen.getAllByTestId('page-toast-item')).toHaveLength(1));
    expect(screen.getByTestId('page-toast-item').textContent).toContain('第二条');
    expect(screen.getByTestId('page-toast-item').textContent).not.toContain('第一条');
  });

  it('新的反馈重置计时：旧的 5 秒不算数', async () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <ToastProvider>
        <Trigger kind="info" text="第一条" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '触发反馈' }));

    // 第一条已经走了 3 秒。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByTestId('page-toast-item')).toBeTruthy();

    rerender(
      <ToastProvider>
        <Trigger kind="info" text="第二条" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '触发反馈' }));

    // 再走 2 秒：离第一条出现已经满 5 秒，但它被顶掉了，不能消失。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByTestId('page-toast-item')).toBeTruthy();
    expect(screen.getByTestId('page-toast-item').textContent).toContain('第二条');

    // 从第二条算起走满 5 秒：这时才消失。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.queryByTestId('page-toast-item')).toBeNull();
  });
});

describe('倒计时不被意外暂停', () => {
  it('鼠标悬停与移动：不暂停倒计时', async () => {
    vi.useFakeTimers();
    renderWithToast('info', '沙箱 demo 已停止');

    const region = screen.getByTestId('page-toast-region');
    fireEvent.mouseEnter(region);
    fireEvent.mouseMove(region);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOAST_DURATION_MS);
    });
    expect(screen.queryByTestId('page-toast-item')).toBeNull();
  });

  it('点提示区：不暂停倒计时', async () => {
    vi.useFakeTimers();
    renderWithToast('info', '沙箱 demo 已停止');

    fireEvent.click(screen.getByTestId('page-toast-region'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOAST_DURATION_MS);
    });
    expect(screen.queryByTestId('page-toast-item')).toBeNull();
  });

  it('触摸按下提示条：不暂停倒计时', async () => {
    vi.useFakeTimers();
    renderWithToast('info', '沙箱 demo 已停止');

    firePointerDown(screen.getByTestId('page-toast-item'), 'touch');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOAST_DURATION_MS);
    });
    expect(screen.queryByTestId('page-toast-item')).toBeNull();
  });

  it('鼠标按下提示条：不暂停倒计时，也不影响下一条反馈', async () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <ToastProvider>
        <Trigger kind="info" text="第一条" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '触发反馈' }));

    firePointerDown(screen.getByTestId('page-toast-item'), 'mouse');

    // 按下之后再来一条新的：它的倒计时必须照常走（不能被「悬停中」卡住）。
    rerender(
      <ToastProvider>
        <Trigger kind="info" text="第二条" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '触发反馈' }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOAST_DURATION_MS);
    });
    expect(screen.queryByTestId('page-toast-item')).toBeNull();
  });

  it('聚焦提示区：不暂停倒计时（Base UI 的聚焦处理被拦）', async () => {
    vi.useFakeTimers();
    renderWithToast('info', '沙箱 demo 已停止');

    // 真的把焦点落到提示区上（jsdom 的 focus 会派发 focus + focusin，
    // React 的 onFocus 走 focusin，所以必须用 focus() 而不是 fireEvent.focus）。
    act(() => {
      region().focus();
    });

    // Base UI 的聚焦处理会把提示区标记成「展开」（并按停倒计时）：
    // 被拦下时不该出现这个标记。
    expect(
      region().hasAttribute('data-expanded'),
      '提示区不该被 Base UI 标记为展开（它的聚焦处理必须被拦）',
    ).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOAST_DURATION_MS);
    });
    expect(screen.queryByTestId('page-toast-item')).toBeNull();
  });

  it('按 F6：Base UI 的 F6 接管被拦下，倒计时照常走完 5 秒', async () => {
    vi.useFakeTimers();
    renderWithToast('info', '沙箱 demo 已启动');

    // 真机场景：焦点在提示区之外（终端里、按钮上）时按 F6。
    // Base UI 会在 window 上接管 F6：把提示区聚焦（顺带把焦点从终端抢走）
    // 并按停倒计时——真机上表现为「圆环画满了，toast 还在」。
    fireEvent.keyDown(screen.getByRole('button', { name: '触发反馈' }), { key: 'F6' });

    expect(
      document.activeElement === region(),
      '提示区不该被 F6 聚焦（Base UI 的 F6 接管必须被拦）',
    ).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOAST_DURATION_MS);
    });
    expect(screen.queryByTestId('page-toast-item')).toBeNull();
  });
});

describe('窗口失焦与回前台', () => {
  it('失焦：倒计时停表、圆环停画', async () => {
    vi.useFakeTimers();
    renderWithToast('info', '沙箱 demo 已停止');

    fireWindowBlur();

    // 圆环跟着倒计时一起停画（否则失焦期间它会画满，与被冻住的计时器脱节）。
    expect(ring()?.style.animationPlayState).toBe('paused');

    // 停表：失焦期间到点也不消失。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOAST_DURATION_MS * 2);
    });
    expect(screen.queryByTestId('page-toast-item')).toBeTruthy();
  });

  it('回前台：圆环与倒计时整体重走 5 秒', async () => {
    vi.useFakeTimers();
    renderWithToast('info', '沙箱 demo 已停止');

    const first = ring();

    fireWindowBlur();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    fireWindowFocus();

    // 圆环重建：动画从头画满（不是接着上一次画）。
    const second = ring();
    expect(second, '圆环元素必须重建').not.toBe(first);
    expect(second?.style.animationPlayState).toBe('running');

    // 倒计时重走满 5 秒：差 100 毫秒还在，走满才消失。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOAST_DURATION_MS - 100);
    });
    expect(screen.queryByTestId('page-toast-item')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.queryByTestId('page-toast-item')).toBeNull();
  });

  it('失焦期间新弹的提示：回前台后同样重走 5 秒', async () => {
    vi.useFakeTimers();
    renderWithToast('info', '沙箱 demo 已停止');

    fireWindowBlur();

    // 失焦期间弹的新提示：圆环从一开始就是停画的。
    fireEvent.click(screen.getByRole('button', { name: '触发反馈' }));
    expect(ring()?.style.animationPlayState).toBe('paused');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOAST_DURATION_MS * 2);
    });
    expect(screen.queryByTestId('page-toast-item')).toBeTruthy();

    fireWindowFocus();
    expect(ring()?.style.animationPlayState).toBe('running');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOAST_DURATION_MS - 100);
    });
    expect(screen.queryByTestId('page-toast-item')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.queryByTestId('page-toast-item')).toBeNull();
  });
});

describe('倒计时圆环', () => {
  it('关闭键外围有圆环：动画类名与时长都是 5 秒', () => {
    renderWithToast('success', '沙箱 demo 已停止');

    const toast = screen.getByTestId('page-toast-item');
    const close = within(toast).getByTestId('page-toast-close');
    const ring = close.querySelector('circle');
    expect(ring, '关闭键上应该有倒计时圆环').toBeTruthy();
    expect(ring?.getAttribute('class')).toContain('animate-toast-countdown');
    // 圆环周长与 dasharray 一致：画一圈正好画满。
    expect(ring?.getAttribute('stroke-dasharray')).toBe(String(TOAST_RING_LENGTH));

    // 时长来自同一个常量，不在 CSS 里另写一份 5s。
    expect(TOAST_DURATION_MS).toBe(5000);
    const svg = close.querySelector('svg');
    expect(svg?.getAttribute('style')).toContain('--app-toast-duration: 5000ms');
  });

  it('反馈被顶替时：圆环元素重建，倒计时重新画满', async () => {
    const { rerender } = render(
      <ToastProvider>
        <Trigger kind="success" text="第一条" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '触发反馈' }));
    const first = within(screen.getByTestId('page-toast-item'))
      .getByTestId('page-toast-close')
      .querySelector('circle');

    rerender(
      <ToastProvider>
        <Trigger kind="success" text="第二条" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '触发反馈' }));

    await waitFor(() => expect(screen.getAllByTestId('page-toast-item')).toHaveLength(1));
    const second = within(screen.getByTestId('page-toast-item'))
      .getByTestId('page-toast-close')
      .querySelector('circle');
    // 圆环是新的 DOM 节点：CSS 动画从头画满，而不是停在画满的状态。
    expect(second === first, '圆环元素必须重建，否则停在画满的旧动画上').toBe(false);
    expect(second?.getAttribute('class')).toContain('animate-toast-countdown');
  });

  it('旧条还在退场就来新反馈：圆环照样重新画满', async () => {
    vi.useFakeTimers();
    // 让 jsdom 的元素「有动画」：Base UI 会等动画结束才摘掉退场中的 toast。
    // 真实浏览器里 toast 有退场过渡，旧条还在退场就来新反馈是常事；
    // jsdom 没有动画，toast 一进退场态就被摘掉，这个竞态复现不出来。
    Object.defineProperty(Element.prototype, 'getAnimations', {
      configurable: true,
      value: () => [
        {
          finished: new Promise(() => {}),
          effect: { getTiming: () => ({ duration: 150, iterations: 1 }) },
        },
      ],
    });
    try {
      const { rerender } = render(
        <ToastProvider>
          <Trigger kind="success" text="第一条" />
        </ToastProvider>,
      );
      fireEvent.click(screen.getByRole('button', { name: '触发反馈' }));
      const first = within(screen.getByTestId('page-toast-item'))
        .getByTestId('page-toast-close')
        .querySelector('circle');

      // 5 秒到：旧条进入退场态（还没被摘掉）。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TOAST_DURATION_MS);
      });
      expect(screen.getByTestId('page-toast-item').hasAttribute('data-ending-style')).toBe(true);

      // 退场途中来新反馈：旧条被顶掉，新条接手。
      rerender(
        <ToastProvider>
          <Trigger kind="success" text="第二条" />
        </ToastProvider>,
      );
      fireEvent.click(screen.getByRole('button', { name: '触发反馈' }));

      expect(screen.getAllByTestId('page-toast-item')).toHaveLength(1);
      const second = within(screen.getByTestId('page-toast-item'))
        .getByTestId('page-toast-close')
        .querySelector('circle');
      // 圆环必须重建：否则它停在「已画满」的旧动画上，画面与 5 秒倒计时立刻脱节。
      expect(second === first, '圆环元素必须重建，否则停在画满的旧动画上').toBe(false);
    } finally {
      // 先卸载：卸载会断开 Base UI 的属性观察器；之后再撤掉桩，不留悬空回调。
      cleanup();
      await act(async () => {
        await Promise.resolve();
      });
      delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
    }
  });
});
