output "one_time_pin_idp_id" {
  description = "One-time PIN identity provider ID. Read by infrastructure/cloudflare/ai-trading via terraform_remote_state."
  value       = cloudflare_zero_trust_access_identity_provider.one_time_pin.id
}

output "team_domain" {
  description = "Zero Trust auth domain, e.g. tobytran.cloudflareaccess.com."
  value       = cloudflare_zero_trust_organization.this.auth_domain
}
