import { useCallback, useEffect, useRef, useState } from 'react';

import { ConnectionNotConfiguredError, api } from '../../api/client';
import type { ForwardModel, SandboxDetail, SandboxSummary } from '../../api/types';
import {
  clearPendingConnection,
  describeHealthFailure,
  effectiveBackendBaseUrl,
  readPendingConnection,
  syncDesktopBackend,
  useConnection,
  type ConnectionConfig,
  type DesktopSyncOutcome,
} from '../../lib/connection';
import { useDrawerWidth } from '../../lib/drawer-width';
import { nextPollFailure } from '../../lib/poll';
import {
  describeMergedPollFailure,
  mergedPollFailed,
  type MergedPollResult,
} from '../../lib/sandbox-poll';
import { TerminalPanel } from '../TerminalPanel';
import { useToast } from '../Toast';
import { useNavigate, useRoute } from '../../lib/router';
import { AppShell, type HealthView } from './AppShell';
import { ConnectionSetup } from './ConnectionSetup';
import { CreateSandboxDialog } from './CreateSandboxDialog';
import { DeleteSandboxDialog } from './DeleteSandboxDialog';
import { EmptyState } from './EmptyState';
import { FileBrowserPanel } from './FileBrowserPanel';
import { SandboxDetailDialog } from './SandboxDetailDialog';
import { SettingsDialog } from './SettingsDialog';
import { StopSandboxDialog } from './StopSandboxDialog';
import { WorkspaceHeader } from './WorkspaceHeader';

/** 沙箱列表轮询间隔（毫秒）。 */
const POLL_INTERVAL = 5000;

/** 后端健康自检的轮询间隔（毫秒）。 */
const HEALTH_POLL_INTERVAL = 15000;

/** 沙箱详情 + 端口转发记录的合并轮询间隔（毫秒）。 */
const DETAIL_POLL_INTERVAL = 10000;

/** 桌面形态启动同步的兜底超时（毫秒）：桌面壳没响应时不能把界面挂死。 */
const DESKTOP_SYNC_TIMEOUT = 3000;

/**
 * 工作台入口：未配置时先给引导面板，配置好了才装工作台。
 *
 * **未配置态不是路由**：地址栏仍然是 `#/`，刷新页面回到这里。
 *
 * 未配置时工作台整体**不挂载**（而不是挂载后再隐藏）：沙箱列表轮询（5 秒）
 * 与健康自检轮询（15 秒）一个都不启动——没令牌时发出去的请求必然 401，
 * 轮询只会白跑。保存配置后工作台挂载，轮询立即开始。
 *
 * 桌面形态还有一步「启动同步」：主文档的 CSP 里要带上后端主机（动态 CSP），
 * 桌面壳没同步好之前**不挂载工作台**——那一版主文档的 CSP 还拦着跨主机请求，
 * 工作台的轮询先发出去只会白跑（还会报一串假失败）。
 */
export function Workbench() {
  const { config, setConfig, configured, desktop } = useConnection();
  /** 运行期发现配置失效（接口层报「未配置」）：回到引导态。 */
  const [invalidated, setInvalidated] = useState(false);
  /** 桌面形态的启动同步还没完（可能要重载主文档）。 */
  const [bootReady, setBootReady] = useState(!desktop);
  /** 启动那一刻的连接配置（启动同步要用它，之后不再变）。 */
  const initialConfigRef = useRef(config);

  useEffect(() => {
    if (!desktop) {
      setBootReady(true);
      return undefined;
    }
    let cancelled = false;
    let timer: number | null = null;
    void (async () => {
      // 待验证配置只是「首次配置还没体检过」的草稿：已经配置好的应用不看它。
      const pending = configured ? null : readPendingConnection();
      if (configured) {
        clearPendingConnection();
      }
      const base = effectiveBackendBaseUrl(initialConfigRef.current, pending);
      // IPC 兜底：桌面壳没响应时不能把界面挂死（空白页）。
      const timeout = new Promise<DesktopSyncOutcome>((resolve) => {
        timer = window.setTimeout(() => resolve('unavailable'), DESKTOP_SYNC_TIMEOUT);
      });
      const outcome = await Promise.race([syncDesktopBackend(base), timeout]);
      if (cancelled || outcome === 'reloading') {
        // 重载中：页面即将卸载，不用管后续（这一轮不挂载工作台）。
        return;
      }
      setBootReady(true);
    })();
    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [desktop]);

  if (!bootReady) {
    // 桌面形态的启动同步期间不挂载任何东西（工作台的轮询会被 CSP 拦掉）。
    return null;
  }

  if (!configured || invalidated) {
    return (
      <ConnectionSetup
        config={config}
        desktop={desktop}
        onSave={(next) => {
          setInvalidated(false);
          setConfig(next);
        }}
      />
    );
  }

  return (
    <WorkbenchView
      connection={config}
      desktop={desktop}
      onConnectionChange={setConfig}
      onNotConfigured={() => setInvalidated(true)}
    />
  );
}

/**
 * 工作台：单页总装与状态中枢。
 *
 * 左侧边栏是沙箱列表，右侧工作区是选中沙箱的摘要与终端会话标签；
 * 新建沙箱 / 沙箱详情 / 设置（代理设置 + 启动模板 + 连接配置）都是右侧抽屉
 * （开关状态不入路由）。
 *
 * 选中的沙箱与当前终端会话都来自路由（`#/sandboxes/<名>[/<会话标识>]`）：
 * 刷新页面或把链接发给别人，能落到同一个位置。
 */
function WorkbenchView({
  connection,
  desktop,
  onConnectionChange,
  onNotConfigured,
}: {
  /** 当前连接配置（设置抽屉的「连接配置」区要改它）。 */
  connection: ConnectionConfig;
  /** 是否运行在桌面壳里（**端口转发的完整管理只在桌面形态**）。 */
  desktop: boolean;
  /** 改连接配置（落盘 + 桌面侧同步动态 CSP）。 */
  onConnectionChange: (next: ConnectionConfig) => void;
  /** 运行期发现配置失效（接口层报「未配置」）：回到引导态。 */
  onNotConfigured: () => void;
}) {
  const route = useRoute();
  const navigate = useNavigate();
  const { show } = useToast();
  // 三个抽屉共用一份宽度（存 localStorage）。
  const { widthVw, setWidthVw } = useDrawerWidth();

  const [sandboxes, setSandboxes] = useState<SandboxSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const [detail, setDetail] = useState<SandboxDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  /** 后端的端口转发记录（**与详情合并轮询**，详情抽屉里的转发表格用它）。 */
  const [forwards, setForwards] = useState<ForwardModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [stopDependencies, setStopDependencies] = useState(true);

  const [health, setHealth] = useState<HealthView>({
    state: 'checking',
    text: '正在检查后端服务…',
  });

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const requestIdRef = useRef(0);
  /** 详情请求的序号：旧响应回来时直接丢弃，不许覆盖新沙箱的头部。 */
  const detailRequestIdRef = useRef(0);
  /** 转发记录请求的序号：同样防止乱序回写（旧沙箱的记录不许串台）。 */
  const forwardsRequestIdRef = useRef(0);
  /** 后台轮询连续失败次数：到阈值弹一条失败 toast，任一次成功即清零。 */
  const pollFailuresRef = useRef(0);
  /** 详情 + 转发记录的合并轮询连续失败次数（同上口径）。 */
  const detailPollFailuresRef = useRef(0);
  /** 详情抽屉上一次是否打开（用来抓「从关到开」的那一瞬间）。 */
  const detailOpenRef = useRef(false);

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
        if (exc instanceof ConnectionNotConfiguredError) {
          // 配置失效（令牌没了）：回引导态，不弹普通错误 toast——
          // 「去配置连接」比「读取沙箱列表失败」有用。
          onNotConfigured();
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
    [show, onNotConfigured],
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
        if (exc instanceof ConnectionNotConfiguredError) {
          // 配置失效：回引导态（不弹 toast）。
          if (!cancelled) {
            onNotConfigured();
          }
          return;
        }
        // 令牌无效与后端不可达是两回事：文案不混（带前缀，后端 detail 原文跟上）。
        view = { state: 'down', text: describeHealthFailure(exc) };
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
  }, [onNotConfigured]);

  /* ------------------------------------------------------------------ 详情 */

  /**
   * 读沙箱详情。
   *
   * `silent` = 轮询那一拍：**失败不逐次弹**（连续 3 次才弹一条），
   * 且**不清空已有的详情**（一拍的抖动不该把工作区头部抹掉）。
   */
  const loadDetail = useCallback(
    async (name: string, options?: { silent?: boolean }): Promise<string | null> => {
      const requestId = detailRequestIdRef.current + 1;
      detailRequestIdRef.current = requestId;
      if (!options?.silent) {
        setDetailLoading(true);
      }
      try {
        const found = await api.getSandbox(name);
        if (requestId !== detailRequestIdRef.current) {
          return null;
        }
        setDetail(found);
        return null;
      } catch (exc) {
        if (requestId !== detailRequestIdRef.current) {
          return null;
        }
        const message = exc instanceof Error ? exc.message : '读取沙箱详情失败';
        if (!options?.silent) {
          // 手动触发（首次读 / 头部刷新）：立刻弹失败 toast，工作区回落到空态展示。
          setDetail(null);
          show('error', message, { source: 'sandbox-detail' });
        }
        return message;
      } finally {
        // **只有非 silent 的那次请求才复位 loading**：silent 请求自己不把
        // loading 置起来（它只是轮询那一拍），提前关掉会把还在转的头部
        // loading 误关。
        if (!options?.silent && requestId === detailRequestIdRef.current) {
          setDetailLoading(false);
        }
      }
    },
    [show],
  );

  /**
   * 读后端的端口转发记录。
   *
   * **与详情合并轮询**：转发记录由工作台持有，端口转发区只管渲染。
   * 失败口径与详情一致（`silent` 时不逐次弹）。
   *
   * **只有桌面形态才读**：web 形态的端口转发区连转发记录都不读
   * （只有一张说明卡，没有表格），读取在工作台层且仅桌面形态执行。
   */
  const loadForwards = useCallback(
    async (name: string, options?: { silent?: boolean }): Promise<string | null> => {
      // web 形态：不读转发记录（面板不渲染行，也就没有读它的理由）。
      if (!desktop) {
        return null;
      }
      const requestId = forwardsRequestIdRef.current + 1;
      forwardsRequestIdRef.current = requestId;
      try {
        const list = await api.listForwards(name);
        if (requestId !== forwardsRequestIdRef.current) {
          return null;
        }
        setForwards(list);
        return null;
      } catch (exc) {
        if (requestId !== forwardsRequestIdRef.current) {
          return null;
        }
        const message = exc instanceof Error ? exc.message : '读取端口转发列表失败';
        if (!options?.silent) {
          show('error', message, { source: 'sandbox-detail' });
        }
        return message;
      }
    },
    [desktop, show],
  );

  /**
   * 一拍刷两份：沙箱详情 + 转发记录（并行）。
   *
   * 两份结果分别落 `detail` 与 `forwards`；失败原因原样返回（交给调用方决定
   * 是立即弹还是计入连续失败计数）。
   *
   * **web 形态只刷详情**：转发记录的读取在工作台层且**仅桌面形态执行**
   * （web 形态的端口转发区只有一张说明卡，没有表格可渲染）。
   */
  const refreshSelected = useCallback(
    async (name: string, options?: { silent?: boolean }): Promise<MergedPollResult> => {
      const [detailError, forwardsError] = await Promise.all([
        loadDetail(name, options),
        loadForwards(name, options),
      ]);
      return { detailError, forwardsError };
    },
    [loadDetail, loadForwards],
  );

  /** 一拍之后的失败计数（连续 3 次失败弹一条，成功即清零）。 */
  const accountMergedPoll = useCallback(
    (result: MergedPollResult) => {
      const step = nextPollFailure(detailPollFailuresRef.current, !mergedPollFailed(result));
      detailPollFailuresRef.current = step.count;
      if (!step.shouldToast) {
        return;
      }
      show('error', describeMergedPollFailure(result), { source: 'sandbox-detail' });
    },
    [show],
  );

  useEffect(() => {
    if (!selectedName) {
      setDetail(null);
      setForwards([]);
      return;
    }
    // 换沙箱：先把上一个沙箱的详情与转发记录清掉，别让头部串台；
    // 在途的旧请求由请求序号护栏丢弃。
    setDetail(null);
    setForwards([]);
    detailPollFailuresRef.current = 0;
    void refreshSelected(selectedName);
  }, [selectedName, refreshSelected]);

  /**
   * 合并轮询：每 10 秒刷一次详情 + 转发记录。
   *
   * **不管详情抽屉开没开都跑**（抽屉关着时数据也得是最新的）。
   * 失败口径：逐次不弹（会刷屏），**连续 3 次失败弹一条**；
   * 页面不可见时整拍跳过（省一次往返，也不让后台标签页堆积请求）。
   */
  useEffect(() => {
    if (!selectedName) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      void refreshSelected(selectedName, { silent: true }).then(accountMergedPoll);
    }, DETAIL_POLL_INTERVAL);
    return () => window.clearInterval(timer);
  }, [selectedName, refreshSelected, accountMergedPoll]);

  /**
   * 打开详情抽屉的那一瞬间：**立即合并刷一次**（详情 + 转发记录），不等下一拍。
   *
   * **非 silent**：开抽屉是**用户主动触发的操作**，失败**立即弹 toast**
   * （与「用户主动触发的操作失败立刻弹」一致），**不计入**合并轮询的
   * 连续失败计数（那是后台轮询的口径）。周期节拍仍是 silent + 计数。
   */
  useEffect(() => {
    const wasOpen = detailOpenRef.current;
    detailOpenRef.current = detailOpen;
    if (!detailOpen || wasOpen || !selectedName) {
      return;
    }
    void refreshSelected(selectedName);
  }, [detailOpen, selectedName, refreshSelected]);

  /** 端口转发的写操作完成后：立即重拉转发记录（不等下一拍）。 */
  const reloadForwards = useCallback(() => {
    if (!selectedName) {
      return;
    }
    void loadForwards(selectedName, { silent: true });
  }, [selectedName, loadForwards]);

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

  /** 停止沙箱：确认弹窗点「确认停止」后才真的发请求。 */
  const stop = useCallback(async () => {
    if (!selectedName) {
      return;
    }
    setBusy(true);
    try {
      const updated = await api.stopSandbox(selectedName, stopDependencies);
      setDetail(updated);
      show('success', `沙箱 ${selectedName} 已停止`, { source: 'sandbox-lifecycle' });
      // 只有成功才关弹窗：失败时留在弹窗里，用户可以直接重试。
      setStopOpen(false);
      await loadList(true);
    } catch (exc) {
      show('error', exc instanceof Error ? exc.message : '停止沙箱失败', {
        source: 'sandbox-lifecycle',
      });
    } finally {
      setBusy(false);
    }
  }, [selectedName, stopDependencies, loadList, show]);

  /**
   * 点「停止」：开确认弹窗。
   *
   * 「同时停止依赖容器」每次都复位成默认勾选：上一次取消时的选择
   * 不粘到下一次（否则用户会误停别的依赖容器）。
   */
  const openStop = useCallback(() => {
    setStopDependencies(true);
    setStopOpen(true);
  }, []);

  /** 点「删除」：直接开确认弹窗（不再预取回收清单）。 */
  const openDelete = useCallback(() => {
    if (!selectedName) {
      return;
    }
    setDeleteTarget(selectedName);
  }, [selectedName]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) {
      return;
    }
    setDeleting(true);
    try {
      const result = await api.deleteSandbox(deleteTarget);
      setDeleteTarget(null);
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
  }, [deleteTarget, navigate, loadList, show]);

  /* ------------------------------------------------------------------ 导航 */

  const selectSandbox = useCallback(
    (name: string) => {
      // 已经选中的沙箱再点一次不改路由：否则会把已选中的终端会话重置掉。
      if (name === selectedName) {
        return;
      }
      setFilesOpen(false);
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

  /** 关掉删除确认弹窗：删除目标作废。 */
  const closeDeleteDialog = useCallback((open: boolean) => {
    if (!open) {
      setDeleteTarget(null);
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
      onSettingsClick={() => setSettingsOpen(true)}
      onRefresh={() => void loadList(false)}
    >
      {selectedName ? (
        <>
          <WorkspaceHeader
            detail={detail}
            busy={busy}
            onRefresh={() => void loadDetail(selectedName)}
            onStart={() => void start()}
            onStop={openStop}
            onOpenDetail={() => setDetailOpen(true)}
            onOpenFiles={() => setFilesOpen(true)}
            onDelete={openDelete}
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
          // 创建成功：关抽屉 → 成功 toast → 刷新列表（不自动选中新建的沙箱）。
          setCreateOpen(false);
          show('success', `沙箱 ${name} 创建成功`, { source: 'sandbox-create' });
          void loadList(true);
        }}
        widthVw={widthVw}
        onWidthChange={setWidthVw}
      />

      <SandboxDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        detail={detail}
        loading={detailLoading}
        widthVw={widthVw}
        onWidthChange={setWidthVw}
        desktop={desktop}
        connection={connection}
        forwards={forwards}
        onForwardsChanged={reloadForwards}
      />

      <FileBrowserPanel
        open={filesOpen}
        onOpenChange={setFilesOpen}
        sandbox={selectedName ?? ''}
        initialPath={detail?.workdir?.trim() || '/'}
        widthVw={widthVw}
        onWidthChange={setWidthVw}
        desktop={desktop}
      />

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        widthVw={widthVw}
        onWidthChange={setWidthVw}
        connection={connection}
        onConnectionChange={onConnectionChange}
      />

      <DeleteSandboxDialog
        open={deleteTarget !== null}
        onOpenChange={closeDeleteDialog}
        sandboxName={deleteTarget ?? ''}
        busy={deleting}
        onConfirm={() => void confirmDelete()}
      />

      <StopSandboxDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        sandboxName={selectedName ?? ''}
        stopDependencies={stopDependencies}
        onStopDependenciesChange={setStopDependencies}
        busy={busy}
        onConfirm={() => void stop()}
      />
    </AppShell>
  );
}
