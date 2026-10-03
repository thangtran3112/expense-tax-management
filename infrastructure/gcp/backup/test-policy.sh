#!/usr/bin/env bash
# Static policy checks for infrastructure/gcp/backup/main.tf -- plain
# grep assertions (same style as infrastructure/cloudflare/expense-tax's
# test-clerk-dns.sh), not a full HCL parser. Never runs `terraform plan`
# or `apply`; only fmt/validate, which touch no live GCP resources.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN_TF="$SCRIPT_DIR/main.tf"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

test -f "$MAIN_TF" || fail "main.tf is missing"

grep -Fq 'uniform_bucket_level_access = true' "$MAIN_TF" || fail "bucket must enable uniform_bucket_level_access"
grep -Fq 'public_access_prevention    = "enforced"' "$MAIN_TF" || fail "bucket must enforce public_access_prevention"

awk '/resource "google_storage_bucket" "backup"/,/^}/' "$MAIN_TF" > /tmp/backup_bucket_block.$$
grep -Fq 'enabled = true' /tmp/backup_bucket_block.$$ || fail "bucket must enable versioning"
grep -Fq 'retention_period = 604800' /tmp/backup_bucket_block.$$ || fail "bucket must set a 7-day (604800s) retention_period"
grep -Fq 'is_locked        = true' /tmp/backup_bucket_block.$$ || fail "bucket retention policy must be locked (is_locked = true)"

grep -Fq 'matches_prefix = ["daily/"]' /tmp/backup_bucket_block.$$ || fail "missing a daily/ lifecycle rule"
grep -Fq 'matches_prefix = ["monthly/"]' /tmp/backup_bucket_block.$$ || fail "missing a monthly/ lifecycle rule"
awk '/matches_prefix = \["daily\/"\]/{print prev} {prev=$0}' /tmp/backup_bucket_block.$$ | grep -Fq 'age            = 30' \
  || fail "daily/ lifecycle rule must expire after 30 days"
awk '/matches_prefix = \["monthly\/"\]/{print prev} {prev=$0}' /tmp/backup_bucket_block.$$ | grep -Fq 'age            = 365' \
  || fail "monthly/ lifecycle rule must expire after 365 days"
rm -f /tmp/backup_bucket_block.$$

grep -Fq 'resource "google_service_account" "backup_writer"' "$MAIN_TF" || fail "missing the VPS writer service account"
grep -Fq 'role   = "roles/storage.objectCreator"' "$MAIN_TF" || fail "writer must be granted roles/storage.objectCreator"
grep -Eq 'role\s*=\s*"roles/storage\.(objectViewer|objectAdmin|admin|legacyBucketOwner)"' "$MAIN_TF" \
  && fail "writer/bucket IAM must never grant a read/admin GCS role"
grep -Fq 'resource "google_service_account_key"' "$MAIN_TF" \
  && fail "no service-account key resource may exist in Terraform state (writer key is created manually -- see README)"

grep -Fq 'resource "google_service_account" "backup_freshness_monitor"' "$MAIN_TF" \
  || fail "missing a SEPARATE freshness-monitor service account"
[[ "$(grep -c 'resource "google_service_account"' "$MAIN_TF")" == "2" ]] \
  || fail "expected exactly two service accounts (writer, freshness-monitor)"
grep -Fq 'permissions = ["storage.objects.list"]' "$MAIN_TF" \
  || fail "freshness-monitor custom role must be list-only (storage.objects.list, no storage.objects.get)"
grep -Fq 'resource "google_iam_workload_identity_pool_provider" "backup_freshness"' "$MAIN_TF" \
  || fail "freshness-monitor must authenticate via its own GitHub OIDC/WIF provider"
grep -Fq 'resource "google_storage_bucket_iam_member" "backup_writer_creator"' "$MAIN_TF" || fail "missing writer IAM binding"
grep -Fq 'resource "google_storage_bucket_iam_member" "backup_freshness_reader"' "$MAIN_TF" || fail "missing freshness-monitor IAM binding"

echo "PASS: backup bucket policy checks (uniform access, no public access, versioning, 7-day locked retention, daily/monthly lifecycle, object-creator-only writer, separate list-only freshness-monitor identity, no writer key in state)"
