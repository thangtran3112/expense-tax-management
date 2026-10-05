variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID."
  sensitive   = true
}

variable "cloudflare_api_token" {
  type        = string
  description = "Cloudflare API token with Access, Tunnel, and DNS write permissions."
  sensitive   = true
  ephemeral   = true
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

variable "access_allowed_emails" {
  type        = list(string)
  description = "Emails allowed through Cloudflare Access. Supplied from a GitHub secret; never committed."
  sensitive   = true

  validation {
    condition     = length(var.access_allowed_emails) > 0 && alltrue([for e in var.access_allowed_emails : can(regex("^[^@\\s]+@[^@\\s]+$", e))])
    error_message = "access_allowed_emails must be a non-empty list of email addresses."
  }
}
