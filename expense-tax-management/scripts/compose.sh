#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
FAMILY_ROOT="$(cd -- "$PROJECT_DIR/.." && pwd)"
# Real values come from the process environment (`pnpm with-env` loads them from
# Firestore family-config); the env file only supplies placeholder defaults.
ENV_FILE="${EXPENSE_TAX_ENV_FILE:-$PROJECT_DIR/.env.example}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "EXPENSE_TAX_ENV_FILE does not exist" >&2
  exit 1
fi

exec docker compose \
  --project-name infrastructure \
  --env-file "$ENV_FILE" \
  -f "$FAMILY_ROOT/infrastructure/docker-compose.common.yml" \
  -f "$FAMILY_ROOT/infrastructure/temporal/docker-compose.local.yml" \
  -f "$PROJECT_DIR/docker-compose.yml" \
  "$@"
