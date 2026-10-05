#!/usr/bin/env bash
# One-time operator step: creates the GitHub OIDC identity that
# .github/workflows/ai-trading-cloudflare.yml uses to reach the shared GCS state
# bucket. Mirrors expense-tax-management/infrastructure/gcp/expense-tax/bootstrap-cloudflare.sh.
set -euo pipefail
umask 077

PROJECT_ID="expense-tax-tobytran-2026"
BUCKET="expense-tax-tobytran-2026-tfstate"
SERVICE_ACCOUNT_ID="ai-trading-cf-terraform"
POOL_ID="expense-tax-github"
PROVIDER_ID="ai-trading-cloudflare"
REPOSITORY="thangtran3112/family-app"
ENVIRONMENT="ai-trading-production"
WORKFLOW_REF="${REPOSITORY}/.github/workflows/ai-trading-cloudflare.yml@refs/heads/main"
CONDITION="assertion.repository=='${REPOSITORY}' && assertion.ref=='refs/heads/main' && assertion.workflow_ref=='${WORKFLOW_REF}' && assertion.environment=='${ENVIRONMENT}'"
MAPPING="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref,attribute.environment=assertion.environment"

command -v gcloud >/dev/null || { echo "gcloud is required" >&2; exit 1; }
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_ID}@${PROJECT_ID}.iam.gserviceaccount.com"

if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SERVICE_ACCOUNT_ID" \
    --project="$PROJECT_ID" --display-name="ai-trading Cloudflare Terraform"
fi

if ! gcloud iam workload-identity-pools describe "$POOL_ID" \
  --project="$PROJECT_ID" --location=global >/dev/null 2>&1; then
  echo "workload identity pool $POOL_ID is missing; run the expense bootstrap first" >&2
  exit 1
fi

if ! gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
    --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" \
    --display-name="ai-trading CF Terraform" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="$MAPPING" --attribute-condition="$CONDITION"
else
  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_ID" \
    --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="$MAPPING" --attribute-condition="$CONDITION"
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
PRINCIPAL_SET="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${REPOSITORY}"

gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT_EMAIL" \
  --project="$PROJECT_ID" --role="roles/iam.workloadIdentityUser" --member="$PRINCIPAL_SET" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" --role="roles/storage.objectAdmin" >/dev/null

echo "Set these vars in the GitHub environment ${ENVIRONMENT}:"
echo "  GCP_AI_TRADING_CF_WORKLOAD_IDENTITY_PROVIDER=projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
echo "  GCP_AI_TRADING_CF_SERVICE_ACCOUNT=${SERVICE_ACCOUNT_EMAIL}"
echo "  TF_STATE_BUCKET=${BUCKET}"
