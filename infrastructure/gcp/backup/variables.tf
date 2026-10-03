variable "project_id" {
  type        = string
  description = "GCP project hosting the backup bucket and identities."
  default     = "expense-tax-tobytran-2026"
}

variable "region" {
  type        = string
  description = "Region for regional resources (service accounts are global; kept for provider defaults)."
  default     = "us-central1"
}

variable "location" {
  type        = string
  description = "Bucket location. A US multi-region, per the plan's 'selected US GCP location'."
  default     = "US"
}

variable "bucket_name" {
  type        = string
  description = "Globally unique backup bucket name."
  default     = "expense-tax-tobytran-2026-backups"
}

variable "github_repository" {
  type        = string
  description = "owner/repo whose Actions runs are allowed to assume the freshness-monitor identity."
  default     = "thangtran3112/family-app"
}

variable "freshness_workflow_file" {
  type        = string
  description = "Workflow file the freshness-monitor WIF provider's attribute condition is scoped to."
  default     = ".github/workflows/family-backup-freshness.yml"
}

variable "freshness_workflow_ref" {
  type        = string
  description = "Git ref the freshness-monitor WIF provider's attribute condition is scoped to."
  default     = "refs/heads/main"
}
