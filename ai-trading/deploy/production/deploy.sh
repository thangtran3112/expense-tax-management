#!/usr/bin/env bash
# Deploys one image tag of the ai-trading stack. Runs on the VPS as root.
#   IMAGE_TAG      commit SHA built by .github/workflows/ai-trading-deploy.yml (required)
#   DOCKER_CONFIG  registry credentials prepared by the workflow (optional)
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/family-app/ai-trading}"
SECRETS_DIR="${AI_TRADING_SECRETS_DIR:-/etc/family-app/ai-trading}"
REGISTRY="${AI_TRADING_REGISTRY:-ghcr.io/thangtran3112/family-app}"
STATE_FILE="$APP_DIR/last-good-tag"
IMAGES_ENV="$APP_DIR/images.env"
SECRET_FILES=(tradingagents.env ai-hedge-fund.env vibe-trading.env cloudflared.env)

die() {
  echo "deploy: $*" >&2
  exit 1
}

[[ "${IMAGE_TAG:-}" =~ ^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$ ]] || die "IMAGE_TAG must be a full commit SHA"
for name in "${SECRET_FILES[@]}"; do
  file="$SECRETS_DIR/$name"
  [[ -f "$file" ]] || die "missing $file; run write-secrets.sh first"
  [[ "$(stat -c '%u:%a' "$file")" == "0:600" ]] || die "$file must be owned by root with mode 600"
done

compose() {
  docker compose --project-name ai-trading --env-file "$IMAGES_ENV" -f "$APP_DIR/docker-compose.yml" "$@"
}

deploy_tag() {
  local tag="$1" tmp
  tmp="$(mktemp "$APP_DIR/images.env.XXXXXX")"
  printf 'AI_TRADING_REGISTRY=%s\nAI_TRADING_IMAGE_TAG=%s\nAI_TRADING_SECRETS_DIR=%s\n' "$REGISTRY" "$tag" "$SECRETS_DIR" >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$IMAGES_ENV"
  compose pull
  compose up -d --remove-orphans --wait --wait-timeout 300
  "$APP_DIR/health-check.sh"
}

rollback() {
  local status="$1" previous=""
  trap - ERR
  if [[ -f "$STATE_FILE" ]]; then
    previous="$(cat "$STATE_FILE")"
  fi
  if [[ -n "$previous" && "$previous" != "$IMAGE_TAG" ]]; then
    echo "deploy: failed with status $status; rolling back to $previous" >&2
    deploy_tag "$previous" || echo "deploy: rollback to $previous failed too" >&2
  else
    echo "deploy: failed with status $status; no earlier tag to roll back to" >&2
  fi
  exit "$status"
}
trap 'rollback "$?"' ERR

install -d -m 0755 "$APP_DIR"
deploy_tag "$IMAGE_TAG"
printf '%s\n' "$IMAGE_TAG" >"$STATE_FILE.tmp"
mv -f "$STATE_FILE.tmp" "$STATE_FILE"
echo "deploy: ai-trading is running $IMAGE_TAG"
