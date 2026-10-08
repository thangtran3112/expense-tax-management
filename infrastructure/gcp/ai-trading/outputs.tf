output "deploy_workload_identity_provider" {
  value       = google_iam_workload_identity_pool_provider.deploy_github.name
  description = "Full WIF provider resource name for ai-trading-deploy.yml's google-github-actions/auth step."
}

output "terraform_workload_identity_provider" {
  value       = google_iam_workload_identity_pool_provider.terraform_github.name
  description = "Full WIF provider resource name for ai-trading-infra.yml's google-github-actions/auth step."
}

output "deploy_service_account_email" {
  value       = google_service_account.deploy.email
  description = "Service account the deploy workflow assumes via WIF."
}

output "terraform_service_account_email" {
  value       = google_service_account.terraform.email
  description = "Service account the infra (terraform) workflow assumes via WIF."
}

output "env_bundle_secret_id" {
  value       = google_secret_manager_secret.env_bundle.secret_id
  description = "Secret Manager secret ID holding the ai-trading env bundle."
}

output "project_number" {
  value       = data.google_project.this.number
  description = "Project number, used to build provider resource names elsewhere."
}
