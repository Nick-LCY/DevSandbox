---
prd: prds/console-cloudflare.md
status: done
---
# 任务：文档收口与 PRD 验收逐条核销

> 需求见 [[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]，决策见 [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]。
> **本任务不含 ADR 的首次落档**——ADR 0019 已随**立项**落档（2026-11-11，状态「已接受」）。本任务做的是**复核与收口**：核对 ADR 0019 与实际交付一致、取代关系与 0013 的标注无误。
> **本任务已收口（done，2026-11-12）**——ADR 0019 复核通过（**状态维持「已接受」**）、**取代关系无误**、文档库与代码区文档全量同步、**PRD 验收标准 27 条逐条核销（27 / 27）**、**全轮留档 `RESULTS.md` 落库**；**历史不改写清单零改动**。各项落点见文末「进展（收口，2026-11-12）」。

## 目标

把全库文档收口，并**逐条核销** PRD 的验收标准（挂证据）。

**注意**：ADR 0019 **本次立项时已落档**（见 [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]），因此本任务的完成标准是「**复核 ADR 0019 与实际交付一致、取代关系与 0013 标注无误**」，**不再含首次落档**。

## 涉及文件

### 文档库（`docs/`）

- `docs/architecture/decisions/README.md` — **复核**（0019 行已在册；核对 0013 行的「CF 托管条目已由 0019 重启」标注）。
- `docs/architecture/overview.md` — 控制台条目补「**后端纯 API 化**」。
- `docs/glossary.md` — 补**三条词条**：控制台前端托管 / Workers 静态资产 / 后端纯 API 化。
- `docs/current-state.md` — 看板状态更新（活跃需求 / 任务看板 / TODO）。
- `docs/prds/README.md`、`docs/tasks/README.md` — 清单复核。
- `docs/prds/console-cloudflare.md` — **验收标准逐条核销**（勾选 + 挂证据）。

### 代码区文档

- 仓库根 `README.md` — **目录结构表补 `infra/` 行** + 控制台章节「前端托管」行改写 + **前端部署命令口径**（`wrangler deploy`）。
- `apps/web/frontend/README.md` — 补 **CF 形态**说明与 **`wrangler deploy`** 命令口径。
- `infra/README.md` — 复核（部署顺序 / 凭据注入 / 待提供清单是否已清空）。

## 实施要点

### ADR 0019 复核（**替代「首次落档」**）

- **状态维持「已接受」**——本轮**不改状态**（若实现与决策有实质偏离，才走修订并写明偏离）；
- 复核四条关键口径与实际交付是否一致：
  1. 载体 = Workers + 静态资产（**不是 Pages**）；
  2. 域名 = `dev.sankabox.com`；
  3. 后端纯 API 化 + `console_mounted` 删字段（**破坏性变更、无兼容层**）；
  4. **单一所有者原则**（TF 只管域名层，不声明 `workers_script`）+ 部署顺序 `wrangler deploy` → `terraform apply`。
- 复核**取代关系**的表述：ADR 0019 **单向取代** ADR 0013 第 6 节；**ADR 0013 本体一个字都不改**（历史表述不改写，只在决策清单的 0013 行加标注）。

### 词汇表三条词条

| 词条 | 要点 |
|---|---|
| **控制台前端托管** | 前端构建产物由 **Cloudflare Workers + 静态资产**承载（**不是 Pages**），域名 `dev.sankabox.com`；与「后端纯 API 化」成对使用 |
| **Workers 静态资产** | Workers 的 `[assets]` 绑定把构建产物直接作为静态资源服务（`run_worker_first=false`、`not_found_handling=none`）；**脚本与资产归 `wrangler`**，Terraform 不声明 `workers_script` |
| **后端纯 API 化** | 控制台服务**只提供 `/api`**，不再托管静态资源；`/api/health` 删 `console_mounted`（**破坏性变更、无兼容层**）；`GET /` 与 `/assets/*` 返回 404 |

### 看板更新

- **活跃需求**：本轮条目（立项日 2026-11-11、五个任务状态、PRD / 任务集 / ADR 0019 指针）；
- **任务看板**：新增一行（状态随实际推进更新）；
- **TODO / 阻塞**：**清零或改写**——「待用户提供 MinIO / Cloudflare 凭据」这条若已闭合就删掉，若未闭合就保留并更新措辞。

### 代码区文档同步

- 仓库根 `README.md` 的**目录结构表**补 `infra/` 行（与 `apps/` 同级的 IaC 目录）；
- 控制台章节的「前端托管」行改写为「前端由 Cloudflare Workers 托管（`dev.sankabox.com`），后端只提供 `/api`」；
- **前端部署命令口径**：`wrangler deploy`（或 `infra/worker` 的 `pnpm run deploy`），并写明**先于** `terraform apply`；
- 前端 `README.md` 补 **CF 形态**（同一份 `dist` 在 CF 与任意静态源都可用）与 `wrangler deploy` 命令。

### PRD 验收逐条核销

把 [[prds/console-cloudflare.md|PRD]] 的「验收标准」逐条勾选，**每条挂证据**（门禁数字、命令输出、留档文件路径、验收步骤结果）。**未核销的条目要写明原因**，不许留空勾。

### 历史不改写清单复核

- [[architecture/decisions/0013-三期定位改定与认证重启.md|ADR 0013]] 本体 —— **不改**；
- [[prds/phase2-console.md|二期 PRD]] —— **不改**；
- [[tasks/phase2-console/01-service-core-api.md|二期任务 01]] —— **不改**；
- [[architecture/decisions/0018-运行期文件传输机制选型.md|ADR 0018]] 及其任务集 —— **本轮零改动**。

## 完成标准

- [x] **复核 ADR 0019 与实际交付一致**（四条关键口径逐条比对）；状态维持「已接受」（除非有实质偏离并写明）——**四条逐条比对均一致，无实质偏离**（对比表见文末「进展（收口）」第一节）。
- [x] **取代关系无误**：ADR 0019 单向取代 ADR 0013 第 6 节；[[architecture/decisions/README.md|决策清单]] 的 0013 行标注到位；**ADR 0013 本体零改动**（仅**追加指向性标注**，历史表述一字未改）。
- [x] [[architecture/overview.md|架构总览]] 的控制台条目补「后端纯 API 化」——**已补**「纯 API 服务：不再托管前端（前端托管于 Cloudflare Workers，见 ADR 0019）」，并**顺带补 0019 行**进「关键决策」表。
- [x] [[glossary.md|词汇表]] 补齐**三条词条**（控制台前端托管 / Workers 静态资产 / 后端纯 API 化）——**已补**（新建「控制台前端托管（Cloudflare 轮）」小节）。
- [x] [[current-state.md|看板]] 同步（活跃需求 / 任务看板 / TODO）——**已同步**：活跃需求改「完整收口口径」、任务看板 **done**、TODO 段删「浏览器真机验收」条目并新增两条**不阻断待用户动作**。
- [x] [[prds/README.md|PRD 清单]] 与 [[tasks/README.md|任务清单]] 复核无误——**已复核**：PRD 清单本轮条目**已在册**（无需改）；任务清单已补 01~05 状态、**RESULTS 指针**与 02 / 03 行的**改名指针**。
- [x] 仓库根 `README.md`：目录结构表补 `infra/` 行 + 控制台章节前端托管行改写 + 前端部署命令口径——**已补**：目录结构表新增 `infra/` 行；控制台章节新增「前端部署到 Cloudflare（`infra/`）」段（**顺序为硬约束** + 凭据走 `infra/.env`）。
- [x] `apps/web/frontend/README.md` 补 CF 形态与 `wrangler deploy`——**已补**「生产形态：Cloudflare Workers 托管」小节。
- [x] `infra/README.md` 复核（部署顺序 / 凭据注入 / 待提供清单状态）——**复核通过**：部署顺序（第 3 节，硬约束）、凭据注入（第 4 节）、待提供清单（第 5 节）**全部已到位、勾选框全为已勾**。
- [x] **PRD 验收标准逐条核销**并挂证据；未核销条目写明原因——**已核销 27 条（27 / 27）**；证据分**门禁数字 / 部署实证 / 用户验收 / RESULTS 指针**四类；**唯一偏离条目**（远端状态后端）按实际核销并注明（属**增强**）。
- [x] **历史不改写清单复核**：ADR 0013 本体、二期 PRD、二期任务 01、ADR 0018 及其任务集 —— 全部**零改动**。

## 依赖

- 依赖 [[tasks/console-cloudflare/01-backend-api-only-and-acceptance-migration.md|01 后端纯 API 化]]（后端 / 前端 / 套件门禁证据）、[[tasks/console-cloudflare/03-cloudflare-workers-deploy.md|03 Workers 部署]]（首次部署证据）、[[tasks/console-cloudflare/04-domain-and-live-acceptance.md|04 域名与真机验收]]（公网验收证据）。
- 决策依据：[[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]。
- 需求：[[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]；任务集：[[tasks/console-cloudflare/README.md|控制台前端托管到 Cloudflare 任务集]]。

---

## 进展（收口，2026-11-12）

> **本任务状态：done（2026-11-12 收口）。** 文档库与代码区文档全量同步、**PRD 验收 27 条逐条核销**、**全轮留档落库**；**历史不改写清单零改动**。**本轮零代码改动**（只改文档）。

### 一、ADR 0019 复核：四条关键口径逐条比对

| # | ADR 0019 的口径 | 实际交付 | 结论 |
|---|---|---|---|
| 1 | 载体 = **Workers + 静态资产**（**不是 Pages**）；域名 `dev.sankabox.com` | Worker **`dev-sandbox`**（`infra/worker/wrangler.toml`）、`[assets]` 绑 `dist`、`run_worker_first = false`、`not_found_handling = none`；域名 **`dev.sankabox.com`** 已绑、**200** | **一致** |
| 2 | 后端**纯 API 化**；`/api/health` 删 `console_mounted`（**破坏性变更、无兼容层**） | 删干净「托管前端」能力链；`GET /` 与 `/assets/*` 一律 **404**；health 字段集合恰为 `{status, version, data_root_configured}`（集合断言钉死） | **一致** |
| 3 | 验收套件迁**独立本地静态源**（页面 origin ≠ 后端 origin） | `vite preview --host 127.0.0.1 --strictPort`；`global-setup` 交叉断言 origin 不等即抛错；用例 51 → **53** | **一致** |
| 4 | **单一所有者原则**（TF 只管域名层、**不声明 `workers_script`**）+ 部署顺序 `wrangler deploy` → `terraform apply` | `terraform state list` **恒 2 项**、**无 `workers_script`**；部署链四步实证、顺序写死在 `infra/README.md` 第 3 节 | **一致** |

- **状态维持「已接受」**——四条口径**无实质偏离**，**不改状态、不走修订**。
- **远端状态后端的口径差异**已在 ADR 0019 的既有两条更新记中处理（MinIO → 真实 AWS S3 → 跨账号 403 已解除），**正文不改写**；本轮**只追加第三条更新记**（标识改定 `dev-sandbox` + 原生锁）。

### 二、各项落点

| 项 | 落点 |
|---|---|
| **ADR 0019 复核** | 上文第一节（四条口径逐条比对）；**状态维持「已接受」** |
| **ADR 0019 更新记** | 文末追加「标识改定 `dev-sandbox` + 原生锁（2026-11-12）」一条 |
| **取代关系** | ADR 0019 **单向取代** 0013 第 6 节；[[architecture/decisions/README.md|决策清单]] 的 0013 行标注**已在册**；**ADR 0013 本体历史表述零改动**（仅追加指向性标注） |
| **架构总览** | [[architecture/overview.md|总览]]「控制台服务（二期）」条目补「**纯 API 服务：不再托管前端（前端托管于 Cloudflare Workers，见 ADR 0019）**」；**「关键决策」表补 0019 行** |
| **词汇表** | [[glossary.md|词汇表]] 新增「**控制台前端托管（Cloudflare 轮）**」小节，三条词条：**控制台前端托管** / **Workers 静态资产** / **后端纯 API 化** |
| **看板** | [[current-state.md|看板]]：活跃需求改「**完整收口口径**（01~05 全部 done、2026-11-12 用户验收通过、RESULTS 指针）」；任务看板行 → **done**；TODO 段**删**「浏览器真机验收」条目、**新增**两条**不阻断待用户动作**（宿主后端择机更新 / 桌面端重打包）、**阻塞项：无** |
| **PRD 清单 / 任务清单** | [[prds/README.md|PRD 清单]]：本轮条目**已在册**（复核通过、零改动）；[[tasks/README.md|任务清单]]：01~05 状态更新为 **done**、**新增 RESULTS 指针行**、02 / 03 行补「**2026-11-12 起标识改定 `dev-sandbox`，见 RESULTS**」 |
| **PRD 核销** | [[prds/console-cloudflare.md|PRD]]「验收标准」**27 条逐条勾选并挂证据（27 / 27）**；偏离条目（远端状态后端）**按实际核销并注明属增强** |
| **仓库根 `README.md`** | 目录结构表**新增 `infra/` 行**；控制台章节新增「**前端部署到 Cloudflare（`infra/`）**」段——**顺序为硬约束**（`pnpm run deploy` 于 `infra/worker` → `terraform apply` 于 `infra`，**须 `-backend-config=backend.hcl`**）+ **凭据走 `infra/.env` 环境变量、不入库** |
| **前端 `README.md`** | 「构建」节下新增「**生产形态：Cloudflare Workers 托管**」小节（`cd infra/worker && pnpm run deploy` = build + `wrangler deploy`） |
| **`infra/README.md`** | **复核通过**——部署顺序（第 3 节）/ 凭据注入（第 4 节）/ 待提供清单（第 5 节，**全部已到位**） |
| **全轮留档** | **新建** [[tasks/console-cloudflare/RESULTS.md|控制台前端托管到 Cloudflare 全轮收口留档]]（轮次总表 / 门禁数字 / 部署实证 / 真机验收记录 / 已知边界与留白 / 提交链） |
| **历史不改写** | [[architecture/decisions/0013-三期定位改定与认证重启.md|ADR 0013]]（**仅追加指向性标注**）、[[prds/phase2-console.md|二期 PRD]]、[[tasks/phase2-console/01-service-core-api.md|二期任务 01]]、[[architecture/decisions/0018-运行期文件传输机制选型.md|ADR 0018]] 及其任务集 —— **零改动** |

### 三、与任务书的偏离（如实登记）

1. **留档位置**：04 任务施工单原写「证据留档在 `infra/RESULTS.md`」——**实际未在 `infra/` 建该文件**，留档统一落在 [[tasks/console-cloudflare/RESULTS.md|docs/tasks/console-cloudflare/RESULTS.md]]。**理由**：`infra/` 是 IaC 代码目录，**不放验收叙事**；部署与改名记录仍留在 `infra/README.md`。
2. **PRD「远端状态后端」条目按实际核销**：原口径（占位 + 跨账号 403 待拍板）**已被实际交付超越**——真实 `backend.hcl` **落本机不入库**、**AWS 原生**、**S3 原生锁已开**（`use_lockfile = true`）；**按实际核销并注明属增强**，PRD 正文不改。
3. **总览「关键决策」表补 0019 行**：任务书只要求改控制台服务条目——**顺带补行**（该表原本缺 0019，补后与决策清单一致）。

### 四、收口结论

- **本任务状态：todo → done（2026-11-12）**——**全轮 01~05 全部 done**，**无遗留开口**。
- **代码改动：零**（本轮只改文档）。
- **留档指针**：全轮留档见 [[tasks/console-cloudflare/RESULTS.md|RESULTS.md]]；PRD 核销见 [[prds/console-cloudflare.md|PRD]]「验收标准」。
