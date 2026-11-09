/**
 * 桌面壳（Rust 侧）IPC 的公共底座。
 *
 * 走 Tauri 注入的 `window.__TAURI_INTERNALS__`，**不引 `@tauri-apps/api`**
 * （口径见 ADR 0015 第 4 节：web 形态的构建产物与依赖树不被 Tauri 污染）。
 * 端口转发（`desktop-forward.ts`）与下载落盘（`desktop-file.ts`）共用这一层。
 *
 * ## 事件订阅的两处硬约束（踩过就记住）
 *
 * 1. **ACL**：Tauri v2 对 `plugin:event|listen` **一律走 ACL 校验**——桌面工程
 *    没有 `src-tauri/capabilities/` 目录时，订阅会被直接拒绝（事件通道整体不通）。
 *    能力清单在 `apps/desktop/src-tauri/capabilities/default.json`（放行
 *    `core:event:allow-listen` / `core:event:allow-unlisten`）。
 * 2. **`target` 的形状**：Rust 侧的 `EventTarget` 是**带标签的枚举**
 *    （`#[serde(tag = "kind")]`），「任意目标」是 `{"kind":"Any"}`——
 *    传裸字符串 `"Any"` 会被反序列化拒掉。
 */

/** Tauri 注入的内部对象（只用 `invoke` 与 `transformCallback`）。 */
export interface TauriInternals {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  transformCallback?: (callback: (payload: unknown) => void) => number;
}

/** 取 Tauri 内部对象（web 形态下是 undefined）。 */
export function desktopInternals(): TauriInternals | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const value = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  return value ?? null;
}

/**
 * 把任意抛出值收口成 `Error`。
 *
 * **Tauri 的 `invoke` 拒绝值可能是裸字符串**：Rust 侧命令返回的
 * `Result<_, String>` 到了前端就是字符串（不是 `Error`）。不收口的话，
 * 调用方的 `exc instanceof Error` 恒为假，Rust 侧的固定中文文案
 * （如「本机端口 80 小于 1024，当前系统不允许普通用户绑定低端口」）
 * 会被兜底文案顶掉——用户看不到真正的原因。
 */
export function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === 'string') {
    return new Error(value);
  }
  try {
    const text = JSON.stringify(value);
    return new Error(text === undefined ? String(value) : text);
  } catch {
    // 循环引用等序列化不了的取值：退成字符串描述。
    return new Error(String(value));
  }
}

/**
 * 调一条桌面壳命令。
 *
 * 桌面壳没有这条命令（老版本）或不在桌面形态时抛错——调用方负责兜。
 *
 * **失败一律收口成 `Error`**（见 `toError`）：调用方只读 `exc.message`
 * 就能拿到 Rust 侧的原文，不必再写「取不到原因就显示某句兜底文案」的分支。
 */
export async function invokeDesktop<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const api = desktopInternals();
  if (typeof api?.invoke !== 'function') {
    throw new Error('当前不是桌面形态，无法调用桌面端命令');
  }
  try {
    return (await api.invoke(cmd, args)) as T;
  } catch (exc) {
    throw toError(exc);
  }
}

/** Tauri 事件订阅的「任意目标」取值（对象，不是字符串——见文件头注释）。 */
export const ANY_EVENT_TARGET = { kind: 'Any' } as const;

/**
 * 订阅一条 Tauri 事件。
 *
 * 返回「取消订阅」函数。订阅失败**向上抛**（ACL 拒绝 / 老桌面壳没有事件命令），
 * 由调用方决定是降级 + 留痕还是直接收口。
 *
 * 载荷拆包与字段校验由调用方做（事件文案形形色色，这里只负责通道）。
 */
export async function listenDesktopEvent(
  event: string,
  handler: (payload: unknown) => void,
): Promise<() => void> {
  const api = desktopInternals();
  if (typeof api?.invoke !== 'function' || typeof api.transformCallback !== 'function') {
    throw new Error('当前不是桌面形态，无法订阅桌面端事件');
  }
  const invoke = api.invoke.bind(api);
  const transform = api.transformCallback.bind(api);
  const callback = transform((raw) => {
    handler((raw as { payload?: unknown } | null)?.payload);
  });
  const eventId = await invoke('plugin:event|listen', {
    event,
    target: ANY_EVENT_TARGET,
    handler: callback,
  });
  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    // 退订失败（事件通道已随窗口销毁 / ACL 限制）不影响调用方收口：
    // 这里只做清理，没有需要向用户报的错误。
    void invoke('plugin:event|unlisten', { event, eventId }).catch(() => {});
  };
}
