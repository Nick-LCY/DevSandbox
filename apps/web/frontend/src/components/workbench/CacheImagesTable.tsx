import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '../../api/client';
import type { CacheImagesResponse } from '../../api/types';
import {
  expandImageRows,
  filterImageRows,
  formatCachedTimeUtc,
  formatSizeDecimal,
  shortImageId,
} from '../../lib/cache-images';
import { useToast } from '../Toast';
import { Input } from '../ui/input';

/**
 * 缓存镜像清单区（设置抽屉「代理」tab 的下半区）。
 *
 * 展示**有标签的拉取过的镜像**（`?tags=only` 视图：与服务端
 * `filter_tag_only` 同语义，与沙箱内 `cached-images` 命令消费的是同一份
 * 视图）。数据源 `GET /api/proxy/cache/images?format=json&tags=only`
 * （完整令牌，既有鉴权头自动附带，无新增令牌逻辑）。
 *
 * 表格口径**与服务端 `render_cache_images_tag_only_table` 对齐**：列是
 * IMAGE / ID / SIZE / CACHED TIME，一个镜像的多个标签**展开成多行**
 * （ID / 大小 / 时间逐行重复），行按 (repo, tag) 排序；SIZE 是**十进制**
 * 人读大小（1000 进制，`formatSizeDecimal`），缓存时间是 **UTC** 墙钟
 * （`formatCachedTimeUtc`）——与沙箱内命令的输出对得上。
 *
 * 搜索是**纯本地过滤**（不发请求）：大小写不敏感子串匹配 `repo:tag`，
 * 查询串命中摘要时该镜像整组行都显示。
 *
 * 三态与刷新：打开抽屉加载一次 + 手动刷新按钮；**零轮询**——不挂任何定时器
 * （后端另有 60 秒 TTL 内存缓存，前端再轮询只是重复打点；清单新鲜度由生成
 * 时间戳 + 手动刷新表达）。
 *
 * 失败口径对齐模板管理区：失败 toast + 就地一行 role=status 说明，
 * 已拿到的旧清单保留展示（不白屏、不清空既有内容）。
 */
export function CacheImagesTable({ open }: { open: boolean }) {
  const { show } = useToast();
  const [manifest, setManifest] = useState<CacheImagesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  /** 读取失败的原因（环境状态说明用 role=status，操作结果仍走 toast）。 */
  const [loadError, setLoadError] = useState('');
  /** 本地搜索词（纯前端过滤，不发请求）。 */
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      // 只取有标签的条目（tags=only）：与服务端 / 沙箱内命令同视图。
      setManifest(await api.cacheImages({ tagsOnly: true }));
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : '读取缓存镜像清单失败';
      setLoadError(message);
      // 读取失败：弹失败 toast + 就地说明（对齐模板管理区的失败口径）。
      show('error', message, { source: 'settings-cache-images' });
    } finally {
      setLoading(false);
    }
  }, [show]);

  // 打开抽屉时加载一次 + 手动刷新；零轮询：不挂任何定时器（既不周期触发，
  // 也不延迟重试，清单新鲜度由生成时间戳 + 手动刷新表达）。
  useEffect(() => {
    if (!open) {
      return;
    }
    void load();
  }, [open, load]);

  /** 展开成表格行（多标签展开 + 排序）。 */
  const rows = useMemo(() => expandImageRows(manifest?.images ?? []), [manifest]);
  /** 本地搜索过滤（不发请求）。 */
  const visibleRows = useMemo(() => filterImageRows(rows, query), [rows, query]);

  return (
    <section aria-label="缓存镜像清单" className="flex min-h-[7rem] flex-1 flex-col">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-foreground">缓存镜像清单</h3>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          data-testid="page-settings-cache-images-refresh-button"
          className="inline-flex h-7 items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-2 text-[12.5px] text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        >
          {loading ? (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              正在刷新
            </>
          ) : (
            '刷新清单'
          )}
        </button>
      </div>

      {/* 搜索框属于清单区的固定部分（不随表格滚动）：纯本地过滤，不发请求。 */}
      <Input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索镜像"
        aria-label="搜索镜像"
        autoComplete="off"
        spellCheck={false}
        data-testid="page-settings-cache-images-search-input"
        // 固定部分：清单区矮时不允许被压扁。
        className="mt-2 shrink-0"
      />

      {loading && manifest === null && (
        <p
          className="mt-2 text-[12.5px] text-muted-foreground"
          data-testid="page-settings-cache-images-loading"
        >
          正在读取缓存镜像清单…
        </p>
      )}

      {loadError && (
        <p
          // 环境状态说明（不是操作结果），故走 role=status 而不是行内红字。
          role="status"
          className="mt-2 text-[12px] text-muted-foreground"
          data-testid="page-settings-cache-images-status"
        >
          缓存镜像清单读取失败，原因见右上角提示：{loadError}
        </p>
      )}

      {!loading && !loadError && rows.length === 0 && (
        <p
          className="mt-2 text-[12.5px] text-muted-foreground"
          data-testid="page-settings-cache-images-empty"
        >
          还没有带标签的镜像。
        </p>
      )}

      {/* 搜索无命中与「清单本身为空」是两种空态：分开文案、分开标识。 */}
      {rows.length > 0 && visibleRows.length === 0 && (
        <p
          className="mt-2 text-[12.5px] text-muted-foreground"
          data-testid="page-settings-cache-images-search-empty"
        >
          没有匹配的镜像。
        </p>
      )}

      {visibleRows.length > 0 && (
        <div
          className="mt-2 min-h-0 flex-1 overflow-auto rounded-lg border border-border"
          data-testid="page-settings-cache-images-scroll"
        >
          <table
            // border-separate（不是 border-collapse）：Chromium 下 collapse 模式
            // 里 sticky 表头的底边会随内容滚走；分离模式 + 边框挂在 th/td 上，
            // 表头与其底边一起吸顶。
            className="w-full table-fixed border-separate border-spacing-0 text-[12px]"
            data-testid="page-settings-cache-images-table"
          >
            {/* 表头吸顶：滚动时固定在表格区顶部（底色用令牌，不透视）。 */}
            <thead className="sticky top-0 z-10 bg-popover" data-testid="page-settings-cache-images-head">
              {/*
                列宽固定（table-fixed）：IMAGE 列吃掉剩余空间、长名截断
                （完整值挂 title），ID / SIZE / CACHED TIME 三列宽度是定值，
                短摘要与时间戳**永远完整可见**。
              */}
              <tr>
                <th className="w-[33%] border-b border-border px-2 py-2 text-left font-medium text-muted-foreground">
                  IMAGE
                </th>
                <th className="w-[23%] border-b border-border px-2 py-2 text-left font-medium text-muted-foreground">
                  ID
                </th>
                <th className="w-[14%] border-b border-border px-2 py-2 text-right font-medium text-muted-foreground">
                  SIZE
                </th>
                <th className="w-[30%] border-b border-border px-2 py-2 text-left font-medium text-muted-foreground">
                  CACHED TIME
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr
                  key={`${row.repo}:${row.tag}:${row.digest}`}
                  // 边框挂在单元格上（分离模式下行/行组的边框不画）。
                  className="hover:bg-muted/60 last:[&>td]:border-b-0"
                  data-testid="page-settings-cache-images-row"
                  data-image-repo={row.repo}
                  data-image-tag={row.tag}
                >
                  <td
                    className="truncate border-b border-border px-2 py-1.5 font-medium text-foreground"
                    title={row.image}
                    data-testid="page-settings-cache-images-image"
                  >
                    {row.image}
                  </td>
                  <td
                    className="truncate border-b border-border px-2 py-1.5 font-mono text-[11.5px] text-muted-foreground"
                    // 完整 digest 挂 title（悬停看全文）；单元格展示前 12 位。
                    title={row.digest}
                    data-testid="page-settings-cache-images-id"
                  >
                    {shortImageId(row.digest)}
                  </td>
                  <td
                    className="border-b border-border px-2 py-1.5 text-right tabular-nums text-foreground"
                    data-testid="page-settings-cache-images-size"
                  >
                    {formatSizeDecimal(row.totalSizeBytes)}
                  </td>
                  <td
                    className="truncate border-b border-border px-2 py-1.5 tabular-nums text-muted-foreground"
                    data-testid="page-settings-cache-images-time"
                  >
                    {formatCachedTimeUtc(row.cachedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {manifest !== null && (
        <p
          className="mt-2 shrink-0 text-[12px] text-muted-foreground"
          data-testid="page-settings-cache-images-generated-at"
        >
          清单生成时间：{formatCachedTimeUtc(manifest.generated_at)}
        </p>
      )}
    </section>
  );
}
