---
prd: prds/console-cloudflare.md
status: done
---
# 任务：Cloudflare Workers 项目与手动部署链

> 需求见 [[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]，决策见 [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]。
> **本任务完成「首次部署成功」**——`workers.dev` 地址能返回控制台页面。
> **本任务已收口（done，2026-11-11）**——**真实部署链四步全通**（`terraform init` → `plan` → `pnpm run deploy` → `terraform apply`），`workers.dev` 地址返回控制台页面；下文「实施要点」是**施工单**，也是验收核对清单；**最终四步实证、产物口径与提交链见文末「部署完成（2026-11-11）」**。
> **2026-11-12 追加**：**项目标识改定 `dev-sandbox`**（Worker 名与地址、远端状态对象前缀统一，**并开启 S3 原生锁**）——详见文末「改名（2026-11-12）」。

## 目标

在 `infra/worker/` 下建 **Cloudflare Workers 项目**，接入 `wrangler`，把**手动部署链**跑通到**首次 `wrangler deploy` 成功**。

载体 = **Workers + 静态资产**（**不是 Pages**）：Worker 脚本是**纯 JS ESM 极简 passthrough**，前端构建产物由 Workers 的 `[assets]` 绑定直接服务。

## 涉及文件

```
infra/worker/
├── package.json          # wrangler 装为 devDependency + scripts
├── wrangler.toml         # name / main / compatibility_date / account_id / [assets]
└── src/
    └── index.js           # 纯 JS ESM 极简 passthrough
```

- `infra/README.md` —— **记录首次部署的账号 / Worker 名 / 地址**（本任务补写）。

## 实施要点

### `wrangler` 的位置

- **`wrangler` 装在 `infra/worker/package.json` 的 `devDependency`**；
- **不进 `apps/web/frontend` 的依赖树**——前端包的依赖树保持干净，不被部署工具污染。

### `package.json` 的 scripts

| script | 行为 | 门禁 |
|---|---|---|
| `dev` | `wrangler dev`（本地起 Worker 预览） | **不作门禁** |
| `deploy` | **先 `pnpm --dir ../../apps/web/frontend run build`，再 `wrangler deploy`** —— **一条命令**完成「构建前端 + 部署 Worker + 上传静态资产」 | **是** |
| `deploy:dry` | 干跑（不发真实部署，或用 `--dry-run`） | 否 |

> `deploy` 把前端构建**串进同一条命令**，避免出现「以为部署了新前端、其实还是旧 `dist`」的经典坑。

### `wrangler.toml`

| 键 | 值 | 说明 |
|---|---|---|
| `name` | Worker 名 | 与 04 轮 `workers_custom_domain` 的 `script_name` 对应 |
| `main` | `src/index.js` | 入口 |
| `compatibility_date` | **填当天**（2026-11-11） | Workers 运行时兼容日期 |
| `account_id` | 用户提供的 Cloudflare Account ID | **非机密，可入库** |
| `[assets].directory` | `../../apps/web/frontend/dist` | 静态资产来源 |
| `[assets].binding` | `ASSETS` | 绑定名 |
| `[assets].run_worker_first` | `false` | 资产请求**不经** Worker 函数（直出） |
| `[assets].not_found_handling` | `none` | **哈希路由不需要回退规则**（前端用 `#/sandboxes/...`） |

### `src/index.js`

- **纯 JS ESM**（无 TypeScript、无构建步骤——这个 Worker 不做逻辑，只做 passthrough）；
- **非资产路径返回 404**；
- 不写业务逻辑、不碰令牌、不代理 API——**API 一律直连后端**（跨源由后端 CORS 放行）。

### 凭据

- **API Token 只走环境变量 `CLOUDFLARE_API_TOKEN`**，**绝不入库**（不入 `wrangler.toml`、不入 `package.json`、不入任何提交物）。

## 完成标准

- [ ] `infra/worker/package.json` 存在，`wrangler` 在 **devDependency**；`apps/web/frontend` 的依赖树**未引入** wrangler。
- [ ] scripts 齐备：`dev`（不作门禁）/ `deploy`（**先 build 再 deploy，一条命令**）/ `deploy:dry`。
- [ ] `wrangler.toml` 九项齐备（`name` / `main` / `compatibility_date`=2026-11-11 / `account_id` / `[assets].directory` / `binding` / `run_worker_first=false` / `not_found_handling=none`）。
- [ ] `src/index.js` 是**纯 JS ESM 极简 passthrough**，非资产路径 **404**。
- [ ] **无 API Token 入库**（仓库内 grep `CLOUDFLARE_API_TOKEN` 只出现在文档与脚本说明里，不出现在任何取值处）。
- [ ] `infra/worker/` 有独立锁文件并入库（与前端包分离）。
- [ ] **门禁**：Terraform `fmt` / `validate` **仍过**（02 轮成果不回归）+ 前端 `build` **成功** + **`wrangler deploy` 成功**。
- [ ] `workers.dev` 地址**可访问且返回控制台页面**（不是 404、不是裸 JSON）。
- [ ] `infra/README.md` 记录**首次部署**的账号 / Worker 名 / 地址。

## 依赖

- 依赖 [[tasks/console-cloudflare/02-terraform-base.md|02 Terraform 底座]]（目录约定、凭据注入口径）。
- 下游：[[tasks/console-cloudflare/04-domain-and-live-acceptance.md|04 域名绑定与真机验收]]（04 的 `workers_custom_domain` 要指向**本轮建出来的** Worker ⇒ 部署顺序 `wrangler deploy` → `terraform apply`）。
- 决策依据：[[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]] 第 1 / 4 / 5 节。
- 需求：[[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]；任务集：[[tasks/console-cloudflare/README.md|控制台前端托管到 Cloudflare 任务集]]。

## 待用户提供（阻塞项）

> **两项均已到位（2026-11-11），本任务阻塞解除。**

- **Cloudflare API Token**（环境变量 `CLOUDFLARE_API_TOKEN` 注入）——**已到位**（**只走环境变量、不入库**）；真实 `wrangler deploy` **已成功**。
- **Cloudflare Account ID**（写进 `wrangler.toml` 的 `account_id`，非机密）——**已到位**：`c6f014ff9f682f99502c1046d5e85ca1`（2026-11-11 取得，已入库）。

---

## 进展

> **本任务状态：done（2026-11-11 收口）。** 脚手架**已落地并提交**，`wrangler deploy --dry-run` **实证通过**，其后 **Cloudflare API Token 已到位**——**真实部署链四步全通**（`terraform init` → `plan` → `pnpm run deploy` → `terraform apply` 全部成功），`workers.dev` 地址返回控制台页面。

### 脚手架完成清单

| 项 | 状态 | 内容 |
|---|---|---|
| `infra/worker/` Workers 项目 | **完成** | **`wrangler` 4.160.1**（装在 `infra/worker/package.json` 的 devDependency，**不进前端依赖树**） |
| `infra/worker/wrangler.toml` | **完成** | 含 **`account_id`**（`c6f014ff9f682f99502c1046d5e85ca1`，非机密）与 **`[assets]` 绑 `dist`**（`directory` / `binding = ASSETS` / `run_worker_first = false` / `not_found_handling = none`） |
| `infra/worker/src/index.js` | **完成** | **极简 ESM worker**（纯 JS、无构建步骤、非资产路径 404） |
| `infra/worker/pnpm-lock.yaml` | **完成** | **独立锁文件并入库**（与前端包分离） |
| `package.json` scripts | **完成** | `dev` / `deploy`（**先 build 再 deploy，一条命令**）/ `deploy:dry` |
| **零 Token 入库** | **通过** | `CLOUDFLARE_API_TOKEN` **只走环境变量**，不入 `wrangler.toml` / `package.json` / 任何提交物 |

### 实证：`wrangler deploy --dry-run` 通过

- 前端 **`build` 成功** → `wrangler deploy --dry-run` **通过**；
- **读入 125 个资产文件**（`[assets]` 绑定的 `dist` 全部被正确纳入产物）；
- **干跑不需要 API Token**（未打真实部署请求）⇒ **本地链路（构建 → 资产打包 → 产物生成）已验证通**。

### 提交

| 提交 | 内容 |
|---|---|
| `43b0bba` | **`infra/worker/` Workers 项目脚手架**：`wrangler` 4.160.1 + `wrangler.toml`（`account_id` + `[assets]` 绑 `dist`）+ 极简 ESM worker + 独立 `pnpm-lock` |
| `b779dba` | **部署留痕**：`infra/README.md` 补**首次部署记录表** + `infra/worker/README.md` 补**已部署记录**与提示「**改前端须重跑 `pnpm run deploy`**、`terraform apply` **不重传资产**」 |

### 部署完成（2026-11-11）

> **本节是收口记，不改写上文施工单与 dry-run 结论。** 部署链四步全部实证通过，**首次部署成功**这一完成标准已达成。

#### 状态后端与凭据（桶方案 c 落地）

| 项 | 口径 |
|---|---|
| 远端状态桶 | **真实 AWS S3**，桶属账号 **`654654240294`** |
| 本机凭据 | **该桶同账号**的 IAM 用户 **`TerraformUser`**（AK / SK 经 `infra/.env` 注入，**未入库、未回显**） |
| 方案 | **方案 c**（提供目标桶同账号凭据）⇒ [[current-state.md\|当前状态]] TODO 段的「跨账号 403 待拍板」**已解除** |
| 密钥卫生 | `backend.hcl` / `terraform.tfvars` / `infra/.env` **均确认 ignored 且未跟踪**（**零凭据入库**） |

#### 四步实证

| 步骤 | 结果 |
|---|---|
| `terraform init` | **成功**——`Successfully configured the backend "s3"`；远端状态对象 **`console-cloudflare/terraform.tfstate`** **已落 S3**；workspace = **`default`** |
| `terraform plan` | **恰 2 个资源**——`data "cloudflare_zone"`（**同账号**过滤命中）+ `cloudflare_workers_custom_domain`（**create**） |
| `pnpm run deploy`（前端 `build` + `wrangler deploy`） | **成功**——Worker **`sandbox-console-web`**；地址 **https://sandbox-console-web.nucbox.workers.dev**；上传 **123** 个资产；版本 id **`2d8b29ba-c5c7-49f3-8a06-2ede41fa9613`**；`HEAD` **200** |
| `terraform apply` | **成功**——**1 added**；`terraform state list` **恰 2 项**、**无 `workers_script`** ⇒ **单一所有者原则守住**（脚本与静态资产归 `wrangler`） |

#### 部署产物口径

- **Worker 名**：`sandbox-console-web`（与 `infra/variables.tf` 的 `worker_name` 默认值一致，04 轮的 `workers_custom_domain.service` 指向它）；
- **地址**：`https://sandbox-console-web.nucbox.workers.dev`——**首探即 200**、返回控制台页面（**不是 404、不是裸 JSON**）；
- **资产**：**真实部署上传 123 个**（dry-run 轮记录 125 个，**以本次真实部署的 123 个为准**）；
- **版本 id**：`2d8b29ba-c5c7-49f3-8a06-2ede41fa9613`（回滚 / 追版本的锚点）；
- **状态清单**：`terraform state list` **恰 2 项**（zone data + `workers_custom_domain`），**无 `workers_script`**。

#### 提交链

**`43b0bba`（脚手架）→ `b779dba`（部署留痕）**。

### 改名（2026-11-12）：项目标识统一为 `dev-sandbox`

> **本节为追加记，不改写上文 2026-11-11 的部署记录**——旧 Worker 名 / 旧地址 / 旧版本 id 仍是当时的实证锚点。**起因**：**用户拍板**——原 Worker 名 `sandbox-console-web` **太难认**，项目标识统一改为 **`dev-sandbox`**（状态对象前缀 + Worker 名一起改），并顺手**开启 S3 原生锁**。

| 项 | 旧值 | 新值 |
|---|---|---|
| Worker 名 | `sandbox-console-web` | **`dev-sandbox`** |
| `workers.dev` 地址 | `https://sandbox-console-web.nucbox.workers.dev` | **`https://dev-sandbox.nucbox.workers.dev`** |
| 远端状态对象 | `console-cloudflare/terraform.tfstate` | **`dev-sandbox/terraform.tfstate`** |
| 状态后端锁 | 无 | **`use_lockfile = true`**（S3 原生锁，**不依赖 DynamoDB**） |

#### 执行与实证

- **状态先搬、后改配置**：服务端 **`copy-object`** 把旧状态对象**复制**为 `dev-sandbox/terraform.tfstate`（**旧对象先当备份保留**）→ 改 `backend.hcl` 的 `key` 并加 `use_lockfile = true` → **`terraform init -reconfigure` 成功**、`terraform state list` **恰 2 项**（zone data + `workers_custom_domain`）⇒ **状态迁移无丢失**。
- **原生锁实测**：`plan` / `apply` 期间 S3 下生成 **`dev-sandbox/terraform.tfstate.tflock`**（Terraform 以 **Conditional PUT** 独占），结束后输出 `Releasing state lock...`、锁对象**正常释放、无残留**（本机 Terraform **v1.15.8**；`use_lockfile` 需 **>= 1.10**）。
- **重新部署**：`pnpm run deploy` **成功** → Worker **`dev-sandbox`**、地址 **`https://dev-sandbox.nucbox.workers.dev`**、**123 资产**、版本 id **`9e12fa39-d92b-48ed-8e8a-ea6978fbb4f7`**。
- **门禁**：`terraform fmt -check -recursive` **无输出**、`terraform validate` **通过** ⇒ 改名未引入漂移。
- **旧物已清**：旧 Worker **`sandbox-console-web` 已删**（旧地址 `GET` → **404**、Cloudflare **error code 1042**）；旧状态对象前缀 **`console-cloudflare/` 已清空并删除**。
- **顺带修正**：`terraform.tfvars.example` 里**残留的旧 Worker 名**一并改掉——**不修会覆盖默认值，把域名绑到已删的 Worker 上**。

#### 提交

| 提交 | 内容 |
|---|---|
| `04de972` | **项目标识改定 `dev-sandbox`**（**7 个文件**）：状态对象前缀（`backend.hcl` 的 `key`）、**开启 S3 原生锁**（`use_lockfile = true`）、Worker 名（`worker/wrangler.toml` 的 `name` 与 `variables.tf` 的 `worker_name` 默认值）、**顺带修正 `terraform.tfvars.example` 里的旧 Worker 名**、`infra/README.md` 补改名留档 |

#### 回滚口径

- `infra/worker/wrangler.toml` 的 `name` 与 `infra/variables.tf` 的 `worker_name` 默认值**改回旧名** → 重新 `pnpm run deploy`（旧 Worker 需先存在）；
- `backend.hcl` 的 `key` **改回** `console-cloudflare/terraform.tfstate`；
- **从新对象复制状态**（`dev-sandbox/terraform.tfstate` → 旧 key）⇒ 域名层重新 apply。

### 剩余

- **本任务剩余：零**（首次部署成功已达成）。
- **下游**：04 轮的**域名绑定与 HTTP 层验收已过**（`terraform apply` 已落 `workers_custom_domain`，`https://dev.sankabox.com` 首探即 200），**剩余 = 用户浏览器真机验收八步**——见 [[tasks/console-cloudflare/04-domain-and-live-acceptance.md|04 任务文件]] 文末「进展（2026-11-11）」；**2026-11-12 改名后域名已重绑并复验 200**——见同页文末「改名后的域名重绑与复验（2026-11-12）」。

### 相关

- 任务集索引：[[tasks/console-cloudflare/README.md|控制台前端托管到 Cloudflare 任务集]]；上游：[[tasks/console-cloudflare/02-terraform-base.md|02 Terraform 底座]]；下游：[[tasks/console-cloudflare/04-domain-and-live-acceptance.md|04 域名绑定与公网真机验收]]。
