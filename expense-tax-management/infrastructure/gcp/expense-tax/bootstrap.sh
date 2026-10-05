#!/usr/bin/env bash
set -euo pipefail
umask 077

PROJECT_ID="expense-tax-tobytran-2026"
ORGANIZATION_ID="177410718350"
BILLING_ACCOUNT="013C6D-EEE26E-EAA1A1"
SECRET_ID="expense-tax-production-env"
SERVICE_ACCOUNT_ID="expense-tax-github-deploy"
POOL_ID="expense-tax-github"
PROVIDER_ID="github"
REPOSITORY="thangtran3112/family-app"
WIF_ATTRIBUTE_CONDITION="assertion.repository=='thangtran3112/family-app' && assertion.ref=='refs/heads/main' && assertion.workflow_ref=='thangtran3112/family-app/.github/workflows/expense-tax-deploy.yml@refs/heads/main' && assertion.environment=='production'"
OUTPUT_FILE="${1:-/dev/stdout}"
TEMP_DIR="$(mktemp -d)"
PROVIDER_FILE="$TEMP_DIR/provider.json"
SERVICE_ACCOUNT_FILE="$TEMP_DIR/service-account.json"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

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

if ! gcloud iam service-accounts describe \
  "${SERVICE_ACCOUNT_ID}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SERVICE_ACCOUNT_ID" \
    --project="$PROJECT_ID" \
    --display-name="Expense Tax GitHub deploy"
else
  echo "service account already exists: $SERVICE_ACCOUNT_ID"
fi

if ! gcloud iam workload-identity-pools describe "$POOL_ID" \
  --project="$PROJECT_ID" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL_ID" \
    --project="$PROJECT_ID" --location=global \
    --display-name="Expense Tax GitHub Actions"
else
  echo "workload identity pool already exists: $POOL_ID"
fi

if ! gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" \
  >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
    --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" \
    --display-name="GitHub Actions" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref,attribute.environment=assertion.environment" \
    --attribute-condition="$WIF_ATTRIBUTE_CONDITION"
else
  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_ID" \
    --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref,attribute.environment=assertion.environment" \
    --attribute-condition="$WIF_ATTRIBUTE_CONDITION"
fi

gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" \
  --format=json > "$PROVIDER_FILE"
node --input-type=module - "$PROVIDER_FILE" <<'NODE'
import { readFileSync } from "node:fs";

const provider = JSON.parse(readFileSync(process.argv[2], "utf8"));
const expected = {
  issuerUri: "https://token.actions.githubusercontent.com",
  "google.subject": "assertion.sub",
  "attribute.repository": "assertion.repository",
  "attribute.ref": "assertion.ref",
  "attribute.workflow_ref": "assertion.workflow_ref",
  "attribute.environment": "assertion.environment",
  attributeCondition: "assertion.repository=='thangtran3112/family-app' && assertion.ref=='refs/heads/main' && assertion.workflow_ref=='thangtran3112/family-app/.github/workflows/expense-tax-deploy.yml@refs/heads/main' && assertion.environment=='production'",
};
const actual = {
  issuerUri: provider.oidc?.issuerUri,
  "google.subject": provider.attributeMapping?.["google.subject"],
  "attribute.repository": provider.attributeMapping?.["attribute.repository"],
  "attribute.ref": provider.attributeMapping?.["attribute.ref"],
  "attribute.workflow_ref": provider.attributeMapping?.["attribute.workflow_ref"],
  "attribute.environment": provider.attributeMapping?.["attribute.environment"],
  attributeCondition: provider.attributeCondition,
};
for (const [key, value] of Object.entries(expected)) {
  if (actual[key] !== value) {
    console.error(`WIF provider drift: ${key}`);
    process.exit(1);
  }
}
NODE

if ! gcloud secrets describe "$SECRET_ID" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud secrets create "$SECRET_ID" --project="$PROJECT_ID" --replication-policy=automatic
else
  echo "secret already exists: $SECRET_ID"
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_ID}@${PROJECT_ID}.iam.gserviceaccount.com"
PRINCIPAL_SET="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${REPOSITORY}"

gcloud iam service-accounts remove-iam-policy-binding "$SERVICE_ACCOUNT_EMAIL" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principal://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/subject/repo:${REPOSITORY}:environment:production" >/dev/null 2>&1 || true

gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT_EMAIL" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="$PRINCIPAL_SET"
gcloud secrets add-iam-policy-binding "$SECRET_ID" \
  --project="$PROJECT_ID" \
  --role="roles/secretmanager.secretAccessor" \
  --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}"

[[ "$OUTPUT_FILE" == /dev/stdout ]] || mkdir -p "$(dirname "$OUTPUT_FILE")"
gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" \
  --format=json > "$PROVIDER_FILE"
gcloud iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" \
  --project="$PROJECT_ID" --format=json > "$SERVICE_ACCOUNT_FILE"
gcloud iam service-accounts get-iam-policy "$SERVICE_ACCOUNT_EMAIL" \
  --project="$PROJECT_ID" --format=json > "$TEMP_DIR/service-account-policy.json"
node --input-type=module - "$TEMP_DIR/service-account-policy.json" "$PROJECT_NUMBER" <<'NODE'
import { readFileSync } from "node:fs";

const [policyFile, projectNumber] = process.argv.slice(2);
const policy = JSON.parse(readFileSync(policyFile, "utf8"));
const expected = `principalSet://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/expense-tax-github/attribute.repository/thangtran3112/family-app`;
const members = (policy.bindings ?? [])
  .filter(({ role }) => role === "roles/iam.workloadIdentityUser")
  .flatMap(({ members: bindingMembers = [] }) => bindingMembers);
if (members.length !== 1 || !members.includes(expected)) {
  console.error("WIF service-account binding drift");
  process.exit(1);
}
NODE
node --input-type=module - "$OUTPUT_FILE" "$PROVIDER_FILE" "$SERVICE_ACCOUNT_FILE" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const [output, providerFile, serviceAccountFile] = process.argv.slice(2);
const provider = JSON.parse(readFileSync(providerFile, "utf8"));
const serviceAccount = JSON.parse(readFileSync(serviceAccountFile, "utf8"));
writeFileSync(output, `${JSON.stringify({
  projectId: "expense-tax-tobytran-2026",
  secretId: "expense-tax-production-env",
  serviceAccountEmail: serviceAccount.email,
  workloadIdentityProvider: provider.name,
  repository: "thangtran3112/family-app",
}, null, 2)}\n`);
NODE
[[ "$OUTPUT_FILE" == /dev/stdout ]] || chmod 600 "$OUTPUT_FILE"
echo "wrote machine-readable outputs: $OUTPUT_FILE" >&2
