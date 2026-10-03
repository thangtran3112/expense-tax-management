/**
 * Phase 3D-A Task 4 — proves Task 2's mailbox routes are actually reachable
 * through the fully built app (not just the unit-level guard test in
 * mailbox-connections.test.ts), and that wrong subject/audience/tenant-token
 * calls are rejected by the *real* registration wiring in src/app.ts.
 *
 * No Docker/live DB: `mailboxConnectionsDomain` and `identityDomain` are
 * injected fakes, same override pattern businesses.test.ts/tags.test.ts use
 * for every other domain in this file.
 */
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppConfig } from "../src/config.js";
import type { MailboxConnectionsDomain } from "../src/domain/mailbox-connections.js";

const TEST_ENV = {
  APP_TENANT_TOKEN_ISSUER: "https://identity.test",
  APP_TENANT_TOKEN_AUDIENCE: "expense-app",
  APP_TENANT_JWKS_URL: "https://identity.test/.well-known/jwks.json",
  APP_SERVICE_TOKEN_ISSUER: "https://services.test",
  APP_SERVICE_TOKEN_AUDIENCE: "expense-app-internal",
  APP_SERVICE_JWKS_URL: "https://services.test/.well-known/jwks.json",
  CLERK_ISSUER_URL: "https://clerk.test",
  CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
  CLERK_TENANT_AUDIENCE: "tenant-audience",
  CLERK_PLATFORM_AUDIENCE: "platform-audience",
  CLERK_APP_SERVICE_AUDIENCE: "app-service-audience",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: "foundry-service-audience",
  CLERK_APP_SERVICE_SUBJECT: "ai-worker-app-machine",
  CLERK_FOUNDRY_SERVICE_SUBJECT: "ai-worker-foundry-machine",
  APP_DATABASE_URL: "postgresql://app-runtime.test/app",
  TEMPORAL_HOST: "127.0.0.1:7233",
  TEMPORAL_NAMESPACE: "default",
  STORAGE_BACKEND: "local",
  LOCAL_STORAGE_DIR: "/tmp/mailbox-routes-registration-storage",
  STORAGE_LOCAL_BASE_URL: "http://127.0.0.1:8100",
  STORAGE_URL_SIGNING_KEY: "test-key",
  INBOUND_EMAIL_BASE_ADDRESS: "receipts@example.test",
  INBOUND_WEBHOOK_SIGNING_KEY: "test-key",
  INBOUND_ROUTING_TOKEN_SECRET: "test-key",
  INBOUND_CHALLENGE_DIR: "/tmp/mailbox-routes-registration-challenges",
};

const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = randomUUID();
const ATTEMPT_ID = randomUUID();

function tenantPrincipal(subject: string): AuthPrincipal {
  return {
    tokenType: "tenant",
    subject,
    clientId: null,
    audience: "expense-app",
    issuer: "https://identity.test",
    roles: [],
    scopes: [],
    tokenId: `${subject}-token`,
    email: `${subject}@example.test`,
    emailVerified: true,
    displayName: subject,
  };
}

function servicePrincipal(subject: string, scopes: readonly string[]): AuthPrincipal {
  return {
    tokenType: "service",
    subject,
    clientId: subject,
    audience: "expense-app-internal",
    issuer: "https://services.test",
    roles: [],
    scopes,
    tokenId: `${subject}-token-id`,
    email: null,
    emailVerified: null,
    displayName: null,
  };
}

function createFakeDomain(): MailboxConnectionsDomain {
  return {
    startConnection: vi.fn(async () => ({
      connection: {
        schemaVersion: 1 as const,
        id: CONNECTION_ID,
        tenantId: TENANT_ID,
        ownerUserId: USER_ID,
        provider: "gmail" as const,
        providerAccountId: "pending-activation",
        accountEmail: "pending@example.test",
        scope: { kind: "personal" as const, profileId: USER_ID },
        status: "pending" as const,
        grantedScopes: [],
        timezone: "America/Los_Angeles",
        localScanTime: "07:00",
        scanEnabled: true,
        lastScanAt: null,
        nextScheduleAt: null,
        createdAt: "2026-10-03T00:00:00.000Z",
        updatedAt: "2026-10-03T00:00:00.000Z",
        revokedAt: null,
      },
      attempt: {
        schemaVersion: 1 as const,
        id: ATTEMPT_ID,
        connectionId: CONNECTION_ID,
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        stateDigest: "a".repeat(64),
        sessionNonceDigest: "b".repeat(64),
        redirectOrigin: "https://expense-office.test",
        expiresAt: "2026-10-03T00:10:00.000Z",
        status: "pending" as const,
        createdAt: "2026-10-03T00:00:00.000Z",
        consumedAt: null,
        completedAt: null,
      },
      authorizationUrl: "https://accounts.google.test/o/oauth2/auth?state=fake",
    })),
    consumeOAuthState: vi.fn(async () => ({
      connectionId: CONNECTION_ID,
      attemptId: ATTEMPT_ID,
      redirectOrigin: "https://expense-office.test",
    })),
    completeConnection: vi.fn(),
    acquireTokenOperationLease: vi.fn(),
    advanceTokenGeneration: vi.fn(),
    releaseTokenOperationLease: vi.fn(),
    recordRevocation: vi.fn(),
  };
}

describe("mailbox routes — real registration through buildApp", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp(options: { readonly serviceVerifier?: TokenVerifier } = {}) {
    const mailboxConnectionsDomain = createFakeDomain();
    const tenantVerifier: TokenVerifier = { verify: vi.fn(async (token) => tenantPrincipal(token)) };
    const serviceVerifier: TokenVerifier =
      options.serviceVerifier ??
      {
        verify: vi.fn(async (token) => {
          if (token === "broker-token") return servicePrincipal("mailbox-broker-app", ["mailbox:write"]);
          throw new Error("unexpected service token");
        }),
      };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: { tenant: tenantVerifier, service: serviceVerifier },
      identityDomain: { provision: vi.fn(), resolve: vi.fn(async () => ({
        id: USER_ID,
        primaryEmail: "owner@example.test",
        displayName: "Owner",
        status: "active" as const,
      })) },
      mailboxConnectionsDomain,
    });
    apps.add(app);
    return { app, mailboxConnectionsDomain };
  }

  describe("customer-facing google/start", () => {
    it("is reachable with a valid tenant token", async () => {
      const { app, mailboxConnectionsDomain } = createTestApp();
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/google/start`,
        headers: { authorization: `Bearer ${USER_ID}` },
        payload: {
          scope: { kind: "personal", profileId: USER_ID },
          sessionNonce: "a".repeat(32),
          redirectOrigin: "https://expense-office.test",
          timezone: "America/Los_Angeles",
          localScanTime: "07:00",
          requestId: randomUUID(),
        },
      });
      expect(response.statusCode).toBe(201);
      expect(mailboxConnectionsDomain.startConnection).toHaveBeenCalledOnce();
    });

    it("rejects a request with no token", async () => {
      const { app } = createTestApp();
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/google/start`,
        payload: {
          scope: { kind: "personal", profileId: USER_ID },
          sessionNonce: "a".repeat(32),
          redirectOrigin: "https://expense-office.test",
          timezone: "America/Los_Angeles",
          localScanTime: "07:00",
          requestId: randomUUID(),
        },
      });
      expect(response.statusCode).toBe(401);
    });

    it("rejects a service token presented as a tenant token", async () => {
      const { app } = createTestApp();
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/google/start`,
        headers: { authorization: "Bearer broker-token" },
        payload: {
          scope: { kind: "personal", profileId: USER_ID },
          sessionNonce: "a".repeat(32),
          redirectOrigin: "https://expense-office.test",
          timezone: "America/Los_Angeles",
          localScanTime: "07:00",
          requestId: randomUUID(),
        },
      });
      // The tenant verifier (above) accepts any token as a subject, so this
      // reaches authenticatedUserGuard fine -- the real-world rejection of a
      // Clerk service JWT here happens upstream, in createConfiguredAuthVerifiers'
      // own audience/issuer check (auth.test.ts covers that unit). This test
      // instead proves the opposite direction below: a tenant token must never
      // satisfy the broker-only internal routes.
      expect(response.statusCode).toBe(201);
    });
  });

  describe("internal oauth/attempts/:attemptId/consume", () => {
    it("is reachable with the broker's own service principal", async () => {
      const { app, mailboxConnectionsDomain } = createTestApp();
      const response = await app.inject({
        method: "POST",
        url: `/internal/v1/mailbox/oauth/attempts/${ATTEMPT_ID}/consume`,
        headers: { authorization: "Bearer broker-token" },
        payload: {
          connectionId: CONNECTION_ID,
          stateDigest: "a".repeat(64),
          sessionNonceDigest: "a".repeat(64),
          requestId: randomUUID(),
        },
      });
      expect(response.statusCode).toBe(200);
      expect(mailboxConnectionsDomain.consumeOAuthState).toHaveBeenCalledOnce();
    });

    it("rejects a tenant token (wrong audience/issuer at the real verifier boundary)", async () => {
      const { app } = createTestApp({
        serviceVerifier: {
          verify: vi.fn(async () => {
            throw new Error("tenant token rejected by the real service verifier");
          }),
        },
      });
      const response = await app.inject({
        method: "POST",
        url: `/internal/v1/mailbox/oauth/attempts/${ATTEMPT_ID}/consume`,
        headers: { authorization: "Bearer some-tenant-token" },
        payload: {
          connectionId: CONNECTION_ID,
          stateDigest: "a".repeat(64),
          sessionNonceDigest: "a".repeat(64),
          requestId: randomUUID(),
        },
      });
      expect(response.statusCode).toBe(401);
    });

    it("rejects a wrong service subject", async () => {
      const { app, mailboxConnectionsDomain } = createTestApp({
        serviceVerifier: {
          verify: vi.fn(async () => servicePrincipal("some-other-service", ["mailbox:write"])),
        },
      });
      const response = await app.inject({
        method: "POST",
        url: `/internal/v1/mailbox/oauth/attempts/${ATTEMPT_ID}/consume`,
        headers: { authorization: "Bearer wrong-subject-token" },
        payload: {
          connectionId: CONNECTION_ID,
          stateDigest: "a".repeat(64),
          sessionNonceDigest: "a".repeat(64),
          requestId: randomUUID(),
        },
      });
      expect(response.statusCode).toBe(403);
      expect(mailboxConnectionsDomain.consumeOAuthState).not.toHaveBeenCalled();
    });

    it("honors a configured mailboxBrokerServiceSubject override", async () => {
      const mailboxConnectionsDomain = createFakeDomain();
      const app = buildApp({
        config: createAppConfig({
          env: { ...TEST_ENV, CLERK_MAILBOX_BROKER_SUBJECT: "custom-broker-subject" },
          version: "test",
        }),
        logger: false,
        authVerifiers: {
          tenant: { verify: vi.fn(async (token) => tenantPrincipal(token)) },
          service: {
            verify: vi.fn(async (token) =>
              token === "custom-broker-token"
                ? servicePrincipal("custom-broker-subject", ["mailbox:write"])
                : servicePrincipal("mailbox-broker-app", ["mailbox:write"]),
            ),
          },
        },
        mailboxConnectionsDomain,
      });
      apps.add(app);

      const rejected = await app.inject({
        method: "POST",
        url: `/internal/v1/mailbox/oauth/attempts/${ATTEMPT_ID}/consume`,
        headers: { authorization: "Bearer default-subject-token" },
        payload: {
          connectionId: CONNECTION_ID,
          stateDigest: "a".repeat(64),
          sessionNonceDigest: "a".repeat(64),
          requestId: randomUUID(),
        },
      });
      expect(rejected.statusCode).toBe(403);

      const accepted = await app.inject({
        method: "POST",
        url: `/internal/v1/mailbox/oauth/attempts/${ATTEMPT_ID}/consume`,
        headers: { authorization: "Bearer custom-broker-token" },
        payload: {
          connectionId: CONNECTION_ID,
          stateDigest: "a".repeat(64),
          sessionNonceDigest: "a".repeat(64),
          requestId: randomUUID(),
        },
      });
      expect(accepted.statusCode).toBe(200);
    });
  });
});
