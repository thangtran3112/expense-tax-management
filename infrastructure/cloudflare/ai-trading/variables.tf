variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID."
  sensitive   = true
}

variable "zone_name" {
  type        = string
  description = "Cloudflare-managed DNS zone name."
  default     = "tobytran.dev"
}

variable "hub_hostname" {
  type        = string
  description = "Trading Hub hostname (hub web app and browser terminals)."
  default     = "trading.tobytran.dev"
}

variable "vibe_trading_hostname" {
  type        = string
  description = "Vibe-Trading hostname."
  default     = "vibe-trading.tobytran.dev"
}
