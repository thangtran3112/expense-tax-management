#!/usr/bin/env bash
# Verifies the running ai-trading stack: every service running, health checks
# passing, and the Cloudflare Tunnel connected. Runs on the VPS as root.
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/family-app/ai-trading}"
ATTEMPTS="${HEALTH_CHECK_ATTEMPTS:-30}"
DELAY="${HEALTH_CHECK_DELAY_SECONDS:-2}"
SERVICES=(web ta-terminal ahf-terminal vibe-trading cloudflared)

compose() {
  docker compose --project-name ai-trading --env-file "$APP_DIR/images.env" -f "$APP_DIR/docker-compose.yml" "$@"
}

service_ok() {
  local id state health
  id="$(compose ps -q "$1")"
  [[ -n "$id" ]] || return 1
  state="$(docker inspect -f '{{.State.Status}}' "$id")"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")"
  [[ "$state" == running && ("$health" == healthy || "$health" == none) ]]
}

# cloudflared is distroless, so ask from the web container on the shared network.
tunnel_ready() {
  compose exec -T web node -e "fetch('http://cloudflared:2000/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
}

failing=()
for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
  failing=()
  for service in "${SERVICES[@]}"; do
    service_ok "$service" || failing+=("$service")
  done
  if ((${#failing[@]} == 0)) && tunnel_ready; then
    echo "health-check: all services healthy; tunnel connected"
    exit 0
  fi
  sleep "$DELAY"
done
echo "health-check: failing services: ${failing[*]:-none}; tunnel connected: $(tunnel_ready && echo yes || echo no)" >&2
exit 1
