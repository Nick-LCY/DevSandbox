---
prd: prds/registry-cache-manifest.md
status: todo
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

- [ ] （PRD 27）设置抽屉代理状态区旁新增「缓存镜像清单」视图：仓库 / 标签 / 摘要 / 大小（人读格式）/ 时间齐备；用完整令牌访问同一端点 json 格式（既有鉴权头，单测断言请求带凭据）。
- [ ] （PRD 28）空清单给空态文案；端点失败给错误展示（不白屏）；打开时加载 + 手动刷新；**不加常驻轮询定时器**（单测断言零 `setInterval` / 轮询 `setTimeout`）。
- [ ] 门禁：前端 vitest 全绿（≥ 基线）+ typecheck 双零错 + build 成功；后端 / 核心包 / CLI 零改动。

## 依赖

- 依赖 [[tasks/registry-cache-manifest/02-server-endpoint-and-token.md|02 服务端端点与受限令牌]]（联调需端点在场；组件与单测可用 mock 先行，不被阻塞）。
- 需求：[[prds/registry-cache-manifest.md|镜像缓存清单与缓存优先拉取引导 PRD]]。
