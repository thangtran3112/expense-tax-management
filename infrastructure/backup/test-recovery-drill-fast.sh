#!/usr/bin/env bash
# Fast, Docker-free checks for recovery-drill.sh's verify_postgres_reachable()
# and verify_receipt_volume() (fix round 2): `docker` itself is a stub on
# PATH, same pattern as test-backup.sh/test-restore-fast.sh. Wired into
# pnpm ci:test via check:vps-backup-infrastructure. The full orchestration
# (real restore, these checks against a real container) is proven in the
# slow test-recovery-drill.sh.
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
BACKUP_DIR="$ROOT/infrastructure/backup"
PASS=0
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$PASS" "$*"; }

# shellcheck source=lib.sh
source "$BACKUP_DIR/lib.sh"
# shellcheck source=recovery-drill.sh
source "$BACKUP_DIR/recovery-drill.sh"

d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
stub_dir="$d/stubs"
mkdir -p "$stub_dir"

make_docker_stub() {
  # make_docker_stub EXPECTED_CONTAINER EXIT_CODE
  cat > "$stub_dir/docker" <<SH
#!/usr/bin/env bash
[[ "\$1" == "exec" ]] || exit 1
[[ "\$2" == "$1" ]] || { echo "unexpected container: \$2" >&2; exit 1; }
exit ${2:-0}
SH
  chmod +x "$stub_dir/docker"
}

export RECOVERY_VERIFY_ATTEMPTS=1 RECOVERY_VERIFY_DELAY_SECONDS=0

# ---------------------------------------------------------------------------
# verify_postgres_reachable(): defaults to "family-app-postgres" (the name
# infrastructure/vps/steps/30-postgres.sh actually uses), configurable via
# RECOVERY_POSTGRES_CONTAINER.
# ---------------------------------------------------------------------------
unset RECOVERY_POSTGRES_CONTAINER 2>/dev/null || true
make_docker_stub "family-app-postgres" 0
if ! ( PATH="$stub_dir:$PATH" verify_postgres_reachable ); then
  fail "verify_postgres_reachable did not default to family-app-postgres"
fi
ok "verify_postgres_reachable defaults to the family-app-postgres container"

make_docker_stub "some-other-postgres" 0
if ! ( PATH="$stub_dir:$PATH" RECOVERY_POSTGRES_CONTAINER=some-other-postgres verify_postgres_reachable ); then
  fail "verify_postgres_reachable did not honor RECOVERY_POSTGRES_CONTAINER"
fi
ok "verify_postgres_reachable honors RECOVERY_POSTGRES_CONTAINER"

make_docker_stub "family-app-postgres" 1
if ( PATH="$stub_dir:$PATH" verify_postgres_reachable ); then
  fail "verify_postgres_reachable succeeded despite pg_isready failing"
fi
ok "verify_postgres_reachable fails when pg_isready fails"

# ---------------------------------------------------------------------------
# verify_receipt_volume(): skipped (not failed) when RECOVERY_RECEIPT_CONTAINER
# is unset -- no single stable container name exists across family-app
# projects, unlike Postgres.
# ---------------------------------------------------------------------------
PATH="/nonexistent" verify_receipt_volume || fail "verify_receipt_volume must succeed (skip) with no docker on PATH when unset"
ok "verify_receipt_volume is skipped, not failed, when RECOVERY_RECEIPT_CONTAINER is unset (never even shells out)"

make_docker_stub "app-api-1" 0
if ! ( PATH="$stub_dir:$PATH" RECOVERY_RECEIPT_CONTAINER=app-api-1 verify_receipt_volume ); then
  fail "verify_receipt_volume did not pass against its configured container"
fi
ok "verify_receipt_volume passes against an explicitly configured container"

make_docker_stub "app-api-1" 1
if ( PATH="$stub_dir:$PATH" RECOVERY_RECEIPT_CONTAINER=app-api-1 verify_receipt_volume ); then
  fail "verify_receipt_volume succeeded despite the directory check failing"
fi
ok "verify_receipt_volume fails when the receipt directory is not reachable"

printf '\n%d checks passed (recovery-drill.sh fast)\n' "$PASS"
