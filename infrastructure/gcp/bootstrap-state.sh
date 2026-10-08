#!/usr/bin/env bash
# One-time (and idempotent) creation of the shared Terraform state bucket.
# Usage: infrastructure/gcp/bootstrap-state.sh --project P --bucket B [--location us]
set -euo pipefail

usage() {
  echo "Usage: $0 --project PROJECT --bucket BUCKET [--location LOCATION]" >&2
  exit 1
}

PROJECT=""
BUCKET=""
LOCATION="us"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT="$2"
      shift 2
      ;;
    --bucket)
      BUCKET="$2"
      shift 2
      ;;
    --location)
      LOCATION="$2"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

[[ -n "$PROJECT" && -n "$BUCKET" ]] || usage

# Controller ruling (ai-trading/AGENTS.md): outside GitHub Actions,
# CLOUDSDK_ACTIVE_CONFIG_NAME must be exactly "personal" -- the operator
# machine's default config ("chartflow") is a different (work) account,
# and any other explicit value is just as wrong a target as the default.
if [[ "${GITHUB_ACTIONS:-}" != "true" && "${CLOUDSDK_ACTIVE_CONFIG_NAME:-}" != "personal" ]]; then
  echo "CLOUDSDK_ACTIVE_CONFIG_NAME must be set to 'personal' outside GitHub Actions" >&2
  exit 1
fi

command -v gcloud >/dev/null || { echo "gcloud is required" >&2; exit 1; }

if ! gcloud storage buckets describe "gs://${BUCKET}" --project="$PROJECT" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET}" \
    --project="$PROJECT" \
    --location="$LOCATION" \
    --uniform-bucket-level-access \
    --public-access-prevention=enforced
else
  echo "state bucket already exists: ${BUCKET}"
fi

gcloud storage buckets update "gs://${BUCKET}" --project="$PROJECT" --versioning

echo "state bucket ready: gs://${BUCKET}"
