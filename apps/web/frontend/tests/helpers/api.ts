/**
 * 控制台 REST 接口的直接调用。
 *
 * 验收里用它做两件事：
 * 一是在用例准备阶段造沙箱（不必绕网页）；
 * 二是把网页看到的字段与接口返回的字段对齐核对。
 *
 * 三期起后端对全部 `/api` 生效令牌认证：这里的每个直调都带
 * `Authorization: Bearer <令牌>`（令牌常量在 `helpers/auth.ts`，与服务进程
 * 注入的是同一份）。
 */

import { authHeaders } from './auth';
import { readFixtures } from './sandbox';

export interface SandboxSummaryModel {
  name: string;
  state: string;
  state_label: string;
  image: string;
  created_at: string;
}

export interface MountModel {
  host_path: string;
  container_path: string;
  read_only: boolean;
  role: string;
}

export interface SandboxDetailModel {
  name: string;
  state: string;
  state_label: string;
  image: string;
  image_source: string;
  created_at: string;
  updated_at: string;
  system_user: string;
  uid: number;
  gid: number;
  home: string;
  subid_start: number;
  subid_length: number;
  socket_path: string;
  container_name: string;
  container_id: string;
  network_name: string;
  network_owned: boolean;
  unit_path: string;
  mounts: MountModel[];
  files: MountModel[];
  dependency_containers: string[];
  command: string[];
  workdir: string;
}

export interface ReclaimPlanModel {
  sandbox_name: string;
  items: string[];
  untouched_note: string;
  user_mounts: string[];
  incomplete: boolean;
}

export interface DeleteResultModel {
  name: string;
  existed: boolean;
  removed: string[];
  failed: string[];
}

/** 启动模板的配置体（字段缺失与字段填了空值不是一回事）。 */
export interface TemplateConfigModel {
  image?: string | null;
  mounts?: string[];
  files?: string[];
  command?: string | null;
  workdir?: string | null;
  env?: Record<string, string>;
  network?: string | null;
}

export interface TemplateModel {
  id: string;
  name: string;
  config: TemplateConfigModel;
  created_at: string;
  updated_at: string;
}

function baseUrl(): string {
  const { host, port } = readFixtures();
  return `http://${host}:${port}`;
}

/** 发一个 JSON 请求。 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      // 认证头（后端对全部 `/api` 生效令牌认证）。
      // 展开顺序有讲究：**显式传入的 header 优先于 `authHeaders()`**——
      // 后展开的同名头覆盖先展开的，所以负向用例要换令牌时，
      // 在 `init.headers` 里传 `Authorization` 就能盖掉默认令牌。
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`接口 ${path} 失败（HTTP ${response.status}）：${text}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** 列出全部沙箱。 */
export function listSandboxes(): Promise<SandboxSummaryModel[]> {
  return request<SandboxSummaryModel[]>('/api/sandboxes');
}

/** 取沙箱详情。 */
export function getSandbox(name: string): Promise<SandboxDetailModel> {
  return request<SandboxDetailModel>(`/api/sandboxes/${encodeURIComponent(name)}`);
}

/** 创建沙箱。 */
export function createSandbox(payload: {
  name: string;
  image: string;
  image_source?: 'auto' | 'host';
  mounts?: string[];
  command?: string;
  env?: Record<string, string>;
  workdir?: string;
}): Promise<{ metadata: SandboxDetailModel; steps: string[] }> {
  return request(`/api/sandboxes`, {
    method: 'POST',
    body: JSON.stringify({ image_source: 'host', ...payload }),
  });
}

/** 停止沙箱。 */
export function stopSandbox(name: string, stopDependencies = true): Promise<SandboxDetailModel> {
  return request(`/api/sandboxes/${encodeURIComponent(name)}/stop`, {
    method: 'POST',
    body: JSON.stringify({ stop_dependencies: stopDependencies }),
  });
}

/** 启动沙箱。 */
export function startSandbox(name: string): Promise<SandboxDetailModel> {
  return request(`/api/sandboxes/${encodeURIComponent(name)}/start`, { method: 'POST' });
}

/** 取删除前的回收清单。 */
export function reclaimPlan(name: string): Promise<ReclaimPlanModel> {
  return request(`/api/sandboxes/${encodeURIComponent(name)}/reclaim`);
}

/** 删除沙箱。 */
export function deleteSandbox(name: string): Promise<DeleteResultModel> {
  return request(`/api/sandboxes/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

/** 宿主本地镜像列表。 */
export function listImages(): Promise<
  { reference: string; image_id: string; size_bytes: number; created_at: string }[]
> {
  return request('/api/images');
}

/** 服务自检。 */
export function health(): Promise<{
  status: string;
  version: string;
  data_root_configured: boolean;
  console_mounted: boolean;
}> {
  return request('/api/health');
}

/** 列出全部启动模板。 */
export function listTemplates(): Promise<TemplateModel[]> {
  return request<TemplateModel[]>('/api/templates');
}

/** 创建启动模板（名称零限制，空名由前端交互拦）。 */
export function createTemplate(payload: {
  name: string;
  config: TemplateConfigModel;
}): Promise<TemplateModel> {
  return request('/api/templates', { method: 'POST', body: JSON.stringify(payload) });
}

/** 重命名启动模板：只改名称，标识与其余字段不动。 */
export function renameTemplate(id: string, name: string): Promise<TemplateModel> {
  return request(`/api/templates/${encodeURIComponent(id)}/rename`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

/** 删除启动模板。 */
export function deleteTemplate(id: string): Promise<{ id: string; deleted: boolean }> {
  return request(`/api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
