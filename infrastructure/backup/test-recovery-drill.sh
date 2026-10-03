#!/usr/bin/env bash
# Slow, Docker-dependent proof of infrastructure/backup/recovery-drill.sh's
# orchestration (Task 8): a real backup -> real restore onto an empty
# destination, with FAKE deploy/health-check/smoke-test commands standing
# in for what only a disposable VPS or real product can provide. Proves
# the timing/report/migration-comparison/RTO-breach logic; it does NOT
# deploy real images, touch Cloudflare, or run a real product smoke test
# -- those remain explicitly operator-run (see README.md). NOT wired into
# `pnpm ci:test` -- run manually:
#
#   bash infrastructure/backup/test-recovery-drill.sh
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
BACKUP_DIR="$ROOT/infrastructure/backup"
RUN_ID=$$
NET="fbk-test-net-$RUN_ID"
SRC_PG="fbk-test-src-pg-$RUN_ID"
DST_PG="fbk-test-dst-pg-$RUN_ID"
WORKDIR=$(mktemp -d "$HOME/.fbk-test-recovery-drill.XXXXXX")

cleanup() {
  docker rm -f "$SRC_PG" "$DST_PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  [[ "${FBK_TEST_KEEP_WORKDIR:-0}" == 1 ]] || rm -rf "$WORKDIR"
}
trap cleanup EXIT

log() { printf '%s [test-recovery-drill] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

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

log "building backup image (ships backup.sh, restore.sh, recovery-drill.sh)"
docker build -q -t fbk-test-backup:local "$BACKUP_DIR" >/dev/null

docker network create "$NET" >/dev/null
log "seeding SOURCE and starting empty DESTINATION"
start_pg "$SRC_PG"
docker exec "$SRC_PG" psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE expense_app;" >/dev/null
docker exec "$SRC_PG" psql -U postgres -v ON_ERROR_STOP=1 -d expense_app \
  -c "CREATE TABLE seed (id serial primary key); INSERT INTO seed DEFAULT VALUES;" >/dev/null
start_pg "$DST_PG"

mkdir -p "$WORKDIR/state" "$WORKDIR/ciphertext" "$WORKDIR/src-receipts" "$WORKDIR/dst-receipts" "$WORKDIR/fake-bucket"
echo -n test-admin-password > "$WORKDIR/pgpass"
chmod 400 "$WORKDIR/pgpass"
echo '{"type":"service_account"}' > "$WORKDIR/creds.json"
echo receipt-bytes > "$WORKDIR/src-receipts/r1.pdf"

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
    key="${dest#gs://*/}"; target="$bucket_root/$key"
    [[ ! -e "$target" ]] || { echo "exists" >&2; exit 1; }
    mkdir -p "$(dirname "$target")"; cp "$src" "$target"
    date +%s%N > "$target.generation"
    openssl dgst -md5 -binary "$target" | openssl base64 > "$target.md5"
  else
    key="${src#gs://*/}"; cp "$bucket_root/$key" "$dest"
  fi
elif [[ "$1 $2 $3" == "storage objects describe" ]]; then
  dest="$4"; key="${dest#gs://*/}"
  gen=$(cat "$bucket_root/$key.generation"); md5=$(cat "$bucket_root/$key.md5")
  for a in "$@"; do case "$a" in --format=value\(generation\)) echo "$gen"; exit 0 ;; esac; done
  printf '{"generation":"%s","md5Hash":"%s"}\n' "$gen" "$md5"
else
  echo "unsupported fake gcloud invocation: $*" >&2; exit 1
fi
SH
chmod +x "$WORKDIR/fake-gcloud.sh"

log "generating a temporary age identity"
docker run --rm --entrypoint age-keygen fbk-test-backup:local >"$WORKDIR/identity.txt" 2>/dev/null
age_recipient=$(grep '# public key:' "$WORKDIR/identity.txt" | awk '{print $NF}')

log "running backup.sh against SOURCE to produce a full backup set"
docker run --rm --network "$NET" \
  --read-only --tmpfs /staging:size=256m \
  -v "$WORKDIR/pgpass:/run/secrets/pgpass:ro" -v "$WORKDIR/creds.json:/run/secrets/creds.json:ro" \
  -v "$WORKDIR/state:/state" -v "$WORKDIR/ciphertext:/ciphertext" -v "$WORKDIR/src-receipts:/receipts:ro" \
  -v "$WORKDIR/fake-bucket:/fake-bucket" -v "$WORKDIR/fake-gcloud.sh:/usr/local/bin/gcloud:ro" \
  -e PGHOST="$SRC_PG" -e PGPORT=5432 -e PGUSER=postgres -e PGPASSWORD_FILE=/run/secrets/pgpass \
  -e BACKUP_GCS_URI=gs://fbk-test-bucket -e BACKUP_HOST_ID=fbk-test-host -e AGE_RECIPIENT="$age_recipient" \
  -e RECEIPT_STORAGE_DIR=/receipts -e BACKUP_STATE_DIR=/state -e BACKUP_CIPHERTEXT_DIR=/ciphertext \
  -e GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/creds.json \
  fbk-test-backup:local >"$WORKDIR/backup.log" 2>&1 || { cat "$WORKDIR/backup.log" >&2; fail "seed backup failed"; }
full_object_uri=$(jq -r .object_uri "$WORKDIR/state/last-success.json")

# Fix round 2: recovery-drill.sh's verify_postgres_reachable()/
# verify_receipt_volume() shell out to `docker exec` against SIBLING
# containers -- real `docker exec` needs a real docker CLI talking to the
# real daemon socket, which the pinned backup image deliberately does not
# ship (it is -read-only, object-creator-scoped, and never needs to
# control other containers during an automated backup run). Ruling:
# mounting the host docker socket is done ONLY here, for this
# operator-run, never-automated recovery-drill test -- never for
# backup.sh's own systemd-scheduled runs. The extracted CLI is pinned by
# digest and matches this image's emulated linux/amd64 platform; every
# command it can run is still scoped to the exact fbk-test-* container
# names this script itself creates and passes in.
log "extracting a matching-arch docker CLI for the (operator-only) recovery-drill docker-exec checks"
docker pull -q --platform linux/amd64 docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c >/dev/null
docker_cli_container=$(docker create --platform linux/amd64 docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c)
docker cp "$docker_cli_container:/usr/local/bin/docker" "$WORKDIR/docker-cli-amd64"
docker rm "$docker_cli_container" >/dev/null
chmod +x "$WORKDIR/docker-cli-amd64"

run_drill() {
  # run_drill RESTORE_WORK_SUBDIR REPORT_FILE [extra -e args...]
  local work_subdir="$1" report_file="$2"; shift 2
  rm -rf "${WORKDIR:?}/dst-receipts-tmp"
  mkdir -p "$WORKDIR/dst-receipts-tmp"
  docker run --rm --network "$NET" \
    -v "$WORKDIR/pgpass:/run/secrets/pgpass:ro" -v "$WORKDIR/creds.json:/run/secrets/creds.json:ro" \
    -v "$WORKDIR/identity.txt:/run/secrets/identity.txt:ro" -v "$WORKDIR/fake-bucket:/fake-bucket:ro" \
    -v "$WORKDIR/fake-gcloud.sh:/usr/local/bin/gcloud:ro" -v "$WORKDIR/dst-receipts-tmp:/receipts" \
    -v "$WORKDIR:/host-workdir" \
    -v "$WORKDIR/docker-cli-amd64:/usr/local/bin/docker:ro" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e PGHOST="$DST_PG" -e PGPORT=5432 -e PGUSER=postgres -e PGPASSWORD_FILE=/run/secrets/pgpass \
    -e RESTORE_AGE_IDENTITY_FILE=/run/secrets/identity.txt \
    -e RESTORE_GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/creds.json \
    -e RESTORE_OBJECT_URI="$full_object_uri" \
    -e RESTORE_WORK_DIR="/restore-work-${work_subdir}" \
    -e RECEIPT_RESTORE_DIR=/receipts \
    -e RECOVERY_REPORT_FILE="/host-workdir/${report_file}" \
    -e RESTORE_CONFIRM_DESTRUCTIVE=yes-destroy-existing-data \
    -e RECOVERY_POSTGRES_CONTAINER="$DST_PG" \
    -e RECOVERY_VERIFY_ATTEMPTS=3 -e RECOVERY_VERIFY_DELAY_SECONDS=1 \
    "$@" \
    --entrypoint /usr/local/lib/family-app-backup/recovery-drill.sh \
    fbk-test-backup:local
}

log "scenario 1: everything passes within the RTO deadline"
docker exec "$DST_PG" psql -U postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS expense_app;" >/dev/null
if ! run_drill "s1" "report-s1.json" \
  -e RECOVERY_DEPLOY_CMD=true -e RECOVERY_HEALTH_CHECK_CMD=true -e RECOVERY_SMOKE_TEST_CMD=true \
  -e RECOVERY_DEADLINE_SECONDS=300 >"$WORKDIR/drill1.log" 2>&1; then
  cat "$WORKDIR/drill1.log" >&2
  fail "scenario 1 (should pass) exited nonzero"
fi
jq -e '.overall_pass == true and .restore_passed == true and .deploy_passed == true and .postgres_passed == true and .receipt_volume_passed == true and .health_check_passed == true and .smoke_test_passed == true and .rto_breached == false' \
  "$WORKDIR/report-s1.json" >/dev/null || { cat "$WORKDIR/report-s1.json" >&2; fail "scenario 1 report shape wrong"; }
log "PASS: scenario 1 (all steps pass, including real postgres_passed against \$DST_PG and skipped-as-passed receipt_volume_passed, RTO not breached)"

log "scenario 2: health-check fails -> overall_pass false, but script still writes a report"
docker exec "$DST_PG" psql -U postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS expense_app;" >/dev/null
if run_drill "s2" "report-s2.json" \
  -e RECOVERY_DEPLOY_CMD=true -e RECOVERY_HEALTH_CHECK_CMD=false -e RECOVERY_SMOKE_TEST_CMD=true \
  -e RECOVERY_DEADLINE_SECONDS=300 >"$WORKDIR/drill2.log" 2>&1; then
  cat "$WORKDIR/drill2.log" >&2
  fail "scenario 2 (health-check fails) should have exited nonzero"
fi
jq -e '.overall_pass == false and .health_check_passed == false and .restore_passed == true' \
  "$WORKDIR/report-s2.json" >/dev/null || { cat "$WORKDIR/report-s2.json" >&2; fail "scenario 2 report shape wrong"; }
log "PASS: scenario 2 (a failed health check fails the drill and is reported)"

log "scenario 3: RTO breach (deadline=0) fails the drill even though every step passed"
docker exec "$DST_PG" psql -U postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS expense_app;" >/dev/null
if run_drill "s3" "report-s3.json" \
  -e RECOVERY_DEPLOY_CMD=true -e RECOVERY_HEALTH_CHECK_CMD=true -e RECOVERY_SMOKE_TEST_CMD=true \
  -e RECOVERY_DEADLINE_SECONDS=0 >"$WORKDIR/drill3.log" 2>&1; then
  cat "$WORKDIR/drill3.log" >&2
  fail "scenario 3 (RTO breach) should have exited nonzero"
fi
jq -e '.overall_pass == false and .rto_breached == true and .restore_passed == true and .health_check_passed == true' \
  "$WORKDIR/report-s3.json" >/dev/null || { cat "$WORKDIR/report-s3.json" >&2; fail "scenario 3 report shape wrong"; }
log "PASS: scenario 3 (exceeding the RTO deadline fails the drill even when every step passed)"

log "scenario 4: schema_migration_versions mismatch is reported, migrations are not run"
docker exec "$DST_PG" psql -U postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS expense_app;" >/dev/null
if ! run_drill "s4" "report-s4.json" \
  -e RECOVERY_SUPPORTED_MIGRATION_VERSIONS="app=9999" \
  -e RECOVERY_MIGRATE_CMD="touch /host-workdir/migrate-ran.marker" \
  -e RECOVERY_DEPLOY_CMD=true -e RECOVERY_HEALTH_CHECK_CMD=true \
  -e RECOVERY_DEADLINE_SECONDS=300 >"$WORKDIR/drill4.log" 2>&1; then
  cat "$WORKDIR/drill4.log" >&2
  fail "scenario 4 (mismatch should not itself fail the drill) exited nonzero"
fi
jq -e '.migration_versions_match == false and .migrations_run == false and .overall_pass == true' \
  "$WORKDIR/report-s4.json" >/dev/null || { cat "$WORKDIR/report-s4.json" >&2; fail "scenario 4 report shape wrong"; }
[[ ! -f "$WORKDIR/migrate-ran.marker" ]] || fail "scenario 4: migrations ran despite a version mismatch"
log "PASS: scenario 4 (a migration-version mismatch is reported and migrations are skipped, not a drill failure by itself)"

log "scenario 5: wrong/unreachable Postgres container name fails the drill (fix round 2)"
docker exec "$DST_PG" psql -U postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS expense_app;" >/dev/null
if run_drill "s5" "report-s5.json" \
  -e RECOVERY_DEPLOY_CMD=true -e RECOVERY_HEALTH_CHECK_CMD=true \
  -e RECOVERY_POSTGRES_CONTAINER=this-container-does-not-exist \
  -e RECOVERY_VERIFY_ATTEMPTS=1 \
  -e RECOVERY_DEADLINE_SECONDS=300 >"$WORKDIR/drill5.log" 2>&1; then
  cat "$WORKDIR/drill5.log" >&2
  fail "scenario 5 (unreachable postgres container) should have exited nonzero"
fi
jq -e '.overall_pass == false and .postgres_passed == false and .restore_passed == true' \
  "$WORKDIR/report-s5.json" >/dev/null || { cat "$WORKDIR/report-s5.json" >&2; fail "scenario 5 report shape wrong"; }
log "PASS: scenario 5 (an unreachable/wrong Postgres container name fails the drill, caught here rather than in a live deploy)"

log "PASS: Task 8 recovery-drill.sh orchestration proof (pass/health-fail/RTO-breach/migration-mismatch/wrong-postgres-container)"
