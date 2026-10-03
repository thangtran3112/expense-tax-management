/**
 * Phase 3D-A Task 3 — redaction configuration shared by this service's
 * eventual Fastify logger (Task 4's app.ts) and any ad-hoc structured
 * logging added by this task's own modules.
 *
 * Mirrors app-api/src/app.ts and foundry-service/src/app.ts's
 * `SENSITIVE_FIELD_NAMES`/`SENSITIVE_LOG_PATHS` exactly (same redaction
 * contract across every service), plus mailbox-specific fields that never
 * exist in those other services: OAuth authorization codes, PKCE
 * verifiers, session nonces, and raw token-vault ciphertext material.
 * Never log a token, key, or authorization header.
 */
export const SENSITIVE_FIELD_NAMES = [
  "authorization",
  "cookie",
  "cookies",
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "bearerToken",
  "apiKey",
  "clientSecret",
  "secret",
  "secrets",
  "key",
  "keys",
  "privateKey",
  "secretKey",
  "signingKey",
  "encryptionKey",
  "databaseUrl",
  "databaseURL",
  "database_url",
  "databaseUri",
  "databaseURI",
  "database_uri",
  "connectionString",
  "connection_string",
  "access_token",
  "refresh_token",
  "id_token",
  "bearer_token",
  "api_key",
  "client_secret",
  "private_key",
  "secret_key",
  "signing_key",
  "encryption_key",
  // Mailbox-broker-specific secrets: never present on any other service.
  "code",
  "pkceVerifier",
  "pkce_verifier",
  "sessionNonce",
  "session_nonce",
  "nonce",
  "ciphertext",
  "authTag",
  "auth_tag",
  "machineSecretKey",
  "machine_secret_key",
] as const;

export const SENSITIVE_LOG_PATHS = [
  ...SENSITIVE_FIELD_NAMES,
  ...SENSITIVE_FIELD_NAMES.map((fieldName) => "*." + fieldName),
  "headers.authorization",
  "headers.cookie",
  "headers.cookies",
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.cookies",
  "request.headers.authorization",
  "request.headers.cookie",
  "request.headers.cookies",
];

/**
 * True when `value` is a plain string that looks like a `Bearer <token>`
 * authorization header value -- used by redaction tests to assert no log
 * line ever contains a raw bearer token.
 */
export function containsBearerToken(value: string): boolean {
  return /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/.test(value);
}

/**
 * Recursively redacts every key in `SENSITIVE_FIELD_NAMES` (case-sensitive,
 * exact match) found anywhere in `value`, replacing its value with the
 * literal string "[Redacted]" -- the same sentinel Fastify/pino's own
 * `redact` option uses. Used by this task's own structured log calls
 * (`key-rotation-cli.ts`, `token-vault.ts`) which run outside any Fastify
 * request lifecycle and so cannot rely on Fastify's `redact` plugin.
 */
export function redact(value: unknown): unknown {
  const sensitive = new Set<string>(SENSITIVE_FIELD_NAMES);
  function walk(input: unknown): unknown {
    if (Array.isArray(input)) {
      return input.map(walk);
    }
    if (input !== null && typeof input === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, entryValue] of Object.entries(input)) {
        result[key] = sensitive.has(key) ? "[Redacted]" : walk(entryValue);
      }
      return result;
    }
    return input;
  }
  return walk(value);
}
