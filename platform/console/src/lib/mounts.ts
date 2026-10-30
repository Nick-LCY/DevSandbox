/**
 * 挂载声明的前端解析与校验。
 *
 * 语法与后端 `sandbox_platform.mounts.parse_mount_declaration` 一致：
 * `宿主路径:容器路径[:ro]`。前端先校验一遍是为了早报错、少一次往返；
 * 后端仍会再校验一次，前端校验不替代后端校验。
 */

/** 宿主敏感目录：命中一律拒绝（与后端固定清单一致）。 */
export const SENSITIVE_HOST_DIRS = ['/etc', '/proc', '/sys', '/dev', '/boot', '/root'] as const;

/** 宿主 Docker 套接字：平台入口，不许挂进沙箱。 */
export const SENSITIVE_HOST_FILES = ['/var/run/docker.sock', '/run/docker.sock'] as const;

export interface MountDeclaration {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

export type MountParseResult =
  | { ok: true; declaration: MountDeclaration }
  | { ok: false; error: string };

function isUnder(path: string, base: string): boolean {
  const normalized = path.replace(/\/+$/, '') || '/';
  const normalizedBase = base.replace(/\/+$/, '') || '/';
  return normalized === normalizedBase || normalized.startsWith(`${normalizedBase}/`);
}

/** 判断宿主路径是否命中敏感清单。 */
export function isSensitiveHostPath(path: string): boolean {
  if (!path.startsWith('/')) {
    return false;
  }
  const dirs = SENSITIVE_HOST_DIRS.some((item) => isUnder(path, item));
  const files = SENSITIVE_HOST_FILES.some((item) => isUnder(path, item));
  return dirs || files;
}

/** 解析单条挂载声明。 */
export function parseMountDeclaration(text: string): MountParseResult {
  const declaration = text.trim();
  if (declaration.length === 0) {
    return { ok: false, error: '挂载声明不能为空' };
  }

  const parts = declaration.split(':');
  if (parts.length !== 2 && parts.length !== 3) {
    return { ok: false, error: `挂载声明格式非法（应为 宿主路径:容器路径[:ro]）：${declaration}` };
  }

  const hostPath = parts[0].trim();
  const containerPath = parts[1].trim();
  const mode = parts.length === 3 ? parts[2].trim() : '';

  if (!hostPath.startsWith('/')) {
    return { ok: false, error: `挂载的宿主路径必须是绝对路径：${hostPath}` };
  }
  if (hostPath.includes(',')) {
    return { ok: false, error: `挂载路径不得包含逗号（Docker 挂载参数以逗号分段）：${hostPath}` };
  }
  if (!containerPath.startsWith('/')) {
    return { ok: false, error: `挂载的容器路径必须是绝对路径：${containerPath}` };
  }
  if (mode !== '' && mode !== 'ro' && mode !== 'rw') {
    return { ok: false, error: `挂载模式只能是 ro 或 rw：${mode}` };
  }
  if (isSensitiveHostPath(hostPath)) {
    return {
      ok: false,
      error: `宿主路径命中敏感清单，不允许挂载：${hostPath}（宿主系统目录与 Docker 套接字均不可挂载）`,
    };
  }

  return {
    ok: true,
    declaration: { hostPath, containerPath, readOnly: mode === 'ro' },
  };
}

/** 把挂载声明还原成后端要的字符串格式。 */
export function formatMountDeclaration(declaration: MountDeclaration): string {
  const suffix = declaration.readOnly ? ':ro' : '';
  return `${declaration.hostPath}:${declaration.containerPath}${suffix}`;
}

/**
 * 校验一组挂载声明：容器路径不能重复。
 * 返回错误文案，全部通过时返回 `null`。
 */
export function validateMountDeclarations(declarations: MountDeclaration[]): string | null {
  const seen = new Set<string>();
  for (const declaration of declarations) {
    if (seen.has(declaration.containerPath)) {
      return `容器路径重复：${declaration.containerPath}`;
    }
    seen.add(declaration.containerPath);
  }
  return null;
}
