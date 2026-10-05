#!/usr/bin/env bash
# Deploys one image tag of the ai-trading stack. Runs on the VPS as root.
#   IMAGE_TAG        commit SHA built by .github/workflows/ai-trading-deploy.yml (required)
#   DOCKER_CONFIG    registry credentials prepared by the workflow (optional)
#   ENV_STAGING_DIR  directory with freshly rendered *.env files to install (optional)
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/family-app/ai-trading}"
SECRETS_DIR="${AI_TRADING_SECRETS_DIR:-/etc/family-app/ai-trading}"
REGISTRY="${AI_TRADING_REGISTRY:-ghcr.io/thangtran3112/family-app}"
ENV_STAGING_DIR="${ENV_STAGING_DIR:-}"
STATE_FILE="$APP_DIR/last-good-tag"
IMAGES_ENV="$APP_DIR/images.env"
SECRET_FILES=(tradingagents.env ai-hedge-fund.env vibe-trading.env cloudflared.env)

die() {
  echo "deploy: $*" >&2
  exit 1
}

[[ "${IMAGE_TAG:-}" =~ ^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$ ]] || die "IMAGE_TAG must be a full commit SHA"

# validate_staged_file FILE: blank lines, # comments, or KEY=value with a
# non-empty value; never a NUL or CR byte anywhere in the file.
validate_staged_file() {
  local file="$1" line
  [[ -f "$file" ]] || die "missing staged $file"
  if ! cmp -s <(LC_ALL=C tr -d '\000' <"$file") "$file"; then
    die "$file contains a NUL byte"
  fi
  if LC_ALL=C grep -q $'\r' "$file"; then
    die "$file contains a CR byte"
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == '#'* ]] && continue
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*=.+$ ]] || die "$file: invalid line: $line"
  done <"$file"
}

# stage_secrets: validates every staged file first (no side effects on
# failure), then backs up the current secrets to .previous/ and installs the
# staged files as root:root 0600.
stage_secrets() {
  local name
  for name in "${SECRET_FILES[@]}"; do
    validate_staged_file "$ENV_STAGING_DIR/$name"
  done
  install -d -m 0700 "$SECRETS_DIR" "$SECRETS_DIR/.previous"
  for name in "${SECRET_FILES[@]}"; do
    [[ -f "$SECRETS_DIR/$name" ]] && cp -p "$SECRETS_DIR/$name" "$SECRETS_DIR/.previous/$name"
  done
  for name in "${SECRET_FILES[@]}"; do
    install -o root -g root -m 0600 "$ENV_STAGING_DIR/$name" "$SECRETS_DIR/$name"
  done
}

# restore_previous_secrets: used by rollback to undo a partially-applied
# stage_secrets before redeploying the previous tag.
restore_previous_secrets() {
  local name
  for name in "${SECRET_FILES[@]}"; do
    [[ -f "$SECRETS_DIR/.previous/$name" ]] && install -o root -g root -m 0600 "$SECRETS_DIR/.previous/$name" "$SECRETS_DIR/$name"
  done
}

if [[ -n "$ENV_STAGING_DIR" ]]; then
  stage_secrets
fi

for name in "${SECRET_FILES[@]}"; do
  file="$SECRETS_DIR/$name"
  [[ -f "$file" ]] || die "missing $file; render and stage env files first"
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
  if [[ -n "$ENV_STAGING_DIR" ]]; then
    restore_previous_secrets
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
