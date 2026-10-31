import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../api/client';
import type { ReclaimPlan, SandboxDetail, SandboxSummary } from '../../api/types';
import { nextPollFailure } from '../../lib/poll';
import { TerminalPanel } from '../TerminalPanel';
import { useToast } from '../Toast';
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
  const { show } = useToast();

  const [sandboxes, setSandboxes] = useState<SandboxSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const [detail, setDetail] = useState<SandboxDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
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
  /** 详情请求的序号：旧响应回来时直接丢弃，不许覆盖新沙箱的头部。 */
  const detailRequestIdRef = useRef(0);
  /** 后台轮询连续失败次数：到阈值弹一条失败 toast，任一次成功即清零。 */
  const pollFailuresRef = useRef(0);

  /** 当前选中的沙箱名（没选中时为 null）。 */
  const selectedName = route.name === 'workbench-sandbox' ? route.sandboxName : null;
  /** 当前选中的终端会话标识。 */
  const activeSessionId = route.name === 'workbench-sandbox' ? route.sessionId : null;

  /* ------------------------------------------------------------------ 列表 */

  const loadList = useCallback(
    async (silent: boolean) => {
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
        // 拉到了就清零：连续失败计数只统计「连续」。
        pollFailuresRef.current = nextPollFailure(pollFailuresRef.current, true).count;
      } catch (exc) {
        if (requestId !== requestIdRef.current) {
          return;
        }
        const message = exc instanceof Error ? exc.message : '读取沙箱列表失败';
        if (!silent) {
          // 首次加载失败：立刻弹失败 toast，侧栏回落到空态展示。
          show('error', message, { source: 'sandbox-list' });
          return;
        }
        // 后台轮询失败：逐次弹会刷屏，连续 3 次才弹一条。
        // （后端整体不可达时侧栏底部的健康自检已经常驻提示，这里兜的是端点级失败。）
        const step = nextPollFailure(pollFailuresRef.current, false);
        pollFailuresRef.current = step.count;
        if (step.shouldToast) {
          show('error', `读取沙箱列表失败（连续 3 次轮询）：${message}`, {
            source: 'sandbox-list',
          });
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [show],
  );

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
    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    setDetailLoading(true);
    try {
      const found = await api.getSandbox(name);
      if (requestId !== detailRequestIdRef.current) {
        return;
      }
      setDetail(found);
    } catch (exc) {
      if (requestId !== detailRequestIdRef.current) {
        return;
      }
      setDetail(null);
      // 详情读取失败：弹失败 toast，工作区回落到空态展示。
      show('error', exc instanceof Error ? exc.message : '读取沙箱详情失败', {
        source: 'sandbox-detail',
      });
    } finally {
      if (requestId === detailRequestIdRef.current) {
        setDetailLoading(false);
      }
    }
  }, [show]);

  useEffect(() => {
    if (!selectedName) {
      setDetail(null);
      return;
    }
    // 换沙箱：先把上一个沙箱的详情清掉，别让头部串台；
    // 在途的旧请求由 loadDetail 的请求序号护栏丢弃。
    setDetail(null);
    void loadDetail(selectedName);
  }, [selectedName, loadDetail]);

  /* -------------------------------------------------------------- 生命周期 */

  const start = useCallback(async () => {
    if (!selectedName) {
      return;
    }
    setBusy(true);
    try {
      const updated = await api.startSandbox(selectedName);
      setDetail(updated);
      show('success', `沙箱 ${selectedName} 已启动`, { source: 'sandbox-lifecycle' });
      await loadList(true);
    } catch (exc) {
      show('error', exc instanceof Error ? exc.message : '启动沙箱失败', {
        source: 'sandbox-lifecycle',
      });
    } finally {
      setBusy(false);
    }
  }, [selectedName, loadList, show]);

  const stop = useCallback(async () => {
    if (!selectedName) {
      return;
    }
    setBusy(true);
    try {
      const updated = await api.stopSandbox(selectedName, stopDependencies);
      setDetail(updated);
      show('success', `沙箱 ${selectedName} 已停止`, { source: 'sandbox-lifecycle' });
      await loadList(true);
    } catch (exc) {
      show('error', exc instanceof Error ? exc.message : '停止沙箱失败', {
        source: 'sandbox-lifecycle',
      });
    } finally {
      setBusy(false);
    }
  }, [selectedName, stopDependencies, loadList, show]);

  /** 删除前先取回收清单；清单拿不到就不进确认环节。 */
  const openDelete = useCallback(async () => {
    if (!selectedName) {
      return;
    }
    setBusy(true);
    try {
      setPlan(await api.reclaimSandbox(selectedName));
    } catch (exc) {
      show('error', exc instanceof Error ? exc.message : '读取回收清单失败', {
        source: 'sandbox-reclaim',
      });
    } finally {
      setBusy(false);
    }
  }, [selectedName, show]);

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
      show(
        failed > 0 ? 'error' : 'success',
        failed > 0
          ? `沙箱 ${result.name} 已删除：回收 ${removed} 项，${failed} 项失败`
          : `沙箱 ${result.name} 已删除：回收 ${removed} 项`,
        { source: 'sandbox-delete' },
      );
      // 沙箱没了：选中态与终端会话一起回到工作台首页。
      navigate({ name: 'workbench' });
      await loadList(true);
    } catch (exc) {
      show('error', exc instanceof Error ? exc.message : '删除沙箱失败', {
        source: 'sandbox-delete',
      });
    } finally {
      setDeleting(false);
    }
  }, [plan, navigate, loadList, show]);

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

  /** 关掉删除确认弹窗：回收清单作废。 */
  const closeDeleteDialog = useCallback((open: boolean) => {
    if (!open) {
      setPlan(null);
    }
  }, []);

  const running = detail?.state === 'running';

  return (
    <AppShell
      sandboxes={sandboxes}
      selectedName={selectedName}
      health={health}
      loading={loading}
      refreshing={loading}
      onSelectSandbox={selectSandbox}
      onCreateClick={() => setCreateOpen(true)}
      onProxyClick={() => setProxyOpen(true)}
      onRefresh={() => void loadList(false)}
    >
      {selectedName ? (
        <>
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
          show('success', `沙箱 ${name} 创建成功`, { source: 'sandbox-create' });
          void loadList(true);
        }}
        onOpenDetail={(name) => selectSandbox(name)}
      />

      <SandboxDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        detail={detail}
        loading={detailLoading}
      />

      <ProxySettingsDialog open={proxyOpen} onOpenChange={setProxyOpen} />

      <DeleteSandboxDialog
        open={plan !== null}
        onOpenChange={closeDeleteDialog}
        plan={plan}
        busy={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </AppShell>
  );
}
