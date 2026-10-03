/**
 * Phase 3D-A Task 4 — broker OAuth routes.
 *
 * `POST /internal/v1/mailbox/oauth/start` -- exact path App API's own
 * outbound client (`services/app-api/src/integrations/mailbox-broker-client.ts`,
 * Task 2) already calls; guarded for the "app-api" caller only, scope
 * "oauth:start".
 *
 * `GET /oauth/google/begin` -- public (Fix round 1, Critical; redesigned
 * fix round 2, Important). The ONLY place the browser touches the
 * broker's own origin before Google, so it's the only place the broker
 * can legally set a cookie that its own later `/oauth/google/callback`
 * will receive back (cookies are origin-scoped -- a cookie set by Office
 * JavaScript on the Office origin is a host-only cookie that never
 * reaches the broker's callback origin, and JavaScript can't set
 * `HttpOnly` anyway).
 *
 * Fix round 2: this route used to accept a client-supplied
 * `authorizationUrl` query parameter and redirect to it verbatim after
 * validating only the `state` extracted from it -- an open redirect (any
 * caller holding a valid `state` could redirect the browser anywhere by
 * substituting a different URL) and a capability replayable for the
 * full ~10-minute OAuth attempt window. It now accepts only an opaque,
 * broker-minted, short-lived (60s) `ticket` (`begin-ticket.ts`) wrapping
 * the real `state` + raw session nonce, and **builds the Google
 * authorization URL itself** from trusted server-side config
 * (`google-authorization-url.ts`) -- the client supplies nothing that
 * influences the redirect destination at all.
 *
 * `GET /oauth/google/callback` -- public, no service auth (Google redirects
 * the end user's browser here). Calls App API's one-time state-consume CAS
 * BEFORE exchanging the authorization code with Google (brief: "Broker
 * calls App consume endpoint before Google code exchange"), so a replayed
 * or tampered callback never reaches Google. The raw session nonce travels
 * via a short-lived, broker-origin-set `Secure; HttpOnly; SameSite=Lax`
 * cookie (never localStorage, never the query string); only its sha256
 * digest is ever sent to App API or persisted anywhere.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { createHash } from "node:crypto";

import type { ServiceGuard } from "../plugins/auth.js";
import type { MailboxBrokerConnectionAppClient, MailboxProviderAdapter } from "../contracts.js";
import { consumeOAuthState, type VaultKeyMap } from "../oauth-state.js";
import { consumeBeginTicket, createBeginTicket } from "../begin-ticket.js";
import type { GoogleAuthorizationUrlBuilder } from "../google-authorization-url.js";

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
  /**
   * Fix round 2 (Important) -- builds the Google authorization URL from
   * trusted server config; the begin route never trusts a client-supplied
   * URL. See `google-authorization-url.ts`.
   */
  readonly buildGoogleAuthorizationUrl: GoogleAuthorizationUrlBuilder;
  /** Begin-ticket TTL in seconds; defaults to 60 (begin-ticket.ts's own default) if omitted. */
  readonly beginTicketTtlSeconds?: number;
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
  /** Fix round 2: opaque, short-lived begin-ticket -- see `begin-ticket.ts`. */
  beginTicket: z.string().trim().min(1),
});

const CallbackQuerySchema = z.object({
  code: z.string().trim().min(1),
  state: z.string().trim().min(1),
});

// Fix round 2: only an opaque ticket -- no authorizationUrl, no nonce.
// Extra/forged query params (e.g. a would-be `authorizationUrl=https://evil.test`)
// are silently ignored by this non-strict schema; nothing in the request
// besides `ticket` ever influences the redirect destination.
const BeginQuerySchema = z.object({
  ticket: z.string().trim().min(1),
});

function requestError(statusCode: number, message: string): Error {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

/** Local copy of oauth-state.ts's private helper (not exported there) -- PKCE S256 code_challenge. */
function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function sessionNonceCookie(cookieName: string, value: string, maxAgeSeconds: number): string {
  return [
    `${cookieName}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");
}

/** Extracts the `state` query parameter from a (not-yet-trusted) absolute URL string. */
function extractStateParam(authorizationUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(authorizationUrl);
  } catch {
    throw requestError(400, "invalid authorizationUrl");
  }
  const state = parsed.searchParams.get("state");
  if (!state) {
    throw requestError(400, "authorizationUrl is missing a state parameter");
  }
  return state;
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
      const started = await options.providerAdapter.createAuthorizationUrl(request.body);
      // Extract the exact `state` just embedded in the Google URL so the
      // begin ticket can carry it -- never re-create a new state here;
      // App API's `mailbox_oauth_attempts.state_digest` row was already
      // computed against this one.
      const state = extractStateParam(started.authorizationUrl);
      const beginTicket = createBeginTicket({
        state,
        sessionNonce: request.body.sessionNonce,
        vaultKeys: options.vaultKeys,
        ...(options.beginTicketTtlSeconds !== undefined
          ? { ttlSeconds: options.beginTicketTtlSeconds }
          : {}),
      });
      return { ...started, beginTicket };
    },
  );

  typedApp.get(
    "/oauth/google/begin",
    { schema: { querystring: BeginQuerySchema } },
    async (request, reply) => {
      // Decrypts the ticket and checks its own short expiry first
      // (BeginTicketInvalidError -> 400, errors.ts). Only on success do we
      // even look at the real OAuth state.
      const { state, sessionNonce } = consumeBeginTicket(request.query.ticket, options.vaultKeys);

      // Stateless validation -- decrypts, checks expiry, confirms the
      // ticket's own nonce digest matches the one embedded in state, and
      // confirms the embedded redirect origin is allowlisted. Throws
      // OAuthStateInvalidError (mapped to 400 by errors.ts) on any
      // mismatch; nothing below runs until this fully succeeds.
      const consumed = consumeOAuthState({
        state,
        sessionNonce,
        allowedRedirectOrigins: allowedOrigins,
        vaultKeys: options.vaultKeys,
      });

      // Built entirely from trusted server config + the already-validated
      // state/PKCE verifier -- nothing from the request influences this.
      const authorizationUrl = options.buildGoogleAuthorizationUrl({
        state,
        codeChallenge: sha256Base64Url(consumed.pkceVerifier),
      });

      reply.header("set-cookie", sessionNonceCookie(cookieName, sessionNonce, 600));
      return reply.redirect(authorizationUrl, 302);
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
      });

      reply.header("set-cookie", sessionNonceCookie(cookieName, "", 0));
      return reply.redirect(`${consumed.redirectOrigin}/mailbox?status=connected`, 302);
    },
  );
}
