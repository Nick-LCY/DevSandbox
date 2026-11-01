/**
 * 后端接口调用。全部走同源相对路径（前端不含任何认证逻辑）。
 *
 * 错误消息直接取后端 `{"detail": "中文消息"}` 里的 `detail`，页面原样展示。
 */

import type {
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

const NETWORK_ERROR_MESSAGE = '无法连接后端服务，请确认控制台服务已启动';

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(path, { credentials: 'same-origin', ...init, headers });
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

export const api = {
  health: () => request<HealthResponse>('/api/health'),

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
