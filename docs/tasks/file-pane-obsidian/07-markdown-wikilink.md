---
prd: prds/file-pane-obsidian.md
status: todo
---
# 任务：markdown 渲染与 wikilink 跳转

> 需求见 [[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
> **依赖 06**（Obsidian 骨架与 vault 树先落地）。

## 目标

把 Obsidian tab 的右栏从「占位区」做成**真正的阅读器**：**markdown 渲染**为主视图 + **wikilink 正向跳转**。

### 要落地的口径

- **渲染库**：以 **react-markdown** 为基座（其默认**不放行原始 HTML**）；任务列表等 GFM 语法按需引入配套插件。
- **工具条**：**返回**（历史栈）+ 文件名 / 大小 + 「**渲染 / 源码**」**分段切换** + **复制**。
- **渲染态**：内容列 **max-width 约 620px** 居中；标题层级、**深底代码块**、列表、**任务列表（静态不可勾）**、引用块、行内码、粗体。
- **frontmatter**（`---` 包裹的 YAML）**渲染态隐藏、源码态可见**。
- **wikilink**：支持 `\[\[目标\]\]` / `\[\[目标|别名\]\]` / `\[\[#标题\]\]`；样式 **强调色 + 虚线下划线**；hover 显示**黑色小 tooltip**（内容是**解析后的目标路径**，须**防视口裁切**）。
- **解析兜底顺序**：① 同目录 → ② vault 根相对路径 → ③ **全库递归同名匹配**（递归列举**带 exec 看门狗超时**）；解析结果**过 `normalizeContainerPath`**。
- **点击**：存在 ⇒ **沿预览历史栈推入**目标渲染视图；不存在 ⇒ 正文**顶部就地**浅红错误条「**链接目标不存在：<名>**」，**可手动关闭**、**不跳转、不弹 toast**。
- **复制**：**渲染态复制 markdown 源文**、**源码态复制原文**；对勾动画与成功零反馈口径同文件窗格预览。

### 解析逻辑必须纯函数化

wikilink 解析（语法切分 + 三级兜底 + 归一）是**纯逻辑**，收敛在 `src/lib/` 下并配**单元测试**：语法变体逐条钉死、兜底顺序逐条钉死、**全库递归同名匹配带 exec 看门狗超时**（超时按「未找到」处理，不挂死）。

## 涉及文件

- 前端依赖 — 引入 markdown 渲染库（**react-markdown 及其 GFM 插件**）
- `apps/web/frontend/src/components/workbench/`（Obsidian 视图组件）— 渲染 / 源码双态、frontmatter 处理、wikilink 渲染与点击、tooltip、错误条、复制
- `apps/web/frontend/src/lib/`（新增）— wikilink 解析纯函数 + 单元测试
- `apps/web/frontend/src/api/client.ts` — 复用 05 轮落地的只读端点与目录列举能力
- `apps/web/frontend/README.md` — 标识表登记

## 完成标准

- [ ] 预览以 **markdown 渲染**为主视图；工具条 = **返回**（历史栈）+ 文件名 / 大小 + 「**渲染 / 源码**」**分段切换** + **复制**（**渲染态复制 markdown 源文**、**源码态复制原文**；对勾动画与成功零反馈口径同文件窗格预览）（对应 PRD 验收项 **OBS-06**）。
- [ ] 渲染态：内容列 **max-width 约 620px** 居中，标题层级、**深底代码块**、列表、**任务列表（静态不可勾）**、引用块、行内码、粗体均正确呈现；**frontmatter 渲染态隐藏、源码态可见**；渲染器**不放行原始 HTML**（`<script>` 一类不执行、不渲染为标签）（对应 PRD 验收项 **OBS-07**）。
- [ ] wikilink 支持 `\[\[目标\]\]` / `\[\[目标|别名\]\]` / `\[\[#标题\]\]`；样式为**强调色 + 虚线下划线**；hover 显示**黑色小 tooltip**（内容为**解析后的目标路径**），且**靠近视口边缘不被裁切**（对应 PRD 验收项 **OBS-08**）。
- [ ] 解析兜底顺序为 **同目录 → vault 根相对路径 → 全库递归同名匹配**（递归列举**带 exec 看门狗超时**）；解析结果**过 `normalizeContainerPath`**；**解析纯函数有单元测试**（对应 PRD 验收项 **OBS-09**）。
- [ ] 点击**存在**的 wikilink 目标 ⇒ **沿预览历史栈推入**渲染视图（可沿返回键退回）；点击**不存在**的目标 ⇒ 正文**顶部就地**浅红错误条「**链接目标不存在：<名>**」，**可手动关闭**、**不跳转、不弹 toast**（对应 PRD 验收项 **OBS-10**）。
- [ ] 复制：**渲染态复制 markdown 源文**、**源码态复制原文**；对勾动画与成功零反馈口径与文件窗格预览**一致**（对应 PRD 验收项 **OBS-06**）。
- [ ] 前端**标识表**登记新标识；门禁（vitest / typecheck / build）全绿。

## 依赖

- 依赖 [[tasks/file-pane-obsidian/06-obsidian-tab.md|06 Obsidian tab 骨架]]（双栏与 vault 树先落地）。
- 数据来源：[[tasks/file-pane-obsidian/05-file-preview.md|05 文件窗格文本预览]]的**只读端点**（markdown 正文读取与目录列举共用）。
- 需求：[[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
