import { describe, expect, it } from 'vitest';

import type { ProxyRestartResult, ProxyStatus } from '../api/types';
import {
  describeCaOutcome,
  describeCertificate,
  describeContainerState,
  describeHealth,
  describeRestartOutcome,
  describeTcp,
} from './proxy';

const BASE_STATUS: ProxyStatus = {
  container: { exists: true, running: true },
  healthy: true,
  tcp_ok: true,
  ca_fetchable: true,
  detail: '代理容器运行中，端口可连，CA 证书可取回',
  cache_size_bytes: 1024,
  certificate_ready: true,
  proxy_url: 'http://127.0.0.1:3128',
};

function restartResult(patch: Partial<ProxyRestartResult>): ProxyRestartResult {
  return {
    ...BASE_STATUS,
    restarted: true,
    ca_changed: false,
    ca_reinstalled: false,
    message: '重启成功',
    reinstalled_users: [],
    failed_users: [],
    ...patch,
  };
}

describe('状态文案', () => {
  it('容器不存在与运行中分别说明', () => {
    expect(describeContainerState({ exists: false, running: false })).toBe('容器不存在');
    expect(describeContainerState({ exists: true, running: true })).toBe('运行中');
    expect(describeContainerState({ exists: true, running: false })).toBe('已停止');
  });

  it('健康、证书与端口状态各自成词', () => {
    expect(describeHealth(true)).toBe('健康');
    expect(describeHealth(false)).toBe('不健康');
    expect(describeCertificate(false)).toBe('未就绪');
    expect(describeTcp(false)).toBe('不可连接');
  });
});

describe('describeCaOutcome', () => {
  it('CA 没变时说无需重装', () => {
    expect(describeCaOutcome(restartResult({ ca_changed: false }))).toContain('未变化');
  });

  it('CA 变了且重装成功时给出用户数', () => {
    const outcome = describeCaOutcome(
      restartResult({ ca_changed: true, ca_reinstalled: true, reinstalled_users: ['sandbox-a'] }),
    );
    expect(outcome).toContain('已变更');
    expect(outcome).toContain('1 个沙箱用户');
  });

  it('CA 变了但没重装成功时不报成已修复', () => {
    const outcome = describeCaOutcome(
      restartResult({ ca_changed: true, ca_reinstalled: false, failed_users: ['sandbox-a'] }),
    );
    expect(outcome).toContain('未能重装');
  });
});

describe('describeRestartOutcome', () => {
  it('重启未成功时用后端给的结论', () => {
    const outcome = describeRestartOutcome(
      restartResult({ restarted: false, message: '重启未成功，原因见服务日志' }),
    );
    expect(outcome).toContain('重启未成功');
  });

  it('重启成功时用后端给的结论', () => {
    expect(describeRestartOutcome(restartResult({ message: '重启成功，代理已恢复健康' }))).toBe(
      '重启成功，代理已恢复健康',
    );
  });
});
