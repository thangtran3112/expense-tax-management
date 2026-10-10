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
  description = "Interim hub hostname, tunneled to web:3000 and the Caddy gateway until Desk Phase 4 takes it (01l)."
  default     = "trading.tobytran.dev"
}

variable "vibe_trading_hostname" {
  type        = string
  description = "Vibe-Trading hostname."
  default     = "vibe-trading.tobytran.dev"
}

variable "terminal_hostnames" {
  type        = map(string)
  description = "Dedicated terminal hostnames, tunneled to the Caddy gateway (01l)."
  default = {
    tradingagents = "tradingagents.tobytran.dev"
    ai_hedge_fund = "ai-hedge-fund.tobytran.dev"
  }
}
