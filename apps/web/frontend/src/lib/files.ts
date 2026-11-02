/**
 * 文件注入声明的前端解析与校验。
 *
 * 语法与后端 `sandbox_platform.files.parse_file_declaration` 一致：
 * `宿主路径:容器路径`（固定两段：容器内一律只读，没有读写标记段）。
 * 前端先校验一遍是为了早报错、少一次往返；后端仍会再校验一次，
 * 前端校验不替代后端校验。
 *
 * **宿主路径允许家目录写法**（`~` / `~/data`）：与挂载声明同口径，
 * 后端在落库前把 `~` 展开成服务运行用户的家目录。
 *
 * **宿主路径先归一化再判敏感清单**：``/tmp/../etc/passwd`` 与 ``//etc/passwd``
 * 词法上都不在 ``/etc`` 之下，归一化之后才看得穿（归一化在共享的
 * ``host-path.ts`` 里做，与后端 ``normalize_host_path`` 同款逻辑）。
 */

import { isSensitiveHostPath } from './mounts';

/** 一条文件注入声明（宿主路径 + 容器内路径）。 */
export interface FileRow {
  hostPath: string;
  containerPath: string;
}

/** 单条文件注入声明的解析结果。 */
export type FileParseResult =
  | { ok: true; declaration: FileRow }
  | { ok: false; error: string };

/**
 * 宿主路径是不是家目录写法（`~` 或 `~/…`）。
 *
 * `~other`（别人的家目录）不算：后端不展开它，核心包也会当非法路径拒掉。
 */
function isHomeRelativePath(hostPath: string): boolean {
  return hostPath === '~' || hostPath.startsWith('~/');
}

/**
 * 解析单条文件注入声明。
 *
 * 合法写法固定两段：`宿主路径:容器路径`。
 */
export function parseFileDeclaration(text: string): FileParseResult {
  const declaration = text.trim();
  if (declaration.length === 0) {
    return { ok: false, error: '文件注入声明不能为空' };
  }

  const parts = declaration.split(':');
  if (parts.length !== 2) {
    return {
      ok: false,
      error: `文件注入声明格式非法（应为 宿主路径:容器路径）：${declaration}`,
    };
  }

  const hostPath = parts[0].trim();
  const containerPath = parts[1].trim();

  if (!hostPath.startsWith('/') && !isHomeRelativePath(hostPath)) {
    return {
      ok: false,
      error: `注入文件的宿主路径必须是绝对路径，或以 ~/ 开头（如 ~/.ssh/id_ed25519）：${hostPath}`,
    };
  }
  if (hostPath.includes(',')) {
    return { ok: false, error: `注入路径不得包含逗号（Docker 挂载参数以逗号分段）：${hostPath}` };
  }
  if (!containerPath.startsWith('/')) {
    return { ok: false, error: `注入文件的容器内路径必须是绝对路径：${declaration}` };
  }
  if (isSensitiveHostPath(hostPath)) {
    return {
      ok: false,
      error: `宿主路径命中敏感清单，不允许注入文件：${hostPath}（宿主系统目录与 Docker 套接字均不可注入）`,
    };
  }

  return { ok: true, declaration: { hostPath, containerPath } };
}

/** 把一条文件注入声明还原成后端要的字符串格式。 */
export function formatFileDeclaration(row: FileRow): string {
  return `${row.hostPath}:${row.containerPath}`;
}

/**
 * 校验一组文件注入声明：宿主路径与容器内路径都不能重复。
 *
 * 返回错误文案，全部通过时返回 `null`。
 */
export function validateFileDeclarations(rows: FileRow[]): string | null {
  const seenHost = new Set<string>();
  const seenContainer = new Set<string>();
  for (const row of rows) {
    if (seenHost.has(row.hostPath)) {
      return `宿主路径重复声明：${row.hostPath}`;
    }
    seenHost.add(row.hostPath);
    if (seenContainer.has(row.containerPath)) {
      return `容器路径重复：${row.containerPath}`;
    }
    seenContainer.add(row.containerPath);
  }
  return null;
}
