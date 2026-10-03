#!/usr/bin/env bash
# One-shot encrypted PostgreSQL + receipt backup. See README.md for the
# full environment contract and infrastructure/README.md for how this fits
# the shared VPS topology.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

preflight() {
  local required_vars=(
    PGHOST PGPORT PGUSER PGPASSWORD_FILE
    BACKUP_GCS_URI BACKUP_HOST_ID AGE_RECIPIENT
    RECEIPT_STORAGE_DIR BACKUP_STATE_DIR BACKUP_CIPHERTEXT_DIR
    GOOGLE_APPLICATION_CREDENTIALS
  )
  local v
  for v in "${required_vars[@]}"; do
    require_var "$v"
  done

  [[ -r "$PGPASSWORD_FILE" ]] || die "PGPASSWORD_FILE is not a readable file: $PGPASSWORD_FILE"
  [[ -r "$GOOGLE_APPLICATION_CREDENTIALS" ]] || die "GOOGLE_APPLICATION_CREDENTIALS is not a readable file"
  [[ -d "$RECEIPT_STORAGE_DIR" ]] || die "RECEIPT_STORAGE_DIR is not a directory: $RECEIPT_STORAGE_DIR"
  [[ -d "$BACKUP_STATE_DIR" ]] || die "BACKUP_STATE_DIR is not a directory: $BACKUP_STATE_DIR"
  [[ -d "$BACKUP_CIPHERTEXT_DIR" ]] || die "BACKUP_CIPHERTEXT_DIR is not a directory: $BACKUP_CIPHERTEXT_DIR"

  validate_bucket_uri "$BACKUP_GCS_URI"
  validate_age_recipient "$AGE_RECIPIENT"

  # PGPASSWORD is the standard libpq channel: unlike a CLI flag it never
  # appears in `ps`, and the file-mount contract (mode 0400, root-owned)
  # keeps the secret off the command line entirely.
  PGPASSWORD="$(< "$PGPASSWORD_FILE")"
  export PGPASSWORD

  pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1 \
    || die "PostgreSQL is not reachable at $PGHOST:$PGPORT"

  log "preflight ok (host=$BACKUP_HOST_ID bucket=$BACKUP_GCS_URI)"
}

main() {
  preflight
  [[ "${BACKUP_PREFLIGHT_ONLY:-0}" == 1 ]] && { log "BACKUP_PREFLIGHT_ONLY=1: stopping after preflight"; return 0; }
  acquire_single_flight_lock
  die "backup.sh: dump/encrypt/upload pipeline not yet reached (Task 3-5 in progress)"
}

main "$@"
