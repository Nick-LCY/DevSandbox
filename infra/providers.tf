# Cloudflare provider 配置。
#
# 凭据只经环境变量注入，绝不入库：
#   export TF_VAR_cloudflare_api_token=<API Token>
#   export TF_VAR_cloudflare_account_id=<Account ID>
# （provider 块直接引用同名变量；敏感变量在 variables.tf 里标了 sensitive = true）
#
# ⚠️ provider v5 的形状变化：provider 块**不再接受 account_id**
#    （v4 里是 provider 级账号作用域；v5 把账号维度下沉到**资源级**）。
#    故此处只留 api_token，account_id 由 main.tf 里的资源显式传参。
#
# ⚠️ 资源级的 account_id 是 **required**（`cloudflare_workers_custom_domain` /
#    `data "cloudflare_zone"` 的 filter.account.id 都要它），**不会**回落到 provider 的
#    CLOUDFLARE_ACCOUNT_ID 环境变量兜底 ⇒ **必须**以变量注入：
#    export TF_VAR_cloudflare_account_id=<Account ID>
#    （或写进不入库的 terraform.tfvars；两种方式任选其一，**不能都不给**）。
provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
