#!/usr/bin/env bash
# Slow, Docker-dependent end-to-end proof of infrastructure/backup/restore.sh:
# seeded SOURCE PostgreSQL + receipts -> real backup.sh -> a full backup set
# plus one daily delta -> a completely empty DESTINATION PostgreSQL + receipt
# dir -> real restore.sh -> verify every database, row count, and receipt
# checksum landed correctly. NOT wired into `pnpm ci:test` -- run manually:
#
#   bash infrastructure/backup/test-restore.sh
#
# Isolation: every container/network/volume this script creates is
# prefixed fbk-test- and removed on exit (trap). It never touches any
# other container or the "infrastructure"/"expense-tax-*" compose projects.
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
BACKUP_DIR="$ROOT/infrastructure/backup"
RUN_ID=$$
NET="fbk-test-net-$RUN_ID"
SRC_PG="fbk-test-src-pg-$RUN_ID"
DST_PG="fbk-test-dst-pg-$RUN_ID"
# Ruling (see test-backup-docker.sh): Docker Desktop here only bind-mounts
# paths under $HOME.
WORKDIR=$(mktemp -d "$HOME/.fbk-test-restore.XXXXXX")

cleanup() {
  docker rm -f "$SRC_PG" "$DST_PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  [[ "${FBK_TEST_KEEP_WORKDIR:-0}" == 1 ]] || rm -rf "$WORKDIR"
}
trap cleanup EXIT

log() { printf '%s [test-restore] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

DATABASES=(expense_app expense_foundry temporal temporal_visibility mailbox_broker)

start_pg() {
  local name="$1"
  docker run -d --name "$name" --network "$NET" \
    -e POSTGRES_PASSWORD=test-admin-password -e POSTGRES_USER=postgres \
    pgvector/pgvector:pg17 >/dev/null
  for _ in $(seq 1 30); do
    docker exec "$name" pg_isready -U postgres >/dev/null 2>&1 && return 0
    sleep 1
  done
  fail "$name never became ready"
}

log "building backup image (ships both backup.sh and restore.sh)"
docker build -q -t fbk-test-backup:local "$BACKUP_DIR" >/dev/null

log "creating isolated network $NET"
docker network create "$NET" >/dev/null

log "starting and seeding SOURCE PostgreSQL 17 ($SRC_PG)"
start_pg "$SRC_PG"
for db in "${DATABASES[@]}"; do
  docker exec "$SRC_PG" psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db;" >/dev/null
  docker exec "$SRC_PG" psql -U postgres -v ON_ERROR_STOP=1 -d "$db" \
    -c "CREATE TABLE seed (id serial primary key, note text); INSERT INTO seed (note) VALUES ('$db-row-1'), ('$db-row-2');" >/dev/null
done

mkdir -p "$WORKDIR/state" "$WORKDIR/ciphertext" "$WORKDIR/src-receipts" "$WORKDIR/dst-receipts" "$WORKDIR/fake-bucket"
echo -n test-admin-password > "$WORKDIR/pgpass"
chmod 400 "$WORKDIR/pgpass"
echo '{"type":"service_account"}' > "$WORKDIR/creds.json"
echo full-receipt-bytes > "$WORKDIR/src-receipts/full-receipt.pdf"

cat > "$WORKDIR/fake-gcloud.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
bucket_root=/fake-bucket
if [[ "$1" == "storage" && "$2" == "cp" ]]; then
  shift 2
  src=""; dest=""
  for a in "$@"; do
    case "$a" in --if-generation-match=*) : ;; *) if [[ -z "$src" ]]; then src="$a"; else dest="$a"; fi ;; esac
  done
  if [[ "$dest" == gs://* ]]; then
    key="${dest#gs://*/}"
    target="$bucket_root/$key"
    if [[ -e "$target" ]]; then echo "precondition failed: already exists" >&2; exit 1; fi
    mkdir -p "$(dirname "$target")"
    cp "$src" "$target"
    date +%s%N > "$target.generation"
    openssl dgst -md5 -binary "$target" | openssl base64 > "$target.md5"
  else
    key="${src#gs://*/}"
    cp "$bucket_root/$key" "$dest"
  fi
elif [[ "$1 $2 $3" == "storage objects describe" ]]; then
  dest="$4"
  key="${dest#gs://*/}"
  gen=$(cat "$bucket_root/$key.generation")
  md5=$(cat "$bucket_root/$key.md5")
  for a in "$@"; do
    case "$a" in
      --format=value\(generation\)) echo "$gen"; exit 0 ;;
    esac
  done
  printf '{"generation":"%s","md5Hash":"%s"}\n' "$gen" "$md5"
else
  echo "unsupported fake gcloud invocation: $*" >&2
  exit 1
fi
SH
chmod +x "$WORKDIR/fake-gcloud.sh"

log "generating a temporary age identity (real age-keygen, pinned image)"
docker run --rm --entrypoint age-keygen fbk-test-backup:local >"$WORKDIR/identity.txt" 2>/dev/null
age_recipient=$(grep '# public key:' "$WORKDIR/identity.txt" | awk '{print $NF}')
[[ -n "$age_recipient" ]] || fail "could not parse a public key out of age-keygen output"

run_backup_against_source() {
  docker run --rm --network "$NET" \
    --read-only --tmpfs /staging:size=256m \
    -v "$WORKDIR/pgpass:/run/secrets/pgpass:ro" \
    -v "$WORKDIR/creds.json:/run/secrets/creds.json:ro" \
    -v "$WORKDIR/state:/state" \
    -v "$WORKDIR/ciphertext:/ciphertext" \
    -v "$WORKDIR/src-receipts:/receipts:ro" \
    -v "$WORKDIR/fake-bucket:/fake-bucket" \
    -v "$WORKDIR/fake-gcloud.sh:/usr/local/bin/gcloud:ro" \
    -e PGHOST="$SRC_PG" -e PGPORT=5432 -e PGUSER=postgres \
    -e PGPASSWORD_FILE=/run/secrets/pgpass \
    -e BACKUP_GCS_URI=gs://fbk-test-bucket \
    -e BACKUP_HOST_ID=fbk-test-host \
    -e AGE_RECIPIENT="$age_recipient" \
    -e RECEIPT_STORAGE_DIR=/receipts \
    -e BACKUP_STATE_DIR=/state \
    -e BACKUP_CIPHERTEXT_DIR=/ciphertext \
    -e GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/creds.json \
    fbk-test-backup:local
}

log "running the full backup.sh pipeline against SOURCE (produces the monthly full set)"
run_backup_against_source >"$WORKDIR/backup-full.log" 2>&1 \
  || { cat "$WORKDIR/backup-full.log" >&2; fail "full backup against source failed"; }
full_object_uri=$(jq -r .object_uri "$WORKDIR/state/last-success.json")
log "full backup set: $full_object_uri"

log "seeding one more receipt and running backup.sh again (produces a daily delta)"
sleep 3
echo daily-receipt-bytes > "$WORKDIR/src-receipts/daily-receipt.pdf"
run_backup_against_source >"$WORKDIR/backup-daily.log" 2>&1 \
  || { cat "$WORKDIR/backup-daily.log" >&2; fail "daily backup against source failed"; }
daily_object_uri=$(jq -r .object_uri "$WORKDIR/state/last-success.json")
[[ "$daily_object_uri" != "$full_object_uri" ]] || fail "second run produced the same object as the first"
log "daily delta set: $daily_object_uri"

log "starting empty DESTINATION PostgreSQL 17 ($DST_PG)"
start_pg "$DST_PG"

log "refusing restore onto a non-empty destination without confirmation"
docker exec "$DST_PG" psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE leftover_db;" >/dev/null
if docker run --rm --network "$NET" \
  -v "$WORKDIR/pgpass:/run/secrets/pgpass:ro" \
  -v "$WORKDIR/creds.json:/run/secrets/creds.json:ro" \
  -v "$WORKDIR/identity.txt:/run/secrets/identity.txt:ro" \
  -v "$WORKDIR/fake-bucket:/fake-bucket:ro" \
  -v "$WORKDIR/fake-gcloud.sh:/usr/local/bin/gcloud:ro" \
  -v "$WORKDIR/dst-receipts:/receipts" \
  -e PGHOST="$DST_PG" -e PGPORT=5432 -e PGUSER=postgres \
  -e PGPASSWORD_FILE=/run/secrets/pgpass \
  -e RESTORE_AGE_IDENTITY_FILE=/run/secrets/identity.txt \
  -e RESTORE_GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/creds.json \
  -e RESTORE_OBJECT_URI="$full_object_uri" \
  -e RESTORE_WORK_DIR=/restore-work \
  -e RECEIPT_RESTORE_DIR=/receipts \
  --entrypoint /usr/local/lib/family-app-backup/restore.sh \
  fbk-test-backup:local >/dev/null 2>&1; then
  fail "restore.sh proceeded against a non-empty destination without confirmation"
fi
docker exec "$DST_PG" psql -U postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE leftover_db;" >/dev/null
log "PASS: restore.sh refuses a non-empty destination without RESTORE_CONFIRM_DESTRUCTIVE"

log "restoring: full backup + ordered daily delta onto the empty destination"
docker run --rm --network "$NET" \
  -v "$WORKDIR/pgpass:/run/secrets/pgpass:ro" \
  -v "$WORKDIR/creds.json:/run/secrets/creds.json:ro" \
  -v "$WORKDIR/identity.txt:/run/secrets/identity.txt:ro" \
  -v "$WORKDIR/fake-bucket:/fake-bucket:ro" \
  -v "$WORKDIR/fake-gcloud.sh:/usr/local/bin/gcloud:ro" \
  -v "$WORKDIR/dst-receipts:/receipts" \
  -e PGHOST="$DST_PG" -e PGPORT=5432 -e PGUSER=postgres \
  -e PGPASSWORD_FILE=/run/secrets/pgpass \
  -e RESTORE_AGE_IDENTITY_FILE=/run/secrets/identity.txt \
  -e RESTORE_GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/creds.json \
  -e RESTORE_OBJECT_URI="$full_object_uri" \
  -e RESTORE_DAILY_OBJECT_URIS="$daily_object_uri" \
  -e RESTORE_WORK_DIR=/restore-work \
  -e RECEIPT_RESTORE_DIR=/receipts \
  --entrypoint /usr/local/lib/family-app-backup/restore.sh \
  fbk-test-backup:local >"$WORKDIR/restore.log" 2>&1 \
  || { cat "$WORKDIR/restore.log" >&2; fail "restore.sh exited nonzero"; }
cat "$WORKDIR/restore.log" >&2

log "verifying every database and row count landed on the destination"
for db in "${DATABASES[@]}"; do
  count=$(docker exec "$DST_PG" psql -U postgres -d "$db" -tAc "SELECT count(*) FROM seed")
  [[ "$count" == "2" ]] || fail "database $db has $count seed rows after restore, expected 2"
done
log "PASS: all ${#DATABASES[@]} databases restored with correct row counts"

log "verifying receipts from BOTH the full set and the daily delta are present with correct bytes"
[[ -f "$WORKDIR/dst-receipts/full-receipt.pdf" ]] || fail "full-receipt.pdf missing after restore"
[[ "$(cat "$WORKDIR/dst-receipts/full-receipt.pdf")" == "full-receipt-bytes" ]] || fail "full-receipt.pdf content mismatch"
[[ -f "$WORKDIR/dst-receipts/daily-receipt.pdf" ]] || fail "daily-receipt.pdf missing after restore"
[[ "$(cat "$WORKDIR/dst-receipts/daily-receipt.pdf")" == "daily-receipt-bytes" ]] || fail "daily-receipt.pdf content mismatch"
log "PASS: full + daily receipts both present with correct bytes"

report_line=$(grep '"status":"restored"' "$WORKDIR/restore.log")
echo "$report_line" | jq -e '.status == "restored" and .receipts_verified == true and (.databases | length) == 5' >/dev/null \
  || fail "restore.sh's final report is missing or has the wrong shape: $report_line"
log "PASS: restore.sh emitted a final machine-readable verification report"

log "PASS: Task 7 end-to-end restore proof (seeded source -> empty destination, full + daily delta)"
