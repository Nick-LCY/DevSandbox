---
prd: prds/syntax-highlight.md
status: done
---
# 任务：文件窗格预览高亮

> 需求见 [[prds/syntax-highlight.md|文件预览语法高亮 PRD]]。
> **状态：done（2026-11-28）**。文件窗格已接入共享逐行高亮组件，并保持既有预览语义。

## 目标

把文件窗格的文本预览接入共享语法高亮组件，同时保持既有下载、行号、逐行纯文本布局和测试标识不变。

### 交付范围

- `FileBrowserPanel` 接入 `SyntaxHighlightedLines`，保留原有 `data-testid`、行号槽、行滚动和复制行为。
- 按文件 basename / 扩展名识别 grammar；`.md` 使用 Markdown grammar，但仍按纯文本逐行输出，不生成 Markdown DOM。
- 加载中先显示完整原文；token 化后显示 token class；失败、未知语言和不支持语言回退纯文本。
- 与 `preview-lines.ts` 行切分契约对齐，保持 CRLF、空行、末尾换行语义；token 结果的 `textContent` 与原文一致。
- 文件窗格使用已应用主题订阅：亮主题 `github-light`，暗主题 `github-dark`。
- 保持既有 **>2 MB** 二次确认、进度条和全文读取口径；确认后的全文不截断、不设置高亮降级阈值。

## 完成标准

- [x] `FileBrowserPanel` 使用 `SyntaxHighlightedLines`，既有行号槽、行级 `data-testid`、下载单击语义和复制行为不回归。
- [x] 文件 basename / 扩展名驱动正确 grammar；`.md` 高亮但不生成 heading、list、link 等 Markdown DOM。
- [x] 加载中的文件正文可见；高亮成功显示 token class；Worker 失败、未知语言和不支持语言显示完整纯文本。
- [x] CRLF、空行、末尾换行与 `preview-lines.ts` 对齐，token 渲染 `textContent` 与原文一致。
- [x] 文件窗格亮 / 暗主题分别使用 `github-light` / `github-dark`，主题变化可更新当前预览。
- [x] **>2 MB** 文件仍走既有二次确认与进度条，确认后高亮全文，不截断、不按大小降级；取消确认不发起读取。
- [x] 文件窗格组件与纯函数单测覆盖识别语言、行语义、token class、主题标识、完整文本和回退路径；最终单测总门禁 **64 个测试文件、1139 / 1139 通过**，定向真沙箱 e2e 通过。

## 进展（2026-11-28 收口）

文件窗格已使用共享的 `preview-lines.ts` 行语义和 `SyntaxHighlightedLines` 渲染；`.md` 只改变 token 呈现，不改变文件窗格的纯文本行布局。大文件仍由既有确认框与进度条控制读取，确认后完整进入高亮流水线。

## 交付摘要

文件窗格的识别、主题、加载态、成功态与失败回退均已接入，且保持下载、复制、行号、滚动和 `data-testid` 契约。相关审查问题已随共享基础设施修复轮闭合，本轮 5 个提交已在 `origin/main`（至 `1464087`），代码未发布，待用户真机验收。

## 依赖

- 依赖 [[tasks/syntax-highlight/01-syntax-infrastructure.md|01 语法基础设施]]。

## 关联验收标准

- [[prds/syntax-highlight.md|PRD]]：1、2、8、9、10~15、17、18。
