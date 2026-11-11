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
#    provider 另会读环境变量 CLOUDFLARE_ACCOUNT_ID 作兜底——本项目用
#    TF_VAR_cloudflare_account_id 注入变量，两者取其一即可。
provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
