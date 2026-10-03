/**
 * Phase 3D-A Task 4 — mailbox-broker Fastify app/routes.
 *
 * Fully local with fakes: no Google, GCP, or Clerk network access, no
 * token-vault database. `providerAdapter`/`appClient` are entirely fake
 * objects (not Task 3's real `createGmailMailboxProvider`, which needs a
 * live Postgres token vault -- out of scope for this route-level suite).
 */
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type BuildAppOptions } from "../src/app.js";
import type { BrokerConfig, InboundAuthConfig } from "../src/config.js";
import type { MailboxBrokerConnectionAppClient, MailboxProviderAdapter } from "../src/contracts.js";
import { createBeginTicket } from "../src/begin-ticket.js";
import { createOAuthState, type VaultKeyMap } from "../src/oauth-state.js";
import { SESSION_NONCE_COOKIE } from "../src/routes/oauth.js";
import { createFakeClerkIssuer, createVaultKeyMap } from "../src/test-doubles.js";
import type { GoogleAuthorizationUrlBuilder } from "../src/google-authorization-url.js";

const AUDIENCE = "mch_mailboxServiceAudience";
const APP_API_SUBJECT = "app-api-mailbox";
const WORKER_SUBJECT = "workflow-worker-mailbox";
const ALLOWED_ORIGIN = "https://expense-office.test";
/** Fix round 2: the fake stands in for a trusted-config Google URL builder -- never client-supplied. */
const GOOGLE_AUTH_ORIGIN = "https://accounts.google.test/o/oauth2/v2/auth";

const fakeBuildGoogleAuthorizationUrl: GoogleAuthorizationUrlBuilder = (input) => {
  const params = new URLSearchParams({
    client_id: "fake-client-id",
    state: input.state,
    code_challenge: input.codeChallenge,
  });
  return `${GOOGLE_AUTH_ORIGIN}?${params.toString()}`;
};

function fakeProviderAdapter(): MailboxProviderAdapter & {
  createAuthorizationUrl: ReturnType<typeof vi.fn>;
  exchangeAuthorizationCode: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
} {
  return {
    // The fake embeds a `state` query param (any opaque string) so the
    // internal start route's extractStateParam/begin-ticket minting has
    // something to wrap -- not a real encrypted state blob; tests that
    // exercise the actual /oauth/google/begin flow build a real one via
    // createOAuthState + createBeginTicket directly instead.
    createAuthorizationUrl: vi.fn(async (input: { attemptId: string }) => ({
      authorizationUrl: `https://accounts.google.test/auth?attempt=${input.attemptId}&state=fake-state-${input.attemptId}`,
      stateDigest: "a".repeat(64),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })),
    exchangeAuthorizationCode: vi.fn(async () => ({
      providerAccountId: "owner@example.test",
      email: "owner@example.test",
      grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      initialHistoryId: "history-1",
      vaultReference: "vault-ref-1",
      tokenGeneration: 1,
    })),
    revoke: vi.fn(async () => undefined),
  };
}

function fakeAppClient(): MailboxBrokerConnectionAppClient & {
  consumeOAuthAttempt: ReturnType<typeof vi.fn>;
  completeConnection: ReturnType<typeof vi.fn>;
  recordRevocation: ReturnType<typeof vi.fn>;
} {
  return {
    consumeOAuthAttempt: vi.fn(async () => ({ status: "consumed" as const, connectionVersion: 0 })),
    completeConnection: vi.fn(async (input) => ({
      schemaVersion: 1 as const,
      id: input.connectionId,
      tenantId: "tenant",
      ownerUserId: "owner",
      provider: "gmail" as const,
      providerAccountId: input.providerAccountId,
      accountEmail: input.email,
      scope: { kind: "personal" as const, profileId: "profile" },
      status: "active" as const,
      grantedScopes: input.grantedScopes,
      timezone: "America/Los_Angeles",
      localScanTime: "07:00",
      scanEnabled: true,
      lastScanAt: null,
      nextScheduleAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revokedAt: null,
    })),
    acquireTokenOperationLease: vi.fn(),
    advanceTokenGeneration: vi.fn(),
    releaseTokenOperationLease: vi.fn(),
    recordRevocation: vi.fn(async (input) => ({
      schemaVersion: 1 as const,
      id: input.connectionId,
      tenantId: "tenant",
      ownerUserId: "owner",
      provider: "gmail" as const,
      providerAccountId: "revoked",
      accountEmail: "revoked@example.test",
      scope: { kind: "personal" as const, profileId: "profile" },
      status: input.status,
      grantedScopes: [],
      timezone: "America/Los_Angeles",
      localScanTime: "07:00",
      scanEnabled: false,
      lastScanAt: null,
      nextScheduleAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revokedAt: new Date().toISOString(),
    })),
  };
}

function fakeConfig(inboundAuth: InboundAuthConfig, vault: VaultKeyMap): BrokerConfig {
  return {
    service: "mailbox-broker",
    version: "test",
    port: 8300,
    databaseUrl: "postgresql://vault.test/vault",
    inboundAuth,
    outboundApp: {
      issuerUrl: "https://clerk.test",
      jwksUrl: "https://clerk.test/.well-known/jwks.json",
      baseUrl: "http://app-api.test",
      credentials: { audience: "app-service-audience", machineSecretKey: "secret", subject: "mailbox-broker-app" },
    },
    vault,
  };
}

describe("mailbox-broker routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  async function createTestApp(overrides: Partial<BuildAppOptions> = {}) {
    const issuer = await createFakeClerkIssuer();
    const providerAdapter = fakeProviderAdapter();
    const appClient = fakeAppClient();
    const vaultKeys = createVaultKeyMap();
    const inboundAuth: InboundAuthConfig = {
      issuer: issuer.issuerUrl,
      audience: AUDIENCE,
      jwksUrl: issuer.jwksUrl,
      appApiSubject: APP_API_SUBJECT,
      workerSubject: WORKER_SUBJECT,
    };
    const app = buildApp({
      config: fakeConfig(inboundAuth, vaultKeys),
      logger: false,
      appClient,
      providerAdapter,
      allowedRedirectOrigins: [ALLOWED_ORIGIN],
      inboundKeyResolver: issuer.keyResolver,
      buildGoogleAuthorizationUrl: fakeBuildGoogleAuthorizationUrl,
      ...overrides,
    });
    apps.add(app);

    async function appApiToken(scopes: readonly string[]): Promise<string> {
      return issuer.mint({ subject: APP_API_SUBJECT, audience: AUDIENCE, scopes });
    }
    async function workerToken(scopes: readonly string[]): Promise<string> {
      return issuer.mint({ subject: WORKER_SUBJECT, audience: AUDIENCE, scopes });
    }

    return { app, providerAdapter, appClient, vaultKeys, appApiToken, workerToken, issuer };
  }

  // ------------------------------------------------------------------ //
  // Internal start route — exact M2M auth
  // ------------------------------------------------------------------ //

  describe("POST /internal/v1/mailbox/oauth/start", () => {
    it("accepts the app-api caller with scope oauth:start", async () => {
      const { app, providerAdapter, appApiToken } = await createTestApp();
      const token = await appApiToken(["oauth:start"]);

      const response = await app.inject({
        method: "POST",
        url: "/internal/v1/mailbox/oauth/start",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          connectionId: randomUUID(),
          attemptId: randomUUID(),
          sessionNonce: "a".repeat(32),
          redirectOrigin: ALLOWED_ORIGIN,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(providerAdapter.createAuthorizationUrl).toHaveBeenCalledOnce();
    });

    it("rejects the workflow worker's own subject (wrong caller)", async () => {
      const { app, providerAdapter, workerToken } = await createTestApp();
      const token = await workerToken(["mailbox:discover"]);

      const response = await app.inject({
        method: "POST",
        url: "/internal/v1/mailbox/oauth/start",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          connectionId: randomUUID(),
          attemptId: randomUUID(),
          sessionNonce: "a".repeat(32),
          redirectOrigin: ALLOWED_ORIGIN,
        },
      });

      expect(response.statusCode).toBe(401);
      expect(providerAdapter.createAuthorizationUrl).not.toHaveBeenCalled();
    });

    it("rejects app-api without the oauth:start scope", async () => {
      const { app, appApiToken } = await createTestApp();
      const token = await appApiToken([]);

      const response = await app.inject({
        method: "POST",
        url: "/internal/v1/mailbox/oauth/start",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          connectionId: randomUUID(),
          attemptId: randomUUID(),
          sessionNonce: "a".repeat(32),
          redirectOrigin: ALLOWED_ORIGIN,
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it("rejects a redirect origin outside the allowlist", async () => {
      const { app, appApiToken } = await createTestApp();
      const token = await appApiToken(["oauth:start"]);

      const response = await app.inject({
        method: "POST",
        url: "/internal/v1/mailbox/oauth/start",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          connectionId: randomUUID(),
          attemptId: randomUUID(),
          sessionNonce: "a".repeat(32),
          redirectOrigin: "https://evil.test",
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it("rejects a request with no token", async () => {
      const { app } = await createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/internal/v1/mailbox/oauth/start",
        payload: {
          connectionId: randomUUID(),
          attemptId: randomUUID(),
          sessionNonce: "a".repeat(32),
          redirectOrigin: ALLOWED_ORIGIN,
        },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ------------------------------------------------------------------ //
  // Internal revoke route — exact M2M auth
  // ------------------------------------------------------------------ //

  describe("POST /internal/v1/connections/:connectionId/revoke", () => {
    it("accepts the app-api caller with scope connections:revoke, calls revoke then recordRevocation", async () => {
      const { app, providerAdapter, appClient, appApiToken } = await createTestApp();
      const token = await appApiToken(["connections:revoke"]);
      const connectionId = randomUUID();
      const operationId = randomUUID();
      const callOrder: string[] = [];
      providerAdapter.revoke.mockImplementation(async () => {
        callOrder.push("revoke");
      });
      appClient.recordRevocation.mockImplementation(async (input: { connectionId: string }) => {
        callOrder.push("recordRevocation");
        return {
          schemaVersion: 1 as const,
          id: input.connectionId,
          tenantId: "tenant",
          ownerUserId: "owner",
          provider: "gmail" as const,
          providerAccountId: "revoked",
          accountEmail: "revoked@example.test",
          scope: { kind: "personal" as const, profileId: "profile" },
          status: "revoked" as const,
          grantedScopes: [],
          timezone: "America/Los_Angeles",
          localScanTime: "07:00",
          scanEnabled: false,
          lastScanAt: null,
          nextScheduleAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          revokedAt: new Date().toISOString(),
        };
      });

      const response = await app.inject({
        method: "POST",
        url: `/internal/v1/connections/${connectionId}/revoke`,
        headers: { authorization: `Bearer ${token}` },
        payload: { operationId },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("revoked");
      expect(callOrder).toEqual(["revoke", "recordRevocation"]);
    });

    it("rejects a wrong scope (missing connections:revoke)", async () => {
      const { app, appClient, appApiToken } = await createTestApp();
      const token = await appApiToken(["oauth:start"]);

      const response = await app.inject({
        method: "POST",
        url: `/internal/v1/connections/${randomUUID()}/revoke`,
        headers: { authorization: `Bearer ${token}` },
        payload: { operationId: randomUUID() },
      });

      expect(response.statusCode).toBe(401);
      expect(appClient.recordRevocation).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------ //
  // Public callback — method/host policy, query redaction, call ordering
  // ------------------------------------------------------------------ //

  describe("GET /oauth/google/callback", () => {
    function cookieHeader(sessionNonce: string): string {
      return `${SESSION_NONCE_COOKIE}=${encodeURIComponent(sessionNonce)}`;
    }

    it("consumes App's one-time state before exchanging the code with Google", async () => {
      const connectionId = randomUUID();
      const attemptId = randomUUID();
      const sessionNonce = "a".repeat(32);
      const { app, appClient, providerAdapter, vaultKeys } = await createTestApp();
      const state = createOAuthState({
        connectionId,
        attemptId,
        sessionNonce,
        redirectOrigin: ALLOWED_ORIGIN,
        ttlSeconds: 600,
        vaultKeys,
      });

      const callOrder: string[] = [];
      appClient.consumeOAuthAttempt.mockImplementation(async () => {
        callOrder.push("consume");
        return { status: "consumed" as const, connectionVersion: 0 };
      });
      providerAdapter.exchangeAuthorizationCode.mockImplementation(async () => {
        callOrder.push("exchange");
        return {
          providerAccountId: "owner@example.test",
          email: "owner@example.test",
          grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          initialHistoryId: "history-1",
          vaultReference: "vault-ref-1",
          tokenGeneration: 1,
        };
      });

      const response = await app.inject({
        method: "GET",
        url: `/oauth/google/callback?code=google-code-value&state=${encodeURIComponent(state.state)}`,
        headers: { cookie: cookieHeader(sessionNonce) },
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(`${ALLOWED_ORIGIN}/mailbox?status=connected`);
      expect(callOrder).toEqual(["consume", "exchange"]);
      expect(appClient.completeConnection).toHaveBeenCalledOnce();
      // The cleared-cookie response must never echo the raw session nonce back.
      expect(String(response.headers["set-cookie"])).not.toContain(sessionNonce);
    });

    it("rejects a missing session-nonce cookie", async () => {
      const connectionId = randomUUID();
      const attemptId = randomUUID();
      const sessionNonce = "a".repeat(32);
      const { app, vaultKeys } = await createTestApp();
      const state = createOAuthState({
        connectionId,
        attemptId,
        sessionNonce,
        redirectOrigin: ALLOWED_ORIGIN,
        ttlSeconds: 600,
        vaultKeys,
      });

      const response = await app.inject({
        method: "GET",
        url: `/oauth/google/callback?code=google-code-value&state=${encodeURIComponent(state.state)}`,
      });

      expect(response.statusCode).toBe(400);
    });

    it("method policy: rejects non-GET methods at the callback path", async () => {
      const { app } = await createTestApp();
      const response = await app.inject({ method: "POST", url: "/oauth/google/callback" });
      expect(response.statusCode).toBe(404);
    });

    it("host policy: 404s when the Host header doesn't match the configured callback host", async () => {
      const { app } = await createTestApp({ expectedCallbackHost: "expense-office.tobytran.dev" });
      const response = await app.inject({
        method: "GET",
        url: "/oauth/google/callback?code=x&state=y",
        headers: { host: "attacker.test" },
      });
      expect(response.statusCode).toBe(404);
    });

    it("host policy: passes through when the Host header matches (port stripped)", async () => {
      const { app } = await createTestApp({ expectedCallbackHost: "expense-office.tobytran.dev" });
      const response = await app.inject({
        method: "GET",
        url: "/oauth/google/callback?code=x&state=y",
        headers: { host: "expense-office.tobytran.dev:443" },
      });
      // Passes the host check, fails later (no cookie) -- proves the host
      // check isn't what rejected it (400, not 404).
      expect(response.statusCode).toBe(400);
    });

    it("query redaction: the request log never contains the raw code or state value", async () => {
      const logLines: string[] = [];
      const writableStream = {
        write(chunk: string) {
          logLines.push(chunk);
          return true;
        },
      };
      const issuer = await createFakeClerkIssuer();
      const vaultKeys = createVaultKeyMap();
      const inboundAuth: InboundAuthConfig = {
        issuer: issuer.issuerUrl,
        audience: AUDIENCE,
        jwksUrl: issuer.jwksUrl,
        appApiSubject: APP_API_SUBJECT,
        workerSubject: WORKER_SUBJECT,
      };
      const app = buildApp({
        config: fakeConfig(inboundAuth, vaultKeys),
        logger: { level: "info", stream: writableStream as never },
        appClient: fakeAppClient(),
        providerAdapter: fakeProviderAdapter(),
        allowedRedirectOrigins: [ALLOWED_ORIGIN],
        inboundKeyResolver: issuer.keyResolver,
      });
      apps.add(app);

      const secretCode = "SECRET_GOOGLE_CODE_VALUE";
      const secretState = "SECRET_STATE_BLOB_VALUE";
      await app.inject({
        method: "GET",
        url: `/oauth/google/callback?code=${secretCode}&state=${secretState}`,
      });

      const combined = logLines.join("\n");
      expect(combined).not.toContain(secretCode);
      expect(combined).not.toContain(secretState);
    });
  });

  // ------------------------------------------------------------------ //
  // Fix round 1 (Critical) — the begin route is where the broker's own
  // origin sets the HttpOnly session-nonce cookie BEFORE redirecting the
  // browser to Google. Office JavaScript can no longer set this cookie
  // (it would be host-only on the Office origin, never sent to the
  // broker's callback origin, and couldn't be HttpOnly either).
  // ------------------------------------------------------------------ //

  describe("GET /oauth/google/begin", () => {
    function realState(vaultKeys: VaultKeyMap, overrides: { readonly sessionNonce?: string; readonly ttlSeconds?: number } = {}) {
      return createOAuthState({
        connectionId: randomUUID(),
        attemptId: randomUUID(),
        sessionNonce: overrides.sessionNonce ?? "a".repeat(32),
        redirectOrigin: ALLOWED_ORIGIN,
        ttlSeconds: overrides.ttlSeconds ?? 600,
        vaultKeys,
      });
    }

    it("builds the Google URL itself from trusted config, sets the HttpOnly cookie, and redirects there", async () => {
      const { app, vaultKeys } = await createTestApp();
      const sessionNonce = "a".repeat(32);
      const state = realState(vaultKeys, { sessionNonce });
      const ticket = createBeginTicket({ state: state.state, sessionNonce, vaultKeys });

      const response = await app.inject({ method: "GET", url: `/oauth/google/begin?ticket=${encodeURIComponent(ticket)}` });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(
        fakeBuildGoogleAuthorizationUrl({ state: state.state, codeChallenge: state.codeChallenge }),
      );
      const setCookie = String(response.headers["set-cookie"]);
      expect(setCookie).toContain(`${SESSION_NONCE_COOKIE}=${sessionNonce}`);
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Secure");
      expect(setCookie).toContain("SameSite=Lax");
    });

    // Fix round 2 (Important) — the old design accepted a client-supplied
    // `authorizationUrl` and redirected to it verbatim (open redirect).
    // There is no longer any such parameter to mutate, but this proves it
    // structurally: an attacker-controlled `authorizationUrl`/`host`
    // alongside a valid `ticket` is silently ignored -- the redirect
    // destination is always the broker's own trusted-config URL.
    it("host mutation rejected: ignores an attacker-supplied authorizationUrl/host, redirecting only to the broker-built URL", async () => {
      const { app, vaultKeys } = await createTestApp();
      const sessionNonce = "a".repeat(32);
      const state = realState(vaultKeys, { sessionNonce });
      const ticket = createBeginTicket({ state: state.state, sessionNonce, vaultKeys });

      const response = await app.inject({
        method: "GET",
        url:
          `/oauth/google/begin?ticket=${encodeURIComponent(ticket)}` +
          `&authorizationUrl=${encodeURIComponent("https://evil.test/phish")}` +
          `&host=evil.test&state=attacker-state`,
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).not.toContain("evil.test");
      expect(response.headers.location).toBe(
        fakeBuildGoogleAuthorizationUrl({ state: state.state, codeChallenge: state.codeChallenge }),
      );
    });

    it("rejects a missing ticket", async () => {
      const { app } = await createTestApp();
      const response = await app.inject({ method: "GET", url: "/oauth/google/begin" });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a forged/garbage ticket", async () => {
      const { app } = await createTestApp();
      const response = await app.inject({
        method: "GET",
        url: `/oauth/google/begin?ticket=${encodeURIComponent("not-a-real-ticket")}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers["set-cookie"]).toBeUndefined();
    });

    it("rejects a ticket built from a different (unknown) vault key", async () => {
      const { app, vaultKeys } = await createTestApp();
      const sessionNonce = "a".repeat(32);
      const state = realState(vaultKeys, { sessionNonce });
      const otherVaultKeys = createVaultKeyMap();
      const ticket = createBeginTicket({ state: state.state, sessionNonce, vaultKeys: otherVaultKeys });

      const response = await app.inject({ method: "GET", url: `/oauth/google/begin?ticket=${encodeURIComponent(ticket)}` });
      expect(response.statusCode).toBe(400);
    });

    it("rejects an expired ticket (tight-expiry replay bound)", async () => {
      const { app, vaultKeys } = await createTestApp();
      const sessionNonce = "a".repeat(32);
      const state = realState(vaultKeys, { sessionNonce });
      const ticket = createBeginTicket({ state: state.state, sessionNonce, vaultKeys, ttlSeconds: -1 });

      const response = await app.inject({ method: "GET", url: `/oauth/google/begin?ticket=${encodeURIComponent(ticket)}` });
      expect(response.statusCode).toBe(400);
      expect(response.headers["set-cookie"]).toBeUndefined();
    });

    it("rejects a ticket whose nonce doesn't match the wrapped state's embedded digest", async () => {
      const { app, vaultKeys } = await createTestApp();
      const state = realState(vaultKeys, { sessionNonce: "a".repeat(32) });
      // Ticket is itself validly minted/decryptable, but wraps a nonce
      // that doesn't match this state's own embedded digest.
      const ticket = createBeginTicket({ state: state.state, sessionNonce: "b".repeat(32), vaultKeys });

      const response = await app.inject({ method: "GET", url: `/oauth/google/begin?ticket=${encodeURIComponent(ticket)}` });
      expect(response.statusCode).toBe(400);
      expect(response.headers["set-cookie"]).toBeUndefined();
    });

    it("rejects an expired state even with a fresh, validly-signed ticket", async () => {
      const { app, vaultKeys } = await createTestApp();
      const sessionNonce = "a".repeat(32);
      const state = realState(vaultKeys, { sessionNonce, ttlSeconds: -1 });
      const ticket = createBeginTicket({ state: state.state, sessionNonce, vaultKeys });

      const response = await app.inject({ method: "GET", url: `/oauth/google/begin?ticket=${encodeURIComponent(ticket)}` });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a redirect origin outside the allowlist, even with a validly-signed state", async () => {
      const issuer = await createFakeClerkIssuer();
      const vaultKeys = createVaultKeyMap();
      const inboundAuth: InboundAuthConfig = {
        issuer: issuer.issuerUrl,
        audience: AUDIENCE,
        jwksUrl: issuer.jwksUrl,
        appApiSubject: APP_API_SUBJECT,
        workerSubject: WORKER_SUBJECT,
      };
      const app = buildApp({
        config: fakeConfig(inboundAuth, vaultKeys),
        logger: false,
        appClient: fakeAppClient(),
        providerAdapter: fakeProviderAdapter(),
        allowedRedirectOrigins: [ALLOWED_ORIGIN],
        inboundKeyResolver: issuer.keyResolver,
        buildGoogleAuthorizationUrl: fakeBuildGoogleAuthorizationUrl,
      });
      apps.add(app);
      const sessionNonce = "a".repeat(32);
      const state = createOAuthState({
        connectionId: randomUUID(),
        attemptId: randomUUID(),
        sessionNonce,
        redirectOrigin: "https://evil.test",
        ttlSeconds: 600,
        vaultKeys,
      });
      const ticket = createBeginTicket({ state: state.state, sessionNonce, vaultKeys });

      const response = await app.inject({
        method: "GET",
        url: `/oauth/google/begin?ticket=${encodeURIComponent(ticket)}`,
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
