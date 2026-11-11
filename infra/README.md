# infra/ —— Terraform 底座（域名层）

本目录是**控制台前端托管到 Cloudflare** 的 IaC 资产，遵循
[ADR 0019](../docs/architecture/decisions/0019-控制台前端托管到CloudflareWorkers.md) 第 4 节：
**Terraform 只管域名层，Worker 脚本与静态资产归 `wrangler`。**

- 载体：**Cloudflare Workers + 静态资产**（不是 Pages）
- 自定义域名：**`dev.sankabox.com`**
- 远端状态：**AWS S3（原生）**，区域 `ap-southeast-1`；**真实桶名 / 键等值只写在不入库的
  `backend.hcl`**（仓库里只留 `backend.hcl.example` 模板）

> **远端状态桶保持私有**：不对外公开、不开匿名读写；访问凭据用**最小权限**的 AK/SK
> （只授该桶 / 该前缀的读写权限），不复用管理员密钥。
>
> **后端 = 真实 AWS S3，不是 MinIO**：因此**不设** `endpoint` / `use_path_style` /
> 五个 `skip_*`（那些是 MinIO 兼容参数，指向 AWS 原生时既无必要、也会削弱校验）。
> 凭据走 **AWS 默认凭据链**（环境变量 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`，
> 或 `~/.aws/credentials` 里的 profile，或实例角色 / SSO）⇒ **仓库里不出现任何 AK/SK**。

---

## 1. 目录说明

| 文件 | 作用 |
|---|---|
| `versions.tf` | `required_version >= 1.9, < 2.0` + cloudflare provider **精确 pin**（`= 5.28.1`）+ `backend "s3"` 空块（远端状态后端） |
| `providers.tf` | cloudflare provider 配置（**仅用 `api_token`**，v5 **不再有 `account_id` 属性**；账号作用域下沉到资源级传） |
| `variables.tf` | 全部输入变量声明（`cloudflare_api_token` 标 `sensitive = true`，无 default） |
| `main.tf` | **唯一所有者原则红线注释** + `data "cloudflare_zone"` + `resource "cloudflare_workers_custom_domain"`（**不含 `cloudflare_workers_script`**） |
| `outputs.tf` | 输出 worker 名 / 绑定域名 / zone id / zone 名 |
| `backend.hcl.example` | 远端状态后端模板（**AWS S3 原生**：`bucket` / `key` / `region` / `workspace_key_prefix`；**不设** `endpoint` / `use_path_style` / 五个 `skip_*`——文末留了一段**注释掉的 MinIO 变体块**备查） |
| `terraform.tfvars.example` | 非敏感变量取值样例（真实 tfvars 不入库） |
| `backend.hcl` | **不入库**（`.gitignore` 已忽略）——真实 S3 桶名 / 键 / 区域等值；凭据不在其中 |
| `terraform.tfvars` | **不入库**（`.gitignore` 已忽略）——真实 `cloudflare_account_id` 等取值 |
| `.gitignore` | 忽略 `.terraform/`、`*.tfstate`、`*.tfvars`、`backend.hcl` 等；**不忽略** `.terraform.lock.hcl` |
| `.terraform.lock.hcl` | provider 版本 + 哈希锁（**入库**，防上游漂移） |
| `worker/` | Workers 项目骨架（`wrangler.toml` / `src/index.js` / `package.json` 由任务 03 填充） |

### Terraform 安装

Terraform **不入库**，本机安装即可（本机实测：`/usr/bin/terraform` = **v1.15.8**，
满足 `required_version >= 1.9, < 2.0`；registry 上游最新稳定版为 v1.17.x，升级亦满足）。

```bash
# 未安装时：从 releases.hashicorp.com 下载最新稳定版 linux_amd64 二进制装入 ~/.local/bin
# （确保 ~/.local/bin 在 PATH 里；本机 PATH 已含）
mkdir -p ~/.local/bin && cd /tmp
curl -fsSLO https://releases.hashicorp.com/terraform/<版本号>/terraform_<版本号>_linux_amd64.zip
unzip -o terraform_<版本号>_linux_amd64.zip -d ~/.local/bin
terraform version
```

### provider 版本说明

- pin 的是 registry **当时最新稳定版** `cloudflare/cloudflare = 5.28.1`（v5 大版本，
  2025-01 起即为当前主线；v4 线仍在收补丁但不再作为新代码基线）。
- **provider v5 与 v4 的三处形状差异**（本目录按 **v5** 写，与 pin 的版本一致）：
  | 项 | v4 | v5（本目录） |
  |---|---|---|
  | provider 块 | `api_token` + `account_id` | **仅用 `api_token`**（v5 **不再有 `account_id` 属性**；账号作用域下沉到资源级） |
  | `cloudflare_workers_custom_domain` | `script_name` | **`service`**（语义相同＝目标 Worker 名） |
  | `data "cloudflare_zone"` | 顶层 `name` 参数 | **`filter = { name = ..., account = { id = ... } }`**（account 子过滤 = 同账号强制校验） |
- 升级 provider 时**必须**同步核对这三处，否则 `terraform validate` 会直接报错
  （`Unsupported argument` / `Unsupported block type`）。

---

## 2. 单一所有者原则（红线）

| 资源 | 唯一所有者 | 工具 |
|---|---|---|
| Worker 脚本（`src/index.js`）、静态资产绑定 | **wrangler** | `wrangler deploy` |
| zone 查询、自定义域名绑定 | **Terraform** | `terraform apply` |

**为什么 Terraform 绝不声明 `cloudflare_workers_script`**：

- 声明了就等于给同一份 Worker 资源找了**第二个所有者**。`wrangler deploy` 与
  `terraform apply` 会互相覆盖对方的写入——脚本内容被回滚、资产绑定被重建，
  线上跑的是谁的版本没人说得清（典型症状：TF 状态里的旧脚本悄悄覆盖刚发的新版本）。
- 两个工具各自的本地状态（`.terraform/` 与 wrangler 的部署记录）各记一份，
  **漂移不可察**；出问题也难以定位是「发版顺序错了」还是「状态被人手改过」。
- Worker 脚本的发布节奏（前端产物）与域名绑定的节奏（偶尔一次）**天然不同频**，
  强行合并到一个工具里只会让两边都变难管。

**红线**：

1. Terraform root module 里的**资源清单恰为** `data "cloudflare_zone"` +
   `resource "cloudflare_workers_custom_domain"`；**不得出现 `cloudflare_workers_script`**
   或任何等价的脚本 / 资产声明。
2. **禁止用 Terraform 改脚本**——脚本与静态资产的任何变更一律走 `wrangler deploy`。
3. 反向亦然：**禁止用 `wrangler` 改域名绑定**（custom domain 只由 `terraform apply` 拥有）。
4. 破坏上述任一条的 PR 一律拒收（`main.tf` 的文件头注释是这段红线的单一事实源）。

---

## 3. 部署顺序（硬约束）

**`wrangler deploy` 先 → `terraform apply` 后。**

原因：自定义域名资源要指向一个**已经存在**的 Worker；脚本不存在时
`terraform apply` 会失败（找不到 script）。

```
1) 构建前端 + 部署 Worker + 上传静态资产     cd infra/worker && pnpm run deploy
2) 绑定自定义域名（Terraform）                  cd infra && terraform apply
```

反向顺序（先 `terraform apply`）会失败或指向不存在的 Worker，**不要尝试**。

---

## 4. 凭据注入方式（绝不入库）

| 用途 | 变量 | 环境变量 |
|---|---|---|
| Cloudflare API Token（敏感） | `var.cloudflare_api_token` | `TF_VAR_cloudflare_api_token` |
| Cloudflare Account ID | `var.cloudflare_account_id` | `TF_VAR_cloudflare_account_id`（**必填**，见下方规则） |
| 其它非敏感变量 | `var.cloudflare_zone_name` / `var.worker_name` / `var.worker_domain` | 同名 `TF_VAR_*` 或 `terraform.tfvars`（不入库） |
| 后端（**AWS S3**）访问凭据 | —— | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`（或 `~/.aws/credentials` 的 profile / 实例角色 / SSO） |
| wrangler 部署（任务 03） | —— | `CLOUDFLARE_API_TOKEN` |

```bash
export TF_VAR_cloudflare_api_token='<API Token>'
export TF_VAR_cloudflare_account_id='<Account ID>'
export AWS_ACCESS_KEY_ID='<AWS access key>'
export AWS_SECRET_ACCESS_KEY='<AWS secret key>'
```

规则：

- **API Token / AWS 凭据一律只走环境变量**（或 AWS 默认凭据链），绝不写进 `*.tfvars`、
  `backend.hcl`、`wrangler.toml` 或任何提交物；`.gitignore` 已忽略 `*.tfvars` /
  `*.tfvars.json` / `backend.hcl`。
- `cloudflare_api_token` 变量声明了 `sensitive = true`（终端输出打码）。
- `backend.hcl` **不入库**（模板是 `backend.hcl.example`；真实桶名 / 区域等值只在不入库的
  `backend.hcl` 里；**AWS 凭据一律不在其中**）。
- **`cloudflare_account_id` 必须显式注入**：它是**资源级 required 参数**
  （`cloudflare_workers_custom_domain.account_id`、`data "cloudflare_zone"` 的
  `filter.account.id` 都要它），provider 的 `CLOUDFLARE_ACCOUNT_ID` 环境变量
  **不会**兜底 ⇒ 只设 `CLOUDFLARE_ACCOUNT_ID` 而不设 `TF_VAR_cloudflare_account_id`，
  `terraform plan` 会直接报「变量未赋值」。两种方式任选其一：环境变量
  `TF_VAR_cloudflare_account_id`，或不入库的 `terraform.tfvars`。

### workspace 用法

**一句话**：本项目是「**单 root module + workspace**」——不做多环境矩阵，
用 `terraform workspace select <name>` 切换环境，对应状态对象按 `backend.hcl` 的
`workspace_key_prefix`（本项目**显式写死为 `envs`**）**前置**隔离：

| workspace | 实际状态对象路径 |
|---|---|
| `default` | `console-cloudflare/terraform.tfstate`（= `key` 本身） |
| `dev` | `envs/dev/console-cloudflare/terraform.tfstate`（= `<workspace_key_prefix>/<workspace>/<key>`） |

⚠️ **口径**：`workspace_key_prefix` 是**前置**到 `key` **之前**，**不是**追加在 key 之后；
`key` 本身**不含** `<workspace>` 占位符（字面量 `console-cloudflare/terraform.tfstate`）。

---

## 5. 待用户提供（阻塞项）

**已到位**（本轮已写入不入库的真实配置文件）：

- [x] **远端状态后端 = AWS S3**（原生，非 MinIO）——桶名 / `key` / `region` / `workspace_key_prefix`
      已写入不入库的 `infra/backend.hcl`；模板见 `backend.hcl.example`。
- [x] **Cloudflare Account ID**（非机密）——已写入不入库的 `infra/terraform.tfvars`；
      也可用环境变量 `TF_VAR_cloudflare_account_id` 注入（**必填**：资源级 `account_id` 是
      required，provider 的 `CLOUDFLARE_ACCOUNT_ID` **不兜底**）。

**仍缺**（到位前**不跑** `terraform plan` / `apply`，也不跑 `wrangler deploy`）：

### Cloudflare

- [ ] **API Token** → `TF_VAR_cloudflare_api_token`（需 **Zone 读取 + Workers 写入 + DNS:Edit**：
      custom domain 与 zone **同账号**时，Cloudflare 会代建 CNAME 记录 ⇒ 需要 **Zone → DNS → Edit**；
      token 权限范围**尽量限定到 `sankabox.com` 这一个 zone**，不要用全账号 token）
- [x] ~~确认 `sankabox.com` 这个 zone 与上述账号是否同账号~~ —— **无需人工确认**：
      `data "cloudflare_zone"` 的 `filter.account.id` 子过滤**在 plan 期强制**（查不到 zone 即失败）。
      若 plan 报 zone 查不到 ⇒ 改走 `routes` + 手工 DNS record 路线（并留档），需另行调整 `main.tf`。

### AWS（远端状态后端访问凭据）

- [x] **访问凭据** —— **本机已有**：`~/.aws/credentials` 的 `[default]` profile
      （region `ap-southeast-1`）；`aws sts get-caller-identity` **成功**（账号 `730335648924`）。
      （环境变量 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 或实例角色 / SSO 也可用。）
- [ ] **目标桶的访问授权** —— 指定的桶 `terraform-654654240294-ap-southeast-1-an` 属
      **另一个 AWS 账号（`654654240294`）**，本机凭据（账号 `730335648924`）对它**无权限**
      （`403 AccessDenied`）⇒ 二选一：
      - 改用**本账号已有的**桶 `terraform-730335648924-ap-southeast-1-an`（**已实测 `init` 成功**）；或
      - 为本机凭据（账号 `730335648924`）授予目标桶的读写权限（**最小权限**：只授该桶 / 该前缀**）。

### 其它

- [x] Worker 名确认：`sandbox-console-web`（须与任务 03 的 `infra/worker/wrangler.toml` 的
      `name` 一致）。
- [ ] 首次部署后的实际账号 / Worker 名 / `workers.dev` 地址补记到本文件（任务 03 / 04）

### 执行记录（本轮）

- **AWS 凭据检测**：本机**已有**可用 AWS 凭据（`~/.aws/credentials` 的 `[default]` profile，
  region `ap-southeast-1`），`aws sts get-caller-identity` **成功**（账号
  `730335648924`）。
- **`terraform init`（真实后端）**：已按 `backend.hcl` 跑过一次，**失败**——原文要点：
  `Failed to get existing workspaces: Unable to list objects in S3 bucket
  "terraform-654654240294-ap-southeast-1-an" with prefix "envs/": ... StatusCode: 403 ...
  api error AccessDenied: Access Denied`。
  ⇒ **桶在账号 `654654240294` 名下**，而**本机凭据属账号 `730335648924`** ⇒ 无权限。
  ⇒ 换桶名即可通：把 `backend.hcl` 的 `bucket` 改成本账号的
  `terraform-730335648924-ap-southeast-1-an`（已实测 `init` 成功：
  `Successfully configured the backend "s3"!`）。

---

## 6. 常用命令

```bash
cd infra

# 初始化（不带后端，只装 provider；门禁用，无需任何凭据）
terraform init -backend=false

# 锁 provider 哈希（linux_amd64）
terraform providers lock -platform=linux_amd64

# 门禁
terraform fmt -check -recursive   # 无输出
terraform validate                # 通过
```

真实后端初始化（**AWS S3**；需 AWS 默认凭据链可用）：

```bash
cp backend.hcl.example backend.hcl   # 填入真实值（该文件不入库）
terraform init -reconfigure -backend-config=backend.hcl   # 初始化 AWS S3 后端（不写 state）
terraform plan                       # 需 TF_VAR_cloudflare_api_token
terraform apply                      # 需 TF_VAR_cloudflare_api_token
```

> ⚠️ **Terraform 不会自动读取 `backend.hcl`**（也不自动读 `backend.tfbackend`）——
> `backend "s3" {}` 是空块时，**必须**显式传 `-backend-config=backend.hcl`，
> 否则报 `The attribute "bucket" is required by the backend.`
> （实测于本机 Terraform **v1.15.8**。）
