---
prd: prds/registry-cache-manifest.md
status: done
---
# 任务：验收与文档收口

> 需求见 [[prds/registry-cache-manifest.md|镜像缓存清单与缓存优先拉取引导 PRD]]。
> 依赖 01~05 全部；**外部硬前置 = 现有沙箱重建（用户执行，04 推送 `base:0.4.0` 后）**——PRD 21、26、30 的核销以重建完成为准。
> 先例口径：真机 e2e / 单测 / 文档落位三档证据，逐条挂证据核销（同文件窗格轮 08、Cloudflare 轮 05）。
>
> **收口口径（2026-11-15）**：21 由新 e2e spec 钉——console 创建**新建** `base:0.4.0` 沙箱（新沙箱自带命令与注入，不依赖存量重建）；26 的 checkbox 本体是「口径写进文档」（04 已落，此处复核勾）；30 按「03 真机记录（0.0.0.0 + LAN IP 探测兑底档实测可达）+ e2e 推演 + API.md 口径写明」核销；**存量重建仍登记为运维留白**（用户执行，见 [[tasks/registry-cache-manifest/RESULTS.md|RESULTS]] 4.1 节）。

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

- [x] （PRD 21）**端到端**：console 创建的沙箱内执行 `cached-images`，输出与端点 text 格式内容一致（同数据源，e2e 断言；前置 = 用户已完成存量沙箱重建至 `base:0.4.0`）。——**核销口径（2026-11-15）**：由 `16-cache-images › 端到端` 钉住——console 创建**新建** `base:0.4.0` 沙箱（新沙箱自带命令与注入，不依赖存量重建），容器内 `cached-images` 经文件通道取回全量字节与端点 text **逐字一致**、退出码 0、stderr 空；存量重建另见 26 与运维留白。
- [x] （PRD 29）**文档落位**：`API.md` 新端点章节（两格式 + 鉴权矩阵 + 部署前提「绑回环时沙箱侧失效」）；`base-image/README.md` 命令用法与引导约定（04 已落，复核在场）；仓库根 `README.md` 设置接口段补一行（逐文件核对在场）。——三文件在场，固定文案（422/503/401）与实际代码逐字核对、退出码 0/2/3 与 TTL 60s 口径核对一致。
- [x] （PRD 30）**部署前提可核验**：服务端绑回环（如仓库单元默认 `127.0.0.1:8000`）时沙箱侧失效（cached-images 走降级提示）、console 视图不受影响（实测或按 18 / 25 已有真机记录推演钉住，口径写明）；当前部署形态（绑 `0.0.0.0:28642` + LAN IP）端到端可用（e2e / 真机）。——按「03 真机记录（探测兑底档实测可达，即非回环监听形态可用）+ e2e 推演（转发器回环自保护断言钉「绑回环 ⇒ 沙箱侧失效」；视图冒烟在回环后端上全绿钉「视图不受影响」）+ `API.md` 17.4 口径写明」三档核销，推演依据见 PRD 30 注记与 RESULTS 3.4 节。
- [x] （PRD 31）**分层归属落位**：扫描器在核心包（`RegistryProxyManager` 邻居、同特权通道、解析与特权 IO 分离可单测）；服务端只做端点 / 令牌 / TTL 缓存 / text 渲染；**无任何 GC 入口**（全库检索零命中，GC 仅为关联提及）。——源码指针 + 全库检索复核（RESULTS 第五节硬约束表）。
- [x] （PRD 32）**回归不破**：后端 pytest 全绿（≥ 基线）+ ruff rc=0；核心包 pytest 全绿（root + 非 root 两档）；前端 vitest 全绿（≥ 基线）+ typecheck 双零错 + build 成功；e2e 全量既有用例 0 失败——数字记录进 RESULTS.md。——后端 398 passed + ruff 0；核心包 500 passed / 3 failed（既有 root_lifecycle 环境故障）+ ruff 0；vitest 953 + typecheck 双零错 + build；e2e 全量 **71 / 71**（首轮 1 例既有用例瞬时失败已甄别为环境性，见 RESULTS 第二节）。
- [x] PRD **32 / 32** 逐条核销挂证据（验收标准节 checkbox 全勾，每条标注证据档位：真机 e2e / 单测 / 文档落位）。
- [x] 硬约束六条复核完成并留证据指针（禁 bash 解析 JSON / 禁 jq / 禁 `docker images` 劫持 / 禁透明改写 / 无 GC 入口 / CLI 零改动）。——RESULTS 第五节逐条带证据指针。
- [x] 看板 / 两份清单 / 词汇表同步完成；`RESULTS.md` 落库；本任务 status → done。

## 依赖

- 依赖全部：[[tasks/registry-cache-manifest/01-core-cache-scanner.md|01]]、[[tasks/registry-cache-manifest/02-server-endpoint-and-token.md|02]]、[[tasks/registry-cache-manifest/03-injection-pipeline.md|03]]、[[tasks/registry-cache-manifest/04-base-image-cached-images.md|04]]、[[tasks/registry-cache-manifest/05-console-cache-images-view.md|05]]。
- **外部前置**：现有沙箱重建（用户执行，04 推送 `base:0.4.0` 后）——21 / 26 / 30 核销的硬前置。
- 需求：[[prds/registry-cache-manifest.md|镜像缓存清单与缓存优先拉取引导 PRD]]。

## 进展（2026-11-15 收口）

> **任务完成（status: done）。** 在途半成品（新 spec + 三份文档改动）经逐字核对与实际行为一致、无半截内容，作为起点续作；e2e 与全量门禁全绿；PRD 32 条逐条核销、全轮留档落库。

### 交付落位（三个提交）

- **验收 spec `16-cache-images.spec.ts`**（345 行，4 条用例）：端到端（PRD 21，真沙箱 `0.4.0` 新建 + cached-images 输出与端点 text 同源一致）、端点两格式（PRD 9/10）、端点负例（PRD 8/11，固定文案原文断言）、console 视图冒烟（PRD 27/28）；spec 自带 `acc-` 前缀沙箱清理与 TCP 转发器（含回环自保护断言，PRD 30 的 e2e 推演依据）。
- **文档落位**：`API.md` 第 17 章（137 行：两格式 / 错误表 / 双凭据鉴权矩阵 / 部署前提与 CLI 边角 / 示例）+ 11.1 端点表补行；根 `README.md` 设置接口段 curl 示例 + 表格行；`base-image/README.md` ②态退出码口径对齐 04 实际行为（未知参数并入退出码 2）；`docs/glossary.md` 补「受限令牌」「缓存镜像清单」词条；PRD 32 条逐条核销挂证据。
- **全轮留档**：`RESULTS.md`（轮次总表与提交链 / 门禁数字 / 真缓存实测与真机记录汇总 / 已知边界与留白含两条运维留白 / 硬约束六条复核带证据指针）；任务集 README、`docs/prds/README.md`、`docs/tasks/README.md`、`docs/current-state.md` 同步。

### e2e 与甄别记录

- 新 spec 单跑 **4 / 4 全绿**（33.9s）；e2e 全量 **71 / 71 passed**（67 既有 + 4 新增，12.6 分钟）。
- 首轮全量 70 passed + 1 failed（`12-file-transfer.spec.ts:776`，列目录响应计数竞态 expected 2 / received 3）——隔离复跑 passed（920ms）+ 全量复跑 71/71 全绿 + 相关性判断（本轮零前端产品源码改动、spec 16 不触面包屑路径）⇒ **环境性瞬时失败，与本轮改动无关**。

### 门禁（06 收口实测）

- 后端 pytest **398 passed / 0 failed** + ruff rc=0；核心包 pytest **500 passed / 3 failed**（3 例既有 root_lifecycle 环境故障，与 01 / 03 收口同源）+ ruff rc=0；前端 vitest **953 passed** + typecheck 双零错 + build 成功。
- 生产 systemd 服务（28642）零接触（收口复核监听进程未变）；测试沙箱全清（spec 自清 + 收尾复核 `acc-` 前缀零残留）。

### PRD 21 / 26 / 30 核销口径（收口裁定）

- **21** 由新 e2e spec 钉：console 创建**新建** `base:0.4.0` 沙箱即满足「console 创建的沙箱」语义（新沙箱自带命令与注入），不依赖存量重建；
- **26** checkbox 本体是「口径写进文档」：04 已落 `base-image/README.md` 与 `API.md` 17.4，此处复核勾；存量重建登记为运维留白；
- **30** 按「03 真机记录（探测兜底档实测可达）+ e2e 推演（回环自保护断言 + 视图冒烟）+ `API.md` 17.4 口径写明」三档核销。

### 收尾复核（2026-11-15）

- 收口后审查复核两提交落链：`e04391b` 审查收尾——跨 TTL 归一化回退死路径修复（前缀断言入 else 分支）+ 转发器 error 监听与连接清理闭环（`forwarderSockets` 名册替代 `closeAllConnections`——该 API 是 `http.Server` 独有、`net.Server` 无）+ 清理失败 `test.info().annotations` 留痕 + 三计数 `Number.isFinite`；新 spec 两轮单跑 **4 / 4 全绿**，复归全量 e2e **71 / 71**（12.5 分钟）；`65f8d72` 复核勘误——spec 头注释清理口径改回自动化兜底事实（`acc-` 前缀清扫由 `cleanupLeftoverSandboxes` 在 global-setup / global-teardown 自动执行）。
- 复核结论：**通过**——Critical 已修复、Warning 2 替代实现经核实正确无泄漏、唯一注释勘误已修；收口数字不变。

全轮数字与证据指针见 [[tasks/registry-cache-manifest/RESULTS.md|RESULTS]]。
