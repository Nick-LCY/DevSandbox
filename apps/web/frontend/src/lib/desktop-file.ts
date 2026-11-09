/**
 * 桌面形态的**下载落盘** IPC 桥：原生「保存为」+ Rust 流式下载。
 *
 * 走 Tauri 注入的 `window.__TAURI_INTERNALS__.invoke`，**不引 `@tauri-apps/api`**
 * （与 `desktop-forward.ts` / `connection.ts` 同款口径：web 形态的构建产物与
 * 依赖树不被 Tauri 污染）。web 形态下这里的一切都不可达——调用方
 * （`FileBrowserPanel`）用 `desktop` 形态标记门控，根本不会调。
 *
 * ## 为什么桌面形态不沿用 web 的 blob 下载
 *
 * 桌面壳的 CSP 只在 `img-src` 放行 `blob:`，导航 `blob:` URL 会被拦；而且要的是
 * **原生保存框**，不是浏览器下载条。因此：
 *
 * | 步骤 | 命令 / 事件 | 说明 |
 * |---|---|---|
 * | ① 选路径 | `plugin:dialog|save`（dialog 插件） | 原生保存框，`defaultPath` = 列表条目名；取消 → `null` |
 * | ② 下载 | `download_to_disk`（自定义命令） | 带令牌流式 GET → 原子写用户所选路径 |
 * | ③ 取消 | `cancel_download`（自定义命令） | 关抽屉 / 切沙箱时收掉在途下载并清临时文件 |
 * | 进度 | 事件 `download://<沙箱作用域>/<下载标识>` | 载荷见 `DesktopDownloadEvent` |
 *
 * 令牌与后端基址由本模块从连接配置现取（`getConnectionConfig`），**不由组件
 * 传入、不写进 localStorage 之外的地方**；Rust 侧同样**不落盘令牌**。
 *
 * ## 事件协议（Rust 侧 `apps/desktop/src-tauri/src/download.rs` 的 `DownloadEvent`）
 *
 * - **事件名带沙箱作用域与下载标识**：`download://<沙箱作用域>/<downloadId>`，
 *   多文件并行下载互不串扰（文件名不进事件名：容器内文件名可以带空格 / 点号，
 *   而 Tauri 的事件名只接受字母数字与 `-` `/` `:` `_`；文件维度由载荷 `path` 携带）。
 * - 载荷字段：`download_id` / `sandbox` / `path` / `phase`（`progress` / `done` /
 *   `error` / `cancelled`）/ `loaded` / `total`（`Content-Length`，可能为 `null`）/
 *   `message`（固定中文；`progress` 为空串）/ `target_path`（`done` 时给）。
 *
 * 沙箱作用域的字符替换规则必须与 Rust 侧 `event_scope` **逐字符一致**。
 */
import { NOT_CONFIGURED_MESSAGE, ConnectionNotConfiguredError } from '../api/client';
import { getConnectionConfig, resolveApiBaseUrl } from './connection';
import { invokeDesktop, listenDesktopEvent } from './desktop-ipc';

/** 下载事件名前缀（与 Rust 侧 `DOWNLOAD_EVENT_PREFIX` 一致）。 */
export const DOWNLOAD_EVENT_PREFIX = 'download://';

/**
 * 用户取消下载时 Rust 侧返回的固定文案（与 `download.rs::CANCELLED_MESSAGE` 一致）。
 *
 * 面板据此**静默收口**：取消是用户 / 关抽屉导致的预期结果，不弹失败 toast。
 */
export const CANCELLED_MESSAGE = '下载已取消';

/** 一次下载的事件阶段。 */
export type DesktopDownloadPhase = 'progress' | 'done' | 'error' | 'cancelled';

/** 下载事件载荷（Rust 侧 `DownloadEvent`，字段是蛇形命名）。 */
export interface DesktopDownloadEvent {
  /** 下载标识（前端生成，命令与事件共用）。 */
  download_id: string;
  /** 沙箱名。 */
  sandbox: string;
  /** 容器内路径。 */
  path: string;
  /** 阶段。 */
  phase: DesktopDownloadPhase;
  /** 已写字节数。 */
  loaded: number;
  /** 总字节数（取 `Content-Length`；没有长度头时为 null）。 */
  total: number | null;
  /** 固定中文说明（`progress` 为空串）。 */
  message: string;
  /** 落盘路径（`done` 时给）。 */
  target_path: string | null;
}

/** 下载命令的返回值（Rust 侧 `DownloadResult`）。 */
export interface DesktopDownloadResult {
  /** 实际落盘的路径（用户所选路径）。 */
  target_path: string;
  /** 实际写入的字节数。 */
  bytes: number;
}

/**
 * 沙箱名在事件名里的作用域：只保留 ASCII 字母数字与 `-` `_`，其余替换成 `_`。
 *
 * **必须与 Rust 侧 `download::event_scope` 逐字符一致**（否则订阅的事件名与
 * Rust 发事件用的名字对不上，进度永远不来）。
 */
export function downloadEventScope(sandbox: string): string {
  return sandbox.replace(/[^A-Za-z0-9_-]/gu, '_');
}

/** 一次下载的事件名：`download://<沙箱作用域>/<下载标识>`。 */
export function downloadEventName(sandbox: string, downloadId: string): string {
  return `${DOWNLOAD_EVENT_PREFIX}${downloadEventScope(sandbox)}/${downloadId}`;
}

/**
 * 弹原生「保存为」对话框，返回用户所选路径。
 *
 * - `defaultFileName`：默认文件名（= 列表条目名；只给文件名，不给目录——
 *   目录由对话框自己决定）；
 * - **用户取消 → `null`**（调用方静默返回，不弹提示）；
 * - 返回值**只有「全空白」判取消，不做 trim**：用户选的路径长得什么样就按什么样
 *   交给 Rust（路径首尾的空格可能是合法文件名的一部分）。
 *
 * 走 dialog 插件的 `save` 命令（能力清单里的 `dialog:allow-save`），
 * 参数形状是 `{ options: { defaultPath } }`（插件 JS 侧的 `save(options)` 同款）。
 */
export async function pickDownloadPath(defaultFileName: string): Promise<string | null> {
  const result = await invokeDesktop<string | null>('plugin:dialog|save', {
    options: { defaultPath: defaultFileName },
  });
  if (typeof result !== 'string' || result.trim() === '') {
    return null;
  }
  return result;
}

/**
 * 订阅一次下载的事件（进度 / 完成 / 失败 / 取消）。
 *
 * 返回「取消订阅」函数。订阅失败**向上抛**（ACL 拒绝 / 老桌面壳）：调用方按
 * 「进度显示降级但下载照跑」处理，不能因为进度订阅失败就拦死下载。
 *
 * 只接受 `download_id` 与本次相同的载荷（事件名已按沙箱 + 标识隔离，这里再兜一层）。
 */
export async function listenDownloadEvents(
  sandbox: string,
  downloadId: string,
  handler: (event: DesktopDownloadEvent) => void,
): Promise<() => void> {
  const event = downloadEventName(sandbox, downloadId);
  return listenDesktopEvent(event, (payload) => {
    const parsed = payload as Partial<DesktopDownloadEvent> | undefined;
    if (!parsed || parsed.download_id !== downloadId || typeof parsed.phase !== 'string') {
      return;
    }
    handler({
      download_id: parsed.download_id,
      sandbox: typeof parsed.sandbox === 'string' ? parsed.sandbox : sandbox,
      path: typeof parsed.path === 'string' ? parsed.path : '',
      phase: parsed.phase as DesktopDownloadPhase,
      loaded: typeof parsed.loaded === 'number' ? parsed.loaded : 0,
      total: typeof parsed.total === 'number' ? parsed.total : null,
      message: typeof parsed.message === 'string' ? parsed.message : '',
      target_path: typeof parsed.target_path === 'string' ? parsed.target_path : null,
    });
  });
}

/**
 * 带令牌流式下载并落盘到 `targetPath`。
 *
 * **后端基址与令牌从连接配置现取**（与 `api/client.ts` 一个口径），组件不碰令牌；
 * 未配置（令牌为空）时**一个 IPC 都不发**，直接抛未配置错误。
 */
export async function downloadToDisk(input: {
  sandbox: string;
  path: string;
  targetPath: string;
  downloadId: string;
}): Promise<DesktopDownloadResult> {
  const config = getConnectionConfig();
  if (config.token.trim() === '') {
    throw new ConnectionNotConfiguredError(NOT_CONFIGURED_MESSAGE);
  }
  const result = await invokeDesktop<DesktopDownloadResult>('download_to_disk', {
    sandbox: input.sandbox,
    path: input.path,
    targetPath: input.targetPath,
    backendBaseUrl: resolveApiBaseUrl(config.backendBaseUrl),
    token: config.token,
    downloadId: input.downloadId,
  });
  return {
    target_path:
      result && typeof result.target_path === 'string' ? result.target_path : input.targetPath,
    bytes: result && typeof result.bytes === 'number' ? result.bytes : 0,
  };
}

/**
 * 取消一次在途下载（Rust 侧删临时文件并让命令以「下载已取消」收口）。
 *
 * **幂等**：任务已经结束时静默忽略（Rust 侧找不到标识也不报错）。
 */
export async function cancelDownload(downloadId: string): Promise<void> {
  await invokeDesktop<void>('cancel_download', { downloadId });
}
