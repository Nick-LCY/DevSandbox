---
prd: prds/registry-cache-manifest.md
status: todo
---
# 任务：验收与文档收口

> 需求见 [[prds/registry-cache-manifest.md|镜像缓存清单与缓存优先拉取引导 PRD]]。
> 依赖 01~05 全部；**外部硬前置 = 现有沙箱重建（用户执行，04 推送 `base:0.4.0` 后）**——PRD 21、26、30 的核销以重建完成为准。
> 先例口径：真机 e2e / 单测 / 文档落位三档证据，逐条挂证据核销（同文件窗格轮 08、Cloudflare 轮 05）。

## 目标

### 一、e2e 用例（`apps/web/frontend/tests/specs/`，新 spec `16-cache-images.spec.ts`，编号顺延）

- **端到端（PRD 21）**：console 创建沙箱 → 容器内执行 `cached-images`，输出与端点 text 格式内容**一致**（同数据源断言）；
- 端点负例：无凭据 / 错误令牌 401、非法 format 422（固定文案原文断言）；
- console 视图冒烟：字段渲染、空态、失败态、手动刷新。

### 二、门禁全量

- 后端 pytest 全绿（≥ 基线）+ ruff rc=0；
- 核心包 pytest 全绿（root + 非 root 两档）+ ruff rc=0；
- 前端 vitest 全绿（≥ 基线）+ typecheck 双零错 + build 成功；
- e2e 全量既有用例 **0 失败**（含本轮新增 spec）。

### 三、PRD 32 条逐条核销

- 本 PRD 验收标准节 checkbox 逐条打勾并挂证据（真机 e2e / 单测 / 文档落位三档）；
- **21 / 26 / 30 核销的硬前置 = 存量沙箱重建完成**（用户执行）；26 由 04 落文档、此处复核收口。

### 四、文档同步

- `apps/web/backend/API.md`：新端点章节（json | text 两格式 + 422 + 鉴权矩阵（完整 / 受限两把钥匙的边界）+ 部署前提「**绑回环时沙箱侧失效**」+ CLI 边角「CLI 创建 / 直接 start 缺 env、console 停止 → 启动自愈」）；
- `base-image/README.md` 复核（04 已落，查漏补缺）；
- 仓库根 `README.md`：设置接口段补一行；
- `docs/glossary.md`：按需补词条（如「受限令牌」「缓存镜像清单」）；
- 看板 `docs/current-state.md` 与两份清单（`docs/prds/README.md`、`docs/tasks/README.md`）同步。

### 五、全轮留档

- `docs/tasks/registry-cache-manifest/RESULTS.md`：轮次总表、门禁数字、真缓存实测与真机记录汇总、已知边界与留白、提交链。

### 六、全局硬约束复核

- **禁 bash 解析 JSON**（02 提供 text、04 只消费 text）、**禁 jq 依赖**（镜像内不装不用）、**禁 `docker images` 劫持**、**禁代理层透明改写**、**无 GC 入口**（全库检索零命中）、**CLI 零改动**（`apps/cli` 无 diff）——逐条复核并写明证据指针。

## 完成标准

- [ ] （PRD 21）**端到端**：console 创建的沙箱内执行 `cached-images`，输出与端点 text 格式内容一致（同数据源，e2e 断言；前置 = 用户已完成存量沙箱重建至 `base:0.4.0`）。
- [ ] （PRD 29）**文档落位**：`API.md` 新端点章节（两格式 + 鉴权矩阵 + 部署前提「绑回环时沙箱侧失效」）；`base-image/README.md` 命令用法与引导约定（04 已落，复核在场）；仓库根 `README.md` 设置接口段补一行（逐文件核对在场）。
- [ ] （PRD 30）**部署前提可核验**：服务端绑回环（如仓库单元默认 `127.0.0.1:8000`）时沙箱侧失效（cached-images 走降级提示）、console 视图不受影响（实测或按 18 / 25 已有真机记录推演钉住，口径写明）；当前部署形态（绑 `0.0.0.0:28642` + LAN IP）端到端可用（e2e / 真机）。
- [ ] （PRD 31）**分层归属落位**：扫描器在核心包（`RegistryProxyManager` 邻居、同特权通道、解析与特权 IO 分离可单测）；服务端只做端点 / 令牌 / TTL 缓存 / text 渲染；**无任何 GC 入口**（全库检索零命中，GC 仅为关联提及）。
- [ ] （PRD 32）**回归不破**：后端 pytest 全绿（≥ 基线）+ ruff rc=0；核心包 pytest 全绿（root + 非 root 两档）；前端 vitest 全绿（≥ 基线）+ typecheck 双零错 + build 成功；e2e 全量既有用例 0 失败——数字记录进 RESULTS.md。
- [ ] PRD **32 / 32** 逐条核销挂证据（验收标准节 checkbox 全勾，每条标注证据档位：真机 e2e / 单测 / 文档落位）。
- [ ] 硬约束六条复核完成并留证据指针（禁 bash 解析 JSON / 禁 jq / 禁 `docker images` 劫持 / 禁透明改写 / 无 GC 入口 / CLI 零改动）。
- [ ] 看板 / 两份清单 / 词汇表同步完成；`RESULTS.md` 落库；本任务 status → done。

## 依赖

- 依赖全部：[[tasks/registry-cache-manifest/01-core-cache-scanner.md|01]]、[[tasks/registry-cache-manifest/02-server-endpoint-and-token.md|02]]、[[tasks/registry-cache-manifest/03-injection-pipeline.md|03]]、[[tasks/registry-cache-manifest/04-base-image-cached-images.md|04]]、[[tasks/registry-cache-manifest/05-console-cache-images-view.md|05]]。
- **外部前置**：现有沙箱重建（用户执行，04 推送 `base:0.4.0` 后）——21 / 26 / 30 核销的硬前置。
- 需求：[[prds/registry-cache-manifest.md|镜像缓存清单与缓存优先拉取引导 PRD]]。
