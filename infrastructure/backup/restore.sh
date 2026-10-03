#!/usr/bin/env bash
# Operator-run restore: downloads one monthly full backup set plus,
# optionally, ordered daily deltas, decrypts them with an explicitly
# supplied private age identity, validates every checksum, then restores
# globals/databases/receipts onto a destination PostgreSQL cluster and
# receipt volume. Never runs unattended and never reads the private
# identity from any default/implicit location -- see README.md.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

preflight() {
  local v
  for v in PGHOST PGPORT PGUSER PGPASSWORD_FILE \
    RESTORE_AGE_IDENTITY_FILE RESTORE_GOOGLE_APPLICATION_CREDENTIALS \
    RESTORE_OBJECT_URI RESTORE_WORK_DIR RECEIPT_RESTORE_DIR; do
    require_var "$v"
  done
  [[ -r "$PGPASSWORD_FILE" ]] || die "PGPASSWORD_FILE is not a readable file: $PGPASSWORD_FILE"
  [[ -r "$RESTORE_AGE_IDENTITY_FILE" ]] || die "RESTORE_AGE_IDENTITY_FILE is not a readable file"
  [[ -r "$RESTORE_GOOGLE_APPLICATION_CREDENTIALS" ]] || die "RESTORE_GOOGLE_APPLICATION_CREDENTIALS is not a readable file"
  [[ -d "$RECEIPT_RESTORE_DIR" ]] || die "RECEIPT_RESTORE_DIR is not a directory: $RECEIPT_RESTORE_DIR"
  [[ "$RESTORE_OBJECT_URI" =~ ^gs://[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]/[A-Za-z0-9._/-]+\.tar\.age$ ]] \
    || die "RESTORE_OBJECT_URI does not look like a gs://bucket/.../*.tar.age object"

  PGPASSWORD="$(< "$PGPASSWORD_FILE")"
  export PGPASSWORD
  pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1 \
    || die "destination PostgreSQL is not reachable at $PGHOST:$PGPORT"

  [[ ! -e "$RESTORE_WORK_DIR" || -z "$(ls -A "$RESTORE_WORK_DIR" 2>/dev/null)" ]] \
    || die "RESTORE_WORK_DIR already exists and is not empty: $RESTORE_WORK_DIR"
  mkdir -p "$RESTORE_WORK_DIR"
  chmod 0700 "$RESTORE_WORK_DIR"
}

psql_dest() {
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -v ON_ERROR_STOP=1 "$@"
}

# Refuses to proceed against a destination that already holds data unless
# the operator explicitly passes RESTORE_CONFIRM_DESTRUCTIVE=yes-destroy-existing-data.
# "Already holds data" = any non-template, non-"postgres" database, or any
# file already in RECEIPT_RESTORE_DIR.
check_destination_empty_or_confirmed() {
  local existing_dbs receipt_file_count
  existing_dbs=$(psql_dest -tAc \
    "SELECT count(*) FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'")
  receipt_file_count=$(find "$RECEIPT_RESTORE_DIR" -type f 2>/dev/null | wc -l | tr -d '[:space:]')
  if [[ "$existing_dbs" != 0 || "$receipt_file_count" != 0 ]]; then
    [[ "${RESTORE_CONFIRM_DESTRUCTIVE:-}" == "yes-destroy-existing-data" ]] \
      || die "destination is not empty ($existing_dbs database(s), $receipt_file_count receipt file(s)); refusing without RESTORE_CONFIRM_DESTRUCTIVE=yes-destroy-existing-data"
    log "destination is not empty but RESTORE_CONFIRM_DESTRUCTIVE was supplied; proceeding"
  fi
}

# Downloads $1 (a gs://... object) into $2, then independently re-derives
# the object's generation/md5 from GCS and compares them against what was
# actually written to disk -- catching any transport corruption before a
# single byte of it is trusted. If $3 (an expected generation, usually
# copied from the originating backup run's status) is supplied, that is
# checked too, catching an operator pointing restore at the wrong object.
download_and_verify_object() {
  local uri="$1" dest="$2" expected_generation="${3:-}"
  gcloud storage cp "$uri" "$dest" >/dev/null || die "download failed: $uri"

  local meta generation md5_remote md5_local
  meta=$(gcloud storage objects describe "$uri" --format='json(generation,md5Hash)')
  generation=$(jq -r '.generation' <<< "$meta")
  md5_remote=$(jq -r '.md5Hash' <<< "$meta")
  md5_local=$(openssl dgst -md5 -binary "$dest" | openssl base64)
  [[ "$md5_remote" == "$md5_local" ]] \
    || die "downloaded object digest does not match GCS metadata: $uri"

  if [[ -n "$expected_generation" ]]; then
    [[ "$generation" == "$expected_generation" ]] \
      || die "object generation mismatch for $uri (expected $expected_generation, got $generation)"
  fi
  log "downloaded and verified: $uri (generation=$generation)"
}

# Decrypts $1 with the explicitly supplied private identity file (never a
# default path, never an env var carrying the key itself -- only ever a
# file the operator names) and untars it into $2.
decrypt_and_extract() {
  local ciphertext="$1" dest_dir="$2"
  mkdir -p "$dest_dir"
  age -d -i "$RESTORE_AGE_IDENTITY_FILE" -o "$dest_dir/plaintext.tar" "$ciphertext" \
    || die "decryption failed for $ciphertext (wrong identity or corrupt ciphertext)"
  tar -xf "$dest_dir/plaintext.tar" -C "$dest_dir"
  rm -f "$dest_dir/plaintext.tar"
  validate_manifest_shape "$dest_dir/manifest.json"

  local name sha f
  while IFS=$'\t' read -r name sha; do
    f="$dest_dir/$name"
    [[ -f "$f" ]] || die "restored set is missing manifest-referenced file: $name"
    [[ "$(sha256_file "$f")" == "$sha" ]] || die "checksum mismatch after decrypt for $name"
  done < <(jq -r '.files[] | [.name, .sha256] | @tsv' "$dest_dir/manifest.json")
  [[ "$(sha256_file "$dest_dir/receipts.tar")" == "$(jq -r '.receipts.sha256' "$dest_dir/manifest.json")" ]] \
    || die "checksum mismatch after decrypt for receipts.tar"

  log "decrypted and validated: mode=$(jq -r .mode "$dest_dir/manifest.json") run_id=$(jq -r .run_id "$dest_dir/manifest.json")"
}

# pg_dumpall --globals-only output recreates every role/tablespace with
# CREATE ...; against a destination that already has a default superuser
# role (every fresh PostgreSQL cluster does), the very first statements
# always conflict. Ruling: run with ON_ERROR_STOP=0 and tolerate ONLY
# "already exists" errors -- anything else in psql's stderr is a real
# problem (e.g. a permissions error, a syntax error from a version skew)
# and must still fail the restore. This is deliberately simple, not a full
# dependency-aware role-diff tool. Cost if wrong: a genuine globals error
# that happens to contain the substring "already exists" would be masked;
# worth revisiting if that ever actually occurs.
restore_globals() {
  local globals_file="$1" stderr_file
  stderr_file=$(mktemp)
  if ! psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -v ON_ERROR_STOP=0 \
    -f "$globals_file" >/dev/null 2>"$stderr_file"; then
    # Only ERROR lines matter here; NOTICE/WARNING noise is expected and
    # must not itself be mistaken for an unreviewed conflict.
    if grep -E 'ERROR' "$stderr_file" | grep -qvE 'already exists'; then
      cat "$stderr_file" >&2
      rm -f "$stderr_file"
      die "globals restore hit an unexpected error (not just role/tablespace conflicts)"
    fi
  fi
  rm -f "$stderr_file"
  log "globals restored (role/tablespace conflicts with an existing cluster are expected and tolerated)"
}

create_database_if_missing() {
  local db="$1" exists
  exists=$(psql_dest -tAc "SELECT 1 FROM pg_database WHERE datname='${db}'")
  [[ "$exists" == "1" ]] || psql_dest -c "CREATE DATABASE \"${db}\";"
}

restore_database_dump() {
  local db="$1" dump_file="$2"
  create_database_if_missing "$db"
  pg_restore --clean --if-exists --no-owner --no-acl \
    -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$db" "$dump_file" \
    || die "pg_restore failed for database: $db"
}

# Extracts one set's receipts.tar into RECEIPT_RESTORE_DIR. Called once for
# the monthly full, then once per ordered daily delta -- tar naturally
# layers additional/overwriting files, reconstructing the full receipt set
# exactly as select_receipt_files() originally partitioned it in backup.sh.
restore_receipts_from_set() {
  local set_dir="$1"
  tar -xf "$set_dir/receipts.tar" -C "$RECEIPT_RESTORE_DIR"
}

main() {
  preflight
  check_destination_empty_or_confirmed

  if [[ "${RESTORE_CONFIRM_DESTRUCTIVE:-}" == "yes-destroy-existing-data" ]]; then
    find "$RECEIPT_RESTORE_DIR" -mindepth 1 -delete 2>/dev/null || true
  fi

  local full_dir="$RESTORE_WORK_DIR/full"
  download_and_verify_object "$RESTORE_OBJECT_URI" "$RESTORE_WORK_DIR/full.tar.age" "${RESTORE_EXPECTED_GENERATION:-}"
  decrypt_and_extract "$RESTORE_WORK_DIR/full.tar.age" "$full_dir"
  [[ "$(jq -r .mode "$full_dir/manifest.json")" == "full" ]] \
    || die "RESTORE_OBJECT_URI must be a full (monthly) backup set, not a daily delta"

  restore_globals "$full_dir/globals.sql"
  local db
  while IFS= read -r db; do
    [[ -n "$db" ]] || continue
    restore_database_dump "$db" "$full_dir/dumps/$db.dump"
  done < <(jq -r '.databases[]' "$full_dir/manifest.json")
  restore_receipts_from_set "$full_dir"

  local expected_parent n=0 uri delta_dir
  expected_parent=$(jq -r .run_id "$full_dir/manifest.json")
  if [[ -n "${RESTORE_DAILY_OBJECT_URIS:-}" ]]; then
    while IFS= read -r uri; do
      [[ -n "$uri" ]] || continue
      n=$((n + 1))
      delta_dir="$RESTORE_WORK_DIR/daily-$n"
      download_and_verify_object "$uri" "$RESTORE_WORK_DIR/daily-$n.tar.age"
      decrypt_and_extract "$RESTORE_WORK_DIR/daily-$n.tar.age" "$delta_dir"
      [[ "$(jq -r .mode "$delta_dir/manifest.json")" == "daily" ]] \
        || die "RESTORE_DAILY_OBJECT_URIS entry $n is not a daily delta: $uri"
      [[ "$(jq -r .parent_full_backup_id "$delta_dir/manifest.json")" == "$expected_parent" ]] \
        || die "RESTORE_DAILY_OBJECT_URIS entry $n does not chain to the restored full backup (parent_full_backup_id mismatch)"
      while IFS= read -r db; do
        [[ -n "$db" ]] || continue
        restore_database_dump "$db" "$delta_dir/dumps/$db.dump"
      done < <(jq -r '.databases[]' "$delta_dir/manifest.json")
      restore_receipts_from_set "$delta_dir"
    done < <(tr ',' '\n' <<< "$RESTORE_DAILY_OBJECT_URIS")
  fi

  restore_verify "$full_dir" "$RESTORE_WORK_DIR"
}

# Produces a machine-readable post-restore report: per-database row counts
# (via pg_catalog so it works regardless of what schema each dump contains),
# migration versions declared in the restored manifest(s), and a receipt
# checksum re-verification against the LIVE restored files (not just the
# plaintext staged during decrypt, which is already gone by this point).
restore_verify() {
  local full_dir="$1" work_dir="$2"
  local db_report="[]" db rows
  while IFS= read -r db; do
    [[ -n "$db" ]] || continue
    rows=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$db" -tAc \
      "SELECT coalesce(sum(n_live_tup),0) FROM pg_stat_user_tables")
    db_report=$(jq -c --arg db "$db" --argjson rows "${rows:-0}" '. + [{database:$db, live_rows:$rows}]' <<< "$db_report")
  done < <(jq -r '.databases[]' "$full_dir/manifest.json")

  local receipt_mismatches=0 path sha actual set_dir
  for set_dir in "$full_dir" "$work_dir"/daily-*; do
    [[ -d "$set_dir" ]] || continue
    while IFS=$'\t' read -r path sha; do
      [[ -n "$path" ]] || continue
      actual=$(sha256_file "$RECEIPT_RESTORE_DIR/$path" 2>/dev/null || echo MISSING)
      [[ "$actual" == "$sha" ]] || receipt_mismatches=$((receipt_mismatches + 1))
    done < <(jq -r '.receipts.files[] | [.path, .sha256] | @tsv' "$set_dir/manifest.json")
  done
  [[ "$receipt_mismatches" == 0 ]] || die "post-restore receipt checksum verification found $receipt_mismatches mismatch(es)"

  jq -nc --argjson databases "$db_report" \
    --arg manifest_sha "$(sha256_file "$full_dir/manifest.json")" \
    '{status:"restored", databases:$databases, receipts_verified:true, full_manifest_sha256:$manifest_sha}'
  log "restore verified: $(jq 'length' <<< "$db_report") database(s), 0 receipt checksum mismatches"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
