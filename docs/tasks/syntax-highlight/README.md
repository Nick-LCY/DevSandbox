# 文件预览语法高亮任务集

本目录是[[prds/syntax-highlight.md|文件预览语法高亮 PRD]]的开发任务集，共 **4 个任务**。立项日期：**2026-11-28**。

## 状态

**01~04 全部 done（2026-11-28 收口）。** 自动化验收通过：单测 **64 个测试文件、1139 / 1139**，定向真沙箱 e2e **16 / 16**，最终全量真沙箱 e2e **90 / 90**，typecheck / `typecheck:tests` / build 通过；代码仍未提交、未发布，用户真机手工验收待执行。全轮数字与边界见 [[tasks/syntax-highlight/RESULTS.md|RESULTS.md]]。

## 关键口径

| 口径 | 内容 |
|---|---|
| 产品范围 | 文件窗格文本预览 + Obsidian 阅读器渲染态 fenced code block；Obsidian 源码态纯文本；inline code 保持既有轻量样式 |
| 引擎 | Shiki 4.6.0 `createHighlighterCore` + JavaScript regex engine；不使用 Oniguruma WASM |
| 执行边界 | 全部 tokenize 在 Web Worker；grammar / theme 按需动态加载；主线程不 tokenize |
| 缓存与生命周期 | 有界 LRU（32 entry / 估算 16 MiB）；超大结果与失败不入缓存；消费者计数 + 30 秒超时 + 空闲 Worker 终止 |
| 大文件 | 全文高亮，不设降级阈值、不截断；既有 **>2 MB** 二次确认 + 进度条不变 |
| 回退 | 未识别扩展名 / 无语言标记 / 不支持语言 / 高亮失败均纯文本 |
| 主题 | 文件窗格随应用主题：`github-light` / `github-dark`；Obsidian fenced 固定 `github-dark` |
| `.md` 语义 | 文件窗格按 Markdown grammar 高亮，但仍纯文本行布局，不生成 Markdown DOM |
| 测试契约 | 使用 token class、主题 / 状态标识和完整文本断言，不以具体颜色值作为依据；UI 与 Worker 行切分统一走 `preview-lines.ts` |

## 任务清单

| 编号 | 任务 | 状态 | 交付内容 | 依赖 |
|---|---|---|---|---|
| [[tasks/syntax-highlight/01-syntax-infrastructure.md\|01]] | 语法基础设施 | **done** | Shiki Worker、语言映射、主题订阅、动态分包、有界缓存与生命周期控制、回归测试 | 无 |
| [[tasks/syntax-highlight/02-file-pane-preview.md\|02]] | 文件窗格预览高亮 | **done** | `FileBrowserPanel` 接入 `SyntaxHighlightedLines`，保留行号 / 标识 / 纯文本布局，补主题、行语义与回退测试 | 01 |
| [[tasks/syntax-highlight/03-obsidian-fenced-preview.md\|03]] | Obsidian fenced 代码高亮 | **done** | `SyntaxHighlightedCodeBlock`、`language-text` remark 标记、渲染 / 源码 / inline code 语义与测试 | 01、02 |
| [[tasks/syntax-highlight/04-browser-build-acceptance.md\|04]] | 真浏览器与构建验收 | **done** | 14/15 定向 e2e、typecheck / 单测 / build / 全量 e2e、主 chunk 与 grammar 分包核查 | 02、03 |

## 依赖顺序

```text
01 ──▶ 02 ──▶ 03 ──▶ 04
```

- 01 无依赖，建立语言识别、Worker、主题和分包基础设施。
- 02 依赖 01，接入文件窗格与共享逐行渲染。
- 03 依赖 01、02，复用共享组件接入 Obsidian fenced block。
- 04 依赖 02、03，统一做真浏览器、门禁和构建产物验收。

## 任务文件

- [[tasks/syntax-highlight/01-syntax-infrastructure.md|01 语法基础设施]]
- [[tasks/syntax-highlight/02-file-pane-preview.md|02 文件窗格预览高亮]]
- [[tasks/syntax-highlight/03-obsidian-fenced-preview.md|03 Obsidian fenced 代码高亮]]
- [[tasks/syntax-highlight/04-browser-build-acceptance.md|04 真浏览器与构建验收]]
- [[tasks/syntax-highlight/RESULTS.md|全轮收口留档]]
- [[prds/syntax-highlight.md|文件预览语法高亮 PRD]]
- [[current-state.md|当前状态]]
