# Terraform 与 provider 版本约束。
#
# - required_version 走下限（>= 1.9）：`terraform init` 会对低版本直接报错，
#   上限由 .terraform.lock.hcl 里的 provider 哈希与实际运行版本把关。
# - provider 必须**精确 pin**（= x.y.z，不用 ~> / >= 浮动范围）：
#   浮动范围会让上游发新版时锁文件与实际安装版本漂移，域名层资源被静默改动。
# - 精确 pin 的同时 .terraform.lock.hcl 入库（provider 版本 + 哈希锁）。
terraform {
  required_version = ">= 1.9"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.28.1"
    }
  }
}
