/**
 * 代理状态的文案转换。
 *
 * 后端给的是结构化字段（布尔 + 明细），页面要把它们翻译成人能直接判断的话。
 * 口径全部按后端契约：`ca_changed` = 变更前后都读得到证书且指纹不同；
 * `ca_reinstalled` = 合并证书链确实重装过（没修好不报成修好了）。
 */

import type { ProxyContainerStatus, ProxyRestartResult, ProxyStatus } from '../api/types';

/** 代理容器状态文案。 */
export function describeContainerState(container: ProxyContainerStatus): string {
  if (!container.exists) {
    return '容器不存在';
  }
  return container.running ? '运行中' : '已停止';
}

/** 代理健康状态文案。 */
export function describeHealth(healthy: boolean): string {
  return healthy ? '健康' : '不健康';
}

/** 证书就绪状态文案。 */
export function describeCertificate(ready: boolean): string {
  return ready ? '已就绪' : '未就绪';
}

/** 端口连通状态文案。 */
export function describeTcp(tcpOk: boolean): string {
  return tcpOk ? '可连接' : '不可连接';
}

/** CA 可取回状态文案。 */
export function describeCaFetchable(fetchable: boolean): string {
  return fetchable ? '可取回' : '不可取回';
}

/** 重启结果的中文结论。 */
export function describeRestartOutcome(result: ProxyRestartResult): string {
  if (!result.restarted) {
    return result.message || '重启未成功，原因见服务日志';
  }
  return result.message || '重启成功，代理已恢复健康';
}

/**
 * CA 重装结论。
 *
 * 三种口径如实区分：没变、变了且重装成功、变了但没重装成功。
 */
export function describeCaOutcome(result: ProxyRestartResult): string {
  if (!result.ca_changed) {
    return '代理 CA 指纹未变化，无需重装合并证书链';
  }
  if (result.ca_reinstalled) {
    const count = result.reinstalled_users.length;
    return `代理 CA 指纹已变更，已为 ${count} 个沙箱用户重装合并证书链`;
  }
  return '代理 CA 指纹已变更，但新 CA 读取失败，未能重装合并证书链';
}

/** 代理状态摘要（一行话）。 */
export function summarizeProxyStatus(status: ProxyStatus): string {
  return [
    `容器：${describeContainerState(status.container)}`,
    `健康：${describeHealth(status.healthy)}`,
    `证书：${describeCertificate(status.certificate_ready)}`,
  ].join(' · ');
}
