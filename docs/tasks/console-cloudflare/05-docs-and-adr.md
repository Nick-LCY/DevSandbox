---
prd: prds/console-cloudflare.md
status: todo
---
# 任务：文档收口与 PRD 验收逐条核销

> 需求见 [[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]，决策见 [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]。
> **本任务不含 ADR 的首次落档**——ADR 0019 已随**立项**落档（2026-11-11，状态「已接受」）。本任务做的是**复核与收口**：核对 ADR 0019 与实际交付一致、取代关系与 0013 的标注无误。

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

- [ ] **复核 ADR 0019 与实际交付一致**（四条关键口径逐条比对）；状态维持「已接受」（除非有实质偏离并写明）。
- [ ] **取代关系无误**：ADR 0019 单向取代 ADR 0013 第 6 节；[[architecture/decisions/README.md|决策清单]] 的 0013 行标注到位；**ADR 0013 本体零改动**。
- [ ] [[architecture/overview.md|架构总览]] 的控制台条目补「后端纯 API 化」。
- [ ] [[glossary.md|词汇表]] 补齐**三条词条**（控制台前端托管 / Workers 静态资产 / 后端纯 API 化）。
- [ ] [[current-state.md|看板]] 同步（活跃需求 / 任务看板 / TODO）。
- [ ] [[prds/README.md|PRD 清单]] 与 [[tasks/README.md|任务清单]] 复核无误。
- [ ] 仓库根 `README.md`：目录结构表补 `infra/` 行 + 控制台章节前端托管行改写 + 前端部署命令口径。
- [ ] `apps/web/frontend/README.md` 补 CF 形态与 `wrangler deploy`。
- [ ] `infra/README.md` 复核（部署顺序 / 凭据注入 / 待提供清单状态）。
- [ ] **PRD 验收标准逐条核销**并挂证据；未核销条目写明原因。
- [ ] **历史不改写清单复核**：ADR 0013 本体、二期 PRD、二期任务 01、ADR 0018 及其任务集 —— 全部**零改动**。

## 依赖

- 依赖 [[tasks/console-cloudflare/01-backend-api-only-and-acceptance-migration.md|01 后端纯 API 化]]（后端 / 前端 / 套件门禁证据）、[[tasks/console-cloudflare/03-cloudflare-workers-deploy.md|03 Workers 部署]]（首次部署证据）、[[tasks/console-cloudflare/04-domain-and-live-acceptance.md|04 域名与真机验收]]（公网验收证据）。
- 决策依据：[[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]。
- 需求：[[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]；任务集：[[tasks/console-cloudflare/README.md|控制台前端托管到 Cloudflare 任务集]]。
