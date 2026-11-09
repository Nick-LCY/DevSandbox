/**
 * 图标资产表：把本地 SVG 子集映射成构建产物 URL。
 *
 * 资产全部来自 `src/assets/file-icons/`（material-icon-theme v5.40.0 的子集 +
 * 用户提供的通用 `folder.svg` / `file.svg`），**运行时零 CDN 依赖**。
 * 用 `import.meta.glob` 在构建期收集，新增图标只需把 SVG 放进目录。
 */

const modules = import.meta.glob('../assets/file-icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

function basename(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.svg$/i, '');
}

/** 资产名（不含扩展名）→ 构建产物 URL。 */
export const FILE_ICON_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(modules).map(([path, url]) => [basename(path), url]),
);

/** 取图标 URL；资产缺失时返回 `undefined`（面板会退回通用图标）。 */
export function fileIconUrl(icon: string): string | undefined {
  return FILE_ICON_URLS[icon];
}
