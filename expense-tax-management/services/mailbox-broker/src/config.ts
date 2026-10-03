/**
 * Phase 3D-A Task 3 — Mailbox broker configuration.
 *
 * Mirrors the manual-parsing style of app-api/src/config.ts and
 * foundry-service/src/config.ts (not workflow-worker's zod-schema style):
 * this service is a Fastify-shaped service like those two, not a
 * zod-first worker.
 *
 * Two distinct identity relationships, per the brief's "Credential
 * naming note":
 * - Inbound: the broker verifies tokens presented by App API and the
 *   workflow worker (two configured subjects, env `MAILBOX_SERVICE_TOKEN_*`
 *   mirroring App API's own `APP_SERVICE_TOKEN_*` verifier-config shape).
 * - Outbound: the broker calls back into App API's mailbox routes with
 *   its own Clerk M2M credential (subject "mailbox-broker-app", audience
 *   the existing `CLERK_APP_SERVICE_AUDIENCE`, reused).
 */

/** Shared outbound M2M credential shape (same as workflow-worker/app-api's). */
export interface MachineCredentialConfig {
  readonly audience: string;
  readonly machineSecretKey: string;
  readonly subject: string;
}

export interface InboundAuthConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  /** Expected subject for App API's own inbound calls (scopes oauth:start/connections:read/connections:revoke). */
  readonly appApiSubject: string;
  /** Expected subject for the workflow worker's inbound calls (scopes mailbox:discover/mailbox:materialize). */
  readonly workerSubject: string;
}

export interface VaultKeyConfig {
  /** key_id -> raw 32-byte AES-256 key material. */
  readonly keys: ReadonlyMap<string, Buffer>;
  readonly activeKeyId: string;
}

export interface BrokerConfig {
  readonly service: "mailbox-broker";
  readonly version: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly inboundAuth: InboundAuthConfig;
  readonly outboundApp: {
    readonly issuerUrl: string;
    readonly jwksUrl: string;
    readonly baseUrl: string;
    readonly credentials: MachineCredentialConfig;
  };
  readonly vault: VaultKeyConfig;
}

export interface BrokerConfigOptions {
  readonly version?: string;
  readonly port?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function requiredEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function httpsUrlEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = requiredEnvironmentValue(env, key);
  try {
    if (new URL(value).protocol !== "https:") {
      throw new Error("non-HTTPS URL");
    }
  } catch {
    throw new Error(`Invalid URL in environment variable: ${key}`);
  }
  return value;
}

/**
 * Compose-internal base URL for App API. Unlike the Clerk URLs above,
 * this may legitimately be `http://app-api:8100` (Docker internal DNS,
 * no TLS) -- same reasoning as app-api's own
 * `optionalBaseUrlEnvironmentValue` for `MAILBOX_BROKER_BASE_URL`.
 */
function baseUrlEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = requiredEnvironmentValue(env, key);
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error(`Invalid URL in environment variable: ${key}`);
  }
  return value;
}

interface RawVaultKeyEntry {
  readonly keyId?: unknown;
  readonly key?: unknown;
}

function parseVaultKeys(
  env: Readonly<Record<string, string | undefined>>,
): VaultKeyConfig {
  const raw = requiredEnvironmentValue(env, "MAILBOX_VAULT_KEYS");
  const activeKeyId = requiredEnvironmentValue(env, "MAILBOX_VAULT_ACTIVE_KEY_ID");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON in environment variable: MAILBOX_VAULT_KEYS");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("MAILBOX_VAULT_KEYS must be a non-empty JSON array");
  }

  const keys = new Map<string, Buffer>();
  for (const entry of parsed as readonly RawVaultKeyEntry[]) {
    const keyId = entry?.keyId;
    const key = entry?.key;
    if (typeof keyId !== "string" || !keyId.trim()) {
      throw new Error("MAILBOX_VAULT_KEYS entry is missing a valid keyId");
    }
    if (typeof key !== "string" || !key.trim()) {
      throw new Error("MAILBOX_VAULT_KEYS entry is missing a valid key");
    }
    let material: Buffer;
    try {
      material = Buffer.from(key, "base64");
    } catch {
      throw new Error(`MAILBOX_VAULT_KEYS entry "${keyId}" has invalid base64 key material`);
    }
    if (material.length !== 32) {
      throw new Error(
        `MAILBOX_VAULT_KEYS entry "${keyId}" must decode to exactly 32 bytes (AES-256)`,
      );
    }
    if (keys.has(keyId)) {
      throw new Error(`MAILBOX_VAULT_KEYS contains duplicate keyId "${keyId}"`);
    }
    keys.set(keyId, material);
  }

  if (!keys.has(activeKeyId)) {
    throw new Error(
      `MAILBOX_VAULT_ACTIVE_KEY_ID "${activeKeyId}" is not present in MAILBOX_VAULT_KEYS`,
    );
  }

  return { keys, activeKeyId };
}

export function brokerConfigFromEnv(
  options: BrokerConfigOptions = {},
): BrokerConfig {
  const port = options.port ?? 8300;
  const env = options.env ?? process.env;

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid application port");
  }

  const databaseUrl = requiredEnvironmentValue(env, "MAILBOX_BROKER_DATABASE_URL");

  return {
    service: "mailbox-broker",
    version: options.version ?? "0.1.0",
    port,
    databaseUrl,
    inboundAuth: {
      issuer: httpsUrlEnvironmentValue(env, "MAILBOX_SERVICE_TOKEN_ISSUER"),
      audience: requiredEnvironmentValue(env, "MAILBOX_SERVICE_TOKEN_AUDIENCE"),
      jwksUrl: httpsUrlEnvironmentValue(env, "MAILBOX_SERVICE_JWKS_URL"),
      appApiSubject: requiredEnvironmentValue(env, "CLERK_MAILBOX_APP_API_SUBJECT"),
      workerSubject: requiredEnvironmentValue(env, "CLERK_MAILBOX_WORKER_SUBJECT"),
    },
    outboundApp: {
      issuerUrl: httpsUrlEnvironmentValue(env, "CLERK_ISSUER_URL"),
      jwksUrl: httpsUrlEnvironmentValue(env, "CLERK_JWKS_URL"),
      baseUrl: baseUrlEnvironmentValue(env, "APP_API_BASE_URL"),
      credentials: {
        audience: requiredEnvironmentValue(env, "CLERK_APP_SERVICE_AUDIENCE"),
        machineSecretKey: requiredEnvironmentValue(
          env,
          "CLERK_MAILBOX_BROKER_MACHINE_SECRET_KEY",
        ),
        subject: requiredEnvironmentValue(env, "CLERK_MAILBOX_BROKER_SUBJECT"),
      },
    },
    vault: parseVaultKeys(env),
  };
}
