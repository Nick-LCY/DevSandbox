import { Copy, Download, Loader2, Play, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

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
  forwardMappingLabel,
  forwardStateLabel,
  listenerBadgeState,
  listenerStateLabel,
  listenerTone,
  listenerToneClass,
  localForwardUrl,
  parsePort,
  validatePort,
} from '../../lib/port-forward';
import type { ConnectionConfig } from '../../lib/connection';
import { useToast } from '../Toast';
import { Input } from '../ui/input';
import { PortForwardInstallDialog } from './PortForwardInstallDialog';

interface PortForwardPanelProps {
  /** 转发挂在哪个沙箱上。 */
  sandbox: string;
  /** 是否运行在桌面壳里（**只有桌面形态有完整管理**）。 */
  desktop: boolean;
  /** 连接配置（桌面形态下要把后端基址与令牌经 IPC 交给 Rust 侧）。 */
  connection: ConnectionConfig;
}

/** 一条转发在本机侧的状态（Rust 侧内存态）。 */
interface ListenerState {
  /** 实际生效的本机端口。 */
  localPort: number;
  /** 状态：`listening`。 */
  state: string;
}

/** 行内按钮的统一样式。 */
const actionClass =
  'inline-flex h-7 items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-2 text-[12.5px] ' +
  'text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 ' +
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
 *   （列表 / 新建 / 停止都不渲染）——本机端口的监听由桌面端持有，
 *   在网页上建转发只会给出「建了却连不上」的半截功能。
 * - **桌面形态**：**完整管理**——新建转发、开启 / 关闭本机监听、停止转发，
 *   开启后行内显示 `http://127.0.0.1:<本机端口>` 与复制按钮。
 *
 * **本机端口规则**（ADR 0014 第 4 节）：默认 = 容器端口、可编辑、不可为空、
 * 被占自动换空闲端口并**显示实际值**、允许 <1024。
 *
 * **状态徽标只表达本机监听语义**（未开启 / 开启中 / 监听中 / 失败），
 * 后端转发记录的状态（running / 已停止）单独一行文字展示——
 * 颜色与文字不同源会出「灰点 +『可用』」这种自相矛盾的呈现。
 */
export function PortForwardPanel({ sandbox, desktop, connection }: PortForwardPanelProps) {
  const { show } = useToast();
  /** 后端的转发记录列表。 */
  const [forwards, setForwards] = useState<ForwardModel[]>([]);
  /** 本机侧**正在监听**的转发（按转发标识索引）。 */
  const [listeners, setListeners] = useState<Record<string, ListenerState>>({});
  /** 正在开启监听的转发标识（徽标显示「开启中」，琥珀脉动）。 */
  const [startingId, setStartingId] = useState<string | null>(null);
  /** 每条转发的行内红字（失败原因原文）。 */
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  /** 每条转发「期望的本机端口」（重新开启监听时沿用；没记过就用容器端口）。 */
  const [requestedPorts, setRequestedPorts] = useState<Record<string, number>>({});
  /** 列表读取中。 */
  const [loading, setLoading] = useState(false);
  /** 正在操作的转发标识（行内按钮的加载态）。 */
  const [busyId, setBusyId] = useState<string | null>(null);
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

  const loadForwards = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listForwards(sandbox);
      setForwards(list);
    } catch (exc) {
      show('error', errorMessage(exc), { source: 'port-forward' });
    } finally {
      setLoading(false);
    }
  }, [sandbox, show]);

  /** 读桌面端的监听状态（页面刷新后回填「已开启」的行）。 */
  const loadListeners = useCallback(async () => {
    try {
      const items: ForwardListener[] = await listForwardListeners();
      const next: Record<string, ListenerState> = {};
      for (const item of items) {
        next[item.forward_id] = {
          localPort: item.local_port,
          state: item.state,
        };
      }
      setListeners(next);
    } catch {
      // 读不到监听状态：按「都没开启」处理（不影响管理能力）。
    }
  }, []);

  useEffect(() => {
    // web 形态不渲染任何管理操作：不读转发记录（省一次白跑的请求）。
    if (!desktop) {
      return;
    }
    void loadForwards();
    void loadListeners();
  }, [desktop, loadForwards, loadListeners]);

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
          // 连接），失败原因就地展示，徽标仍是「监听中」。
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

  /** 开启本机监听：Rust 侧绑定端口并返回**实际生效的端口**。 */
  const startListener = useCallback(
    async (forward: ForwardModel) => {
      setBusyId(forward.id);
      // 徽标先置「开启中」（琥珀脉动）：等 Rust 侧绑端口的这段不算「未开启」。
      setStartingId(forward.id);
      // 期望的本机端口：沿用上一次用的（没记过就默认 = 容器端口）。
      const requested = requestedPorts[forward.id] ?? forward.container_port;
      try {
        const actual = await startForwardListener({
          forwardId: forward.id,
          backendBaseUrl: connection.backendBaseUrl,
          token: connection.token,
          containerPort: forward.container_port,
          localPort: requested,
        });
        setListeners((prev) => ({
          ...prev,
          [forward.id]: { localPort: actual, state: 'listening' },
        }));
        setRowErrors((prev) => {
          const next = { ...prev };
          delete next[forward.id];
          return next;
        });
        show('success', describeListenerStarted(requested, actual), { source: 'port-forward' });
      } catch (exc) {
        // 失败原因**原文展示**（Rust 侧的固定中文文案）：行内红字 + 失败 toast。
        const message = errorMessage(exc);
        setRowErrors((prev) => ({ ...prev, [forward.id]: message }));
        show('error', message, { source: 'port-forward' });
      } finally {
        setBusyId(null);
        setStartingId(null);
      }
    },
    [connection.backendBaseUrl, connection.token, requestedPorts, show],
  );

  /** 关闭本机监听（转发记录保留，随时可以再开）。 */
  const closeListener = useCallback(
    async (forward: ForwardModel) => {
      setBusyId(forward.id);
      try {
        await stopForwardListener(forward.id);
        setListeners((prev) => {
          const next = { ...prev };
          delete next[forward.id];
          return next;
        });
        setRowErrors((prev) => {
          const next = { ...prev };
          delete next[forward.id];
          return next;
        });
        show('success', '本机监听已关闭', { source: 'port-forward' });
      } catch (exc) {
        show('error', errorMessage(exc), { source: 'port-forward' });
      } finally {
        setBusyId(null);
      }
    },
    [show],
  );

  /** 停止转发：先关本机监听，再删后端的转发记录。 */
  const stopForward = useCallback(
    async (forward: ForwardModel) => {
      setBusyId(forward.id);
      try {
        // 先收掉本机监听（不留僵尸监听）。
        // **停不掉要出声**：静默 continue 会留下指向已删转发的僵尸监听，
        // 提示用户去桌面端把它重新开一次再关。
        try {
          await stopForwardListener(forward.id);
        } catch {
          show('error', STOP_LISTENER_FAILED_NOTICE, { source: 'port-forward' });
        }
        await api.deleteForward(forward.id);
        setListeners((prev) => {
          const next = { ...prev };
          delete next[forward.id];
          return next;
        });
        setRowErrors((prev) => {
          const next = { ...prev };
          delete next[forward.id];
          return next;
        });
        setRequestedPorts((prev) => {
          const next = { ...prev };
          delete next[forward.id];
          return next;
        });
        setForwards((prev) => prev.filter((item) => item.id !== forward.id));
        show('success', '转发已停止', { source: 'port-forward' });
      } catch (exc) {
        show('error', errorMessage(exc), { source: 'port-forward' });
      } finally {
        setBusyId(null);
      }
    },
    [show],
  );

  /** 新建转发：先建后端记录，再开启本机监听。 */
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
    // 后端记录已建（幂等：同一沙箱同一容器端口复用既有转发）。
    setForwards((prev) => [...prev.filter((item) => item.id !== forward.id), forward]);
    setRequestedPorts((prev) => ({ ...prev, [forward.id]: requested }));
    // 接着开启本机监听（失败不影响已建的转发记录：行里还能手动再开）。
    setStartingId(forward.id);
    try {
      const actual = await startForwardListener({
        forwardId: forward.id,
        backendBaseUrl: connection.backendBaseUrl,
        token: connection.token,
        containerPort: forward.container_port,
        localPort: requested,
      });
      setListeners((prev) => ({
        ...prev,
        [forward.id]: { localPort: actual, state: 'listening' },
      }));
      setRowErrors((prev) => {
        const next = { ...prev };
        delete next[forward.id];
        return next;
      });
      show('success', describeListenerStarted(requested, actual), { source: 'port-forward' });
    } catch (exc) {
      const message = errorMessage(exc);
      setRowErrors((prev) => ({ ...prev, [forward.id]: message }));
      show('error', message, { source: 'port-forward' });
    } finally {
      setStartingId(null);
    }
    setContainerPort('');
    setLocalPort('');
    setLocalPortTouched(false);
    setCreating(false);
  }, [connection.backendBaseUrl, connection.token, containerPort, effectiveLocalPort, sandbox, show]);

  /** 复制本机访问地址。 */
  const copyUrl = useCallback(
    async (port: number) => {
      const url = localForwardUrl(port);
      try {
        await navigator.clipboard.writeText(url);
        show('success', `已复制 ${url}`, { source: 'port-forward' });
      } catch {
        show('error', '复制到系统剪贴板失败', { source: 'port-forward' });
      }
    },
    [show],
  );

  /* ------------------------------------------------------------------ 渲染 */

  /** 按容器端口排序（小的在前）。 */
  const sorted = useMemo(
    () => [...forwards].sort((a, b) => a.container_port - b.container_port),
    [forwards],
  );

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
      {loading && forwards.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground" data-testid="page-forward-loading">
          正在读取端口转发…
        </p>
      ) : null}

      {!loading && sorted.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground" data-testid="page-forward-empty">
          （还没有端口转发）
        </p>
      ) : null}

      {sorted.length > 0 && (
        <ul className="m-0 list-none space-y-2 p-0" data-testid="page-forward-list">
          {sorted.map((forward) => {
            const listener = listeners[forward.id];
            const localPort = listener?.localPort ?? null;
            const busy = busyId === forward.id;
            const starting = startingId === forward.id;
            const rowError = rowErrors[forward.id] ?? '';
            // 徽标只表达**本机监听语义**（颜色与文字同源）。
            const badge = listenerBadgeState({
              starting,
              listening: listener?.state === 'listening',
              failed: rowError !== '',
            });
            return (
              <li
                key={forward.id}
                className="rounded-lg border border-border bg-card px-3 py-2.5"
                data-testid="page-forward-item"
                data-forward-id={forward.id}
                data-container-port={forward.container_port}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span
                    className="font-mono text-[12.5px]"
                    data-testid="page-forward-item-mapping"
                  >
                    {forwardMappingLabel(forward.container_port, localPort)}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-[11.5px] ${listenerToneClass(
                      listenerTone(badge),
                    )}`}
                    data-testid="page-forward-item-state"
                    data-forward-state={badge}
                  >
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                    {listenerStateLabel(badge)}
                  </span>
                  {/* 后端转发记录的状态：单独一行文字，不进徽标。 */}
                  <span className="text-[11.5px] text-muted-foreground" data-testid="page-forward-item-record-state">
                    转发状态：{forwardStateLabel(forward.state)}
                  </span>
                </div>

                {listener?.state === 'listening' && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <code
                      className="rounded-md bg-muted px-2 py-1 font-mono text-[12px]"
                      data-testid="page-forward-item-url"
                    >
                      {localForwardUrl(listener.localPort)}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyUrl(listener.localPort)}
                      disabled={busy}
                      data-testid="page-forward-item-copy-button"
                      title="复制本机访问地址"
                      aria-label="复制本机访问地址"
                      className={actionClass}
                    >
                      <Copy className="size-3.5" aria-hidden="true" />
                      复制
                    </button>
                  </div>
                )}

                {rowError && (
                  <p
                    className="mt-1.5 text-[12px] text-destructive"
                    role="alert"
                    data-testid="page-forward-item-error"
                  >
                    {rowError}
                  </p>
                )}

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {listener?.state === 'listening' ? (
                    <button
                      type="button"
                      onClick={() => void closeListener(forward)}
                      disabled={busy}
                      data-testid="page-forward-item-toggle-button"
                      className={actionClass}
                    >
                      {busy ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <Square className="size-3.5" aria-hidden="true" />
                      )}
                      关闭本机监听
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void startListener(forward)}
                      disabled={busy}
                      data-testid="page-forward-item-toggle-button"
                      className={actionClass}
                    >
                      {busy ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <Play className="size-3.5" aria-hidden="true" />
                      )}
                      开启本机监听
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void stopForward(forward)}
                    disabled={busy}
                    data-testid="page-forward-item-stop-button"
                    className={`${actionClass} border-destructive/40 text-destructive hover:bg-destructive-soft`}
                  >
                    {busy ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    )}
                    停止转发
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

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
    </div>
  );
}
