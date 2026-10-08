# Dedicated static bucket for MiroFish's unmodified Vue build (Task 3's
# output). Public-read-only by design (01e): it holds only built HTML/CSS/JS,
# never secrets, accounts, uploads, or portfolio data. Separate from the
# hub's own bucket (Plan A's infrastructure/gcp/ai-trading/main.tf) so a
# mistake in one upload pipeline cannot touch the other bucket's objects.

variable "mirofish_static_bucket_name" {
  type        = string
  description = "Globally unique GCS bucket name for MiroFish's static Vue build. No default -- same reasoning as the backup bucket's name variable."
}

resource "google_storage_bucket" "mirofish_static" {
  project                     = var.project_id
  name                        = var.mirofish_static_bucket_name
  location                    = "US"
  uniform_bucket_level_access = true
  force_destroy               = false

  versioning {
    enabled = true # CI restores prior object generations if post-upload verification fails.
  }

  website {
    main_page_suffix = "index.html"
    not_found_page   = "index.html" # Vue history-mode deep links (01e section 2, point 2)
  }

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "mirofish_static_public_read" {
  bucket = google_storage_bucket.mirofish_static.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

# Bucket-scoped CI identity -- narrower than the deploy service account's
# broad access, so a compromised upload step cannot read Secret Manager or
# write to any other bucket.
resource "google_service_account" "mirofish_static_uploader" {
  project      = var.project_id
  account_id   = "ai-trading-mirofish-upload"
  display_name = "ai-trading mirofish static upload (GitHub OIDC)"
}

output "mirofish_static_uploader_email" {
  value       = google_service_account.mirofish_static_uploader.email
  description = "Service account email for Task 7's authenticated MiroFish static asset upload."
}

resource "google_service_account_iam_member" "mirofish_static_uploader_wif_binding" {
  service_account_id = google_service_account.mirofish_static_uploader.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.deploy.name}/attribute.repository/${var.github_repository}"
}

resource "google_storage_bucket_iam_member" "mirofish_static_uploader_write" {
  bucket = google_storage_bucket.mirofish_static.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.mirofish_static_uploader.email}"
}

output "mirofish_bucket_name" {
  value       = google_storage_bucket.mirofish_static.name
  description = "MiroFish static bucket name. The Cloudflare Worker (infrastructure/cloudflare/ai-trading/mirofish.tf) binds its GCS backend to this value."
}
