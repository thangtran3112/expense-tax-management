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

# Mirrors infrastructure/cloudflare/expense-tax/bootstrap-state.sh's guard:
# the operator machine's default gcloud configuration is a different (work)
# account, so this refuses to run against it by surprise.
if [[ "${GITHUB_ACTIONS:-}" != "true" && -z "${CLOUDSDK_ACTIVE_CONFIG_NAME:-}" ]]; then
  echo "CLOUDSDK_ACTIVE_CONFIG_NAME must be set outside GitHub Actions" >&2
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
