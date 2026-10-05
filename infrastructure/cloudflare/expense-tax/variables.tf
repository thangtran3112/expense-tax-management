variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID containing the Zero Trust Tunnel."
  sensitive   = true
}

# Ephemeral: never persisted in saved plans or state (Terraform >= 1.10).
variable "cloudflare_api_token" {
  type        = string
  description = "Cloudflare API token with Account Cloudflare Tunnel Edit and Zone DNS Edit."
  sensitive   = true
  ephemeral   = true
}

variable "zone_name" {
  type        = string
  description = "Cloudflare-managed DNS zone name."
  default     = "tobytran.dev"
}

variable "primary_hostname" {
  type        = string
  description = "Primary Capture application hostname."
  default     = "expense.tobytran.dev"
}

variable "api_hostname" {
  type        = string
  description = "API and webhook hostname."
  default     = "expense-api.tobytran.dev"
}

variable "capture_hostname" {
  type        = string
  description = "Capture application hostname."
  default     = "expense-capture.tobytran.dev"
}

variable "office_hostname" {
  type        = string
  description = "Office application hostname."
  default     = "expense-office.tobytran.dev"
}

variable "foundry_hostname" {
  type        = string
  description = "Foundry application hostname."
  default     = "expense-foundry.tobytran.dev"
}

variable "mailbox_hostname" {
  type        = string
  description = "Mailbox broker OAuth hostname (Phase 3D-A Task 5)."
  default     = "expense-mailbox.tobytran.dev"
}
