/**
 * 注入文件清单（沙箱详情抽屉里，与既有「挂载」区**同级**）。
 *
 * **只显示元数据**：宿主源 → 容器目标、条目种类、是否只读。
 * **不读正文、不展开目录树**——私钥 / 凭证一个字节都不进界面。
 *
 * **写动作只有一处**：每条一个「刷新副本」按钮，调用
 * `POST /api/sandboxes/{name}/injections/{entry_id}/refresh`
 * （**只按条目标识定位**，路径一律由服务端从实例元数据查得）。
 * 既有「刷新详情」是**读操作**（`GET /api/sandboxes/{name}`），两者完全不同：
 * 读操作不触发刷新副本。
 *
 * 口径四条：
 * - **一个沙箱一次只做一个刷新**：服务端同沙箱互斥（并发回 409），前端也只放行
 *   一个在途请求（其余行按钮禁用）；
 * - **加载态禁重复触发**：旋转图标 + 按钮禁用（防重入用 ref 判，不用 state——
 *   连续两次点击落在同一批次里时 state 还没更新）；
 * - **结果一律走右上角 toast**（来源 `injection-refresh`）：失败**直出后端
 *   `detail` 原文**（含「可能部分更新」的语义，不另造说法）；
 * - **换沙箱 / 关抽屉后，在途结果一律丢弃**：旧沙箱的反馈不该落到新沙箱的
 *   界面上（不弹提示、不回写状态）。
 */

import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../api/client';
import type { InjectionInfo } from '../../api/types';
import { useToast } from '../Toast';

interface InjectionListProps {
  /** 清单挂在哪个沙箱上（刷新请求按它 + 条目标识定位）。 */
  sandbox: string;
  /** 详情里的注入声明清单（**只读元数据**）。 */
  injections: InjectionInfo[];
}

/** 条目种类的界面文案。 */
function kindLabel(kind: string): string {
  return kind === 'directory' ? '目录' : '文件';
}

/**
 * 失败原因：**只取 `exc.message`**。
 *
 * 接口层抛的是 `Error`（`ApiError` 的 message 就是后端 `detail` 原文），
 * 这里不再写「取不到原因就显示某句兜底文案」的分支——那种兜底会把后端的
 * 固定中文文案顶掉，用户看不到真正的原因（尤其是「可能部分更新」）。
 */
function errorMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

export function InjectionList({ sandbox, injections }: InjectionListProps) {
  const { show } = useToast();
  /** 正在刷新的条目（同一沙箱一次只做一个）。 */
  const [busyEntryId, setBusyEntryId] = useState<string | null>(null);
  /** 在途请求护栏：防重入 + 作废换沙箱后的旧结果。 */
  const inFlightRef = useRef(false);
  const requestTokenRef = useRef(0);
  /** 组件是否已卸载（抽屉关掉 / 换沙箱）：在途结果一律丢弃。 */
  const disposedRef = useRef(false);

  // 换沙箱 / 卸载：作废在途请求的结果（不让旧沙箱的反馈落到新沙箱的界面上）。
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      requestTokenRef.current += 1;
      inFlightRef.current = false;
    };
  }, [sandbox]);

  /** 刷新一条注入的托管副本。 */
  const refresh = useCallback(
    async (entry: InjectionInfo) => {
      // **防重入**：同一沙箱一次只做一个（服务端同沙箱互斥，并发回 409）。
      // 用 ref 判而不是 state：连续两次点击落在同一批次里时 state 还没更新。
      if (inFlightRef.current) {
        return;
      }
      inFlightRef.current = true;
      const token = requestTokenRef.current + 1;
      requestTokenRef.current = token;
      setBusyEntryId(entry.entry_id);
      try {
        await api.refreshInjection(sandbox, entry.entry_id);
        if (disposedRef.current || requestTokenRef.current !== token) {
          return;
        }
        show('success', '副本已刷新', { source: 'injection-refresh' });
      } catch (exc) {
        if (disposedRef.current || requestTokenRef.current !== token) {
          return;
        }
        // 失败原因**原文展示**（后端 detail）：含「可能部分更新」的语义。
        show('error', errorMessage(exc), { source: 'injection-refresh' });
      } finally {
        inFlightRef.current = false;
        if (!disposedRef.current && requestTokenRef.current === token) {
          setBusyEntryId(null);
        }
      }
    },
    [sandbox, show],
  );

  // 没有条目（**旧实例 / 无注入声明**）：**不出现刷新入口**，整区不渲染。
  if (injections.length === 0) {
    return null;
  }

  return (
    <ul className="m-0 list-none space-y-1.5 p-0" data-testid="page-sandbox-detail-injections">
      {injections.map((item) => {
        const busy = busyEntryId === item.entry_id;
        // 别的行在途时也禁用（一个沙箱一次只做一个）；条目不可刷新时同样禁用。
        const disabled = busyEntryId !== null || !item.can_refresh;
        const hint = item.can_refresh
          ? '刷新副本'
          : '沙箱未运行，无法刷新副本';
        return (
          <li
            key={item.entry_id}
            className="rounded-lg border border-border bg-card px-3 py-2"
            data-testid="page-sandbox-detail-injection-item"
            data-entry-id={item.entry_id}
            data-kind={item.kind}
          >
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
              <div className="min-w-0 flex-1">
                <p className="m-0 break-all font-mono text-[12px] text-foreground">
                  {item.source_path} → {item.container_path}
                </p>
                <p className="mt-1 mb-0 text-[11.5px] text-muted-foreground">
                  {kindLabel(item.kind)} · {item.read_only ? '只读' : '可写'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void refresh(item)}
                disabled={disabled}
                data-testid="page-sandbox-detail-injection-refresh"
                data-entry-id={item.entry_id}
                aria-busy={busy}
                title={hint}
                aria-label={`${hint}：${item.container_path}`}
                className="inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
                刷新副本
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
