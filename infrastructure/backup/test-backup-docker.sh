#!/usr/bin/env bash
# Slow, Docker-dependent proof of infrastructure/backup/backup.sh against a
# real disposable PostgreSQL 17 server. NOT wired into `pnpm ci:test` (see
# README.md) -- run manually:
#
#   bash infrastructure/backup/test-backup-docker.sh
#
# Isolation: every container/network/volume this script creates is
# prefixed fbk-test- and removed on exit (trap). It never touches any
# other container (e.g. local-llm-observability-postgres-1, geo-types-pg,
# geo-orch-pg) or the "infrastructure"/"expense-tax-*" compose projects.
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
BACKUP_DIR="$ROOT/infrastructure/backup"
RUN_ID=$$
NET="fbk-test-net-$RUN_ID"
PG="fbk-test-pg-$RUN_ID"
# Ruling: Docker Desktop on this machine only bind-mounts paths under
# $HOME; a workdir under the default $TMPDIR (/var/folders/.../T or /tmp)
# silently turns a single-file bind mount into an empty directory inside
# the container instead of erroring -- reproduced directly against this
# image during this implementation. Cost if wrong: every file-mount test
# below would read empty/missing credentials instead of failing loudly, so
# this is deliberately placed under $HOME, not the OS default tmp root.
WORKDIR=$(mktemp -d "$HOME/.fbk-test-backup-docker.XXXXXX")

cleanup() {
  docker rm -f "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  [[ "${FBK_TEST_KEEP_WORKDIR:-0}" == 1 ]] || rm -rf "$WORKDIR"
}
trap cleanup EXIT

log() { printf '%s [test-backup-docker] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# Runs backup.sh inside the pinned image with the standard env contract
# plus any extra `-e KEY=VAL` arguments given. Output goes to $WORKDIR/backup.log.
run_backup() {
  docker run --rm --network "$NET" \
    --read-only --tmpfs /staging:size=256m \
    -v "$WORKDIR/pgpass:/run/secrets/pgpass:ro" \
    -v "$WORKDIR/creds.json:/run/secrets/creds.json:ro" \
    -v "$WORKDIR/state:/state" \
    -v "$WORKDIR/ciphertext:/ciphertext" \
    -v "$WORKDIR/receipts:/receipts:ro" \
    -e PGHOST="$PG" -e PGPORT=5432 -e PGUSER=postgres \
    -e PGPASSWORD_FILE=/run/secrets/pgpass \
    -e BACKUP_GCS_URI=gs://fbk-test-bucket \
    -e BACKUP_HOST_ID=fbk-test-host \
    -e AGE_RECIPIENT=age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p \
    -e RECEIPT_STORAGE_DIR=/receipts \
    -e BACKUP_STATE_DIR=/state \
    -e BACKUP_CIPHERTEXT_DIR=/ciphertext \
    -e GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/creds.json \
    "$@" \
    fbk-test-backup:local
}

set_receipt_mtime() {
  local file="$1" iso="$2" epoch
  epoch=$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$iso" +%s 2>/dev/null || date -u -d "$iso" +%s)
  if date -r "$epoch" +%Y%m%d%H%M.%S >/tmp/.fbk_touchfmt.$$ 2>/dev/null; then
    touch -t "$(cat /tmp/.fbk_touchfmt.$$)" "$file"
  else
    touch -d "@$epoch" "$file"
  fi
  rm -f /tmp/.fbk_touchfmt.$$
}

log "building backup image"
docker build -q -t fbk-test-backup:local "$BACKUP_DIR" >/dev/null

log "creating isolated network $NET"
docker network create "$NET" >/dev/null

log "starting disposable PostgreSQL 17 ($PG)"
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_PASSWORD=test-admin-password \
  -e POSTGRES_USER=postgres \
  pgvector/pgvector:pg17 >/dev/null

for _ in $(seq 1 30); do
  docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1 || fail "disposable PostgreSQL never became ready"

log "seeding representative App, Foundry, Temporal, visibility, and mailbox databases"
for db in expense_app expense_foundry temporal temporal_visibility mailbox_broker; do
  docker exec "$PG" psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db;" >/dev/null
  docker exec "$PG" psql -U postgres -v ON_ERROR_STOP=1 -d "$db" \
    -c "CREATE TABLE seed (id serial primary key, note text); INSERT INTO seed (note) VALUES ('$db-row-1'), ('$db-row-2');" >/dev/null
done

mkdir -p "$WORKDIR/state" "$WORKDIR/ciphertext" "$WORKDIR/receipts" "$WORKDIR/dump-out"
echo -n test-admin-password > "$WORKDIR/pgpass"
chmod 400 "$WORKDIR/pgpass"
echo '{"type":"service_account"}' > "$WORKDIR/creds.json"

# ---------------------------------------------------------------------------
# Task 3: dump + validate every non-template database
# ---------------------------------------------------------------------------
log "running backup.sh (BACKUP_DUMP_ONLY=1) inside the pinned image"
run_backup -v "$WORKDIR/dump-out:/dump-out" -e BACKUP_DUMP_ONLY=1 -e BACKUP_DUMP_ONLY_COPY_TO=/dump-out \
  >"$WORKDIR/backup.log" 2>&1 \
  || { cat "$WORKDIR/backup.log" >&2; fail "backup.sh (dump-only) exited nonzero"; }
cat "$WORKDIR/backup.log" >&2

[[ -s "$WORKDIR/dump-out/globals.sql" ]] || fail "globals.sql missing or empty"

inventory="$WORKDIR/dump-out/database-inventory.json"
[[ -s "$inventory" ]] || fail "database-inventory.json missing"

for db in expense_app expense_foundry temporal temporal_visibility mailbox_broker; do
  jq -e --arg db "$db" '.databases | index($db) != null' "$inventory" >/dev/null \
    || fail "manifest database list missing $db"
  [[ -f "$WORKDIR/dump-out/dumps/$db.dump" ]] || fail "dump file missing for $db"
  docker run --rm -v "$WORKDIR/dump-out/dumps/$db.dump:/d.dump:ro" --entrypoint pg_restore \
    fbk-test-backup:local --list /d.dump >/dev/null \
    || fail "pg_restore --list failed for $db dump (post-hoc re-validation)"
done
jq -e '.databases | index("postgres") == null' "$inventory" >/dev/null \
  || fail "admin 'postgres' database must be excluded from the backup set"

sha_recorded=$(jq -r '.files[] | select(.name == "globals.sql") | .sha256' "$inventory")
sha_actual=$(sha256sum "$WORKDIR/dump-out/globals.sql" | awk '{print $1}')
[[ "$sha_recorded" == "$sha_actual" ]] || fail "globals.sql checksum in manifest does not match actual file"

log "simulating a mid-dump failure to prove no marker/state is touched"
echo '{"sentinel":"untouched"}' > "$WORKDIR/state/last-success.json"
before_sha=$(sha256sum "$WORKDIR/state/last-success.json" | awk '{print $1}')
if run_backup -e BACKUP_DUMP_ONLY=1 -e PGUSER=does-not-exist-role >/dev/null 2>&1; then
  fail "backup.sh unexpectedly succeeded with an invalid PGUSER"
fi
after_sha=$(sha256sum "$WORKDIR/state/last-success.json" | awk '{print $1}')
[[ "$before_sha" == "$after_sha" ]] || fail "a failed dump mutated the prior success marker"
log "PASS: failed dump left the prior success marker byte-identical"
rm -f "$WORKDIR/state/last-success.json"

log "PASS: Task 3 dump + validation proof (real PostgreSQL 17, 5 representative databases)"

# ---------------------------------------------------------------------------
# Task 4: receipt capture + manifest, against the real receipts dir above
# (BACKUP_MANIFEST_ONLY=1 stops right after manifest validation, before the
# Task 5 encrypt/upload pipeline this script does not yet exercise).
# ---------------------------------------------------------------------------
log "first run (no marker): must be a full receipt backup"
echo r1 > "$WORKDIR/receipts/r1.pdf"
echo r2 > "$WORKDIR/receipts/r2.pdf"
run_backup -v "$WORKDIR/dump-out:/dump-out" \
  -e BACKUP_MANIFEST_ONLY=1 -e BACKUP_DUMP_ONLY_COPY_TO=/dump-out \
  >"$WORKDIR/backup.log" 2>&1 || { cat "$WORKDIR/backup.log" >&2; fail "first-run manifest build failed"; }
manifest="$WORKDIR/dump-out/manifest.json"
[[ "$(jq -r .mode "$manifest")" == "full" ]] || fail "first run must be mode=full"
[[ "$(jq -r .receipts.file_count "$manifest")" == "2" ]] || fail "first run must archive both seeded receipts"
log "PASS: first run with no marker is a full receipt backup (2 files)"

log "same-month rerun: must be a daily delta containing only the new file"
# Promote this run's manifest into a real marker, as Task 5 will once
# upload succeeds, then add one more receipt before the next run.
jq -n --argjson m "$(cat "$manifest")" \
  '{cutoff_epoch: ($m.cutoff | fromdateiso8601), last_full_period: ($m.cutoff | fromdateiso8601 | strftime("%Y-%m")), parent_full_backup_id: $m.run_id}' \
  > "$WORKDIR/state/last-success.json"
# Margin here must exceed, not just equal, the clock skew between this host
# (which stamps r3.pdf's mtime directly) and the Docker Desktop Linux VM
# (whose clock backup.sh reads for "now"/cutoff) -- observed ~1s drift
# during this implementation made a 1s sleep an exact tie, not a margin.
sleep 3
echo r3 > "$WORKDIR/receipts/r3.pdf"
run_backup -v "$WORKDIR/dump-out-2:/dump-out" \
  -e BACKUP_MANIFEST_ONLY=1 -e BACKUP_DUMP_ONLY_COPY_TO=/dump-out \
  >"$WORKDIR/backup2.log" 2>&1 || { cat "$WORKDIR/backup2.log" >&2; fail "daily delta manifest build failed"; }
manifest2="$WORKDIR/dump-out-2/manifest.json"
[[ "$(jq -r .mode "$manifest2")" == "daily" ]] || fail "same-month rerun must be mode=daily"
[[ "$(jq -r .receipts.file_count "$manifest2")" == "1" ]] || fail "daily delta must contain exactly the one new receipt"
[[ "$(jq -r '.receipts.files[0].path' "$manifest2")" == "r3.pdf" ]] || fail "daily delta must be the newly arrived file, not an old one"
[[ "$(jq -r .parent_full_backup_id "$manifest2")" == "$(jq -r .run_id "$manifest")" ]] \
  || fail "daily delta must carry the prior full backup's run_id forward"
log "PASS: same-month rerun is a daily delta containing only the new receipt"

log "unchanged receipts: next run with no new files must succeed with zero receipts"
jq -n --argjson m "$(cat "$manifest2")" \
  '{cutoff_epoch: ($m.cutoff | fromdateiso8601), last_full_period: ($m.cutoff | fromdateiso8601 | strftime("%Y-%m")), parent_full_backup_id: $m.parent_full_backup_id}' \
  > "$WORKDIR/state/last-success.json"
run_backup -v "$WORKDIR/dump-out-3:/dump-out" \
  -e BACKUP_MANIFEST_ONLY=1 -e BACKUP_DUMP_ONLY_COPY_TO=/dump-out \
  >"$WORKDIR/backup3.log" 2>&1 || { cat "$WORKDIR/backup3.log" >&2; fail "unchanged-receipts manifest build failed"; }
manifest3="$WORKDIR/dump-out-3/manifest.json"
[[ "$(jq -r .receipts.file_count "$manifest3")" == "0" ]] || fail "unchanged receipts must archive zero files"
log "PASS: unchanged receipts window still succeeds with a valid, empty archive"

log "new calendar month: must start a new full backup regardless of marker"
jq -n --argjson m "$(cat "$manifest2")" \
  '{cutoff_epoch: ($m.cutoff | fromdateiso8601), last_full_period: "2000-01", parent_full_backup_id: $m.parent_full_backup_id}' \
  > "$WORKDIR/state/last-success.json"
run_backup -v "$WORKDIR/dump-out-4:/dump-out" \
  -e BACKUP_MANIFEST_ONLY=1 -e BACKUP_DUMP_ONLY_COPY_TO=/dump-out \
  >"$WORKDIR/backup4.log" 2>&1 || { cat "$WORKDIR/backup4.log" >&2; fail "new-month full manifest build failed"; }
manifest4="$WORKDIR/dump-out-4/manifest.json"
[[ "$(jq -r .mode "$manifest4")" == "full" ]] || fail "a new calendar month must force mode=full"
[[ "$(jq -r .receipts.file_count "$manifest4")" == "3" ]] || fail "a new full must re-archive every receipt, not just deltas"
log "PASS: a new calendar month starts a fresh full receipt backup (all 3 files)"

log "boundary: a receipt arriving strictly after the frozen cutoff belongs to the NEXT run"
jq -n --argjson m "$(cat "$manifest4")" \
  '{cutoff_epoch: ($m.cutoff | fromdateiso8601), last_full_period: ($m.cutoff | fromdateiso8601 | strftime("%Y-%m")), parent_full_backup_id: $m.run_id}' \
  > "$WORKDIR/state/last-success.json"
# r4 is written with a future mtime, simulating arrival after this run's
# cutoff is frozen -- select_receipt_files must exclude it this time.
echo r4 > "$WORKDIR/receipts/r4.pdf"
set_receipt_mtime "$WORKDIR/receipts/r4.pdf" "$(date -u -v+1d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ)"
run_backup -v "$WORKDIR/dump-out-5:/dump-out" \
  -e BACKUP_MANIFEST_ONLY=1 -e BACKUP_DUMP_ONLY_COPY_TO=/dump-out \
  >"$WORKDIR/backup5.log" 2>&1 || { cat "$WORKDIR/backup5.log" >&2; fail "boundary-cutoff manifest build failed"; }
manifest5="$WORKDIR/dump-out-5/manifest.json"
[[ "$(jq -r .receipts.file_count "$manifest5")" == "0" ]] \
  || fail "a receipt with mtime after the frozen cutoff must not be archived by this run"
log "PASS: a receipt arriving after the frozen cutoff is deferred to the next run"

log "PASS: Task 4 receipt capture + manifest proof (full/daily/unchanged/new-month/boundary)"
