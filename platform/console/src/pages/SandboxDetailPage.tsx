import { useCallback, useEffect, useState } from 'react';

import { api } from '../api/client';
import type { ReclaimPlan, SandboxDetail } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import { ReclaimDialog } from '../components/ReclaimDialog';
import { TerminalPanel } from '../components/TerminalPanel';
import { actionBannerClass, type ActionMessage } from '../lib/action';
import { formatBoolean, formatTimestamp, orPlaceholder } from '../lib/format';

/** 沙箱详情页：完整信息 + 生命周期操作 + 网页终端面板。 */
export function SandboxDetailPage({ sandboxName }: { sandboxName: string }) {
  const [detail, setDetail] = useState<SandboxDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionMessage, setActionMessage] = useState<ActionMessage | null>(null);
  const [plan, setPlan] = useState<ReclaimPlan | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopDependencies, setStopDependencies] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const found = await api.getSandbox(sandboxName);
      setDetail(found);
      setError('');
    } catch (exc) {
      setDetail(null);
      setError(exc instanceof Error ? exc.message : '读取沙箱详情失败');
    } finally {
      setLoading(false);
    }
  }, [sandboxName]);

  useEffect(() => {
    void load();
  }, [load]);

  const start = useCallback(async () => {
    setBusy(true);
    setActionMessage(null);
    try {
      const updated = await api.startSandbox(sandboxName);
      setDetail(updated);
      setActionMessage({ kind: 'success', text: `沙箱 ${sandboxName} 已启动` });
    } catch (exc) {
      setActionMessage({
        kind: 'error',
        text: exc instanceof Error ? exc.message : '启动沙箱失败',
      });
    } finally {
      setBusy(false);
    }
  }, [sandboxName]);

  const stop = useCallback(async () => {
    setBusy(true);
    setActionMessage(null);
    try {
      const updated = await api.stopSandbox(sandboxName, stopDependencies);
      setDetail(updated);
      setActionMessage({ kind: 'success', text: `沙箱 ${sandboxName} 已停止` });
    } catch (exc) {
      setActionMessage({
        kind: 'error',
        text: exc instanceof Error ? exc.message : '停止沙箱失败',
      });
    } finally {
      setBusy(false);
    }
  }, [sandboxName, stopDependencies]);

  /** 删除前先取回收清单并弹窗确认。 */
  const openDelete = useCallback(async () => {
    setBusy(true);
    setActionMessage(null);
    try {
      setPlan(await api.reclaimSandbox(sandboxName));
    } catch (exc) {
      setActionMessage({
        kind: 'error',
        text: exc instanceof Error ? exc.message : '读取回收清单失败',
      });
    } finally {
      setBusy(false);
    }
  }, [sandboxName]);

  const confirmDelete = useCallback(async () => {
    if (!plan) {
      return;
    }
    setDeleting(true);
    try {
      const result = await api.deleteSandbox(plan.sandbox_name);
      setPlan(null);
      const failed = result.failed.length;
      setActionMessage({
        kind: failed > 0 ? 'error' : 'success',
        text:
          failed > 0
            ? `沙箱 ${result.name} 已删除：回收 ${result.removed.length} 项，${failed} 项失败`
            : `沙箱 ${result.name} 已删除：回收 ${result.removed.length} 项`,
      });
      window.location.hash = '#/';
    } catch (exc) {
      setActionMessage({
        kind: 'error',
        text: exc instanceof Error ? exc.message : '删除沙箱失败',
      });
    } finally {
      setDeleting(false);
    }
  }, [plan]);

  const running = detail?.state === 'running';

  return (
    <section className="page">
      <div className="page-header">
        <h2 className="page-title" data-testid="page-sandbox-detail-title">
          沙箱 {sandboxName}
        </h2>
        <div className="page-header-actions">
          <a className="button" href="#/" data-testid="page-sandbox-detail-back-button">
            返回列表
          </a>
          <button
            type="button"
            className="button"
            onClick={() => void load()}
            disabled={loading}
            data-testid="page-sandbox-detail-refresh-button"
          >
            刷新
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void start()}
            disabled={busy || running}
            data-testid="page-sandbox-detail-start-button"
          >
            启动
          </button>
          <button
            type="button"
            className="button"
            onClick={() => void stop()}
            disabled={busy || !running}
            data-testid="page-sandbox-detail-stop-button"
          >
            停止
          </button>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={stopDependencies}
              onChange={(event) => setStopDependencies(event.target.checked)}
              data-testid="page-sandbox-detail-stop-dependencies-checkbox"
            />
            同时停止依赖容器
          </label>
          <button
            type="button"
            className="button button-danger"
            onClick={() => void openDelete()}
            disabled={busy}
            data-testid="page-sandbox-detail-delete-button"
          >
            删除
          </button>
        </div>
      </div>

      <ErrorBanner message={error} testId="page-sandbox-detail-error-message" />
      {actionMessage && (
        <div
          className={actionBannerClass(actionMessage.kind)}
          data-testid="page-sandbox-detail-action-message"
          data-action-kind={actionMessage.kind}
        >
          {actionMessage.text}
        </div>
      )}

      {loading && !detail && (
        <p className="hint" data-testid="page-sandbox-detail-loading">
          正在读取沙箱详情…
        </p>
      )}

      {detail && (
        <>
          <div className="panel">
            <div className="detail-grid">
              <div className="detail-item">
                <span className="detail-label">状态</span>
                <span className="detail-value" data-testid="page-sandbox-detail-state">
                  {detail.state_label}
                </span>
              </div>
              <div className="detail-item">
                <span className="detail-label">镜像</span>
                <span className="detail-value" data-testid="page-sandbox-detail-image">
                  {detail.image}
                </span>
              </div>
              <div className="detail-item">
                <span className="detail-label">镜像来源</span>
                <span className="detail-value" data-testid="page-sandbox-detail-image-source">
                  {detail.image_source}
                </span>
              </div>
              <div className="detail-item">
                <span className="detail-label">系统用户</span>
                <span className="detail-value" data-testid="page-sandbox-detail-system-user">
                  {detail.system_user}
                </span>
              </div>
              <div className="detail-item">
                <span className="detail-label">容器名</span>
                <span className="detail-value" data-testid="page-sandbox-detail-container-name">
                  {detail.container_name}
                </span>
              </div>
              <div className="detail-item">
                <span className="detail-label">网桥网络</span>
                <span className="detail-value" data-testid="page-sandbox-detail-network-name">
                  {detail.network_name}
                  {detail.network_owned ? '（平台自建，删除时回收）' : '（用户指定，不回收）'}
                </span>
              </div>
              <div className="detail-item">
                <span className="detail-label">创建时间</span>
                <span className="detail-value" data-testid="page-sandbox-detail-created-at">
                  {formatTimestamp(detail.created_at)}
                </span>
              </div>
              <div className="detail-item">
                <span className="detail-label">更新时间</span>
                <span className="detail-value" data-testid="page-sandbox-detail-updated-at">
                  {formatTimestamp(detail.updated_at)}
                </span>
              </div>
              <div className="detail-item">
                <span className="detail-label">套接字路径</span>
                <span className="detail-value" data-testid="page-sandbox-detail-socket-path">
                  {detail.socket_path}
                </span>
              </div>
              <div className="detail-item">
                <span className="detail-label">容器内挂载点</span>
                <span className="detail-value" data-testid="page-sandbox-detail-socket-mount-path">
                  {detail.socket_mount_path}
                </span>
              </div>
              <div className="detail-item">
                <span className="detail-label">工作目录</span>
                <span className="detail-value" data-testid="page-sandbox-detail-workdir">
                  {orPlaceholder(detail.workdir)}
                </span>
              </div>
              <div className="detail-item">
                <span className="detail-label">启动命令</span>
                <span className="detail-value" data-testid="page-sandbox-detail-command">
                  {detail.command.length > 0 ? detail.command.join(' ') : orPlaceholder('')}
                </span>
              </div>
              <div className="detail-item">
                <span className="detail-label">子 ID 段</span>
                <span className="detail-value" data-testid="page-sandbox-detail-subid">
                  {detail.subid_start} 起 {detail.subid_length} 个
                </span>
              </div>
              <div className="detail-item">
                <span className="detail-label">网络由平台自建</span>
                <span className="detail-value" data-testid="page-sandbox-detail-network-owned">
                  {formatBoolean(detail.network_owned)}
                </span>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <h3 className="panel-title">环境变量</h3>
              <span className="hint">值已脱敏，只显示键名</span>
            </div>
            {Object.keys(detail.env).length === 0 ? (
              <p className="hint" data-testid="page-sandbox-detail-env-empty">
                （无环境变量）
              </p>
            ) : (
              <ul className="plain-list" data-testid="page-sandbox-detail-env">
                {Object.keys(detail.env).map((key) => (
                  <li key={key} data-testid="page-sandbox-detail-env-item">
                    {key}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="panel">
            <div className="panel-header">
              <h3 className="panel-title">挂载</h3>
            </div>
            {detail.mounts.length === 0 ? (
              <p className="hint" data-testid="page-sandbox-detail-mounts-empty">
                （无挂载）
              </p>
            ) : (
              <ul className="plain-list" data-testid="page-sandbox-detail-mounts">
                {detail.mounts.map((mount) => (
                  <li key={`${mount.role}:${mount.container_path}`} data-testid="page-sandbox-detail-mount-item">
                    {mount.host_path} → {mount.container_path}
                    {mount.read_only ? '（只读）' : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="panel">
            <div className="panel-header">
              <h3 className="panel-title">依赖容器</h3>
            </div>
            {detail.dependency_containers.length === 0 ? (
              <p className="hint" data-testid="page-sandbox-detail-dependencies-empty">
                （无依赖容器）
              </p>
            ) : (
              <ul className="plain-list" data-testid="page-sandbox-detail-dependencies">
                {detail.dependency_containers.map((name) => (
                  <li key={name} data-testid="page-sandbox-detail-dependency-item">
                    {name}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <TerminalPanel sandboxName={sandboxName} sandboxRunning={running} />
        </>
      )}

      {plan && (
        <ReclaimDialog
          plan={plan}
          testIdPrefix="page-sandbox-detail-delete"
          busy={deleting}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPlan(null)}
        />
      )}
    </section>
  );
}
