# 三期任务集（桌面端打包 + 端口转发）

本目录是沙箱平台**三期**的任务集，共 9 个任务，需求来源见 [[prds/phase3-desktop.md|三期 PRD]]。

三期 = 桌面端打包（Tauri）+ 端口转发 + 连接层改造（后端独立 API + token 认证）。原「前后端分离部署」规划被本期吸收（后端侧并入、Cloudflare 静态托管退役），决策依据见 [[architecture/decisions/0013-三期定位改定与认证重启.md|0013 三期定位改定与认证重启]]；端口转发机制见 [[architecture/decisions/0014-端口转发机制选型.md|0014 端口转发机制选型]]；桌面壳与连接配置见 [[architecture/decisions/0015-桌面壳与连接配置抽象.md|0015 桌面壳与连接配置抽象]]。

**状态：01 done、02 done（待与 03 同批发布）、03 doing（远端形态已真机通过，本机形态待拍板），04 done、05 done，**06 done（真机连通通过）**，07 done，08~09 todo。** 打样轮 01 已闭合（2026-11-04，Windows 11 真机 + 真后端复验全通过：P2 三项全过 / P4 路径②正式可交付 / P5 无提装，结论见 [[tasks/phase3-desktop/RESULTS.md|三期留档]]）；02（连接层后端改造：令牌 + 一次性票据鉴权 / CORS 任意来源）与 03（连接层前端改造：基址抽象 / 连接配置 / 未配置态）**均已落地**，按部署口径**同批发布**后网页控制台恢复；03 只差第 2 条完成标准（同一份产物连本机 / 远端后端全链路可用）——**远端形态已于 2026-11-04 真机实测通过，本机形态（连同机后端）未单独实测、口径待用户拍板**，**04 已完成**（2026-11-03：核心包 `forwarding.py` 落地并通过审查修复轮——转发容器编排（不发布端口）/ exec 字节泵 / 转发记录原子读写 / 生命周期联动与遗留清理；门禁：核心包 pytest 288 passed、ruff 0、CLI 零改动），**05 已完成**（2026-11-03：三条转发管理 REST + 隧道 WebSocket 落地并通过审查修复轮——错误帧与 HTTP `detail` 全为固定中文文案（原文只进日志）、`SandboxError` 统一收敛 1008、镜像失败 503、字节泵 I/O 独立线程池（32）、stderr 排空与失败原因帧、关闭竞态收敛、新增关闭码 1011；门禁：服务端 pytest 289 passed / 核心包 292 passed / ruff 0 / 分层契约 10 passed / CLI·前端·桌面零改动），**06 done**（2026-11-03 实现并通过审查修复轮：Rust 本机监听（每转发一个 `127.0.0.1` 监听、每条连接各开一条隧道 WS，Bearer；**单条隧道断开只关该连接、监听器保留到用户显式 `stop_forward`**）+ 端口转发界面（web 形态只说明卡 + 安装指引、桌面形态完整管理；Rust 侧不落盘令牌）；门禁：前端 vitest 527 / typecheck 双零错 / build 过、cargo check 0 警告 / cargo test 20；**2026-11-04 真机连通通过**（桌面端开启转发后本机端口可访问沙箱服务），**整体验收由用户实际使用确认、无其他问题**；注：界面已由 2026-11-04 端口转发区 UI 重构轮的表格化重构替代，原卡片行口径以追加轮为准），**07 已完成**（2026-11-03：验收套件 token 化——测试令牌单一来源 `helpers/auth.ts`（服务进程注入 / 脚本直调 / 页面预置三处同一份）、页面侧 `storageState` 预置 + 运行期注入（构造未配置 / 错令牌两态）、新增 `specs/10-auth-connection.spec.ts` 10 条认证用例（401 负向 / 200 正向 / 无票据 WS 被拒（精确 1006）/ 带票 WS 正向对照 / 引导面板与工作台挂载）；门禁：全量套件 **46 passed / 0 failed**（约 8.6 分钟，含构建与真机沙箱），**产品源码零改动**）。看板见 [[current-state.md|当前状态]]。

> **✅ 验收套件已恢复（不再有已知过渡态）**：既有 Playwright 验收套件（`apps/web/frontend/tests`）自 03 落地起曾为红（未配置态引导面板替换了工作台 + 后端要求令牌，脚本没预置令牌就进不了工作台）——**该过渡态已由 07（[[tasks/phase3-desktop/07-acceptance-tokenization.md|验收套件 token 化]]）闭合**：既有 9 条 spec 全部恢复并全量 46 passed / 0 failed，认证负向用例常驻（含带票正向对照）。**现在看到套件为红才是真回归。**

## 任务清单

| 编号 | 任务 | 状态 | 交付内容 |
|---|---|---|---|
| [[tasks/phase3-desktop/01-prototype-and-spike.md\|01]] | 打样轮：免 root 端口发布 / Tauri 壳 / WebView2 三项冒烟 | done | 四项打样结论 + 失败时的备案路径裁决 + Windows 出包路径裁决（**2026-11-04 真机复验全通过：P2 三项全过 / P4 路径②正式可交付 / P5 无提装**） |
| [[tasks/phase3-desktop/02-backend-token-and-cors.md\|02]] | 连接层后端改造：token 认证 / CORS / WS 鉴权 | done | 令牌生成与配置、Bearer 中间件、一次性票据鉴权、CORS 任意来源（WS 握手无 Origin 门禁） |
| [[tasks/phase3-desktop/03-frontend-connection-layer.md\|03]] | 连接层前端改造：基址抽象 / 连接配置 / 未配置态 | doing（远端形态已真机通过，本机形态待拍板） | `src/lib/connection.ts`、请求基址、WS 地址推导、引导面板、设置区 |
| [[tasks/phase3-desktop/04-port-forward-core.md\|04]] | 端口转发核心包能力 | done | `forwarding.py`：转发容器编排（**不发布端口**）、exec 字节泵、转发记录原子读写、生命周期联动与遗留清理（**无宿主端口分配**） |
| [[tasks/phase3-desktop/05-port-forward-server-api.md\|05]] | 端口转发服务端接口 | done | 三条转发管理 REST（GET 裸数组 / POST `{sandbox, port}` / DELETE）+ `/api/forward/tunnel/{id}` 隧道 WS（**exec 字节泵**，模型无 `host_port`；Bearer 鉴权、固定文案错误帧、关闭码 1000/1001/1008/1011） |
| [[tasks/phase3-desktop/06-port-forward-desktop.md\|06]] | 端口转发桌面侧 | done | Rust 本机监听与隧道桥接（每连接一条隧道 WS；**单条隧道断开只关该连接，监听器保留到用户显式停止**）、端口转发界面（web 形态只说明卡 + 安装指引，桌面形态完整管理）；**真机连通已通过（2026-11-04）** |
| [[tasks/phase3-desktop/07-acceptance-tokenization.md\|07]] | 既有验收套件 token 化改造 | done | 令牌单一来源（`helpers/auth.ts`）、`storageState` 预置 + 运行期注入、新增 `10-auth-connection.spec.ts` 10 条认证用例（含 401 负向、无票据 WS 被拒与带票正向对照）；全量套件 46 passed / 0 failed |
| [[tasks/phase3-desktop/08-windows-package.md\|08]] | Windows 打包产物与冒烟 | todo | 安装包产出、干净机器安装冒烟 |
| [[tasks/phase3-desktop/09-acceptance-and-docs.md\|09]] | 验收回归与文档收口 | todo | 全量回归 + 三篇 ADR + 看板 / 词汇 / 总览 / 约定 / API.md 同步 |

## 追加轮（不入 9 任务编号序列）

- **端口转发区 UI 重构轮（2026-11-04，前端单侧改造）**：转发列表由卡片行改为五列表格（本地端口 / 容器端口 / 本地状态 / 容器状态 / 操作：同步·编辑·删除三个单 icon 按钮），状态改为小圆点 + Tooltip（「未开启」映射为红），行 = 后端记录 ∪ 本机监听并集（孤儿行可见、可同步重建）；本机监听改全手动生命周期（无任何自动开关），本机端口与转发同建同删（编辑仅监听中可用）；新增工作台层 10 秒合并轮询（沙箱详情 + 转发记录一拍双刷）。门禁：前端 vitest 585 passed / typecheck 0 / build 过，经审查修复轮闭合 4 项必修（web 形态白跑转发请求、删无监听行误报、Esc 冒泡关抽屉、迁移 stop 无兜底）；后端 / Rust / CLI 零改动。本轮不属 01~09 编号序列、不新建任务文件，也不改 9 个任务的状态字段；进展见 [[current-state.md|当前状态]]。
- **桌面壳 dev 刷新修复轮（2026-11-04）**：needs_csp_reload 桌面端 dev 恒 false，切断 dev 启动无限整页刷新；cargo test 26 passed；前端 / CLI 零改动；本轮不属 01~09 编号序列、不新建任务文件，也不改 9 个任务的状态字段；详见 `apps/desktop/README.md` 的「时序契约（CSP 与主文档重载）」小节与 [[current-state.md|当前状态]]。

## 依赖顺序

```
01 ──▶ 02 ──▶ 03 ──▶ 07
 │                 │
 └──▶ 04 ──▶ 05 ──▶ 06 ──┐
                          ├──▶ 08 ──▶ 09
 └───────────────────────┘
```

**图上进度标记**：01 done / 02 done / 03 doing（远端形态已真机通过，本机形态待拍板）/ **04 done** / **05 done** / **06 done** / **07 done** / 08~09 todo。

- **01 是全期的前置硬门槛**：`P1`（免 root `-p` 是否在宿主回环真的产生监听）**已实测通过**，但按 **2026-11-03 决策 C** **不采用**该路径——04 / 05 / 06 按 **Fallback B（`docker exec -i` 字节泵）** 实现（后端宿主零端口）；`P2`（WebView2 三项冒烟）**已于 2026-11-04 真机实测通过**（不成立时的备案路径未启用）；`P4`（Windows 出包路径）**已实测通过**——路径②正式可交付，08 可按此出包。
- **02 → 03 强顺序**：后端契约先定，前端才能对接。
- **04 → 05 → 06 强顺序**：核心包能力先定，服务端再包 REST 与隧道，桌面侧最后接。**04 / 05 / 06 均已 done**（04 / 05 于 2026-11-03；06 于 2026-11-04 真机连通通过）。
- **07 可与 04 / 05 / 06 并行**：它改造的是既有验收套件，与新功能无耦合；但它依赖 02 的令牌契约。**07 已 done**（2026-11-03），验收套件恢复全绿。
- **09 收口**：等 01~08 全部就位。

## 关键前置与风险（展开见任务 01）

| 项 | 性质 | 影响 |
|---|---|---|
| P1 免 root `-p` 发布宿主回环 | **已实测通过**（本机，2026-11-03），**但按决策 C 不采用**——`-p` 主路径与宿主端口区间分配整体废除，**Fallback B（`docker exec -i` 字节泵）是唯一路径**，后端宿主零端口 | 04~06 按 exec 字节泵实现；宿主端口分配 / 占位 / 区间概念全部废除 |
| P2 WebView2 三项冒烟 | **已实测通过**（Windows 11 真机，2026-11-04）：① `oklch` 配色正常；② xterm 渲染 / fit / 表面不溢出正常；③ `window.isSecureContext === true`、剪贴板读写可用 | 风险未触发（备案路径未启用） |
| P3 转发镜像经代理可拉 | **已实测通过**（本机，digest 已钉） | 转发镜像可经统一镜像代理拉进免 root 守护进程 |
| P4 Windows 出包路径 | **已实测通过并正式记录**（Windows 11，2026-11-04）：路径②（用户自有 Windows 机器本地构建）**正式可交付**——产出 NSIS `setup.exe` 约 3.7 MB（**构建耗时未统计**）；**路径①（GitHub Actions）未验**，仓库仍无 CI、无远端 | 决定 08 的交付方式与是否需要用户机器 |
| P5 WebView2 运行时策略 | **已实测通过**（Windows 11 真机，2026-11-04）：**无提装动作、直接可用**（Win11 系统自带 WebView2 运行时，属预期行为）；`downloadBootstrapper` 取值不变 | 缺运行时场景（离线随包 / 提示自装）未验——目标机器的 WebView2 版本不由我们控制 |
| R5 验收套件全量回归成本 | 已知；**当前状态：07 已落地，9 条 spec 全部恢复并全量 46 passed / 0 failed（约 8.6 分钟），认证负向用例常驻** | 套件已恢复全绿；后续回归含端口转发用例（06 真机已通过，用例待补） |
| R10 宿主回环这一跳不受令牌保护 | **已作废**（2026-11-03 决策 C：后端宿主不再发布任何转发端口，暴露面归零） | 无需处理 |

完整的打样前置项（P1~P5）、风险清单（R1~R16）与开放问题清单（Q1~Q16）见 [[prds/phase3-desktop.md|三期 PRD]]；打样与实测结论留档见 [[tasks/phase3-desktop/RESULTS.md|三期留档]]。

## 部署顺序硬约束

- **02 不得单独部署到在跑的网页控制台**：前端在 03 落地前不发 `Authorization` 头、不取票据，02 合并后网页控制台全线 `401`。这是令牌硬需求的必然结果（[[architecture/decisions/0013-三期定位改定与认证重启.md|ADR 0013]] 第 3 节），不是缺陷。（**现状：03 已落地，二者已具备同批发布条件；07 已落地，验收套件已恢复（46 passed / 0 failed）。**）
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
- [[tasks/phase3-desktop/RESULTS.md]] — 打样与实测结论留档（P1~P5 全部有结论：P1 / P3 本机实测，P2 / P4 / P5 于 2026-11-04 Windows 11 真机实测闭合）。
