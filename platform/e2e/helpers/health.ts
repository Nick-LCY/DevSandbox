/**
 * 健康判据实现。
 *
 * 每个依赖一条明确的判据；判据不通过时抛出的错误里必须带依赖名与判据描述。
 */

import { DependencySpec } from './config';

/** HTTP 判据的单次请求超时（毫秒）。 */
const HTTP_PROBE_TIMEOUT_MS = 10_000;

/** 判据检查：不通过就抛错，错误信息里带依赖名与判据。 */
export async function checkDependency(dep: DependencySpec): Promise<void> {
  try {
    if (dep.type === 'http') {
      await checkHttp(dep);
      return;
    }
    throw new Error(`未知的判据类型：${dep.type}`);
  } catch (error) {
    throw new Error(
      `依赖「${dep.name}」未就绪；判据：${dep.criterion}；原因：${(error as Error).message}`,
    );
  }
}

async function checkHttp(dep: DependencySpec): Promise<void> {
  const response = await fetch(dep.url, { signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS) });
  if (response.status !== 200) {
    throw new Error(`HTTP 状态码 ${response.status}（期望 200）`);
  }
  if (dep.bodyIncludes) {
    const body = await response.text();
    if (!body.includes(dep.bodyIncludes)) {
      throw new Error(`响应体缺少片段：${dep.bodyIncludes}`);
    }
  }
}
