#!/usr/bin/env bash
# Deploys one image tag of the ai-trading stack. Runs on the VPS as root.
#   IMAGE_TAG            commit SHA built by .github/workflows/ai-trading-deploy.yml (required)
#   DOCKER_CONFIG        registry credentials prepared by the workflow (optional)
#   ENV_STAGING_DIR       directory with freshly rendered *.env files to install (optional)
#   DEPLOY_SH_SKIP_CHOWN  test-only: skip the root:root chown on installed/restored
#                         secret files, so stage_secrets/rollback can be dry-run as a
#                         non-root user. Never set this in production.
#   DEPLOY_SH_FAIL_AFTER  test-only: name of a SECRET_FILES entry (e.g. ai-hedge-fund.env);
#                         stage_secrets aborts right after installing that file, to
#                         dry-run rollback without needing a real install failure. Never
#                         set this in production.
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/family-app/ai-trading}"
SECRETS_DIR="${AI_TRADING_SECRETS_DIR:-/etc/family-app/ai-trading}"
REGISTRY="${AI_TRADING_REGISTRY:-ghcr.io/thangtran3112/family-app}"
ENV_STAGING_DIR="${ENV_STAGING_DIR:-}"
STATE_FILE="$APP_DIR/last-good-tag"
IMAGES_ENV="$APP_DIR/images.env"
SECRET_FILES=(tradingagents.env ai-hedge-fund.env vibe-trading.env cloudflared.env)
# Tracks, per secret file, whether it existed before this run's staging so
# rollback can tell "restore the backup" from "delete what we just created".
declare -A PRIOR_EXISTED=()

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

# install_secret_file SRC DEST: writes DEST atomically (a root:root 0600 temp
# file on DEST's filesystem, then `mv -f` over DEST) so a reader never sees a
# partially-written file and a failure never leaves DEST truncated.
install_secret_file() {
  local src="$1" dest="$2" tmp
  tmp="$(mktemp "$(dirname "$dest")/.$(basename "$dest").XXXXXX")"
  if [[ -n "${DEPLOY_SH_SKIP_CHOWN:-}" ]]; then
    install -m 0600 "$src" "$tmp"
  else
    install -o root -g root -m 0600 "$src" "$tmp"
  fi
  mv -f "$tmp" "$dest"
}

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

# restore_or_remove_secrets: used by rollback to undo a partially- or fully-
# applied stage_secrets. A file that existed before this run is restored from
# its backup; a file that did not (first deploy) is deleted, never left
# behind as a leftover new secret.
restore_or_remove_secrets() {
  local name
  for name in "${SECRET_FILES[@]}"; do
    if [[ "${PRIOR_EXISTED[$name]:-0}" == 1 ]]; then
      [[ -f "$SECRETS_DIR/.previous/$name" ]] && install_secret_file "$SECRETS_DIR/.previous/$name" "$SECRETS_DIR/$name"
    else
      rm -f "$SECRETS_DIR/$name"
    fi
  done
}

rollback() {
  local status="$1" previous=""
  trap - ERR
  if [[ -n "$ENV_STAGING_DIR" ]]; then
    restore_or_remove_secrets
  fi
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

# stage_secrets: validates every staged file first (no side effects on
# failure). Only then does it record which target files already exist, back
# those up to .previous/, and arm the rollback trap -- all before installing
# anything -- so a failure partway through the four atomic installs below is
# always caught and always rolled back to exactly the prior state. `rollback`
# and everything it calls are defined above, before this function is ever
# invoked, so the trap it arms always resolves.
stage_secrets() {
  local name
  for name in "${SECRET_FILES[@]}"; do
    validate_staged_file "$ENV_STAGING_DIR/$name"
  done

  install -d -m 0700 "$SECRETS_DIR" "$SECRETS_DIR/.previous"

  for name in "${SECRET_FILES[@]}"; do
    if [[ -f "$SECRETS_DIR/$name" ]]; then
      PRIOR_EXISTED[$name]=1
      cp -p "$SECRETS_DIR/$name" "$SECRETS_DIR/.previous/$name"
    else
      PRIOR_EXISTED[$name]=0
    fi
  done
  trap 'rollback "$?"' ERR

  for name in "${SECRET_FILES[@]}"; do
    install_secret_file "$ENV_STAGING_DIR/$name" "$SECRETS_DIR/$name"
    # `return 1` here would not reliably trigger the ERR trap just armed
    # above (a function's own `return` does not fire a trap set during that
    # same call, only one already armed before the call) -- a real failing
    # command does, so use one.
    [[ "$name" != "${DEPLOY_SH_FAIL_AFTER:-}" ]] || false
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

trap 'rollback "$?"' ERR

install -d -m 0755 "$APP_DIR"
deploy_tag "$IMAGE_TAG"
printf '%s\n' "$IMAGE_TAG" >"$STATE_FILE.tmp"
mv -f "$STATE_FILE.tmp" "$STATE_FILE"
echo "deploy: ai-trading is running $IMAGE_TAG"
