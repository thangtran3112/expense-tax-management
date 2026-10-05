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
tail -1 /tmp/preflight.$$ | jq -e '.status == "failure" and (.reason | test("PostgreSQL"))' >/dev/null \
  || { cat /tmp/preflight.$$ >&2; fail "die() did not emit a machine-readable failure status"; }
grep -qi 'super-secret-password' /tmp/preflight.$$ \
  && fail "a failure status must never echo a secret value" || true
rm -f /tmp/preflight.$$
ok "preflight rejects unavailable PostgreSQL and emits a machine-readable failure status"

if ! run_preflight env $(base_env | tr '\n' ' ') >/tmp/preflight.$$ 2>&1; then
  cat /tmp/preflight.$$ >&2; fail "preflight rejected a fully valid environment"
fi
if grep -qi 'super-secret-password' /tmp/preflight.$$; then
  fail "preflight leaked PGPASSWORD_FILE content to stdout/stderr"
fi
rm -f /tmp/preflight.$$
ok "preflight accepts a fully valid environment and never prints the password"

printf '\n%d checks passed (Part A+B)\n' "$PASS"

# ---------------------------------------------------------------------------
# Part C: receipt file selection (Task 4) -- pure filesystem logic, no
# Docker/age/gcloud/postgres needed. Runs identically on macOS (BSD stat)
# and Linux (GNU stat/the pinned container).
# ---------------------------------------------------------------------------
# shellcheck source=backup.sh
source "$BACKUP_DIR/backup.sh"

receipts_dir=$(mktemp -d)
trap 'rm -rf "$receipts_dir"' EXIT
mkdir -p "$receipts_dir/sub"
epoch_of() { date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null || date -u -d "$1" +%s; }
set_mtime() {
  # BSD touch -t has no UTC/Z notion and always treats its argument as
  # local time; GNU touch -d understands "...Z" directly. Fix: always go
  # through epoch_of() first, then (on BSD) format THAT epoch back as a
  # local-time touch -t argument -- touch -t will reinterpret it as local
  # time and land on the same epoch either way.
  local file="$1" iso="$2" epoch
  epoch=$(epoch_of "$iso")
  if date -r "$epoch" +%Y%m%d%H%M.%S >/tmp/.touchfmt.$$ 2>/dev/null; then
    touch -t "$(cat /tmp/.touchfmt.$$)" "$file"
  else
    touch -d "@$epoch" "$file"
  fi
  rm -f /tmp/.touchfmt.$$
}

last_cutoff=$(epoch_of "2026-01-10T00:00:00Z")
current_cutoff=$(epoch_of "2026-01-15T00:00:00Z")

echo before  > "$receipts_dir/before.pdf";      set_mtime "$receipts_dir/before.pdf" "2026-01-05T00:00:00Z"
echo in      > "$receipts_dir/in-window.pdf";   set_mtime "$receipts_dir/in-window.pdf" "2026-01-12T00:00:00Z"
echo at      > "$receipts_dir/at-cutoff.pdf";   set_mtime "$receipts_dir/at-cutoff.pdf" "2026-01-15T00:00:00Z"
echo after   > "$receipts_dir/sub/after.pdf";   set_mtime "$receipts_dir/sub/after.pdf" "2026-01-20T00:00:00Z"

daily_selection=$(select_receipt_files "$receipts_dir" daily "$last_cutoff" "$current_cutoff" | sort)
expected_daily=$'at-cutoff.pdf\nin-window.pdf'
[[ "$daily_selection" == "$expected_daily" ]] \
  || fail "daily selection mismatch: got [$daily_selection] want [$expected_daily]"
ok "daily mode selects only (last_cutoff, current_cutoff], at-cutoff inclusive"

full_selection=$(select_receipt_files "$receipts_dir" full "$last_cutoff" "$current_cutoff" | sort)
expected_full=$'at-cutoff.pdf\nbefore.pdf\nin-window.pdf'
[[ "$full_selection" == "$expected_full" ]] \
  || fail "full selection mismatch: got [$full_selection] want [$expected_full]"
ok "full mode selects every file up to current_cutoff, excludes files after it"

empty_selection=$(select_receipt_files "$receipts_dir" daily "$current_cutoff" "$current_cutoff")
[[ -z "$empty_selection" ]] || fail "unchanged-receipts window should select nothing"
ok "daily mode on an unchanged window selects zero files"

printf '\n%d checks passed (Part A+B+C)\n' "$PASS"

# ---------------------------------------------------------------------------
# Part D: manifest assembly (Task 4) -- determine_mode/build_receipt_archive/
# build_manifest/validate_manifest. The receipt archive step shells out to
# `tar --sort=name --mtime=@0 ...` (GNU-only flags, for a byte-reproducible
# archive); macOS ships bsdtar, which lacks them. Ruling: skip this part
# (not fake it) on a non-GNU-tar host and prove it instead inside
# test-backup-docker.sh's pinned Linux image and in CI (ubuntu-latest ships
# GNU tar by default) -- same precedent as the flock skip in Part A.
# ---------------------------------------------------------------------------
if ! tar --version 2>&1 | grep -q GNU; then
  log "skip: Part D manifest-assembly checks (no GNU tar on this host; proven in test-backup-docker.sh + CI)"
else
  d=$(mktemp -d)
  trap 'rm -rf "$d" "$receipts_dir"' EXIT
  staging="$d/staging"; mkdir -p "$staging/dumps"
  echo '-- fake globals' > "$staging/globals.sql"
  echo 'fake dump 1' > "$staging/dumps/db1.dump"
  jq -n --arg v "17.4" \
    '{postgresql_version:$v, databases:["db1"], files:[
      {name:"globals.sql", bytes: 16, sha256: "'"$(sha256_file "$staging/globals.sql")"'"},
      {name:"dumps/db1.dump", bytes: 12, sha256: "'"$(sha256_file "$staging/dumps/db1.dump")"'"}
    ]}' > "$staging/database-inventory.json"

  export RECEIPT_STORAGE_DIR="$d/receipts"
  mkdir -p "$RECEIPT_STORAGE_DIR"
  echo r1 > "$RECEIPT_STORAGE_DIR/r1.pdf"; set_mtime "$RECEIPT_STORAGE_DIR/r1.pdf" "2026-01-12T00:00:00Z"
  export BACKUP_HOST_ID=test-host
  export BACKUP_IMAGE_TAGS="app-api=sha-abc,foundry=sha-def"
  export BACKUP_MIGRATION_VERSIONS="app=0042"

  build_receipt_archive "$staging" full 0 "$(epoch_of 2026-01-15T00:00:00Z)"
  [[ -f "$staging/receipts.tar" ]] || fail "receipts.tar not created"
  ok "build_receipt_archive produces receipts.tar"

  mode_json=$(determine_mode "$d/no-such-marker.json" "$(epoch_of 2026-01-15T00:00:00Z)" run-1)
  [[ "$(jq -r .mode <<< "$mode_json")" == "full" ]] || fail "determine_mode: no marker must mean full"
  ok "determine_mode: no marker means full"

  build_manifest "$staging" run-1 "2026-01-15T00:00:00Z" "$mode_json"
  validate_manifest "$staging"
  ok "build_manifest + validate_manifest succeed for a well-formed staging dir"

  jq -e '.deployed_image_tags["app-api"] == "sha-abc" and .schema_migration_versions["app"] == "0042"' \
    "$staging/manifest.json" >/dev/null || fail "manifest did not record image tags/migration versions"
  ok "manifest records BACKUP_IMAGE_TAGS and BACKUP_MIGRATION_VERSIONS"

  jq -e '.compose_checksum == null' "$staging/manifest.json" >/dev/null \
    || fail "compose_checksum should be null when BACKUP_COMPOSE_FILE is unset"
  ok "manifest leaves compose_checksum null when unset"

  # Marker continuity: same month as a prior full -> daily, carrying that
  # full run's id forward and resuming from its cutoff.
  marker="$d/marker.json"
  jq -n '{cutoff_epoch: 1000, last_full_period: "2026-01", parent_full_backup_id: "full-run-0"}' > "$marker"
  mode_json=$(determine_mode "$marker" "$(epoch_of 2026-01-20T00:00:00Z)" run-2)
  [[ "$(jq -r .mode <<< "$mode_json")" == "daily" ]] || fail "determine_mode: same month as prior full must mean daily"
  [[ "$(jq -r .parent_full_backup_id <<< "$mode_json")" == "full-run-0" ]] || fail "determine_mode: daily must carry the full run's id forward"
  [[ "$(jq -r .last_cutoff_epoch <<< "$mode_json")" == "1000" ]] || fail "determine_mode: daily must resume from the marker's cutoff"
  ok "determine_mode: same month as prior full means daily, carrying its id and cutoff"

  mode_json=$(determine_mode "$marker" "$(epoch_of 2026-02-01T00:00:00Z)" run-3)
  [[ "$(jq -r .mode <<< "$mode_json")" == "full" ]] || fail "determine_mode: a new month must start a new full"
  [[ "$(jq -r .parent_full_backup_id <<< "$mode_json")" == "run-3" ]] || fail "determine_mode: a new full's parent is itself"
  ok "determine_mode: a new calendar month starts a new full backup chain"

  # ---------------------------------------------------------------------
  # Part E: upload_backup_set/advance_marker naming + precondition logic
  # (Task 5). age and gcloud are stubbed here -- this proves OUR orchestration
  # (object naming/prefix, creation-only precondition, marker merge, no
  # leftover ciphertext). The real age round trip (generate a temporary
  # identity, encrypt, decrypt, compare every checksum) against a
  # directory-backed fake GCS is proven in test-backup-docker.sh, which has
  # a real `age` binary in the pinned image.
  # ---------------------------------------------------------------------
  fake_bucket="$d/fake-bucket"; mkdir -p "$fake_bucket"
  upload_stub_dir="$d/upload-stubs"; mkdir -p "$upload_stub_dir"
  cat > "$upload_stub_dir/age" <<'SH'
#!/usr/bin/env bash
# Identity transform (ignores -r): proves plumbing, not cryptography.
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat > "$out"
SH
  chmod +x "$upload_stub_dir/age"
  cat > "$upload_stub_dir/gcloud" <<SH
#!/usr/bin/env bash
set -euo pipefail
bucket_root="$fake_bucket"
if [[ "\$1" == "storage" && "\$2" == "cp" ]]; then
  shift 2
  src=""; dest=""
  for a in "\$@"; do
    case "\$a" in --if-generation-match=*) : ;; *) if [[ -z "\$src" ]]; then src="\$a"; else dest="\$a"; fi ;; esac
  done
  key="\${dest#gs://*/}"
  target="\$bucket_root/\$key"
  if [[ -e "\$target" ]]; then echo "precondition failed: already exists" >&2; exit 1; fi
  mkdir -p "\$(dirname "\$target")"
  cp "\$src" "\$target"
  date +%s%N > "\$target.generation"
elif [[ "\$1 \$2 \$3" == "storage objects describe" ]]; then
  dest="\$4"
  key="\${dest#gs://*/}"
  cat "\$bucket_root/\$key.generation"
else
  echo "unsupported fake gcloud invocation: \$*" >&2
  exit 1
fi
SH
  chmod +x "$upload_stub_dir/gcloud"

  (
    export PATH="$upload_stub_dir:$PATH"
    export BACKUP_GCS_URI="gs://fbk-test-bucket" BACKUP_CIPHERTEXT_DIR="$d/ciphertext"
    export AGE_RECIPIENT="age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"
    mkdir -p "$BACKUP_CIPHERTEXT_DIR"

    upload_json=$(upload_backup_set "$staging" full "$(epoch_of 2026-01-15T00:00:00Z)" run-upload-full)
    echo "$upload_json" | jq -e '.object_uri | test("^gs://fbk-test-bucket/monthly/2026/01/.*\\.tar\\.age$")' >/dev/null \
      || { echo "$upload_json" >&2; fail "full mode must upload under monthly/YYYY/MM/"; }
    [[ -z "$(ls -A "$BACKUP_CIPHERTEXT_DIR")" ]] || fail "ciphertext dir must be empty after a successful upload"

    upload_json2=$(upload_backup_set "$staging" daily "$(epoch_of 2026-01-15T00:00:00Z)" run-upload-daily)
    echo "$upload_json2" | jq -e '.object_uri | test("^gs://fbk-test-bucket/daily/2026/01/15/.*\\.tar\\.age$")' >/dev/null \
      || { echo "$upload_json2" >&2; fail "daily mode must upload under daily/YYYY/MM/DD/"; }

    # Identical staging + identical cutoff + identical mode -> identical
    # ciphertext -> identical object key: the creation-only precondition
    # must reject the retry rather than silently overwrite it.
    # Subshell: upload_backup_set calls die() -> exit on failure (an explicit
    # exit, unlike a nonzero return, is not contained by `if`) which would
    # otherwise terminate this whole sourced test script, not just the check.
    if ( upload_backup_set "$staging" full "$(epoch_of 2026-01-15T00:00:00Z)" run-upload-full-retry ) >/tmp/retry.$$ 2>&1; then
      cat /tmp/retry.$$ >&2
      rm -f /tmp/retry.$$
      fail "a colliding object key must be rejected by the creation-only precondition"
    fi
    rm -f /tmp/retry.$$
    [[ -z "$(find "$BACKUP_CIPHERTEXT_DIR" -name '*.age' 2>/dev/null)" ]] \
      || fail "a rejected upload must not leave ciphertext behind"
  )
  ok "upload_backup_set: full->monthly/, daily->daily/, and a colliding key is rejected with no leftover ciphertext"

  marker="$d/advance-marker.json"
  : > "$marker"
  advance_marker "$marker" "$(epoch_of 2026-01-15T00:00:00Z)" "2026-01-15T00:00:00Z" \
    '{"mode":"full","parent_full_backup_id":"run-upload-full"}' run-upload-full \
    '{"object_uri":"gs://fbk-test-bucket/monthly/2026/01/x.tar.age","generation":"123"}'
  jq -e '.last_full_period == "2026-01" and .parent_full_backup_id == "run-upload-full" and .object_uri == "gs://fbk-test-bucket/monthly/2026/01/x.tar.age" and .generation == "123"' \
    "$marker" >/dev/null || { cat "$marker" >&2; fail "advance_marker did not merge mode/upload fields correctly"; }
  ok "advance_marker merges mode and upload fields into the marker"

  # Tamper with a dumped file after the manifest was built: validate_manifest
  # must reject it rather than encrypt/upload a mismatched checksum.
  echo 'tampered' >> "$staging/dumps/db1.dump"
  # Subshell: validate_manifest calls die() -> exit on failure, which would
  # otherwise terminate this whole sourced test script, not just the check.
  if ( validate_manifest "$staging" ) >/tmp/validate_tamper.$$ 2>&1; then
    cat /tmp/validate_tamper.$$ >&2
    fail "validate_manifest accepted a tampered dump file"
  fi
  rm -f /tmp/validate_tamper.$$
  ok "validate_manifest rejects a checksum mismatch before encryption"

  printf '\n%d checks passed (Part A+B+C+D+E)\n' "$PASS"
fi
