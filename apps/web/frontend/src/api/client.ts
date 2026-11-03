/**
 * 后端接口调用。请求基址由连接配置决定（见 `src/lib/connection.ts`），
 * 每个请求都带 `Authorization: Bearer <token>`。
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
 * - 基址：连接配置里的后端基址（空串 = 同源，走相对路径）。
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

  const url = `${resolveApiBaseUrl(config)}${path}`;

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
};
