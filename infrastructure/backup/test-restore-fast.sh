#!/usr/bin/env bash
# Fast, Docker-free checks for infrastructure/backup/restore.sh's pure
# logic: every external tool (psql, pg_isready) is a stub on PATH, same
# pattern as test-backup.sh. Wired into pnpm ci:test via
# check:vps-backup-infrastructure. The real end-to-end restore (real
# PostgreSQL 17, real age, real gcloud-shaped fake) lives in the slow
# test-restore.sh, including the reversed/duplicate-delta rejection cases
# fix round 1 added there.
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
BACKUP_DIR="$ROOT/infrastructure/backup"
PASS=0
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$PASS" "$*"; }

# shellcheck source=lib.sh
source "$BACKUP_DIR/lib.sh"
# shellcheck source=restore.sh
source "$BACKUP_DIR/restore.sh"

d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
stub_dir="$d/stubs"
mkdir -p "$stub_dir"

# ---------------------------------------------------------------------------
# Part A: restore_globals() must ALWAYS inspect stderr, regardless of
# psql's own exit code (fix round 1, Critical #3) -- a stray ERROR line
# must fail the restore even when psql itself "succeeds" (ON_ERROR_STOP=0
# makes psql exit 0 after a failed statement).
# ---------------------------------------------------------------------------
make_psql_stub() {
  # make_psql_stub STDERR_TEXT EXIT_CODE
  cat > "$stub_dir/psql" <<SH
#!/usr/bin/env bash
printf '%s\n' "$1" >&2
exit ${2:-0}
SH
  chmod +x "$stub_dir/psql"
}

export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres

make_psql_stub 'psql:globals.sql:3: ERROR:  role "postgres" already exists' 0
echo ok > "$d/globals.sql"
if ! ( PATH="$stub_dir:$PATH" restore_globals "$d/globals.sql" ) >/tmp/rg_out.$$ 2>&1; then
  cat /tmp/rg_out.$$ >&2
  rm -f /tmp/rg_out.$$
  fail "restore_globals rejected a benign 'already exists' conflict"
fi
rm -f /tmp/rg_out.$$
ok "restore_globals tolerates an 'already exists' role/tablespace conflict"

# The bug this fixes: psql exits 0 (ON_ERROR_STOP=0 default behavior) but
# stderr contains a real, non-benign error. The OLD code's stderr check
# lived inside \`if ! psql ...; then\`, so it never ran at all here.
make_psql_stub 'psql:globals.sql:7: ERROR:  permission denied for schema app' 0
if ( PATH="$stub_dir:$PATH" restore_globals "$d/globals.sql" ) >/tmp/rg_out.$$ 2>&1; then
  cat /tmp/rg_out.$$ >&2
  rm -f /tmp/rg_out.$$
  fail "restore_globals accepted a non-benign error that psql itself exited 0 for"
fi
rm -f /tmp/rg_out.$$
ok "restore_globals fails on a non-benign error even when psql's own exit code is 0"

# Fail-closed on a nonzero psql exit with no explanatory ERROR line too
# (e.g. a connection drop) -- defense in depth, not just string matching.
make_psql_stub 'connection to server was lost' 2
if ( PATH="$stub_dir:$PATH" restore_globals "$d/globals.sql" ) >/tmp/rg_out.$$ 2>&1; then
  cat /tmp/rg_out.$$ >&2
  rm -f /tmp/rg_out.$$
  fail "restore_globals accepted a nonzero psql exit with no ERROR line"
fi
rm -f /tmp/rg_out.$$
ok "restore_globals fails closed on a nonzero psql exit even without a matching ERROR line"

# ---------------------------------------------------------------------------
# Part B: preflight() must export GOOGLE_APPLICATION_CREDENTIALS (what
# gcloud actually reads), not just validate RESTORE_GOOGLE_APPLICATION_CREDENTIALS
# (fix round 1, Critical #4).
# ---------------------------------------------------------------------------
cat > "$stub_dir/pg_isready" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$stub_dir/pg_isready"

echo -n fake-password > "$d/pgpass"
chmod 400 "$d/pgpass"
echo '{"type":"service_account"}' > "$d/creds.json"
echo 'AGE-SECRET-KEY-FAKE' > "$d/identity.txt"
mkdir -p "$d/receipts"

result=$(
  PATH="$stub_dir:$PATH" \
  PGPASSWORD_FILE="$d/pgpass" \
  RESTORE_AGE_IDENTITY_FILE="$d/identity.txt" \
  RESTORE_GOOGLE_APPLICATION_CREDENTIALS="$d/creds.json" \
  RESTORE_OBJECT_URI="gs://fake-bucket/monthly/2026/01/x.tar.age" \
  RESTORE_WORK_DIR="$d/restore-work" \
  RECEIPT_RESTORE_DIR="$d/receipts" \
  bash -c '
    source "'"$BACKUP_DIR"'/lib.sh"
    source "'"$BACKUP_DIR"'/restore.sh"
    preflight
    printf "%s" "${GOOGLE_APPLICATION_CREDENTIALS:-UNSET}"
  '
)
[[ "$result" == "$d/creds.json" ]] \
  || fail "preflight did not export GOOGLE_APPLICATION_CREDENTIALS from RESTORE_GOOGLE_APPLICATION_CREDENTIALS (got: $result)"
ok "preflight exports GOOGLE_APPLICATION_CREDENTIALS, which gcloud actually reads"

printf '\n%d checks passed (restore.sh fast)\n' "$PASS"
