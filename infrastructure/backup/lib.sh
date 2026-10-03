#!/usr/bin/env bash
# Shared helpers for infrastructure/backup/backup.sh and restore.sh.
# Sourced, never executed directly. No function here may print a secret
# value: log only variable NAMES, never their contents.
set -euo pipefail

log() { printf '%s [backup] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

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
