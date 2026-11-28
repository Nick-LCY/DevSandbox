---
prd: prds/syntax-highlight.md
status: done
---
# 任务：真浏览器与构建验收

> 需求见 [[prds/syntax-highlight.md|文件预览语法高亮 PRD]]。
> **状态：done（2026-11-28）**。两处预览、构建产物与全量真沙箱回归均已收口。

## 目标

补齐真实浏览器回归与构建门禁，证明文件窗格、Obsidian 阅读器、主题、回退、大文件口径和代码分包在集成环境中成立。

### 交付范围

- 在既有 `14` 文件窗格与 `15` Obsidian 阅读器 e2e 中完成语法高亮场景，断言 token class / `data-syntax-state` / `data-syntax-theme` / 完整文本。
- 覆盖文件窗格 `.md` 纯文本行布局、未知扩展名纯文本与亮暗主题；覆盖 Obsidian fenced 有语言 / 无语言 / 未知语言、源码态、inline code 与固定深色主题。
- 验证高亮失败或未识别时仍可读原文，且不改变下载、复制、返回栈、wikilink 和大文件确认 / 进度行为。
- 运行前端 typecheck、单测、build、定向 e2e 与全量 e2e；检查主 chunk、Shiki core / engine 与 grammar 分包关系。

## 完成标准

- [x] `14` 文件窗格与 `15` Obsidian 阅读器定向 e2e 已覆盖本轮高亮、主题、回退与完整文本契约；定向结果 **16 / 16 通过**。
- [x] 文件窗格 `.md` 仍为纯文本行布局；Obsidian fenced 渲染态 / 源码态、inline code、未知语言与固定主题语义均通过自动化回归。
- [x] 真实浏览器验证加载态 / 失败回退仍可阅读原文，既有下载、复制、返回、wikilink 与 **>2 MB** 确认 / 进度行为未被高亮接入改变。
- [x] 前端 typecheck、`typecheck:tests`、单测、build 和最终全量 e2e 全部通过；单测 **64 个文件、1139 / 1139**，最终全量真沙箱 e2e **90 / 90**。
- [x] 构建产物核查确认 dist 主 chunk 无 Shiki runtime / grammar / engine；`.wasm` 为 0 个；`shiki-core`、`shiki-engine` 与 grammar 为独立异步 chunk。
- [x] 测试断言依赖 token class、主题 / 状态标识和文本内容，不以具体颜色值作为验收条件。

## 进展（2026-11-28 收口）

- 定向真沙箱 e2e：`14` / `15` 共 **16 / 16** 通过。
- 全量真沙箱 e2e 首次为 **89 / 90**；唯一失败是既有 `12-file-transfer` 面包屑根 crumb 瞬时目录响应断言，与本轮无关；独立重跑通过，最终再次全量为 **90 / 90**，无 OOM。
- typecheck、`typecheck:tests`、单测、build 与 dist 分包核查均通过。两轮审查发现的问题已全部修复，详见 [[tasks/syntax-highlight/RESULTS.md|全轮收口留档]]。

## 交付摘要

自动化验收证明两处预览、构建分包与回归行为已闭合。全量 e2e 的瞬时断言脆化单独记录为后续 TODO，不阻断本轮；用户真机手工验收、代码提交与发布仍待后续决定。

## 依赖

- 依赖 [[tasks/syntax-highlight/02-file-pane-preview.md|02 文件窗格预览高亮]]。
- 依赖 [[tasks/syntax-highlight/03-obsidian-fenced-preview.md|03 Obsidian fenced 代码高亮]]。

## 关联验收标准

- [[prds/syntax-highlight.md|PRD]]：18~20。
