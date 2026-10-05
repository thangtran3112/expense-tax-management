variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID."
  sensitive   = true
}

variable "team_name" {
  type        = string
  description = "Zero Trust team name. Becomes the auth domain <team_name>.cloudflareaccess.com."
  default     = "tobytran"
}
