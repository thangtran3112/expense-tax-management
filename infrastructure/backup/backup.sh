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

psql_admin() {
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -v ON_ERROR_STOP=1 "$@"
}

# Every real database except the maintenance templates and the bootstrap
# "postgres" catalog-only database. Ruling: the plan says "excluding
# templates"; "postgres" itself is never an application database in this
# cluster (infrastructure/vps/steps/30-postgres.sh only ever stores app
# data in app-created databases), so it is excluded too to keep the backup
# set exactly "every family PostgreSQL database" per ARCHITECTURE.md
# rather than also the empty admin catalog. Cost if wrong: an operator
# restore is missing an empty, re-creatable database.
discover_databases() {
  psql_admin -tAc \
    "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY datname"
}

dump_globals() {
  local staging="$1"
  pg_dumpall -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --globals-only \
    --file="$staging/globals.sql" \
    || die "pg_dumpall --globals-only failed"
  [[ -s "$staging/globals.sql" ]] || die "globals.sql dump is empty"
}

# Dumps every database in $2 (newline-separated) into $1/dumps/<db>.dump and
# validates each one with `pg_restore --list` before returning. Aborts the
# whole run on the first failure so no partial/corrupt dump set is ever
# encrypted or uploaded, and -- because this runs entirely before the
# marker file is touched -- the prior success marker is left untouched.
dump_databases() {
  local staging="$1" databases="$2" db
  mkdir -p "$staging/dumps"
  [[ -n "$databases" ]] || die "no non-template databases discovered"
  while IFS= read -r db; do
    [[ -n "$db" ]] || continue
    log "dumping database: $db"
    pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" \
      --format=custom --no-owner --no-acl \
      --file="$staging/dumps/$db.dump" "$db" \
      || die "pg_dump failed for database: $db"
    pg_restore --list "$staging/dumps/$db.dump" >/dev/null \
      || die "pg_restore --list validation failed for database: $db"
  done <<< "$databases"
}

# Writes staging/manifest.json's database-inventory portion: pg version,
# host id, and per-item {name, bytes, sha256} for globals.sql and every
# dump. Later tasks (4/5) extend this same file with receipt/encryption
# fields rather than writing a second manifest.
record_database_inventory() {
  local staging="$1" databases="$2" pg_version db items
  pg_version=$(psql_admin -tAc "SHOW server_version" | tr -d '[:space:]')
  items="[]"
  items=$(jq -c --arg name globals.sql \
    --arg sha "$(sha256_file "$staging/globals.sql")" \
    --argjson bytes "$(stat -c%s "$staging/globals.sql" 2>/dev/null || stat -f%z "$staging/globals.sql")" \
    '. + [{name: $name, bytes: $bytes, sha256: $sha}]' <<< "$items")
  while IFS= read -r db; do
    [[ -n "$db" ]] || continue
    local f="$staging/dumps/$db.dump"
    items=$(jq -c --arg name "dumps/$db.dump" \
      --arg sha "$(sha256_file "$f")" \
      --argjson bytes "$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")" \
      '. + [{name: $name, bytes: $bytes, sha256: $sha}]' <<< "$items")
  done <<< "$databases"
  jq -n --arg pg_version "$pg_version" \
    --argjson databases "$(jq -ncR '[inputs | select(length > 0)]' <<< "$databases")" \
    --argjson files "$items" \
    '{postgresql_version: $pg_version, databases: $databases, files: $files}' \
    > "$staging/database-inventory.json"
}

main() {
  preflight
  [[ "${BACKUP_PREFLIGHT_ONLY:-0}" == 1 ]] && { log "BACKUP_PREFLIGHT_ONLY=1: stopping after preflight"; return 0; }
  acquire_single_flight_lock

  local staging="${BACKUP_STAGING_DIR:-/staging}/run-$$"
  mkdir -p "$staging"
  # ${staging:-} (not "$staging"): this trap can still fire after main()
  # returns, once `staging` the local variable is out of scope -- under
  # `set -u` a bare "$staging" would then itself fail as unbound.
  trap 'rm -rf "${staging:-}"' EXIT

  dump_globals "$staging"
  local databases
  databases=$(discover_databases)
  dump_databases "$staging" "$databases"
  record_database_inventory "$staging" "$databases"
  log "database dump + validation complete: $(jq -r '.databases | length' "$staging/database-inventory.json") database(s)"

  if [[ "${BACKUP_DUMP_ONLY:-0}" == 1 ]]; then
    log "BACKUP_DUMP_ONLY=1: stopping after database dump (test hook)"
    if [[ -n "${BACKUP_DUMP_ONLY_COPY_TO:-}" ]]; then
      mkdir -p "$BACKUP_DUMP_ONLY_COPY_TO"
      cp -a "$staging/." "$BACKUP_DUMP_ONLY_COPY_TO/"
    fi
    return 0
  fi

  die "backup.sh: receipt capture/manifest/encrypt/upload pipeline not yet reached (Task 4-5 in progress)"
}

main "$@"
