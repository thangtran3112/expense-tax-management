# Dedicated static bucket for the Trading Hub's static export (Task 1's
# `out/` directory). Public-read-only by design (01e): it holds only built
# HTML/CSS/JS, never secrets, accounts, uploads, or portfolio data. Separate
# from MiroFish's own bucket (infrastructure/gcp/ai-trading/mirofish-bucket.tf,
# owned by the sibling 01i plan) so a mistake in one upload pipeline cannot
# touch the other bucket's objects.

resource "google_storage_bucket" "hub_static" {
  project                     = var.project_id
  name                        = "tobytran-ai-trading-hub"
  location                    = "US"
  uniform_bucket_level_access = true
  force_destroy               = false # Preserve published site objects if the bucket is destroyed.

  versioning {
    enabled = true
  }

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "hub_static_public_read" {
  bucket = google_storage_bucket.hub_static.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

resource "google_service_account" "hub_static_uploader" {
  project      = var.project_id
  account_id   = "ai-trading-hub-upload"
  display_name = "ai-trading hub static upload (GitHub OIDC)"
}

resource "google_service_account_iam_member" "hub_static_uploader_wif_binding" {
  service_account_id = google_service_account.hub_static_uploader.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.deploy.name}/attribute.repository/${var.github_repository}"
}

# Dedicated bucket-scoped CI identity. The broad deploy account can read
# Secret Manager; this uploader can write only to the hub's static bucket.
resource "google_storage_bucket_iam_member" "hub_static_uploader_write" {
  bucket = google_storage_bucket.hub_static.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.hub_static_uploader.email}"
}

output "hub_bucket_name" {
  value       = google_storage_bucket.hub_static.name
  description = "Hub static bucket name. The Cloudflare Worker (infrastructure/cloudflare/ai-trading/hub-static.tf) binds its GCS backend to this value."
}

output "hub_static_uploader_email" {
  value       = google_service_account.hub_static_uploader.email
  description = "Service account email for GitHub Actions to authenticate with WIF for hub static uploads."
}
