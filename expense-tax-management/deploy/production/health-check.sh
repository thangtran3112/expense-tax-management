#!/usr/bin/env bash
set -Eeuo pipefail

attempts="${HEALTH_CHECK_ATTEMPTS:-30}"
delay="${HEALTH_CHECK_DELAY_SECONDS:-2}"
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
COMPOSE_ENV_FILE="${PRODUCTION_ENV_FILE:-/etc/expense-tax-management/production.env}"
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

worker_ready=0
for ((attempt = 1; attempt <= attempts; attempt += 1)); do
  if compose ps --status running --services | awk '$1 == "ai-worker" { found=1 } END { exit found ? 0 : 1 }'; then
    worker_ready=1
    break
  fi
  sleep "$delay"
done
if ((worker_ready == 0)); then
  printf '%s\n' "ai-worker is not running" >&2
  exit 1
fi

for ((attempt = 1; attempt <= attempts; attempt += 1)); do
  if docker exec family-temporal temporal operator cluster health --address temporal:7233 >/dev/null 2>&1 &&
    docker exec family-temporal temporal operator namespace describe --address temporal:7233 --namespace expense-tax >/dev/null 2>&1; then
    exit 0
  fi
  sleep "$delay"
done
printf '%s\n' "Temporal health check failed" >&2
exit 1
