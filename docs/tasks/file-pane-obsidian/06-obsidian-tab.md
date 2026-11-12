---
prd: prds/file-pane-obsidian.md
status: todo
---
# 任务：Obsidian tab 骨架（固定 tab、双栏、vault 树）

> 需求见 [[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
> **依赖 04**（本任务要动同一片终端标签区与内容区布局）。
> **不含 markdown 渲染与 wikilink**——那部分在 07 轮；本轮先把骨架与 vault 树立起来。

## 目标

在 tabs 条**最左**加一个**固定的 Obsidian tab**，激活时展示**全宽双栏**的 vault 阅读器骨架（左树右预览），并能**设 vault 根**、**浏览 vault 树**。

### 要落地的口径

- **固定 tab**：tabs 条**最左**，**gem 图标**（lucide-react **v1.65.0 无品牌图标**，Obsidian 的 logo 是宝石）+「**Obsidian**」文字；**不可关闭、无关闭按钮**；**独立于终端会话**存在——**没有任何终端会话时仍然可用**。
- **与文件窗格联动**：激活 Obsidian tab 时**文件窗格隐藏**；切回终端 tab 时窗格**按原折叠态恢复**。
- **布局**：**全宽双栏**——左 **vault 树** + 右预览区，中间一条细**分隔线**（**无拖拽**）。
- **vault 根未设**：右侧显示**引导态**（居中）——书本线框图标 +「**选择一个目录作为 vault 根**」+「**使用沙箱工作目录**」描边按钮 + **路径输入框** +「**打开**」按钮——**两条入口都可用**。
- **vault 根已设**：左栏顶部显示「**vault 根：<路径>**」+「**更改**」小按钮（点击**回引导态并预填原根**）；vault 根**按沙箱记在前端本地**（换沙箱各自记忆，**不入后端**）。
- **vault 树**：**树形展开风格**（三角箭头旋转、缩进层级线）；**只列目录与 `.md` 文件**；目录可展开 / 收起，**展开态按路径在前端本地记忆**。

## 涉及文件

- `apps/web/frontend/src/components/TerminalPanel.tsx` 及其标签条相关组件 — 固定 Obsidian tab（最左）、激活态切换
- `apps/web/frontend/src/components/workbench/`（新增）— Obsidian 双栏视图组件（vault 树 / 引导态 / 预览占位区）
- `apps/web/frontend/src/lib/`（新增）— vault 根存取（按沙箱）、树展开态存取、目录列举等纯函数 + 单测
- `apps/web/frontend/src/api/client.ts` — 复用既有目录列举能力（`list`）
- `apps/web/frontend/README.md` — 标识表登记

## 完成标准

- [ ] tabs 条**最左**有**固定**的 Obsidian tab：**gem 图标** +「**Obsidian**」文字，**不可关闭、无关闭按钮**；**没有任何终端会话时该 tab 仍可用**（对应 PRD 验收项 **OBS-01**）。
- [ ] 激活 Obsidian tab 时**文件窗格隐藏**、切回终端 tab 时窗格**按原折叠态恢复**；Obsidian 视图为**全宽双栏**（左 vault 树 + 右预览区），中间一条细分隔线、**不可拖拽**（对应 PRD 验收项 **OBS-02**）。
- [ ] **未设 vault 根**时右侧显示**引导态**：居中书本线框图标 +「**选择一个目录作为 vault 根**」+「**使用沙箱工作目录**」描边按钮 + **路径输入框** +「**打开**」按钮；**两条入口都可用**（按钮与输入框两条路径均能成功设根）（对应 PRD 验收项 **OBS-03**）。
- [ ] **已设 vault 根**时左栏顶部显示「**vault 根：<路径>**」+「**更改**」小按钮，点击**回引导态并预填原根**；vault 根**按沙箱记在前端本地**、**不入后端**（对应 PRD 验收项 **OBS-04**）。
- [ ] vault 树为**树形展开风格**（三角箭头旋转 + 缩进层级线），**只列目录与 `.md` 文件**；目录可展开 / 收起，**展开态按路径在前端本地记忆**（刷新后仍在）（对应 PRD 验收项 **OBS-05**）。
- [ ] 前端**标识表**登记新增标识；门禁（vitest / typecheck / build）全绿。

## 依赖

- 依赖 [[tasks/file-pane-obsidian/04-file-pane-split.md|04 文件窗格分屏骨架]]（同一片标签区与内容区布局）。
- 需求：[[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
