#!/usr/bin/env bash
# Fast, Docker-free checks for infrastructure/backup/{lib.sh,backup.sh}.
# No network, no containers, no real PostgreSQL/age/gcloud: every external
# tool backup.sh shells out to is replaced by a stub binary on PATH so this
# runs in plain CI (same pattern as infrastructure/temporal/test-temporal-infrastructure.sh).
# Slow Docker end-to-end proof lives in test-backup-docker.sh (not run here).
# This harness deliberately builds KEY=VALUE env assignments as unquoted
# word-split arguments to `env` (e.g. `env $(base_env | tr '\n' ' ')`) so a
# NEWLINE-separated var=value list becomes separate argv entries. Every
# value here is a fixed test fixture with no spaces/globs, so the split is
# intentional, not a bug.
# shellcheck disable=SC2046,SC2086
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
BACKUP_DIR="$ROOT/infrastructure/backup"
PASS=0
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$PASS" "$*"; }

# ---------------------------------------------------------------------------
# Part A: lib.sh validation primitives (pure functions, no subprocess stubs)
# ---------------------------------------------------------------------------
# shellcheck source=lib.sh
source "$BACKUP_DIR/lib.sh"

expect_die() {
  local desc="$1"; shift
  if ( "$@" ) >/tmp/expect_die.$$ 2>&1; then
    fail "$desc: expected failure, got success"
  fi
  rm -f "/tmp/expect_die.$$"
  ok "$desc"
}

expect_ok() {
  local desc="$1"; shift
  if ! ( "$@" ) >/tmp/expect_ok.$$ 2>&1; then
    cat "/tmp/expect_ok.$$" >&2
    rm -f "/tmp/expect_ok.$$"
    fail "$desc: expected success, got failure"
  fi
  rm -f "/tmp/expect_ok.$$"
  ok "$desc"
}

expect_die "validate_bucket_uri rejects non-gs scheme" validate_bucket_uri "s3://bucket/prefix"
expect_die "validate_bucket_uri rejects path traversal" validate_bucket_uri "gs://bucket/../secrets"
expect_die "validate_bucket_uri rejects spaces" validate_bucket_uri "gs://bucket/pre fix"
expect_die "validate_bucket_uri rejects uppercase bucket" validate_bucket_uri "gs://Bucket/prefix"
expect_ok "validate_bucket_uri accepts plain bucket" validate_bucket_uri "gs://family-app-backups"
expect_ok "validate_bucket_uri accepts bucket with prefix" validate_bucket_uri "gs://family-app-backups/daily"

expect_die "validate_age_recipient rejects empty" validate_age_recipient ""
expect_die "validate_age_recipient rejects missing prefix" validate_age_recipient "not-a-recipient"
expect_die "validate_age_recipient rejects ssh-style key" validate_age_recipient "ssh-ed25519 AAAA"
expect_ok "validate_age_recipient accepts well-formed age1 key" \
  validate_age_recipient "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"

require_var_test() {
  unset -v TEST_REQUIRED_VAR 2>/dev/null || true
  require_var TEST_REQUIRED_VAR
}
expect_die "require_var fails on missing variable" require_var_test
expect_ok "require_var passes on set variable" bash -c 'TEST_REQUIRED_VAR=x; source "'"$BACKUP_DIR"'/lib.sh"; require_var TEST_REQUIRED_VAR'

status_json=$(BACKUP_HOST_ID=test-host emit_status success '{"object_uri":"gs://b/o"}')
echo "$status_json" | jq -e '.status == "success" and .host_id == "test-host" and .object_uri == "gs://b/o"' >/dev/null \
  || fail "emit_status produces expected JSON shape"
ok "emit_status produces expected JSON shape"

echo "$status_json" | jq -e 'has("timestamp")' >/dev/null || fail "emit_status includes timestamp"
ok "emit_status includes timestamp"

# acquire_single_flight_lock: second acquisition in a child process must fail
# while the first holds the lock in this shell.
# Ruling: flock(1) is a Linux util-linux tool, absent on stock macOS (and
# with no official Homebrew formula). Production and CI (GitHub Actions
# ubuntu-latest) are both Linux, where it is always present, so this check
# is skipped on non-Linux dev machines rather than faked; cost if wrong is
# a lock regression surfacing only in CI/Docker, never silently in prod.
if ! command -v flock >/dev/null 2>&1; then
  log "skip: acquire_single_flight_lock contention check (flock not installed; verified in CI/Docker)"
else
  lock_test_dir=$(mktemp -d)
  trap 'rm -rf "$lock_test_dir"' EXIT
  (
    BACKUP_STATE_DIR="$lock_test_dir" bash -c '
      set -euo pipefail
      source "'"$BACKUP_DIR"'/lib.sh"
      acquire_single_flight_lock
      sleep 2
    '
  ) &
  holder_pid=$!
  sleep 0.5
  if BACKUP_STATE_DIR="$lock_test_dir" bash -c '
    set -euo pipefail
    source "'"$BACKUP_DIR"'/lib.sh"
    acquire_single_flight_lock
  ' >/tmp/lock_contend.$$ 2>&1; then
    cat /tmp/lock_contend.$$ >&2
    rm -f /tmp/lock_contend.$$
    fail "acquire_single_flight_lock allowed a concurrent holder"
  fi
  rm -f /tmp/lock_contend.$$
  ok "acquire_single_flight_lock rejects a concurrent holder"
  wait "$holder_pid" 2>/dev/null || true
fi

printf '\n%d checks passed (Part A: lib.sh)\n' "$PASS"

# ---------------------------------------------------------------------------
# Part B: backup.sh preflight contract (Task 2) -- stub every external tool
# ---------------------------------------------------------------------------
sandbox=$(mktemp -d)
trap 'rm -rf "$sandbox"' EXIT

stub_dir="$sandbox/stubs"
mkdir -p "$stub_dir" "$sandbox/receipts" "$sandbox/state" "$sandbox/ciphertext" "$sandbox/staging"
echo 'super-secret-password' > "$sandbox/pgpass"
chmod 400 "$sandbox/pgpass"
echo '{"type":"service_account"}' > "$sandbox/creds.json"

cat > "$stub_dir/pg_isready" <<'SH'
#!/usr/bin/env bash
[[ "${FAIL_PG_ISREADY:-0}" != 1 ]]
SH
chmod +x "$stub_dir/pg_isready"

base_env() {
  cat <<ENV
PGHOST=127.0.0.1
PGPORT=5432
PGUSER=postgres
PGPASSWORD_FILE=$sandbox/pgpass
BACKUP_GCS_URI=gs://family-app-backups
BACKUP_HOST_ID=test-host
AGE_RECIPIENT=age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
RECEIPT_STORAGE_DIR=$sandbox/receipts
BACKUP_STATE_DIR=$sandbox/state
BACKUP_CIPHERTEXT_DIR=$sandbox/ciphertext
GOOGLE_APPLICATION_CREDENTIALS=$sandbox/creds.json
BACKUP_STAGING_DIR=$sandbox/staging
ENV
}

run_preflight() {
  # Runs only preflight() in isolation via BACKUP_PREFLIGHT_ONLY=1.
  env -i PATH="$stub_dir:/usr/bin:/bin" BACKUP_PREFLIGHT_ONLY=1 "$@" \
    bash "$BACKUP_DIR/backup.sh" 2>&1
}

with_env_minus() {
  # Prints base_env with the given VAR removed.
  local drop="$1"
  base_env | grep -v "^${drop}="
}

required_contract_vars=(
  PGHOST PGPORT PGUSER PGPASSWORD_FILE BACKUP_GCS_URI BACKUP_HOST_ID
  AGE_RECIPIENT RECEIPT_STORAGE_DIR BACKUP_STATE_DIR BACKUP_CIPHERTEXT_DIR
  GOOGLE_APPLICATION_CREDENTIALS
)
for var in "${required_contract_vars[@]}"; do
  tmp_env="$sandbox/env_minus_${var}"
  with_env_minus "$var" > "$tmp_env"
  if run_preflight env $(cat "$tmp_env" | tr '\n' ' ') >/tmp/preflight.$$ 2>&1; then
    cat /tmp/preflight.$$ >&2
    fail "preflight accepted missing $var"
  fi
  grep -q "$var" /tmp/preflight.$$ || { cat /tmp/preflight.$$ >&2; fail "preflight error for missing $var did not name it"; }
  rm -f /tmp/preflight.$$
done
ok "preflight rejects every missing required variable by name"

bad_bucket_env=$(base_env | grep -v '^BACKUP_GCS_URI=')
if run_preflight env $bad_bucket_env BACKUP_GCS_URI='s3://not-gcs' >/tmp/preflight.$$ 2>&1; then
  cat /tmp/preflight.$$ >&2; fail "preflight accepted unsafe bucket URI"
fi
rm -f /tmp/preflight.$$
ok "preflight rejects unsafe bucket URI"

bad_age_env=$(base_env | grep -v '^AGE_RECIPIENT=')
if run_preflight env $bad_age_env AGE_RECIPIENT='not-an-age-key' >/tmp/preflight.$$ 2>&1; then
  cat /tmp/preflight.$$ >&2; fail "preflight accepted invalid age recipient"
fi
rm -f /tmp/preflight.$$
ok "preflight rejects invalid age recipient"

if run_preflight env $(base_env | tr '\n' ' ') FAIL_PG_ISREADY=1 >/tmp/preflight.$$ 2>&1; then
  cat /tmp/preflight.$$ >&2; fail "preflight accepted unreachable PostgreSQL"
fi
rm -f /tmp/preflight.$$
ok "preflight rejects unavailable PostgreSQL"

if ! run_preflight env $(base_env | tr '\n' ' ') >/tmp/preflight.$$ 2>&1; then
  cat /tmp/preflight.$$ >&2; fail "preflight rejected a fully valid environment"
fi
if grep -qi 'super-secret-password' /tmp/preflight.$$; then
  fail "preflight leaked PGPASSWORD_FILE content to stdout/stderr"
fi
rm -f /tmp/preflight.$$
ok "preflight accepts a fully valid environment and never prints the password"

printf '\n%d checks passed (Part A+B)\n' "$PASS"
