#!/usr/bin/env bash
# Verifies the running ai-trading stack: every service running, health checks
# passing, and the Cloudflare Tunnel connected. Runs on the VPS as root.
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/family-app/ai-trading}"
ATTEMPTS="${HEALTH_CHECK_ATTEMPTS:-30}"
DELAY="${HEALTH_CHECK_DELAY_SECONDS:-2}"

compose() {
  local mirofish_compose=()
  [[ -f "$APP_DIR/docker-compose.mirofish.yml" ]] && mirofish_compose=(-f "$APP_DIR/docker-compose.mirofish.yml")
  docker compose --project-name ai-trading --env-file "$APP_DIR/images.env" -f "$APP_DIR/docker-compose.yml" "${mirofish_compose[@]}" "$@"
}

# mirofish_enabled: true only when *this* run actually activated MiroFish --
# COMPOSE_PROFILES=mirofish (inherited from deploy.sh's own activate_mirofish,
# which deploy_tag invokes this script right after). Never just because
# $AI_TRADING_RUNTIME_ENV_DIR/mirofish.env happens to still exist on disk: a
# redeploy after MiroFish was previously activated, but whose own
# MIROFISH_ACTIVATE isn't set this time, correctly unsets COMPOSE_PROFILES
# (deploy.sh's own activate_mirofish does this unconditionally) and must
# still pass health-check even though that stale file is still sitting
# there from the earlier run.
#
# Deliberately does NOT also require `compose ps -q mirofish` to be
# non-empty (review P1, round 2): that extra check made a *died/stopped*
# mirofish container silently drop out of SERVICES instead of failing --
# COMPOSE_PROFILES=mirofish said "this deploy enabled it," so the service
# belongs in SERVICES regardless of its current container state, and
# service_ok() below already fails correctly on a missing or stopped
# container (same as it does for every other service).
mirofish_enabled() {
  [[ "${COMPOSE_PROFILES:-}" == mirofish ]]
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

# --- main flow below this line; test-deploy-firestore.sh sources only the
# function definitions above it and calls them directly. ---
SERVICES=(web ta-terminal ahf-terminal vibe-trading cloudflared gateway auth)
mirofish_enabled && SERVICES+=(mirofish)

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
