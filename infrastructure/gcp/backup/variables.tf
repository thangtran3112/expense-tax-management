variable "project_id" {
  type        = string
  description = "GCP project hosting the backup bucket and identities. No default -- fix round 1: a real production project ID must never be committed as a default, or an unparameterized `terraform apply` would silently target production. Operator supplies this via an untracked *.auto.tfvars file or -var."

  validation {
    condition     = length(var.project_id) > 0
    error_message = "project_id must be supplied explicitly (e.g. via an untracked terraform.tfvars); it has no default."
  }
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
  description = "Globally unique backup bucket name. No default -- same reasoning as project_id."

  validation {
    condition     = length(var.bucket_name) > 0
    error_message = "bucket_name must be supplied explicitly; it has no default."
  }
}

variable "github_repository" {
  type        = string
  description = "owner/repo whose Actions runs are allowed to assume the freshness-monitor identity. No default -- same reasoning as project_id."

  validation {
    condition     = can(regex("^[^/]+/[^/]+$", var.github_repository))
    error_message = "github_repository must be supplied explicitly as \"owner/repo\"; it has no default."
  }
}

variable "wif_pool_id" {
  type        = string
  description = "ID of the EXISTING GitHub OIDC/WIF workload identity pool (provisioned by expense-tax-management/infrastructure/gcp/expense-tax/bootstrap.sh) to attach the freshness-monitor provider to. No default -- this names a real, project-specific resource."

  validation {
    condition     = length(var.wif_pool_id) > 0
    error_message = "wif_pool_id must be supplied explicitly; it has no default."
  }
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
