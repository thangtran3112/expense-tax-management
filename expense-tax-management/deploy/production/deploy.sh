#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
TARGET_ENV_FILE="${PRODUCTION_ENV_FILE:-/etc/expense-tax-management/production.env}"
INCOMING_ENV_FILE="${DEPLOY_ENV_FILE:-${2:-$TARGET_ENV_FILE}}"
STATE_FILE="${DEPLOYED_IMAGE_TAG_FILE:-/opt/expense-tax-management/app/deployed-image-tag}"
PROJECT_NAME="expense-tax-production"
COMPOSE_ENV_FILE="$INCOMING_ENV_FILE"
IMAGE_TAG="${IMAGE_TAG:-${1:-}}"

# Allowlist is deliberately narrower than a shell environment. Values are data
# only; no line is ever evaluated as shell syntax.
KNOWN_ENV_KEYS=(
  OPENAI_API_KEY OPENROUTER_API_KEY AUTH_PROVIDER
  APP_TENANT_TOKEN_ISSUER APP_TENANT_TOKEN_AUDIENCE APP_TENANT_JWKS_URL
  APP_SERVICE_TOKEN_ISSUER APP_SERVICE_TOKEN_AUDIENCE APP_SERVICE_JWKS_URL
  APP_DATABASE_URL APP_MIGRATION_DATABASE_URL
  FOUNDRY_PLATFORM_TOKEN_ISSUER FOUNDRY_PLATFORM_TOKEN_AUDIENCE FOUNDRY_PLATFORM_JWKS_URL
  FOUNDRY_SERVICE_TOKEN_ISSUER FOUNDRY_SERVICE_TOKEN_AUDIENCE FOUNDRY_SERVICE_JWKS_URL
  FOUNDRY_DATABASE_URL FOUNDRY_MIGRATION_DATABASE_URL
  CLERK_ISSUER_URL CLERK_JWKS_URL CLERK_TENANT_AUDIENCE CLERK_PLATFORM_AUDIENCE
  CLERK_APP_SERVICE_AUDIENCE CLERK_FOUNDRY_SERVICE_AUDIENCE
  CLERK_APP_SERVICE_SUBJECT CLERK_FOUNDRY_SERVICE_SUBJECT
  CLERK_APP_MACHINE_SECRET_KEY CLERK_FOUNDRY_MACHINE_SECRET_KEY CLERK_WEBHOOK_SIGNING_SECRET
  STORAGE_BACKEND STORAGE_LOCAL_BASE_URL STORAGE_URL_SIGNING_KEY
  INBOUND_EMAIL_BASE_ADDRESS INBOUND_WEBHOOK_SIGNING_KEY INBOUND_ROUTING_TOKEN_SECRET
)

die() {
  printf 'Deployment failed: %s\n' "$1" >&2
  exit 1
}

[[ "$IMAGE_TAG" =~ ^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$ ]] || die "IMAGE_TAG must be a full 40- or 64-character hexadecimal SHA"

file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

validate_env_file() {
  local file=$1 mode
  [[ -f "$file" && ! -L "$file" ]] || die "production env must be a regular file, not a symlink"
  [[ "$(stat -c '%u' "$file" 2>/dev/null || stat -f '%u' "$file")" == "0" ]] || die "production env file must be root-owned"
  mode=$(file_mode "$file")
  [[ "$mode" == "600" || "$mode" == "0600" ]] || die "production env file must have exact mode 0600"
}

validate_env_bytes() {
  local file=$1
  # Permit line-feed separators only. All other C0 controls, DEL, and NUL are unsafe.
  if ! LC_ALL=C od -An -v -tu1 "$file" | awk '{for (i = 1; i <= NF; i++) { if (($i < 10) || ($i > 10 && $i < 32) || ($i == 127)) { exit 1 } }}'; then
    die "production env contains unsafe control bytes"
  fi
}

is_known_key() {
  local candidate=$1 key
  for key in "${KNOWN_ENV_KEYS[@]}"; do
    [[ "$candidate" == "$key" ]] && return 0
  done
  return 1
}

load_env_file() {
  local file=$1 line key value line_number=0
  declare -A seen=()
  validate_env_bytes "$file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    ((line_number += 1))
    [[ -z "$line" ]] && continue
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || die "malformed production env line $line_number"
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    is_known_key "$key" || die "unknown production env key: $key"
    [[ -z "${seen[$key]+set}" ]] || die "duplicate production env key: $key"
    seen[$key]=1
    [[ "$value" =~ [[:cntrl:]] ]] && die "unsafe bytes in production env key: $key"
    [[ "$value" != *'\'* && "$value" != *'`'* && "$value" != *'$'* ]] || die "unsafe value for production env key: $key"
    printf -v "$key" '%s' "$value"
    export "$key"
  done <"$file"
}

validate_auth_values() {
  local key value
  for key in \
    AUTH_PROVIDER \
    APP_TENANT_TOKEN_ISSUER APP_TENANT_TOKEN_AUDIENCE APP_TENANT_JWKS_URL \
    APP_SERVICE_TOKEN_ISSUER APP_SERVICE_TOKEN_AUDIENCE APP_SERVICE_JWKS_URL \
    FOUNDRY_PLATFORM_TOKEN_ISSUER FOUNDRY_PLATFORM_TOKEN_AUDIENCE FOUNDRY_PLATFORM_JWKS_URL \
    FOUNDRY_SERVICE_TOKEN_ISSUER FOUNDRY_SERVICE_TOKEN_AUDIENCE FOUNDRY_SERVICE_JWKS_URL \
    CLERK_ISSUER_URL CLERK_JWKS_URL CLERK_TENANT_AUDIENCE CLERK_PLATFORM_AUDIENCE \
    CLERK_APP_SERVICE_AUDIENCE CLERK_FOUNDRY_SERVICE_AUDIENCE \
    CLERK_APP_SERVICE_SUBJECT CLERK_FOUNDRY_SERVICE_SUBJECT \
    CLERK_APP_MACHINE_SECRET_KEY CLERK_FOUNDRY_MACHINE_SECRET_KEY CLERK_WEBHOOK_SIGNING_SECRET; do
    value=${!key:-}
    [[ -n "$value" ]] || die "$key is required"
    if [[ "$key" == "AUTH_PROVIDER" && "$value" != "clerk" ]]; then
      die "AUTH_PROVIDER must be clerk"
    fi
    if [[ "$key" == "CLERK_WEBHOOK_SIGNING_SECRET" && ! "$value" =~ ^whsec_[^[:space:]]+$ ]]; then
      die "CLERK_WEBHOOK_SIGNING_SECRET must match whsec_ secret shape"
    fi
    case "$value" in
      https://identity.not-configured.invalid|https://identity.not-configured.invalid/.well-known/jwks.json|https://services.not-configured.invalid|https://services.not-configured.invalid/.well-known/jwks.json|not-configured)
        # Explicit Phase 1B values are nonfunctional: JWKS cannot resolve and
        # worker tokens are rejected until identity is configured.
        ;;
      *not-yet-issued*|*change-in-production*|*placeholder*|*expense-tax.local*|*not-configured*)
        die "$key contains an unapproved placeholder value"
        ;;
    esac
  done
}

compose() {
  docker compose --project-name "$PROJECT_NAME" --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

require_shared_temporal() {
  local legacy_server
  legacy_server=$(docker ps --quiet --filter "label=com.docker.compose.project=$PROJECT_NAME" --filter label=com.docker.compose.service=temporal) || die "cannot inspect legacy Temporal"
  [[ -z "$legacy_server" ]] || die "Expense-owned Temporal must be stopped before shared deployment"
  docker network inspect family_shared >/dev/null 2>&1 || die "shared network is unavailable"
  docker exec family-temporal temporal operator cluster health --address temporal:7233 >/dev/null 2>&1 || die "shared Temporal is unavailable"
  docker exec family-temporal temporal operator namespace describe --address temporal:7233 --namespace expense-tax >/dev/null 2>&1 || die "expense-tax Temporal namespace is unavailable"
}

APPLICATION_SERVICES=(app-api foundry-service ai-worker capture-web office-web foundry-web)
verify_running_images() {
  local expected_tag=$1 service container_id actual_image
  for service in "${APPLICATION_SERVICES[@]}"; do
    container_id=$(compose ps -q "$service")
    [[ -n "$container_id" ]] || { printf 'missing running container: %s\n' "$service" >&2; return 1; }
    actual_image=$(docker inspect --format '{{.Config.Image}}' "$container_id")
    [[ "$actual_image" == "ghcr.io/thangtran3112/family-app/expense-tax-${service}:${expected_tag}" ]] || {
      printf 'image mismatch for %s: expected tag %s\n' "$service" "$expected_tag" >&2
      return 1
    }
  done
}

validate_env_file "$INCOMING_ENV_FILE"
if [[ -e "$TARGET_ENV_FILE" ]]; then validate_env_file "$TARGET_ENV_FILE"; fi
load_env_file "$INCOMING_ENV_FILE"
validate_auth_values
export IMAGE_TAG
compose config --quiet
require_shared_temporal

previous_tag=""
if [[ -f "$STATE_FILE" ]]; then
  previous_tag=$(<"$STATE_FILE")
  [[ "$previous_tag" =~ ^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$ ]] || die "recorded prior image tag is invalid"
fi

state_dir=$(dirname -- "$STATE_FILE")
mkdir -p "$state_dir"
chmod 0755 "$state_dir"
env_backup=$(mktemp)
target_env_tmp=""
had_target=0
if [[ -e "$TARGET_ENV_FILE" ]]; then had_target=1; fi
cleanup() { rm -f -- "$env_backup" "$target_env_tmp"; }
trap cleanup EXIT

rollback() {
  local status=$1 rollback_status=0
  trap - ERR
  if [[ "$INCOMING_ENV_FILE" != "$TARGET_ENV_FILE" ]]; then
    if ((had_target == 1)); then
      install -o root -g root -m 0600 "$env_backup" "$TARGET_ENV_FILE" || true
      validate_env_file "$TARGET_ENV_FILE" || true
    else
      rm -f -- "$TARGET_ENV_FILE" || true
    fi
  fi
  if [[ -n "$previous_tag" ]]; then
    printf 'Deployment failed; restoring prior image tag\n' >&2
    IMAGE_TAG="$previous_tag"
    export IMAGE_TAG
    if ! compose pull; then rollback_status=1; fi
    if ! compose up -d "${APPLICATION_SERVICES[@]}"; then rollback_status=1; fi
    if ! PRODUCTION_ENV_FILE="$COMPOSE_ENV_FILE" "$SCRIPT_DIR/health-check.sh"; then rollback_status=1; fi
    if ! verify_running_images "$previous_tag"; then rollback_status=1; fi
    if ((rollback_status != 0)); then
      printf 'rollback failed after original deployment failure (status %s)\n' "$status" >&2
    else
      printf 'rollback verified at prior image tag %s\n' "$previous_tag" >&2
    fi
  fi
  exit "$status"
}
trap 'rollback "$?"' ERR

if [[ "$INCOMING_ENV_FILE" != "$TARGET_ENV_FILE" ]]; then
  target_env_dir=$(dirname -- "$TARGET_ENV_FILE")
  install -d -m 0755 "$target_env_dir"
  if [[ -e "$TARGET_ENV_FILE" ]]; then cp --preserve=mode,ownership "$TARGET_ENV_FILE" "$env_backup"; fi
  target_env_tmp=$(mktemp "$target_env_dir/.production.env.XXXXXX")
  install -o root -g root -m 0600 "$INCOMING_ENV_FILE" "$target_env_tmp"
  mv -f -- "$target_env_tmp" "$TARGET_ENV_FILE"
  target_env_tmp=""
  validate_env_file "$TARGET_ENV_FILE"
  COMPOSE_ENV_FILE="$TARGET_ENV_FILE"
  export COMPOSE_ENV_FILE
fi

compose pull
compose run --rm app-api-migrate
compose run --rm foundry-service-migrate
compose up -d "${APPLICATION_SERVICES[@]}"
"$SCRIPT_DIR/health-check.sh"
verify_running_images "$IMAGE_TAG"

tmp_state=$(mktemp "$state_dir/.deployed-image-tag.XXXXXX")
printf '%s\n' "$IMAGE_TAG" >"$tmp_state"
chmod 0644 "$tmp_state"
chown root:root "$tmp_state"
mv -f -- "$tmp_state" "$STATE_FILE"
trap - ERR
