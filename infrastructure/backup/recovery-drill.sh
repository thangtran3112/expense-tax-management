#!/usr/bin/env bash
# Orchestrates a recovery drill (Task 8): restore.sh against disposable
# infrastructure, compare restored vs. supported schema migration
# versions before running any migration, deploy + health-check + an
# optional authenticated smoke test, and a timestamped JSON report with
# RPO/RTO. The drill FAILS if the whole thing exceeds the two-hour RTO,
# regardless of whether every individual step otherwise succeeded.
#
# This script is a pluggable ORCHESTRATOR: deploy/health-check/smoke-test
# are commands YOU supply (disposable local infra, or a disposable remote
# host -- never production routing; "no production routing" is an
# operator discipline this script cannot enforce for you). It never talks
# to Cloudflare, never deploys to the live VPS, and never runs real
# migration tooling unless RECOVERY_MIGRATE_CMD is explicitly supplied.
#
# Required env vars (passed straight through to restore.sh -- see its
# own README section for what each means):
#   PGHOST / PGPORT / PGUSER / PGPASSWORD_FILE
#   RESTORE_AGE_IDENTITY_FILE / RESTORE_GOOGLE_APPLICATION_CREDENTIALS
#   RESTORE_OBJECT_URI / RESTORE_WORK_DIR / RECEIPT_RESTORE_DIR
#
# Recovery-drill-specific env vars:
#   RECOVERY_REPORT_FILE            Where to write the JSON report (required)
#   RECOVERY_SUPPORTED_MIGRATION_VERSIONS
#                                    "app=0042,foundry=0017" -- what the
#                                    image(s) you are about to deploy
#                                    actually support. Compared against the
#                                    restored manifest's own
#                                    schema_migration_versions before any
#                                    migration runs.
#   RECOVERY_MIGRATE_CMD             Optional. Only run when the comparison
#                                    above matches (or RECOVERY_FORCE_MIGRATE=1).
#   RECOVERY_DEPLOY_CMD              Optional. e.g. a disposable
#                                    `docker compose up -d --wait`.
#   RECOVERY_HEALTH_CHECK_CMD        Optional. e.g.
#                                    deploy/production/health-check.sh against
#                                    the disposable host.
#   RECOVERY_SMOKE_TEST_CMD          Optional authenticated product smoke test.
#   RECOVERY_DEADLINE_SECONDS        Default 7200 (2 hours, the plan's RTO).
#   RECOVERY_POSTGRES_CONTAINER      Default "family-app-postgres" (the name
#                                    infrastructure/vps/steps/30-postgres.sh
#                                    actually uses). Configurable here on
#                                    purpose -- fix round 2: this used to be
#                                    hardcoded into deploy/production/health-check.sh,
#                                    which runs on every ordinary deploy AND
#                                    its automatic rollback; a wrong guess
#                                    there (bootstrap-temporal-db.sh's own
#                                    default differs: expense-tax-postgres)
#                                    would fail both. Getting it wrong here
#                                    only fails a drill.
#   RECOVERY_POSTGRES_USER           Default "postgres".
#   RECOVERY_RECEIPT_CONTAINER       Optional. Container to check the receipt
#                                    volume inside. Skipped (not failed) when
#                                    unset -- there is no single stable
#                                    container name across family-app projects.
#   RECOVERY_RECEIPT_PATH            Default "/tmp/expense_tax_storage".
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

run_named_step() {
  # run_named_step NAME CMD_VAR_NAME -> runs ${!CMD_VAR_NAME} if set
  # (via `bash -c`, so it can be a whole pipeline), prints PASS/SKIP/FAIL,
  # and returns that step's own exit status (0 for SKIP).
  local name="$1" cmd_var="$2" cmd="${!2:-}"
  if [[ -z "$cmd" ]]; then
    log "$name: skipped (no ${cmd_var} supplied)"
    return 0
  fi
  if bash -c "$cmd"; then
    log "$name: PASS"
    return 0
  else
    log "$name: FAIL"
    return 1
  fi
}

report_bool() { [[ "$1" == 0 ]] && echo true || echo false; }

# Task 8's "verify PostgreSQL ... and receipt retrieval" bullet, moved
# here (fix round 2) from deploy/production/health-check.sh: that script
# runs on every ordinary production deploy and its automatic rollback, so
# an unverified/wrong container name there fails live deploys, not just a
# drill. See the RECOVERY_POSTGRES_CONTAINER doc comment above.
verify_postgres_reachable() {
  local container="${RECOVERY_POSTGRES_CONTAINER:-family-app-postgres}"
  local user="${RECOVERY_POSTGRES_USER:-postgres}"
  local attempts="${RECOVERY_VERIFY_ATTEMPTS:-30}" delay="${RECOVERY_VERIFY_DELAY_SECONDS:-2}" i
  for ((i = 1; i <= attempts; i += 1)); do
    docker exec "$container" pg_isready -U "$user" >/dev/null 2>&1 && return 0
    sleep "$delay"
  done
  return 1
}

# Structural check only (the volume is mounted and reachable inside the
# running app container) -- a full authenticated content fetch is the
# separate smoke-test step. Skipped, not failed, when
# RECOVERY_RECEIPT_CONTAINER is unset: unlike the Postgres container name,
# there is no single stable container name across family-app projects.
verify_receipt_volume() {
  local container="${RECOVERY_RECEIPT_CONTAINER:-}"
  [[ -n "$container" ]] || return 0
  local path="${RECOVERY_RECEIPT_PATH:-/tmp/expense_tax_storage}"
  local attempts="${RECOVERY_VERIFY_ATTEMPTS:-30}" delay="${RECOVERY_VERIFY_DELAY_SECONDS:-2}" i
  for ((i = 1; i <= attempts; i += 1)); do
    docker exec "$container" test -d "$path" >/dev/null 2>&1 && return 0
    sleep "$delay"
  done
  return 1
}

main() {
: "${RESTORE_OBJECT_URI:?RESTORE_OBJECT_URI is required}"
: "${RESTORE_WORK_DIR:?RESTORE_WORK_DIR is required}"
: "${RECOVERY_REPORT_FILE:?RECOVERY_REPORT_FILE is required}"

local deadline_seconds start_epoch start_iso
deadline_seconds="${RECOVERY_DEADLINE_SECONDS:-7200}"
start_epoch=$(date -u +%s)
start_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)

log "recovery drill starting: restoring ${RESTORE_OBJECT_URI}"
restore_status=0
"$SCRIPT_DIR/restore.sh" || restore_status=$?

migrations_run=false
migration_versions_match=null
if [[ "$restore_status" == 0 ]]; then
  manifest="$RESTORE_WORK_DIR/full/manifest.json"
  if [[ -s "$manifest" ]]; then
    restored_versions=$(jq -c '.schema_migration_versions' "$manifest")
    supported_versions=$(csv_pairs_to_json "${RECOVERY_SUPPORTED_MIGRATION_VERSIONS:-}")
    if [[ "$restored_versions" == "$supported_versions" ]]; then
      migration_versions_match=true
    else
      migration_versions_match=false
      log "schema_migration_versions mismatch: restored=$restored_versions supported=$supported_versions"
    fi
    if [[ "$migration_versions_match" == true || "${RECOVERY_FORCE_MIGRATE:-0}" == 1 ]]; then
      if [[ -n "${RECOVERY_MIGRATE_CMD:-}" ]]; then
        bash -c "$RECOVERY_MIGRATE_CMD" && migrations_run=true
      fi
    else
      log "migrations NOT run: schema_migration_versions did not match (operator review required)"
    fi
  else
    log "WARNING: no restored manifest found at $manifest; cannot compare migration versions"
  fi
fi

deploy_status=0
run_named_step "deploy" RECOVERY_DEPLOY_CMD || deploy_status=$?

postgres_status=0
if verify_postgres_reachable; then
  log "postgres: PASS"
else
  postgres_status=1
  log "postgres: FAIL"
fi

receipts_status=0
if verify_receipt_volume; then
  if [[ -n "${RECOVERY_RECEIPT_CONTAINER:-}" ]]; then
    log "receipt-volume: PASS"
  else
    log "receipt-volume: skipped (RECOVERY_RECEIPT_CONTAINER not supplied)"
  fi
else
  receipts_status=1
  log "receipt-volume: FAIL"
fi

health_status=0
run_named_step "health-check" RECOVERY_HEALTH_CHECK_CMD || health_status=$?
smoke_status=0
run_named_step "smoke-test" RECOVERY_SMOKE_TEST_CMD || smoke_status=$?

end_epoch=$(date -u +%s)
elapsed_seconds=$((end_epoch - start_epoch))
rto_breached=false
if (( elapsed_seconds > deadline_seconds )); then
  rto_breached=true
fi

rpo_hours=null
if [[ -s "${RESTORE_WORK_DIR}/full/manifest.json" ]]; then
  cutoff_epoch=$(jq -r '.cutoff | fromdateiso8601' "${RESTORE_WORK_DIR}/full/manifest.json")
  rpo_hours=$(( (start_epoch - cutoff_epoch) / 3600 ))
fi

overall_pass=true
[[ "$restore_status" == 0 ]] || overall_pass=false
[[ "$deploy_status" == 0 ]] || overall_pass=false
[[ "$postgres_status" == 0 ]] || overall_pass=false
[[ "$receipts_status" == 0 ]] || overall_pass=false
[[ "$health_status" == 0 ]] || overall_pass=false
[[ "$smoke_status" == 0 ]] || overall_pass=false
[[ "$rto_breached" == false ]] || overall_pass=false

jq -n \
  --arg started_at "$start_iso" \
  --argjson elapsed_seconds "$elapsed_seconds" \
  --argjson deadline_seconds "$deadline_seconds" \
  --argjson rto_breached "$rto_breached" \
  --argjson rpo_hours "$rpo_hours" \
  --argjson restore_passed "$(report_bool "$restore_status")" \
  --argjson migration_versions_match "$migration_versions_match" \
  --argjson migrations_run "$migrations_run" \
  --argjson deploy_passed "$(report_bool "$deploy_status")" \
  --argjson postgres_passed "$(report_bool "$postgres_status")" \
  --argjson receipt_volume_passed "$(report_bool "$receipts_status")" \
  --argjson health_check_passed "$(report_bool "$health_status")" \
  --argjson smoke_test_passed "$(report_bool "$smoke_status")" \
  --argjson overall_pass "$overall_pass" \
  '{
    started_at: $started_at,
    elapsed_seconds: $elapsed_seconds,
    deadline_seconds: $deadline_seconds,
    rto_breached: $rto_breached,
    rpo_hours: $rpo_hours,
    restore_passed: $restore_passed,
    migration_versions_match: $migration_versions_match,
    migrations_run: $migrations_run,
    deploy_passed: $deploy_passed,
    postgres_passed: $postgres_passed,
    receipt_volume_passed: $receipt_volume_passed,
    health_check_passed: $health_check_passed,
    smoke_test_passed: $smoke_test_passed,
    overall_pass: $overall_pass
  }' | tee "$RECOVERY_REPORT_FILE"

log "recovery drill finished in ${elapsed_seconds}s (deadline ${deadline_seconds}s): overall_pass=$overall_pass"
[[ "$overall_pass" == true ]]
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
