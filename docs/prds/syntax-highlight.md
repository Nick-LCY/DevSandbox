# 文件预览语法高亮

> 日期：2026-11-28
> 立项口径：用户于 2026-11-28 拍板；本轮只改造文件预览与 Obsidian 阅读器的代码呈现，不改变终端、下载或编辑语义。
> 相关历史轮次：[[prds/file-pane-obsidian.md|文件窗格与 Obsidian 阅读器 PRD]]。
> 收口状态（2026-11-28）：任务 01~04 全部 done；以下 20 条按单测、定向 e2e、构建与产物核查完成自动化核销。代码未提交、未发布，用户真机手工验收尚未执行。

## 背景

文件窗格已经能够读取并以等宽文本、行号槽展示沙箱文件，Obsidian 阅读器也已经能够在渲染态显示 fenced code block，但两处代码目前缺少语法高亮。用户在阅读配置、源码、脚本与 markdown 笔记时，需要依靠纯文本结构识别语言，长代码段的可读性不足。

本轮在既有预览通道和阅读器布局上增加统一的语法高亮能力：文件窗格继续是纯文本逐行预览，Obsidian 阅读器继续是 markdown 渲染态；两处共享语言识别、Worker 高亮与 token 渲染基础设施，但保留各自的布局和主题口径。

## 目标

- 文件窗格文本预览对已识别语言应用语法高亮，保留现有逐行布局、行号和 `data-testid`。
- Obsidian 阅读器渲染态的 fenced code block 应用语法高亮；源码态仍显示纯文本，行内代码保持现有轻量样式。
- 使用 Shiki，并让语法 grammar、主题和高亮工作按需、异步、在 Web Worker 中执行，不让首屏主线程 tokenize 或承载完整 grammar 大包。
- 未识别扩展名、未识别 basename、无语言标记或不支持的语言均安全回退为纯文本。
- 文件窗格随应用亮 / 暗主题切换（`github-light` / `github-dark`）；Obsidian fenced code block 固定深色底并使用 `github-dark`。
- 让 token 化后的可见文本与原文逐字一致，保持 CRLF、空行和末尾换行的既有行语义。

## 非目标

- 不把文件窗格的 `.md` 渲染为 Markdown DOM；它仍是纯文本行布局，但可以按 Markdown grammar 做语法高亮。
- 不在 Obsidian 源码态高亮 fenced code block，不改变源码态的纯文本语义。
- 不改变行内代码现有轻量样式，不把行内代码当成 fenced code block 处理。
- 不做编辑、诊断、代码折叠、行内错误提示、颜色值精确匹配或语言自动推断以外的智能分析。
- 不为大文件设置语法高亮降级阈值、不截断源码、不只高亮前 N KB。用户明确接受全文高亮的性能代价；既有文件读取中对 **>2 MB** 的二次确认与进度条口径保持不变。

### 用户拍板：否决大文件降级建议

2026-11-28，用户明确否决计划员提出的“大文件达到阈值后降级 / 只高亮部分内容”的方案。最终拍板是**大文件全文高亮，不设降级阈值、不截断**；即使接受性能代价，也必须保持完整源码可读。既有 **>2 MB** 二次确认与进度条只承担读取前的风险提示和进度反馈，不是高亮降级闸门。

- 不使用 Oniguruma WASM；不引入需要 Cloudflare Workers 静态托管 WASM 的运行时路径。

## 方案

### 一、引擎与执行边界

使用 Shiki `createHighlighterCore` + `createJavaScriptRegexEngine`。不使用 Oniguruma WASM，以规避 Cloudflare Workers 静态托管 WASM 的兼容风险。所有 tokenize / token 生成均在 Web Worker 执行，主线程只负责请求调度、状态展示和 token 结果渲染。

Worker 不在加载时初始化全部语言。grammar 与主题均通过动态 import 按需加载；Worker 第一次收到一个已识别语言请求时才初始化所需 highlighter 资源。`vite.config.ts` 为 Shiki core 配置单独的异步 chunk，grammar 不合并成首屏大包，验收时检查主 chunk 不包含 grammar。

`syntax-highlight.ts` 提供 Worker 客户端：

- 请求缓存 key 固定为 `theme + language + source`，相同输入复用结果；
- Worker 重启、语言首次初始化与多次切换造成的迟到响应不能覆盖当前视图，过期响应必须丢弃；
- Worker 初始化、动态 import、tokenize 或通信失败时回退纯文本，不阻断文件读取或 Obsidian 页面；
- 加载中先显示原文，token 结果返回后再切换渲染态。

### 二、语言识别

新增纯函数模块 `syntax-language.ts`，把文件扩展名、fenced code block language 标识映射到 Shiki grammar id。识别规则大小写不敏感，并支持 `Dockerfile`、`Makefile` 等 basename；未知、空值和不支持的标识返回 `null`。

文件窗格按文件 basename / 扩展名识别语言；`.md` 映射 Markdown grammar，但仍只输出纯文本行，不渲染 Markdown DOM。Obsidian fenced code block 按围栏语言标识识别；无语言 fenced block 由 remark AST 插件加内部 `language-text` 标记，使它与行内代码区分，再按纯文本处理。

未识别扩展名、无语言标记和 `language-text` 均输出纯文本。语言识别失败不应产生伪造的 grammar id，也不应触发对应 grammar 的动态加载。

### 三、共享渲染组件

新增共享组件 `SyntaxHighlightedCode.tsx`：

- `SyntaxHighlightedLines` 用于文件窗格逐行输出，保留既有行号槽、原有行级 `data-testid` 与滚动布局；
- `SyntaxHighlightedCodeBlock` 用于 Obsidian 渲染态 fenced code block，输出 `data-syntax-state` 与 `data-syntax-theme`，便于测试区分纯文本、加载中、已高亮和失败回退；
- token 渲染不得改变 `textContent`，必须与输入源码一致；加载中和失败回退都能直接阅读原文；
- token class、主题标识和文本内容是测试契约，不以具体颜色值作为验收依据。

### 四、主题

`theme.ts` 增加已应用主题订阅。文件窗格订阅应用当前亮 / 暗主题并分别使用 `github-light` / `github-dark`；主题变更会使请求缓存按主题隔离并触发当前预览更新。Obsidian fenced code block 不跟随应用主题，固定使用深色底与 `github-dark`，并通过 `data-syntax-theme` 暴露该事实。

### 五、与既有预览语义的衔接

- 文件窗格继续使用逐行布局，`splitPreviewLines` 的 CRLF、空行、末尾换行语义必须与 token 行数组对齐；
- `.md` 的口径从既有轮次的“文件窗格内一律纯文本”细化为“文件窗格内不渲染 Markdown DOM，但允许按 Markdown grammar 语法高亮”。这是本轮对历史口径的演进说明，不改写 [[prds/file-pane-obsidian.md|既有 PRD]] 与既有任务的历史留档正文；
- Obsidian 源码态保持原文，渲染态只对 fenced code block 接入高亮；行内代码保持原有轻量样式；
- 既有 **>2 MB** 文件预览二次确认、进度条和全文读取行为保持不变。确认后全文进入高亮流水线，不新增大小阈值、不截断、不降级为前 N KB；
- 读取失败、语言未知或高亮失败均回退纯文本 / 原有错误态，不影响下载、返回栈、复制、源码切换和 wikilink 行为。

## 验收标准

> 共 **20 条**，按编号供任务核销引用。颜色值不作为验收依据；测试以 token class、主题标识和文本内容为主。

1. [x] **自动化通过**：文件窗格已识别语言的文本预览会显示 token class；其逐行布局、行号槽、滚动行为与既有 `data-testid` 保持不变。（依据：单测 + 定向真沙箱 e2e `14` / `15`，共 16 / 16 通过）
2. [x] **自动化通过**：文件窗格的 `.md` 文件使用 Markdown grammar 进行语法高亮，但仍是纯文本逐行布局，不生成 Markdown 标题、列表、链接或其它 Markdown DOM。（依据：文件窗格组件单测 + 定向 e2e）
3. [x] **自动化通过**：Obsidian 阅读器渲染态的 fenced code block 使用共享高亮组件；Obsidian 源码态保持原文纯文本。（依据：Obsidian 组件单测 + 定向 e2e）
4. [x] **自动化通过**：Obsidian 行内代码继续使用现有轻量样式，不被当作 fenced code block，不进入 fenced 高亮路径。（依据：组件单测 + `15` 定向 e2e）
5. [x] **自动化通过**：使用 Shiki `createHighlighterCore` 与 `createJavaScriptRegexEngine`；运行时不依赖 Oniguruma WASM。（依据：单测 / 源码核对 + build 产物 `.wasm` 为 0 个）
6. [x] **自动化通过**：grammar 与主题按需动态加载；Worker 首次收到已识别语言请求时才初始化对应资源，未知语言不会触发 grammar 加载。（依据：Worker 单测 + build 分包核查）
7. [x] **自动化通过**：所有 tokenize 与 token 生成均在 Web Worker 中执行，主线程不存在同步 tokenize 路径；加载中先展示原文。（依据：Worker / 组件单测 + 定向 e2e）
8. [x] **自动化通过**：`syntax-language.ts` 对扩展名、fenced 标识和 basename 的识别大小写不敏感，覆盖 `Dockerfile` / `Makefile` 等 basename，未知输入返回 `null`。（依据：语言映射单测）
9. [x] **自动化通过**：`syntax-highlight.ts` 按 `theme + language + source` 使用有界缓存；过期 Worker 响应会被丢弃，失败会回退纯文本且不阻断预览。（依据：缓存 / 失效 / 回退单测；两轮审查问题已修复）
10. [x] **自动化通过**：共享组件提供 `SyntaxHighlightedLines` 与 `SyntaxHighlightedCodeBlock`；后者输出 `data-syntax-state` / `data-syntax-theme`，前者保留文件窗格既有行号与测试标识。（依据：组件单测 + 定向 e2e）
11. [x] **自动化通过**：高亮加载中、成功和失败回退三种状态的可见文本 `textContent` 均与输入源码一致，不丢失字符、不重复字符、不改变换行。（依据：组件单测 + 定向 e2e 完整文本断言）
12. [x] **自动化通过**：CRLF、空行和末尾换行的行数组与 `splitPreviewLines` 语义一致；空行保留，末尾换行不凭空增加一行。（依据：`preview-lines.ts` 相关单测与共享渲染回归）
13. [x] **自动化通过**：未识别扩展名、无语言标记、`language-text` 和不支持语言均按纯文本渲染，不抛出未处理异常。（依据：语言 / 组件单测 + `14` / `15` 定向 e2e）
14. [x] **自动化通过**：文件窗格随应用主题使用 `github-light` / `github-dark`，主题变化通过 `theme.ts` 已应用主题订阅触发更新。（依据：主题单测 + 文件窗格定向 e2e）
15. [x] **自动化通过**：Obsidian fenced code block 固定使用深色底与 `github-dark`，不因应用亮 / 暗主题变化而改用 `github-light`。（依据：组件单测 + Obsidian 定向 e2e）
16. [x] **自动化通过**：无语言 fenced block 经 remark AST 插件获得内部 `language-text` 标记，并与 inline code 区分；该标记不泄漏为用户可见文本。（依据：remark / 组件单测 + Obsidian 定向 e2e）
17. [x] **自动化通过**：大于 2 MB 的预览仍先二次确认、确认后显示既有进度条并全文读取；高亮不设置降级阈值、不截断、不只处理前 N KB，取消确认不发起读取。（依据：预览 / 共享组件单测 + 定向 e2e 回归）
18. [x] **自动化通过**：单元测试覆盖语言映射、Worker 客户端缓存 / 过期响应 / 失败回退、主题订阅、行语义与共享组件；断言 token class、主题标识和完整文本内容，不断言具体颜色值。（依据：**64 个测试文件、1139 / 1139 通过**）
19. [x] **自动化通过**：真浏览器 e2e 已增补 `14` 文件窗格与 `15` Obsidian 阅读器场景，定向结果 **16 / 16 通过**。（依据：真沙箱 Playwright e2e）
20. [x] **自动化通过**：前端 typecheck、单测、build 与全量 e2e 通过；构建产物核查确认主 chunk 不含 grammar，Shiki core 为独立异步 chunk，grammar 未被合并成首屏大包。（依据：typecheck / `typecheck:tests`、单测 **1139 / 1139**、build 核查、最终全量 e2e **90 / 90**）

## 相关文档

- [[tasks/syntax-highlight/README.md|文件预览语法高亮任务集]] — 四个任务及依赖顺序。
- [[current-state.md|当前状态]] — 本轮活跃需求与任务看板。
- [[conventions/console-frontend.md|控制台前端约定]] — 前端测试标识、主题与预览交互的稳定约定。
