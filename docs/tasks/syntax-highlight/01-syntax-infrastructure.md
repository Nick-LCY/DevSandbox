---
prd: prds/syntax-highlight.md
status: done
---
# 任务：语法基础设施

> 需求见 [[prds/syntax-highlight.md|文件预览语法高亮 PRD]]。
> **状态：done（2026-11-28）**。本任务建立了其余接入任务共用的语言识别、Worker、主题订阅与构建分包基础设施。

## 目标

建立不依赖具体预览页面的语法识别、高亮 Worker、主题订阅和构建分包基础设施，确保主线程只消费 token 结果，不执行 tokenize。

### 交付范围

- Shiki 4.6.0 `createHighlighterCore` + JavaScript 正则引擎；不引入 Oniguruma WASM。
- 纯函数 `syntax-language.ts`：扩展名、fenced 标识与 basename 映射到 grammar id；大小写不敏感；覆盖 `Dockerfile` / `Makefile`；未知返回 `null`。
- `syntax-highlight.ts` 与 `syntax-highlight.worker.ts`：Worker 客户端、按 `theme + language + source` 缓存、请求 key 防旧响应覆盖、失败纯文本回退。
- grammar 与主题按需动态 import；Worker 首次收到已识别语言请求时再初始化对应资源；加载中先展示原文。
- 有界 LRU 缓存（32 entry / 估算 16 MiB）；超大结果不入缓存，失败不入缓存；消费者计数、30 秒超时与空闲 Worker 终止。
- `theme.ts` 已应用主题订阅，供文件窗格跟随使用；Vite 配置产出 Shiki core、engine 与 grammar 的独立异步 chunk。

## 完成标准

- [x] 使用 `createHighlighterCore` 与 `createJavaScriptRegexEngine`；运行时无 Oniguruma WASM 路径。
- [x] `syntax-language.ts` 单测覆盖大小写不敏感的扩展名 / fenced 标识、`Dockerfile` / `Makefile` basename、未知与空输入返回 `null`。
- [x] Worker 首次收到已识别语言请求才加载对应 grammar / theme；未知语言不动态加载 grammar。
- [x] 主线程通过 Worker 客户端取得 token；不存在同步 tokenize 路径；加载、初始化、通信和 tokenize 失败均返回可渲染的纯文本回退。
- [x] 高亮请求按 `theme + language + source` 缓存，并由有界 LRU 限制容量；迟到或过期响应不会覆盖当前请求，失败不进入缓存。
- [x] `theme.ts` 可订阅已应用主题，亮 / 暗主题映射到 `github-light` / `github-dark`。
- [x] Vite 构建配置产出独立 Shiki core / engine / grammar 异步 chunk；单测与最终构建产物核查均通过。
- [x] 基础设施单测通过，覆盖缓存命中、请求失效、失败回退、主题变化与 Worker 资源 generation 竞态；最终单测为 **64 个测试文件、1139 / 1139 通过**。

## 进展（2026-11-28 收口）

- Worker 资源状态增加 generation，修复失败重置与后续请求之间的竞态；hook state 携带 request key，修复输入切换时旧 token 错显。
- 两轮审查提出的 2 个 Critical（缓存无界、旧 token 错显）与复核阶段 1 个 Critical（资源失败重置竞态）均已修复；相关 Warning 也已处理并补回归测试。
- 定向 e2e、typecheck、单测、build 与最终全量真沙箱 e2e 均通过，详见 [[tasks/syntax-highlight/RESULTS.md|全轮收口留档]]。

## 交付摘要

基础设施已满足两处消费者的共享契约：识别失败不触发 grammar 加载，tokenize 仅在 Worker 执行，缓存有界且按主题 / 语言 / 源文隔离，Worker 可在无消费者时终止；代码未提交、未发布，待用户真机验收与提交决定。

## 依赖

- 无。

## 关联验收标准

- [[prds/syntax-highlight.md|PRD]]：5~9、14、18、20。
