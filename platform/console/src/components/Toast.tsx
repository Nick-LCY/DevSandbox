/**
 * 全局操作反馈（toast）。
 *
 * 一条操作结果 = 右上角一条 toast：成功绿、失败红、提示蓝；
 * 出现 5 秒后自然消失，关闭键周围有与之一致的倒计时圆环。
 *
 * 底座是 Base UI 自带的 Toast 原语（不引第二套组件库）：
 * - Provider 负责队列与结构（**自动关闭置 0**：倒计时由本层自己的计时器管）；
 * - Portal + Viewport 负责挂到 body 右上角；
 * - Root / Title / Close 负责单条 toast 的结构。
 *
 * 同一时刻只显示最新一条：新的操作结果直接顶掉上一条，
 * 轮询失败也不会在屏幕上刷出一排重复提示。
 *
 * 倒计时口径（铁律：圆环画满与 toast 消失严格同步）：
 * - **一份计时**：圆环的 CSS 动画与 toast 的消失都由本层的同一个计时器驱动，
 *   不会各走各的（Base UI 自带计时 + 自绘圆环会脱节，故它的自动关闭被关掉）。
 * - **窗口失焦**：倒计时停表、圆环停画（唯一允许的例外）；
 *   回前台时整条重走 5 秒（圆环重画 + 计时器重走）。
 * - **悬停 / 聚焦 / 点提示区 / 触摸按下**：都不暂停（Base UI 默认会暂停，逐条拦掉）。
 * - **F6**：Base UI 会在 window 上接管 F6（聚焦提示区 + 暂停倒计时），这里掐掉。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { Toast as ToastPrimitive } from '@base-ui/react/toast';
import type { ToastObject } from '@base-ui/react/toast';
import { CircleCheck, CircleX, Info, X } from 'lucide-react';

import { cn } from '../lib/cn';
import {
  TOAST_DURATION_MS,
  TOAST_RING_LENGTH,
  TOAST_RING_RADIUS,
  toastKindClass,
  type ToastKind,
} from '../lib/toast';

/** 弹一条 toast 时的可选附加信息。 */
export interface ToastOptions {
  /**
   * 反馈来源标记（可选）。
   *
   * 同一页面上可能先后出现多条失败提示，端到端脚本靠它把「本用例关心的那条」
   * 与「前一步残留的无关那条」区分开（例如 `sandbox-detail`）。
   */
  source?: string;
}

/** 全局反馈接口。 */
export interface ToastApi {
  /** 弹一条操作结果反馈（同一时刻只留最新一条）。 */
  show: (kind: ToastKind, text: string, options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * 取全局反馈接口。
 *
 * 必须在 `ToastProvider` 内使用（Provider 挂在应用入口）。
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) {
    throw new Error('useToast 必须在 ToastProvider 内使用');
  }
  return api;
}

/** toast 的固定标识：同一时刻只留一条，新的反馈顶掉旧的。 */
const TOAST_ID = 'console-toast';

/** toast 的附加数据。 */
interface ToastData {
  kind: ToastKind;
  /**
   * 代次：每次 `show` 自增，**只增不减**。
   *
   * 倒计时圆环拿它当 React `key`：反馈被顶替时（哪怕旧条还在退场动画里），
   * 圆环元素一定被重建，动画重新画满，与重置后的 5 秒计时严格对齐。
   * （Base UI 自带的 `updateKey` 在退场竞态下会归零，不能当动画重启键用。）
   */
  generation: number;
  /** 反馈来源标记（可选）。 */
  source?: string;
}

/** 拦住 Base UI 的默认处理：悬停 / 聚焦 / 点视口时不暂停自动消失。 */
function keepAutoDismiss(event: SyntheticEvent & { preventBaseUIHandler?: () => void }): void {
  event.preventBaseUIHandler?.();
}

/**
 * 这个焦点事件是不是「窗口级」的？
 *
 * 窗口失焦 / 回前台时浏览器把事件派发到 window（或 document）上；
 * 元素之间的焦点切换派发到元素上——那种事件也会冒泡到 window，
 * 不能当成「窗口回前台」（否则点一下按钮就会把倒计时重走一遍）。
 *
 * 判据用 nodeType（元素 = 1，文档 = 9，window 没有 nodeType），
 * 不依赖 `instanceof`：不同环境里 window 的构造器不一定同一个。
 */
function isWindowLevelFocusEvent(event: FocusEvent): boolean {
  const target = event.target as (EventTarget & { nodeType?: number }) | null;
  if (!target) {
    return false;
  }
  return target.nodeType !== 1;
}

/**
 * 全局反馈的 Provider。
 *
 * 挂在应用入口（`src/App.tsx`），整站只有这一个。
 *
 * `timeout={0}`：关掉 Base UI 自带的自动消失。它的计时器与本层自绘的圆环
 * 各走各的（失焦恢复语义还不一样：实测「失焦前就在的」按剩余时间恢复，
 * 「失焦期间新弹的」按满值 5 秒恢复），两者一脱节就会出现「圆环画满但
 * toast 不消失」。倒计时统一交给本层的计时器，圆环与消失共用一份时间。
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <ToastPrimitive.Provider timeout={0}>
      <ToastLayer>{children}</ToastLayer>
    </ToastPrimitive.Provider>
  );
}

function ToastLayer({ children }: { children: ReactNode }) {
  const { toasts, add, close } = ToastPrimitive.useToastManager<ToastData>();
  /** 代次计数器：只增不减，圆环靠它重启动画。 */
  const generationRef = useRef(0);
  /** 屏幕上的提示条：回前台时要用它把当前这条的倒计时整体重走一遍。 */
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;
  /** 窗口是否在前台：失焦时倒计时停表、圆环停画。 */
  const windowFocusedRef = useRef(true);
  const [windowFocused, setWindowFocused] = useState(true);
  /** 倒计时计时器句柄（null = 没在走表）。 */
  const countdownRef = useRef<number | null>(null);

  /** 停表。 */
  const stopCountdown = useCallback(() => {
    if (countdownRef.current !== null) {
      window.clearTimeout(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  /**
   * 重新起表：满值 5 秒。
   *
   * 窗口失焦时不起表——失焦期间到点的提示条要等回前台再整体重走。
   */
  const startCountdown = useCallback(() => {
    stopCountdown();
    if (!windowFocusedRef.current) {
      return;
    }
    countdownRef.current = window.setTimeout(() => {
      countdownRef.current = null;
      close(TOAST_ID);
    }, TOAST_DURATION_MS);
  }, [close, stopCountdown]);

  const show = useCallback(
    (kind: ToastKind, text: string, options?: ToastOptions) => {
      generationRef.current += 1;
      // 固定标识：新的反馈顶掉上一条（轮询失败不刷屏），计时器随之重置。
      add({
        id: TOAST_ID,
        type: kind,
        title: text,
        data: { kind, generation: generationRef.current, source: options?.source },
      });
      startCountdown();
    },
    [add, startCountdown],
  );

  // 窗口失焦 / 回前台：倒计时与圆环一起停、一起重走。
  useEffect(() => {
    /**
     * 窗口失焦：停表 + 圆环停画。
     *
     * 只认「窗口级」的 blur：元素之间的焦点切换冒泡上来时目标是元素，
     * 不能当成失焦（Base UI 自己也是这么分的）。
     */
    const onBlur = (event: FocusEvent) => {
      if (!isWindowLevelFocusEvent(event)) {
        return;
      }
      windowFocusedRef.current = false;
      setWindowFocused(false);
      stopCountdown();
    };

    /**
     * 回到前台：当前这条提示的倒计时整体重走 5 秒。
     *
     * 圆环重画（代次 +1 → 圆环元素重建，动画从头画满）与计时器重走
     * （重新起表，满值 5 秒）必须同时发生，否则又会出现「圆环画满但
     * toast 不消失」或反过来。
     */
    const onFocus = (event: FocusEvent) => {
      // 元素之间的焦点切换不是「窗口回前台」。
      if (!isWindowLevelFocusEvent(event)) {
        return;
      }
      windowFocusedRef.current = true;
      setWindowFocused(true);
      const current = toastsRef.current[0];
      if (!current) {
        return;
      }
      generationRef.current += 1;
      const kind: ToastKind =
        current.type === 'success' || current.type === 'error' ? current.type : 'info';
      add({
        id: current.id,
        type: current.type,
        title: current.title,
        data: { kind, generation: generationRef.current, source: current.data?.source },
      });
      startCountdown();
    };

    window.addEventListener('blur', onBlur, true);
    window.addEventListener('focus', onFocus, true);
    return () => {
      window.removeEventListener('blur', onBlur, true);
      window.removeEventListener('focus', onFocus, true);
    };
  }, [add, startCountdown, stopCountdown]);

  /**
   * 掐掉 Base UI 的 F6 接管。
   *
   * Base UI 在提示区上注册了 window 级 keydown：命中 F6 就把提示区聚焦
   * （顺带把焦点从终端抢走）并暂停倒计时——真机上表现为「圆环画满了，
   * toast 还在」。这里在捕获阶段拦下 F6，Base UI 的处理器与浏览器默认的
   * 「F6 切到浏览器工具栏」（那会让窗口失焦）都走不到。
   *
   * 屏幕上没有提示条时不拦：F6 保持浏览器的默认行为。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'F6' || toastsRef.current.length === 0) {
        return;
      }
      event.stopPropagation();
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // 卸载时把表停掉：别让计时器在组件没了之后还去关提示条。
  useEffect(
    () => () => {
      if (countdownRef.current !== null) {
        window.clearTimeout(countdownRef.current);
        countdownRef.current = null;
      }
    },
    [],
  );

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport
          data-testid="page-toast-region"
          // 视口挂在 body 上（Portal 默认行为），补上外壳作用域标记，
          // 让 color-scheme 与选中态规则在提示区里同样生效。
          data-console-shell=""
          aria-label="操作结果提示"
          className="fixed top-4 right-4 z-[100] flex w-[340px] max-w-[calc(100vw_-_2rem)] flex-col gap-2 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          onMouseEnter={keepAutoDismiss}
          onMouseMove={keepAutoDismiss}
          onFocus={keepAutoDismiss}
          // 点视口本身也会被 Base UI 当成「聚焦提示区」而暂停倒计时：一并拦住。
          onClick={keepAutoDismiss}
          // 视口自己的键盘处理（Base UI 用它做 Shift+Tab 还原焦点）：
          // 一并拦住，提示区不抢键盘。
          onKeyDown={keepAutoDismiss}
        >
          {toasts.map((toast) => (
            <ToastItem key={toast.id} toast={toast} windowFocused={windowFocused} />
          ))}
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastContext.Provider>
  );
}

/** 每种类型配一个图标（形状也带信息，不只靠颜色）。 */
function KindIcon({ kind }: { kind: ToastKind }) {
  if (kind === 'success') {
    return <CircleCheck className="mt-px size-4 shrink-0" aria-hidden="true" />;
  }
  if (kind === 'error') {
    return <CircleX className="mt-px size-4 shrink-0" aria-hidden="true" />;
  }
  return <Info className="mt-px size-4 shrink-0" aria-hidden="true" />;
}

/** 单条 toast：图标 + 文案 + 带倒计时圆环的关闭键。 */
function ToastItem({ toast, windowFocused }: { toast: ToastObject<ToastData>; windowFocused: boolean }) {
  const kind: ToastKind = toast.type === 'success' || toast.type === 'error' ? toast.type : 'info';
  const source = toast.data?.source;

  return (
    <ToastPrimitive.Root
      toast={toast}
      data-testid="page-toast-item"
      data-toast-kind={kind}
      data-toast-source={source}
      data-console-toast-item=""
      // Base UI 默认给 toast 根节点 `role="dialog"`：一条瞬时提示报成「对话框」不对。
      // 改成 `role="status"`（瞬时状态播报区，隐含 aria-live=polite），
      // 视口本身的 aria-live="polite" 不变。
      role="status"
      // 关掉滑动关闭：Base UI 的滑动会顺带挂上 pointerdown 处理器，
      // 触摸按下 / 鼠标按下会把倒计时按停（圆环画满但 toast 不消失）。
      // 本控制台只用关闭键提前关闭，不需要滑动。
      swipeDirection={[]}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[12.5px] leading-relaxed shadow-md',
        toastKindClass(kind),
      )}
    >
      <KindIcon kind={kind} />
      <ToastPrimitive.Title className="min-w-0 flex-1 font-normal">
        {toast.title}
      </ToastPrimitive.Title>
      <ToastPrimitive.Close
        aria-label="关闭提示"
        // Base UI 默认只在视口展开时暴露关闭键（堆叠提示的可达性策略）；
        // 本控制台同一时刻只有一条提示，关闭键必须一直可读可点。
        aria-hidden={undefined}
        data-testid="page-toast-close"
        className="relative grid size-5 shrink-0 place-items-center rounded-full opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 size-full -rotate-90"
          style={
            {
              '--app-toast-duration': `${TOAST_DURATION_MS}ms`,
              '--app-toast-ring-length': `${TOAST_RING_LENGTH}`,
            } as CSSProperties
          }
        >
          <circle
            // 代次只增不减：反馈被顶替时圆环元素一定重建，倒计时重新画满。
            key={toast.data?.generation ?? 0}
            cx="12"
            cy="12"
            r={TOAST_RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={TOAST_RING_LENGTH}
            className="animate-toast-countdown"
            // 窗口失焦：圆环跟着倒计时一起停画（唯一允许的例外）。
            // 回到前台时圆环元素会被重建（代次 +1），动画从头画满 5 秒。
            // 动画挂在圆环上，播放状态也得挂在圆环上（该属性不继承）。
            style={{ animationPlayState: windowFocused ? 'running' : 'paused' }}
          />
        </svg>
        <X className="relative size-3" aria-hidden="true" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}
