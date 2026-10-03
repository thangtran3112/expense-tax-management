/**
 * Phase 3D-A Task 4 — route-guard plumbing built on top of Task 3's
 * `auth/clerk.ts` (`createServiceVerifier`/`requireCaller`/`requireScopes`).
 * Not in the brief's literal file list, but structurally required the same
 * way Task 3's own `database/{client,migrate,types}.ts` were (Task 3
 * Ruling 1): app.ts needs a Fastify preHandler, and app-api/foundry-service
 * both keep this exact plumbing in their own `plugins/auth.ts`.
 *
 * Zero changes to Task 3's `auth/clerk.ts` -- this module only wraps it.
 */
import type { FastifyRequest } from "fastify";

import {
  createServiceVerifier,
  requireCaller,
  requireScopes,
  ServiceAuthError,
  type CreateServiceVerifierOptions,
  type InboundCaller,
  type ServicePrincipal,
} from "../auth/clerk.js";
import type { InboundAuthConfig } from "../config.js";

export type ServiceGuard = (request: FastifyRequest) => Promise<void>;

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") {
    throw new ServiceAuthError("missing authorization header");
  }
  const match = /^Bearer ([^\s,]+)$/i.exec(authorization);
  if (!match?.[1]) {
    throw new ServiceAuthError("malformed authorization header");
  }
  return match[1];
}

/**
 * Builds a `serviceGuard(caller, requiredScopes)` factory bound to one
 * verifier instance (so the remote JWKS is fetched/cached once per app,
 * not once per route).
 */
export function createServiceGuardFactory(
  config: InboundAuthConfig,
  options: CreateServiceVerifierOptions = {},
): (caller: InboundCaller, requiredScopes: readonly string[]) => ServiceGuard {
  const verifier = createServiceVerifier(config, options);

  return (caller, requiredScopes) => async (request) => {
    const principal: ServicePrincipal = await verifier.verify(bearerToken(request));
    requireCaller(principal, caller);
    requireScopes(principal, requiredScopes);
    (request as FastifyRequest & { servicePrincipal?: ServicePrincipal }).servicePrincipal = principal;
  };
}
