# ============================================================================
# 单一所有者原则（红线·勿改）
# ----------------------------------------------------------------------------
# 本文件（乃至整个 Terraform root module）**只管域名层**：
#   1. data "cloudflare_zone"             —— 按名字查 zone（只读，不创建）
#   2. resource "cloudflare_workers_custom_domain" —— 把自定义域名指向已存在的 Worker
#
# **禁止在这里声明 cloudflare_workers_script**（或任何等价物，如 workers_script
# 的 modules / assets 绑定 / 幂等的 script 资源）：
#   Worker 脚本与静态资产的唯一所有者是 **wrangler**（infra/worker/，见任务 03）。
#   两个所有者写同一份资源 ⇒ 互相覆盖 ⇒ 状态漂移：
#     - wrangler deploy 后，terraform apply 会把脚本内容回滚成 TF 状态里的旧版本；
#     - terraform apply 后，wrangler deploy 会把 TF 记录的 custom domain 之外的东西改掉；
#     - 谁都不知道线上跑的是谁的版本。
#   所以本仓库的红线是：**Terraform 永不碰脚本**。脚本 / 资产变更一律走
#   `wrangler deploy`；域名 / zone 变更一律走 `terraform apply`。
#
# 资源清单**恰为上面两项**——新增任何资源前先确认它不与 wrangler 的产物重叠。
# ============================================================================

# zone 查询（只读 data source，不创建、不修改 zone）。
# provider v5 起，zone data source 不再接受顶层 name 参数，改用 filter 参数按名字筛：
#   filter = { name = var.cloudflare_zone_name, account = { id = var.cloudflare_account_id } }
data "cloudflare_zone" "this" {
  filter = {
    name = var.cloudflare_zone_name
    # 同账号确认从「人工核对」升级为「plan 期强制」：filter.account.id 把 zone 查询
    # 限定在 var.cloudflare_account_id 这个账号下（v5 schema 支持 account = { id = ... }）。
    # zone 不在该账号下 ⇒ 查不到 zone ⇒ plan/apply 直接失败，而不是误绑到别人的 zone。
    account = {
      id = var.cloudflare_account_id
    }
  }
}

# 自定义域名绑定：把 worker_domain 指向 worker_name 这个已存在的 Worker。
# 硬约束：**script 必须在 apply 之前就存在** ⇒ 部署顺序固定为
#   wrangler deploy（先） → terraform apply（后）
#
# 属性名说明（provider v5 与 v4 的差异，此处按 pin 的 v5 写）：
#   - v4 的 `script_name` 在 v5 改名 `service`，语义相同（都是「目标 Worker 的名字」）；
#   - v5 把账号作用域下沉到资源级 ⇒ 这里要显式传 `account_id`
#     （provider 块已不再接受 account_id，见 providers.tf）。
resource "cloudflare_workers_custom_domain" "this" {
  account_id = var.cloudflare_account_id
  zone_id    = data.cloudflare_zone.this.id
  hostname   = var.worker_domain
  service    = var.worker_name
}
