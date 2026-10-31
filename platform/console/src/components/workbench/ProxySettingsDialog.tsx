import { useCallback, useEffect, useState } from 'react';

import { api } from '../../api/client';
import type { ProxyRestartResult, ProxyStatus } from '../../api/types';
import { formatBytes, formatTimestamp } from '../../lib/format';
import {
  describeCaFetchable,
  describeCaOutcome,
  describeCertificate,
  describeContainerState,
  describeHealth,
  describeRestartOutcome,
  describeTcp,
  summarizeProxyStatus,
} from '../../lib/proxy';
import { useToast } from '../Toast';
import { DrawerShell } from './DrawerShell';

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
 * 代理设置抽屉：状态展示 + 重启 + CA 重装结果。
 *
 * 字段与旧的「代理设置」页一一对应，定位标识全部保留。
 */
export function ProxySettingsDialog({
  open,
  onOpenChange,
  widthVw,
  onWidthChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 抽屉宽度（视口宽度的百分比）。 */
  widthVw: number;
  /** 宽度变化回调（工作台负责持久化）。 */
  onWidthChange: (vw: number) => void;
}) {
  const { show } = useToast();
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [restart, setRestart] = useState<ProxyRestartResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(
    async (options?: { quiet?: boolean }) => {
      setLoading(true);
      try {
        setStatus(await api.proxyStatus());
      } catch (exc) {
        // 读取代理状态失败：弹失败 toast（弹窗里不再挂失败横幅）。
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
    // 重启进行中：弹 info toast（弹窗里不再挂蓝条）。
    // toast 5 秒后消失，重启还没完时按钮自身的「正在重启…」状态仍在。
    show('info', RESTARTING_NOTICE, { source: 'proxy-settings' });
    // 本轮是否已经报过失败：报过就不让后续的状态刷新失败再顶一条。
    let reportedFailure = false;
    try {
      const result = await api.restartProxy();
      setRestart(result);
      setStatus(result);
      // 重启结果：成功 / 失败都走 toast（弹窗里的明细面板照旧保留）。
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
      title="代理设置"
      testId="page-settings-dialog"
      onOpenChange={onOpenChange}
      widthVw={widthVw}
      onWidthChange={onWidthChange}
      footer={
        <>
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
            className="inline-flex h-8 items-center justify-center rounded-lg border border-transparent bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            {restarting ? '正在重启…' : '重启代理'}
          </button>
        </>
      }
    >
      <h2 className="sr-only" data-testid="page-settings-title">
        代理设置
      </h2>

      {loading && !status && (
        <p className="text-[12.5px] text-muted-foreground" data-testid="page-settings-loading">
          正在读取代理状态…
        </p>
      )}

      {status && (
        <div>
          <p
            className="mb-3 rounded-lg border border-success/30 bg-success-soft px-3 py-2 text-[12.5px] text-success"
            data-testid="page-settings-summary"
          >
            {summarizeProxyStatus(status)}
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3.5">
            <Field
              label="容器运行状态"
              value={describeContainerState(status.container)}
              testId="page-settings-container-running"
            />
            <Field label="健康状态" value={describeHealth(status.healthy)} testId="page-settings-healthy" />
            <Field label="端口连通" value={describeTcp(status.tcp_ok)} testId="page-settings-tcp-ok" />
            <Field
              label="CA 证书可取回"
              value={describeCaFetchable(status.ca_fetchable)}
              testId="page-settings-ca-fetchable"
            />
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
            <Field label="状态明细" value={status.detail} testId="page-settings-detail" />
          </div>
          <p className="mt-3 text-[12px] text-muted-foreground">
            代理缓存只增不减，页面只展示占用大小，不提供清理入口。
          </p>
        </div>
      )}

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
    </DrawerShell>
  );
}
