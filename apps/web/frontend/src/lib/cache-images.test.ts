/**
 * 缓存镜像清单的纯逻辑：十进制人读大小、UTC 缓存时间、短摘要、多标签展开与
 * 本地搜索过滤。
 *
 * 口径与服务端 `apps/web/backend/src/sandbox_console/cache_images.py` 一致
 * （十进制 1000 进制、1 位小数、中点取偶、UTC 墙钟、按 (repo, tag) 排序）——
 * 前端表格要与沙箱内 `cached-images` 命令的输出对得上。
 */

import { describe, expect, it } from 'vitest';

import type { CachedImage } from '../api/types';
import {
  digestHex,
  expandImageRows,
  filterImageRows,
  formatCachedTimeUtc,
  formatSizeDecimal,
  shortImageId,
} from './cache-images';

/** 一条缓存镜像条目（字段与后端 `to_payload()` 逐字段对应）。 */
function makeImage(overrides: Partial<CachedImage> = {}): CachedImage {
  return {
    repo: 'library/nginx',
    tags: ['latest'],
    digest: 'sha256:aa27bb3390799fefbf6b0ea27ff75b6b44d21beb6f8be93919fedcb0e60b3ea2',
    total_size_bytes: 1610612736,
    cached_at: '2026-11-14T10:30:00+00:00',
    ...overrides,
  };
}

describe('formatSizeDecimal', () => {
  it('字节档：整数字节（不带小数点）', () => {
    expect(formatSizeDecimal(0)).toBe('0B');
    expect(formatSizeDecimal(1)).toBe('1B');
    expect(formatSizeDecimal(933)).toBe('933B');
    expect(formatSizeDecimal(999)).toBe('999B');
  });

  it('十进制单位逐级放大（1000 进制，不是 1024）', () => {
    expect(formatSizeDecimal(1000)).toBe('1kB');
    expect(formatSizeDecimal(5800)).toBe('5.8kB');
    expect(formatSizeDecimal(19300000)).toBe('19.3MB');
    expect(formatSizeDecimal(1610612736)).toBe('1.6GB');
    expect(formatSizeDecimal(10 ** 15)).toBe('1TB');
  });

  it('整数不带 .0', () => {
    expect(formatSizeDecimal(1000)).toBe('1kB');
    expect(formatSizeDecimal(2000)).toBe('2kB');
    expect(formatSizeDecimal(1024)).toBe('1kB');
  });

  it('本单元内四舍五入满 1000 即升单元（不出现 1000kB 这种行）', () => {
    expect(formatSizeDecimal(999949)).toBe('999.9kB');
    expect(formatSizeDecimal(999999)).toBe('1MB');
    expect(formatSizeDecimal(999999999)).toBe('1GB');
    // TB 是兜底封顶位：到此不再进位。
    expect(formatSizeDecimal(10 ** 18)).toBe('1000TB');
  });

  it('中点取偶（与服务端 Python 的 f"{x:.1f}" 同款）', () => {
    expect(formatSizeDecimal(1250)).toBe('1.2kB');
    expect(formatSizeDecimal(2250)).toBe('2.2kB');
    expect(formatSizeDecimal(1350)).toBe('1.4kB');
  });

  it('负数与非有限数回落占位符', () => {
    expect(formatSizeDecimal(-1)).toBe('—');
    expect(formatSizeDecimal(Number.NaN)).toBe('—');
    expect(formatSizeDecimal(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatCachedTimeUtc', () => {
  it('按 UTC 墙钟渲染到秒（不落本地时区）', () => {
    expect(formatCachedTimeUtc('2026-11-14T10:30:00+00:00')).toBe('2026-11-14 10:30:00');
    expect(formatCachedTimeUtc('2026-11-14T10:30:00Z')).toBe('2026-11-14 10:30:00');
  });

  it('非 UTC 偏移的输入归一到 UTC', () => {
    expect(formatCachedTimeUtc('2026-11-14T12:30:00+02:00')).toBe('2026-11-14 10:30:00');
  });

  it('不带时区标记的输入按 UTC 解读（与服务端 naive 口径一致）', () => {
    expect(formatCachedTimeUtc('2026-11-14T10:30:00')).toBe('2026-11-14 10:30:00');
    expect(formatCachedTimeUtc('2026-11-14')).toBe('2026-11-14 00:00:00');
  });

  it('非法值回落占位符', () => {
    expect(formatCachedTimeUtc('')).toBe('—');
    expect(formatCachedTimeUtc('不是时间')).toBe('—');
  });
});

describe('shortImageId', () => {
  it('去 sha256: 前缀后取前 12 位十六进制', () => {
    expect(shortImageId('sha256:aa27bb3390799fefbf6b0ea27ff75b6b44d21beb6f8be93919fedcb0e60b3ea2')).toBe(
      'aa27bb339079',
    );
  });

  it('没有前缀时同样取前 12 位', () => {
    expect(shortImageId('aa27bb3390799fef')).toBe('aa27bb339079');
  });

  it('不足 12 位时原样返回', () => {
    expect(shortImageId('sha256:abc')).toBe('abc');
  });

  it('与服务端逐字同语义：不转小写、不去空白（原样取前 12 位）', () => {
    // 服务端是 `digest.removeprefix("sha256:")[:12]`：原样取，不小写化。
    expect(shortImageId('sha256:AA27BB3390799F')).toBe('AA27BB339079');
    expect(shortImageId('AA27BB3390799F')).toBe('AA27BB339079');
    // 前缀只认小写的 `sha256:`（与 Python 的 removeprefix 同款）。
    expect(shortImageId('SHA256:aa27bb339079')).toBe('SHA256:aa27b');
  });
});

describe('digestHex', () => {
  it('去前缀并转小写（只用于搜索匹配径）', () => {
    expect(digestHex('sha256:AA27BB')).toBe('aa27bb');
    expect(digestHex('AA27BB')).toBe('aa27bb');
  });

  it('搜索匹配走小写化：大小写不敏感的子串命中', () => {
    const rows = expandImageRows([
      makeImage({
        repo: 'library/nginx',
        tags: ['latest'],
        digest: 'sha256:AA27BB339079',
      }),
    ]);
    expect(filterImageRows(rows, 'aa27bb3390').map((row) => row.image)).toEqual([
      'library/nginx:latest',
    ]);
    expect(filterImageRows(rows, 'AA27BB3390').map((row) => row.image)).toEqual([
      'library/nginx:latest',
    ]);
  });
});

describe('expandImageRows', () => {
  it('一个镜像的多个标签展开成多行（ID / 大小 / 时间逐行重复）', () => {
    const rows = expandImageRows([
      makeImage({ repo: 'library/nginx', tags: ['1.27', 'latest'] }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.image)).toEqual(['library/nginx:1.27', 'library/nginx:latest']);
    expect(rows[0].digest).toBe(rows[1].digest);
    expect(rows[0].totalSizeBytes).toBe(rows[1].totalSizeBytes);
    expect(rows[0].cachedAt).toBe(rows[1].cachedAt);
  });

  it('按 (repo, tag) 排序', () => {
    const rows = expandImageRows([
      makeImage({ repo: 'quay.io/example/app', tags: ['v2', 'v1'] }),
      makeImage({ repo: 'library/nginx', tags: ['latest', '1.27'] }),
    ]);

    expect(rows.map((row) => row.image)).toEqual([
      'library/nginx:1.27',
      'library/nginx:latest',
      'quay.io/example/app:v1',
      'quay.io/example/app:v2',
    ]);
  });

  it('没有标签的条目不产生行', () => {
    expect(expandImageRows([makeImage({ tags: [] })])).toEqual([]);
  });

  it('空清单得到空行集', () => {
    expect(expandImageRows([])).toEqual([]);
  });
});

describe('filterImageRows', () => {
  const rows = expandImageRows([
    makeImage({
      repo: 'library/nginx',
      tags: ['1.27', 'latest'],
      digest: 'sha256:aa27bb3390799fefbf6b0ea27ff75b6b44d21beb6f8be93919fedcb0e60b3ea2',
    }),
    makeImage({
      repo: 'quay.io/example/app',
      tags: ['v1'],
      digest: 'sha256:bbb8f4dcd8b9a1e26ee1e2d1f5c7a03e9d4b1a2c3d4e5f60718293a4b5c6d7e8f',
    }),
  ]);

  it('空查询返回全部', () => {
    expect(filterImageRows(rows, '')).toHaveLength(3);
    expect(filterImageRows(rows, '   ')).toHaveLength(3);
  });

  it('大小写不敏感地按 repo:tag 子串匹配', () => {
    expect(filterImageRows(rows, 'NGINX').map((row) => row.image)).toEqual([
      'library/nginx:1.27',
      'library/nginx:latest',
    ]);
    expect(filterImageRows(rows, 'quay.io/example/app:v1').map((row) => row.image)).toEqual([
      'quay.io/example/app:v1',
    ]);
  });

  it('命中摘要（不带前缀）时该镜像整组行都显示', () => {
    const hits = filterImageRows(rows, 'aa27bb339079');
    expect(hits.map((row) => row.image)).toEqual([
      'library/nginx:1.27',
      'library/nginx:latest',
    ]);
  });

  it('命中摘要（带 sha256: 前缀）同样整组显示', () => {
    const hits = filterImageRows(rows, 'sha256:bbb8f4dcd8b9');
    expect(hits.map((row) => row.image)).toEqual(['quay.io/example/app:v1']);
  });

  it('没有命中时返回空行集', () => {
    expect(filterImageRows(rows, '不存在的镜像')).toEqual([]);
  });
});
