---
prd: prds/syntax-highlight.md
status: done
---
# 任务：Obsidian fenced 代码高亮

> 需求见 [[prds/syntax-highlight.md|文件预览语法高亮 PRD]]。
> **状态：done（2026-11-28）**。Obsidian 渲染态 fenced code block 已接入共享高亮组件，源码态与 inline code 语义保持不变。

## 目标

把 Obsidian 阅读器渲染态的 fenced code block 接入共享语法高亮，并保持源码态、行内代码和既有 Markdown 阅读语义不变。

### 交付范围

- 在现有 Obsidian code 渲染组件中接入 `SyntaxHighlightedCodeBlock`。
- remark AST 插件为无语言 fenced code block 添加内部 `language-text` 标记，使其与 inline code 区分；标记不显示给用户。
- 有语言 fenced block 按语言标识懒加载 grammar；无语言、未知语言和不支持语言按纯文本回退。
- 源码态继续显示原文纯文本；inline code 保持既有轻量样式，不进入 fenced 高亮路径。
- Obsidian code block 固定深色底与 `github-dark`，输出 `data-syntax-state` / `data-syntax-theme`。
- 复用既有读取、二次确认与进度条语义，全文高亮不设大小阈值、不截断；高亮失败不影响渲染器其它内容。

## 完成标准

- [x] 渲染态有语言 fenced code block 使用 `SyntaxHighlightedCodeBlock` 并显示 token class；源码态仍是完整纯文本。
- [x] inline code 保持原有轻量样式，不触发 fenced code block 的语法高亮请求。
- [x] 无语言 fenced block 被 remark AST 插件标记为 `language-text`，该内部标记不泄漏为可见文本，并与 inline code 区分。
- [x] 未知语言、未识别语言和 Worker 失败均回退纯文本；加载中先显示原文；`textContent` 与源码逐字一致。
- [x] code block 固定使用深色底和 `github-dark`，`data-syntax-theme` / `data-syntax-state` 可供测试断言。
- [x] **>2 MB** markdown 仍走既有确认框与进度条，确认后全文读取并高亮；不截断、不降级，取消不读取。
- [x] Obsidian 组件单测覆盖 fenced 有 / 无语言、源码态、inline code、未知语言、主题标识、token class、完整文本与失败回退；最终单测总门禁 **64 个测试文件、1139 / 1139 通过**，定向真沙箱 e2e 通过。

## 进展（2026-11-28 收口）

所有 fenced block（包括无语言和未知语言）统一走共享代码块组件，并通过状态与主题标识暴露渲染契约。Obsidian 源码态不高亮，inline code 继续使用原有轻量样式；固定 `github-dark` 不随应用主题切换。

## 交付摘要

Obsidian 阅读器的渲染态高亮、纯文本回退、主题固定与大文件语义均已闭合。相关审查问题已修复并由回归测试覆盖，本轮 5 个提交已在 `origin/main`（至 `1464087`），代码未发布，用户真机验收已于 2026-11-28 通过。

## 依赖

- 依赖 [[tasks/syntax-highlight/01-syntax-infrastructure.md|01 语法基础设施]]。
- 依赖 [[tasks/syntax-highlight/02-file-pane-preview.md|02 文件窗格预览高亮]]（共享组件与渲染契约）。

## 关联验收标准

- [[prds/syntax-highlight.md|PRD]]：3、4、6、7、10、11、13、15~18。
