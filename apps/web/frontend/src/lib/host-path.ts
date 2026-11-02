/**
 * 宿主路径的词法归一化与范围判定（前端侧）。
 *
 * 与后端 `sandbox_platform.mounts.normalize_host_path` 同款逻辑：
 * 折叠 `.` / `..`，并把前导多斜杠压成一个。前端先归一化再判敏感清单，
 * `/tmp/../etc/passwd`、`//etc/passwd` 这类绕不过去（后端还会再判一次）。
 */

/**
 * 词法归一化：折叠 `.` / `..`，压平前导多斜杠。
 *
 * 只做词法折叠，不解析符号链接——符号链接由后端按真实路径复核。
 */
export function normalizeHostPath(raw: string): string {
  const collapsed = raw.replace(/\/{2,}/g, '/');
  const absolute = collapsed.startsWith('/');
  const out: string[] = [];
  for (const segment of collapsed.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      const last = out[out.length - 1];
      if (out.length > 0 && last !== '..') {
        out.pop();
      } else if (!absolute) {
        out.push('..');
      }
      continue;
    }
    out.push(segment);
  }
  const joined = out.join('/');
  return absolute ? `/${joined}` : joined;
}

/** 路径是否等于 base 或落在 base 之下（两边都先归一化再比）。 */
export function isUnderPath(path: string, base: string): boolean {
  const normalized = normalizeHostPath(path);
  const normalizedBase = normalizeHostPath(base);
  if (normalizedBase === '/') {
    return normalized.startsWith('/');
  }
  return normalized === normalizedBase || normalized.startsWith(`${normalizedBase}/`);
}
