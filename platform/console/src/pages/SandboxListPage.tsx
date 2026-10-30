import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../api/client';
import type { ReclaimPlan, SandboxSummary } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import { ReclaimDialog } from '../components/ReclaimDialog';
import { actionBannerClass, type ActionMessage } from '../lib/action';
import { formatTimestamp } from '../lib/format';
import { sandboxDetailHash } from '../lib/router';

/** 列表轮询间隔（毫秒）。 */
const POLL_INTERVAL = 5000;

/** 沙箱列表页：名字 / 状态 / 镜像 / 创建时间 + 行内操作。 */
export function SandboxListPage() {
  const [sandboxes, setSandboxes] = useState<SandboxSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionMessage, setActionMessage] = useState<ActionMessage | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [plan, setPlan] = useState<ReclaimPlan | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async (silent: boolean) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    if (!silent) {
      setLoading(true);
    }
    try {
      const list = await api.listSandboxes();
      if (requestId !== requestIdRef.current) {
        return;
      }
      setSandboxes(list);
      setError('');
      setUpdatedAt(new Date().toISOString());
    } catch (exc) {
      if (requestId !== requestIdRef.current) {
        return;
      }
      setError(exc instanceof Error ? exc.message : '读取沙箱列表失败');
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void load(false);
    const timer = window.setInterval(() => {
      void load(true);
    }, POLL_INTERVAL);
    return () => window.clearInterval(timer);
  }, [load]);

  const start = useCallback(
    async (name: string) => {
      setBusyName(name);
      setActionMessage(null);
      try {
        await api.startSandbox(name);
        setActionMessage({ kind: 'success', text: `沙箱 ${name} 已启动` });
        await load(true);
      } catch (exc) {
        setActionMessage({
          kind: 'error',
          text: exc instanceof Error ? exc.message : `启动沙箱 ${name} 失败`,
        });
      } finally {
        setBusyName(null);
      }
    },
    [load],
  );

  const stop = useCallback(
    async (name: string) => {
      setBusyName(name);
      setActionMessage(null);
      try {
        await api.stopSandbox(name);
        setActionMessage({ kind: 'success', text: `沙箱 ${name} 已停止` });
        await load(true);
      } catch (exc) {
        setActionMessage({
          kind: 'error',
          text: exc instanceof Error ? exc.message : `停止沙箱 ${name} 失败`,
        });
      } finally {
        setBusyName(null);
      }
    },
    [load],
  );

  /** 删除前先取回收清单；清单拿不到就不进确认环节。 */
  const openDelete = useCallback(async (name: string) => {
    setBusyName(name);
    setActionMessage(null);
    try {
      const reclaimPlan = await api.reclaimSandbox(name);
      setPlan(reclaimPlan);
    } catch (exc) {
      setActionMessage({
        kind: 'error',
        text: exc instanceof Error ? exc.message : `读取回收清单失败：${name}`,
      });
    } finally {
      setBusyName(null);
    }
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!plan) {
      return;
    }
    setDeleting(true);
    try {
      const result = await api.deleteSandbox(plan.sandbox_name);
      setPlan(null);
      const removed = result.removed.length;
      const failed = result.failed.length;
      setActionMessage({
        kind: failed > 0 ? 'error' : 'success',
        text:
          failed > 0
            ? `沙箱 ${result.name} 已删除：回收 ${removed} 项，${failed} 项失败`
            : `沙箱 ${result.name} 已删除：回收 ${removed} 项`,
      });
      await load(true);
    } catch (exc) {
      setActionMessage({
        kind: 'error',
        text: exc instanceof Error ? exc.message : '删除沙箱失败',
      });
    } finally {
      setDeleting(false);
    }
  }, [plan, load]);

  return (
    <section className="page">
      <div className="page-header">
        <h2 className="page-title" data-testid="page-sandbox-list-title">
          沙箱列表
        </h2>
        <div className="page-header-actions">
          <span className="hint" data-testid="page-sandbox-list-updated-at">
            {updatedAt ? `上次刷新 ${formatTimestamp(updatedAt)}` : '尚未刷新'}
          </span>
          <button
            type="button"
            className="button"
            onClick={() => void load(false)}
            disabled={loading}
            data-testid="page-sandbox-list-refresh-button"
          >
            刷新
          </button>
          <a className="button button-primary" href="#/new" data-testid="page-sandbox-list-create-button">
            新建沙箱
          </a>
        </div>
      </div>

      <ErrorBanner message={error} testId="page-sandbox-list-error-message" />
      {actionMessage && (
        <div
          className={actionBannerClass(actionMessage.kind)}
          data-testid="page-sandbox-list-action-message"
          data-action-kind={actionMessage.kind}
        >
          {actionMessage.text}
        </div>
      )}

      {loading && sandboxes.length === 0 && (
        <p className="hint" data-testid="page-sandbox-list-loading">
          正在读取沙箱列表…
        </p>
      )}

      {!loading && sandboxes.length === 0 && !error && (
        <p className="hint" data-testid="page-sandbox-list-empty">
          还没有沙箱。点「新建沙箱」从宿主本地镜像里选一个开始。
        </p>
      )}

      {sandboxes.length > 0 && (
        <table className="table" data-testid="page-sandbox-list-table">
          <thead>
            <tr>
              <th>名字</th>
              <th>状态</th>
              <th>镜像</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {sandboxes.map((item) => {
              const running = item.state === 'running';
              const busy = busyName === item.name;
              return (
                <tr
                  key={item.name}
                  data-testid="page-sandbox-list-item"
                  data-sandbox-name={item.name}
                  data-sandbox-state={item.state}
                >
                  <td data-testid="page-sandbox-list-item-name">
                    <a
                      href={sandboxDetailHash(item.name)}
                      data-testid="page-sandbox-list-item-name-link"
                    >
                      {item.name}
                    </a>
                  </td>
                  <td data-testid="page-sandbox-list-item-state">{item.state_label}</td>
                  <td data-testid="page-sandbox-list-item-image">{item.image}</td>
                  <td data-testid="page-sandbox-list-item-created-at">
                    {formatTimestamp(item.created_at)}
                  </td>
                  <td className="table-actions">
                    <button
                      type="button"
                      className="button button-small"
                      onClick={() => void start(item.name)}
                      disabled={running || busy}
                      data-testid="page-sandbox-list-item-start-button"
                    >
                      启动
                    </button>
                    <button
                      type="button"
                      className="button button-small"
                      onClick={() => void stop(item.name)}
                      disabled={!running || busy}
                      data-testid="page-sandbox-list-item-stop-button"
                    >
                      停止
                    </button>
                    <a
                      className="button button-small"
                      href={sandboxDetailHash(item.name)}
                      data-testid="page-sandbox-list-item-detail-button"
                    >
                      详情
                    </a>
                    <button
                      type="button"
                      className="button button-small button-danger"
                      onClick={() => void openDelete(item.name)}
                      disabled={busy}
                      data-testid="page-sandbox-list-item-delete-button"
                    >
                      删除
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {plan && (
        <ReclaimDialog
          plan={plan}
          testIdPrefix="page-sandbox-list-delete"
          busy={deleting}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPlan(null)}
        />
      )}
    </section>
  );
}
