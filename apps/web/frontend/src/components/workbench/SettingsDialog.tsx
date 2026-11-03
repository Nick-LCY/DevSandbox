import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '../../api/client';
import type { ProxyRestartResult, ProxyStatus } from '../../api/types';
import { formatBytes, formatTimestamp } from '../../lib/format';
import {
  describeConnectionSource,
  isDesktopRuntime,
  syncDesktopBackend,
  validateBaseUrl,
  type ConnectionConfig,
} from '../../lib/connection';
import {
  describeCaOutcome,
  describeCertificate,
  describeContainerState,
  describeHealth,
  describeRestartOutcome,
  describeTcp,
} from '../../lib/proxy';
import { useToast } from '../Toast';
import { Input } from '../ui/input';
import { DrawerShell } from './DrawerShell';
import { TemplateManager } from './TemplateManager';

/** 重启期间的提示文案：代理不可达时依赖镜像拉取失败是预期行为，不做降级。 */
const RESTARTING_NOTICE = '代理正在重启，重启期间依赖镜像拉取会失败，属预期行为。';

/** 详情里的一行：左标签右值。 */
function Field({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11.5px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-[13px] break-all" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

/**
 * 设置抽屉：代理设置 + 启动模板管理 + 连接配置。
 *
 * 第一区是代理设置（状态展示 + 刷新状态 + 重启 + CA 重装结果），内容与原
 * 「代理设置」抽屉完全一致；第二区是启动模板管理区（列表 / 行内重命名 / 删除）；
 * 第三区是连接配置（后端地址 + 访问令牌 + 测试连接 + 保存配置）。
 *
 * 「刷新状态」与「重启代理」两个按钮**在第一区里**（状态字段区之后），不再挂在
 * 整个抽屉的全局页脚：抽屉页脚只放跟整张抽屉相关的动作，这两个按钮只管代理，
 * 放在代理设置区里更挨着它管的东西（抽屉因此没有页脚）。
 *
 * 定位标识除已退役的三个（顶部摘要、CA 可取回、状态明细）外全部保留。
 */
export function SettingsDialog({
  open,
  onOpenChange,
  widthVw,
  onWidthChange,
  connection,
  onConnectionChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 抽屉宽度（视口宽度的百分比）。 */
  widthVw: number;
  /** 宽度变化回调（工作台负责持久化）。 */
  onWidthChange: (vw: number) => void;
  /** 当前连接配置。 */
  connection: ConnectionConfig;
  /** 改连接配置（落盘 + 桌面侧同步动态 CSP）。 */
  onConnectionChange: (next: ConnectionConfig) => void;
}) {
  const { show } = useToast();
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [restart, setRestart] = useState<ProxyRestartResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [restarting, setRestarting] = useState(false);

  /* ------------------------------------------------------- 连接配置（第三区） */

  /** 连接配置的草稿值：没保存前不动生效中的配置。 */
  const [baseUrl, setBaseUrl] = useState(connection.backendBaseUrl);
  const [token, setToken] = useState(connection.token);
  /** 连接配置的本地校验红字（就地展示，不走 toast）。 */
  const [connectionError, setConnectionError] = useState('');
  /** 「测试连接」进行中。 */
  const [testing, setTesting] = useState(false);
  /** 桌面形态（桌面壳里才需要填后端地址）。 */
  const desktop = useMemo(() => isDesktopRuntime(), []);

  // 打开抽屉时把草稿重置成生效中的配置（关闭期间改的草稿不粘到下一次）。
  useEffect(() => {
    if (!open) {
      return;
    }
    setBaseUrl(connection.backendBaseUrl);
    setToken(connection.token);
    setConnectionError('');
  }, [open, connection]);

  /** 校验草稿：返回空串表示合法。 */
  const validateDraft = useCallback((): string => {
    const baseError = desktop ? validateBaseUrl(baseUrl) : '';
    if (baseError) {
      return baseError;
    }
    if (token.trim() === '') {
      return '请填写访问令牌';
    }
    return '';
  }, [baseUrl, desktop, token]);

  /** 草稿值 → 连接配置（web 形态的基址恒为同源，即空串）。 */
  const draftConfig = useCallback(
    (): ConnectionConfig => ({
      backendBaseUrl: desktop ? baseUrl.trim() : '',
      token: token.trim(),
    }),
    [baseUrl, desktop, token],
  );

  /** 「测试连接」：拿草稿值打一次健康检查，结果按 toast 规范反馈。 */
  const testConnection = useCallback(async () => {
    const error = validateDraft();
    if (error) {
      setConnectionError(error);
      return;
    }
    setConnectionError('');
    setTesting(true);
    try {
      await api.health(draftConfig());
      show('success', '连接成功', { source: 'connection' });
    } catch (exc) {
      show(
        'error',
        `连接失败：${exc instanceof Error ? exc.message : '无法连接后端服务'}`,
        { source: 'connection' },
      );
    } finally {
      setTesting(false);
    }
  }, [draftConfig, show, validateDraft]);

  /**
   * 「保存配置」：落盘（并同步桌面侧的动态 CSP）。
   *
   * 顺序是硬要求：**先落盘，再同步**——同步可能要重载主文档（桌面壳的主文档
   * CSP 里要带上后端主机），重载后配置得还在。
   */
  const saveConnection = useCallback(async () => {
    const error = validateDraft();
    if (error) {
      setConnectionError(error);
      return;
    }
    setConnectionError('');
    const next = draftConfig();
    onConnectionChange(next);
    if (desktop) {
      const outcome = await syncDesktopBackend(next.backendBaseUrl);
      if (outcome === 'reloading') {
        // 主文档重载中：提示会随页面一起消失，不再补一条。
        return;
      }
    }
    show('success', '连接配置已保存', { source: 'connection' });
  }, [desktop, draftConfig, onConnectionChange, show, validateDraft]);

  const load = useCallback(
    async (options?: { quiet?: boolean }) => {
      setLoading(true);
      try {
        setStatus(await api.proxyStatus());
      } catch (exc) {
        // 读取代理状态失败：弹失败 toast（抽屉里不再挂失败横幅）。
        // quiet 模式不弹：重启已经报过更具体的失败，不能被这条顶掉。
        if (!options?.quiet) {
          show('error', exc instanceof Error ? exc.message : '读取代理状态失败', {
            source: 'proxy-settings',
          });
        }
      } finally {
        setLoading(false);
      }
    },
    [show],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setRestart(null);
    void load();
  }, [open, load]);

  const restartProxy = useCallback(async () => {
    setRestarting(true);
    setRestart(null);
    // 重启进行中：弹 info toast（抽屉里不再挂蓝条）。
    // toast 5 秒后消失，重启还没完时按钮自身的「正在重启」加载态仍在。
    show('info', RESTARTING_NOTICE, { source: 'proxy-settings' });
    // 本轮是否已经报过失败：报过就不让后续的状态刷新失败再顶一条。
    let reportedFailure = false;
    try {
      const result = await api.restartProxy();
      setRestart(result);
      setStatus(result);
      // 重启结果：成功 / 失败都走 toast（抽屉里的明细面板照旧保留）。
      show(result.restarted ? 'success' : 'error', describeRestartOutcome(result), {
        source: 'proxy-settings',
      });
      reportedFailure = !result.restarted;
    } catch (exc) {
      // 重启代理失败：弹失败 toast。
      reportedFailure = true;
      show('error', exc instanceof Error ? exc.message : '重启代理失败', {
        source: 'proxy-settings',
      });
    } finally {
      setRestarting(false);
      // 重启后刷新一次状态：即使重启接口失败，状态页也拿到最新快照。
      // 刷新也失败时不再弹 toast：更具体的「重启代理失败」不能被它顶掉。
      void load({ quiet: reportedFailure });
    }
  }, [load, show]);

  return (
    <DrawerShell
      open={open}
      title="设置"
      testId="page-settings-dialog"
      onOpenChange={onOpenChange}
      widthVw={widthVw}
      onWidthChange={onWidthChange}
    >
      <h2 className="sr-only" data-testid="page-settings-title">
        设置
      </h2>

      <section aria-label="代理设置">
        <h3 className="mb-2 text-[13px] font-semibold text-foreground">代理设置</h3>

        {loading && !status && (
          <p className="text-[12.5px] text-muted-foreground" data-testid="page-settings-loading">
            正在读取代理状态…
          </p>
        )}

        {status && (
          <div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3.5">
              <Field
                label="容器运行状态"
                value={describeContainerState(status.container)}
                testId="page-settings-container-running"
              />
              <Field label="健康状态" value={describeHealth(status.healthy)} testId="page-settings-healthy" />
              <Field label="端口连通" value={describeTcp(status.tcp_ok)} testId="page-settings-tcp-ok" />
              <Field
                label="缓存目录占用"
                value={formatBytes(status.cache_size_bytes)}
                testId="page-settings-cache-size"
              />
              <Field
                label="证书就绪状态"
                value={describeCertificate(status.certificate_ready)}
                testId="page-settings-certificate-ready"
              />
              <Field label="代理访问地址" value={status.proxy_url} testId="page-settings-proxy-url" />
            </div>
          </div>
        )}

        {/* 代理区的两个动作按钮：紧跟状态字段区，右对齐。 */}
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading || restarting}
            data-testid="page-settings-refresh-button"
            className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-[13px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            刷新状态
          </button>
          <button
            type="button"
            onClick={() => void restartProxy()}
            disabled={restarting}
            data-testid="page-settings-restart-button"
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            {restarting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                正在重启
              </>
            ) : (
              '重启代理'
            )}
          </button>
        </div>

        {restart && (
          <div className="mt-5 border-t border-border pt-4" data-testid="page-settings-restart-result">
            <div className="grid grid-cols-2 gap-x-6 gap-y-3.5">
              <Field
                label="重启结果"
                value={restart.restarted ? '已重启并恢复健康' : '重启未成功'}
                testId="page-settings-restarted"
              />
              <Field label="结论" value={describeRestartOutcome(restart)} testId="page-settings-restart-message" />
              <Field
                label="CA 指纹是否变更"
                value={restart.ca_changed ? '已变更' : '未变更'}
                testId="page-settings-ca-changed"
              />
              <Field
                label="合并证书链是否重装"
                value={restart.ca_reinstalled ? '已重装' : '未重装'}
                testId="page-settings-ca-reinstalled"
              />
              <Field label="CA 处理结论" value={describeCaOutcome(restart)} testId="page-settings-ca-conclusion" />
              <Field
                label="已重装用户"
                value={restart.reinstalled_users.length > 0 ? restart.reinstalled_users.join('、') : '（无）'}
                testId="page-settings-reinstalled-users"
              />
              <Field
                label="重装失败用户"
                value={restart.failed_users.length > 0 ? restart.failed_users.join('、') : '（无）'}
                testId="page-settings-failed-users"
              />
            </div>
            <p className="mt-3 text-[12px] text-muted-foreground">
              代理状态采集时间：{formatTimestamp(new Date().toISOString())}
            </p>
          </div>
        )}
      </section>

      {/* 第二区：启动模板管理（列表 / 行内重命名 / 删除）。 */}
      <section className="mt-6 border-t border-border pt-5" aria-label="启动模板">
        <TemplateManager />
      </section>

      {/* 第三区：连接配置（后端地址 + 访问令牌 + 测试连接 + 保存配置）。 */}
      <section className="mt-6 border-t border-border pt-5" aria-label="连接配置">
        <h3 className="mb-2 text-[13px] font-semibold text-foreground">连接配置</h3>

        <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
          {describeConnectionSource(desktop)}
        </p>

        <div className="space-y-3">
          <div>
            <label
              htmlFor="settings-connection-base-url"
              className="mb-1.5 block text-[12.5px] font-medium text-foreground"
            >
              后端地址
            </label>
            <Input
              id="settings-connection-base-url"
              value={baseUrl}
              readOnly={!desktop}
              autoComplete="off"
              spellCheck={false}
              placeholder={desktop ? 'http://127.0.0.1:8000' : '与本页面同源'}
              onChange={(event) => setBaseUrl(event.target.value)}
              data-testid="page-settings-connection-base-url-input"
            />
          </div>

          <div>
            <label
              htmlFor="settings-connection-token"
              className="mb-1.5 block text-[12.5px] font-medium text-foreground"
            >
              访问令牌
            </label>
            <Input
              id="settings-connection-token"
              type="password"
              value={token}
              autoComplete="off"
              spellCheck={false}
              placeholder="粘贴后端部署处的访问令牌"
              onChange={(event) => setToken(event.target.value)}
              data-testid="page-settings-connection-token-input"
            />
          </div>
        </div>

        {connectionError && (
          <p
            className="mt-3 text-[12.5px] text-destructive"
            role="alert"
            data-testid="page-settings-connection-error"
          >
            {connectionError}
          </p>
        )}

        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => void testConnection()}
            disabled={testing}
            data-testid="page-settings-connection-test-button"
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 text-[13px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            {testing ? (
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                正在测试
              </>
            ) : (
              '测试连接'
            )}
          </button>
          <button
            type="button"
            onClick={() => void saveConnection()}
            disabled={testing}
            data-testid="page-settings-connection-save-button"
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            保存配置
          </button>
        </div>
      </section>
    </DrawerShell>
  );
}
