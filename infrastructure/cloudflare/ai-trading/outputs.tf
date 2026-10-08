output "tunnel_id" {
  description = "Cloudflare tunnel ID. The deploy workflow looks up the connector token from the Cloudflare API by tunnel name, so no sensitive output is needed here."
  value       = cloudflare_zero_trust_tunnel_cloudflared.ai_trading.id
}

output "tunnel_name" {
  value = cloudflare_zero_trust_tunnel_cloudflared.ai_trading.name
}

output "hub_url" {
  value = "https://${var.hub_hostname}"
}

output "vibe_trading_url" {
  value = "https://${var.vibe_trading_hostname}"
}
