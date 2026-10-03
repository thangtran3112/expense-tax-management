#!/usr/bin/env bash
set -euo pipefail
set -o pipefail
umask 077

PROJECT_ID="expense-tax-tobytran-2026"
SECRET_ID="expense-tax-production-env"
DATABASE_ENV_PATH="${DATABASE_ENV_PATH:-.keys/ovh/postgres-vps.env}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_MODULE="$(cd "$SCRIPT_DIR/../../../scripts/lib" && pwd)/production-secret-bundle.mjs"
TEMP_DIR="$(mktemp -d)"
BUNDLE_FILE="$TEMP_DIR/bundle.env"
CURRENT_FILE="$TEMP_DIR/current.env"
VERSIONS_FILE="$TEMP_DIR/versions.json"
VERIFY_FILE="$TEMP_DIR/verify.env"
API_ENV_FILE="$TEMP_DIR/api.env"

cleanup() {
  rm -f "$BUNDLE_FILE" "$CURRENT_FILE" "$VERSIONS_FILE" "$VERIFY_FILE" "$API_ENV_FILE"
  rmdir "$TEMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT
chmod 700 "$TEMP_DIR"

if [[ ! -f "$DATABASE_ENV_PATH" ]]; then
  echo "database env file not found: $DATABASE_ENV_PATH" >&2
  exit 1
fi

gcloud secrets versions list "$SECRET_ID" --project="$PROJECT_ID" --format=json > "$VERSIONS_FILE"
CURRENT_VERSION_IDS="$(env -i PATH="$PATH" VERSIONS_FILE="$VERSIONS_FILE" BUNDLE_MODULE="$BUNDLE_MODULE" node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
const { activeVersionIds } = await import(process.env.BUNDLE_MODULE);
const versions = JSON.parse(readFileSync(process.env.VERSIONS_FILE, "utf8"));
for (const version of activeVersionIds(versions)) console.log(version);
NODE
)"
if [[ -n "$CURRENT_VERSION_IDS" ]]; then
  if ! gcloud secrets versions access latest --secret="$SECRET_ID" --project="$PROJECT_ID" > "$CURRENT_FILE"; then
    echo "current secret access failed; refusing destructive rotation" >&2
    exit 1
  fi
  chmod 600 "$CURRENT_FILE"
  CURRENT_ENV_PATH="$CURRENT_FILE"
else
  echo "only proven no-version state: no non-destroyed secret version"
  rm -f "$CURRENT_FILE"
  CURRENT_ENV_PATH=""
fi

API_ENV_FILE="$API_ENV_FILE" zsh -dfic '
  # Startup files are user-controlled; discard all startup output before loading them.
  set +x
  exec 3>&2
  exec >/dev/null 2>&1
  source ~/.zshrc
  set +x
  exec 2>&3 3>&-
  : "${OPENAI_API_KEY:?OPENAI_API_KEY must be set in ~/.zshrc}"
  : "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY must be set in ~/.zshrc}"
  : "${CLERK_APP_MACHINE_SECRET_KEY:?CLERK_APP_MACHINE_SECRET_KEY must be set in ~/.zshrc}"
  : "${CLERK_FOUNDRY_MACHINE_SECRET_KEY:?CLERK_FOUNDRY_MACHINE_SECRET_KEY must be set in ~/.zshrc}"
  : "${CLERK_WEBHOOK_SIGNING_SECRET_FILE:?CLERK_WEBHOOK_SIGNING_SECRET_FILE must point to a mode-0600 file}"
  if [[ ! -f "$CLERK_WEBHOOK_SIGNING_SECRET_FILE" ]]; then
    echo "CLERK_WEBHOOK_SIGNING_SECRET_FILE not found" >&2
    exit 1
  fi
  SECRET_FILE_MODE="$(stat -f '%Lp' "$CLERK_WEBHOOK_SIGNING_SECRET_FILE" 2>/dev/null || true)"
  [[ "$SECRET_FILE_MODE" =~ ^[0-7]+$ ]] || SECRET_FILE_MODE="$(stat -c '%a' "$CLERK_WEBHOOK_SIGNING_SECRET_FILE" 2>/dev/null || true)"
  [[ "$SECRET_FILE_MODE" == "600" ]] || { echo "CLERK_WEBHOOK_SIGNING_SECRET_FILE must have mode 0600" >&2; exit 1; }
  CLERK_WEBHOOK_SIGNING_SECRET="$(<"$CLERK_WEBHOOK_SIGNING_SECRET_FILE")"
  [[ "$CLERK_WEBHOOK_SIGNING_SECRET" =~ '^whsec_[^[:space:]]+$' ]] || { echo "CLERK_WEBHOOK_SIGNING_SECRET_FILE must contain a nonempty whsec_ secret" >&2; exit 1; }
  : "${AUTH_PROVIDER:?AUTH_PROVIDER must be set in ~/.zshrc}"
  : "${CLERK_ISSUER_URL:?CLERK_ISSUER_URL must be set in ~/.zshrc}"
  : "${CLERK_JWKS_URL:?CLERK_JWKS_URL must be set in ~/.zshrc}"
  : "${CLERK_TENANT_AUDIENCE:?CLERK_TENANT_AUDIENCE must be set in ~/.zshrc}"
  : "${CLERK_PLATFORM_AUDIENCE:?CLERK_PLATFORM_AUDIENCE must be set in ~/.zshrc}"
  : "${CLERK_APP_SERVICE_AUDIENCE:?CLERK_APP_SERVICE_AUDIENCE must be set in ~/.zshrc}"
  : "${CLERK_FOUNDRY_SERVICE_AUDIENCE:?CLERK_FOUNDRY_SERVICE_AUDIENCE must be set in ~/.zshrc}"
  : "${CLERK_APP_SERVICE_SUBJECT:?CLERK_APP_SERVICE_SUBJECT must be set in ~/.zshrc}"
  : "${CLERK_FOUNDRY_SERVICE_SUBJECT:?CLERK_FOUNDRY_SERVICE_SUBJECT must be set in ~/.zshrc}"
  [[ "$AUTH_PROVIDER" == "clerk" ]] || { echo "AUTH_PROVIDER must be clerk" >&2; exit 1; }
  [[ "$CLERK_ISSUER_URL" == "https://clerk.tobytran.dev" ]] || { echo "CLERK_ISSUER_URL does not match approved production issuer" >&2; exit 1; }
  [[ "$CLERK_JWKS_URL" == "https://clerk.tobytran.dev/.well-known/jwks.json" ]] || { echo "CLERK_JWKS_URL does not match approved production JWKS" >&2; exit 1; }
  [[ "$CLERK_TENANT_AUDIENCE" == "expense-app" ]] || { echo "CLERK_TENANT_AUDIENCE does not match approved production audience" >&2; exit 1; }
  [[ "$CLERK_PLATFORM_AUDIENCE" == "expense-foundry-platform" ]] || { echo "CLERK_PLATFORM_AUDIENCE does not match approved production audience" >&2; exit 1; }
  [[ "$CLERK_APP_SERVICE_AUDIENCE" == "mch_3JAI0juruFRPSkrE1rpcDKx1k1i" ]] || { echo "CLERK_APP_SERVICE_AUDIENCE does not match approved production target" >&2; exit 1; }
  [[ "$CLERK_FOUNDRY_SERVICE_AUDIENCE" == "mch_3JAIAMNUiVXteVOki8QENYHvJjp" ]] || { echo "CLERK_FOUNDRY_SERVICE_AUDIENCE does not match approved production target" >&2; exit 1; }
  [[ "$CLERK_APP_SERVICE_SUBJECT" == "mch_3JAIPnx8itUTJsizuEGewr6NGBX" ]] || { echo "CLERK_APP_SERVICE_SUBJECT does not match approved production source" >&2; exit 1; }
  [[ "$CLERK_FOUNDRY_SERVICE_SUBJECT" == "mch_3JAIi2BwnqBf8bNzbjTtjJa6nGw" ]] || { echo "CLERK_FOUNDRY_SERVICE_SUBJECT does not match approved production source" >&2; exit 1; }
  # Phase 3D-A Task 5 (controller ruling): mailbox production wiring is
  # opt-in. These required-presence checks run only when the operator
  # shell sets MAILBOX_FEATURE_ENABLED=true in ~/.zshrc -- an ordinary
  # operator who has never touched mailbox config is never asked for any
  # of these keys. Export/pass-through below is unconditional (forwarding
  # an unset value as empty is harmless: buildProductionBundle only
  # requires them when the flag is true).
  MAILBOX_FEATURE_ENABLED="${MAILBOX_FEATURE_ENABLED:-false}"
  if [[ "$MAILBOX_FEATURE_ENABLED" == "true" ]]; then
    : "${CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY:?CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY must be set in ~/.zshrc}"
    : "${CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY:?CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY must be set in ~/.zshrc}"
    : "${CLERK_MAILBOX_BROKER_MACHINE_SECRET_KEY:?CLERK_MAILBOX_BROKER_MACHINE_SECRET_KEY must be set in ~/.zshrc}"
    : "${MAILBOX_VAULT_KEYS:?MAILBOX_VAULT_KEYS must be set in ~/.zshrc}"
    : "${MAILBOX_VAULT_ACTIVE_KEY_ID:?MAILBOX_VAULT_ACTIVE_KEY_ID must be set in ~/.zshrc}"
    : "${MAILBOX_BROKER_PUBLIC_BASE_URL:?MAILBOX_BROKER_PUBLIC_BASE_URL must be set in ~/.zshrc}"
    : "${MAILBOX_ALLOWED_REDIRECT_ORIGINS:?MAILBOX_ALLOWED_REDIRECT_ORIGINS must be set in ~/.zshrc}"
    : "${GOOGLE_OAUTH_CLIENT_ID:?GOOGLE_OAUTH_CLIENT_ID must be set in ~/.zshrc}"
    : "${GOOGLE_OAUTH_CLIENT_SECRET:?GOOGLE_OAUTH_CLIENT_SECRET must be set in ~/.zshrc}"
    : "${GOOGLE_OAUTH_REDIRECT_URI:?GOOGLE_OAUTH_REDIRECT_URI must be set in ~/.zshrc}"
    : "${CLERK_MAILBOX_SERVICE_AUDIENCE:?CLERK_MAILBOX_SERVICE_AUDIENCE must be set in ~/.zshrc}"
    : "${CLERK_MAILBOX_APP_API_SUBJECT:?CLERK_MAILBOX_APP_API_SUBJECT must be set in ~/.zshrc}"
    : "${CLERK_MAILBOX_WORKER_SUBJECT:?CLERK_MAILBOX_WORKER_SUBJECT must be set in ~/.zshrc}"
    : "${CLERK_MAILBOX_BROKER_SUBJECT:?CLERK_MAILBOX_BROKER_SUBJECT must be set in ~/.zshrc}"
  fi
  umask 077
  # Export only required API-key variables and runtime values into protected builder input.
  printf "export OPENAI_API_KEY=%q\\nexport OPENROUTER_API_KEY=%q\\nexport CLERK_APP_MACHINE_SECRET_KEY=%q\\nexport CLERK_FOUNDRY_MACHINE_SECRET_KEY=%q\\nexport AUTH_PROVIDER=%q\\nexport CLERK_ISSUER_URL=%q\\nexport CLERK_JWKS_URL=%q\\nexport CLERK_TENANT_AUDIENCE=%q\\nexport CLERK_PLATFORM_AUDIENCE=%q\\nexport CLERK_APP_SERVICE_AUDIENCE=%q\\nexport CLERK_FOUNDRY_SERVICE_AUDIENCE=%q\\nexport CLERK_APP_SERVICE_SUBJECT=%q\\nexport CLERK_FOUNDRY_SERVICE_SUBJECT=%q\\n" \
    "$OPENAI_API_KEY" "$OPENROUTER_API_KEY" \
    "$CLERK_APP_MACHINE_SECRET_KEY" "$CLERK_FOUNDRY_MACHINE_SECRET_KEY" \
    "$AUTH_PROVIDER" "$CLERK_ISSUER_URL" "$CLERK_JWKS_URL" \
    "$CLERK_TENANT_AUDIENCE" "$CLERK_PLATFORM_AUDIENCE" \
    "$CLERK_APP_SERVICE_AUDIENCE" "$CLERK_FOUNDRY_SERVICE_AUDIENCE" \
    "$CLERK_APP_SERVICE_SUBJECT" "$CLERK_FOUNDRY_SERVICE_SUBJECT" > "$API_ENV_FILE"
  printf "export CLERK_WEBHOOK_SIGNING_SECRET=%q\\n" "$CLERK_WEBHOOK_SIGNING_SECRET" >> "$API_ENV_FILE"
  printf "export MAILBOX_FEATURE_ENABLED=%q\\nexport CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY=%q\\nexport CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY=%q\\nexport CLERK_MAILBOX_BROKER_MACHINE_SECRET_KEY=%q\\nexport MAILBOX_VAULT_KEYS=%q\\nexport MAILBOX_VAULT_ACTIVE_KEY_ID=%q\\nexport MAILBOX_BROKER_PUBLIC_BASE_URL=%q\\nexport MAILBOX_ALLOWED_REDIRECT_ORIGINS=%q\\nexport GOOGLE_OAUTH_CLIENT_ID=%q\\nexport GOOGLE_OAUTH_CLIENT_SECRET=%q\\nexport GOOGLE_OAUTH_REDIRECT_URI=%q\\nexport CLERK_MAILBOX_SERVICE_AUDIENCE=%q\\nexport CLERK_MAILBOX_APP_API_SUBJECT=%q\\nexport CLERK_MAILBOX_WORKER_SUBJECT=%q\\nexport CLERK_MAILBOX_BROKER_SUBJECT=%q\\n" \
    "$MAILBOX_FEATURE_ENABLED" \
    "$CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY" "$CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY" "$CLERK_MAILBOX_BROKER_MACHINE_SECRET_KEY" \
    "$MAILBOX_VAULT_KEYS" "$MAILBOX_VAULT_ACTIVE_KEY_ID" \
    "$MAILBOX_BROKER_PUBLIC_BASE_URL" "$MAILBOX_ALLOWED_REDIRECT_ORIGINS" \
    "$GOOGLE_OAUTH_CLIENT_ID" "$GOOGLE_OAUTH_CLIENT_SECRET" "$GOOGLE_OAUTH_REDIRECT_URI" \
    "$CLERK_MAILBOX_SERVICE_AUDIENCE" "$CLERK_MAILBOX_APP_API_SUBJECT" \
    "$CLERK_MAILBOX_WORKER_SUBJECT" "$CLERK_MAILBOX_BROKER_SUBJECT" >> "$API_ENV_FILE"
'
chmod 600 "$API_ENV_FILE"

env -i PATH="$PATH" HOME="$HOME" \
  API_ENV_FILE="$API_ENV_FILE" \
  DATABASE_ENV_PATH="$DATABASE_ENV_PATH" \
  CURRENT_ENV_PATH="$CURRENT_ENV_PATH" \
  VERSIONS_FILE="$VERSIONS_FILE" \
  BUNDLE_MODULE="$BUNDLE_MODULE" \
  BUNDLE_FILE="$BUNDLE_FILE" \
  zsh -dfc '
  source "$API_ENV_FILE"
  export OPENAI_API_KEY OPENROUTER_API_KEY \
    CLERK_APP_MACHINE_SECRET_KEY CLERK_FOUNDRY_MACHINE_SECRET_KEY \
    CLERK_WEBHOOK_SIGNING_SECRET \
    AUTH_PROVIDER CLERK_ISSUER_URL CLERK_JWKS_URL \
    CLERK_TENANT_AUDIENCE CLERK_PLATFORM_AUDIENCE \
    CLERK_APP_SERVICE_AUDIENCE CLERK_FOUNDRY_SERVICE_AUDIENCE \
    CLERK_APP_SERVICE_SUBJECT CLERK_FOUNDRY_SERVICE_SUBJECT \
    MAILBOX_FEATURE_ENABLED \
    CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY CLERK_MAILBOX_BROKER_MACHINE_SECRET_KEY \
    MAILBOX_VAULT_KEYS MAILBOX_VAULT_ACTIVE_KEY_ID \
    MAILBOX_BROKER_PUBLIC_BASE_URL MAILBOX_ALLOWED_REDIRECT_ORIGINS \
    GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET GOOGLE_OAUTH_REDIRECT_URI \
    CLERK_MAILBOX_SERVICE_AUDIENCE CLERK_MAILBOX_APP_API_SUBJECT \
    CLERK_MAILBOX_WORKER_SUBJECT CLERK_MAILBOX_BROKER_SUBJECT
  node --input-type=module <<"NODE"
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
const { buildProductionBundle, activeVersionIds } = await import(process.env.BUNDLE_MODULE);

const currentEnv = process.env.CURRENT_ENV_PATH
  ? readFileSync(process.env.CURRENT_ENV_PATH, "utf8")
  : undefined;
const bundle = buildProductionBundle({
  shellEnv: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    CLERK_APP_MACHINE_SECRET_KEY: process.env.CLERK_APP_MACHINE_SECRET_KEY,
    CLERK_FOUNDRY_MACHINE_SECRET_KEY: process.env.CLERK_FOUNDRY_MACHINE_SECRET_KEY,
    CLERK_WEBHOOK_SIGNING_SECRET: process.env.CLERK_WEBHOOK_SIGNING_SECRET,
    AUTH_PROVIDER: process.env.AUTH_PROVIDER,
    CLERK_ISSUER_URL: process.env.CLERK_ISSUER_URL,
    CLERK_JWKS_URL: process.env.CLERK_JWKS_URL,
    CLERK_TENANT_AUDIENCE: process.env.CLERK_TENANT_AUDIENCE,
    CLERK_PLATFORM_AUDIENCE: process.env.CLERK_PLATFORM_AUDIENCE,
    CLERK_APP_SERVICE_AUDIENCE: process.env.CLERK_APP_SERVICE_AUDIENCE,
    CLERK_FOUNDRY_SERVICE_AUDIENCE: process.env.CLERK_FOUNDRY_SERVICE_AUDIENCE,
    CLERK_APP_SERVICE_SUBJECT: process.env.CLERK_APP_SERVICE_SUBJECT,
    CLERK_FOUNDRY_SERVICE_SUBJECT: process.env.CLERK_FOUNDRY_SERVICE_SUBJECT,
    MAILBOX_FEATURE_ENABLED: process.env.MAILBOX_FEATURE_ENABLED,
    CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY: process.env.CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY,
    CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY: process.env.CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY,
    CLERK_MAILBOX_BROKER_MACHINE_SECRET_KEY: process.env.CLERK_MAILBOX_BROKER_MACHINE_SECRET_KEY,
    MAILBOX_VAULT_KEYS: process.env.MAILBOX_VAULT_KEYS,
    MAILBOX_VAULT_ACTIVE_KEY_ID: process.env.MAILBOX_VAULT_ACTIVE_KEY_ID,
    MAILBOX_BROKER_PUBLIC_BASE_URL: process.env.MAILBOX_BROKER_PUBLIC_BASE_URL,
    MAILBOX_ALLOWED_REDIRECT_ORIGINS: process.env.MAILBOX_ALLOWED_REDIRECT_ORIGINS,
    GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI,
    CLERK_MAILBOX_SERVICE_AUDIENCE: process.env.CLERK_MAILBOX_SERVICE_AUDIENCE,
    CLERK_MAILBOX_APP_API_SUBJECT: process.env.CLERK_MAILBOX_APP_API_SUBJECT,
    CLERK_MAILBOX_WORKER_SUBJECT: process.env.CLERK_MAILBOX_WORKER_SUBJECT,
    CLERK_MAILBOX_BROKER_SUBJECT: process.env.CLERK_MAILBOX_BROKER_SUBJECT,
  },
  databaseEnv: readFileSync(process.env.DATABASE_ENV_PATH, "utf8"),
  currentEnv,
});
writeFileSync(process.env.BUNDLE_FILE, bundle, { mode: 0o600 });
chmodSync(process.env.BUNDLE_FILE, 0o600);
const versions = JSON.parse(readFileSync(process.env.VERSIONS_FILE, "utf8"));
console.log(JSON.stringify({ activeVersionIds: activeVersionIds(versions) }));
NODE
'

NEW_VERSION="$(gcloud secrets versions add "$SECRET_ID" --project="$PROJECT_ID" --data-file="$BUNDLE_FILE" --format='value(name)' | awk -F/ '{print $NF}')"
if [[ -z "$NEW_VERSION" ]]; then
  echo "Secret Manager did not return new version ID" >&2
  exit 1
fi

gcloud secrets versions access "$NEW_VERSION" --secret="$SECRET_ID" \
  --project="$PROJECT_ID" > "$VERIFY_FILE"
chmod 600 "$VERIFY_FILE"
EXPECTED_HASH="$(shasum -a 256 "$BUNDLE_FILE" | awk '{print $1}')"
ACTUAL_HASH="$(shasum -a 256 "$VERIFY_FILE" | awk '{print $1}')"
if [[ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]]; then
  echo "Secret Manager payload hash mismatch" >&2
  exit 1
fi
echo "uploaded version $NEW_VERSION; sha256 $ACTUAL_HASH"

gcloud secrets versions list "$SECRET_ID" --project="$PROJECT_ID" --format=json > "$VERSIONS_FILE"
OLD_VERSIONS="$(env -i PATH="$PATH" VERSIONS_FILE="$VERSIONS_FILE" BUNDLE_MODULE="$BUNDLE_MODULE" node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
const { activeVersionIds } = await import(process.env.BUNDLE_MODULE);
const versions = JSON.parse(readFileSync(process.env.VERSIONS_FILE, "utf8"));
for (const version of activeVersionIds(versions)) console.log(version);
NODE
)"
destroy_failures=()
while IFS= read -r version; do
  [[ -z "$version" || "$version" == "$NEW_VERSION" ]] && continue
  if ! gcloud secrets versions destroy "$version" --secret="$SECRET_ID" --project="$PROJECT_ID" --quiet; then
    destroy_failures+=("$version")
  fi
done <<< "$OLD_VERSIONS"

gcloud secrets versions list "$SECRET_ID" --project="$PROJECT_ID" --format=json > "$VERSIONS_FILE"
POSTCONDITION="$(env -i PATH="$PATH" VERSIONS_FILE="$VERSIONS_FILE" BUNDLE_MODULE="$BUNDLE_MODULE" node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
const { activeVersionIds } = await import(process.env.BUNDLE_MODULE);
const versions = JSON.parse(readFileSync(process.env.VERSIONS_FILE, "utf8"));
const ids = activeVersionIds(versions);
console.log(`${ids.length}:${ids[0] ?? ""}`);
NODE
)"

if (( ${#destroy_failures[@]} > 0 )); then
  printf 'failed to destroy old secret versions: %s\n' "${destroy_failures[*]}" >&2
fi
if [[ "$POSTCONDITION" != "1:$NEW_VERSION" ]]; then
  echo "postcondition failed: expected exactly one non-destroyed version equal to new version $NEW_VERSION; got $POSTCONDITION" >&2
  exit 1
fi
if (( ${#destroy_failures[@]} > 0 )); then
  exit 1
fi
echo "postcondition verified: exactly one non-destroyed version equals $NEW_VERSION"
