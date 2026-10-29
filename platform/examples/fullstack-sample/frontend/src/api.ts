/** 后端接口调用。全部走同源相对路径，由后端托管。 */

import type { RecordItem, UserInfo } from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body?.detail) {
        detail = body.detail;
      }
    } catch {
      // 响应体不是 JSON，用状态码兜底。
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

export function fetchMe(): Promise<{ user: UserInfo | null }> {
  return request('/api/me');
}

export function startLogin(): Promise<{ authorizeUrl: string }> {
  return request('/api/auth/login', { method: 'POST' });
}

export function exchangeCode(code: string, state: string): Promise<{ user: UserInfo }> {
  return request('/api/auth/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, state }),
  });
}

export function logout(): Promise<{ ok: boolean }> {
  return request('/api/auth/logout', { method: 'POST' });
}

export function fetchRecords(): Promise<{ records: RecordItem[] }> {
  return request('/api/records');
}

export function createRecord(form: FormData): Promise<{ record: RecordItem }> {
  return request('/api/records', { method: 'POST', body: form });
}

export function fileDownloadUrl(recordId: string): string {
  return `/api/records/${recordId}/file`;
}
