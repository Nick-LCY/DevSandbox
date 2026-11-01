/** 展示层的格式化：字节数、时间戳、布尔值。 */

/** 二进制单位（与 `ls -h` 一致）。 */
const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

/** 把字节数格式化成人类可读文本。负数或非有限数一律显示为占位符。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unitIndex]}`;
}

/** 把 ISO 时间戳格式成本地时间 `YYYY-MM-DD HH:mm:ss`。空值或非法值显示为占位符。 */
export function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '—';
  }
  const pad = (part: number): string => String(part).padStart(2, '0');
  return (
    `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ` +
    `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`
  );
}

/** 布尔值的中文展示。 */
export function formatBoolean(value: boolean): string {
  return value ? '是' : '否';
}

/** 空列表的占位文案。 */
export function orPlaceholder(value: string | null | undefined, placeholder = '（无）'): string {
  if (value === null || value === undefined) {
    return placeholder;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : placeholder;
}
