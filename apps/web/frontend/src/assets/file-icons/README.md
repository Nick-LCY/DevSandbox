# 文件图标资产

## 来源

- **material-icon-theme 子集**：来源钉在
  `https://cdn.jsdelivr.net/gh/material-extensions/vscode-material-icon-theme@v5.40.0/icons/<名>.svg`
  （tag `v5.40.0`）。共 **111** 个，按 `src/lib/file-transfer.ts` 的映射表去重后
  逐个下载，**逐个校验 HTTP 200 且响应以 `<svg` 开头**。
- **通用兜底**：`folder.svg` / `file.svg` 由用户提供并验收（原先暂存在仓库根目录，
  本任务移入本目录）。映射表里未知扩展名 → `file.svg`，未知目录名 → `folder.svg`。
- 该版本**没有**通用 `folder.svg` / `file.svg`，也没有 `*_open` 变体；展开态用样式表达。

## 使用

- 图标名映射（扩展名 / 精确文件名 / 目录语义 → 资产名）在 `src/lib/file-transfer.ts`。
- 资产名 → 构建产物 URL 在 `src/lib/file-icon-assets.ts`（`import.meta.glob`）。
- **运行时零 CDN 依赖**：所有图标都是本地资产 import；新增图标只需把 SVG 放进本目录
  并在映射表里登记资产名。
