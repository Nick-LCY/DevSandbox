---
prd: prds/phase3-desktop.md
status: done
---
# 任务：验收回归与文档收口

## 目标

把三期整体收口：跑齐全部质量基线确认无回归，补齐转发与认证的真机验收用例，把三篇决策记录归档，并同步看板、词汇表、架构总览、前端约定、接口文档与工程说明。

## 涉及文件

- 新增 / 改 `apps/web/frontend/tests/specs/` — 端口转发与连接配置的验收用例
- 改 `docs/architecture/decisions/README.md` — 0013 / 0014 / 0015 入清单表
- 改 `docs/architecture/README.md` — 0013 / 0014 / 0015 入清单表
- 改 `docs/architecture/overview.md` — 关键决策表 + 核心模块（「连接层与认证」「端口转发」「桌面端」三条）
- 改 `docs/glossary.md` — 新增术语（端口转发、访问令牌、连接配置、转发容器、桌面端）
- 改 `docs/conventions/console-frontend.md` — 「连接配置与请求基址」「端口转发」两节
- 改 `docs/current-state.md` — 规划段（「前后端分离部署」标注被吸收 / Cloudflare 退役）、任务看板、TODO
- 改 `docs/prds/README.md` — 三期 PRD 入清单
- 改 `docs/tasks/README.md` — 三期任务集入清单
- 改 `apps/web/backend/API.md` — 认证章节 + 端口转发接口章节（若 02 / 05 未写完则在此补齐）
- 改 `apps/web/frontend/README.md` — 连接配置、转发界面、标识表、接口一览
- 改 `README.md`（仓库根）— 目录结构加 `apps/desktop/`、认证与令牌说明、非回环监听口径改写
- 改 `apps/web/backend/sandbox-console.service` — 令牌相关注释

## 实施步骤

1. **质量基线**：核心包 pytest（含 `-m root`）、服务端 pytest、ruff（`E4/E7/E9/F`）、前端 vitest / typecheck / typecheck:tests / build 全绿。
2. **真机回归**：既有 9 条 spec + 新增的认证用例（`10-auth-connection.spec.ts`）+ 端口转发用例（转发建立 → 桌面端开启 → 本机访问 → 停止 → 沙箱删除后回收）全绿。
3. **三篇 ADR**：按仓库模板写全六段（日期、状态、背景、决策、影响、相关决策），文件名 `0013-三期定位改定与认证重启.md`、`0014-端口转发机制选型.md`、`0015-桌面壳与连接配置抽象.md`。
4. **清单同步**：三篇 ADR 登记进 `docs/architecture/decisions/README.md` 与 `docs/architecture/README.md` 两张表；PRD 与任务集登记进对应清单；看板、词汇表、总览、约定、API.md、两个 README 同步到位。
5. **留档**：`docs/tasks/phase3-desktop/RESULTS.md` 记实测数字（各套测试条数、真机用例数、Windows 冒烟结论）。
6. **仓库卫生自查**：本轮新增文件里 grep 不到个人家目录路径与个人专属内容。

## 完成标准

- [x] 核心包 pytest（含 root 级用例）、服务端 pytest、ruff 全绿。**（数字引自各任务当轮门禁留档，不是收口轮重跑：核心包 292 passed（含 root 级用例）/ 服务端 289 passed / ruff（`E4/E7/E9/F`）0 错 / 分层契约 10 passed——见 [[tasks/phase3-desktop/04-port-forward-core.md|04]] 与 [[tasks/phase3-desktop/05-port-forward-server-api.md|05]]；收口轮起后端与核心包零改动。）**
- [x] 前端 vitest、typecheck、typecheck:tests、build 全绿。**（引自 2026-11-04 端口转发区 UI 重构轮：vitest 585 passed / typecheck 双零错 / build 过；其后前端只新增了验收 spec，产品源码零改动。）**
- [x] Playwright 真机用例全绿（既有 9 条 + 认证用例 + 端口转发用例）。**（**48 passed / 0 failed / 0 flaky**，约 9.3 分钟，含前端构建与真机沙箱，**连续两轮全绿**；此前基线 46 条无回归。端口转发用例以 `11-forward-web-notice.spec.ts` 的 2 条 web 形态用例落库——**桌面形态的完整管理要 Tauri IPC，Playwright 覆盖不到**，已由 Windows 真机验收替代。）**
- [x] 三篇决策记录按仓库模板写全并登记进两张清单表。**（ADR 0013 / 0014 / 0015 **期中随决策产生时已落档**——非本任务新写；六段（日期 / 状态 / 背景 / 决策 / 影响 / 相关决策）齐全，已登记进 `docs/architecture/decisions/README.md` 与 `docs/architecture/README.md` 两张清单表。）**
- [x] `docs/current-state.md` 更新：规划段三条方向全部收敛（「前后端分离部署」标注被三期吸收、Cloudflare 静态托管退役、三期任务集挂行）、TODO 段落登记本期明确不做的非目标。**（规划段：留的两条方向均为三期之后、**未立项**；「前后端分离部署」已并入三期、Cloudflare 静态托管已随 [[architecture/decisions/0013-三期定位改定与认证重启.md|0013]] 退役；三期任务集已挂行并于 2026-11-04 收口。本期非目标清单落在 [[prds/phase3-desktop.md|三期 PRD]] 的「非目标」一节（不承诺 Linux / macOS 打包、Cloudflare 静态托管退役、不做 web 形态端口访问、不改命令行等），看板 TODO 段保留的是与三期无关的存量待办。）**
- [x] `docs/glossary.md` 补齐新术语，并保持「端口转发 ≠ URL 代理」的区分。**（三期新词已齐：桌面端 / 连接配置 / 请求基址 / 未配置态 / 动态 CSP / 访问令牌 / 一次性票据 / 准入边界 / 端口转发 / 转发容器——本轮核对后**补录「隧道」一条**；「端口转发 ≠ URL 代理」的显式区分在「URL 代理」条与「端口转发」条各有一句。）**
- [x] `docs/architecture/overview.md` 的核心模块与关键决策表补齐；ADR 0009 的认证裁剪在总览里标注为已被 0013 推翻。**（「三期规划中的新模块」三条（连接层与认证 / 端口转发 / 桌面端）齐备；关键决策表含 0001~0015；0009 的「不做认证」裁剪在「控制台服务（二期）」核心模块条目与 0013 的决策表行都标了被推翻。）**
- [x] `docs/conventions/console-frontend.md` 补「连接配置与请求基址」「端口转发」两节。**（「端口转发」一节已在（且已随 UI 重构轮同步到五列表格口径）；「**连接配置与请求基址**」一节本轮核对发现缺失，**已补写**。）**
- [x] `apps/web/backend/API.md` 与两个 README 同步本轮改动。**（API.md 第 14 章「认证（访问令牌 / 一次性票据 / 跨源放行）」与第 15 章「端口转发接口（转发管理 REST + 隧道 WebSocket）」均在（02 / 05 轮写入）；`apps/web/frontend/README.md` 有「连接配置」「端口转发」两节与 `page-forward-*` 标识表；仓库根 `README.md` 有令牌 / 跨源口径与 API.md 第 14 章指引。**遗留已闭合（2026-11-04）**：根 README 的「目录结构」表**已补上 `apps/desktop/` 行**（并行改动完成，核销前已核对到位）——本条曾登记的遗留（`docs/` 之外、09 轮按约束未改）随之闭合，对应 PRD 验收清单的唯一留白条已补勾。）**
- [x] `docs/tasks/phase3-desktop/RESULTS.md` 留档实测数字与已知边界。**（本轮回填：Playwright 48 passed / 0 failed / 0 flaky（约 9.3 分钟，连续两轮全绿）与新增 spec 的覆盖口径。）**
- [x] 仓库卫生自查通过。**（`docs/` 全量 grep 无个人家目录路径与个人专属内容——仅打样探针账号 `fwdprobe` 的路径留档，属可复跑的探针环境记录。）**

## 依赖

- 依赖 [[tasks/phase3-desktop/01-prototype-and-spike.md|01]] ~ [[tasks/phase3-desktop/08-windows-package.md|08]] 全部就位。
- 决策记录模板与清单体例见 [[architecture/decisions/README.md|架构决策记录索引]]；看板体例见 [[current-state.md|当前状态]]。

## 收口（2026-11-04）

- **全量验收回归**：`pnpm run test:acceptance`（Playwright，串行，含前端构建 + 真机沙箱 + 固定测试令牌）——**48 passed / 0 failed / 0 flaky，约 9.3 分钟**，**连续两轮全绿**；此前基线 46 条（07 轮）**无回归**。
- **新增用例**：`tests/specs/11-forward-web-notice.spec.ts` **2 条**，钉死 web 形态端口转发区的行为——① 端口转发区**只有说明卡 + 「安装桌面端」入口**（文案写明「网页形态无法管理端口转发」），**零管理元素**（表格 / 行 / 新建表单 / 「转发」按钮一个都不渲染），且**不发 `/api/forwards` 请求**（跨过一个合并轮询周期仍为零）；② 安装指引弹窗**三步齐全**（拿安装包 / 填后端地址与令牌 / 开启转发后访问）且能关闭。
- **端口转发用例的覆盖口径**：**桌面形态的完整管理 Playwright 覆盖不到**（要 Tauri IPC），**已由 Windows 真机验收替代**（[[tasks/phase3-desktop/06-port-forward-desktop.md|06 真机连通]] + [[tasks/phase3-desktop/08-windows-package.md|08 冒烟]]）；web 形态的「零管理 + 不发转发请求」由上述 2 条钉死。
- **三篇 ADR**：[[architecture/decisions/0013-三期定位改定与认证重启.md|0013]]、[[architecture/decisions/0014-端口转发机制选型.md|0014]]、[[architecture/decisions/0015-桌面壳与连接配置抽象.md|0015]] **期中随决策产生即已落档**（非本任务新写），六段齐全，已登记进两张清单表。
- **文档核对结论**：

| 文档 | 核对结论 |
|---|---|
| [[glossary.md\|词汇表]] | 三期新词齐备（桌面端 / 连接配置 / 请求基址 / 未配置态 / 动态 CSP / 访问令牌 / 一次性票据 / 准入边界 / 端口转发 / 转发容器）；本轮**补录「隧道」一条** |
| [[architecture/overview.md\|架构总览]] | 三期三条核心模块（连接层与认证 / 端口转发 / 桌面端）+ 0001~0015 关键决策表齐备；0009 的认证裁剪已标注被 0013 推翻 |
| [[conventions/console-frontend.md\|前端约定]] | 「端口转发」一节已同步到五列表格口径；「**连接配置与请求基址**」一节**本轮补写** |
| `apps/web/backend/API.md` | 第 14 章（认证）+ 第 15 章（端口转发接口）均在，无需补写 |
| [[current-state.md\|看板]] / [[tasks/phase3-desktop/README.md\|任务集]] / [[tasks/phase3-desktop/RESULTS.md\|留档]] / [[tasks/README.md\|任务索引]] | 同步到 48 / 0 failed 与「三期整体 done（2026-11-04）」 |

- **三期整体闭合声明**：**三期（桌面端打包 + 端口转发 + 连接层认证）全部交付**——01~09 九个任务全部 done（打样 / 后端认证 / 前端连接层 / 转发核心包 / 转发服务端 / 转发桌面侧 / 验收套件 token 化 / Windows 打包冒烟 / 收口），**三期任务集整体状态 done（2026-11-04）**。三期之后未立项的方向见 [[current-state.md|看板]] 的「规划」段。
- **状态**：todo → done。
