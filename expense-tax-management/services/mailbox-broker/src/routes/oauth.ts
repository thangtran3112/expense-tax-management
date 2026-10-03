/**
 * Phase 3D-A Task 4 — broker OAuth routes.
 *
 * `POST /internal/v1/mailbox/oauth/start` -- exact path App API's own
 * outbound client (`services/app-api/src/integrations/mailbox-broker-client.ts`,
 * Task 2) already calls; guarded for the "app-api" caller only, scope
 * "oauth:start".
 *
 * `GET /oauth/google/callback` -- public, no service auth (Google redirects
 * the end user's browser here). Calls App API's one-time state-consume CAS
 * BEFORE exchanging the authorization code with Google (brief: "Broker
 * calls App consume endpoint before Google code exchange"), so a replayed
 * or tampered callback never reaches Google. The raw session nonce travels
 * via a short-lived cookie (never localStorage, never the query string);
 * only its sha256 digest is ever sent to App API or persisted anywhere.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { ServiceGuard } from "../plugins/auth.js";
import type { MailboxBrokerConnectionAppClient, MailboxProviderAdapter } from "../contracts.js";
import { consumeOAuthState, type VaultKeyMap } from "../oauth-state.js";

export const SESSION_NONCE_COOKIE = "mailbox_oauth_nonce";

export interface OAuthRouteOptions {
  readonly providerAdapter: MailboxProviderAdapter;
  readonly appClient: MailboxBrokerConnectionAppClient;
  readonly vaultKeys: VaultKeyMap;
  readonly allowedRedirectOrigins: readonly string[];
  readonly sessionNonceCookieName?: string;
  /** When set, the callback 404s unless the request Host header matches exactly (case-insensitive, port stripped). */
  readonly expectedCallbackHost?: string;
  /** Guards the internal start route: caller "app-api", scope "oauth:start". */
  readonly appApiStartGuard: ServiceGuard;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = part.slice(0, separatorIndex).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separatorIndex + 1).trim());
    } catch {
      return part.slice(separatorIndex + 1).trim();
    }
  }
  return undefined;
}

const StartBodySchema = z.strictObject({
  connectionId: z.uuid(),
  attemptId: z.uuid(),
  sessionNonce: z.string().trim().min(16).max(512),
  redirectOrigin: z.string().trim().min(1).max(2048),
});
const StartResponseSchema = z.strictObject({
  authorizationUrl: z.string().trim().min(1),
  stateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().trim().min(1),
});

const CallbackQuerySchema = z.object({
  code: z.string().trim().min(1),
  state: z.string().trim().min(1),
});

function requestError(statusCode: number, message: string): Error {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

export async function registerOAuthRoutes(
  app: FastifyInstance,
  options: OAuthRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const allowedOrigins = new Set(options.allowedRedirectOrigins);
  const cookieName = options.sessionNonceCookieName ?? SESSION_NONCE_COOKIE;

  typedApp.post(
    "/internal/v1/mailbox/oauth/start",
    {
      preHandler: [options.appApiStartGuard],
      schema: { body: StartBodySchema, response: { 200: StartResponseSchema } },
    },
    async (request) => {
      if (!allowedOrigins.has(request.body.redirectOrigin)) {
        throw requestError(400, "redirect origin not allowed");
      }
      return options.providerAdapter.createAuthorizationUrl(request.body);
    },
  );

  typedApp.get(
    "/oauth/google/callback",
    { schema: { querystring: CallbackQuerySchema } },
    async (request, reply) => {
      if (options.expectedCallbackHost) {
        const host = (request.headers.host ?? "").split(":")[0]?.trim().toLowerCase();
        if (host !== options.expectedCallbackHost.toLowerCase()) {
          return reply.code(404).send();
        }
      }

      const sessionNonce = readCookie(request.headers.cookie, cookieName);
      if (!sessionNonce) {
        throw requestError(400, "missing session nonce cookie");
      }

      // Decrypt + validate the state locally first (expiry/origin), then
      // call App's one-time consume CAS -- and only after that succeeds,
      // exchange the code with Google. Never the reverse order.
      const consumed = consumeOAuthState({
        state: request.query.state,
        sessionNonce,
        allowedRedirectOrigins: allowedOrigins,
        vaultKeys: options.vaultKeys,
      });

      await options.appClient.consumeOAuthAttempt({
        connectionId: consumed.connectionId,
        attemptId: consumed.attemptId,
        stateDigest: consumed.stateDigest,
        sessionNonceDigest: consumed.sessionNonceDigest,
      });

      const connectedAccount = await options.providerAdapter.exchangeAuthorizationCode({
        code: request.query.code,
        state: request.query.state,
        requestOrigin: consumed.redirectOrigin,
      });

      await options.appClient.completeConnection({
        ...connectedAccount,
        connectionId: consumed.connectionId,
        attemptId: consumed.attemptId,
        expectedConnectionVersion: 0,
      });

      reply.header("set-cookie", `${cookieName}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
      return reply.redirect(`${consumed.redirectOrigin}/mailbox?status=connected`, 302);
    },
  );
}
