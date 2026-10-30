import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../api/client';
import type { ReclaimPlan, SandboxDetail, SandboxSummary } from '../../api/types';
import { ErrorBanner } from '../ErrorBanner';
import { TerminalPanel } from '../TerminalPanel';
import { actionBannerClass, type ActionMessage } from '../../lib/action';
import { useNavigate, useRoute } from '../../lib/router';
import { AppShell, type HealthView } from './AppShell';
import { CreateSandboxDialog } from './CreateSandboxDialog';
import { DeleteSandboxDialog } from './DeleteSandboxDialog';
import { EmptyState } from './EmptyState';
import { ProxySettingsDialog } from './ProxySettingsDialog';
import { SandboxDetailDialog } from './SandboxDetailDialog';
import { WorkspaceHeader } from './WorkspaceHeader';

/** 沙箱列表轮询间隔（毫秒）。 */
const POLL_INTERVAL = 5000;

/** 后端健康自检的轮询间隔（毫秒）。 */
const HEALTH_POLL_INTERVAL = 15000;

/**
 * 工作台：单页总装与状态中枢。
 *
 * 左侧边栏是沙箱列表，右侧工作区是选中沙箱的摘要与终端会话标签；
 * 新建沙箱 / 沙箱详情 / 代理设置都是弹窗（开关状态不入路由）。
 *
 * 选中的沙箱与当前终端会话都来自路由（`#/sandboxes/<名>[/<会话标识>]`）：
 * 刷新页面或把链接发给别人，能落到同一个位置。
 */
export function Workbench() {
  const route = useRoute();
  const navigate = useNavigate();

  const [sandboxes, setSandboxes] = useState<SandboxSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [actionMessage, setActionMessage] = useState<ActionMessage | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const [detail, setDetail] = useState<SandboxDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stopDependencies, setStopDependencies] = useState(true);

  const [health, setHealth] = useState<HealthView>({
    state: 'checking',
    text: '正在检查后端服务…',
  });

  const [plan, setPlan] = useState<ReclaimPlan | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [proxyOpen, setProxyOpen] = useState(false);

  const requestIdRef = useRef(0);

  /** 当前选中的沙箱名（没选中时为 null）。 */
  const selectedName = route.name === 'workbench-sandbox' ? route.sandboxName : null;
  /** 当前选中的终端会话标识。 */
  const activeSessionId = route.name === 'workbench-sandbox' ? route.sessionId : null;

  /* ------------------------------------------------------------------ 列表 */

  const loadList = useCallback(async (silent: boolean) => {
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
      setListError('');
      setUpdatedAt(new Date().toISOString());
    } catch (exc) {
      if (requestId !== requestIdRef.current) {
        return;
      }
      setListError(exc instanceof Error ? exc.message : '读取沙箱列表失败');
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadList(false);
    const timer = window.setInterval(() => {
      void loadList(true);
    }, POLL_INTERVAL);
    return () => window.clearInterval(timer);
  }, [loadList]);

  /* ------------------------------------------------------------------ 健康 */

  useEffect(() => {
    let cancelled = false;

    const check = async (): Promise<void> => {
      let view: HealthView;
      try {
        const result = await api.health();
        if (!result.console_mounted) {
          view = { state: 'degraded', text: `服务正常（v${result.version}），前端产物未挂载` };
        } else {
          view = { state: 'ok', text: `服务正常（v${result.version}）` };
        }
      } catch (exc) {
        const reason = exc instanceof Error ? exc.message : '无法连接后端服务';
        view = { state: 'down', text: `后端服务不可达：${reason}` };
      }
      if (!cancelled) {
        setHealth(view);
      }
    };

    void check();
    const timer = window.setInterval(() => {
      void check();
    }, HEALTH_POLL_INTERVAL);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  /* ------------------------------------------------------------------ 详情 */

  const loadDetail = useCallback(async (name: string) => {
    setDetailLoading(true);
    try {
      const found = await api.getSandbox(name);
      setDetail(found);
      setDetailError('');
    } catch (exc) {
      setDetail(null);
      setDetailError(exc instanceof Error ? exc.message : '读取沙箱详情失败');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedName) {
      setDetail(null);
      setDetailError('');
      return;
    }
    void loadDetail(selectedName);
  }, [selectedName, loadDetail]);

  /* -------------------------------------------------------------- 生命周期 */

  const start = useCallback(async () => {
    if (!selectedName) {
      return;
    }
    setBusy(true);
    setActionMessage(null);
    try {
      const updated = await api.startSandbox(selectedName);
      setDetail(updated);
      setActionMessage({ kind: 'success', text: `沙箱 ${selectedName} 已启动` });
      await loadList(true);
    } catch (exc) {
      setActionMessage({
        kind: 'error',
        text: exc instanceof Error ? exc.message : '启动沙箱失败',
      });
    } finally {
      setBusy(false);
    }
  }, [selectedName, loadList]);

  const stop = useCallback(async () => {
    if (!selectedName) {
      return;
    }
    setBusy(true);
    setActionMessage(null);
    try {
      const updated = await api.stopSandbox(selectedName, stopDependencies);
      setDetail(updated);
      setActionMessage({ kind: 'success', text: `沙箱 ${selectedName} 已停止` });
      await loadList(true);
    } catch (exc) {
      setActionMessage({
        kind: 'error',
        text: exc instanceof Error ? exc.message : '停止沙箱失败',
      });
    } finally {
      setBusy(false);
    }
  }, [selectedName, stopDependencies, loadList]);

  /** 删除前先取回收清单；清单拿不到就不进确认环节。 */
  const openDelete = useCallback(async () => {
    if (!selectedName) {
      return;
    }
    setBusy(true);
    setActionMessage(null);
    try {
      setPlan(await api.reclaimSandbox(selectedName));
    } catch (exc) {
      setActionMessage({
        kind: 'error',
        text: exc instanceof Error ? exc.message : '读取回收清单失败',
      });
    } finally {
      setBusy(false);
    }
  }, [selectedName]);

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
      // 沙箱没了：选中态与终端会话一起回到工作台首页。
      navigate({ name: 'workbench' });
      await loadList(true);
    } catch (exc) {
      setActionMessage({
        kind: 'error',
        text: exc instanceof Error ? exc.message : '删除沙箱失败',
      });
    } finally {
      setDeleting(false);
    }
  }, [plan, navigate, loadList]);

  /* ------------------------------------------------------------------ 导航 */

  const selectSandbox = useCallback(
    (name: string) => {
      // 已经选中的沙箱再点一次不改路由：否则会把已选中的终端会话重置掉。
      if (name === selectedName) {
        return;
      }
      navigate({ name: 'workbench-sandbox', sandboxName: name, sessionId: null });
    },
    [navigate, selectedName],
  );

  const selectSession = useCallback(
    (sessionId: string | null) => {
      if (!selectedName) {
        return;
      }
      navigate({ name: 'workbench-sandbox', sandboxName: selectedName, sessionId });
    },
    [navigate, selectedName],
  );

  const running = detail?.state === 'running';

  return (
    <AppShell
      sandboxes={sandboxes}
      selectedName={selectedName}
      health={health}
      error={listError}
      loading={loading}
      updatedAt={updatedAt}
      refreshing={loading}
      onSelectSandbox={selectSandbox}
      onCreateClick={() => setCreateOpen(true)}
      onProxyClick={() => setProxyOpen(true)}
      onRefresh={() => void loadList(false)}
    >
      {actionMessage && (
        <div className="px-6 pt-4">
          <div
            className={actionBannerClass(actionMessage.kind)}
            data-testid="page-sandbox-list-action-message"
            data-action-kind={actionMessage.kind}
          >
            {actionMessage.text}
          </div>
        </div>
      )}

      {selectedName ? (
        <>
          {detailError && (
            <div className="px-6 pt-4">
              <ErrorBanner message={detailError} testId="page-sandbox-detail-error-message" />
            </div>
          )}
          <WorkspaceHeader
            detail={detail}
            busy={busy}
            stopDependencies={stopDependencies}
            onStopDependenciesChange={setStopDependencies}
            onRefresh={() => void loadDetail(selectedName)}
            onStart={() => void start()}
            onStop={() => void stop()}
            onOpenDetail={() => setDetailOpen(true)}
            onDelete={() => void openDelete()}
          />
          <TerminalPanel
            sandboxName={selectedName}
            sandboxRunning={running}
            activeSessionId={activeSessionId}
            onActiveSessionChange={selectSession}
          />
        </>
      ) : (
        <EmptyState onCreateClick={() => setCreateOpen(true)} />
      )}

      <CreateSandboxDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(name) => {
          setActionMessage({ kind: 'success', text: `沙箱 ${name} 已创建` });
          void loadList(true);
          selectSandbox(name);
        }}
      />

      <SandboxDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        detail={detail}
        loading={detailLoading}
        error={detailError}
      />

      <ProxySettingsDialog open={proxyOpen} onOpenChange={setProxyOpen} />

      <DeleteSandboxDialog
        open={plan !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPlan(null);
          }
        }}
        plan={plan}
        busy={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </AppShell>
  );
}
