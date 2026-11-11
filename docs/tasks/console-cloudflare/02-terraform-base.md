---
prd: prds/console-cloudflare.md
status: todo
---
# 任务：Terraform 底座（`infra/` 目录骨架与远端状态后端）

> 需求见 [[prds/console-cloudflare.md|控制台前端托管到 Cloudflare PRD]]，决策见 [[architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md|ADR 0019]]。
> **本任务只落底座**，不部署、不建资源——**Cloudflare 凭据与 MinIO 配置尚未到位**（见「待用户提供」清单）。

## 目标

在本仓新增 **`infra/`** 目录，搭起 Terraform 底座：目录骨架、provider 精确 pin、远端状态后端（S3 兼容对象存储 = MinIO）占位配置、变量与输出骨架、**单一所有者原则**写死在 `main.tf` 里。

**Terraform 只管域名层**（zone data + `workers_custom_domain`）；**Worker 脚本与静态资产归 `wrangler`**——两条工具链**不重叠、不互相声明对方的资源**。

## 涉及文件

新增目录 `infra/`：

```
infra/
├── README.md                  # 目录说明 / 部署顺序 / 凭据注入 / 待提供清单
├── .gitignore                 # 忽略 .terraform/、*.tfstate、*.tfvars 等
├── versions.tf                # required_version + provider 精确 pin
├── providers.tf               # provider 配置（cloudflare）
├── variables.tf               # 变量声明（api_token sensitive）
├── main.tf                    # zone data + workers_custom_domain（唯一所有者原则注释）
├── outputs.tf                 # 输出（hostname / zone_id 等）
├── backend.hcl.example        # backend "s3" 占位示例
├── terraform.tfvars.example   # 变量取值示例（全部占位、无真实凭据）
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

- `main.tf` 里只放 **`backend "s3" {}` 空块**（不写值——值在 `backend.hcl` 里）；
- **`backend.hcl.example`** 写全配置项，**值全部是占位**：

| 项 | 值 / 说明 |
|---|---|
| `bucket` | 占位（MinIO 桶名） |
| `key` | 占位，**带 workspace 前缀** |
| `region` | 占位 |
| `endpoint` | 占位（MinIO 端点 URL） |
| `use_path_style` | **`true`** —— MinIO **必须** path style，否则桶名会被当成域名的一部分 |
| `skip_credentials_validation` | `true` |
| `skip_region_validation` | `true` |
| `skip_requesting_account_id` | `true` |
| `skip_metadata_api_check` | `true` |

> **四个 `skip_*` 是 MinIO 的硬要求**：不设则 `terraform init` 会去 AWS 官方端点做凭证 / 区域 / 账号校验，直接卡住。

### 变量与凭据

- `variables.tf` **全部变量都声明**（不留隐式输入）；**`api_token` 标 `sensitive = true`**。
- **无真实凭据入库**：`terraform.tfvars.example` 里所有值都是占位。
- 凭据只走**环境变量**：`TF_VAR_<name>` 传变量值、`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 传后端凭据。

### `main.tf`（**唯一所有者原则**）

- 文件头注释写明：**TF 只管 zone data + `workers_custom_domain`；**不声明 `workers_script`**——脚本与静态资产归 `wrangler`。
- 资源清单**恰为**：
  1. `data "cloudflare_zone"`（按名字查 zone）；
  2. `resource "cloudflare_workers_custom_domain"`（`hostname` = `dev.sankabox.com`、`script_name` 指向 03 轮建的 Worker、`zone_id` 取自 data）。
- **不写 `resource "cloudflare_workers_script"`**——写进去就构成第二个所有者，脚本会被 TF 与 `wrangler` 互相覆盖。

## 完成标准

- [ ] `infra/` 目录骨架齐全（上表 10 项），文件命名与职责符合上表。
- [ ] `versions.tf`：`required_version >= 1.9`；provider **精确 pin**；`.terraform.lock.hcl` **入库**。
- [ ] `backend "s3"` 空块在位；`backend.hcl.example` **九项齐全**（bucket / key 带 workspace 前缀 / region / endpoint / **`use_path_style = true`** / 四个 `skip_*`），**值全是占位**。
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
