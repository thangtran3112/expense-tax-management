#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
# Phase 3D-A Task 5 (controller ruling): opt-in overlay, included by the
# compose helper function below only when the validated production env
# sets MAILBOX_FEATURE_ENABLED=true. Referenced with a `:-` default so
# this variable (and MAILBOX_FEATURE_ENABLED itself) stay safe to read
# before load_env_file exports them, and so a standalone extraction of
# that helper alone (e.g. a test harness) still behaves exactly like the
# pre-mailbox single-file invocation.
MAILBOX_COMPOSE_FILE="$SCRIPT_DIR/docker-compose.mailbox.yml"
# family_config.py writes the Firestore production profile to this root-only
# temp file for the duration of the deploy (`run ... --env-file-var DEPLOY_ENV_FILE`).
COMPOSE_ENV_FILE="${DEPLOY_ENV_FILE:-}"
STATE_FILE="${DEPLOYED_IMAGE_TAG_FILE:-/opt/expense-tax-management/app/deployed-image-tag}"
PROJECT_NAME="expense-tax-production"
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
  # Phase 3D-A Task 5: mailbox broker, opt-in. The production env file
  # always carries MAILBOX_FEATURE_ENABLED (true or false); every other
  # key here is only ever present -- with a real value -- when it is true
  # (the Firestore production profile carries none of them otherwise). Allowing
  # them unconditionally is harmless: an unknown-key line still fails
  # load_env_file regardless of this list's contents.
  MAILBOX_FEATURE_ENABLED
  MAILBOX_BROKER_PUBLIC_BASE_URL MAILBOX_ALLOWED_REDIRECT_ORIGINS
  CLERK_MAILBOX_SERVICE_AUDIENCE
  CLERK_MAILBOX_APP_API_SUBJECT CLERK_MAILBOX_WORKER_SUBJECT CLERK_MAILBOX_BROKER_SUBJECT
  CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY CLERK_MAILBOX_BROKER_MACHINE_SECRET_KEY
  MAILBOX_VAULT_KEYS MAILBOX_VAULT_ACTIVE_KEY_ID
  MAILBOX_BROKER_DATABASE_URL MAILBOX_BROKER_MIGRATION_DATABASE_URL
  MAILBOX_SERVICE_TOKEN_ISSUER MAILBOX_SERVICE_TOKEN_AUDIENCE MAILBOX_SERVICE_JWKS_URL
  GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET GOOGLE_OAUTH_REDIRECT_URI
)

die() {
  printf 'Deployment failed: %s\n' "$1" >&2
  exit 1
}

[[ "$IMAGE_TAG" =~ ^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$ ]] || die "IMAGE_TAG must be a full 40- or 64-character hexadecimal SHA"
[[ -n "$COMPOSE_ENV_FILE" ]] || die "DEPLOY_ENV_FILE is required; run deploy.sh through family_config.py run expense-tax-management/production --env-file-var DEPLOY_ENV_FILE"

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

# Required runtime values the production profile must carry. Mailbox values are
# required only when the feature is on, and the broker's inbound verifier must
# match what App API and the workflow worker mint against.
validate_required_values() {
  local key
  for key in OPENAI_API_KEY OPENROUTER_API_KEY \
    APP_DATABASE_URL APP_MIGRATION_DATABASE_URL FOUNDRY_DATABASE_URL FOUNDRY_MIGRATION_DATABASE_URL \
    CLERK_APP_MACHINE_SECRET_KEY CLERK_FOUNDRY_MACHINE_SECRET_KEY CLERK_WEBHOOK_SIGNING_SECRET; do
    [[ -n "${!key:-}" ]] || die "$key is required"
  done
  for key in STORAGE_URL_SIGNING_KEY INBOUND_WEBHOOK_SIGNING_KEY INBOUND_ROUTING_TOKEN_SECRET; do
    [[ "${!key:-}" =~ ^[0-9a-f]{64}$ ]] || die "$key must be 64 lowercase hex characters"
  done
  [[ "${MAILBOX_FEATURE_ENABLED:-false}" == "true" ]] || return 0
  for key in CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY CLERK_MAILBOX_BROKER_MACHINE_SECRET_KEY \
    MAILBOX_VAULT_KEYS MAILBOX_VAULT_ACTIVE_KEY_ID MAILBOX_BROKER_PUBLIC_BASE_URL MAILBOX_ALLOWED_REDIRECT_ORIGINS \
    GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET GOOGLE_OAUTH_REDIRECT_URI \
    MAILBOX_BROKER_DATABASE_URL MAILBOX_BROKER_MIGRATION_DATABASE_URL \
    CLERK_MAILBOX_SERVICE_AUDIENCE CLERK_MAILBOX_APP_API_SUBJECT CLERK_MAILBOX_WORKER_SUBJECT CLERK_MAILBOX_BROKER_SUBJECT \
    MAILBOX_SERVICE_TOKEN_ISSUER MAILBOX_SERVICE_TOKEN_AUDIENCE MAILBOX_SERVICE_JWKS_URL; do
    [[ -n "${!key:-}" ]] || die "$key is required when MAILBOX_FEATURE_ENABLED=true"
  done
  [[ "$MAILBOX_SERVICE_TOKEN_ISSUER" == "${CLERK_ISSUER_URL:-}" ]] || die "MAILBOX_SERVICE_TOKEN_ISSUER must equal CLERK_ISSUER_URL"
  [[ "$MAILBOX_SERVICE_JWKS_URL" == "${CLERK_JWKS_URL:-}" ]] || die "MAILBOX_SERVICE_JWKS_URL must equal CLERK_JWKS_URL"
  [[ "$MAILBOX_SERVICE_TOKEN_AUDIENCE" == "$CLERK_MAILBOX_SERVICE_AUDIENCE" ]] || die "MAILBOX_SERVICE_TOKEN_AUDIENCE must equal CLERK_MAILBOX_SERVICE_AUDIENCE"
}

compose() {
  local mailbox_overlay=()
  if [[ -n "${MAILBOX_COMPOSE_FILE:-}" && "${MAILBOX_FEATURE_ENABLED:-false}" == "true" ]]; then
    mailbox_overlay=(-f "$MAILBOX_COMPOSE_FILE")
  fi
  docker compose --project-name "$PROJECT_NAME" --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE" "${mailbox_overlay[@]}" "$@"
}

require_shared_temporal() {
  local legacy_server
  legacy_server=$(docker ps --quiet --filter "label=com.docker.compose.project=$PROJECT_NAME" --filter label=com.docker.compose.service=temporal) || die "cannot inspect legacy Temporal"
  [[ -z "$legacy_server" ]] || die "Expense-owned Temporal must be stopped before shared deployment"
  docker network inspect family_shared >/dev/null 2>&1 || die "shared network is unavailable"
  docker exec family-temporal temporal operator cluster health --address temporal:7233 >/dev/null 2>&1 || die "shared Temporal is unavailable"
  docker exec family-temporal temporal operator namespace describe --address temporal:7233 --namespace expense-tax >/dev/null 2>&1 || die "expense-tax Temporal namespace is unavailable"
}

APPLICATION_SERVICES=(app-api foundry-service ai-worker workflow-worker capture-web office-web foundry-web)
verify_running_images() {
  local expected_tag=$1
  shift
  local services=("$@") service container_id actual_image
  for service in "${services[@]}"; do
    container_id=$(compose ps -q "$service")
    [[ -n "$container_id" ]] || { printf 'missing running container: %s\n' "$service" >&2; return 1; }
    actual_image=$(docker inspect --format '{{.Config.Image}}' "$container_id")
    [[ "$actual_image" == "ghcr.io/thangtran3112/family-app/expense-tax-${service}:${expected_tag}" ]] || {
      printf 'image mismatch for %s: expected tag %s\n' "$service" "$expected_tag" >&2
      return 1
    }
  done
}

# workflow-worker is the only optional rollback service: production's
# currently-recorded previous_tag can predate the Task 7 Stage B commit
# that first built its image (main had no workflow-worker image before
# then), so a straight rollback would `compose pull`/`up` a nonexistent
# image and fail, stranding production on the broken release. Routing
# still targets generation 1 (Python, ai-worker) until an operator runs
# `advance`, so a rollback that omits workflow-worker entirely is safe --
# every other service stays mandatory exactly as before.
#
# Treated as available if EITHER the image already exists locally (the
# previous release's image normally remains on the VPS after a deploy) OR
# the registry manifest probe succeeds, retried a few times with a short
# backoff. A transient GHCR probe failure must not be treated the same as
# a genuinely missing image: after an operator runs `advance`,
# workflow-worker is the ACTIVE worker, so wrongly dropping it during a
# later rollback would stall processing, not just leave it idle. Only
# drop it when both the local check and every registry retry fail.
workflow_worker_image_exists() {
  local tag=$1
  local image="ghcr.io/thangtran3112/family-app/expense-tax-workflow-worker:${tag}"
  docker image inspect "$image" >/dev/null 2>&1 && return 0

  local attempts="${WORKFLOW_WORKER_PROBE_ATTEMPTS:-3}" delay="${WORKFLOW_WORKER_PROBE_DELAY_SECONDS:-2}" attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    docker manifest inspect "$image" >/dev/null 2>&1 && return 0
    ((attempt < attempts)) && sleep "$delay"
  done
  return 1
}

# Phase 3D-A Task 5 (controller ruling): same optional-image treatment as
# workflow-worker above, kept as its own self-contained function (not a
# shared helper) so a standalone extraction of either function -- e.g. a
# test harness -- continues to behave identically to before this task.
mailbox_broker_image_exists() {
  local tag=$1
  local image="ghcr.io/thangtran3112/family-app/expense-tax-mailbox-broker:${tag}"
  docker image inspect "$image" >/dev/null 2>&1 && return 0

  local attempts="${WORKFLOW_WORKER_PROBE_ATTEMPTS:-3}" delay="${WORKFLOW_WORKER_PROBE_DELAY_SECONDS:-2}" attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    docker manifest inspect "$image" >/dev/null 2>&1 && return 0
    ((attempt < attempts)) && sleep "$delay"
  done
  return 1
}

validate_env_file "$COMPOSE_ENV_FILE"
load_env_file "$COMPOSE_ENV_FILE"
validate_auth_values
validate_required_values
export IMAGE_TAG
# Phase 3D-A Task 5 (controller ruling): MAILBOX_FEATURE_ENABLED is only
# known once the production env file is loaded above, so the mailbox
# broker is appended here -- never inline in the static array declaration
# -- so an ordinary dev->main deploy (MAILBOX_FEATURE_ENABLED=false or
# unset) runs with exactly the pre-mailbox seven services.
if [[ "${MAILBOX_FEATURE_ENABLED:-false}" == "true" ]]; then
  APPLICATION_SERVICES+=(mailbox-broker)
fi
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

rollback() {
  local status=$1 rollback_status=0
  trap - ERR
  if [[ -n "$previous_tag" ]]; then
    printf 'Deployment failed; restoring prior image tag\n' >&2
    IMAGE_TAG="$previous_tag"
    export IMAGE_TAG

    local rollback_services=("${APPLICATION_SERVICES[@]}") required_workers="ai-worker workflow-worker"
    if ! workflow_worker_image_exists "$previous_tag"; then
      printf 'workflow-worker has no image for tag %s; rolling back without it\n' "$previous_tag" >&2
      rollback_services=()
      local service
      for service in "${APPLICATION_SERVICES[@]}"; do
        [[ "$service" == "workflow-worker" ]] || rollback_services+=("$service")
      done
      required_workers="ai-worker"
      compose rm --force --stop workflow-worker || true
    fi

    # Phase 3D-A Task 5 (controller ruling): mailbox-broker is optional the
    # same way, for the same reason -- only relevant when
    # MAILBOX_FEATURE_ENABLED=true put it in APPLICATION_SERVICES in the
    # first place; an ordinary (mailbox-disabled) rollback never has it in
    # rollback_services at all, so this is a no-op there.
    local has_mailbox_broker=0 rollback_service
    for rollback_service in "${rollback_services[@]}"; do
      [[ "$rollback_service" == "mailbox-broker" ]] && has_mailbox_broker=1
    done
    if ((has_mailbox_broker == 1)) && ! mailbox_broker_image_exists "$previous_tag"; then
      printf 'mailbox-broker has no image for tag %s; rolling back without it\n' "$previous_tag" >&2
      local filtered_services=()
      for rollback_service in "${rollback_services[@]}"; do
        [[ "$rollback_service" == "mailbox-broker" ]] || filtered_services+=("$rollback_service")
      done
      rollback_services=("${filtered_services[@]}")
      compose rm --force --stop mailbox-broker || true
    fi

    if ! compose pull "${rollback_services[@]}"; then rollback_status=1; fi
    if ! compose up -d "${rollback_services[@]}"; then rollback_status=1; fi
    if ! HEALTH_CHECK_REQUIRED_WORKERS="$required_workers" PRODUCTION_ENV_FILE="$COMPOSE_ENV_FILE" "$SCRIPT_DIR/health-check.sh"; then rollback_status=1; fi
    if ! verify_running_images "$previous_tag" "${rollback_services[@]}"; then rollback_status=1; fi
    if ((rollback_status != 0)); then
      printf 'rollback failed after original deployment failure (status %s)\n' "$status" >&2
    else
      printf 'rollback verified at prior image tag %s\n' "$previous_tag" >&2
    fi
  fi
  exit "$status"
}
trap 'rollback "$?"' ERR

compose pull
compose run --rm app-api-migrate
compose run --rm foundry-service-migrate
if [[ "${MAILBOX_FEATURE_ENABLED:-false}" == "true" ]]; then
  compose run --rm mailbox-broker-migrate
fi
compose up -d "${APPLICATION_SERVICES[@]}"
PRODUCTION_ENV_FILE="$COMPOSE_ENV_FILE" "$SCRIPT_DIR/health-check.sh"
verify_running_images "$IMAGE_TAG" "${APPLICATION_SERVICES[@]}"

tmp_state=$(mktemp "$state_dir/.deployed-image-tag.XXXXXX")
printf '%s\n' "$IMAGE_TAG" >"$tmp_state"
chmod 0644 "$tmp_state"
chown root:root "$tmp_state"
mv -f -- "$tmp_state" "$STATE_FILE"
trap - ERR
