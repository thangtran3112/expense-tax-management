#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="expense-tax-tobytran-2026"
ORGANIZATION_ID="177410718350"
BILLING_ACCOUNT="013C6D-EEE26E-EAA1A1"
POOL_ID="expense-tax-github"

command -v gcloud >/dev/null || { echo "gcloud is required" >&2; exit 1; }

verify_project_contract() {
  local parent_type parent_id billing_account
  parent_type="$(gcloud projects describe "$PROJECT_ID" --format='value(parent.type)')"
  parent_id="$(gcloud projects describe "$PROJECT_ID" --format='value(parent.id)')"
  billing_account="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingAccountName)')"
  [[ "$parent_type" == "organization" && "$parent_id" == "$ORGANIZATION_ID" ]] || {
    echo "project parent mismatch" >&2
    exit 1
  }
  [[ "$billing_account" == "billingAccounts/$BILLING_ACCOUNT" || "$billing_account" == "$BILLING_ACCOUNT" ]] || {
    echo "project billing account mismatch" >&2
    exit 1
  }
}

if ! gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud projects create "$PROJECT_ID" --organization="$ORGANIZATION_ID" --name="Expense Tax Production"
else
  echo "project already exists: $PROJECT_ID"
fi

gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
verify_project_contract
gcloud services enable \
  cloudresourcemanager.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  --project="$PROJECT_ID"

if ! gcloud iam workload-identity-pools describe "$POOL_ID" \
  --project="$PROJECT_ID" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL_ID" \
    --project="$PROJECT_ID" --location=global \
    --display-name="Expense Tax GitHub Actions"
else
  echo "workload identity pool already exists: $POOL_ID"
fi
