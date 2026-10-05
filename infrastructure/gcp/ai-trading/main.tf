# ai-trading GCP identity: Secret Manager bundle, workload identity pools,
# and the service accounts the deploy and terraform GitHub Actions workflows
# assume via OIDC. Operator-applied; see README.md. NEVER run `terraform
# apply` here without separate, explicit user approval -- `init
# -backend=false`, `fmt -check`, and `validate` are the only commands this
# task's own verification runs.
terraform {
  required_version = ">= 1.8.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.0.0, < 8.0.0"
    }
  }

  backend "gcs" {
    prefix = "gcp/ai-trading"
  }
}

provider "google" {
  project = var.project_id
}

data "google_project" "this" {
  project_id = var.project_id
}

locals {
  deploy_workflow_ref    = "${var.github_repository}/.github/workflows/ai-trading-deploy.yml@refs/heads/main"
  terraform_workflow_ref = "${var.github_repository}/.github/workflows/ai-trading-infra.yml@refs/heads/main"

  # Shared by both providers: repository, the main branch, the exact
  # workflow_ref, and the production environment -- see AGENTS.md and the
  # plan's Global Constraints. Only the workflow_ref differs between them.
  attribute_mapping = {
    "google.subject"         = "assertion.sub"
    "attribute.repository"   = "assertion.repository"
    "attribute.ref"          = "assertion.ref"
    "attribute.workflow_ref" = "assertion.workflow_ref"
    "attribute.environment"  = "assertion.environment"
  }
}

resource "google_project_service" "apis" {
  for_each = toset([
    "secretmanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "cloudresourcemanager.googleapis.com",
  ])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# --- Secret Manager bundle --------------------------------------------------

resource "google_secret_manager_secret" "env_bundle" {
  project   = var.project_id
  secret_id = "ai-trading-env-bundle"

  labels = {
    app        = "ai-trading"
    versioning = "single"
  }

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

# --- Workload identity: deploy (ai-trading-deploy.yml) ----------------------

resource "google_iam_workload_identity_pool" "deploy" {
  project                   = var.project_id
  workload_identity_pool_id = "ai-trading-deploy"
  display_name              = "ai-trading deploy"

  depends_on = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "deploy_github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.deploy.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub Actions"

  attribute_mapping   = local.attribute_mapping
  attribute_condition = "assertion.repository=='${var.github_repository}' && assertion.ref=='refs/heads/main' && assertion.workflow_ref=='${local.deploy_workflow_ref}' && assertion.environment=='${var.github_environment}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "deploy" {
  project      = var.project_id
  account_id   = "ai-trading-deploy"
  display_name = "ai-trading deploy (GitHub OIDC)"
}

resource "google_service_account_iam_member" "deploy_wif_binding" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.deploy.name}/attribute.repository/${var.github_repository}"
}

# --- Workload identity: terraform (ai-trading-infra.yml) --------------------

resource "google_iam_workload_identity_pool" "terraform" {
  project                   = var.project_id
  workload_identity_pool_id = "ai-trading-terraform"
  display_name              = "ai-trading terraform"

  depends_on = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "terraform_github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.terraform.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub Actions"

  attribute_mapping   = local.attribute_mapping
  attribute_condition = "assertion.repository=='${var.github_repository}' && assertion.ref=='refs/heads/main' && assertion.workflow_ref=='${local.terraform_workflow_ref}' && assertion.environment=='${var.github_environment}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "terraform" {
  project      = var.project_id
  account_id   = "ai-trading-terraform"
  display_name = "ai-trading terraform (GitHub OIDC)"
}

resource "google_service_account_iam_member" "terraform_wif_binding" {
  service_account_id = google_service_account.terraform.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.terraform.name}/attribute.repository/${var.github_repository}"
}

# --- Secret IAM --------------------------------------------------------------

resource "google_secret_manager_secret_iam_member" "deploy_env_bundle_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.env_bundle.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.deploy.email}"
}

# Reused, read-only: the OVH deploy SSH key (AGENTS.md's one shared
# exception). This secret is provisioned by expense-tax-management's own
# Terraform, not this root; granting access here only references its ID.
resource "google_secret_manager_secret_iam_member" "deploy_ovh_keys_accessor" {
  project   = var.project_id
  secret_id = "expense-tax-env-files"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_secret_manager_secret_iam_member" "terraform_env_bundle_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.env_bundle.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.terraform.email}"
}

# --- State bucket IAM --------------------------------------------------------

resource "google_storage_bucket_iam_member" "terraform_state_admin" {
  bucket = var.state_bucket
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.terraform.email}"
}
