variable "project_id" {
  type        = string
  description = "GCP project hosting ai-trading's Secret Manager bundle and GitHub OIDC identities."
  default     = "tobytran-portfolio"
}

variable "state_bucket" {
  type        = string
  description = "GCS bucket holding Terraform state, granted to the terraform identity as object admin."
  default     = "tobytran-portfolio-tfstate"
}

variable "github_repository" {
  type        = string
  description = "owner/repo whose GitHub Actions runs are trusted by the deploy and terraform WIF providers."
  default     = "thangtran3112/family-app"
}

variable "github_environment" {
  type        = string
  description = "GitHub Actions environment name required by both WIF provider attribute conditions."
  default     = "ai-trading-production"
}
