---
prd: prds/runtime-file-transfer.md
status: todo
---
# 任务：验收与文档收口

> 需求见 [[prds/runtime-file-transfer.md|运行期文件传输 PRD]]。**依赖 03 / 04 / 05 全部就位**。
>
> **ADR 0018 的口径（2026-11-09）**：ADR 0018 已随 01 轮**落档为「已接受」**，**06 轮只复核、不改状态、不再出草案**。

## 目标

把这一轮收口：真机验收跑通、文档全库同步、**ADR 0018 定稿**、任务集留档。

## 涉及文件

- 新增 `apps/web/e2e/specs/`（或既有 spec 目录）— 真机 spec
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

- **经域名**（`sandbox-api.sankabox.com`，过 Traefik）做一次**慢速大上传**（限速使单次请求超过 60 s）→ **不再被 60 s 掐断**。**03 轮已真机验证过**（A/B：改前 **60.53 s 被 502 掐断** → 改后 **83.13 s 200 成功**、sha256 一致；落地方式为**入口点级**——Traefik v3 **没有** service 级 `serversTransport.respondingTimeouts` ⇒ 只动 `websecure` 入口点 `readTimeout=0`，`:80` / `:8080` 与其它 service / router 不动；infra 提交 `529ac29`；**勘误见 [[architecture/decisions/0018-运行期文件传输机制选型.md|ADR 0018]] §6**）——**本轮复验可直接引用 03 轮的证据**（见 [[tasks/runtime-file-transfer/03-server-file-endpoints.md|任务 03]] 的「真机验证」）。

## 文档同步清单

- [ ] `apps/web/backend/API.md` — 三端点章节与实现一致（路由 / 字段 / 错误码映射 / 认证口径 / 大小不限的口径）。
- [ ] [[conventions/console-frontend.md|前端约定]] — 两条新约定（「不加副标题 / 解释说明性文字」「操作即本体」）在册，且与实现一致。
- [ ] [[glossary.md|词汇表]] — 「运行期文件传输」词条，与「文件注入（创建时）」明确区分（通道 / 时序 / 读写方向 / 生命周期）。
- [ ] [[current-state.md|当前状态]] — 任务看板、活跃需求、TODO 段同步。
- [ ] [[prds/runtime-file-transfer.md|PRD]] — **验收清单逐条核销**（每条挂上证据锚点）。
- [ ] **ADR 0018 复核**并确认：状态已是**已接受**（01 轮落档），本轮只复核内容与实现一致，**不改状态**；决策清单登记正确。

## 完成标准

- [ ] Playwright 真机 spec 覆盖**主链路**（上传 → 容器内校验内容与属主 → 下载 → 字节比对）。
- [ ] Playwright 真机 spec 覆盖**负例**：下载目录 400 / 沙箱停止 409 / 非法路径 400。
- [ ] 质量基线全绿并记录数字：核心包 pytest + ruff；服务端 pytest + ruff；前端 vitest + typecheck + build；`cargo check` / `cargo test`；Playwright 全量。**基线参照（03 轮收口时的实测值）**：服务端 **329 passed**、核心包非 root **370 passed** / root **23 passed**（11m20s）、**ruff rc=0**。
- [ ] **200MB 级**传输的**后端内存曲线与耗时**在验收轮再留一份证据（01 轮那份是对机制，本轮是对实现）。
- [ ] **经域名（过 Traefik）的慢速大上传不再被 60 s 掐断**（**03 轮已落地并真机验证**——**入口点级**覆盖 `websecure` 的 `readTimeout=0`（v3 无 service 级 `respondingTimeouts`，勘误见 ADR 0018 §6）；A/B：改前 60.53 s 被 502 掐断 → 改后 83.13 s 200 成功、sha256 一致；本轮**复验**并把证据挂到收口留档）。
- [ ] **ADR 0018 复核通过**（机制选型 + 四条否决理由 + 覆盖 / 类型 / 路径 / 大小四条口径 + 10 条实测修正口径 + 代价），**状态维持「已接受」**（01 轮落档，06 轮不改）。
- [ ] 文档同步清单逐条完成（`API.md` / 约定 / 词汇表 / 看板 / PRD 验收清单）。
- [ ] [[tasks/runtime-file-transfer/README.md|任务集 README]] 与六个任务文件的 `status` 更新为 `done`。
- [ ] **收口留档**（`RESULTS.md`）写完：结论、验收数字、已知边界、留白项（尤其是 Windows 真机清单的验过状态）。
- [ ] **命令行零改动**、**创建时注入通道零改动**的结论在留档中写明（可与轮前行为逐项比对）。

## 依赖

- 依赖 [[tasks/runtime-file-transfer/03-server-file-endpoints.md|03]]、[[tasks/runtime-file-transfer/04-frontend-file-panel.md|04]]、[[tasks/runtime-file-transfer/05-desktop-download.md|05]] 全部就位。
- 留档体例参考 [[tasks/phase3-desktop/RESULTS.md|三期留档]]。
