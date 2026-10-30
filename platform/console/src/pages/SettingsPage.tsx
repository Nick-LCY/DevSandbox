import { useCallback, useEffect, useState } from 'react';

import { api } from '../api/client';
import type { ProxyRestartResult, ProxyStatus } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import { formatBytes, formatTimestamp } from '../lib/format';
import {
  describeCaFetchable,
  describeCaOutcome,
  describeCertificate,
  describeContainerState,
  describeHealth,
  describeRestartOutcome,
  describeTcp,
} from '../lib/proxy';

/** 重启期间的提示文案：代理不可达时依赖镜像拉取失败是预期行为，不做降级。 */
const RESTARTING_NOTICE = '代理正在重启，重启期间依赖镜像拉取会失败，属预期行为。';

/** 代理设置页：状态展示 + 重启 + CA 重装结果。 */
export function SettingsPage() {
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [restart, setRestart] = useState<ProxyRestartResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api.proxyStatus());
      setError('');
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : '读取代理状态失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const restartProxy = useCallback(async () => {
    setRestarting(true);
    setError('');
    setRestart(null);
    try {
      const result = await api.restartProxy();
      setRestart(result);
      setStatus(result);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : '重启代理失败');
    } finally {
      setRestarting(false);
      // 重启后刷新一次状态：即使重启接口失败，状态页也拿到最新快照
      void load();
    }
  }, [load]);

  return (
    <section className="page">
      <div className="page-header">
        <h2 className="page-title" data-testid="page-settings-title">
          代理设置
        </h2>
        <div className="page-header-actions">
          <button
            type="button"
            className="button"
            onClick={() => void load()}
            disabled={loading || restarting}
            data-testid="page-settings-refresh-button"
          >
            刷新状态
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void restartProxy()}
            disabled={restarting}
            data-testid="page-settings-restart-button"
          >
            {restarting ? '正在重启…' : '重启代理'}
          </button>
        </div>
      </div>

      <ErrorBanner message={error} testId="page-settings-error-message" />

      {restarting && (
        <div className="banner banner-info" data-testid="page-settings-restarting-message">
          {RESTARTING_NOTICE}
        </div>
      )}

      {loading && !status && (
        <p className="hint" data-testid="page-settings-loading">
          正在读取代理状态…
        </p>
      )}

      {status && (
        <div className="panel">
          <div className="detail-grid">
            <div className="detail-item">
              <span className="detail-label">容器运行状态</span>
              <span className="detail-value" data-testid="page-settings-container-running">
                {describeContainerState(status.container)}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">健康状态</span>
              <span className="detail-value" data-testid="page-settings-healthy">
                {describeHealth(status.healthy)}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">端口连通</span>
              <span className="detail-value" data-testid="page-settings-tcp-ok">
                {describeTcp(status.tcp_ok)}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">CA 证书可取回</span>
              <span className="detail-value" data-testid="page-settings-ca-fetchable">
                {describeCaFetchable(status.ca_fetchable)}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">缓存目录占用</span>
              <span className="detail-value" data-testid="page-settings-cache-size">
                {formatBytes(status.cache_size_bytes)}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">证书就绪状态</span>
              <span className="detail-value" data-testid="page-settings-certificate-ready">
                {describeCertificate(status.certificate_ready)}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">代理访问地址</span>
              <span className="detail-value" data-testid="page-settings-proxy-url">
                {status.proxy_url}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">状态明细</span>
              <span className="detail-value" data-testid="page-settings-detail">
                {status.detail}
              </span>
            </div>
          </div>
          <p className="hint">
            代理缓存只增不减，页面只展示占用大小，不提供清理入口。
          </p>
        </div>
      )}

      {restart && (
        <div className="panel" data-testid="page-settings-restart-result">
          <div className="detail-grid">
            <div className="detail-item">
              <span className="detail-label">重启结果</span>
              <span className="detail-value" data-testid="page-settings-restarted">
                {restart.restarted ? '已重启并恢复健康' : '重启未成功'}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">结论</span>
              <span className="detail-value" data-testid="page-settings-restart-message">
                {describeRestartOutcome(restart)}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">CA 指纹是否变更</span>
              <span className="detail-value" data-testid="page-settings-ca-changed">
                {restart.ca_changed ? '已变更' : '未变更'}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">合并证书链是否重装</span>
              <span className="detail-value" data-testid="page-settings-ca-reinstalled">
                {restart.ca_reinstalled ? '已重装' : '未重装'}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">CA 处理结论</span>
              <span className="detail-value" data-testid="page-settings-ca-conclusion">
                {describeCaOutcome(restart)}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">已重装用户</span>
              <span className="detail-value" data-testid="page-settings-reinstalled-users">
                {restart.reinstalled_users.length > 0
                  ? restart.reinstalled_users.join('、')
                  : '（无）'}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">重装失败用户</span>
              <span className="detail-value" data-testid="page-settings-failed-users">
                {restart.failed_users.length > 0 ? restart.failed_users.join('、') : '（无）'}
              </span>
            </div>
          </div>
          <p className="hint">代理状态采集时间：{formatTimestamp(new Date().toISOString())}</p>
        </div>
      )}
    </section>
  );
}
