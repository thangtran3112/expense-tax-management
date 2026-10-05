output "tunnel_token" {
  description = "Connector token; becomes TUNNEL_TOKEN in cloudflared.env."
  value       = data.cloudflare_zero_trust_tunnel_cloudflared_token.ai_trading.token
  sensitive   = true
}

output "access_application_aud" {
  description = "Cloudflare Access audience tag. Release 2's API verifies it."
  value       = cloudflare_zero_trust_access_application.ai_trading.aud
}

output "hub_url" {
  value = "https://${var.hub_hostname}"
}

output "vibe_trading_url" {
  value = "https://${var.vibe_trading_hostname}"
}
