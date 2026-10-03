# VPS backup bucket and identities. See README.md for the restore
# procedure and the explicit operator steps this deliberately does NOT
# automate. NEVER run `terraform plan`/`apply` here without separate,
# explicit user approval -- `terraform fmt -check` and `terraform validate`
# are the only commands this directory's own tooling (test-policy.sh) runs.
terraform {
  required_version = ">= 1.8.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.0.0, < 7.0.0"
    }
  }

  backend "gcs" {
    prefix = "gcp/backup"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# One dedicated bucket: versioned, uniform IAM only, no public access ever,
# and a locked 7-day retention floor so even the (object-creator-only, see
# below) writer identity cannot cause an object to disappear before then.
resource "google_storage_bucket" "backup" {
  name                        = var.bucket_name
  project                     = var.project_id
  location                    = var.location
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  retention_policy {
    retention_period = 604800 # 7 days, in seconds (7 * 24 * 3600)
    is_locked        = true
  }

  # with_state = "ANY" (fix round 1, Important #7): versioning is enabled
  # above, so a deleted/replaced live object does not free its bytes --
  # it becomes a noncurrent/archived generation instead. The default
  # lifecycle condition state is LIVE only; without ANY here, an archived
  # generation past its age threshold would never actually be deleted,
  # so "daily/monthly retention" would only ever apply to the live
  # pointer, not the ciphertext bytes themselves.
  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age            = 30
      matches_prefix = ["daily/"]
      with_state     = "ANY"
    }
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age            = 365
      matches_prefix = ["monthly/"]
      with_state     = "ANY"
    }
  }
}

# The VPS-resident writer identity. Ruling: no key resource is created here
# (google_service_account_key is deliberately absent) -- the private key
# material for this account is created ONCE, by hand, with
# `gcloud iam service-accounts keys create`, and transferred directly into
# Secret Manager's shared-infrastructure bundle. Terraform state must never
# hold a credential that can create objects in this bucket. Cost if wrong:
# anyone with read access to this module's state (or its GCS backend
# bucket) gains a live backup-writer credential.
resource "google_service_account" "backup_writer" {
  project      = var.project_id
  account_id   = "expense-tax-backup-writer"
  display_name = "Expense Tax backup writer (VPS, object-creator only)"
}

resource "google_storage_bucket_iam_member" "backup_writer_creator" {
  bucket = google_storage_bucket.backup.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.backup_writer.email}"
}

# Freshness-monitor identity: separate from the writer above in every
# respect -- its own service account, its own (list-only, no
# storage.objects.get) custom role, and authenticated via GitHub Actions
# OIDC/WIF rather than any downloadable key. Reuses the EXISTING
# expense-tax-github workload identity POOL that
# expense-tax-management/infrastructure/gcp/expense-tax/bootstrap.sh
# already provisions for the deploy service account, but defines its OWN
# provider: that pool's existing "github" provider has an attributeCondition
# hard-scoped to expense-tax-deploy.yml on refs/heads/main, which would
# reject tokens minted for this freshness workflow anyway. Cost if wrong
# (i.e. if this ever diverges from the bootstrap script's pool ID): plan
# apply fails fast on a missing data source, not a silent security gap.
data "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = var.wif_pool_id
}

resource "google_iam_workload_identity_pool_provider" "backup_freshness" {
  project                            = var.project_id
  workload_identity_pool_id          = data.google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "backup-freshness"
  display_name                       = "Backup freshness monitor"

  attribute_mapping = {
    "google.subject"         = "assertion.sub"
    "attribute.repository"   = "assertion.repository"
    "attribute.workflow_ref" = "assertion.workflow_ref"
  }

  attribute_condition = "assertion.repository=='${var.github_repository}' && assertion.workflow_ref=='${var.github_repository}/${var.freshness_workflow_file}@${var.freshness_workflow_ref}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "backup_freshness_monitor" {
  project      = var.project_id
  account_id   = "expense-tax-backup-freshness"
  display_name = "Expense Tax backup freshness monitor (read-only, GitHub OIDC)"
}

resource "google_service_account_iam_member" "backup_freshness_wif_binding" {
  service_account_id = google_service_account.backup_freshness_monitor.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${data.google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

# No predefined GCS role is list-only: roles/storage.objectViewer also
# grants storage.objects.get (content download). A custom role keeps the
# freshness check to exactly what it needs -- object names, sizes, and
# update times via `storage.objects.list` -- never backup content.
resource "google_project_iam_custom_role" "backup_metadata_reader" {
  project     = var.project_id
  role_id     = "expenseTaxBackupMetadataReader"
  title       = "Expense Tax backup metadata reader"
  description = "List-only access to backup object metadata for the freshness check. Excludes storage.objects.get: cannot read or download backup content."
  permissions = ["storage.objects.list"]
}

resource "google_storage_bucket_iam_member" "backup_freshness_reader" {
  bucket = google_storage_bucket.backup.name
  role   = google_project_iam_custom_role.backup_metadata_reader.id
  member = "serviceAccount:${google_service_account.backup_freshness_monitor.email}"
}
