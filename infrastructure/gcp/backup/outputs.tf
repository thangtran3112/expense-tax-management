output "bucket_name" {
  value       = google_storage_bucket.backup.name
  description = "Backup bucket name. Use for BACKUP_GCS_URI as gs://<bucket_name>."
}

output "writer_service_account_email" {
  value       = google_service_account.backup_writer.email
  description = "VPS writer identity. Its key is created manually (never via Terraform) -- see README.md."
}

output "freshness_monitor_service_account_email" {
  value       = google_service_account.backup_freshness_monitor.email
  description = "Read-only (list-only) identity GitHub Actions assumes via OIDC/WIF for the hourly freshness check."
}

output "freshness_monitor_workload_identity_provider" {
  value       = google_iam_workload_identity_pool_provider.backup_freshness.name
  description = "Full WIF provider resource name for the freshness workflow's google-github-actions/auth step."
}
