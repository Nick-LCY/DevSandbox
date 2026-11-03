/**
 * 连接配置：后端在哪 + 用什么令牌。
 *
 * 口径（见 ADR 0015 第 2 节；**决策 D：基址恒非空**）：
 * - 模型 `{ backendBaseUrl, token }`；`backendBaseUrl` **恒非空**：
 *   默认 `http://127.0.0.1:8000`（`DEFAULT_BACKEND_BASE_URL`），允许编辑，
 *   **不允许置空**（网页形态与桌面形态一个口径）。
 * - **「空 = 同源」语义已废除**：请求恒为 `<基址>/api/...` 的绝对地址，
 *   不再拼相对路径；终端 WebSocket 地址恒从基址推导（`http→ws` / `https→wss`），
 *   不再按页面位置（`window.location`）回退。
 * - 存储：localStorage，键 `sandbox-console-connection`。
 * - 存取口径与 `src/lib/theme.ts`、`src/lib/sidebar-collapsed.ts` 同款：
 *   只认「用户明确写过的值」，非法值 / 读取失败一律回落默认（= 未配置），
 *   存储不可用（隐私模式）时静默忽略，不打断交互。
 * - **挂载时不写存储**：只有用户主动保存连接配置才落盘。
 *
 * 未配置判定：**令牌为空**（基址恒有默认值，不参与判定）。
 * 未配置时不渲染工作台，改渲染引导面板（页面状态，不是路由）。
 *
 * **旧存储的兼容**：决策 D 之前允许基址为空（同源）。那些配置读到时**归一为
 * 默认地址**（`readStoredConnection` 里经 `normalizeBaseUrl` 处理），存量用户
 * 不会因为「存储里基址是空串」而连不上后端。
 *
 * 桌面形态还有一层「动态 CSP」的同步（`syncDesktopBackend`）：后端主机是运行期
 * 才知道的，桌面壳按它生成主文档的 `connect-src`——那是**桌面运行时的机制**，
 * 与「地址能不能填」无关：口径与时序契约见 `apps/desktop/README.md` 的
 * 「CSP」一节与 `apps/desktop/src-tauri/src/csp.rs`。
 */
import { useCallback, useMemo, useState } from 'react';

/** 连接配置。 */
export interface ConnectionConfig {
  /**
   * 后端基址（如 `http://127.0.0.1:8000`）。
   *
   * **恒非空**：默认值 `DEFAULT_BACKEND_BASE_URL`，允许编辑，**不允许置空**
   * （两种形态一个口径）。空值在归一层（`normalizeBaseUrl`）一律落回默认值。
   */
  backendBaseUrl: string;
  /** 访问令牌（`Authorization: Bearer <token>`）。空串 = 未配置。 */
  token: string;
}

/** 连接配置的存储键。 */
export const CONNECTION_STORAGE_KEY = 'sandbox-console-connection';

/**
 * 待验证配置的存储键（**仅桌面形态**）。
 *
 * 桌面形态首次配置时，跨主机的健康检查会被 CSP 拦死（主文档的 CSP 里还没有
 * 后端主机），必须先把后端主机告诉桌面壳并**重载主文档**，之后才能体检。
 * 重载会把内存状态清掉，所以这份草稿先落在存储里：重载回来时用它体检，
 * **体检通过才提升为生效配置**（不通过就不保存、不挂载工作台）。
 */
export const PENDING_CONNECTION_STORAGE_KEY = 'sandbox-console-connection-pending';

/** 默认后端地址（基址恒非空时的兜底值）。 */
export const DEFAULT_BACKEND_BASE_URL = 'http://127.0.0.1:8000';

/** 默认配置：默认基址 + 空令牌（= 未配置）。 */
export const DEFAULT_CONNECTION_CONFIG: ConnectionConfig = {
  backendBaseUrl: DEFAULT_BACKEND_BASE_URL,
  token: '',
};

/** 形如 `scheme://` 的前缀。 */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/** 取存储句柄；隐私模式等场景下访问 localStorage 会抛异常。 */
function resolveStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) {
    return storage;
  }
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * 归一化后端基址：去空白、补 scheme、去尾部斜杠，**空值落回默认地址**。
 *
 * - 补 scheme：用户填 `127.0.0.1:8000` 时按 `http://127.0.0.1:8000` 处理（省一次心智负担）。
 * - 去尾部斜杠：基址后面要直接拼 `/api/...`，多一个斜杠会出现 `//`。
 * - **空值 → 默认地址**：基址恒非空（决策 D），空串不再表示「同源」，
 *   一律归一为 `DEFAULT_BACKEND_BASE_URL`（存量存储里的空基址也走这条）。
 */
export function normalizeBaseUrl(raw: string): string {
  const text = raw.trim();
  if (text === '') {
    return DEFAULT_BACKEND_BASE_URL;
  }
  const withScheme = SCHEME_PATTERN.test(text) ? text : `http://${text}`;
  const trimmed = withScheme.replace(/\/+$/, '');
  // 去完尾部斜杠什么都不剩的极端输入保持原样；`http://` 这种会被去成 `http:`，
  // 交给校验去报错（`new URL('http:')` 解析不出主机名）。
  return trimmed === '' ? withScheme : trimmed;
}

/**
 * 校验后端地址。返回空串表示合法，否则返回中文原因（就地展示的红字）。
 *
 * **必填**：基址恒非空（决策 D），空值直接判非法（两种形态一个口径）。
 *
 * **不带路径 / 查询 / 片段**：基址只表示「后端在哪个主机的哪个端口」，
 * 路径、参数与 `#` 一律拒绝（后端的接口都在根路径下，填了路径反而对不上）。
 */
export function validateBaseUrl(raw: string): string {
  const text = raw.trim();
  if (text === '') {
    return '请填写后端地址';
  }
  let url: URL;
  try {
    url = new URL(normalizeBaseUrl(text));
  } catch {
    return '后端地址格式不对，请填 http:// 或 https:// 开头的地址';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return '后端地址只支持 http 与 https';
  }
  if (url.hostname === '') {
    return '后端地址格式不对，请填 http:// 或 https:// 开头的地址';
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return '后端地址不要带路径、参数或 #';
  }
  return '';
}

/**
 * 读已存连接配置。
 *
 * 没存过、值非法（不是对象 / 字段不是字符串）或读取失败，一律回落默认
 * （= 默认基址 + 空令牌 = 未配置）。
 *
 * **存量配置里的空基址归一为默认地址**（决策 D 之前「空 = 同源」留下的数据）：
 * 走 `normalizeBaseUrl`，空串落回 `DEFAULT_BACKEND_BASE_URL`，存量用户不受影响。
 */
export function readStoredConnection(storage?: Storage | null): ConnectionConfig {
  const store = resolveStorage(storage);
  if (!store) {
    return { ...DEFAULT_CONNECTION_CONFIG };
  }
  try {
    const raw = store.getItem(CONNECTION_STORAGE_KEY);
    if (raw === null) {
      return { ...DEFAULT_CONNECTION_CONFIG };
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ...DEFAULT_CONNECTION_CONFIG };
    }
    const record = parsed as Record<string, unknown>;
    return {
      backendBaseUrl: normalizeBaseUrl(
        typeof record.backendBaseUrl === 'string' ? record.backendBaseUrl : '',
      ),
      token: typeof record.token === 'string' ? record.token.trim() : '',
    };
  } catch {
    // 读不到 / 解析失败：回落默认（未配置）。
    return { ...DEFAULT_CONNECTION_CONFIG };
  }
}

/** 写连接配置；写不进去（隐私模式）时静默忽略，不打断交互。 */
export function writeStoredConnection(
  config: ConnectionConfig,
  storage?: Storage | null,
): void {
  const store = resolveStorage(storage);
  if (!store) {
    return;
  }
  try {
    store.setItem(
      CONNECTION_STORAGE_KEY,
      JSON.stringify({
        backendBaseUrl: normalizeBaseUrl(config.backendBaseUrl),
        token: config.token.trim(),
      }),
    );
  } catch {
    // 忽略：存不下就算了，本次会话内的配置仍然生效。
  }
}

/**
 * 读待验证配置（桌面形态首次配置时，重载前写下的草稿）。
 *
 * 没有、值非法或读取失败，一律返回 null（= 没有待验证的配置）。
 */
export function readPendingConnection(storage?: Storage | null): ConnectionConfig | null {
  const store = resolveStorage(storage);
  if (!store) {
    return null;
  }
  try {
    const raw = store.getItem(PENDING_CONNECTION_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const token = typeof record.token === 'string' ? record.token.trim() : '';
    if (token === '') {
      return null;
    }
    return {
      backendBaseUrl: normalizeBaseUrl(
        typeof record.backendBaseUrl === 'string' ? record.backendBaseUrl : '',
      ),
      token,
    };
  } catch {
    return null;
  }
}

/** 写待验证配置；写不进去时静默忽略。 */
export function writePendingConnection(
  config: ConnectionConfig,
  storage?: Storage | null,
): void {
  const store = resolveStorage(storage);
  if (!store) {
    return;
  }
  try {
    store.setItem(
      PENDING_CONNECTION_STORAGE_KEY,
      JSON.stringify({
        backendBaseUrl: normalizeBaseUrl(config.backendBaseUrl),
        token: config.token.trim(),
      }),
    );
  } catch {
    // 忽略：存不下就没法在重载后体检（那次保存会走「不重载」的直连路径）。
  }
}

/** 清掉待验证配置（体检通过并提升为生效配置后，或体检失败后）。 */
export function clearPendingConnection(storage?: Storage | null): void {
  const store = resolveStorage(storage);
  if (!store) {
    return;
  }
  try {
    store.removeItem(PENDING_CONNECTION_STORAGE_KEY);
  } catch {
    // 忽略：清不掉也不影响后续（下次体检失败会再清一次）。
  }
}

/**
 * 请求基址：**恒为绝对地址**（决策 D：不再有「空 = 同源」的相对路径分支）。
 *
 * 入参是基址本身（不是整份配置）：令牌与基址推导无关。
 */
export function resolveApiBaseUrl(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl);
}

/**
 * 运行形态探测：是否跑在 Tauri 桌面壳里。
 *
 * 特性探测 `window.__TAURI_INTERNALS__`（Tauri v2 注入的内部对象），
 * **不引入 `@tauri-apps/api`**：web 形态的构建产物与依赖树不被 Tauri 污染。
 */
export function isDesktopRuntime(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const internals = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  return internals !== undefined && internals !== null;
}

/**
 * 当前配置是否已配置（可以连后端了）。
 *
 * **未配置 = 令牌为空**：后端对全部 `/api` 生效，没有令牌就换不到数据。
 *
 * 基址**不参与判定**：基址恒有默认值（恒非空），两种运行形态一个口径。
 */
export function isConnectionConfigured(config: ConnectionConfig): boolean {
  return config.token.trim() !== '';
}

/**
 * 进程内的当前配置缓存。
 *
 * 接口层（`src/api/client.ts`）与终端地址推导都从这里取配置，而不是每次读存储：
 * 存储不可用（隐私模式）时用户仍然能在引导面板里填配置，本进程内照样能连后端。
 */
let cachedConfig: ConnectionConfig | null = null;

/** 只更新内存缓存，不落盘（挂载时用：口径是「挂载时不写存储」）。 */
export function cacheConnectionConfig(config: ConnectionConfig): void {
  cachedConfig = {
    backendBaseUrl: normalizeBaseUrl(config.backendBaseUrl),
    token: config.token.trim(),
  };
}

/** 取当前配置：优先用内存缓存，没有则读一次存储。 */
export function getConnectionConfig(): ConnectionConfig {
  if (cachedConfig === null) {
    cachedConfig = readStoredConnection();
  }
  return cachedConfig;
}

/** 保存配置：更新内存缓存并落盘。 */
export function setConnectionConfig(config: ConnectionConfig): void {
  cacheConnectionConfig(config);
  writeStoredConnection(getConnectionConfig());
}

/** 桌面同步的结果。 */
export type DesktopSyncOutcome =
  /** 已同步（桌面壳的状态已经是这个后端主机），不用重载主文档。 */
  | 'synced'
  /** 桌面壳的主文档 CSP 还没跟上：**主文档正在重载**（页面即将卸载）。 */
  | 'reloading'
  /** 不是桌面形态 / 桌面壳没有这条命令：什么也没做。 */
  | 'unavailable';

/**
 * 本次页面会话里已经送给桌面壳的后端基址（**归一后的值**）。
 *
 * 同一个基址只送一次：桌面壳的状态已经是它了，重复送没有意义
 * （省掉「保存一次 = 两次 IPC」的往返）。
 *
 * 去重按**归一值**比较：`10.0.0.5:8000` 与 `http://10.0.0.5:8000` 是同一个基址，
 * 只送一次。
 */
let lastSyncedBaseUrl: string | null = null;

/**
 * 测试用：清掉「本次页面会话已同步的后端基址」缓存。
 *
 * 单元测试里每个用例都要从「没同步过」的状态起步（否则后一个用例会被前一个
 * 用例的去重缓存影响）。
 */
export function resetDesktopSyncState(): void {
  lastSyncedBaseUrl = null;
}

/**
 * 桌面形态下把后端基址告诉 Rust 侧（动态 CSP 跟着连接配置走）。
 *
 * 走 Tauri 注入的 `window.__TAURI_INTERNALS__.invoke`，**不引 `@tauri-apps/api`**。
 *
 * **时序契约**（与 `apps/desktop/src-tauri/src/csp.rs` 一一对应）：
 * 1. `set_backend_base_url` 更新桌面壳里的状态（幂等）；
 * 2. `csp_needs_reload` 问「当前主文档的 CSP 跟我要的后端主机一致吗」；
 * 3. 不一致 → 主文档重载（`location.reload()`）：重载后主文档重新被请求，
 *    这一版 CSP 才带上后端主机。**顺序不能反**：先更新状态，再重载。
 *
 * **送出去的基址恒为「非空且已归一」**：用户可能填 `10.0.0.5:8000`（漏 scheme），
 * 原串送进 Rust 侧的 `Url::parse` 会解析失败 → `connect-src` 静默少掉那台主机
 * → 跨主机请求全被 CSP 拦死（界面上看不出原因）。归一走 `normalizeBaseUrl`
 * （补 scheme、去尾部斜杠、空值落回默认地址）。
 *
 * 调用失败（老版本桌面壳没有这些命令）时静默忽略：不能因为 CSP 同步失败
 * 就把用户的配置保存也带崩。
 */
export async function syncDesktopBackend(baseUrl: string): Promise<DesktopSyncOutcome> {
  if (typeof window === 'undefined') {
    return 'unavailable';
  }
  const internals = (
    window as unknown as {
      __TAURI_INTERNALS__?: {
        invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
    }
  ).__TAURI_INTERNALS__;
  const invoke = internals?.invoke;
  if (typeof invoke !== 'function') {
    return 'unavailable';
  }
  // 恒送「非空且已归一」的基址（归一规则在 `normalizeBaseUrl`，单一真相源）。
  const target = normalizeBaseUrl(baseUrl);
  if (lastSyncedBaseUrl !== null && lastSyncedBaseUrl === target) {
    // 同一个后端主机已经送过了：桌面壳的状态已经是它，不用再送一次。
    return 'synced';
  }
  try {
    await invoke('set_backend_base_url', { backendBaseUrl: target });
    const needsReload = await invoke('csp_needs_reload');
    // 两步都成了才算「已同步」：第二步失败时不算，下次还能重试。
    lastSyncedBaseUrl = target;
    if (needsReload === true) {
      // 主文档的 CSP 还没带上后端主机：重载（页面即将卸载，调用方不要再往下走）。
      window.location.reload();
      return 'reloading';
    }
    return 'synced';
  } catch {
    // 忽略：桌面壳没有这些命令（或 IPC 失败），不影响配置本身的保存。
    return 'unavailable';
  }
}

/**
 * 当前这一轮要连的后端基址。
 *
 * **待验证配置优先**：桌面形态首次保存时，主文档重载回来后要体检的是那份草稿
 * （它才是这一轮真正要连的主机）；没有待验证配置时用生效中的配置。
 */
export function effectiveBackendBaseUrl(
  live: ConnectionConfig,
  pending: ConnectionConfig | null,
): string {
  const pendingBase = pending?.backendBaseUrl.trim() ?? '';
  if (pendingBase !== '') {
    return pendingBase;
  }
  return live.backendBaseUrl;
}

/**
 * 健康检查失败的原因文案：**区分「令牌无效」与「后端不可达」**。
 *
 * 两种失败态不混（ADR 0015 第 5 节）：令牌无效是「配置不对，去改令牌」，
 * 后端不可达是「服务没起来或地址不对，去看后端」。
 */
export function describeHealthFailure(exc: unknown): string {
  const status = statusOf(exc);
  const message = exc instanceof Error ? exc.message : '';
  if (status === 401 || status === 403) {
    return `令牌无效：${message || '访问令牌无效或缺失'}`;
  }
  return `后端不可达：${message || '无法连接后端服务'}`;
}

/** 取出错误对象上的 HTTP 状态码（没有则 null）。 */
function statusOf(exc: unknown): number | null {
  if (typeof exc !== 'object' || exc === null) {
    return null;
  }
  const status = (exc as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

/** 连接配置接口。 */
export interface ConnectionApi {
  /** 当前配置。 */
  config: ConnectionConfig;
  /** 改配置并落盘（基址与令牌统一归一：基址恒非空，空值落回默认地址）。 */
  setConfig: (next: ConnectionConfig) => void;
  /** 当前是否已配置（未配置时不渲染工作台，改渲染引导面板）。 */
  configured: boolean;
  /** 是否运行在桌面壳里。 */
  desktop: boolean;
}

/**
 * 连接配置 Hook。
 *
 * - 初始值来自 localStorage（非法值回落默认 = 未配置），**挂载时不写存储**。
 * - 初始化时**同步**写内存缓存（不靠 effect 的执行顺序）：接口层与终端地址
 *   推导在首次渲染时就能拿到同一份配置。
 * - 只有用户主动保存（引导面板的「保存并连接」/ 设置抽屉的「保存配置」）才落盘。
 * - **不再按运行形态收敛**：两种形态都能配后端地址，未配置只看令牌；
 *   基址恒非空（空值归一为默认地址）。
 */
export function useConnection(): ConnectionApi {
  const desktop = useMemo(() => isDesktopRuntime(), []);
  const [config, setConfigState] = useState<ConnectionConfig>(() => {
    const initial = readStoredConnection();
    // 初始化就落进内存缓存：接口层（`src/api/client.ts`）与终端地址推导
    // 在首次渲染时读到的就是这份配置，不依赖 effect 的执行顺序。
    cacheConnectionConfig(initial);
    return initial;
  });

  const setConfig = useCallback((next: ConnectionConfig) => {
    // 归一 + 落盘（基址与令牌的归一口径在 `cacheConnectionConfig` 里）。
    setConnectionConfig(next);
    setConfigState(getConnectionConfig());
    // 生效配置一落盘，待验证配置就没有意义了（清掉，别留着误导下一次体检）。
    clearPendingConnection();
  }, []);

  const configured = isConnectionConfigured(config);

  return { config, setConfig, configured, desktop };
}
