/**
 * 后端接口调用。请求基址由连接配置决定（见 `src/lib/connection.ts`），
 * 每个请求都带 `Authorization: Bearer <token>`。
 *
 * **请求恒为绝对地址**：基址恒非空（默认 `http://127.0.0.1:8000`），
 * 请求一律是 `<基址>/api/...`——不再有「空基址 = 同源 = 相对路径」的分支。
 *
 * 错误消息直接取后端 `{"detail": "中文消息"}` 里的 `detail`，页面原样展示。
 */

import {
  getConnectionConfig,
  resolveApiBaseUrl,
  type ConnectionConfig,
} from '../lib/connection';
import type {
  AuthTicketResponse,
  CreateSandboxRequest,
  CreateSandboxResponse,
  DeleteSandboxResponse,
  FileListEntry,
  FileUploadResponse,
  ForwardDeleteResponse,
  ForwardModel,
  HealthResponse,
  HostImage,
  ProxyRestartResult,
  ProxyStatus,
  ReclaimPlan,
  SandboxDetail,
  SandboxSummary,
  Template,
  TemplateConfig,
  TemplateDeleteResult,
  TerminalSession,
  TerminalSessionDeleteResult,
  TerminalSessionRecord,
} from './types';

/** 接口调用失败。`message` 是给用户看的中文文案，`status` 是 HTTP 状态码（0 表示网络不可达）。 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * 未配置连接：**请求根本没发出去**（令牌缺失）。
 *
 * 与 `ApiError` 分开：上层要靠它区分「还没配置，去引导态」与「后端报错了」。
 */
export class ConnectionNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionNotConfiguredError';
  }
}

/** 未配置连接时的提示文案。 */
export const NOT_CONFIGURED_MESSAGE = '尚未配置后端连接：请先填写访问令牌';

const NETWORK_ERROR_MESSAGE = '无法连接后端服务，请确认控制台服务已启动';

/** 健康检查的超时（毫秒）：后端不可达时不能把「正在连接」的加载态挂死。 */
const HEALTH_TIMEOUT_MS = 10000;

async function readDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body?.detail === 'string' && body.detail.length > 0) {
      return body.detail;
    }
  } catch {
    // 响应体不是 JSON：用状态码兜底。
  }
  return `请求失败（HTTP ${response.status}）`;
}

/**
 * 发一次请求。
 *
 * - 基址：连接配置里的后端基址（**恒非空**，恒拼绝对地址）。
 * - 凭据：**每个请求都带 `Authorization: Bearer <token>`**（后端对全部 `/api` 生效）。
 * - 令牌缺失时**一个请求都不发**，抛 `ConnectionNotConfiguredError` 交给上层进引导态。
 * - `connection` 可以覆盖当前配置（设置抽屉的「测试连接」用还没保存的草稿值试）。
 */
async function request<T>(
  path: string,
  init?: RequestInit,
  connection?: ConnectionConfig,
): Promise<T> {
  const config = connection ?? getConnectionConfig();
  if (config.token.trim() === '') {
    // 令牌缺失：不发请求（后端会回 401，发了也只是白跑一趟）。
    throw new ConnectionNotConfiguredError(NOT_CONFIGURED_MESSAGE);
  }

  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${config.token}`);
  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const url = `${resolveApiBaseUrl(config.backendBaseUrl)}${path}`;

  let response: Response;
  try {
    response = await fetch(url, { credentials: 'same-origin', ...init, headers });
  } catch {
    throw new ApiError(NETWORK_ERROR_MESSAGE, 0);
  }

  if (!response.ok) {
    throw new ApiError(await readDetail(response), response.status);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

function pathOf(name: string): string {
  return `/api/sandboxes/${encodeURIComponent(name)}`;
}

/**
 * 带超时的请求（健康检查用）。
 *
 * 后端地址是用户填的：填了一个不通的地址时，连接可能一直挂着（不回包也不断），
 * 那会让「测试连接」/「保存并连接」的加载态永远转下去。这里给一个超时兜底。
 */
async function requestWithTimeout<T>(
  path: string,
  connection: ConnectionConfig | undefined,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request<T>(path, { signal: controller.signal }, connection);
  } catch (exc) {
    if (controller.signal.aborted) {
      throw new ApiError(`连接后端超时（${Math.round(timeoutMs / 1000)} 秒无响应）`, 0);
    }
    throw exc;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 换一张一次性终端票据（`POST /api/auth/ticket`）。
 *
 * 浏览器发起的 WebSocket 不能设自定义头（`WebSocket` API 不支持），所以先用
 * Bearer 换一张 30 秒有效、用过即废的票据，再以 `?ticket=` 带上。
 *
 * **不缓存**：每次连接 / 重连前现取（票据用过即废，缓存下来也没用）。
 */
export async function fetchAuthTicket(): Promise<string> {
  const response = await request<AuthTicketResponse>('/api/auth/ticket', { method: 'POST' });
  return response.ticket;
}

/** 一次传输的进度：`total` 为 `null` 表示总长度未知（无 `Content-Length`）。 */
export interface TransferProgress {
  loaded: number;
  total: number | null;
}

/** 上传 / 下载的可选参数。 */
export interface TransferOptions {
  /** 进度回调（上传靠 XHR 的 progress 事件；下载靠流式读取 + `Content-Length`）。 */
  onProgress?: (progress: TransferProgress) => void;
  /** 取消信号（上传的「取消」按钮用它 abort XHR）。 */
  signal?: AbortSignal;
}

/** 下载结果：字节本体 + 原始 `Content-Disposition`（文件名解析在纯逻辑层做）。 */
export interface DownloadFileResult {
  blob: Blob;
  contentDisposition: string | null;
}

function transferUrl(config: ConnectionConfig, path: string): string {
  return `${resolveApiBaseUrl(config.backendBaseUrl)}${path}`;
}

function filesPath(name: string, action: 'upload' | 'download' | 'list'): string {
  return `${pathOf(name)}/files/${action}`;
}

/** 从 XHR 的错误响应里取后端 `detail`；取不到用状态码兜底。 */
function readXhrDetail(xhr: XMLHttpRequest): string {
  try {
    const body = JSON.parse(xhr.responseText) as { detail?: unknown };
    if (typeof body?.detail === 'string' && body.detail.length > 0) {
      return body.detail;
    }
  } catch {
    // 响应体不是 JSON：用状态码兜底。
  }
  return `请求失败（HTTP ${xhr.status}）`;
}

/**
 * 上传停滞阈值（毫秒）：**连续这么久没有任何 progress 事件**就取消上传。
 *
 * 不用 `xhr.timeout`：那是「整个请求的总时长」上限，与「文件大小不限」冲突——
 * 大文件只要还在持续传，就该继续跑。这里看的是**进度是否还在动**。
 */
const UPLOAD_STALL_TIMEOUT_MS = 120_000;

/** 上传停滞时给用户看的话（不是后端 detail，属于本地判定）。 */
const UPLOAD_STALL_MESSAGE = '上传停滞，已取消（120 秒无进度）';

/** 上传一次文件（raw body，`application/octet-stream`）。 */
function uploadFileWithXhr(
  sandbox: string,
  path: string,
  file: File,
  options: TransferOptions = {},
): Promise<FileUploadResponse> {
  return new Promise<FileUploadResponse>((resolve, reject) => {
    const config = getConnectionConfig();
    if (config.token.trim() === '') {
      reject(new ConnectionNotConfiguredError(NOT_CONFIGURED_MESSAGE));
      return;
    }
    if (options.signal?.aborted) {
      reject(new DOMException('上传已取消', 'AbortError'));
      return;
    }

    const url = transferUrl(
      config,
      `${filesPath(sandbox, 'upload')}?path=${encodeURIComponent(path)}`,
    );
    const xhr = new XMLHttpRequest();
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let stalled = false;
    const cleanup = (): void => {
      options.signal?.removeEventListener('abort', handleAbort);
      if (stallTimer !== undefined) {
        clearTimeout(stallTimer);
        stallTimer = undefined;
      }
    };
    const handleAbort = (): void => {
      xhr.abort();
    };
    /** 收到 progress 就重新计时：慢速但持续有进度的上传不会被误杀。 */
    const armStallTimer = (): void => {
      if (stallTimer !== undefined) {
        clearTimeout(stallTimer);
      }
      stallTimer = setTimeout(() => {
        stalled = true;
        // 先给出可读的本地错误，再 abort（abort 事件里的「已取消」不会盖掉它）。
        cleanup();
        reject(new ApiError(UPLOAD_STALL_MESSAGE, 0));
        xhr.abort();
      }, UPLOAD_STALL_TIMEOUT_MS);
    };

    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${config.token}`);
    // **显式 octet-stream**：既有的 `request()` 会给带 body 的请求写死 JSON。
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.addEventListener('progress', (event) => {
      armStallTimer();
      const total = event.lengthComputable ? event.total : file.size;
      options.onProgress?.({ loaded: event.loaded, total: total > 0 ? total : null });
    });

    xhr.addEventListener('load', () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const body = JSON.parse(xhr.responseText) as FileUploadResponse;
          resolve(body);
        } catch {
          reject(new ApiError('上传响应格式不正确', xhr.status));
        }
        return;
      }
      reject(new ApiError(readXhrDetail(xhr), xhr.status));
    });
    xhr.addEventListener('error', () => {
      cleanup();
      reject(new ApiError(NETWORK_ERROR_MESSAGE, 0));
    });
    xhr.addEventListener('abort', () => {
      cleanup();
      if (stalled) {
        return;
      }
      reject(new DOMException('上传已取消', 'AbortError'));
    });

    options.signal?.addEventListener('abort', handleAbort);
    xhr.send(file);
    armStallTimer();
  });
}

/** 下载一次文件（流式读取，按 `Content-Length` 算进度）→ Blob。 */
async function downloadFileWithProgress(
  sandbox: string,
  path: string,
  options: TransferOptions = {},
): Promise<DownloadFileResult> {
  const config = getConnectionConfig();
  if (config.token.trim() === '') {
    throw new ConnectionNotConfiguredError(NOT_CONFIGURED_MESSAGE);
  }

  const url = transferUrl(
    config,
    `${filesPath(sandbox, 'download')}?path=${encodeURIComponent(path)}`,
  );
  const headers = new Headers({ Authorization: `Bearer ${config.token}` });

  let response: Response;
  try {
    response = await fetch(url, {
      credentials: 'same-origin',
      headers,
      signal: options.signal,
    });
  } catch {
    if (options.signal?.aborted) {
      throw new DOMException('下载已取消', 'AbortError');
    }
    throw new ApiError(NETWORK_ERROR_MESSAGE, 0);
  }

  if (!response.ok) {
    throw new ApiError(await readDetail(response), response.status);
  }

  const lengthHeader = response.headers.get('Content-Length');
  const declared =
    lengthHeader === null || lengthHeader.trim() === '' ? Number.NaN : Number(lengthHeader);
  const total = Number.isFinite(declared) && declared >= 0 ? declared : null;
  const contentType = response.headers.get('Content-Type') ?? 'application/octet-stream';
  const contentDisposition = response.headers.get('Content-Disposition');

  let blob: Blob;
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: BlobPart[] = [];
    let loaded = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          chunks.push(value as unknown as BlobPart);
          loaded += value.byteLength;
          options.onProgress?.({ loaded, total });
        }
      }
    } catch (exc) {
      // 进度回调抛错 / 读流失败时也要把 reader 收掉：不 cancel 会一直占着连接。
      try {
        await reader.cancel();
      } catch {
        // 连接已断时 cancel 也会抛：忽略，保留原始错误。
      }
      if (options.signal?.aborted) {
        throw new DOMException('下载已取消', 'AbortError');
      }
      throw exc;
    }
    blob = new Blob(chunks, { type: contentType });
    // 收尾再报一次：读到 EOF 与「进度到 100%」不必依赖最后一帧的大小。
    options.onProgress?.({ loaded, total: total ?? loaded });
  } else {
    blob = await response.blob();
    options.onProgress?.({ loaded: blob.size, total: total ?? blob.size });
  }

  return { blob, contentDisposition };
}

export const api = {
  /**
   * 后端健康自检。给了连接配置就用它（设置抽屉的「测试连接」用草稿值试），
   * 不给就用当前配置。
   *
   * 带 10 秒超时：填了不通的后端地址时不会把加载态挂死。
   */
  health: (connection?: ConnectionConfig) =>
    requestWithTimeout<HealthResponse>('/api/health', connection, HEALTH_TIMEOUT_MS),

  /** 换一张一次性终端票据（见 `fetchAuthTicket`）。 */
  fetchAuthTicket: () => fetchAuthTicket(),

  /** 全部沙箱（含停止态）。后端返回裸数组。 */
  listSandboxes: () => request<SandboxSummary[]>('/api/sandboxes'),

  getSandbox: (name: string) => request<SandboxDetail>(pathOf(name)),

  createSandbox: (payload: CreateSandboxRequest) =>
    request<CreateSandboxResponse>('/api/sandboxes', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  startSandbox: (name: string) =>
    request<SandboxDetail>(`${pathOf(name)}/start`, { method: 'POST' }),

  stopSandbox: (name: string, stopDependencies = true) =>
    request<SandboxDetail>(`${pathOf(name)}/stop`, {
      method: 'POST',
      body: JSON.stringify({ stop_dependencies: stopDependencies }),
    }),

  /**
   * 删除前的回收清单。沙箱不存在回 404。
   *
   * 控制台页面已不再调用（删除确认不再预取清单），保留给脚本与将来的清单预览。
   */
  reclaimSandbox: (name: string) => request<ReclaimPlan>(`${pathOf(name)}/reclaim`),

  deleteSandbox: (name: string) =>
    request<DeleteSandboxResponse>(pathOf(name), { method: 'DELETE' }),

  /** 宿主本地镜像实时枚举。后端返回裸数组。 */
  listImages: () => request<HostImage[]>('/api/images'),

  proxyStatus: () => request<ProxyStatus>('/api/proxy/status'),

  restartProxy: () => request<ProxyRestartResult>('/api/proxy/restart', { method: 'POST' }),

  /** 列出全部启动模板。后端返回裸数组（带完整配置体）。 */
  listTemplates: () => request<Template[]>('/api/templates'),

  /** 创建启动模板。名称零限制（空名由前端交互拦）。 */
  createTemplate: (payload: { name: string; config: TemplateConfig }) =>
    request<Template>('/api/templates', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /** 重命名模板：只改名称，标识与其余字段不动。 */
  renameTemplate: (id: string, name: string) =>
    request<Template>(`/api/templates/${encodeURIComponent(id)}/rename`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  /** 删除模板。删的是内置模板时服务端写墓碑（删了不复活）。 */
  deleteTemplate: (id: string) =>
    request<TemplateDeleteResult>(`/api/templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  createTerminalSession: (sandbox: string, cols: number, rows: number) =>
    request<TerminalSession>('/api/terminal/sessions', {
      method: 'POST',
      body: JSON.stringify({ sandbox, cols, rows }),
    }),

  /** 列出会话；给了沙箱名则只列该沙箱的会话。后端返回裸数组。 */
  listTerminalSessions: (sandbox?: string) =>
    request<TerminalSessionRecord[]>(
      sandbox === undefined
        ? '/api/terminal/sessions'
        : `/api/terminal/sessions?sandbox=${encodeURIComponent(sandbox)}`,
    ),

  /**
   * 删除一个终端会话。
   *
   * 运行中的会话后端先完整关闭再删记录；已退出的会话走一遍收尾再删记录。
   * 会话不存在回 404，错误消息取后端 `detail`。
   */
  deleteTerminalSession: (sessionId: string) =>
    request<TerminalSessionDeleteResult>(
      `/api/terminal/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    ),

  /**
   * 列出端口转发。给了沙箱名则只列该沙箱的转发。
   *
   * 后端返回**裸数组**。注意：**本机端口不在这里**——本机端口由桌面端持有，
   * 后端宿主零端口（ADR 0014 第二次修订）。
   */
  listForwards: (sandbox?: string) =>
    request<ForwardModel[]>(
      sandbox === undefined
        ? '/api/forwards'
        : `/api/forwards?sandbox=${encodeURIComponent(sandbox)}`,
    ),

  /**
   * 建立端口转发（**幂等**：同一沙箱同一容器端口已有转发则复用既有转发）。
   *
   * 入参 `port` 是**容器端口**（转发目标端口），不是本机端口。
   */
  createForward: (sandbox: string, port: number) =>
    request<ForwardModel>('/api/forwards', {
      method: 'POST',
      body: JSON.stringify({ sandbox, port }),
    }),

  /**
   * 停止端口转发：删转发容器 + 删记录。
   *
   * **幂等口径**：首次停止 → 200 + 处理清单；重复停止同一条 → 404
   * （已无可停的东西，按「不存在」报）。
   */
  deleteForward: (forwardId: string) =>
    request<ForwardDeleteResponse>(`/api/forwards/${encodeURIComponent(forwardId)}`, {
      method: 'DELETE',
    }),

  /** 列出沙箱容器内某个目录（后端返回裸数组；隐藏文件也在内）。 */
  listFiles: (name: string, path: string) =>
    request<FileListEntry[]>(
      `${filesPath(name, 'list')}?path=${encodeURIComponent(path)}`,
    ),

  /**
   * 上传文件到容器内目标路径。
   *
   * **走 XHR**：fetch 拿不到上传进度事件。请求体是 raw `File`（浏览器自动带
   * `Content-Length`，服务端据此核对字节数），`Content-Type` 显式
   * `application/octet-stream`（绕开 `request()` 固定 JSON 的坑）。
   */
  uploadFile: (name: string, path: string, file: File, options?: TransferOptions) =>
    uploadFileWithXhr(name, path, file, options),

  /**
   * 下载容器内文件：fetch → 流式读 → Blob。
   *
   * 进度按响应 `Content-Length` 计算；返回 Blob 与原始 `Content-Disposition`
   * （文件名解析在 `src/lib/file-transfer.ts`）。
   *
   * **内存上限**：整份文件会先读进内存再落盘，能下多大受浏览器 Blob 上限与
   * 可用内存约束（超出时这里会失败，不会写坏目标文件）。
   */
  downloadFile: (name: string, path: string, options?: TransferOptions) =>
    downloadFileWithProgress(name, path, options),
};
