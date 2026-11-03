# 三期任务集（桌面端打包 + 端口转发）

本目录是沙箱平台**三期**的任务集，共 9 个任务，需求来源见 [[prds/phase3-desktop.md|三期 PRD]]。

三期 = 桌面端打包（Tauri）+ 端口转发 + 连接层改造（后端独立 API + token 认证）。原「前后端分离部署」规划被本期吸收（后端侧并入、Cloudflare 静态托管退役），决策依据见 [[architecture/decisions/0013-三期定位改定与认证重启.md|0013 三期定位改定与认证重启]]；端口转发机制见 [[architecture/decisions/0014-端口转发机制选型.md|0014 端口转发机制选型]]；桌面壳与连接配置见 [[architecture/decisions/0015-桌面壳与连接配置抽象.md|0015 桌面壳与连接配置抽象]]。

**状态：01 doing、02 done（待与 03 同批发布）、03 doing（实现完成，待真机复验），04 done，05~09 todo。** 打样轮 01 的本机部分已完成（结论见 [[tasks/phase3-desktop/RESULTS.md|三期留档]]），首轮 Windows 反馈已入档（P4 路径②可行、P2 外观初测通过；P2 控制台三项、P5 与「骨架可启动」仍待验）；02（连接层后端改造：令牌 + 一次性票据鉴权 / CORS 任意来源）与 03（连接层前端改造：基址抽象 / 连接配置 / 未配置态）**均已落地**，按部署口径**同批发布**后网页控制台恢复；03 只差第 2 条完成标准（同一份产物连本机 / 远端后端全链路可用）待用户 Windows 真机 + 真后端复验，**04 已完成**（2026-11-03：核心包 `forwarding.py` 落地并通过审查修复轮——转发容器编排（不发布端口）/ exec 字节泵 / 转发记录原子读写 / 生命周期联动与遗留清理；门禁：核心包 pytest 288 passed、ruff 0、CLI 零改动），**05 起可开工**（05/06 已按 2026-11-03 决策 C 改写）。看板见 [[current-state.md|当前状态]]。

> **⚠️ 已知过渡态（勿当回归）**：既有 Playwright 验收套件（`apps/web/frontend/tests`，9 条 spec）**自 03 落地起为红**——未配置态引导面板替换了工作台，后端又要求令牌，脚本没预置令牌就进不了工作台。**07（[[tasks/phase3-desktop/07-acceptance-tokenization.md|验收套件 token 化]]）落地后恢复**。这 9 条红是已知过渡态，不是回归。

## 任务清单

| 编号 | 任务 | 状态 | 交付内容 |
|---|---|---|---|
| [[tasks/phase3-desktop/01-prototype-and-spike.md\|01]] | 打样轮：免 root 端口发布 / Tauri 壳 / WebView2 三项冒烟 | doing | 四项打样结论 + 失败时的备案路径裁决 + Windows 出包路径裁决 |
| [[tasks/phase3-desktop/02-backend-token-and-cors.md\|02]] | 连接层后端改造：token 认证 / CORS / WS 鉴权 | done | 令牌生成与配置、Bearer 中间件、一次性票据鉴权、CORS 任意来源（WS 握手无 Origin 门禁） |
| [[tasks/phase3-desktop/03-frontend-connection-layer.md\|03]] | 连接层前端改造：基址抽象 / 连接配置 / 未配置态 | doing | `src/lib/connection.ts`、请求基址、WS 地址推导、引导面板、设置区 |
| [[tasks/phase3-desktop/04-port-forward-core.md\|04]] | 端口转发核心包能力 | done | `forwarding.py`：转发容器编排（**不发布端口**）、exec 字节泵、转发记录原子读写、生命周期联动与遗留清理（**无宿主端口分配**） |
| [[tasks/phase3-desktop/05-port-forward-server-api.md\|05]] | 端口转发服务端接口 | todo | `/api/forwards` 三条 REST + `/api/forward/tunnel/{id}` 隧道 WS（**exec 字节泵**，模型无 `host_port`） |
| [[tasks/phase3-desktop/06-port-forward-desktop.md\|06]] | 端口转发桌面侧 | todo | Rust 本机监听与隧道桥接、端口转发界面（web 形态只说明卡 + 安装指引，桌面形态完整管理） |
| [[tasks/phase3-desktop/07-acceptance-tokenization.md\|07]] | 既有验收套件 token 化改造 | todo | 令牌注入、`storageState` 预置、负向用例 |
| [[tasks/phase3-desktop/08-windows-package.md\|08]] | Windows 打包产物与冒烟 | todo | 安装包产出、干净机器安装冒烟 |
| [[tasks/phase3-desktop/09-acceptance-and-docs.md\|09]] | 验收回归与文档收口 | todo | 全量回归 + 三篇 ADR + 看板 / 词汇 / 总览 / 约定 / API.md 同步 |

## 依赖顺序

```
01 ──▶ 02 ──▶ 03 ──▶ 07
 │                 │
 └──▶ 04 ──▶ 05 ──▶ 06 ──┐
                          ├──▶ 08 ──▶ 09
 └───────────────────────┘
```

**图上进度标记**：01 doing / 02 done / 03 doing（待真机复验）/ **04 done** / 05~09 todo（**05 可开工**）。

- **01 是全期的前置硬门槛**：`P1`（免 root `-p` 是否在宿主回环真的产生监听）**已实测通过**，但按 **2026-11-03 决策 C** **不采用**该路径——04 / 05 / 06 按 **Fallback B（`docker exec -i` 字节泵）** 实现（后端宿主零端口）；`P2`（WebView2 三项冒烟）不成立时，03 的样式与剪贴板口径要调整；`P4`（Windows 出包路径）不成立时，08 无法交付。
- **02 → 03 强顺序**：后端契约先定，前端才能对接。
- **04 → 05 → 06 强顺序**：核心包能力先定，服务端再包 REST 与隧道，桌面侧最后接。**04 已 done**（2026-11-03），05 可开工。
- **07 可与 04 / 05 / 06 并行**：它改造的是既有验收套件，与新功能无耦合；但它依赖 02 的令牌契约。
- **09 收口**：等 01~08 全部就位。

## 关键前置与风险（展开见任务 01）

| 项 | 性质 | 影响 |
|---|---|---|
| P1 免 root `-p` 发布宿主回环 | **已实测通过**（本机，2026-11-03），**但按决策 C 不采用**——`-p` 主路径与宿主端口区间分配整体废除，**Fallback B（`docker exec -i` 字节泵）是唯一路径**，后端宿主零端口 | 04~06 按 exec 字节泵实现；宿主端口分配 / 占位 / 区间概念全部废除 |
| P2 WebView2 三项冒烟 | 首轮外观初测通过（配色正常），控制台三项待调试构建（`pnpm tauri dev`）复验；**xterm 真渲染待真机连真后端后验**（03 已落地，阻塞已解，可测了） | `oklch` 掉色 / xterm 溢出 / 剪贴板不可用 |
| P3 转发镜像经代理可拉 | **已实测通过**（本机，digest 已钉） | 转发镜像可经统一镜像代理拉进免 root 守护进程 |
| P4 Windows 出包路径 | 路径②（用户自有 Windows 机器本地构建）已可行，细节待正式记录；**仓库无 CI、无远端** | 决定 08 的交付方式与是否需要用户机器 |
| R5 验收套件全量回归成本 | 已知；**当前状态：9 条 spec 自 03 落地起为红（过渡态，非回归），07 token 化后恢复** | 9 条 spec 全部带令牌，负向用例新增 |
| R10 宿主回环这一跳不受令牌保护 | **已作废**（2026-11-03 决策 C：后端宿主不再发布任何转发端口，暴露面归零） | 无需处理 |

完整的打样前置项（P1~P5）、风险清单（R1~R16）与开放问题清单（Q1~Q16）见 [[prds/phase3-desktop.md|三期 PRD]]；打样与实测结论留档见 [[tasks/phase3-desktop/RESULTS.md|三期留档]]。

## 部署顺序硬约束

- **02 不得单独部署到在跑的网页控制台**：前端在 03 落地前不发 `Authorization` 头、不取票据，02 合并后网页控制台全线 `401`。这是令牌硬需求的必然结果（[[architecture/decisions/0013-三期定位改定与认证重启.md|ADR 0013]] 第 3 节），不是缺陷。（**现状：03 已落地，二者已具备同批发布条件；发布后仍需 07 恢复验收套件。**）
- **02 必须与 03 同批发布**：03 落地（请求基址抽象 + 统一带令牌 + 票据获取）后前端才具备带凭据请求后端的能力，两者同批发布后网页控制台恢复。
- 该约束只针对**部署节奏**，不改变任务集内的依赖顺序（02 → 03 仍是最强顺序）。

## 任务文件

- [[tasks/phase3-desktop/01-prototype-and-spike.md]] — 打样轮：免 root 端口发布 / Tauri 壳 / WebView2 三项冒烟 / Windows 出包路径。
- [[tasks/phase3-desktop/02-backend-token-and-cors.md]] — 连接层后端改造：令牌 + 一次性票据鉴权 / CORS 任意来源（WS 握手无 Origin 门禁）。
- [[tasks/phase3-desktop/03-frontend-connection-layer.md]] — 连接层前端改造：请求基址抽象 / 连接配置 / WebSocket 地址推导 / 未配置态。
- [[tasks/phase3-desktop/04-port-forward-core.md]] — 端口转发核心包能力：转发容器编排（**不发布端口**）/ 生命周期与清理（**无宿主端口分配**）。
- [[tasks/phase3-desktop/05-port-forward-server-api.md]] — 端口转发服务端接口：转发管理 REST + 隧道 WebSocket（**exec 字节泵**）。
- [[tasks/phase3-desktop/06-port-forward-desktop.md]] — 端口转发桌面侧：Rust 本机 TCP 监听 + 隧道桥接 + 端口转发界面。
- [[tasks/phase3-desktop/07-acceptance-tokenization.md]] — 既有验收套件 token 化改造。
- [[tasks/phase3-desktop/08-windows-package.md]] — Windows 打包产物与冒烟。
- [[tasks/phase3-desktop/09-acceptance-and-docs.md]] — 验收回归与文档收口。
- [[tasks/phase3-desktop/RESULTS.md]] — 打样与实测结论留档（P1 / P3 已填，P2 / P4 / P5 待 Windows 实测）。
