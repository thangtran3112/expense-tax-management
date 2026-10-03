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

file_mtime_epoch() {
  stat -c%Y "$1" 2>/dev/null || stat -f%m "$1"
}

# Prints, one per line, paths (relative to $1) of every regular file whose
# server-controlled mtime falls in the backup window for $2 (full|daily):
#   full:  mtime <= current_cutoff            (everything up to the freeze)
#   daily: last_cutoff < mtime <= current_cutoff
# Pure filesystem logic -- no GNU-only find flags -- so it runs identically
# on the pinned Linux container, GitHub Actions ubuntu-latest, and macOS.
select_receipt_files() {
  local dir="$1" mode="$2" last_cutoff="$3" current_cutoff="$4" path rel mtime
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    mtime=$(file_mtime_epoch "$path")
    if [[ "$mode" == "full" ]]; then
      (( mtime <= current_cutoff )) || continue
    else
      (( mtime > last_cutoff && mtime <= current_cutoff )) || continue
    fi
    rel="${path#"$dir"/}"
    printf '%s\n' "$rel"
  done < <(find "$dir" -type f)
}

current_month_of() {
  local epoch="$1"
  date -u -d "@$epoch" +%Y-%m 2>/dev/null || date -u -r "$epoch" +%Y-%m
}

iso_of() {
  local epoch="$1"
  date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$epoch" +%Y-%m-%dT%H:%M:%SZ
}

# Decides full-vs-daily by comparing the current calendar month against the
# month of the most recent full backup recorded in the marker (not the
# marker's cutoff date itself, so this needs no date arithmetic beyond one
# string compare). No marker at all -> always full (first run).
determine_mode() {
  local marker_file="$1" current_cutoff_epoch="$2" current_run_id="$3"
  local current_month
  current_month=$(current_month_of "$current_cutoff_epoch")
  if [[ ! -s "$marker_file" ]]; then
    jq -nc --arg parent "$current_run_id" \
      '{mode: "full", last_cutoff_epoch: 0, parent_full_backup_id: $parent}'
    return
  fi
  local marker_last_full_period
  marker_last_full_period=$(jq -r '.last_full_period' "$marker_file")
  if [[ "$marker_last_full_period" == "$current_month" ]]; then
    jq -c '{mode: "daily", last_cutoff_epoch: .cutoff_epoch, parent_full_backup_id: .parent_full_backup_id}' "$marker_file"
  else
    jq -nc --arg parent "$current_run_id" \
      '{mode: "full", last_cutoff_epoch: 0, parent_full_backup_id: $parent}'
  fi
}

# Builds staging/receipts.tar deterministically (sorted names, zeroed
# owner/group/mtime) from exactly the files select_receipt_files() returns,
# and staging/receipt-inventory.json with per-file path/bytes/sha256 plus
# the archive's own aggregate stats. Always produces a valid (possibly
# empty) archive so an unchanged-receipts run still succeeds.
build_receipt_archive() {
  local staging="$1" mode="$2" last_cutoff_epoch="$3" current_cutoff_epoch="$4"
  local filelist="$staging/receipt-filelist.txt"
  select_receipt_files "$RECEIPT_STORAGE_DIR" "$mode" "$last_cutoff_epoch" "$current_cutoff_epoch" \
    | sort > "$filelist"

  tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner --no-recursion \
    -cf "$staging/receipts.tar" -C "$RECEIPT_STORAGE_DIR" -T "$filelist" \
    || die "receipt archive construction failed"

  local items="[]" rel f bytes sha
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    f="$RECEIPT_STORAGE_DIR/$rel"
    bytes=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")
    sha=$(sha256_file "$f")
    items=$(jq -c --arg path "$rel" --arg sha "$sha" --argjson bytes "$bytes" \
      '. + [{path: $path, bytes: $bytes, sha256: $sha}]' <<< "$items")
  done < "$filelist"

  jq -n --arg name receipts.tar \
    --argjson count "$(wc -l < "$filelist")" \
    --argjson bytes "$(stat -c%s "$staging/receipts.tar" 2>/dev/null || stat -f%z "$staging/receipts.tar")" \
    --arg sha "$(sha256_file "$staging/receipts.tar")" \
    --argjson files "$items" \
    '{archive_name: $name, file_count: $count, bytes: $bytes, sha256: $sha, files: $files}' \
    > "$staging/receipt-inventory.json"
}

# Parses "KEY1=VAL1,KEY2=VAL2" into {"KEY1":"VAL1","KEY2":"VAL2"}; empty
# input yields {}. Used for BACKUP_IMAGE_TAGS / BACKUP_MIGRATION_VERSIONS.
csv_pairs_to_json() {
  local csv="${1:-}"
  [[ -n "$csv" ]] || { echo '{}'; return; }
  jq -nc --arg csv "$csv" '
    $csv | split(",") | map(select(length > 0) | split("=") | {(.[0]): (.[1] // "")}) | add // {}
  '
}

# Combines database-inventory.json (Task 3) and receipt-inventory.json
# (above) into the single manifest.json this whole backup set is validated
# and encrypted around.
build_manifest() {
  local staging="$1" run_id="$2" cutoff_iso="$3" mode_json="$4"
  local compose_checksum=null
  if [[ -n "${BACKUP_COMPOSE_FILE:-}" && -r "${BACKUP_COMPOSE_FILE:-}" ]]; then
    compose_checksum="\"$(sha256_file "$BACKUP_COMPOSE_FILE")\""
  fi
  jq -n \
    --arg host "$BACKUP_HOST_ID" \
    --arg run_id "$run_id" \
    --arg cutoff "$cutoff_iso" \
    --argjson mode "$mode_json" \
    --slurpfile db "$staging/database-inventory.json" \
    --slurpfile receipts "$staging/receipt-inventory.json" \
    --argjson image_tags "$(csv_pairs_to_json "${BACKUP_IMAGE_TAGS:-}")" \
    --argjson migrations "$(csv_pairs_to_json "${BACKUP_MIGRATION_VERSIONS:-}")" \
    --argjson compose_checksum "$compose_checksum" \
    '{
      backup_host_id: $host,
      run_id: $run_id,
      cutoff: $cutoff,
      mode: $mode.mode,
      parent_full_backup_id: $mode.parent_full_backup_id,
      postgresql_version: $db[0].postgresql_version,
      databases: $db[0].databases,
      files: $db[0].files,
      receipts: $receipts[0],
      deployed_image_tags: $image_tags,
      schema_migration_versions: $migrations,
      compose_checksum: $compose_checksum
    }' > "$staging/manifest.json"
}

# Hand-checks manifest.json against every required key/type/enum that
# manifest.schema.json declares (Ruling: no ajv dependency -- see README).
# Also re-verifies every file/receipt checksum it references actually
# matches bytes still on disk, so a corrupt staging write is caught before
# encryption, not after.
validate_manifest() {
  local staging="$1"
  local manifest="$staging/manifest.json"
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
  ' "$manifest" >/dev/null || die "manifest.json failed schema validation"

  local name sha f
  while IFS=$'\t' read -r name sha; do
    f="$staging/$name"
    [[ -f "$f" ]] || die "manifest references missing file: $name"
    [[ "$(sha256_file "$f")" == "$sha" ]] || die "checksum mismatch for $name"
  done < <(jq -r '.files[] | [.name, .sha256] | @tsv' "$manifest")

  while IFS=$'\t' read -r path sha; do
    f="$RECEIPT_STORAGE_DIR/$path"
    [[ -f "$f" ]] || die "manifest references missing receipt: $path"
    [[ "$(sha256_file "$f")" == "$sha" ]] || die "checksum mismatch for receipt: $path"
  done < <(jq -r '.receipts.files[] | [.path, .sha256] | @tsv' "$manifest")

  [[ "$(sha256_file "$staging/receipts.tar")" == "$(jq -r '.receipts.sha256' "$manifest")" ]] \
    || die "checksum mismatch for receipts.tar"

  log "manifest validated: mode=$(jq -r .mode "$manifest") databases=$(jq -r '.databases|length' "$manifest") receipts=$(jq -r '.receipts.file_count' "$manifest")"
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

  # Freeze current_cutoff immediately after database dumps (Task 4): any
  # receipt confirmed after this instant belongs to the NEXT run, never
  # this one, even if upload takes a while from here.
  local current_cutoff_epoch run_id mode_json mode last_cutoff_epoch cutoff_iso
  current_cutoff_epoch=$(date -u +%s)
  cutoff_iso=$(iso_of "$current_cutoff_epoch")
  run_id="${BACKUP_HOST_ID}-${current_cutoff_epoch}-$$"

  local marker_file="$BACKUP_STATE_DIR/last-success.json"
  mode_json=$(determine_mode "$marker_file" "$current_cutoff_epoch" "$run_id")
  mode=$(jq -r '.mode' <<< "$mode_json")
  last_cutoff_epoch=$(jq -r '.last_cutoff_epoch' <<< "$mode_json")

  build_receipt_archive "$staging" "$mode" "$last_cutoff_epoch" "$current_cutoff_epoch"
  build_manifest "$staging" "$run_id" "$cutoff_iso" "$mode_json"
  validate_manifest "$staging"
  log "backup set ready (mode=$mode run_id=$run_id cutoff=$cutoff_iso)"

  if [[ "${BACKUP_MANIFEST_ONLY:-0}" == 1 ]]; then
    log "BACKUP_MANIFEST_ONLY=1: stopping after manifest validation (test hook)"
    if [[ -n "${BACKUP_DUMP_ONLY_COPY_TO:-}" ]]; then
      mkdir -p "$BACKUP_DUMP_ONLY_COPY_TO"
      cp -a "$staging/." "$BACKUP_DUMP_ONLY_COPY_TO/"
    fi
    return 0
  fi

  die "backup.sh: encrypt/upload pipeline not yet reached (Task 5 in progress)"
}

# Only run main when executed directly (as the container ENTRYPOINT or by
# the Docker test scripts) -- not when test-backup.sh sources this file to
# reuse pure functions like select_receipt_files/build_manifest.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
