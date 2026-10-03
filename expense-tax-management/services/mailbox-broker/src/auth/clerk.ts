/**
 * Phase 3D-A Task 3 — broker's own inbound auth.
 *
 * Verifies tokens against this service's own audience
 * (`MAILBOX_SERVICE_TOKEN_AUDIENCE`/`MAILBOX_SERVICE_TOKEN_ISSUER`/
 * `MAILBOX_SERVICE_JWKS_URL`, unprefixed -- mirrors App API's own
 * `APP_SERVICE_TOKEN_*` verifier-config shape, not the `CLERK_`-prefixed
 * outbound-credential vars) and accepts exactly two configured subjects:
 * App API's own subject (scopes `oauth:start`/`connections:read`/
 * `connections:revoke`) and the workflow worker's subject (scopes
 * `mailbox:discover`/`mailbox:materialize`).
 *
 * No Fastify app exists in this task (Task 4 builds `app.ts`/routes);
 * this module exports a plain verify function Task 4's preHandler will
 * wrap, mirroring `foundry-service/src/auth/verifier.ts`'s
 * `createTokenVerifier` shape closely enough to reuse that same pattern
 * later without rework.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import type { InboundAuthConfig } from "../config.js";

const REQUIRED_CLAIMS = ["sub", "iat", "exp"] as const;
const CLOCK_TOLERANCE_SECONDS = 30;

export type InboundCaller = "app-api" | "worker";

export interface ServicePrincipal {
  readonly caller: InboundCaller;
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly tokenId: string;
}

export class ServiceAuthError extends Error {
  constructor(reason: string) {
    super(`Service authentication failed: ${reason}`);
    this.name = "ServiceAuthError";
  }
}

function parseScopes(value: unknown): readonly string[] {
  if (value === undefined || value === "") return [];
  if (typeof value !== "string") throw new ServiceAuthError("invalid scope claim");
  return value.split(/\s+/).filter(Boolean);
}

function requiredNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ServiceAuthError("invalid subject claim");
  }
  return value;
}

export interface CreateServiceVerifierOptions {
  readonly keyResolver?: JWTVerifyGetKey;
}

export function createServiceVerifier(
  config: InboundAuthConfig,
  options: CreateServiceVerifierOptions = {},
): { verify(token: string): Promise<ServicePrincipal> } {
  const keyResolver = options.keyResolver ?? createRemoteJWKSet(new URL(config.jwksUrl));

  return {
    async verify(token: string): Promise<ServicePrincipal> {
      let payload: Record<string, unknown>;
      try {
        const verified = await jwtVerify(token, keyResolver, {
          algorithms: ["RS256"],
          audience: config.audience,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          issuer: config.issuer,
          requiredClaims: [...REQUIRED_CLAIMS],
        });
        payload = verified.payload as Record<string, unknown>;
      } catch {
        throw new ServiceAuthError("token verification failed");
      }

      const subject = requiredNonEmptyString(payload.sub);
      const tokenId = requiredNonEmptyString(
        payload.jti === undefined ? payload.sid : payload.jti,
      );
      const scopes = parseScopes(payload.scope);

      const caller: InboundCaller =
        subject === config.appApiSubject
          ? "app-api"
          : subject === config.workerSubject
            ? "worker"
            : (() => {
                throw new ServiceAuthError("unexpected subject");
              })();

      return { caller, subject, scopes, tokenId };
    },
  };
}

/**
 * Enforces that a verified principal carries every scope in
 * `requiredScopes` -- callers (Task 4's route preHandlers) pass the
 * route-specific scope set (`oauth:start` for App API, `mailbox:discover`
 * / `mailbox:materialize` for the worker, etc.).
 */
export function requireScopes(
  principal: ServicePrincipal,
  requiredScopes: readonly string[],
): void {
  const scopes = new Set(principal.scopes);
  if (requiredScopes.some((scope) => !scopes.has(scope))) {
    throw new ServiceAuthError("missing required scope");
  }
}

export function requireCaller(principal: ServicePrincipal, expected: InboundCaller): void {
  if (principal.caller !== expected) {
    throw new ServiceAuthError("unexpected caller");
  }
}
