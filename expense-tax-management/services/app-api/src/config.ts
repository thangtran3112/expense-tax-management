export interface AppConfig {
  readonly service: "app-api";
  readonly version: string;
  readonly port: number;
  readonly authProvider: AuthProvider;
  readonly databaseUrl: string;
  readonly auth: AppAuthConfig;
  readonly clerk?: ClerkConfig;
  /**
   * Phase 3D-A Task 4 -- exact-match allowlist of trusted Office origins
   * for the mailbox OAuth redirect flow. Comma-separated
   * `MAILBOX_ALLOWED_REDIRECT_ORIGINS`; undefined (not an empty array)
   * when unset, so existing `config.test.ts` exact-shape fixtures that
   * predate mailbox stay untouched (same reasoning as Task 2's optional
   * mailbox Clerk fields, Ruling 1).
   */
  readonly mailboxAllowedRedirectOrigins?: readonly string[] | undefined;
  /**
   * Fix round 1 (Important) -- explicit feature flag, `MAILBOX_FEATURE_ENABLED`
   * (exactly "true", case-insensitive; anything else, including unset, is
   * disabled). Default false: a deployment that never set the mailbox env
   * vars at all stays fully, deliberately disabled. When true, every
   * required outbound-broker field below is validated eagerly in this
   * function (fail startup with a clear, non-secret error naming only the
   * missing variable names) -- misconfiguration can never silently serve a
   * half-working feature.
   */
  readonly mailboxEnabled: boolean;
  readonly temporal: TemporalConnectionConfig;
  readonly storage: StorageConnectionConfig;
  readonly inboundEmail: InboundEmailConfig;
  /**
   * Web session wiring design (2026-10-06) -- exact-match allowlist of
   * trusted browser origins, comma-separated `APP_CORS_ALLOWED_ORIGINS`.
   * Undefined (not an empty array) when unset, same convention as
   * mailboxAllowedRedirectOrigins; `registerCors` treats both the same
   * (CORS disabled).
   */
  readonly corsAllowedOrigins?: readonly string[] | undefined;
}

export type AuthProvider = "clerk" | "legacy";

export interface ClerkConfig {
  readonly issuerUrl: string;
  readonly jwksUrl: string;
  readonly tenantAudience: string;
  readonly platformAudience: string;
  readonly appServiceAudience: string;
  readonly foundryServiceAudience: string;
  readonly appServiceSubject: string;
  readonly foundryServiceSubject: string;
  /** Scope required on the enrichment-input route. Default: "jobs:enrichment-input" */
  readonly enrichmentInputScope: string;
  /** Scope required on the enrichment-result route. Default: "jobs:enrichment-result" */
  readonly enrichmentResultScope: string;
  readonly publishableKey?: string | undefined;
  readonly secretKey?: string | undefined;
  readonly webhookSigningSecret?: string | undefined;
  /**
   * Phase 3D-A: App API's own outbound M2M credential to call the mailbox
   * broker (subject "app-api-mailbox"). Optional -- absent until an
   * operator provisions the broker's env vars -- so existing deployments
   * and fixtures that predate the mailbox broker keep working unchanged.
   */
  readonly mailboxBrokerBaseUrl?: string | undefined;
  /**
   * Fix round 1 (Critical) -- the broker's PUBLIC base URL (e.g.
   * `https://expense-mailbox.tobytran.dev`), distinct from
   * `mailboxBrokerBaseUrl` (the Compose-internal URL App API uses for its
   * own M2M calls). The customer-facing start route wraps the broker's
   * Google authorization URL in a link to this origin's
   * `/oauth/google/begin` -- the one place the browser touches the broker
   * before Google, so the broker can set its own `HttpOnly` session-nonce
   * cookie (Office JavaScript cannot: a cookie it sets is host-only on the
   * Office origin and never reaches the broker's callback origin).
   */
  readonly mailboxBrokerPublicBaseUrl?: string | undefined;
  readonly mailboxServiceAudience?: string | undefined;
  readonly mailboxAppApiMachineSecretKey?: string | undefined;
  readonly mailboxAppApiSubject?: string | undefined;
  /**
   * Expected-subject config for the two inbound mailbox route families.
   * Optional with a literal fallback at the call site (same pattern as
   * `options.workerServiceSubject ?? "ai-worker"` elsewhere in this
   * service), not required here.
   */
  readonly mailboxBrokerServiceSubject?: string | undefined;
  readonly mailboxWorkerServiceSubject?: string | undefined;
}

/** Shared outbound M2M credential shape (ported from workflow-worker's config). */
export interface MachineCredentialConfig {
  readonly audience: string;
  readonly machineSecretKey: string;
  readonly subject: string;
}

export interface InboundEmailConfig {
  readonly baseAddress: string;
  readonly webhookSigningKey: string;
  readonly routingTokenSecret: string;
  readonly challengeDir: string;
}

export interface TemporalConnectionConfig {
  readonly address: string;
  readonly namespace: string;
}

export interface StorageConnectionConfig {
  readonly backend: string;
  readonly localDir: string;
  readonly baseUrl: string;
  readonly urlSigningKey: string;
  /**
   * Web session wiring design (2026-10-06) -- optional origin for internal
   * (worker-issued) read URLs, `STORAGE_INTERNAL_BASE_URL` (e.g.
   * `http://app-api:8100` in production). Undefined when unset: internal
   * read URLs then fall back to `baseUrl`, today's behavior.
   */
  readonly internalBaseUrl?: string | undefined;
}

export interface TokenAuthorityConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
}

export interface AppAuthConfig {
  readonly tenant: TokenAuthorityConfig;
  readonly service: TokenAuthorityConfig;
}

export interface AppConfigOptions {
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

function jwksUrl(
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

function urlEnvironmentValue(
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

function optionalEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

function optionalCommaListEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): readonly string[] | undefined {
  const raw = optionalEnvironmentValue(env, key);
  if (raw === undefined) return undefined;
  const items = raw.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * Optional HTTP(S) base URL. Used for the mailbox broker's Compose-internal
 * origin (`http://mailbox-broker:8300`), unlike `urlEnvironmentValue`'s
 * HTTPS-only Clerk URLs -- Docker's internal DNS has no TLS.
 */
function optionalBaseUrlEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  const value = optionalEnvironmentValue(env, key);
  if (value === undefined) return undefined;
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

/**
 * Fix round 1 (Important) -- fails startup with a clear, non-secret error
 * (variable names only, never values) when the mailbox feature is
 * explicitly enabled but any required outbound-broker field is missing.
 * Never throws when the feature is disabled (default), so every existing
 * fixture/deployment that predates mailbox -- and never sets
 * MAILBOX_FEATURE_ENABLED -- is completely unaffected.
 */
function validateMailboxConfiguration(
  mailboxEnabled: boolean,
  clerk: ClerkConfig | undefined,
  mailboxAllowedRedirectOrigins: readonly string[] | undefined,
): void {
  if (!mailboxEnabled) return;
  if (!clerk) {
    throw new Error(
      "Mailbox feature is enabled (MAILBOX_FEATURE_ENABLED=true) but AUTH_PROVIDER is not \"clerk\"",
    );
  }
  const missing: string[] = [];
  if (!clerk.mailboxBrokerBaseUrl) missing.push("MAILBOX_BROKER_BASE_URL");
  if (!clerk.mailboxBrokerPublicBaseUrl) missing.push("MAILBOX_BROKER_PUBLIC_BASE_URL");
  if (!clerk.mailboxServiceAudience) missing.push("CLERK_MAILBOX_SERVICE_AUDIENCE");
  if (!clerk.mailboxAppApiMachineSecretKey) missing.push("CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY");
  if (!clerk.mailboxAppApiSubject) missing.push("CLERK_MAILBOX_APP_API_SUBJECT");
  if (!mailboxAllowedRedirectOrigins || mailboxAllowedRedirectOrigins.length === 0) {
    missing.push("MAILBOX_ALLOWED_REDIRECT_ORIGINS");
  }
  if (missing.length > 0) {
    throw new Error(
      `Mailbox feature is enabled (MAILBOX_FEATURE_ENABLED=true) but missing required configuration: ${missing.join(", ")}`,
    );
  }
}

export function createAppConfig(options: AppConfigOptions = {}): AppConfig {
  const port = options.port ?? 8100;
  const env = options.env ?? process.env;
  // Existing focused auth fixtures intentionally provide only auth variables.
  const databaseEnv =
    options.env?.APP_DATABASE_URL === undefined &&
    options.env?.APP_MIGRATION_DATABASE_URL === undefined
      ? process.env
      : env;
  const temporalEnv =
    options.env?.TEMPORAL_HOST === undefined &&
    options.env?.TEMPORAL_NAMESPACE === undefined
      ? process.env
      : env;
  const storageEnv =
    options.env?.STORAGE_BACKEND === undefined &&
    options.env?.LOCAL_STORAGE_DIR === undefined &&
    options.env?.STORAGE_URL_SIGNING_KEY === undefined &&
    options.env?.STORAGE_LOCAL_BASE_URL === undefined &&
    options.env?.STORAGE_INTERNAL_BASE_URL === undefined
      ? process.env
      : env;
  const inboundEnv =
    options.env?.INBOUND_EMAIL_BASE_ADDRESS === undefined &&
    options.env?.INBOUND_WEBHOOK_SIGNING_KEY === undefined &&
    options.env?.INBOUND_ROUTING_TOKEN_SECRET === undefined &&
    options.env?.INBOUND_CHALLENGE_DIR === undefined
      ? process.env
      : env;

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid application port");
  }

  const databaseUrl = requiredEnvironmentValue(databaseEnv, "APP_DATABASE_URL");
  const authProvider = env.AUTH_PROVIDER?.trim() || "clerk";
  if (authProvider !== "clerk" && authProvider !== "legacy") {
    throw new Error("Invalid AUTH_PROVIDER: expected clerk or legacy");
  }

  const clerk =
    authProvider === "clerk"
      ? {
          issuerUrl: urlEnvironmentValue(env, "CLERK_ISSUER_URL"),
          jwksUrl: urlEnvironmentValue(env, "CLERK_JWKS_URL"),
          tenantAudience: requiredEnvironmentValue(
            env,
            "CLERK_TENANT_AUDIENCE",
          ),
          platformAudience: requiredEnvironmentValue(
            env,
            "CLERK_PLATFORM_AUDIENCE",
          ),
          appServiceAudience: requiredEnvironmentValue(
            env,
            "CLERK_APP_SERVICE_AUDIENCE",
          ),
          foundryServiceAudience: requiredEnvironmentValue(
            env,
            "CLERK_FOUNDRY_SERVICE_AUDIENCE",
          ),
          appServiceSubject: requiredEnvironmentValue(
            env,
            "CLERK_APP_SERVICE_SUBJECT",
          ),
          foundryServiceSubject: requiredEnvironmentValue(
            env,
            "CLERK_FOUNDRY_SERVICE_SUBJECT",
          ),
          enrichmentInputScope:
            env.CLERK_APP_ENRICHMENT_INPUT_SCOPE?.trim() ||
            "jobs:enrichment-input",
          enrichmentResultScope:
            env.CLERK_APP_ENRICHMENT_RESULT_SCOPE?.trim() ||
            "jobs:enrichment-result",
          publishableKey: optionalEnvironmentValue(
            env,
            "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
          ),
          secretKey: optionalEnvironmentValue(env, "CLERK_SECRET_KEY"),
          webhookSigningSecret: optionalEnvironmentValue(
            env,
            "CLERK_WEBHOOK_SIGNING_SECRET",
          ),
          mailboxBrokerBaseUrl: optionalBaseUrlEnvironmentValue(
            env,
            "MAILBOX_BROKER_BASE_URL",
          ),
          mailboxBrokerPublicBaseUrl: optionalBaseUrlEnvironmentValue(
            env,
            "MAILBOX_BROKER_PUBLIC_BASE_URL",
          ),
          mailboxServiceAudience: optionalEnvironmentValue(
            env,
            "CLERK_MAILBOX_SERVICE_AUDIENCE",
          ),
          mailboxAppApiMachineSecretKey: optionalEnvironmentValue(
            env,
            "CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY",
          ),
          mailboxAppApiSubject: optionalEnvironmentValue(
            env,
            "CLERK_MAILBOX_APP_API_SUBJECT",
          ),
          mailboxBrokerServiceSubject: optionalEnvironmentValue(
            env,
            "CLERK_MAILBOX_BROKER_SUBJECT",
          ),
          mailboxWorkerServiceSubject: optionalEnvironmentValue(
            env,
            "CLERK_MAILBOX_WORKER_SUBJECT",
          ),
        }
      : undefined;

  const config = {
    service: "app-api",
    version: options.version ?? "0.1.0",
    port,
    authProvider,
    databaseUrl,
    auth: {
      tenant: {
        issuer: requiredEnvironmentValue(env, "APP_TENANT_TOKEN_ISSUER"),
        audience: requiredEnvironmentValue(env, "APP_TENANT_TOKEN_AUDIENCE"),
        jwksUrl: jwksUrl(env, "APP_TENANT_JWKS_URL"),
      },
      service: {
        issuer: requiredEnvironmentValue(env, "APP_SERVICE_TOKEN_ISSUER"),
        audience: requiredEnvironmentValue(env, "APP_SERVICE_TOKEN_AUDIENCE"),
        jwksUrl: jwksUrl(env, "APP_SERVICE_JWKS_URL"),
      },
    },
    clerk,
    mailboxAllowedRedirectOrigins: optionalCommaListEnvironmentValue(
      env,
      "MAILBOX_ALLOWED_REDIRECT_ORIGINS",
    ),
    corsAllowedOrigins: optionalCommaListEnvironmentValue(
      env,
      "APP_CORS_ALLOWED_ORIGINS",
    ),
    mailboxEnabled: env.MAILBOX_FEATURE_ENABLED?.trim().toLowerCase() === "true",
    temporal: {
      address: requiredEnvironmentValue(temporalEnv, "TEMPORAL_HOST"),
      namespace: requiredEnvironmentValue(temporalEnv, "TEMPORAL_NAMESPACE"),
    },
    storage: {
      backend: requiredEnvironmentValue(storageEnv, "STORAGE_BACKEND"),
      localDir: requiredEnvironmentValue(storageEnv, "LOCAL_STORAGE_DIR"),
      baseUrl: requiredEnvironmentValue(storageEnv, "STORAGE_LOCAL_BASE_URL"),
      urlSigningKey: requiredEnvironmentValue(
        storageEnv,
        "STORAGE_URL_SIGNING_KEY",
      ),
      internalBaseUrl: optionalBaseUrlEnvironmentValue(
        storageEnv,
        "STORAGE_INTERNAL_BASE_URL",
      ),
    },
    inboundEmail: {
      baseAddress: requiredEnvironmentValue(
        inboundEnv,
        "INBOUND_EMAIL_BASE_ADDRESS",
      ),
      webhookSigningKey: requiredEnvironmentValue(
        inboundEnv,
        "INBOUND_WEBHOOK_SIGNING_KEY",
      ),
      routingTokenSecret: requiredEnvironmentValue(
        inboundEnv,
        "INBOUND_ROUTING_TOKEN_SECRET",
      ),
      challengeDir: requiredEnvironmentValue(
        inboundEnv,
        "INBOUND_CHALLENGE_DIR",
      ),
    },
  } as AppConfig;

  validateMailboxConfiguration(
    config.mailboxEnabled,
    config.clerk,
    config.mailboxAllowedRedirectOrigins,
  );

  if (config.clerk !== undefined) {
    Object.defineProperty(config, "clerk", {
      enumerable: false,
      value: config.clerk,
    });
  }

  return config;
}
