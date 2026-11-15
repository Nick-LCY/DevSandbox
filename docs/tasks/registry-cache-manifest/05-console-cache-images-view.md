---
prd: prds/registry-cache-manifest.md
status: done
---
# 任务：console 缓存镜像清单视图

> 需求见 [[prds/registry-cache-manifest.md|镜像缓存清单与缓存优先拉取引导 PRD]]。
> 前端用**完整令牌**访问同一端点（既有鉴权头自动附带，**无新增令牌逻辑**）；联调需 02 端点在场，组件与单测可用 mock 先行。

## 目标

### 一、视图（`frontend/src/components/workbench/SettingsDialog.tsx`）

- 设置抽屉**代理状态区旁**新增「**缓存镜像清单**」视图；
- 展示字段：仓库 / 标签 / 摘要 / **大小（人读格式，KB/MB/GB）** / 时间；
- 数据源：`GET /api/proxy/cache/images?format=json`（api 客户端新增调用，`frontend/src/api/`）。

### 二、三态与刷新

- **空清单**给空态文案；
- **端点失败**给错误展示（**不白屏**，对齐抽屉既有失败口径——toast / 错误条按现有惯例）；
- **打开时加载 + 手动刷新按钮**；**不加常驻轮询定时器**（零 `setInterval`、零轮询 `setTimeout`）。

### 三、单测（`SettingsDialog.test.tsx` 扩展或新测试文件）

- 字段渲染（含人读大小）、空态、失败态不白屏、手动刷新触发重取、无轮询定时器断言。

## 完成标准

- [x] （PRD 27）设置抽屉代理状态区旁新增「缓存镜像清单」视图：仓库 / 标签 / 摘要 / 大小（人读格式）/ 时间齐备；用完整令牌访问同一端点 json 格式（既有鉴权头，单测断言请求带凭据）。**——已核销（2026-11-15，真机点验随 06）：`CacheImagesSection` 落位设置抽屉代理设置区与启动模板区之间，五字段齐备——仓库 / 标签（digest 直拉显示（无））/ 摘要（19 字符截断 + title 全文）/ 大小（复用既有 `formatBytes` 人读格式 KiB/MiB/GiB，与同抽屉「缓存目录占用」单位统一）/ 时间（`formatTimestamp`）+ 生成时间戳脚注；api 客户端新增 `api.cacheImages()`（`GET /api/proxy/cache/images?format=json`）走既有 `request()` 通道——完整令牌自动附带、零新增令牌逻辑，「带凭据」单测断言落 api 层（reviewer 裁决接受）；真机点验（完整令牌打真实端点）归 06 端到端。**
- [x] （PRD 28）空清单给空态文案；端点失败给错误展示（不白屏）；打开时加载 + 手动刷新；**不加常驻轮询定时器**（单测断言零 `setInterval` / 轮询 `setTimeout`）。**——已核销（2026-11-15）：三态齐备——加载态、空态文案（被 `!loading && !loadError` 门控不误显）、失败态 toast（settings-cache-images）+ 就地 `role=status` 说明双通道（不白屏）、刷新失败保留旧清单；打开抽屉加载 + 手动刷新按钮；零 `setInterval`、零 `setTimeout`——零轮询双保险：整文件静态断言（`SettingsDialog.tsx` 全文件 grep 断言零 setInterval/setTimeout 字面量）+ 假时钟行为断言（推进 10 分钟仍只调一次）。**
- [x] 门禁：前端 vitest 全绿（≥ 基线）+ typecheck 双零错 + build 成功；后端 / 核心包 / CLI 零改动。**——已核销（2026-11-15）：vitest 全量 953 passed / 0 failed（基线 943 → +10）；typecheck 主 tsconfig 0 错、typecheck:tests 0 错；build 成功（chunk 体积 warning 为既有）；后端 / 核心包 / CLI / docs 零改动，详见进展节。**

## 依赖

- 依赖 [[tasks/registry-cache-manifest/02-server-endpoint-and-token.md|02 服务端端点与受限令牌]]（联调需端点在场；组件与单测可用 mock 先行，不被阻塞）。
- 需求：[[prds/registry-cache-manifest.md|镜像缓存清单与缓存优先拉取引导 PRD]]。

## 进展（2026-11-15 收口）

> **任务完成（status: done）。** 完成标准逐条核销（PRD 27 / 28 的真机点验——完整令牌打真实端点——随 06 端到端落档，见联调说明）。交付分两个提交：**`4ad452b` 主实现** + **`a33c33f` 审查收尾**；reviewer 结论「通过（无 Critical）」，五项取舍全部裁决接受，一条 Warning（刷新失败保留旧清单缺回归钉）已随收尾提交落实。

### 交付落位（提交 `4ad452b` 主实现 + `a33c33f` 审查收尾）

- **api 客户端 `api.cacheImages()`**：`GET /api/proxy/cache/images?format=json`，走既有 `request()` 通道——完整令牌自动附带、**零新增令牌逻辑**；类型 `CachedImage` / `CacheImagesResponse` 与核心包 `to_payload()` 逐字段对齐（蛇形命名零转换、tags 恒数组、空为 `[]`）。
- **`CacheImagesSection`**（`SettingsDialog.tsx`，代理设置区与启动模板区之间）：字段齐备——仓库 / 标签（digest 直拉显示（无））/ 摘要（19 字符截断 + title 全文）/ 大小（复用既有 `formatBytes` 人读格式 KiB/MiB/GiB，与同抽屉「缓存目录占用」单位统一）/ 时间（`formatTimestamp`）+ 生成时间戳脚注；多条目 `max-h-80` 滚动、排版对齐 TemplateManager 基调。
- **加载与刷新**：打开抽屉加载 + 手动刷新按钮；**零 `setInterval`、零 `setTimeout`**。
- **三态**：加载态；空态文案（被 `!loading && !loadError` 门控，不误显）；失败态 **toast（settings-cache-images）+ 就地 `role=status` 说明双通道**（不白屏）、**刷新失败保留旧清单**。
- **零轮询双保险**：① 全文件静态断言——对 `SettingsDialog.tsx` 整文件 grep 断言零 `setInterval` / `setTimeout` 字面量（reviewer 源码下钻确认不假绿不误伤）；② 假时钟行为断言——推进 10 分钟仍只调一次。
- **`a33c33f`（审查收尾）**：补「刷新失败保留旧清单」回归测试——成功加载后换 reject 刷新，断言旧条目在场 + `role=status` 说明在场 + 空态不误显 + 失败 toast 照常。

### 审查结论与取舍登记

- reviewer 结论：**通过（无 Critical）**。
- **五项取舍全部裁决接受**：① TemplateManager 基调布局；② 零轮询 + 时间戳脚注表达新鲜度；③ formatBytes 二进制单位优先于任务文案字面 KB/MB/GB（PRD 权威口径只写「人读格式」）；④ 失败态 toast + 就地说明双通道；⑤「带凭据」断言放 api 层。
- 一条 Warning（刷新失败保留旧清单缺回归钉）已随 `a33c33f` 落实。

### 门禁

- vitest 全量 **953 passed / 0 failed**（基线 943 → +10）；typecheck 主 tsconfig **0 错**、typecheck:tests **0 错**；build 成功（chunk 体积 warning 为既有）；后端 / 核心包 / CLI / docs **零改动**。

### 联调说明（明确随 06）

- 组件与单测 mock 先行（任务前置允许）；真机点验（完整令牌打真实端点）归 **06 端到端**（PRD 27 / 28 的真机证据随 06 全量 e2e 落档）。

### 可选建议登记（reviewer 提出，裁决不处理）

- 静态断言路径改 `import.meta.url` 免疫；`generated_at` 脚注移出非空条件块；在途请求无 AbortController（沿既有区行为）。
