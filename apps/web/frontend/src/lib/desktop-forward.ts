/**
 * 桌面壳（Rust 侧）的端口转发 IPC 桥。
 *
 * 走 Tauri 注入的 `window.__TAURI_INTERNALS__`，**不引 `@tauri-apps/api`**
 * （与 `src/lib/connection.ts` 的 `syncDesktopBackend` 同款口径：web 形态的
 * 构建产物与依赖树不被 Tauri 污染）。
 *
 * **web 形态下这里的一切都不可达**：`invoke` 不存在时命令直接抛错，
 * 调用方（`PortForwardPanel`）用 `isDesktopRuntime()` 门控，根本不会调。
 *
 * 三个命令（Rust 侧见 `apps/desktop/src-tauri/src/commands.rs`）：
 *
 * | 命令 | 作用 | 返回 |
 * |---|---|---|
 * | `start_forward` | 开启本机监听（幂等） | **实际生效**的本机端口 |
 * | `stop_forward` | 关闭本机监听（关监听 + 关全部连接） | — |
 * | `forward_listeners` | 当前所有「已开启本机监听」的转发 | 监听状态数组 |
 *
 * 另有两个事件：
 *
 * | 事件 | 含义 |
 * |---|---|
 * | `forward://state` | **转发级**状态（监听开启 / 关闭 / 致命失败） |
 * | `forward://connection` | **连接级**状态（某一条本机连接的隧道收场） |
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

/** 一条转发的本机监听状态（Rust 侧 `ForwardListener`，字段是蛇形命名）。 */
export interface ForwardListener {
  /** 转发标识。 */
  forward_id: string;
  /** 容器端口（转发目标端口）。 */
  container_port: number;
  /** **实际生效**的本机端口。 */
  local_port: number;
  /** 状态：`listening`。 */
  state: string;
}

/** 转发级状态事件（Rust 侧 `ForwardStateEvent`）。 */
export interface ForwardStateEvent {
  /** 转发标识。 */
  forward_id: string;
  /** 状态：`listening` / `stopped` / `error`。 */
  state: string;
  /** 容器端口（转发目标端口）。 */
  container_port: number;
  /** 实际生效的本机端口（未开启时为 null）。 */
  local_port: number | null;
  /** 面向用户的中文说明。 */
  message: string;
}

/** 连接级状态事件（Rust 侧 `ForwardConnectionEvent`）。 */
export interface ForwardConnectionEvent {
  /** 转发标识。 */
  forward_id: string;
  /** 状态：`connected` / `closed` / `error`。 */
  state: string;
  /** 容器端口（转发目标端口）。 */
  container_port: number;
  /** 本机端口。 */
  local_port: number;
  /** 面向用户的中文说明。 */
  message: string;
}

/** Tauri 注入的内部对象（只用 `invoke` 与 `transformCallback`）。 */
interface TauriInternals {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  transformCallback?: (callback: (payload: unknown) => void) => number;
}

/** 取 Tauri 内部对象（web 形态下是 undefined）。 */
function internals(): TauriInternals | null {
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
async function invokeDesktop<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const api = internals();
  if (typeof api?.invoke !== 'function') {
    throw new Error('当前不是桌面形态，无法调用桌面端命令');
  }
  try {
    return (await api.invoke(cmd, args)) as T;
  } catch (exc) {
    throw toError(exc);
  }
}

/**
 * 开启一条转发的本机监听。
 *
 * - `localPort`：本机端口（缺省 = 容器端口）；**被占时桌面端自动换空闲端口**，
 *   返回值是**实际生效的端口**（界面必须显示它）。
 */
export async function startForwardListener(input: {
  forwardId: string;
  backendBaseUrl: string;
  token: string;
  containerPort: number;
  localPort?: number | null;
}): Promise<number> {
  return invokeDesktop<number>('start_forward', {
    forwardId: input.forwardId,
    backendBaseUrl: input.backendBaseUrl,
    token: input.token,
    containerPort: input.containerPort,
    localPort: input.localPort ?? null,
  });
}

/** 关闭一条转发的本机监听（关监听 + 关全部连接）。 */
export async function stopForwardListener(forwardId: string): Promise<void> {
  await invokeDesktop<void>('stop_forward', { forwardId });
}

/** 当前所有「已开启本机监听」的转发（前端挂载时回填「已开启」的行）。 */
export async function listForwardListeners(): Promise<ForwardListener[]> {
  const result = await invokeDesktop<ForwardListener[]>('forward_listeners');
  return Array.isArray(result) ? result : [];
}

/**
 * 订阅端口转发的两个事件。
 *
 * 返回一个「取消订阅」函数（组件卸载时调用）。
 *
 * **订阅失败不抛错，但一定留痕**：桌面壳没有事件命令、或能力清单里没放行
 * `core:event` 权限时，订阅会被 ACL 拒绝——这时打一条 `console.warn`
 * 说明「事件同步已降级」，别让这类问题被静默吞掉（事件通道整体不通时
 * 界面看着正常，实际早就不同步了）。
 */
export async function listenForwardEvents(handlers: {
  onState?: (event: ForwardStateEvent) => void;
  onConnection?: (event: ForwardConnectionEvent) => void;
}): Promise<() => void> {
  const api = internals();
  if (typeof api?.invoke !== 'function' || typeof api.transformCallback !== 'function') {
    return () => {};
  }
  const invoke = api.invoke.bind(api);
  const transform = api.transformCallback.bind(api);

  const stateHandler = transform((raw) => {
    const payload = (raw as { payload?: unknown } | null)?.payload;
    const event = payload as ForwardStateEvent | undefined;
    if (event && typeof event.forward_id === 'string') {
      handlers.onState?.(event);
    }
  });
  const connectionHandler = transform((raw) => {
    const payload = (raw as { payload?: unknown } | null)?.payload;
    const event = payload as ForwardConnectionEvent | undefined;
    if (event && typeof event.forward_id === 'string') {
      handlers.onConnection?.(event);
    }
  });

  // **`target` 是对象不是字符串**：Rust 侧的 `EventTarget` 是带标签的枚举
  // （`{"kind":"Any"}`），传裸字符串会被拒。
  const target = { kind: 'Any' };
  let stateId: unknown;
  try {
    stateId = await invoke('plugin:event|listen', {
      event: 'forward://state',
      target,
      handler: stateHandler,
    });
    const connectionId = await invoke('plugin:event|listen', {
      event: 'forward://connection',
      target,
      handler: connectionHandler,
    });
    return () => {
      void invoke('plugin:event|unlisten', { event: 'forward://state', eventId: stateId });
      void invoke('plugin:event|unlisten', {
        event: 'forward://connection',
        eventId: connectionId,
      });
    };
  } catch (exc) {
    // 订阅失败：把已订阅的那条退掉，再降级（状态同步靠命令返回值兜底）。
    if (stateId !== undefined) {
      void invoke('plugin:event|unlisten', { event: 'forward://state', eventId: stateId });
    }
    console.warn(
      '[port-forward] 订阅端口转发事件失败，状态同步降级为「命令返回值 + 手动刷新」。' +
        '若桌面壳缺少 core:event 的 listen 权限（capabilities 清单），事件通道会整体不通。',
      exc,
    );
    return () => {};
  }
}

/** 一条监听重启的结果（逐条独立：一条失败不影响其它条）。 */
export interface ForwardListenerRestart {
  /** 转发标识。 */
  forwardId: string;
  /** 是否重启成功。 */
  ok: boolean;
  /** 重启后的实际本机端口（成功时）。 */
  localPort?: number;
  /** 失败原因（失败时，原文）。 */
  message?: string;
}

/**
 * 用新凭据重启**全部已开启的本机监听**。
 *
 * **为什么要重启**：令牌与后端基址是**开启监听那一刻的快照**——用户改了
 * 连接配置（换令牌 / 换后端）之后，旧监听仍拿着旧凭据，隧道会以
 * 1008（策略违规）收场。所以保存连接配置成功后要把已开启的监听逐个停掉、
 * 用新凭据重开。
 *
 * - **同端口**：本机端口是用户已经拿在手里的地址，重启不能换掉它
 *   （用监听器当前的**实际**端口重开）。
 * - **逐条独立**：一条失败不影响其它条，也不中断整体流程（失败原因逐条上报）。
 */
export async function restartForwardListeners(config: {
  backendBaseUrl: string;
  token: string;
}): Promise<ForwardListenerRestart[]> {
  const items = await listForwardListeners();
  const results: ForwardListenerRestart[] = [];
  for (const item of items) {
    try {
      // 先停：不停的话 `start_forward` 是幂等的，会直接返回旧会话的端口，
      // 新凭据根本没换上（重启等于没做）。
      await stopForwardListener(item.forward_id);
      const localPort = await startForwardListener({
        forwardId: item.forward_id,
        backendBaseUrl: config.backendBaseUrl,
        token: config.token,
        containerPort: item.container_port,
        localPort: item.local_port,
      });
      results.push({ forwardId: item.forward_id, ok: true, localPort });
    } catch (exc) {
      results.push({
        forwardId: item.forward_id,
        ok: false,
        message: toError(exc).message,
      });
    }
  }
  return results;
}
