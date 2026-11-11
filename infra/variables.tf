# 输入变量——**全部输入都在这里声明**，不留隐式输入。
#
# 敏感值（cloudflare_api_token）只经环境变量注入：
#   export TF_VAR_cloudflare_api_token=<API Token>
# 非敏感值可以走 terraform.tfvars（.gitignore 已忽略 *.tfvars）或同名 TF_VAR_* 环境变量。

variable "cloudflare_api_token" {
  description = "Cloudflare API Token（需具备 Zone 读取与 Workers 写入权限）。敏感值——只经 TF_VAR_cloudflare_api_token 环境变量注入，绝不入库。"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare Account ID（非机密；须与创建 Worker 的账号一致）。待用户提供。"
  type        = string
}

variable "cloudflare_zone_name" {
  description = "承载自定义域名的 Cloudflare zone 名。待确认 sankabox.com 与本账号同账号（不同账号需改走 routes + 手工 DNS record 路线）。"
  type        = string
  default     = "sankabox.com"
}

variable "worker_name" {
  description = "要绑定自定义域名的 Worker 名——须与 infra/worker/wrangler.toml 的 name 一致。Worker 本身由 wrangler 创建，Terraform 只引用、不声明。"
  type        = string
  default     = "sandbox-console-web"
}

variable "worker_domain" {
  description = "Worker 绑定的自定义域名。"
  type        = string
  default     = "dev.sankabox.com"
}
