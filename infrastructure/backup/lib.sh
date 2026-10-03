#!/usr/bin/env bash
# Shared helpers for infrastructure/backup/backup.sh and restore.sh.
# Sourced, never executed directly. No function here may print a secret
# value: log only variable NAMES, never their contents.
set -euo pipefail

log() { printf '%s [backup] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

# Every die() call site in this directory passes a generic description or,
# at most, a variable NAME/path/object-key -- never a secret VALUE (PGPASSWORD,
# private key, or credential file content) -- so it is always safe to echo
# that same message into the machine-readable failure status on stdout.
die() {
  log "ERROR: $*"
  emit_status failure "$(jq -nc --arg reason "$*" '{reason:$reason}')"
  exit 1
}

require_var() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    die "missing required variable: $name"
  fi
}

# Accepts only gs://bucket[/prefix...]: lowercase bucket name per GCS rules,
# optional slash-separated prefix of safe characters. Rejects any other
# scheme, path traversal, spaces, and shell metacharacters.
validate_bucket_uri() {
  local uri="$1"
  [[ "$uri" != *".."* ]] || die "unsafe BACKUP_GCS_URI: path traversal"
  [[ "$uri" =~ ^gs://[a-z0-9][a-z0-9._-]{1,61}[a-z0-9](/[A-Za-z0-9._/-]+)?$ ]] \
    || die "unsafe or malformed BACKUP_GCS_URI"
}

# age X25519 recipients are "age1" followed by a bech32 data part (lowercase
# alphanumeric, excluding b/i/o/1 by bech32 charset, typically 58 chars).
# This is a format check only; age itself rejects a recipient it cannot use.
validate_age_recipient() {
  local recipient="$1"
  [[ "$recipient" =~ ^age1[02-9ac-hj-np-z]{20,100}$ ]] \
    || die "invalid AGE_RECIPIENT format"
}

sha256_file() { sha256sum "$1" | awk '{print $1}'; }

# Parses "KEY1=VAL1,KEY2=VAL2" into {"KEY1":"VAL1","KEY2":"VAL2"}; empty
# input yields {}. Used for BACKUP_IMAGE_TAGS/BACKUP_MIGRATION_VERSIONS
# (backup.sh) and RECOVERY_SUPPORTED_MIGRATION_VERSIONS (recovery-drill.sh)
# so both sides of "compare restored vs. supported schema versions" parse
# the same shape identically.
csv_pairs_to_json() {
  local csv="${1:-}"
  [[ -n "$csv" ]] || { echo '{}'; return; }
  jq -nc --arg csv "$csv" '
    $csv | split(",") | map(select(length > 0) | split("=") | {(.[0]): (.[1] // "")}) | add // {}
  '
}

# Hand-checks a manifest.json's required keys/types/enums against
# manifest.schema.json (Ruling: no ajv dependency -- see README). Shared by
# backup.sh (validating what it is about to encrypt) and restore.sh
# (validating what it just decrypted) so the one contract is enforced
# identically on both sides of the backup.
validate_manifest_shape() {
  local manifest="$1"
  [[ -s "$manifest" ]] || die "manifest.json missing or empty"
  jq -e '
    (.backup_host_id | type == "string" and length > 0) and
    (.run_id | type == "string" and length > 0) and
    (.cutoff | type == "string") and
    (.mode == "full" or .mode == "daily") and
    (.parent_full_backup_id | type == "string" and length > 0) and
    (.postgresql_version | type == "string" and length > 0) and
    (.databases | type == "array") and
    (.files | type == "array" and all(.[]; (.name|type=="string") and (.bytes|type=="number") and (.sha256|test("^[0-9a-f]{64}$")))) and
    (.receipts.archive_name | type == "string") and
    (.receipts.file_count | type == "number") and
    (.receipts.files | type == "array" and all(.[]; (.path|type=="string") and (.sha256|test("^[0-9a-f]{64}$")))) and
    (.deployed_image_tags | type == "object") and
    (.schema_migration_versions | type == "object")
  ' "$manifest" >/dev/null || die "manifest.json failed schema validation: $manifest"
}

# Writes the machine-readable status line to stdout. Never pass a value
# derived from a secret (password, private key, credential file content).
emit_status() {
  local state="$1" extra_json="${2:-null}"
  jq -nc --arg status "$state" \
    --arg host "${BACKUP_HOST_ID:-unknown}" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson extra "$extra_json" \
    '{status: $status, host_id: $host, timestamp: $ts} * ($extra // {})'
}

# Single-flight guard: holds an flock on $BACKUP_STATE_DIR/backup.lock for
# the remaining lifetime of the current shell. Safe to call once near the
# top of main(); exits nonzero without blocking if another run holds it.
acquire_single_flight_lock() {
  local lock_file="$BACKUP_STATE_DIR/backup.lock"
  exec 9>"$lock_file"
  flock -n 9 || die "another backup run is already in progress (flock on $lock_file)"
}
