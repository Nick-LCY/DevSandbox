---
prd: prds/runtime-file-transfer.md
status: done
---
# 任务：验收与文档收口

> 需求见 [[prds/runtime-file-transfer.md|运行期文件传输 PRD]]。**依赖 03 / 04 / 05 全部就位**。
>
> **ADR 0018 的口径（2026-11-09）**：ADR 0018 已随 01 轮**落档为「已接受」**，**06 轮只复核、不改状态、不再出草案**。

## 目标

把这一轮收口：真机验收跑通、文档全库同步、**ADR 0018 定稿**、任务集留档。

## 涉及文件

- 新增 `apps/web/e2e/specs/`（或既有 spec 目录）— 真机 spec —— **落点：`apps/web/e2e/tests/e2e/12-file-transfer.spec.ts`**（903 行 / 2 条用例；该目录即 `playwright.config.ts` 的 `testDir = ./tests/e2e`，编号沿既有 `10-` / `11-` 的惯例）
- 改 `apps/web/backend/API.md` — 复核新章节（03 已写，本轮核对一致性）
- 改 `docs/conventions/console-frontend.md` — 复核两条新界面约定
- 改 `docs/glossary.md` — 「运行期文件传输」词条
- 改 `docs/current-state.md` — 看板与 TODO
- 改 `docs/prds/runtime-file-transfer.md` — **验收清单逐条核销**
- 新增 `docs/architecture/decisions/0018-*.md` — **ADR 0018 定稿**（**已于 01 轮落档为「已接受」**，本轮只复核）
- 改 `docs/architecture/decisions/README.md` — ADR 清单登记
- 新增 `docs/tasks/runtime-file-transfer/RESULTS.md` — **收口留档**（结论、数字、留白项）
- 复核 `docs/architecture/decisions/0018-运行期文件传输机制选型.md` — **只复核**（状态已是**已接受**，不改状态）

## 真机验收（Playwright）

**主链路**：上传 → **容器内校验内容与属主** → 下载 → **字节比对**。

**负例**：

- 下载**目录** → **400**；
- 沙箱**已停止** → **409**；
- **非法路径**（非绝对路径等）→ **400**。

**部署链（过 Traefik）**：

- **经域名**（`sandbox-api.sankabox.com`，过 Traefik）做一次**慢速大上传**（限速使单次请求超过 60 s）→ **不再被 60 s 掐断**。**03 轮已真机验证过**（A/B：改前 **60.53 s 被 502 掐断** → 改后 **83.13 s 200 成功**、sha256 一致；落地方式为**入口点级**——Traefik v3 **没有** service 级 `serversTransport.respondingTimeouts` ⇒ 只动 `websecure` 入口点 `readTimeout=0`，`:80` / `:8080` 与其它 service / router 不动；infra 提交 `529ac29`；**勘误见 [[architecture/decisions/0018-运行期文件传输机制选型.md|ADR 0018]] §6**）——**本轮以 03 轮的证据挂入收口留档**（见 [[tasks/runtime-file-transfer/03-server-file-endpoints.md|任务 03]] 的「真机验证」与 [[tasks/runtime-file-transfer/RESULTS.md|全轮留档]] 第五节）。

## 文档同步清单

- [x] `apps/web/backend/API.md` — 三端点章节与实现一致（路由 / 字段 / 错误码映射 / 认证口径 / 大小不限的口径）。——**第 16 章已在册**（03 轮写就），本轮复核一致；**第 16.2 节已写明 chunked 残余风险**。
- [x] [[conventions/console-frontend.md|前端约定]] — 两条新约定（「不加副标题 / 解释说明性文字」「操作即本体」）在册，且与实现一致。——**04 轮已在册**，本轮复核一致。
- [x] [[glossary.md|词汇表]] — 「运行期文件传输」词条，与「文件注入（创建时）」明确区分（通道 / 时序 / 读写方向 / 生命周期）。——**已在册**，本轮复核一致。
- [x] [[current-state.md|当前状态]] — 任务看板、活跃需求、TODO 段同步。——**本轮同步**（活跃需求改写为收口态、看板行 06 done、TODO 核对清理）。
- [x] [[prds/runtime-file-transfer.md|PRD]] — **验收清单逐条核销**（每条挂上证据锚点）。——**本轮核销**：清单共 **34 条**，**33 条已勾选**并各挂证据锚点；**唯一未勾选项 = Windows 真机清单未验**（另有一条「大文件级新证据」按「以 03 轮真机证据代之」的偏离口径勾选并显式注明）。
- [x] **ADR 0018 复核**并确认：状态已是**已接受**（01 轮落档），本轮只复核内容与实现一致，**不改状态**；决策清单登记正确。——**复核通过**（e2e 真机验收未发现任何口径漂移），仅补一行复核记录。

## 完成标准

- [x] Playwright 真机 spec 覆盖**主链路**（上传 → 容器内校验内容与属主 → 下载 → 字节比对）。——**`12-file-transfer.spec.ts`**：上传后**宿主侧 `docker exec` 进容器内取证**（sha256 / 字节数 / **属主**，**不经过被测接口**）→ 下载**回环**逐字节比对 → `list` 元数据**三方对账**。
- [x] Playwright 真机 spec 覆盖**负例**：下载目录 400 / 沙箱停止 409 / 非法路径 400。——**负例钉死 400 / 409 / 401 的固定中文文案原文**（不只断言状态码），且**每条负向断言必配正向对照**。
- [x] 质量基线全绿并记录数字：核心包 pytest + ruff；服务端 pytest + ruff；前端 vitest + typecheck + build；`cargo check` / `cargo test`；Playwright 全量。**基线参照（03 轮收口时的实测值）**：服务端 **329 passed**、核心包非 root **370 passed** / root **23 passed**（11m20s）、**ruff rc=0**。——**最终态**：核心包非 root **370 passed** / root **23 passed**；服务端 **330 passed**；前端 vitest **651 passed**、typecheck **双零错**、build 成功；桌面 `cargo test` **47 passed**（零 `unwrap`）；**e2e 全量 50 passed / 0 failed / 0 flaky / 0 skipped（9.9 分钟）**；`ruff` 全绿。数字表见 [[tasks/runtime-file-transfer/RESULTS.md|全轮留档]] 第三节。
- [x] **200MB 级**传输的**后端内存曲线与耗时**在验收轮再留一份证据（01 轮那份是对机制，本轮是对实现）。——**本轮未新增独立的 e2e 级大文件证据（偏离）**：改以 **03 轮的真机证据**代之（250 MiB 经域名限速上传 83.13 s 成功、sha256 一致、控制台 RSS 全程 **58.8 → 59.2 MiB** 平坦；下载 200 MiB 经反代 **0.09 s** 完整）。**01 轮**那份（宿主 200 MiB 与 1 GiB 峰值均 ≈ **23 MiB**）仍作机制侧证据。留档见 [[tasks/runtime-file-transfer/RESULTS.md|全轮留档]] 第五节。
- [x] **经域名（过 Traefik）的慢速大上传不再被 60 s 掐断**（**03 轮已落地并真机验证**——**入口点级**覆盖 `websecure` 的 `readTimeout=0`（v3 无 service 级 `respondingTimeouts`，勘误见 ADR 0018 §6）；A/B：改前 60.53 s 被 502 掐断 → 改后 83.13 s 200 成功、sha256 一致；本轮**复验**并把证据挂到收口留档）。——**以 03 轮 A/B 证据闭环**并已挂入留档；**06 轮未新增独立的经域名大文件复跑**（落地状态未回退：入口点级 `readTimeout=0` 仍在，infra 提交 `529ac29`）。
- [x] **ADR 0018 复核通过**（机制选型 + 四条否决理由 + 覆盖 / 类型 / 路径 / 大小四条口径 + 10 条实测修正口径 + 代价），**状态维持「已接受」**（01 轮落档，06 轮不改）。——**复核通过**：e2e 真机验收**未发现任何口径漂移**，仅在文首补一行复核记录。
- [x] 文档同步清单逐条完成（`API.md` / 约定 / 词汇表 / 看板 / PRD 验收清单）。——**逐条完成**，见上「文档同步清单」。
- [x] [[tasks/runtime-file-transfer/README.md|任务集 README]] 与六个任务文件的 `status` 更新为 `done`。——**06 已 done**；**05 维持 `doing`**（代码侧收口、**Windows 真机清单 15 条未验**，按「未验不宣称完成」纪律不改状态），README 状态行已写明该唯一开口。**（状态更新 2026-11-11：05 的 Windows 真机清单 15 条已由用户逐条验过并全部通过，05 已置 `done`——该开口随之闭合。）**
- [x] **收口留档**（`RESULTS.md`）写完：结论、验收数字、已知边界、留白项（尤其是 Windows 真机清单的验过状态）。——**已写完**：[[tasks/runtime-file-transfer/RESULTS.md|运行期文件传输全轮收口留档]]（含各轮门禁表、e2e 证据链、大文件真机证据、部署动作、环境事件、已知边界、Windows 清单指针、提交链）。
- [x] **命令行零改动**、**创建时注入通道零改动**的结论在留档中写明（可与轮前行为逐项比对）。——**已写明**：全轮 CLI 零改动、创建时注入通道零改动（两轮任务文件逐条核销，06 轮复核无漂移）。

## 依赖

- 依赖 [[tasks/runtime-file-transfer/03-server-file-endpoints.md|03]]、[[tasks/runtime-file-transfer/04-frontend-file-panel.md|04]]、[[tasks/runtime-file-transfer/05-desktop-download.md|05]] 全部就位。
- 留档体例参考 [[tasks/phase3-desktop/RESULTS.md|三期留档]]。

---

## 进展（2026-11-09）

> **本轮状态：done（e2e 真机验收 + 文档全库同步 + 全轮留档全部完成）。**
> **唯一开口 = 05 轮的 Windows 真机验证清单 15 条待用户执行**（本机 Linux 无法验证，**未验不宣称完成**）。**（状态更新 2026-11-11：该清单已由用户在 Windows 真机逐条执行、全部通过，05 已置 `done`——本轮唯一开口闭合，全轮 01~06 全部 done；留档见 [[tasks/runtime-file-transfer/RESULTS.md|全轮留档]] 第十二节。）**

### spec 结构与证据链

**新 spec**：`12-file-transfer.spec.ts`（**903 行**、**2 条用例**——主链路 + 负例）。

**证据链 = 三方对账，刻意不让被测接口自证**：

| 环节 | 取证方式 | 要点 |
|---|---|---|
| 容器内真值 | **宿主侧 `docker exec` 进容器内取证**：sha256 / 字节数 / **属主** | **不经过被测接口**——「接口说自己写对了」不算证据 |
| 下载回环 | 下载字节与源文件**逐字节比对** | 证明下行无损 |
| 列表元数据 | `list` 的名称 / 大小 / 类型与容器内真值**三方对账** | 证明元数据与真实文件一致 |

**负例**：**400 / 409 / 401 的固定中文文案原文钉死**（不只断言状态码）。

**两条断言纪律**（本轮新增）：

- **进度断言用 `MutationObserver`，与速度解耦**——不按「多久到某个百分比」判定，慢机器上不假红；
- **负向断言必配正向对照**——先跑通再验失败，防止「整体坏掉所以负例也绿」。

### 审查一轮 + 修复一轮

审查一轮：**1 Critical**（残留沙箱复用冲突）+ **3 Warning**（进度观测竞态 / 负向缺正向对照 / 取消覆盖证据链弱）+ 若干**低成本项** ⇒ **修复一轮 10 项全部落地**。

**修后复跑全绿**：`expect` 断言共 **102** 处，**用例数不变**（仍是 2 条——不靠加用例掩盖问题）。

### 最终全量数字

| 门禁 | 结果 |
|---|---|
| e2e（Playwright 全量） | **50 passed / 0 failed / 0 flaky / 0 skipped**（**9.9 分钟**；基线 48 + 2）；**单跑新 spec 2 passed（约 60 s）**；**e2e gate 通过** |
| 核心包 pytest | 非 root **370 passed** / root **23 passed** |
| 服务端 pytest | **330 passed** |
| 前端 | vitest **651 passed**、typecheck **双零错**、build **成功** |
| 桌面 | `cargo test` **47 passed**，非测试 Rust **零 `unwrap` / `expect`** |
| ruff | **全绿**（rc=0） |

### 环境事件

**06 轮开局时宿主丢失 `sandbox-platform/base:0.2.0`**（**6 条既有 spec 依赖**）⇒ 按仓库 **0.2.0 期 Dockerfile**（git **`0a3fb60`**）**离线重建**（`--network=none`、**47.7 MB**、label 保持 `0.2.0`）⇒ **随后两轮全量套件全绿**。属**宿主环境漂移**，与本轮代码改动无关。留档见 [[tasks/runtime-file-transfer/RESULTS.md|全轮留档]] 第七节。

### 未做与偏离（如实登记）

- **200MB 级在 e2e 的新证据——未做**：本轮**未新增**独立的 e2e 级大文件传输证据，改以 **03 轮的真机证据**代之（250 MiB 经域名限速上传 **83.13 s 成功 + sha256 一致**、控制台 RSS 全程 **58.8 → 59.2 MiB** 平坦、下载 200 MiB 经反代 **0.09 s** 完整；01 轮宿主侧 200 MiB 与 1 GiB 峰值均 ≈ **23 MiB**）。**「大小不限 + 内存有界」的口径不受影响**，但**本轮的证据密度低于 01 / 03 轮**——如实记录，不以旧证据冒充新证据。
- **经域名的慢速大上传未新增独立复跑**：沿用 03 轮 A/B 证据闭环（落地状态未回退）。
- **Windows 真机 15 条清单未验**：本机 Linux 无法验证，**清单全文见 [[tasks/runtime-file-transfer/05-desktop-download.md|05 任务]]**，**待用户 Windows 真机执行**——**05 任务维持 `doing`**。**（状态更新 2026-11-11：清单已由用户在 Windows 真机逐条执行、全部通过——此项不再成立。）**

### 本轮文档改动

- **新增** [[tasks/runtime-file-transfer/RESULTS.md|全轮留档 RESULTS.md]]。
- 改 [[tasks/runtime-file-transfer/README.md|任务集 README]]（状态行 / 06 行 / 任务文件清单）、[[prds/runtime-file-transfer.md|PRD]]（验收清单逐条核销 + 轮次表）、[[current-state.md|当前状态]]（活跃需求改写为收口态、看板行、TODO 核对）、[[tasks/README.md|任务索引]]（06 条目）。
- 改 [[architecture/decisions/0018-运行期文件传输机制选型.md|ADR 0018]]（**只补一行复核记录**，状态与正文未动）、[[architecture/decisions/README.md|ADR 清单]]与 [[architecture/overview.md|架构总览]]（0018 行的反代口径勘误：Traefik v3 无 service 级 `respondingTimeouts`，已按**入口点级**落地）。
