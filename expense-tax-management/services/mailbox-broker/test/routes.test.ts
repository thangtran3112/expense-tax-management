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
import { createOAuthState, type VaultKeyMap } from "../src/oauth-state.js";
import { SESSION_NONCE_COOKIE } from "../src/routes/oauth.js";
import { createFakeClerkIssuer, createVaultKeyMap } from "../src/test-doubles.js";

const AUDIENCE = "mch_mailboxServiceAudience";
const APP_API_SUBJECT = "app-api-mailbox";
const WORKER_SUBJECT = "workflow-worker-mailbox";
const ALLOWED_ORIGIN = "https://expense-office.test";

function fakeProviderAdapter(): MailboxProviderAdapter & {
  createAuthorizationUrl: ReturnType<typeof vi.fn>;
  exchangeAuthorizationCode: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
} {
  return {
    createAuthorizationUrl: vi.fn(async (input: { attemptId: string }) => ({
      authorizationUrl: `https://accounts.google.test/auth?attempt=${input.attemptId}`,
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
});
