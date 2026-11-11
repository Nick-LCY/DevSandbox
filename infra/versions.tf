# Terraform 与 provider 版本约束。
#
# - required_version 走区间（">= 1.9, < 2.0"）：`terraform init` 会对低版本直接报错，
#   上限写 < 2.0 挡住未验证的大版本；provider 哈希由 .terraform.lock.hcl 把关。
# - provider 必须**精确 pin**（"= x.y.z"，不用 ~> / >= 浮动范围）：
#   浮动范围会让上游发新版时锁文件与实际安装版本漂移，域名层资源被静默改动。
#   （裸版本号 "5.28.1" 在 Terraform 里等价于精确匹配，这里显式写出 "=" 以对齐注释口径。）
# - 精确 pin 的同时 .terraform.lock.hcl 入库（provider 版本 + 哈希锁）。
terraform {
  required_version = ">= 1.9, < 2.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.28.1"
    }
  }

  # 远端状态后端：**AWS S3（原生，非 MinIO）**。
  # 这里只放空块——具体配置在 backend.hcl（不入库，模板见 backend.hcl.example）。
  # ⚠️ Terraform **不会自动读取** backend.hcl —— 初始化时必须显式传：
  #     terraform init -reconfigure -backend-config=backend.hcl
  backend "s3" {}
}
