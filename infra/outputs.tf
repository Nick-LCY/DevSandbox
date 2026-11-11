# 对外输出——供人工核对「域名到底绑到了哪个 zone / 哪个 Worker」。

output "worker_name" {
  description = "绑定自定义域名的 Worker 名（由 wrangler 创建，Terraform 只引用）。"
  value       = var.worker_name
}

output "worker_domain" {
  description = "已绑定的自定义域名。"
  value       = cloudflare_workers_custom_domain.this.hostname
}

output "zone_id" {
  description = "承载该域名的 Cloudflare zone ID。"
  value       = data.cloudflare_zone.this.id
}

output "zone_name" {
  description = "承载该域名的 Cloudflare zone 名。"
  value       = data.cloudflare_zone.this.name
}
