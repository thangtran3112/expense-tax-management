import { randomBytes as nodeRandomBytes } from "node:crypto";

const REQUIRED_SHELL_KEYS = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "CLERK_APP_MACHINE_SECRET_KEY",
  "CLERK_FOUNDRY_MACHINE_SECRET_KEY",
  "CLERK_WEBHOOK_SIGNING_SECRET",
];
const REQUIRED_DATABASE_KEYS = [
  "APP_DATABASE_URL",
  "APP_MIGRATION_DATABASE_URL",
  "FOUNDRY_DATABASE_URL",
  "FOUNDRY_MIGRATION_DATABASE_URL",
];
const GENERATED_KEYS = [
  "STORAGE_URL_SIGNING_KEY",
  "INBOUND_WEBHOOK_SIGNING_KEY",
  "INBOUND_ROUTING_TOKEN_SECRET",
];
const CLERK_RUNTIME_KEYS = [
  "AUTH_PROVIDER",
  "CLERK_ISSUER_URL",
  "CLERK_JWKS_URL",
  "CLERK_TENANT_AUDIENCE",
  "CLERK_PLATFORM_AUDIENCE",
  "CLERK_APP_SERVICE_AUDIENCE",
  "CLERK_FOUNDRY_SERVICE_AUDIENCE",
  "CLERK_APP_SERVICE_SUBJECT",
  "CLERK_FOUNDRY_SERVICE_SUBJECT",
];

/**
 * Phase 3D-A Task 5 (controller ruling): mailbox production wiring is
 * opt-in. These four categories below are only ever consulted -- and
 * only ever land in the bundle -- when the operator's shell sets
 * MAILBOX_FEATURE_ENABLED=true; an ordinary dev->main release's shell
 * never sets it, so the bundle carries MAILBOX_FEATURE_ENABLED=false and
 * none of these keys at all (see buildProductionBundle below).
 *
 * Category treatment mirrors the brief's own design for each key once
 * enabled:
 * - MAILBOX_REQUIRED_SHELL_KEYS: operator-supplied secrets/config with no
 *   safe inert default (an encryption key, a machine secret, the real
 *   public broker hostname, the real allowed redirect origins) -- hard
 *   failure if missing while enabled.
 * - MAILBOX_REQUIRED_DATABASE_KEYS: same rewriteDatabaseUrl treatment as
 *   the four existing App/Foundry URLs. Named MAILBOX_BROKER_* (matching
 *   services/mailbox-broker/src/config.ts's and database/migrate.ts's
 *   actual required env var names), not the brief's stale
 *   MAILBOX_VAULT_DATABASE_URL* -- see task-5-report.md ruling.
 * - MAILBOX_CLERK_RUNTIME_KEYS: optional, shell-overridable, otherwise
 *   fail-closed (same as CLERK_RUNTIME_KEYS above).
 * - MAILBOX_FAIL_CLOSED_ONLY_KEYS: the broker's own inbound-verifier
 *   config (MAILBOX_SERVICE_TOKEN_*) -- fail-closed-only, never
 *   shell-overridable through this script, matching
 *   APP_SERVICE_TOKEN_*'s existing precedent exactly.
 */
const MAILBOX_REQUIRED_SHELL_KEYS = [
  "CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY",
  "CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY",
  "CLERK_MAILBOX_BROKER_MACHINE_SECRET_KEY",
  "MAILBOX_VAULT_KEYS",
  "MAILBOX_VAULT_ACTIVE_KEY_ID",
  "MAILBOX_BROKER_PUBLIC_BASE_URL",
  "MAILBOX_ALLOWED_REDIRECT_ORIGINS",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REDIRECT_URI",
];
const MAILBOX_REQUIRED_DATABASE_KEYS = [
  "MAILBOX_BROKER_DATABASE_URL",
  "MAILBOX_BROKER_MIGRATION_DATABASE_URL",
];
const MAILBOX_CLERK_RUNTIME_KEYS = [
  "CLERK_MAILBOX_SERVICE_AUDIENCE",
  "CLERK_MAILBOX_APP_API_SUBJECT",
  "CLERK_MAILBOX_WORKER_SUBJECT",
  "CLERK_MAILBOX_BROKER_SUBJECT",
];
const MAILBOX_FAIL_CLOSED_RUNTIME_VALUES = {
  CLERK_MAILBOX_SERVICE_AUDIENCE: "mch_3J9hMailboxSvcAud01",
  CLERK_MAILBOX_APP_API_SUBJECT: "app-api-mailbox-not-configured",
  CLERK_MAILBOX_WORKER_SUBJECT: "workflow-worker-mailbox-not-configured",
  CLERK_MAILBOX_BROKER_SUBJECT: "mailbox-broker-app-not-configured",
  MAILBOX_SERVICE_TOKEN_ISSUER: "https://services.not-configured.invalid",
  MAILBOX_SERVICE_TOKEN_AUDIENCE: "phase-1b-inert-service",
  MAILBOX_SERVICE_JWKS_URL: "https://services.not-configured.invalid/.well-known/jwks.json",
};

const FAIL_CLOSED_RUNTIME_VALUES = {
  AUTH_PROVIDER: "clerk",
  APP_TENANT_TOKEN_ISSUER: "https://identity.not-configured.invalid",
  APP_TENANT_TOKEN_AUDIENCE: "phase-1b-inert-tenant",
  APP_TENANT_JWKS_URL: "https://identity.not-configured.invalid/.well-known/jwks.json",
  APP_SERVICE_TOKEN_ISSUER: "https://services.not-configured.invalid",
  APP_SERVICE_TOKEN_AUDIENCE: "phase-1b-inert-service",
  APP_SERVICE_JWKS_URL: "https://services.not-configured.invalid/.well-known/jwks.json",
  FOUNDRY_PLATFORM_TOKEN_ISSUER: "https://identity.not-configured.invalid",
  FOUNDRY_PLATFORM_TOKEN_AUDIENCE: "phase-1b-inert-platform",
  FOUNDRY_PLATFORM_JWKS_URL: "https://identity.not-configured.invalid/.well-known/jwks.json",
  FOUNDRY_SERVICE_TOKEN_ISSUER: "https://services.not-configured.invalid",
  FOUNDRY_SERVICE_TOKEN_AUDIENCE: "phase-1b-inert-service",
  FOUNDRY_SERVICE_JWKS_URL: "https://services.not-configured.invalid/.well-known/jwks.json",
  CLERK_ISSUER_URL: "https://identity.not-configured.invalid",
  CLERK_JWKS_URL: "https://identity.not-configured.invalid/.well-known/jwks.json",
  CLERK_TENANT_AUDIENCE: "phase-1b-inert-tenant",
  CLERK_PLATFORM_AUDIENCE: "phase-1b-inert-platform",
  CLERK_APP_SERVICE_AUDIENCE: "mch_3J9fsniGga4hUqUf65ZQqzeGX2b",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: "mch_3J9g3CNoKL9q6KfbRy5zq1Rh2zT",
  CLERK_APP_SERVICE_SUBJECT: "mch_3J9Xg9Hu84Rn2oeqj7EMrv0ax19",
  CLERK_FOUNDRY_SERVICE_SUBJECT: "mch_3J9gHBtDcxOE3fWE39Ay9uF7hFv",
  STORAGE_BACKEND: "local",
  STORAGE_LOCAL_BASE_URL: "http://127.0.0.1:8100",
  INBOUND_EMAIL_BASE_ADDRESS: "receipts@inbound.expense-tax.local",
};

function parseEnv(input) {
  if (input === undefined || input === null) return {};
  if (typeof input === "object") return { ...input };
  if (typeof input !== "string") {
    throw new TypeError("environment input must be a map or dotenv string");
  }

  const result = {};
  for (const line of input.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) throw new Error("invalid dotenv entry");
    let value = match[2];
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

function requireValues(values, keys) {
  const missing = keys.filter(
    (key) => typeof values[key] !== "string" || values[key].length === 0,
  );
  if (missing.length > 0) {
    throw new Error(`missing required environment keys: ${missing.join(", ")}`);
  }
}

function assertSafeValue(key, value) {
  if (typeof value !== "string") {
    throw new Error(`invalid value for ${key}`);
  }
  if (/[\r\n\u0000]/u.test(value)) {
    throw new Error(`unsafe value for ${key}`);
  }
}

function rewriteDatabaseUrl(key, value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`invalid database URL for ${key}`);
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error(`invalid database URL for ${key}`);
  }
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "15432") return value;

  const match = value.match(/^([A-Za-z][A-Za-z\d+.-]*:\/\/)([^/?#]*)([/?#].*)?$/u);
  if (!match) throw new Error(`invalid database URL for ${key}`);
  return `${match[1]}${match[2].replace(/127\.0\.0\.1:15432$/u, "postgres:5432")}${match[3] ?? ""}`;
}

function generateSecret(randomBytes) {
  const bytes = randomBytes(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
    throw new Error("randomBytes must return 32 bytes");
  }
  return bytes.toString("hex");
}

function assertGeneratedSecret(key, value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`invalid generated secret for ${key}`);
  }
}

export function buildProductionBundle({
  shellEnv,
  databaseEnv,
  currentEnv,
  randomBytes = nodeRandomBytes,
}) {
  const shell = parseEnv(shellEnv);
  const database = parseEnv(databaseEnv);
  const current = parseEnv(currentEnv);

  requireValues(shell, REQUIRED_SHELL_KEYS);
  requireValues(database, REQUIRED_DATABASE_KEYS);

  const values = {};
  for (const key of REQUIRED_DATABASE_KEYS) {
    values[key] = rewriteDatabaseUrl(key, database[key]);
  }
  for (const key of REQUIRED_SHELL_KEYS) values[key] = shell[key];
  Object.assign(
    values,
    FAIL_CLOSED_RUNTIME_VALUES,
    Object.fromEntries(
      CLERK_RUNTIME_KEYS
        .filter((key) => shell[key] !== undefined)
        .map((key) => [key, shell[key]]),
    ),
  );
  for (const key of GENERATED_KEYS) {
    values[key] = current[key] === undefined ? generateSecret(randomBytes) : current[key];
    assertGeneratedSecret(key, values[key]);
  }

  const mailboxEnabled = shell.MAILBOX_FEATURE_ENABLED?.trim().toLowerCase() === "true";
  values.MAILBOX_FEATURE_ENABLED = mailboxEnabled ? "true" : "false";
  if (mailboxEnabled) {
    requireValues(shell, MAILBOX_REQUIRED_SHELL_KEYS);
    requireValues(database, MAILBOX_REQUIRED_DATABASE_KEYS);
    for (const key of MAILBOX_REQUIRED_DATABASE_KEYS) {
      values[key] = rewriteDatabaseUrl(key, database[key]);
    }
    for (const key of MAILBOX_REQUIRED_SHELL_KEYS) values[key] = shell[key];
    Object.assign(
      values,
      MAILBOX_FAIL_CLOSED_RUNTIME_VALUES,
      Object.fromEntries(
        MAILBOX_CLERK_RUNTIME_KEYS
          .filter((key) => shell[key] !== undefined)
          .map((key) => [key, shell[key]]),
      ),
    );
  }

  for (const [key, value] of Object.entries(values)) assertSafeValue(key, value);
  return `${Object.keys(values)
    .sort()
    .map((key) => `${key}=${values[key]}`)
    .join("\n")}\n`;
}

export function activeVersionIds(versions) {
  return versions
    .filter((version) => {
      const state = String(version.state || "").toUpperCase();
      return state === "ENABLED" || state === "DISABLED";
    })
    .map((version) => version.name ?? version.id)
    .filter((name) => name !== undefined && name !== null)
    .map((name) => String(name).split("/").pop());
}
