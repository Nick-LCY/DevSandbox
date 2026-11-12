---
prd: prds/console-cloudflare.md
status: done
---
# 任务：Terraform 底座（`infra/` 目录骨架与远端状态后端）

> 需求见 [[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]，决策见 [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]。
> **本任务只落底座**，不部署、不建资源——**Cloudflare 凭据与 MinIO 配置尚未到位**（见「待用户提供」清单）。
> **本任务已收口（done，2026-11-11）**——底座、provider pin 与 lock、门禁、审查修复全部落地；下文的实施要点是**施工单**，也是验收核对清单；**最终门禁、审查结论、提交链与两处口径勘误见文末「进展（收口）」**。

## 目标

在本仓新增 **`infra/`** 目录，搭起 Terraform 底座：目录骨架、provider 精确 pin、远端状态后端（S3 兼容对象存储 = MinIO）占位配置、变量与输出骨架、**单一所有者原则**写死在 `main.tf` 里。

**Terraform 只管域名层**（zone data + `workers_custom_domain`）；**Worker 脚本与静态资产归 `wrangler`**——两条工具链**不重叠、不互相声明对方的资源**。

## 涉及文件

新增目录 `infra/`：

```
infra/
├── README.md                  # 目录说明 / 部署顺序 / 凭据注入 / 待提供清单
├── .gitignore                 # 忽略 .terraform/、*.tfstate、*.tfvars 等
├── versions.tf                # required_version + provider 精确 pin + backend "s3" 空块
├── providers.tf               # provider 配置（cloudflare）
├── variables.tf               # 变量声明（api_token sensitive）
├── main.tf                    # zone data + workers_custom_domain（唯一所有者原则注释）
├── outputs.tf                 # 输出（hostname / zone_id 等）
├── backend.hcl.example        # backend "s3" 配置模板（值全为占位）
├── terraform.tfvars.example   # 变量取值示例（全部占位、无真实凭据）
├── .terraform.lock.hcl        # provider 版本 + 哈希锁（**必须入库**）
└── worker/                    # Workers 项目骨架（03 轮填充）
```

## 实施要点

### 目录骨架

- **`README.md`** 写全四段：**目录说明**（每个文件干什么）/ **部署顺序**（`wrangler deploy` **先** → `terraform apply` **后**）/ **凭据注入**（`TF_VAR_*` 传变量、`AWS_*` 传后端凭据、`CLOUDFLARE_API_TOKEN` 供 `wrangler`）/ **待用户提供清单**。
- **`.gitignore`** 忽略 `.terraform/`、`*.tfstate`、`*.tfstate.*`、`*.tfvars`、`*.tfvars.json`、`.terraform.lock.hcl` **除外**（lock **必须入库**）。

### `versions.tf`

- `required_version = ">= 1.9"`；
- cloudflare provider **精确 pin**（**精确版本号**，不用 `~>` / `>=` 浮动范围）；
- **`.terraform.lock.hcl` 入库**（provider 哈希锁，防上游漂移）。

### `backend.hcl` 占位

- **`backend "s3" {}` 空块放在 `versions.tf` 的 `terraform` 块内**（不写值——值在 `backend.hcl` 里）——**勘误**：施工单原写「放在 `main.tf` 里」，实际实现按 Terraform 惯例**合并进 `versions.tf` 的 `terraform` 块**（`required_version` / `required_providers` / `backend` 同块）；
- **`backend.hcl.example`** 写全配置项，**值全部是占位**：

| 项 | 值 / 说明 |
|---|---|
| `bucket` | 占位（MinIO 桶名） |
| `key` | 占位，**字面量 `console-cloudflare/terraform.tfstate`**（**不含 `<workspace>` 占位符**）——**勘误**：施工单原写「带 workspace 前缀」，实际实现是 **key 用字面量**、workspace 隔离靠下一行的 `workspace_key_prefix` |
| `workspace_key_prefix` | **显式写死 `"envs"`**（后端默认值为 `env:`）——**前置**到 `key` **之前**（不是追加在 key 之后）；非 default workspace 的状态对象路径形如 `envs/<workspace>/console-cloudflare/terraform.tfstate` |
| `region` | 占位 |
| `endpoint` | 占位（MinIO 端点 URL） |
| `use_path_style` | **`true`** —— MinIO **必须** path style，否则桶名会被当成域名的一部分 |
| `skip_credentials_validation` | `true` |
| `skip_region_validation` | `true` |
| `skip_requesting_account_id` | `true` |
| `skip_metadata_api_check` | `true` |
| `skip_s3_checksum` | `true` —— 老版本 MinIO 不认 S3 的 `x-amz-checksum-mode` 头，会直接回 400 |

> **五个 `skip_*` 是 MinIO 的硬要求**：不设则 `terraform init` 会去 AWS 官方端点做凭证 / 区域 / 账号校验，直接卡住。

### 变量与凭据

- `variables.tf` **全部变量都声明**（不留隐式输入）；**`api_token` 标 `sensitive = true`**。
- **无真实凭据入库**：`terraform.tfvars.example` 里所有值都是占位。
- 凭据只走**环境变量**：`TF_VAR_<name>` 传变量值、`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 传后端凭据。

### `main.tf`（**唯一所有者原则**）

- 文件头注释写明：**TF 只管 zone data + `workers_custom_domain`；**不声明 `workers_script`**——脚本与静态资产归 `wrangler`。
- 资源清单**恰为**：
  1. `data "cloudflare_zone"`（按名字查 zone）；
  2. `resource "cloudflare_workers_custom_domain"`（`hostname` = `dev.sankabox.com`、`service` 指向 03 轮建的 Worker、`zone_id` 取自 data）——**勘误**：施工单原写 `script_name`，那是 provider **v4** 的字段名；本仓 pin 的是 **v5**，字段名为 **`service`**（语义相同＝目标 Worker 名）。
- **不写 `resource "cloudflare_workers_script"`**——写进去就构成第二个所有者，脚本会被 TF 与 `wrangler` 互相覆盖。

## 完成标准

- [ ] `infra/` 目录骨架齐全（上表 11 项），文件命名与职责符合上表。
- [ ] `versions.tf`：`required_version >= 1.9`；provider **精确 pin**；`.terraform.lock.hcl` **入库**。
- [ ] `backend "s3"` 空块在位（**在 `versions.tf` 的 `terraform` 块内**）；`backend.hcl.example` **配置项齐全**（bucket / key **字面量** / **`workspace_key_prefix = "envs"`** / region / endpoint / **`use_path_style = true`** / **五个 `skip_*`**，含 `skip_s3_checksum`），**值全是占位**。
- [ ] `variables.tf` 变量**全部声明**；`api_token` **`sensitive = true`**；**无真实凭据入库**。
- [ ] `main.tf` 资源清单**恰为** zone data + `workers_custom_domain`；文件头注释写明**单一所有者原则**；**无 `workers_script`**。
- [ ] `outputs.tf` 输出齐备（至少 hostname / zone_id）。
- [ ] `infra/.gitignore` 忽略 `.terraform/` / `*.tfstate` / `*.tfvars`，**且不忽略** `.terraform.lock.hcl`。
- [ ] `infra/README.md` 四段齐全（目录说明 / 部署顺序 / 凭据注入 / 待提供清单）。
- [ ] **门禁**：`terraform fmt -check -recursive` **无输出** + `terraform validate` **通过**。
- [ ] **本任务不要求 `init` / `plan` / `apply`**（凭据未到）——在任务文件里显式标注「**待用户提供**」。

## 依赖

- **无**。与 [[tasks/console-cloudflare/01-backend-api-only-and-acceptance-migration.md|01 后端纯 API 化]] **可并行**（零文件重叠）。
- 下游：[[tasks/console-cloudflare/03-cloudflare-workers-deploy.md|03 Cloudflare Workers 部署]]（依赖本任务的目录约定与凭据注入口径）。
- 决策依据：[[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]] 第 4 节（单一所有者原则、远端状态后端）。
- 需求：[[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]；任务集：[[tasks/console-cloudflare/README.md|控制台前端托管到 Cloudflare 任务集]]。

## 待用户提供（阻塞项）

- **MinIO S3 远端状态**：端点 URL / 桶名 / region / 访问凭据（→ `backend.hcl` 的 `endpoint` / `bucket` / `region` / `AWS_*`）。
- **Cloudflare**：Account ID / API Token / **zone 与账号是否同账号**（同账号 ⇒ DNS 自动创建；不同账号 ⇒ 改走 `routes` + 手工 record 路线并留档）。
- 上述未到位前，**代码骨架与 `fmt` / `validate` 门禁可先做完**；`init` / `plan` / `apply` 留待 03 / 04 轮。

---

## 进展（收口）

> **本任务状态：done（2026-11-11 收口）。** `infra/` Terraform 底座落地——**只管域名层**（`data "cloudflare_zone"` + `cloudflare_workers_custom_domain`），**全程不声明 `workers_script`**（单一所有者原则写死在 `main.tf` 文件头）；cloudflare provider **精确 pin `5.28.1`** + `.terraform.lock.hcl` **入库**；门禁全绿；审查一轮**零 Critical**、**4 条 Warning 全部修复后合入**。
> **本任务不部署、不建资源**：`terraform init`（带后端）/ `plan` / `apply` **待用户提供 MinIO 与 Cloudflare 配置后**才跑（清单见 [[current-state.md|当前状态]] 的 TODO 段与 [[tasks/console-cloudflare/README.md|任务集 README]]）。

### 交付结论

- **交付 = `infra/` Terraform 底座**（本仓新增目录）：`README.md` / `.gitignore` / `versions.tf` / `providers.tf` / `variables.tf` / `main.tf` / `outputs.tf` / `backend.hcl.example` / `terraform.tfvars.example` / `.terraform.lock.hcl` + `worker/` 骨架（03 轮填充）。
- **域名层 only**：root module 资源清单**恰为** `data "cloudflare_zone"` + `resource "cloudflare_workers_custom_domain"`——**不声明 `cloudflare_workers_script`**（Worker 脚本与静态资产归 `wrangler`），红线写死在 `main.tf` 文件头注释。
- **provider 精确 pin**：`cloudflare/cloudflare = 5.28.1`（`= x.y.z`，**不用** `~>` / `>=` 浮动范围，防上游漂移）+ `.terraform.lock.hcl` **入库**（provider 版本 + 哈希锁）。
- **零凭据入库**：`api_token` 标 `sensitive = true`，只经 `TF_VAR_cloudflare_api_token` 注入；`backend.hcl` 与真实 `*.tfvars` 均被 `.gitignore` 排除，入库的两份 `.example` **值全是占位**。
- **workspace 隔离口径**：`key` 为**字面量** `console-cloudflare/terraform.tfstate`（**不含 `<workspace>` 占位符**），隔离靠**显式** `workspace_key_prefix = "envs"`（**前置**到 key 之前）——`default` ⇒ `console-cloudflare/terraform.tfstate`；非 default ⇒ `envs/<workspace>/console-cloudflare/terraform.tfstate`。

### 门禁最终数字

| 门禁 | 结果 |
|---|---|
| `terraform init -backend=false` | **成功**——只装 provider、不连后端、**零凭据** |
| `terraform providers lock -platform=linux_amd64` | **成功**——`.terraform.lock.hcl` 生成并入库 |
| `terraform fmt -check -recursive` | **无输出**（审查修复轮复跑仍无输出） |
| `terraform validate` | **通过**（审查修复轮复跑仍通过） |

### 审查结论与修复轮

- **审查（reviewer）一轮**：**零 Critical**、**4 条 Warning** ⇒ 结论「**修复后合入**」。
- **4 条 Warning 全部修复**：

| # | Warning | 修复落点 |
|---|---|---|
| 1 | **workspace 状态路径口径**不准 | `backend.hcl.example` / `infra/README.md` 统一为「`workspace_key_prefix` **前置**到 key **之前**」，并给出 `default` 与非 default 两条实际对象路径对照 |
| 2 | **`account_id` 注入口径**不清 | `providers.tf` / `infra/README.md` 写明：**资源级 `account_id` 是 required**，provider 的 `CLOUDFLARE_ACCOUNT_ID` **不兜底** ⇒ 必须 `TF_VAR_cloudflare_account_id` 或不入库的 `terraform.tfvars` |
| 3 | **Token 权限清单缺 `DNS:Edit`** | 待提供清单补 **Zone:Read + DNS:Edit + Workers 写权限**，并建议**限定 `sankabox.com` 单 zone**（custom domain 与 zone 同账号时 Cloudflare 会代建 CNAME 记录） |
| 4 | **`infra/README.md` 断链** | 指向 ADR 0019 的引用路径修正为可点开的正确路径 |

- **provider v5 与 v4 的三处形状差异**（按 pin 的 **v5** 写，**经 provider schema 实证正确**）：① **provider 块无 `account_id`**（v5 把账号作用域下沉到**资源级**）；② `cloudflare_workers_custom_domain` 用 **`service`** 字段（v4 为 `script_name`，语义相同＝目标 Worker 名）；③ `data "cloudflare_zone"` 用 **`filter = { name = ..., account = { id = ... } }`**（v4 为顶层 `name` 参数）——其 `account` 子过滤把「zone 与账号同账号」从**人工核对**升级为 **plan 期强制**（查不到 zone 即直接失败）。

### 提交链

| 提交 | 内容 |
|---|---|
| `e408740` | **底座**：`infra/` 目录骨架 + provider 精确 pin 5.28.1 + lock 入库 + 单一所有者红线注释 |
| `62b1555` | **审查修复轮**：4 条 Warning 全部修复（workspace 路径口径 / `account_id` 注入口径 / Token 权限补 `DNS:Edit` / README 断链） |

### 与任务书的两处口径勘误

1. **`backend "s3"` 空块的位置**：施工单原写「**`main.tf` 里**只放 `backend "s3" {}` 空块」——实际实现**合并进 `versions.tf` 的 `terraform` 块**（`required_version` / `required_providers` / `backend` 同块）。
2. **`key` 的 workspace 前缀**：施工单原写「`key` 占位，**带 workspace 前缀**」——实际实现的 `key` 是**字面量** `console-cloudflare/terraform.tfstate`（**不含 `<workspace>` 占位符**），workspace 隔离靠**显式** `workspace_key_prefix = "envs"`（**前置**到 key 之前）；非 default workspace 的状态对象路径形如 `envs/<workspace>/console-cloudflare/terraform.tfstate`。

### 后续（待用户提供配置后）

- `terraform init`（带后端）/ `plan` / `apply` **一律不跑**，直到 **MinIO 端点 / 桶名 / region / AK·SK** 与 **Cloudflare Account ID / API Token** 到位（清单见 [[current-state.md|当前状态]] 的 TODO 段）——**勘误（2026-11-11）**：后端已改定为**真实 AWS S3**，本条以文末「增量（2026-11-11）」小节为准。
- **已知提示**：Terraform **1.15.8** 对 S3 后端的 `endpoint` 参数有 **deprecation 警告**（提示改用 `endpoints.s3` 块）——**待真实 `init` 时一并处理**。**勘误（2026-11-11）**：改定后**不设 `endpoint`**（走 AWS 默认端点），该警告**不再适用**。
- 下游：[[tasks/console-cloudflare/03-cloudflare-workers-deploy.md|03 Cloudflare Workers 部署]]（填 `infra/worker/` + 首次 `wrangler deploy`）→ [[tasks/console-cloudflare/04-domain-and-live-acceptance.md|04 域名绑定与公网真机验收]]（`terraform apply`）。
- 收口留档索引：[[tasks/console-cloudflare/README.md|控制台前端托管到 Cloudflare 任务集]]；决策依据：[[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]（第 4 节：单一所有者原则、远端状态后端）。

### 增量（2026-11-11）：状态后端改定真实 AWS S3

> **本节是收口后的增量记，不改写上文施工单与收口结论。** 上文「MinIO / path style / 五个 `skip_*`」是**当时的施工单口径**；**用户于 2026-11-11 改定远端状态后端 = 真实 AWS S3**，故 `backend.hcl.example` 已切 AWS 原生写法。**下文口径以本节为准。**

#### 改定事实

| 项 | 新口径（2026-11-11 改定） |
|---|---|
| 远端状态后端 | **真实 AWS S3**（**不再用 MinIO**） |
| region | `ap-southeast-1` |
| 桶 | `terraform-654654240294-ap-southeast-1-an` |
| 端点 | **AWS 默认端点**（**不设 `endpoint`**） |
| Cloudflare Account ID | `c6f014ff9f682f99502c1046d5e85ca1`（**非机密**，可入库） |
| 本机 AWS 凭据 | **已有**（`default` profile，属账号 **`730335648924`**，由 `sts get-caller-identity` **实证**） |

#### 实证与结论

- **真实 `init` 未通——因跨账号**：指定桶属账号 **`654654240294`**，而本机凭据属账号 **`730335648924`** ⇒ 访问被拒（**403 AccessDenied**）。
- **配置形状已被对照实验证明正确**：工兵用**本账号下同命名模式**的桶（`terraform-730335648924-ap-southeast-1-an`）做对照实验 ⇒ **`init` 可通**，即 `backend "s3"` 的配置形状（bucket / key / `workspace_key_prefix` / region）**无误**，**唯一变量是桶归属账号**。
- **Terraform 1.15.8 不自动读 `backend.hcl`**（实证）——须**显式传参**：`terraform init -reconfigure -backend-config=backend.hcl`。`infra/` 内的注释与 `README.md` **已按此修正**（旧口径「`init` 会自动取 `backend.hcl`」作废）。

#### 增量提交

| 提交 | 内容 |
|---|---|
| `f6ab90c` | **`backend.hcl.example` 切 AWS 原生**：**删** `endpoint` / `use_path_style` / **五个 `skip_*`**（`skip_credentials_validation` / `skip_region_validation` / `skip_requesting_account_id` / `skip_metadata_api_check` / `skip_s3_checksum`）；**保留注释掉的 MinIO 变体块**（若日后回退到 MinIO，照抄该块即可）；`infra/README.md` **同步** |

#### 待决事项

- **跨账号 403 的处置待用户拍板**——三个候选（**a / b / c**）见 [[current-state.md|当前状态]] 的 TODO 段「**S3 状态桶决策（跨账号 403）**」：
  - **a)** 改用本账号已有的 `terraform-730335648924-ap-southeast-1-an`（**已实测可 `init`**，零额外动作）；
  - **b)** 为账号 `730335648924` 授予目标桶最小权限（**限 `envs/console-cloudflare/` 前缀读写**）；
  - **c)** 提供账号 `654654240294` 的凭据。
- 在拍板前，**带后端的 `init` / `plan` / `apply` 仍不跑**（`init` 会 403）。**其余阻塞（Cloudflare API Token）见 [[current-state.md|当前状态]] 的 TODO 段**——那是 03 / 04 的**唯一硬阻塞**。

#### 已解决（2026-11-11 收口后记，**不改写上文**）

- **跨账号 403 已解除**——**用户拍板走候选 c**：提供**账号 `654654240294`** 的凭据（同账号 IAM 用户 **`TerraformUser`**，AK / SK 经 `infra/.env` 注入，**未入库、未回显**）⇒ **真实 `init` 成功**（`Successfully configured the backend "s3"`）、状态对象 `console-cloudflare/terraform.tfstate` **已落 S3**（workspace `default`）。
- **带后端的 `init` / `plan` / `apply` 均已跑通**（03 / 04 轮）——`plan` **恰 2 资源**（zone data + `workers_custom_domain`）、`apply` **1 added**、`terraform state list` **恰 2 项**、**无 `workers_script`**（单一所有者原则守住）。详见 [[tasks/console-cloudflare/03-cloudflare-workers-deploy.md|任务 03]] 文末「部署完成（2026-11-11）」。
- **上文「待决事项」与「在拍板前不跑」为当时状态，已作废**；当前状态见 [[current-state.md|当前状态]]。
