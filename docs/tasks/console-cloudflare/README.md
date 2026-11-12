# 控制台前端托管到 Cloudflare 任务集

本目录是**控制台前端托管到 Cloudflare（Workers + 静态资产）**轮的任务集，共 5 个任务，需求来源见 [[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]，决策依据见 [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]。

这一轮把网页控制台的前端**从后端进程里搬出去**，搬到 Cloudflare Workers + 静态资产上（域名 `dev.sankabox.com`），后端随之**纯 API 化**（删干净「托管前端」的能力链，`/api/health` 删 `console_mounted`——破坏性变更、无兼容层）。同时把**验收套件迁到独立本地静态源**，让「页面 origin ≠ 后端 origin」成为验收基线（与生产跨源形态同构），并用 **Terraform** 把 Cloudflare 域名层纳入版本管理。

**状态：01~05 全部 done（2026-11-12 收口）**（立项日 2026-11-11）——**01 门禁全绿、四轮 e2e 全绿；02 底座落地、门禁全绿、审查零 Critical；03 真实部署完成**（Worker **`dev-sandbox`**、地址 **`https://dev-sandbox.nucbox.workers.dev`**、**123 资产**、版本 id **`9e12fa39-d92b-48ed-8e8a-ea6978fbb4f7`**）；**04 域名绑定 + HTTP 层验收 + 用户浏览器真机八步全部通过**（**2026-11-12 用户在真实浏览器执行，八步逐条全过；控制台无 CORS 预检失败、无混合内容告警**）；**05 文档收口 + PRD 验收逐条核销（27 / 27）**。**全轮留档见 [[tasks/console-cloudflare/RESULTS.md|控制台前端托管到 Cloudflare 全轮收口留档]]**。看板见 [[current-state.md|当前状态]]。
**2026-11-12 项目标识改定 `dev-sandbox`**（用户拍板：原名 `sandbox-console-web` 太难认）——Worker 名与地址、**远端状态对象前缀**统一，**S3 原生锁已开启**（`use_lockfile = true`），提交 **`04de972`**；**旧 Worker 与旧状态对象已清**（旧地址 **404**）。改名细节见 [[tasks/console-cloudflare/03-cloudflare-workers-deploy.md|任务 03]] 文末「改名（2026-11-12）」。

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
| 远端状态 | **真实 AWS S3**（**2026-11-11 用户改定，不再用 MinIO**）：region `ap-southeast-1`、桶 `terraform-654654240294-ap-southeast-1-an`、**AWS 默认端点**；**方案 c 已落地**（桶同账号 IAM 用户 `TerraformUser` 凭据经 `infra/.env` 注入，**未入库、未回显**）⇒ **`init` 已成功、状态对象已落 S3**（状态对象 key 与原生锁口径见下一行） |
| Worker 名 / 地址 | **`dev-sandbox`** / **`https://dev-sandbox.nucbox.workers.dev`**——**2026-11-12 改名**；原名 `sandbox-console-web` **已删**（旧地址 **404** / CF **error 1042**）；新版本 id **`9e12fa39-d92b-48ed-8e8a-ea6978fbb4f7`**、**123 资产** |
| 状态对象 / 锁 | 状态对象 = **`dev-sandbox/terraform.tfstate`**（**2026-11-12** 由 `console-cloudflare/terraform.tfstate` **服务端复制迁移**，旧前缀**已清空删除**）；**原生锁已开启**——`backend.hcl` 设 **`use_lockfile = true`**（**S3 原生锁，不依赖 DynamoDB**，需 Terraform **>= 1.10**，本机 **v1.15.8**），锁对象 **`dev-sandbox/terraform.tfstate.tflock`** **实测生成并正常释放、无残留** |

## 任务清单

| 编号 | 任务 | 状态 | 交付内容 |
|---|---|---|---|
| [[tasks/console-cloudflare/01-backend-api-only-and-acceptance-migration.md\|01]] | 后端纯 API 化 + 验收套件迁独立静态源 | **done** | 后端删干净「托管前端」能力链（`StaticFiles` 挂载链 / `SANDBOX_CONSOLE_DIST` / `console_mounted`）+ 前端删降级分支 + **51 条验收用例迁到独立本地静态源**（页面 origin ≠ 后端 origin）+ 代码区文档同步；门禁全绿——**2026-11-11 收口**：门禁全绿、**e2e 全量四轮全绿**（53 passed / 0 failed / 0 flaky / 0 skipped），审查一轮**零 Critical**（6 条 Warning 全部修复后合入） |
| [[tasks/console-cloudflare/02-terraform-base.md\|02]] | Terraform 底座（`infra/`） | **done** | `infra/` 目录骨架（`versions.tf` / `providers.tf` / `variables.tf` / `main.tf` / `outputs.tf` / `backend.hcl.example` / `terraform.tfvars.example` / `worker/`）+ provider 精确 pin + lock 入库 + `backend "s3"` 占位齐全 + **单一所有者原则**；门禁 = `fmt -check` 无输出 + `validate` 通过——**2026-11-11 收口**：provider **5.28.1 精确 pin** + `.terraform.lock.hcl` **入库**、**`fmt -check -recursive` 无输出 + `validate` 通过**（审查修复轮复跑仍全绿）、**零凭据入库**、审查一轮**零 Critical**（**4 条 Warning 全部修复后合入**） |
| [[tasks/console-cloudflare/03-cloudflare-workers-deploy.md\|03]] | Cloudflare Workers 项目与手动部署链 | **done** | `infra/worker/` Workers 项目（`wrangler.toml` + 极简 passthrough 脚本）+ `wrangler` 装在 `infra/worker/package.json` + `deploy` 脚本（先 build 再 deploy）+ **首次 `wrangler deploy` 成功**——**2026-11-11 收口**：**真实部署链四步全通**（`terraform init` → `plan` → `pnpm run deploy` → `terraform apply` 全部成功）；Worker **`sandbox-console-web`**、地址 **`https://sandbox-console-web.nucbox.workers.dev`**、**123 资产**、版本 id **`2d8b29ba-c5c7-49f3-8a06-2ede41fa9613`**；`terraform state list` **恰 2 项**、**无 `workers_script`**（单一所有者原则守住）；提交链 `43b0bba`（脚手架）→ `b779dba`（部署留痕）；**2026-11-12 改名**——Worker → **`dev-sandbox`**、地址 **`https://dev-sandbox.nucbox.workers.dev`**、版本 id **`9e12fa39-d92b-48ed-8e8a-ea6978fbb4f7`**、**123 资产**，提交 **`04de972`** |
| [[tasks/console-cloudflare/04-domain-and-live-acceptance.md\|04]] | 域名绑定与公网真机验收 | **done** | `main.tf` 落 `workers_custom_domain`（`dev.sankabox.com`）+ `terraform state list` / `plan` 核对资源清单 + **公网真机浏览器全功能验收**（八步）+ 证据留档 `RESULTS.md`——**2026-11-12 收口**：**域名绑定 + HTTP 层验收已过**（`https://dev.sankabox.com` **首探即 200**、证书即时签发、内容与 workers.dev **byte 级一致（同一 sha256）**、资产直出 **200**（`assets/index-DFpMAFde.js` 635 KB）、**非资产路径 404**）+ **用户浏览器真机八步逐条全过**（引导面板 → 填地址令牌 → 健康 ok 无降级文案 → 沙箱生命周期（终端连上敲命令、断开重连）/ 停止 / 删除 → 模板 → 文件注入 → 运行期文件面板 → 剪贴板），**控制台无 CORS 预检失败、无混合内容告警**；**本轮零代码改动、零提交**（留档落在 [[tasks/console-cloudflare/RESULTS.md\|RESULTS.md]]，非 `infra/RESULTS.md`） |
| [[tasks/console-cloudflare/05-docs-and-adr.md\|05]] | 文档收口与 PRD 验收逐条核销 | **done** | **复核** ADR 0019 与实际交付一致（取代关系与 0013 标注无误）+ 决策清单 / 总览 / 词汇表 / 看板 / PRD·任务清单复核 + 代码区文档同步 + **PRD 验收逐条核销挂证据** + 历史不改写清单复核——**2026-11-12 收口**：**PRD 验收 27 条逐条核销（27 / 27，证据分门禁数字 / 部署实证 / 用户验收 / RESULTS 指针四类）**；词汇表补三条词条、总览控制台条目补「纯 API 服务」、看板与两份清单同步、根 `README.md` 补 `infra/` 行与前端部署命令口径、**全轮留档 `RESULTS.md` 落库**；**历史不改写清单零改动**（ADR 0013 / 二期 PRD / 二期任务 01 / ADR 0018 及其任务集） |

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
| **S3 远端状态配置（跨账号 403）** | 曾阻塞 02 的 `init` / `plan`、与 03 / 04 的部署 | 指定桶属账号 `654654240294`，本机凭据原属账号 `730335648924` ⇒ 访问被拒（**403 AccessDenied**） | **已消解（2026-11-11）**——**方案 c 落地**：桶**同账号** IAM 用户 **`TerraformUser`** 凭据经 `infra/.env` 注入（**未入库、未回显**）⇒ 真实 `init` **成功**（`Successfully configured the backend "s3"`）、状态对象 `console-cloudflare/terraform.tfstate` **已落 S3**（workspace `default`）、`plan` / `apply` **均已跑通**。详见 [[tasks/console-cloudflare/03-cloudflare-workers-deploy.md\|任务 03]] 文末「部署完成（2026-11-11）」；**2026-11-12 状态对象已迁至 `dev-sandbox/terraform.tfstate`**（旧前缀已清空删除） |
| **Cloudflare API Token / Account ID** | 曾阻塞 03 / 04 的实际部署 | `wrangler deploy` 与 `terraform apply` 都要凭据 | **已到位（2026-11-11）**——Token **只走环境变量、不入库**；**`wrangler deploy` 成功**（Worker `sandbox-console-web`）、**`terraform apply` 成功**（1 added）；Account ID `c6f014ff9f682f99502c1046d5e85ca1`（非机密，已入库 `infra/worker/wrangler.toml`）；**2026-11-12 Worker 改名 `dev-sandbox` 后凭据口径不变** |
| **zone 与账号同账号确认** | 04 的 DNS 路线分叉 | 同账号 ⇒ `workers_custom_domain` 自动建 DNS 记录；**不同账号** ⇒ 改走 `routes` + 手工 record 路线并留档 | **同账号已由 plan 期强制**（`data "cloudflare_zone"` 的 `filter.account.id` 子过滤，**02 轮落地**，查不到 zone 即失败）⇒ **无需人工确认**；`infra/README.md` 的待提供清单已记该分叉 |
| **`vite preview` 在 `base: './'` 下能否冒烟** | 01 的第一步风险 | 冒烟不过则整个验收迁移的基座要换 | **已消解**（01 轮）：冒烟**一次通过**，回退方案（自写极简 Node 静态服务器，约 60 行，`node:http` + `fs` + mime 表 + SPA 回退；**不得用 `http-server`**）**未启用** |
| **`console_mounted` 是破坏性变更** | 01 的对外契约风险 | 旧前端读到 `undefined` 判「未挂载」→ 只显示降级文案、**不崩** | **接受**：先发后端、再发前端，允许**短暂不兼容窗口**；**01 轮已实际落地**（字段已删、不留兼容层） |
| **Cloudflare 与 Terraform 两个所有者** | 03 / 04 的运维风险 | 顺序错（先 `terraform apply`）⇒ 域名指向不存在的 Worker | **顺序写死**：`wrangler deploy` → `terraform apply`；`main.tf` 文件头注释写明单一所有者原则 |

## 任务文件

- [[tasks/console-cloudflare/01-backend-api-only-and-acceptance-migration.md]] — 后端纯 API 化 + 验收套件迁独立静态源（**done**：2026-11-11 收口——门禁全绿、**e2e 全量四轮全绿**、审查一轮**零 Critical**）。
- [[tasks/console-cloudflare/02-terraform-base.md]] — Terraform 底座（`infra/` 目录骨架与 `backend "s3"` 占位）（**done**：2026-11-11 收口——provider **5.28.1 精确 pin** + lock 入库、门禁全绿、**零凭据入库**、审查一轮**零 Critical**；两处施工单旧口径已在文末「进展（收口）」勘误；**增量**：状态后端改定**真实 AWS S3**，提交 `f6ab90c`，**跨账号 403 已由方案 c 解除**（见 03 轮「部署完成」与 02 轮文末「已解决」）。
- [[tasks/console-cloudflare/03-cloudflare-workers-deploy.md]] — Cloudflare Workers 项目与手动部署链（**done**：2026-11-11 收口——**真实部署链四步全通**（`init` → `plan` → `pnpm run deploy` → `terraform apply`）；Worker **`sandbox-console-web`**、地址 **`https://sandbox-console-web.nucbox.workers.dev`**、**123 资产**、版本 id `2d8b29ba-c5c7-49f3-8a06-2ede41fa9613`；`terraform state list` **恰 2 项**、**无 `workers_script`**；提交链 `43b0bba`（脚手架）→ `b779dba`（部署留痕）；**2026-11-12 改名 `dev-sandbox`**——新地址 `https://dev-sandbox.nucbox.workers.dev`、版本 id `9e12fa39-d92b-48ed-8e8a-ea6978fbb4f7`、**123 资产**、**旧 Worker 已删**、提交 `04de972`）。
- [[tasks/console-cloudflare/04-domain-and-live-acceptance.md]] — 域名绑定与公网真机验收（**done**：2026-11-12 收口——**域名绑定 + HTTP 层验收已过**（首探即 200 / 内容 byte 级一致 / 资产直出 200 / 非资产路径 404）；**用户于 2026-11-12 在真实浏览器逐条执行八步、全部通过**，**无 CORS 预检失败、无混合内容告警**；**本轮零代码改动、零提交**）。
- [[tasks/console-cloudflare/05-docs-and-adr.md]] — 文档收口与 PRD 验收逐条核销（**done**：2026-11-12 收口——**PRD 验收 27 条逐条核销（27 / 27）**；词汇表 / 总览 / 看板 / 两份清单 / 根 `README.md` 同步；**全轮留档 `RESULTS.md` 落库**；历史不改写清单**零改动**）。
- [[tasks/console-cloudflare/RESULTS.md]] — **控制台前端托管到 Cloudflare 全轮收口留档**（01~05）：轮次总表与提交链、全轮门禁数字、部署实证（Worker `dev-sandbox` / 123 资产 / 状态恒 2 项 / 原生锁实测）、**用户真机验收记录（2026-11-12 八步全过）**、**已知边界与留白 5 条**。
- [[prds/console-cloudflare.md]] — **控制台前端托管到 Cloudflare PRD**（本轮需求与验收标准）。
- [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md]] — **ADR 0019 控制台前端托管到 Cloudflare Workers**（**已接受**；单向取代 ADR 0013 第 6 节，**历史表述不改写**）。
