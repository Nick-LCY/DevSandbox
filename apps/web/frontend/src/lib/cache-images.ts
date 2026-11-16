/**
 * 缓存镜像清单的纯逻辑：十进制人读大小、UTC 缓存时间、短摘要、多标签展开与
 * 本地搜索过滤。
 *
 * **与服务端同口径**（这一段是硬要求）：服务端
 * `apps/web/backend/src/sandbox_console/cache_images.py` 的
 * `format_size_decimal` / `format_cached_time` /
 * `render_cache_images_tag_only_table` 与这里是同一套算法——十进制（1000
 * 进制）单位、1 位小数、整数不带 `.0`、满 999.95 升单元、缓存时间按 UTC
 * 墙钟渲染、清单按 (repo, tag) 排序。前端表格要与沙箱内 `cached-images`
 * 命令的输出对得上，口径分叉就会让两处显示不同的数。
 *
 * 注意与 `src/lib/format.ts` 的 `formatBytes` **刻意并存两套**：那边是
 * 二进制（KiB / MiB，1024 进制，console 其余处沿用），这边是十进制
 * （B / kB / MB，1000 进制，镜像清单表格专用）。
 */

import type { CachedImage } from '../api/types';

/** 十进制（1000 进制）单位序列，与服务端 `_SIZE_UNITS_DECIMAL` 同序。 */
const SIZE_UNITS_DECIMAL = ['B', 'kB', 'MB', 'GB', 'TB'] as const;

/** 表格里的一行：一个镜像的一个标签（同一镜像多标签展开成多行）。 */
export interface CacheImageRow {
  /** 仓库名。 */
  repo: string;
  /** 标签。 */
  tag: string;
  /** `repo:tag`（表格的 IMAGE 列）。 */
  image: string;
  /** 完整摘要（`sha256:` 前缀在不在都原样带着）。 */
  digest: string;
  /** 镜像链的声明字节数。 */
  totalSizeBytes: number;
  /** 缓存时间（ISO 8601 UTC 原文）。 */
  cachedAt: string;
}

/**
 * 把字节数格式化成十进制（1000 进制）人读大小：`933B` / `5.8kB` / `19.3MB`。
 *
 * 与服务端 `format_size_decimal` **逐行为对齐**：
 * - 单位序列 `B / kB / MB / GB / TB`，每级 1000；
 * - 1 位小数，整数不带 `.0`（`1kB` 不是 `1.0kB`）；
 * - 本单元内四舍五入满 1000 即升单元（`999999B` → `1MB`，不是 `1000kB`）；
 * - TB 是兜底封顶位，到此不再进位；
 * - 非有限数与负数回落占位符 `—`（服务端只吃整数，前端多一层防御）。
 *
 * **小数位的四舍五入与 Python 的 `f"{x:.1f}"` 同款**（精确值恰好落在中点时
 * 取偶数）：`1250` → `1.2kB`（不是 `1.3kB`）。这里不用 `toFixed`——它的
 * 中点处理是「取大」，与 Python 差一档。
 */
export function formatSizeDecimal(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  let size = bytes;
  let unitIndex = SIZE_UNITS_DECIMAL.length - 1;
  for (let index = 0; index < SIZE_UNITS_DECIMAL.length; index += 1) {
    if (size < 999.95) {
      unitIndex = index;
      break;
    }
    size /= 1000;
  }
  const unit = SIZE_UNITS_DECIMAL[unitIndex];
  if (unit === 'B') {
    return `${Math.trunc(size)}B`;
  }
  const text = formatOneDecimal(size);
  return text.endsWith('.0') ? `${text.slice(0, -2)}${unit}` : `${text}${unit}`;
}

/**
 * 缓存时间渲染：`YYYY-MM-DD HH:mm:ss`（**UTC 墙钟**，不落本地时区）。
 *
 * 与服务端 `format_cached_time` 同口径：解析后按 UTC 渲染，非 UTC 偏移的
 * 输入归一到 UTC。非法值回落占位符 `—`（服务端是原样返回，服务端那一侧
 * 的脏数据不炸渲染，前端这里给占位符）。
 */
export function formatCachedTimeUtc(value: string): string {
  const parsed = new Date(normalizeUtcIso(value));
  if (Number.isNaN(parsed.getTime())) {
    return '—';
  }
  const iso = parsed.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

/**
 * 短摘要：去掉 `sha256:` 前缀后取前 12 位十六进制（表格的 ID 列）。
 *
 * 完整 digest 挂在单元格的 `title` 上（悬停看全文）。
 */
export function shortImageId(digest: string): string {
  return digestHex(digest).slice(0, 12);
}

/** 摘要里的十六进制本体（去 `sha256:` 前缀，小写）。 */
export function digestHex(digest: string): string {
  const trimmed = digest.trim();
  const withoutPrefix = trimmed.startsWith('sha256:') ? trimmed.slice('sha256:'.length) : trimmed;
  return withoutPrefix.toLowerCase();
}

/**
 * 清单展开成表格行：**一个镜像的多个标签展开成多行**（ID / 大小 / 时间
 * 逐行重复），行按 (repo, tag) 排序（对齐服务端 `render_cache_images_tag_only_table`
 * 的排序）。
 *
 * 没有标签的条目不产生行（`tags=only` 视图下服务端已经滤过，这里再兜一层）。
 */
export function expandImageRows(images: CachedImage[]): CacheImageRow[] {
  const rows: CacheImageRow[] = [];
  for (const image of images) {
    for (const tag of image.tags) {
      rows.push({
        repo: image.repo,
        tag,
        image: `${image.repo}:${tag}`,
        digest: image.digest,
        totalSizeBytes: image.total_size_bytes,
        cachedAt: image.cached_at,
      });
    }
  }
  // 稳定排序（同一 repo + tag 的两条按原顺序留）——与服务端的稳定排序同款。
  rows.sort((left, right) => compareText(left.repo, right.repo) || compareText(left.tag, right.tag));
  return rows;
}

/**
 * 本地搜索过滤（**不发请求**）：大小写不敏感子串匹配 `repo:tag`。
 *
 * 命中摘要时**该镜像整组行都显示**——查询串可以带 `sha256:` 前缀，也可以
 * 不带（两种写法都认）；只给摘要片段时按摘要本体子串匹配。
 *
 * 空查询 = 全部（不清空已有筛选）。
 */
export function filterImageRows(rows: CacheImageRow[], query: string): CacheImageRow[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === '') {
    return rows;
  }
  // 摘要查询：去掉 `sha256:` 前缀后按摘要本体（十六进制）子串匹配。
  const digestQuery = trimmed.startsWith('sha256:') ? trimmed.slice('sha256:'.length) : trimmed;
  const digestHits = new Set<string>();
  if (digestQuery !== '') {
    for (const row of rows) {
      if (digestHex(row.digest).includes(digestQuery)) {
        digestHits.add(row.digest);
      }
    }
  }
  return rows.filter(
    (row) => row.image.toLowerCase().includes(trimmed) || digestHits.has(row.digest),
  );
}

/** 字符串比较（码位序；与服务端 Python 的字符串排序同款）。 */
function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/**
 * 没有时区标记的 ISO 时间串按 UTC 解读。
 *
 * 服务端 `datetime.fromisoformat` 对不带偏移的输入按「已经是 UTC」处理
 * （naive datetime 直接格式化），浏览器的 `new Date` 却按**本地时区**解读
 * 同款输入——不归一的话，同一条数据在两端会差一个时区偏移。
 */
function normalizeUtcIso(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(trimmed)) {
    return `${trimmed.replace(' ', 'T')}Z`;
  }
  return trimmed;
}

/**
 * 把一个数按 1 位小数渲染，**中点取偶**（与 Python 的 `f"{x:.1f}"` 同款）。
 *
 * `toFixed` 的中点处理是「取大」（`1.25` → `1.3`），Python 是取偶
 * （`1.25` → `1.2`）——服务端表格与前端表格要逐字对得上，这里按 Python 走。
 *
 * 实现：把 double 的精确值拆成 `m * 2^e`，乘 10 后用 BigInt 做精确的
 * 四舍五入（不经过二进制浮点的十进制转换，中点判定才是准的）。
 */
function formatOneDecimal(value: number): string {
  const { mantissa, exponent } = decomposeDouble(value);
  // value * 10 = mantissa * 5 * 2^(exponent + 1)
  const scaled = mantissa * 5n;
  const shift = exponent + 1;
  const numerator = shift >= 0 ? scaled << BigInt(shift) : scaled;
  const denominator = shift >= 0 ? 1n : 1n << BigInt(-shift);
  const tenths = roundHalfEven(numerator, denominator);
  const negative = tenths < 0n;
  const absolute = negative ? -tenths : tenths;
  const text = `${absolute / 10n}.${absolute % 10n}`;
  return negative ? `-${text}` : text;
}

/** 把 double 的精确值拆成 `mantissa * 2^exponent`（mantissa 是 BigInt 整数）。 */
function decomposeDouble(value: number): { mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const negative = (bits >> 63n) === 1n;
  const rawExponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  if (rawExponent === 0) {
    // 次正规数：尾数没有隐含的最高位。
    return { mantissa: negative ? -fraction : fraction, exponent: -1074 };
  }
  const mantissa = fraction | (1n << 52n);
  return { mantissa: negative ? -mantissa : mantissa, exponent: rawExponent - 1075 };
}

/** `numerator / denominator` 四舍五入到整数，中点取偶（denominator > 0）。 */
function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const doubled = remainder * 2n;
  let result = quotient;
  if (doubled > denominator || (doubled === denominator && quotient % 2n === 1n)) {
    result = quotient + 1n;
  }
  return negative ? -result : result;
}
