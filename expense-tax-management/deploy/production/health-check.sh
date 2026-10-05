#!/usr/bin/env bash
set -Eeuo pipefail

attempts="${HEALTH_CHECK_ATTEMPTS:-30}"
delay="${HEALTH_CHECK_DELAY_SECONDS:-2}"
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
COMPOSE_ENV_FILE="${PRODUCTION_ENV_FILE:?PRODUCTION_ENV_FILE is required}"
compose() {
  docker compose --project-name expense-tax-production --env-file "$COMPOSE_ENV_FILE" -f "$SCRIPT_DIR/docker-compose.yml" "$@"
}
endpoints=(
  "http://127.0.0.1:8100/health/live"
  "http://127.0.0.1:8200/health/live"
  "http://127.0.0.1:7301/capture"
  "http://127.0.0.1:7302/dashboard"
  "http://127.0.0.1:7303/providers"
)
# Phase 3D-A Task 5 (controller ruling): mailbox broker is opt-in -- only
# polled when the validated production env set MAILBOX_FEATURE_ENABLED=true
# (same signal deploy.sh uses to decide whether the broker was started at
# all). An ordinary mailbox-disabled deploy never waits on this endpoint.
if [[ "${MAILBOX_FEATURE_ENABLED:-false}" == "true" ]]; then
  endpoints+=("http://127.0.0.1:8300/health/live")
fi

for endpoint in "${endpoints[@]}"; do
  ready=0
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl --fail --silent --show-error --max-time 5 "$endpoint" >/dev/null; then
      ready=1
      break
    fi
    sleep "$delay"
  done
  if ((ready == 0)); then
    printf 'Health check failed: %s\n' "$endpoint" >&2
    exit 1
  fi
done

# Configurable so a rollback to a pre-Stage-B image tag (no workflow-worker
# image available) can require only ai-worker, without weakening the
# default (both workers required) for every normal deploy/health check.
read -r -a required_workers <<<"${HEALTH_CHECK_REQUIRED_WORKERS:-ai-worker workflow-worker}"
for worker in "${required_workers[@]}"; do
  worker_ready=0
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if compose ps --status running --services | awk -v worker="$worker" '$1 == worker { found=1 } END { exit found ? 0 : 1 }'; then
      worker_ready=1
      break
    fi
    sleep "$delay"
  done
  if ((worker_ready == 0)); then
    printf '%s is not running\n' "$worker" >&2
    exit 1
  fi
done

for ((attempt = 1; attempt <= attempts; attempt += 1)); do
  if docker exec family-temporal temporal operator cluster health --address temporal:7233 >/dev/null 2>&1 &&
    docker exec family-temporal temporal operator namespace describe --address temporal:7233 --namespace expense-tax >/dev/null 2>&1; then
    exit 0
  fi
  sleep "$delay"
done
printf '%s\n' "Temporal health check failed" >&2
exit 1
