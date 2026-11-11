# 控制台前端托管到 Cloudflare 任务集

本目录是**控制台前端托管到 Cloudflare（Workers + 静态资产）**轮的任务集，共 5 个任务，需求来源见 [[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]，决策依据见 [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]。

这一轮把网页控制台的前端**从后端进程里搬出去**，搬到 Cloudflare Workers + 静态资产上（域名 `dev.sankabox.com`），后端随之**纯 API 化**（删干净「托管前端」的能力链，`/api/health` 删 `console_mounted`——破坏性变更、无兼容层）。同时把**验收套件迁到独立本地静态源**，让「页面 origin ≠ 后端 origin」成为验收基线（与生产跨源形态同构），并用 **Terraform** 把 Cloudflare 域名层纳入版本管理。

**状态：01、02 done（均于 2026-11-11 收口）／ 03~05 todo**（立项日 2026-11-11）——**01 门禁全绿、四轮 e2e 全绿；02 底座落地、门禁全绿、审查零 Critical**。看板见 [[current-state.md|当前状态]]。

**关键口径（贯穿全轮）**：

| 口径 | 内容 |
|---|---|
| 载体 | **Cloudflare Workers + 静态资产**，**不是 Pages** |
| 域名 | `dev.sankabox.com` |
| 后端 | **纯 API 化**：只提供 `/api`，`GET /` 与 `/assets/*` 一律 404 |
| 健康检查 | 删 `console_mounted`（**破坏性变更，无兼容层**），字段集合恰为 `{status, version, data_root_configured}` |
| 验收形态 | 页面 origin（本地静态源）**≠** 后端 origin，**与生产同构** |
| IaC 归属 | **Terraform 只管域名层**（zone data + `workers_custom_domain`）；**脚本与资产归 `wrangler`**（单一所有者原则） |
| 部署顺序 | **`wrangler deploy` 先 → `terraform apply` 后** |
| 远端状态 | S3 兼容对象存储（MinIO），`backend "s3"` + path style + 四个 `skip_*`；**端点 / 桶 / 凭据待用户提供** |

## 任务清单

| 编号 | 任务 | 状态 | 交付内容 |
|---|---|---|---|
| [[tasks/console-cloudflare/01-backend-api-only-and-acceptance-migration.md\|01]] | 后端纯 API 化 + 验收套件迁独立静态源 | **done** | 后端删干净「托管前端」能力链（`StaticFiles` 挂载链 / `SANDBOX_CONSOLE_DIST` / `console_mounted`）+ 前端删降级分支 + **51 条验收用例迁到独立本地静态源**（页面 origin ≠ 后端 origin）+ 代码区文档同步；门禁全绿——**2026-11-11 收口**：门禁全绿、**e2e 全量四轮全绿**（53 passed / 0 failed / 0 flaky / 0 skipped），审查一轮**零 Critical**（6 条 Warning 全部修复后合入） |
| [[tasks/console-cloudflare/02-terraform-base.md\|02]] | Terraform 底座（`infra/`） | **done** | `infra/` 目录骨架（`versions.tf` / `providers.tf` / `variables.tf` / `main.tf` / `outputs.tf` / `backend.hcl.example` / `terraform.tfvars.example` / `worker/`）+ provider 精确 pin + lock 入库 + `backend "s3"` 占位齐全 + **单一所有者原则**；门禁 = `fmt -check` 无输出 + `validate` 通过——**2026-11-11 收口**：provider **5.28.1 精确 pin** + `.terraform.lock.hcl` **入库**、**`fmt -check -recursive` 无输出 + `validate` 通过**（审查修复轮复跑仍全绿）、**零凭据入库**、审查一轮**零 Critical**（**4 条 Warning 全部修复后合入**） |
| [[tasks/console-cloudflare/03-cloudflare-workers-deploy.md\|03]] | Cloudflare Workers 项目与手动部署链 | **todo** | `infra/worker/` Workers 项目（`wrangler.toml` + 极简 passthrough 脚本）+ `wrangler` 装在 `infra/worker/package.json` + `deploy` 脚本（先 build 再 deploy）+ **首次 `wrangler deploy` 成功** |
| [[tasks/console-cloudflare/04-domain-and-live-acceptance.md\|04]] | 域名绑定与公网真机验收 | **todo** | `main.tf` 落 `workers_custom_domain`（`dev.sankabox.com`）+ `terraform state list` / `plan` 核对资源清单 + **公网真机浏览器全功能验收**（八步）+ 证据留档 `RESULTS.md` |
| [[tasks/console-cloudflare/05-docs-and-adr.md\|05]] | 文档收口与 PRD 验收逐条核销 | **todo** | **复核** ADR 0019 与实际交付一致（取代关系与 0013 标注无误）+ 决策清单 / 总览 / 词汇表 / 看板 / PRD·任务清单复核 + 代码区文档同步 + **PRD 验收逐条核销挂证据** + 历史不改写清单复核 |

## 依赖顺序

```
01 ─────────────────────────┐
                            ├──▶ 05
02 ──▶ 03 ──▶ 04 ──────────┘
```

- **01 与 02 可并行**：01 动的是**后端 / 前端 / 验收套件 / 代码区文档**，02 动的是**新增的 `infra/` 目录**——**零文件重叠**，互不阻塞。
- **02 → 03 强顺序**：03 要在 Terraform 底座之上落 Workers 项目与部署链，且共用 `infra/` 的目录约定与凭据注入口径（`TF_VAR_*` / `AWS_*` / `CLOUDFLARE_API_TOKEN`）。
- **03 → 04 强顺序**：04 的 `workers_custom_domain` 要指向**一个已存在**的 Worker ⇒ **`wrangler deploy` 必须先成功**，再 `terraform apply`。
- **05 依赖 01 / 03 / 04**：文档收口要核销 PRD 的验收标准，而验收标准的证据分别来自 01（后端 / 前端 / 套件门禁）、03（首次部署成功）、04（公网真机验收）。

## 关键前置与风险

| 项 | 性质 | 影响 | 现状 |
|---|---|---|---|
| **MinIO 远端状态配置** | **阻塞 02 的 `init` / `plan`、与 03 / 04 的部署** | `terraform init` 要连 S3 兼容后端：端点 / 桶 / region / 凭据缺失则**根本起不来** | **待用户提供**（见 [[current-state.md|当前状态]] 的 TODO 段）。02 的代码骨架与门禁（`fmt` / `validate`）**已完成（02 已于 2026-11-11 收口）**，只剩**带后端的 `init` / `plan` / `apply`** 待凭据到位 |
| **Cloudflare API Token / Account ID** | 阻塞 03 / 04 的实际部署 | `wrangler deploy` 与 `terraform apply` 都要凭据 | **待用户提供**；Token **只走环境变量**，绝不入库 |
| **zone 与账号同账号确认** | 04 的 DNS 路线分叉 | 同账号 ⇒ `workers_custom_domain` 自动建 DNS 记录；**不同账号** ⇒ 改走 `routes` + 手工 record 路线并留档 | **同账号已由 plan 期强制**（`data "cloudflare_zone"` 的 `filter.account.id` 子过滤，**02 轮落地**，查不到 zone 即失败）⇒ **无需人工确认**；`infra/README.md` 的待提供清单已记该分叉 |
| **`vite preview` 在 `base: './'` 下能否冒烟** | 01 的第一步风险 | 冒烟不过则整个验收迁移的基座要换 | **已消解**（01 轮）：冒烟**一次通过**，回退方案（自写极简 Node 静态服务器，约 60 行，`node:http` + `fs` + mime 表 + SPA 回退；**不得用 `http-server`**）**未启用** |
| **`console_mounted` 是破坏性变更** | 01 的对外契约风险 | 旧前端读到 `undefined` 判「未挂载」→ 只显示降级文案、**不崩** | **接受**：先发后端、再发前端，允许**短暂不兼容窗口**；**01 轮已实际落地**（字段已删、不留兼容层） |
| **Cloudflare 与 Terraform 两个所有者** | 03 / 04 的运维风险 | 顺序错（先 `terraform apply`）⇒ 域名指向不存在的 Worker | **顺序写死**：`wrangler deploy` → `terraform apply`；`main.tf` 文件头注释写明单一所有者原则 |

## 任务文件

- [[tasks/console-cloudflare/01-backend-api-only-and-acceptance-migration.md]] — 后端纯 API 化 + 验收套件迁独立静态源（**done**：2026-11-11 收口——门禁全绿、**e2e 全量四轮全绿**、审查一轮**零 Critical**）。
- [[tasks/console-cloudflare/02-terraform-base.md]] — Terraform 底座（`infra/` 目录骨架与 `backend "s3"` 占位）（**done**：2026-11-11 收口——provider **5.28.1 精确 pin** + lock 入库、门禁全绿、**零凭据入库**、审查一轮**零 Critical**；两处施工单旧口径已在文末「进展（收口）」勘误）。
- [[tasks/console-cloudflare/03-cloudflare-workers-deploy.md]] — Cloudflare Workers 项目与手动部署链（**todo**）。
- [[tasks/console-cloudflare/04-domain-and-live-acceptance.md]] — 域名绑定与公网真机验收（**todo**）。
- [[tasks/console-cloudflare/05-docs-and-adr.md]] — 文档收口与 PRD 验收逐条核销（**todo**）。
- [[prds/console-cloudflare.md]] — **控制台前端托管到 Cloudflare PRD**（本轮需求与验收标准）。
- [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md]] — **ADR 0019 控制台前端托管到 Cloudflare Workers**（**已接受**；单向取代 ADR 0013 第 6 节，**历史表述不改写**）。
