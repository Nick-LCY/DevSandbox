# 文件预览语法高亮全轮收口留档

> 本文件是「文件预览语法高亮」轮（01~04）的全轮收口记录，保留最终口径、交付摘要、审查修复、自动化门禁、已知瞬时失败与交付状态。
> 需求见 [[prds/syntax-highlight.md|文件预览语法高亮 PRD]]，任务集见 [[tasks/syntax-highlight/README.md|任务集]]，看板见 [[current-state.md|当前状态]]。

## 一、收口结论

**任务 01~04 全部完成。** 文件窗格文本预览与 Obsidian 渲染态 fenced code block 均接入 Shiki 高亮；高亮在 Web Worker 中执行，grammar / 主题按需动态加载，未知语言与失败安全回退为纯文本。自动化门禁最终通过，5 个提交已在 `origin/main`（至 `1464087`），代码未发布；用户真机手工验收尚未执行。

## 二、最终口径

- **产品范围**：只改文件窗格预览与 Obsidian 阅读器渲染态 fenced code block；Obsidian 源码态与 inline code 不接入高亮。
- **引擎**：Shiki 4.6.0，`createHighlighterCore` + JavaScript 正则引擎；不使用 WASM。
- **执行边界**：全部 tokenize 在 Web Worker；grammar / 主题动态 import 懒加载，主线程只消费结果。
- **缓存与生命周期**：有界 LRU 缓存（32 entry / 估算 16 MiB）；超大结果不入缓存，失败不入缓存；消费者计数、30 秒超时与空闲 Worker 终止共同控制资源生命周期。
- **并发正确性**：hook state 携带 request key，避免旧 token 错显；Worker 资源状态携带 generation，避免失败重置竞态。
- **行语义**：UI 与 Worker 共用 `preview-lines.ts` 行切分，保持 CRLF、空行、末尾换行与原文 `textContent` 一致。
- **主题**：文件窗格随应用主题使用 `github-light` / `github-dark`；Obsidian fenced code block 固定使用 `github-dark`。
- **组件契约**：所有 fenced block（包括未知语言与无语言）统一走 `SyntaxHighlightedCodeBlock`，暴露 `data-syntax-state` / `data-syntax-theme`；文件窗格 `.md` 按 Markdown grammar 高亮，但仍保持纯文本逐行布局。
- **大文件**：不设全文高亮阈值、不截断、不只处理前 N KB；既有大于 2 MB 的二次确认与进度条保持不变。

## 三、任务交付

| 任务 | 状态 | 交付摘要 |
|---|---|---|
| [[tasks/syntax-highlight/01-syntax-infrastructure.md\|01 语法基础设施]] | **done** | Shiki Worker 客户端与 Worker、语言映射、主题订阅、动态分包、缓存与生命周期控制；补齐请求失效、失败回退、generation 竞态等回归测试。 |
| [[tasks/syntax-highlight/02-file-pane-preview.md\|02 文件窗格预览高亮]] | **done** | 文件窗格接入逐行高亮；`.md` 使用 Markdown grammar 但不生成 Markdown DOM；保留行号、测试标识、复制与全文预览语义。 |
| [[tasks/syntax-highlight/03-obsidian-fenced-preview.md\|03 Obsidian fenced 代码高亮]] | **done** | 渲染态 fenced block 统一接入共享组件；无语言 / 未知语言 / 失败回退纯文本；源码态与 inline code 语义保持不变。 |
| [[tasks/syntax-highlight/04-browser-build-acceptance.md\|04 真浏览器与构建验收]] | **done** | 完成 14/15 定向真沙箱 e2e、前端门禁、构建产物分包核查与全量 e2e 收口。 |

## 四、两轮审查与修复

第一轮审查发现 **2 个 Critical**：缓存无界、输入切换时旧 token 错显；另有 **5 个 Warning**。第二轮复核发现 **1 个 Critical**：Worker 资源失败重置竞态；另有 **3 个 Warning**。以上问题均已修复，并补回归测试；其中包含 `syntax-highlight.worker.generation.test.ts`，用于钉住 generation 防竞态语义。

## 五、最终门禁

| 门禁 | 最终结果 |
|---|---|
| 前端 typecheck | 通过 |
| 前端 `typecheck:tests` | 通过 |
| 单测 | **64 个测试文件，1139 / 1139 通过** |
| build | 通过；dist 主 chunk 不含 Shiki runtime / grammar / engine；`.wasm` 文件数为 0；`shiki-core`、`shiki-engine`、grammar 为独立异步 chunk |
| 定向真沙箱 e2e | `14` 文件窗格 / `15` Obsidian：**16 / 16 通过** |
| 全量真沙箱 e2e（首次） | **89 / 90**；唯一失败为既有 `12-file-transfer` 面包屑根 crumb 瞬时目录响应断言，与本轮无关 |
| 全量真沙箱 e2e（独立重跑） | **通过** |
| 全量真沙箱 e2e（再次全量最终结果） | **90 / 90 干净通过**，无 OOM |

首次全量的唯一失败在独立重跑中通过；再次全量亦为 90 / 90。因此该断言脆化不阻断本轮收口，但作为后续加固 TODO 留在 [[current-state.md|当前状态]]。

## 六、验收状态

- [[prds/syntax-highlight.md|PRD]] 的 20 条验收标准均已依据单测、定向 e2e、构建与产物核查自动化核销：**20 / 20 通过**。
- 本轮尚未进行用户手工真机验收；尤其主观视觉体验仍待用户确认。该状态不改写自动化门禁结果，也不等同于已发布。
- 代码的 5 个提交已按规范推送至 `origin/main`（远端从 `0a257b7` 更新至 `1464087`）：`b2d9add`、`c00e8b3`、`ba98c4f`、`ec7ce04`、`1464087`。

## 七、未决与后续

- **12-file-transfer 面包屑根 crumb 瞬时断言脆化**：本轮两次全量各出现一次，独立重跑均通过；建议后续改为等待目录响应稳定或使用更稳健的断言，不阻断本轮。
- **用户真机手工验收**：待用户确认文件窗格与 Obsidian 两处预览的实际视觉与交互体验。

## 八、沉淀

本轮没有重大架构分歧，不新增 ADR。稳定前端约定已补入 [[conventions/console-frontend.md|控制台前端约定]]：token 断言不依赖具体颜色值，预览行语义统一走 `preview-lines.ts`。

## 九、提交记录

本轮改动已按规范拆为以下 5 个提交，并已推送至 `origin/main`（远端从 `0a257b7` 更新至 `1464087`）：

- `b2d9add` feat(web): 文件预览语法高亮基础设施
- `c00e8b3` feat(web): 文件窗格预览接入语法高亮
- `ba98c4f` feat(web): Obsidian fenced 代码块接入语法高亮
- `ec7ce04` test(web): 语法高亮 e2e 验收与构建分包配置
- `1464087` docs(syntax-highlight): 立项与全轮收口留档
