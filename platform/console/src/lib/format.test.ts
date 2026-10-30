import { describe, expect, it } from 'vitest';

import { formatBytes, formatTimestamp, orPlaceholder } from './format';

describe('formatBytes', () => {
  it('小于 1 KiB 时显示整数字节', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('按二进制单位逐级放大', () => {
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MiB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GiB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TiB');
  });

  it('负数与非有限数显示占位符', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatTimestamp', () => {
  it('空值与非法值显示占位符', () => {
    expect(formatTimestamp('')).toBe('—');
    expect(formatTimestamp(null)).toBe('—');
    expect(formatTimestamp('不是时间')).toBe('—');
  });

  it('合法 ISO 时间戳按本地时间展示到秒', () => {
    const formatted = formatTimestamp('2026-10-30T04:36:00+00:00');
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('orPlaceholder', () => {
  it('空串与空白都换成占位符', () => {
    expect(orPlaceholder('')).toBe('（无）');
    expect(orPlaceholder('   ')).toBe('（无）');
    expect(orPlaceholder(null)).toBe('（无）');
    expect(orPlaceholder('abc')).toBe('abc');
  });
});
