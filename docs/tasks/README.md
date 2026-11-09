# 任务

需求拆分出的开发任务。**按 PRD 分组**：`tasks/<feature>/<NN>-<短名>.md`。每个 task 是一个可独立领取、独立完成的单元。

## Task 文件格式

```
---
prd: prds/<feature>.md
status: todo        # todo | doing | done | blocked
---
# 任务：<标题>

## 目标
（来自 PRD 的拆分项）

## 完成标准
- [ ] ...

## 依赖
- 无 / 或依赖其他 task
```

## 状态约定
- `todo` — 待领取
- `doing` — 正在执行中
- `done` — 完成
- `blocked` — 阻塞

## 清单
- [[tasks/sandbox-platform/README.md]] — 沙箱平台一期（本地闭环）任务集索引，含依赖顺序
- [[tasks/sandbox-platform/01-rootless-probe.md]] — 免 root 沙箱模式打样验证（02、04 的前置）
- [[tasks/sandbox-platform/02-base-image.md]] — 平台基础镜像
- [[tasks/sandbox-platform/03-sandbox-image.md]] — 默认全栈沙箱镜像
- [[tasks/sandbox-platform/04-lifecycle-core-cli.md]] — 生命周期核心模块与 CLI
- [[tasks/sandbox-platform/05-e2e-harness.md]] — 端到端测试基建
- [[tasks/sandbox-platform/06-sample-app-acceptance.md]] — 示例全栈项目与一期验收演练
- [[tasks/sandbox-platform/RESULTS.md]] — 平台侧总验收结论留档（一期总验收与分项、二期分项与已知边界）
- [[tasks/phase2-console/README.md]] — 沙箱平台二期（控制面服务化与网页控制台）任务集索引，含依赖顺序
- [[tasks/phase2-console/01-service-core-api.md]] — 控制面服务骨架与沙箱管理 HTTP 接口
- [[tasks/phase2-console/02-image-proxy-api.md]] — 宿主镜像枚举与代理状态管理接口
- [[tasks/phase2-console/03-web-terminal.md]] — 网页终端：伪终端会话管理与 WebSocket 桥接
- [[tasks/phase2-console/04-console-frontend.md]] — 网页控制台前端（React + Vite）
- [[tasks/phase2-console/05-acceptance-regression.md]] — 二期端到端验收与一期回归复验
- [[tasks/phase2-console/07-console-ui-overhaul.md]] — 控制台 UI 全面改造（单页工作台 + 新视觉底座）
- [[tasks/phase2-console/08-console-drawer-migration.md]] — 控制台弹窗抽屉化（大面板改右侧抽屉 + 确认类弹窗精简）
- [[tasks/console-templates/README.md]] — 控制台模板轮（基础镜像 0.3.0 工具层 + 启动模板）任务集索引，含依赖顺序
- [[tasks/console-templates/01-base-image-0.3.0.md]] — 平台基础镜像 0.3.0：apt 装 9 个通用工具包、构建转联网、判定扩到 42 项
- [[tasks/console-templates/02-template-server.md]] — 启动模板服务端：模板库落盘、四条接口、`~` 展开、内置模板种子机制
- [[tasks/console-templates/03-template-console.md]] — 启动模板前端与字体：新建抽屉加载 / 保存、设置抽屉模板管理区、字体子集重生成
- [[tasks/console-templates/04-acceptance-and-docs.md]] — 控制台模板轮真机验收与文档收口：三套测试全绿、两篇架构决策记录、看板与约定同步
- [[tasks/file-injection/README.md]] — 文件注入轮（创建沙箱时把宿主文件复制进沙箱）任务集索引，含四个工作包完成状态、验收数字与提交链
- [[tasks/phase3-desktop/README.md]] — 三期（桌面端打包 + 端口转发）任务集索引，含 9 个任务、依赖顺序与关键前置风险（**done：01~09 全部 done，三期整体于 2026-11-04 收口**）
- [[tasks/phase3-desktop/01-prototype-and-spike.md]] — 打样轮：免 root 端口发布 / Tauri 壳 / WebView2 三项冒烟 / Windows 出包路径（done：本机 P1 / P3 已实测通过；P1 结论仍成立但按 2026-11-03 决策 C **不采用** `-p` 路径；**2026-11-04 Windows 11 真机复验全通过**——P2 三项全过、P4 路径②正式可交付、P5 无提装）
- [[tasks/phase3-desktop/02-backend-token-and-cors.md]] — 连接层后端改造：令牌 + 一次性票据鉴权 / CORS 任意来源（done：后端侧已落地，准入边界 = 令牌 + 票据；按部署口径须与 03 同批发布）
- [[tasks/phase3-desktop/03-frontend-connection-layer.md]] — 连接层前端改造：请求基址抽象 / 连接配置 / WebSocket 地址推导 / 未配置态（done：前端侧已落地，CSP 闸门闭合；**远端形态已于 2026-11-04 真机实测通过**，**本机形态按用户拍板的「偏离记录」口径闭合**——本平台后端在 Linux 宿主、桌面端在 Windows，本机形态在目标部署中不存在，远端形态约束更强且机制上覆盖本机形态，留待该场景实际出现时再验证；**2026-11-03 决策 D「基址不可空」已落地（2026-11-03，前端改造完成）**）
- [[tasks/phase3-desktop/04-port-forward-core.md]] — 端口转发核心包能力：转发容器编排（**不发布端口**）/ exec 字节泵 / 转发记录原子读写 / 生命周期与清理（**无宿主端口分配**）（done：`forwarding.py` 已落地并通过审查修复轮；门禁 pytest 288 passed / ruff 0 / CLI 零改动；两处既定偏差见任务文件文末「进展」）
- [[tasks/phase3-desktop/05-port-forward-server-api.md]] — 端口转发服务端接口：转发管理 REST + 隧道 WebSocket（**exec 字节泵**，done：三条 REST + 隧道 WS 已落地并通过审查修复轮——Bearer 鉴权、固定中文文案错误帧、关闭码 1000/1001/1008/1011、字节泵专用线程池；门禁 pytest 289 passed / 核心包 292 passed / ruff 0 / 分层契约 10 passed / CLI·前端·桌面零改动）
- [[tasks/phase3-desktop/06-port-forward-desktop.md]] — 端口转发桌面侧：Rust 本机 TCP 监听 + 隧道桥接 + 端口转发界面（done：已实现并通过审查修复轮——**每转发一个本机监听、每条连接各开一条隧道 WS（Bearer）**；**正式口径：单条隧道断开只关该连接，监听器保留到用户显式 `stop_forward`**；web 形态只说明卡 + 安装指引、桌面形态完整管理；Rust 侧不落盘令牌。门禁 vitest 527 / typecheck 双零错 / build 过、cargo check 0 警告 / cargo test 20；**2026-11-04 真机连通通过、整体验收由用户实际使用确认**）
- [[tasks/phase3-desktop/07-acceptance-tokenization.md]] — 既有验收套件 token 化改造（done：测试令牌单一来源 `helpers/auth.ts`、页面侧 `storageState` 预置 + 运行期注入、新增 `10-auth-connection.spec.ts` 10 条认证用例含 401 负向、无票据 WS 被拒与带票正向对照；门禁：全量套件 **46 passed / 0 failed**（约 8.6 分钟；**09 收口轮后全量为 48 passed / 0 failed**），**产品源码零改动**；「验收套件为红」的过渡态到此结束）
- [[tasks/phase3-desktop/08-windows-package.md]] — Windows 打包产物与冒烟（done：NSIS `setup.exe` 约 3.7 MB，**默认路径**、**不入库**；**构建耗时未统计**，用户明确接受不再待补；**冒烟通过**——用户确认安装 / 启动 / 连接 / 使用均无问题；冒烟环境为用户自有 Windows 11，是否全新未另行记录；未签名告警属预期；README 构建说明齐备，**未签名 / SmartScreen 与仅 Windows 承诺两条限制说明已由并行改动补齐**）
- [[tasks/phase3-desktop/09-acceptance-and-docs.md]] — 验收回归与文档收口（done：全量回归 **48 passed / 0 failed / 0 flaky**，约 **9.3 分钟**，**连续两轮全绿**；新增 `11-forward-web-notice.spec.ts` **2 条** web 形态端口转发用例——桌面形态的完整管理 Playwright 覆盖不到，已由 Windows 真机验收替代；三篇 ADR 0013 / 0014 / 0015 期中已落档；看板 / 词汇 / 总览 / 约定 / API.md 核对同步完成；**三期整体收口**）
- [[tasks/phase3-desktop/RESULTS.md]] — 三期打样与实测结论留档（P1~P5 全部有结论：P1 / P3 本机实测；P2 / P4 / P5 于 2026-11-04 Windows 11 真机实测闭合；06 真机连通、08 打包与冒烟同轮闭合；**另含 2026-11-09 收口后缺陷修复留档**——`https://` 后端下的 wss 隧道建连 panic，修复提交 `da36940`，Windows 真机复测通过）
- [[tasks/runtime-file-transfer/README.md]] — 运行期文件传输轮（运行中沙箱的单文件上传 / 下载，类 `docker cp`）任务集索引，含 6 个任务、依赖顺序与硬前置说明（**01 打样与机制验证是硬前置，不通过不进 02**；**01 已于 2026-11-09 收口（done）**，主通道成立、零新增依赖，机制落 [[architecture/decisions/0018-运行期文件传输机制选型.md|ADR 0018]]；**02 亦于 2026-11-09 收口（done）**；**03 亦于 2026-11-09 收口（done）**；**04 亦于 2026-11-09 收口（done）**；**05 代码侧已于 2026-11-09 收口（doing），Windows 真机待验**；06 todo）
- [[tasks/runtime-file-transfer/01-prototype-and-mechanism.md]] — 打样与机制验证：真沙箱 exec 命令实测（临时名 + `mv` / `cat` / 分层探测 / 只读目标报错归类）、反代缓冲与超时核对、200MB 级内存曲线与耗时、容器内 `sh` / `cat` / `wc` / `stat` / `find` 存在性、**ADR 0018 落档（已接受）**（done：2026-11-09 收口——主通道成立、**10 条实测修正口径**、反代 `readTimeout=60s` 硬约束已定位）
- [[tasks/runtime-file-transfer/02-core-transfer.md]] — 核心包传输能力：`transfer.py`（路径校验 / upload / probe / 下载泵 / list）+ `TransferError` 与固定中文文案常量 + 单测（**done：2026-11-09 收口**——`transfer.py` 落地、**93 项单测**全绿、**审查修复一轮**（结论「需修复后合入」的 **7 项必修全部完成**，含 `set -C` + 16 位十六进制临时名防写穿的真机实测验证）；门禁核心包非 root **362 passed**（基线 292 → +70）/ root **23 passed**（11m38s）/ **ruff rc=0**，服务端基线 **287 passed** 未动；**`forwarding.py` 零改动**）
- [[tasks/runtime-file-transfer/03-server-file-endpoints.md]] — 服务端文件传输接口：三个端点（upload / download / list）+ 流式装配（专用线程池）+ 错误文案表 + `API.md` 第 16 章 + 单测（**done：2026-11-09 收口**——服务端 **329 passed**（基线 287 → +42，`test_server_files.py` **42 项**）/ 核心包非 root **370 passed**（+8）/ root **23 passed**（11m20s）/ **ruff rc=0**；审查一轮「需修复后合入」的 **7 项必修全部完成**；**核心包回修**上传字节数核对 + **服务端计数兜底**（双保险）；**Traefik 读超时以「入口点级」落地**——v3 无 service 级 `respondingTimeouts` ⇒ 只动 `websecure` 入口点 `readTimeout=0`（infra 提交 `529ac29`），真机 A/B：改前 60.53 s 被 502 掐断 → 改后 83.13 s 200 成功）
- [[tasks/runtime-file-transfer/04-frontend-file-panel.md]] — 前端文件浏览面板：入口按钮 + 独立抽屉 + 面包屑 + 三列列表 + 上传 / 下载 / 进度 / 覆盖确认框 + 图标资产 vendor（**done：2026-11-09 收口**——「文件」入口与抽屉落地，上传队列 / XHR 进度 / 取消 / 同名覆盖确认（列表不可信先重读、同名目录走 400）、点行下载 + `Content-Length` 流式进度 + 多文件并行、关闭 / 切沙箱全量收口；图标 **113 个 SVG** 本地 vendor（v5.40.0 的 111 个 + 兜底 `folder.svg` / `file.svg`，运行时零 CDN）；后端配套 CORS `expose_headers`；用户八条硬约束逐条核验成立，审查修复一轮（2 Critical + **12 项清单**全部落地）；门禁：前端 **633 passed**（基线 584 → +49）/ typecheck 双零错 / build 成功，后端 **330 passed**（+1）/ **ruff rc=0**；桌面下载留桩 `TODO(05)`）
- [[tasks/runtime-file-transfer/05-desktop-download.md]] — 桌面端下载落盘：`reqwest` 0.12（rustls-tls，**不引 OpenSSL / aws-lc-rs**）+ `tauri-plugin-dialog` 原生「保存为」+ Rust 流式下载（同目录临时名 + `rename` 原子写）+ 进度事件（100 ms 节流）+ `cancel_download` 幂等取消 + 前端 `desktop-ipc.ts` 公共层与形态分支 + Windows 真机验证清单（**doing：2026-11-09 代码侧收口**——审查修复一轮 **9 项**；门禁 `cargo test` **47 passed**（基线 25 → +22）/ 前端 **651 passed**（基线 633 → +18）/ typecheck 双零错 / build 成功；**后端 / 核心包零改动**；**15 条 Windows 真机清单待用户执行，未验不宣称完成**）
- [[tasks/runtime-file-transfer/06-acceptance-and-docs.md]] — 验收与文档收口：Playwright 真机 spec（主链路 + 负例）+ 文档同步 + **ADR 0018 复核**（状态已是已接受，只复核不改状态） + 收口留档

## 看板
任务状态汇总见 [[current-state.md]]，由人维护。
