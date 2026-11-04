import { Check, Download, Loader2, Pencil, RefreshCw, Trash2, X } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '../../api/client';
import type { ForwardModel } from '../../api/types';
import {
  listForwardListeners,
  listenForwardEvents,
  startForwardListener,
  stopForwardListener,
  type ForwardListener,
} from '../../lib/desktop-forward';
import {
  describeListenerStarted,
  forwardRecordDotClass,
  forwardRecordState,
  forwardRecordStateLabel,
  listenerBadgeState,
  listenerDotClass,
  listenerStateHint,
  parsePort,
  validatePort,
} from '../../lib/port-forward';
import type { ConnectionConfig } from '../../lib/connection';
import { cn } from '../../lib/cn';
import { useToast } from '../Toast';
import { Input } from '../ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { PortForwardInstallDialog } from './PortForwardInstallDialog';

interface PortForwardPanelProps {
  /** 转发挂在哪个沙箱上。 */
  sandbox: string;
  /** 是否运行在桌面壳里（**只有桌面形态有完整管理**）。 */
  desktop: boolean;
  /** 连接配置（桌面形态下要把后端基址与令牌经 IPC 交给 Rust 侧）。 */
  connection: ConnectionConfig;
  /** 后端的转发记录（**由工作台轮询送来**，面板自己不拉）。 */
  forwards: ForwardModel[];
  /** 写操作完成后回调（工作台立即重拉转发记录，不等下一拍）。 */
  onForwardsChanged: () => void;
}

/** 一条转发在本机侧的状态（Rust 侧内存态）。 */
interface ListenerState {
  /** 实际生效的本机端口。 */
  localPort: number;
  /** 容器端口（转发目标端口）：孤儿行靠它显示。 */
  containerPort: number;
  /** 状态：`listening`。 */
  state: string;
}

/**
 * 表格的一行：**后端记录 ∪ 本机监听**的并集（按转发标识对齐）。
 *
 * - 有记录有监听：正常行；
 * - 有记录无监听：正常行，本机状态是「未开启」；
 * - 无记录有监听：**孤儿行**（记录被删了，本机还在听）。
 */
interface ForwardRow {
  /** 转发标识（对齐键）。 */
  id: string;
  /** 后端记录（`null` = 孤儿行）。 */
  record: ForwardModel | null;
  /** 本机监听（`null` = 本机没开监听）。 */
  listener: ListenerState | null;
  /** 容器端口（记录优先；孤儿行取监听携带的值）。 */
  containerPort: number;
}

/** 行内图标按钮的统一样式（本区先例：终端标签的关闭键）。 */
const iconButtonClass =
  'grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors ' +
  'hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 ' +
  'focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50';

/**
 * 「停止转发」时本机监听停不掉的固定文案。
 *
 * 停不掉就意味着本机端口还占着、还指着一条已被删掉的转发记录——
 * 用户得知道这件事，**不静默吞掉**。
 */
const STOP_LISTENER_FAILED_NOTICE =
  '本机监听停止失败，该端口可能仍被占用；请在桌面端重新开启本机监听后再关闭';

/**
 * 「同步转发」时**旧监听停不掉**的固定文案（记录重建后要把监听迁到新标识）。
 *
 * 旧标识停不掉就不能迁（对新标识再开监听会端口冲突）：
 * 说清现状 + 给用户一条出路（删掉这行再重新同步）。
 */
const MIGRATE_LISTENER_FAILED_NOTICE =
  '本机监听仍指向旧的转发标识，请删除该行后重新同步';

/**
 * 失败原因：**只取 `exc.message`**。
 *
 * 桌面侧的 `invoke` 拒绝值（Tauri 可能传裸字符串）已在
 * `desktop-forward.ts` 的 `invokeDesktop` 里收口成 `Error`；接口层抛的也是
 * `Error`。这里**不再写「取不到原因就显示某句兜底文案」的分支**——
 * 那种兜底会把 Rust 侧的固定中文文案顶掉，用户看不到真正的原因。
 */
function errorMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/**
 * 端口转发区（沙箱详情抽屉里）。
 *
 * **两种形态的差异**（决策 C）：
 * - **web 形态**：**只渲染说明卡 + 「安装桌面端」按钮**，**没有任何管理操作**
 *   （表格 / 新建都不渲染）——本机端口的监听由桌面端持有，
 *   在网页上建转发只会给出「建了却连不上」的半截功能。
 * - **桌面形态**：**完整管理**——新建转发、表格（记录 ∪ 监听并集）、
 *   行内同步 / 编辑本机端口 / 删除转发。
 *
 * **本机端口规则**（ADR 0014 第 4 节）：默认 = 容器端口、可编辑、不可为空、
 * 被占自动换空闲端口并**显示实际值**、允许 <1024。
 *
 * **本机监听的生命周期完全手动**：没有任何自动开启 / 自动关闭——
 * 监听只随「新建 / 删除 / 行内同步 / 行内编辑 / 连接配置变更重开」变化。
 * 轮询只把**数据**刷回来，绝不碰监听。
 *
 * **状态用纯圆点 + tooltip**（不再用带文字的徽标）：本机状态与容器状态
 * 两列各一个圆点，提示文案同时作为圆点的可访问名（`aria-label`）。
 */
export function PortForwardPanel({
  sandbox,
  desktop,
  connection,
  forwards,
  onForwardsChanged,
}: PortForwardPanelProps) {
  const { show } = useToast();
  /** 本机侧**正在监听**的转发（按转发标识索引）。 */
  const [listeners, setListeners] = useState<Record<string, ListenerState>>({});
  /** 本机监听表是否已回填（回填前显示「正在读取端口转发…」）。 */
  const [listenersLoaded, setListenersLoaded] = useState(false);
  /** 正在开启监听的行（圆点显示「开启中」，琥珀脉动）。 */
  const [startingRows, setStartingRows] = useState<Record<string, boolean>>({});
  /** 每条转发的行内红字（失败原因原文）。 */
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  /** 正在操作的行 → 操作名（按钮的加载态）。 */
  const [busyActions, setBusyActions] = useState<Record<string, string>>({});
  /** 行内编辑中的行（本地端口可改）。 */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 行内编辑的端口输入值。 */
  const [editingPort, setEditingPort] = useState('');
  /** 行内编辑的校验红字（就地展示）。 */
  const [editingError, setEditingError] = useState('');
  /** 正在新建。 */
  const [creating, setCreating] = useState(false);
  /** 容器端口输入框。 */
  const [containerPort, setContainerPort] = useState('');
  /** 本机端口输入框（默认跟随容器端口，用户改过之后不再跟随）。 */
  const [localPort, setLocalPort] = useState('');
  /** 本机端口是否被用户手动改过（改过之后不再跟随容器端口）。 */
  const [localPortTouched, setLocalPortTouched] = useState(false);
  /** 本地表单校验红字（就地展示，不走 toast）。 */
  const [error, setError] = useState('');
  /** 「安装桌面端」指引弹窗是否打开（仅 web 形态用）。 */
  const [installOpen, setInstallOpen] = useState(false);

  /** 本机端口输入框的实际取值：没手动改过时跟随容器端口。 */
  const effectiveLocalPort = localPortTouched ? localPort : containerPort;

  /* ------------------------------------------------------------------ 读取 */

  /** 读桌面端的监听状态（页面刷新后回填「已开启」的行）。 */
  const loadListeners = useCallback(async () => {
    try {
      const items: ForwardListener[] = await listForwardListeners();
      const next: Record<string, ListenerState> = {};
      for (const item of items) {
        next[item.forward_id] = {
          localPort: item.local_port,
          containerPort: item.container_port,
          state: item.state,
        };
      }
      setListeners(next);
    } catch {
      // 读不到监听状态：按「都没开启」处理（不影响管理能力）。
    } finally {
      setListenersLoaded(true);
    }
  }, []);

  useEffect(() => {
    // web 形态不渲染任何管理操作：不读转发记录、不读本机监听。
    if (!desktop) {
      return;
    }
    void loadListeners();
  }, [desktop, loadListeners]);

  /* ------------------------------------------------------------------ 事件 */

  useEffect(() => {
    if (!desktop) {
      return undefined;
    }
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void listenForwardEvents({
      onState: (event) => {
        if (event.state === 'stopped') {
          // 监听已关：行回到「未开启」，失败原因一并清掉。
          setListeners((prev) => {
            const next = { ...prev };
            delete next[event.forward_id];
            return next;
          });
          setRowErrors((prev) => {
            const next = { ...prev };
            delete next[event.forward_id];
            return next;
          });
          return;
        }
        if (event.state === 'error') {
          // 转发级致命失败（隧道建不起来等）：**监听器仍在**（用户可以再试一次
          // 连接），失败原因就地展示，圆点仍是「监听中」。
          setRowErrors((prev) => ({ ...prev, [event.forward_id]: event.message }));
          return;
        }
        if (event.local_port === null) {
          return;
        }
        setListeners((prev) => ({
          ...prev,
          [event.forward_id]: {
            localPort: event.local_port as number,
            containerPort: event.container_port,
            state: event.state,
          },
        }));
        setRowErrors((prev) => {
          const next = { ...prev };
          delete next[event.forward_id];
          return next;
        });
      },
      onConnection: (event) => {
        // 连接级事件只提示「这一条连接收场了」：监听器不动。
        if (event.state === 'error') {
          show('error', event.message, { source: 'port-forward' });
        }
      },
    }).then((off) => {
      if (cancelled) {
        off();
        return;
      }
      dispose = off;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [desktop, show]);

  /* ------------------------------------------------------------------ 操作 */

  /** 记一行「操作中」（按钮的加载态）。 */
  const markBusy = useCallback((id: string, action: string | null) => {
    setBusyActions((prev) => {
      const next = { ...prev };
      if (action === null) {
        delete next[id];
      } else {
        next[id] = action;
      }
      return next;
    });
  }, []);

  /** 清掉一行的失败原因。 */
  const clearRowError = useCallback((id: string) => {
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  /** 记一行的失败原因（原文展示，不另造说法）。 */
  const setRowError = useCallback((id: string, message: string) => {
    setRowErrors((prev) => ({ ...prev, [id]: message }));
  }, []);

  /**
   * 开启本机监听：Rust 侧绑定端口并返回**实际生效的端口**。
   *
   * `localPort` 传 `null` = 端口交给桌面端挑（默认容器端口，被占自动换空闲端口）。
   */
  const startListener = useCallback(
    async (input: {
      forwardId: string;
      containerPort: number;
      localPort: number | null;
    }): Promise<number | null> => {
      setStartingRows((prev) => ({ ...prev, [input.forwardId]: true }));
      try {
        const actual = await startForwardListener({
          forwardId: input.forwardId,
          backendBaseUrl: connection.backendBaseUrl,
          token: connection.token,
          containerPort: input.containerPort,
          localPort: input.localPort,
        });
        setListeners((prev) => ({
          ...prev,
          [input.forwardId]: {
            localPort: actual,
            containerPort: input.containerPort,
            state: 'listening',
          },
        }));
        clearRowError(input.forwardId);
        return actual;
      } catch (exc) {
        // 失败原因**原文展示**（Rust 侧的固定中文文案）：行内红字 + 失败 toast。
        const message = errorMessage(exc);
        setRowError(input.forwardId, message);
        show('error', message, { source: 'port-forward' });
        return null;
      } finally {
        setStartingRows((prev) => {
          const next = { ...prev };
          delete next[input.forwardId];
          return next;
        });
      }
    },
    [clearRowError, connection.backendBaseUrl, connection.token, setRowError, show],
  );

  /**
   * 行内「同步」：把后端记录与本机监听对齐（**两个方向按需执行**）。
   *
   * - 后端可用 + 本机无监听 → 开启本机监听（端口交给桌面端挑）；
   * - 后端无记录 / 已停 → 先把记录拉回「可用」（后端幂等：复用或重建）；
   *   **记录重建后 id 可能变了**（隧道按转发标识寻址，旧标识已失效）→
   *   把本机监听迁到新 id（停旧 → 按新标识重开，端口不变）；
   * - 两者已经一致 → 不发任何请求，只弹一条成功提示。
   */
  const syncRow = useCallback(
    async (row: ForwardRow) => {
      markBusy(row.id, 'sync');
      try {
        const record = row.record;
        const listener = row.listener;
        const containerPort = row.containerPort;

        // 后端可用 = 有记录且记录是「可用」；否则先把记录拉回「可用」。
        let activeRecord: ForwardModel;
        if (record !== null && record.state === 'running') {
          activeRecord = record;
        } else {
          activeRecord = await api.createForward(sandbox, containerPort);
          // 记录被删后重建时 id 会变：本机监听要迁到新 id（旧标识已失效）。
          if (listener && activeRecord.id !== row.id) {
            // 迁移期间旧行也标「开启中」：用户盯着的那行圆点立刻变脉动。
            setStartingRows((prev) => ({ ...prev, [row.id]: true }));
            try {
              try {
                await stopForwardListener(row.id);
              } catch {
                // 旧监听停不掉就不能迁（对新 id 再开监听会端口冲突）：
                // 说清原因、**中止迁移**（不开新监听），但仍让新记录行立刻出现。
                show('info', MIGRATE_LISTENER_FAILED_NOTICE, { source: 'port-forward' });
                onForwardsChanged();
                return;
              }
              setListeners((prev) => {
                const next = { ...prev };
                delete next[row.id];
                return next;
              });
              const actual = await startListener({
                forwardId: activeRecord.id,
                containerPort: activeRecord.container_port,
                localPort: listener.localPort,
              });
              if (actual !== null) {
                show('success', describeListenerStarted(listener.localPort, actual), {
                  source: 'port-forward',
                });
              }
            } finally {
              // 迁移结束（含中止）：旧行的「开启中」收掉。
              setStartingRows((prev) => {
                const next = { ...prev };
                delete next[row.id];
                return next;
              });
            }
            onForwardsChanged();
            return;
          }
        }

        // 后端可用 + 本机在听 → 已经一致，不发任何请求。
        if (listener) {
          show('success', '转发已同步', { source: 'port-forward' });
          onForwardsChanged();
          return;
        }

        // 本机没有监听 → 开一个（端口交给桌面端挑：默认容器端口，被占自动换）。
        const actual = await startListener({
          forwardId: activeRecord.id,
          containerPort: activeRecord.container_port,
          localPort: null,
        });
        if (actual !== null) {
          show('success', describeListenerStarted(containerPort, actual), {
            source: 'port-forward',
          });
        }
        onForwardsChanged();
      } catch (exc) {
        show('error', errorMessage(exc), { source: 'port-forward' });
      } finally {
        markBusy(row.id, null);
      }
    },
    [markBusy, onForwardsChanged, sandbox, show, startListener],
  );

  /** 行内「编辑本机端口」：进入行内编辑态。 */
  const beginEdit = useCallback((row: ForwardRow) => {
    setEditingId(row.id);
    setEditingPort(row.listener ? String(row.listener.localPort) : '');
    setEditingError('');
  }, []);

  /** 退出行内编辑态。 */
  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditingPort('');
    setEditingError('');
  }, []);

  /** 行内编辑确认：停旧监听 → 按新端口重开。 */
  const confirmEdit = useCallback(
    async (row: ForwardRow) => {
      // **防重入**：这一行正在忙（确认键 / 回车已经按过一次）就直接返回，
      // 不重复发停 / 启请求。
      if (busyActions[row.id] !== undefined) {
        return;
      }
      const message = validatePort(editingPort, '本机端口');
      if (message) {
        setEditingError(message);
        return;
      }
      const requested = parsePort(editingPort) as number;
      markBusy(row.id, 'edit');
      try {
        try {
          await stopForwardListener(row.id);
        } catch (exc) {
          // 旧监听停不掉就不能重开（同一转发标识已在监听）：说清原因，退出编辑态。
          show('error', errorMessage(exc), { source: 'port-forward' });
          cancelEdit();
          return;
        }
        setListeners((prev) => {
          const next = { ...prev };
          delete next[row.id];
          return next;
        });
        const actual = await startListener({
          forwardId: row.id,
          containerPort: row.containerPort,
          localPort: requested,
        });
        if (actual !== null) {
          show('success', describeListenerStarted(requested, actual), { source: 'port-forward' });
        }
        cancelEdit();
        onForwardsChanged();
      } finally {
        markBusy(row.id, null);
      }
    },
    [busyActions, cancelEdit, editingPort, markBusy, onForwardsChanged, show, startListener],
  );

  /** 行内「删除转发」：先关本机监听，再删后端的转发记录。 */
  const deleteRow = useCallback(
    async (row: ForwardRow) => {
      markBusy(row.id, 'delete');
      try {
        // 先收掉本机监听（不留僵尸监听）。
        // **只有本机真的在听才调 stop**：没有监听的行去停是空操作，
        // 停不掉还会误报一条「停止失败」的警告。
        // **停不掉要出声**：静默 continue 会留下指向已删转发的僵尸监听，
        // 提示用户去桌面端把它重新开一次再关。
        if (row.listener) {
          try {
            await stopForwardListener(row.id);
            setListeners((prev) => {
              const next = { ...prev };
              delete next[row.id];
              return next;
            });
          } catch {
            show('error', STOP_LISTENER_FAILED_NOTICE, { source: 'port-forward' });
          }
        }
        // 孤儿行（后端没有记录）：没有可删的记录，DELETE 跳过。
        if (row.record) {
          await api.deleteForward(row.id);
        }
        clearRowError(row.id);
        show('success', '转发已停止', { source: 'port-forward' });
        onForwardsChanged();
      } catch (exc) {
        show('error', errorMessage(exc), { source: 'port-forward' });
      } finally {
        markBusy(row.id, null);
      }
    },
    [clearRowError, markBusy, onForwardsChanged, show],
  );

  /** 新建转发：先建后端记录，再开启本机监听（一步双开）。 */
  const createForward = useCallback(async () => {
    const containerError = validatePort(containerPort, '容器端口');
    if (containerError) {
      setError(containerError);
      return;
    }
    const localError = validatePort(effectiveLocalPort, '本机端口');
    if (localError) {
      setError(localError);
      return;
    }
    setError('');
    setCreating(true);
    const port = parsePort(containerPort) as number;
    const requested = parsePort(effectiveLocalPort) as number;
    let forward: ForwardModel;
    try {
      forward = await api.createForward(sandbox, port);
    } catch (exc) {
      show('error', errorMessage(exc), { source: 'port-forward' });
      setCreating(false);
      return;
    }
    // 后端记录已建（幂等：同一沙箱同一容器端口复用既有转发）→ 立即重拉记录。
    onForwardsChanged();
    // 接着开启本机监听（失败不影响已建的转发记录：行里还能手动再开）。
    const actual = await startListener({
      forwardId: forward.id,
      containerPort: forward.container_port,
      localPort: requested,
    });
    if (actual !== null) {
      show('success', describeListenerStarted(requested, actual), { source: 'port-forward' });
    }
    setContainerPort('');
    setLocalPort('');
    setLocalPortTouched(false);
    setCreating(false);
  }, [
    containerPort,
    effectiveLocalPort,
    onForwardsChanged,
    sandbox,
    show,
    startListener,
  ]);

  /* ------------------------------------------------------------------ 渲染 */

  /**
   * 行集合：**后端记录 ∪ 本机监听**（按转发标识对齐），按容器端口排序。
   *
   * 孤儿行（记录被删、本机还在听）照常渲染：容器端口取监听携带的值，
   * 容器状态点为红（无后端转发记录）。
   */
  const rows = useMemo<ForwardRow[]>(() => {
    const map = new Map<string, ForwardRow>();
    for (const record of forwards) {
      map.set(record.id, {
        id: record.id,
        record,
        listener: null,
        containerPort: record.container_port,
      });
    }
    for (const [id, listener] of Object.entries(listeners)) {
      const existing = map.get(id);
      if (existing) {
        map.set(id, { ...existing, listener });
      } else {
        map.set(id, {
          id,
          record: null,
          listener,
          containerPort: listener.containerPort,
        });
      }
    }
    return [...map.values()].sort((a, b) => a.containerPort - b.containerPort);
  }, [forwards, listeners]);

  /* ------------------------------------------------------- web 形态：只说明 */

  if (!desktop) {
    return (
      <div className="space-y-3" data-testid="page-forward-notice">
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          访问沙箱端口需要桌面应用：网页形态无法管理端口转发，请使用桌面端。
        </p>
        <button
          type="button"
          onClick={() => setInstallOpen(true)}
          data-testid="page-forward-install-button"
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[13px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <Download className="size-4" aria-hidden="true" />
          安装桌面端
        </button>
        <PortForwardInstallDialog open={installOpen} onOpenChange={setInstallOpen} />
      </div>
    );
  }

  /* --------------------------------------------------- 桌面形态：完整管理 */

  return (
    <div className="space-y-3" data-testid="page-forward-panel">
      {/* 新建表单卡（在上）：只填容器端口，本机端口默认跟随、可改、不可为空。 */}
      <div className="rounded-lg border border-border bg-card px-3 py-2.5">
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-[132px]">
            <label
              htmlFor="forward-container-port"
              className="mb-1.5 block text-[12.5px] font-medium text-foreground"
            >
              容器端口
            </label>
            <Input
              id="forward-container-port"
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={containerPort}
              placeholder="8080"
              onChange={(event) => setContainerPort(event.target.value)}
              data-testid="page-forward-create-container-port-input"
            />
          </div>
          <div className="w-[132px]">
            <label
              htmlFor="forward-local-port"
              className="mb-1.5 block text-[12.5px] font-medium text-foreground"
            >
              本机端口
            </label>
            <Input
              id="forward-local-port"
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={effectiveLocalPort}
              placeholder="8080"
              onChange={(event) => {
                setLocalPortTouched(true);
                setLocalPort(event.target.value);
              }}
              data-testid="page-forward-create-local-port-input"
            />
          </div>
          <button
            type="button"
            onClick={() => void createForward()}
            disabled={creating}
            data-testid="page-forward-create-submit-button"
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            {creating ? (
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                正在转发
              </>
            ) : (
              '转发'
            )}
          </button>
        </div>

        {error && (
          <p
            className="mt-2 text-[12.5px] text-destructive"
            role="alert"
            data-testid="page-forward-create-error"
          >
            {error}
          </p>
        )}
      </div>

      {/* 转发表（在下）：五列 —— 本机端口 / 容器端口 / 本地状态 / 容器状态 / 操作。 */}
      <div className="rounded-lg border border-border bg-card px-3 py-2.5">
        {!listenersLoaded ? (
          <p className="text-[12.5px] text-muted-foreground" data-testid="page-forward-loading">
            正在读取端口转发…
          </p>
        ) : null}

        {listenersLoaded && rows.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground" data-testid="page-forward-empty">
            （还没有端口转发）
          </p>
        ) : null}

        {rows.length > 0 ? (
          <TooltipProvider>
            <table className="w-full border-collapse" data-testid="page-forward-table">
              <thead>
                <tr className="border-b border-border text-[11.5px] text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 text-left font-medium">
                    本机端口
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-left font-medium">
                    容器端口
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-center font-medium">
                    本地状态
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-center font-medium">
                    容器状态
                  </th>
                  <th scope="col" className="py-1.5 text-right font-medium">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const listener = row.listener;
                  const rowError = rowErrors[row.id] ?? '';
                  // 本机状态：开启中 > 监听中 > 失败 > 未开启。
                  const badge = listenerBadgeState({
                    starting: startingRows[row.id] === true,
                    listening: listener?.state === 'listening',
                    failed: rowError !== '',
                  });
                  const localHint = listenerStateHint(badge, listener?.localPort ?? null);
                  // 容器状态：可用 / 已停 / 无记录（孤儿行）。
                  const recordState = forwardRecordState(row.record?.state);
                  const containerHint = forwardRecordStateLabel(recordState);
                  const busyAction = busyActions[row.id] ?? '';
                  const busy = busyAction !== '';
                  const editing = editingId === row.id;
                  const canEdit = listener?.state === 'listening';
                  return (
                    <Fragment key={row.id}>
                    <tr
                      className="border-t border-border transition-colors hover:bg-muted/50"
                      data-testid="page-forward-row"
                      data-forward-id={row.id}
                      data-container-port={row.containerPort}
                    >
                      <td className="py-1.5 pr-3 align-middle" data-testid="page-forward-row-local-port">
                        {editing ? (
                          <div className="flex flex-col items-start gap-1">
                            <div className="flex items-center gap-1">
                              <Input
                                type="number"
                                inputMode="numeric"
                                min={1}
                                max={65535}
                                value={editingPort}
                                aria-label="本机端口"
                                onChange={(event) => {
                                  setEditingPort(event.target.value);
                                  setEditingError('');
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    void confirmEdit(row);
                                  }
                                  if (event.key === 'Escape') {
                                    // **不让 Esc 冒泡**：抽屉会拿 Esc 关闭面板，
                                    // 行内编辑态退出时不应该顺手把抽屉也关了。
                                    event.stopPropagation();
                                    event.preventDefault();
                                    cancelEdit();
                                  }
                                }}
                                data-testid="page-forward-row-edit-input"
                                className="h-7 w-[76px] px-1.5 font-mono text-[12.5px] md:text-[12.5px]"
                              />
                              <button
                                type="button"
                                onClick={() => void confirmEdit(row)}
                                disabled={busy}
                                data-testid="page-forward-row-edit-confirm-button"
                                title="确认"
                                aria-label="确认本机端口"
                                className={cn(iconButtonClass, 'size-6')}
                              >
                                {busyAction === 'edit' ? (
                                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                                ) : (
                                  <Check className="size-3.5" aria-hidden="true" />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={cancelEdit}
                                data-testid="page-forward-row-edit-cancel-button"
                                title="取消"
                                aria-label="取消编辑本机端口"
                                className={cn(iconButtonClass, 'size-6')}
                              >
                                <X className="size-3.5" aria-hidden="true" />
                              </button>
                            </div>
                            {editingError ? (
                              <p
                                className="text-[11.5px] text-destructive"
                                role="alert"
                                data-testid="page-forward-row-edit-error"
                              >
                                {editingError}
                              </p>
                            ) : null}
                          </div>
                        ) : (
                          <span className="font-mono text-[12.5px]">
                            {listener ? listener.localPort : '—'}
                          </span>
                        )}
                      </td>
                      <td
                        className="py-1.5 pr-3 align-middle font-mono text-[12.5px]"
                        data-testid="page-forward-row-container-port"
                      >
                        {row.containerPort}
                      </td>
                      <td className="py-1.5 pr-3 text-center align-middle">
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <span
                                role="img"
                                className={cn(
                                  'inline-block size-[7px] rounded-full bg-current',
                                  listenerDotClass(badge),
                                )}
                                aria-label={localHint}
                                data-testid="page-forward-row-local-state"
                                data-state={badge}
                              />
                            }
                            delay={0}
                          />
                          <TooltipContent>{localHint}</TooltipContent>
                        </Tooltip>
                      </td>
                      <td className="py-1.5 pr-3 text-center align-middle">
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <span
                                role="img"
                                className={cn(
                                  'inline-block size-[7px] rounded-full bg-current',
                                  forwardRecordDotClass(recordState),
                                )}
                                aria-label={containerHint}
                                data-testid="page-forward-row-container-state"
                                data-state={recordState}
                              />
                            }
                            delay={0}
                          />
                          <TooltipContent>{containerHint}</TooltipContent>
                        </Tooltip>
                      </td>
                      <td className="py-1.5 text-right align-middle">
                        {editing ? null : (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => void syncRow(row)}
                              disabled={busy}
                              data-testid="page-forward-row-sync-button"
                              title="同步转发"
                              aria-label="同步转发"
                              className={iconButtonClass}
                            >
                              {busyAction === 'sync' ? (
                                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                              ) : (
                                <RefreshCw className="size-3.5" aria-hidden="true" />
                              )}
                            </button>
                            {/* 禁用按钮外面包一层带 title 的 span：Firefox 对
                                disabled 控件不弹 title（按钮自身的 title 也留着）。 */}
                            <span
                              className="inline-flex"
                              title={
                                canEdit ? '编辑本机端口' : '本机监听未开启，先同步或新建后再编辑'
                              }
                            >
                              <button
                                type="button"
                                onClick={() => beginEdit(row)}
                                disabled={busy || !canEdit}
                                data-testid="page-forward-row-edit-button"
                                title={
                                  canEdit ? '编辑本机端口' : '本机监听未开启，先同步或新建后再编辑'
                                }
                                aria-label={
                                  canEdit ? '编辑本机端口' : '本机监听未开启，先同步或新建后再编辑'
                                }
                                className={iconButtonClass}
                              >
                                <Pencil className="size-3.5" aria-hidden="true" />
                              </button>
                            </span>
                            <button
                              type="button"
                              onClick={() => void deleteRow(row)}
                              disabled={busy}
                              data-testid="page-forward-row-delete-button"
                              title="删除转发"
                              aria-label="删除转发"
                              className={cn(iconButtonClass, 'hover:bg-destructive-soft hover:text-destructive')}
                            >
                              {busyAction === 'delete' ? (
                                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                              ) : (
                                <Trash2 className="size-3.5" aria-hidden="true" />
                              )}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                    {rowError ? (
                      <tr>
                        <td colSpan={5} className="py-1.5">
                          <p
                            className="text-[12px] text-destructive"
                            role="alert"
                            data-testid="page-forward-item-error"
                          >
                            {rowError}
                          </p>
                        </td>
                      </tr>
                    ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </TooltipProvider>
        ) : null}
      </div>
    </div>
  );
}
