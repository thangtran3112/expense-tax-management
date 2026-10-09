/**
 * Phase 3D-A Task 4 — proves Task 2's mailbox routes are actually reachable
 * through the fully built app (not just the unit-level guard test in
 * mailbox-connections.test.ts), and that wrong issuer/audience/subject/
 * token-type/tenant-vs-service calls are rejected by the *real*
 * registration wiring in src/app.ts.
 *
 * Fix round 1 (Important, review finding 4): the original version of this
 * file used a fake tenant verifier that accepted literally any bearer
 * token as a valid subject (`verify: async (token) => principal(token)`),
 * which made its one "rejects a service token" test assert 201 instead of
 * a rejection -- the fake was too lenient to ever reject anything. This
 * version uses real `createTokenVerifier` instances (same primitive
 * test/auth.test.ts uses) with distinct signing keys per actor, so every
 * negative case is a genuinely-signed-but-wrong token exercising the real
 * `jwtVerify` issuer/audience/signature checks, not a lenient stand-in.
 *
 * No Docker/live DB: `mailboxConnectionsDomain` and `identityDomain` are
 * injected fakes, same override pattern businesses.test.ts/tags.test.ts use
 * for every other domain in this file.
 *
 * Phase 3D-B Task 3 fix round 1 (review finding 3) adds the same real-
 * signed-fixture coverage for the two worker-facing routes Task 3 added
 * (`scheduled-scans`/`finalize`), guarded by the worker's own service
 * principal (subject "workflow-worker-mailbox", scope "mailbox:discover")
 * -- distinct from the broker's subject/scope used by every other
 * describe block in this file.
 */
import { randomUUID } from "node:crypto";

import { generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { createTokenVerifier } from "../src/auth/verifier.js";
import { createAppConfig } from "../src/config.js";
import type { MailboxConnectionsDomain } from "../src/domain/mailbox-connections.js";
import type { MailboxScansDomain } from "../src/domain/mailbox-scans.js";
import type { ProcessingJobsDomain } from "../src/domain/processing-jobs.js";

const TENANT_ISSUER = "https://identity.test";
const TENANT_AUDIENCE = "expense-app";
const SERVICE_ISSUER = "https://services.test";
const SERVICE_AUDIENCE = "expense-app-internal";
const BROKER_SUBJECT = "mailbox-broker-app";
const WORKER_SUBJECT = "workflow-worker-mailbox";

const TEST_ENV = {
  APP_TENANT_TOKEN_ISSUER: TENANT_ISSUER,
  APP_TENANT_TOKEN_AUDIENCE: TENANT_AUDIENCE,
  APP_TENANT_JWKS_URL: "https://identity.test/.well-known/jwks.json",
  APP_SERVICE_TOKEN_ISSUER: SERVICE_ISSUER,
  APP_SERVICE_TOKEN_AUDIENCE: SERVICE_AUDIENCE,
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
  MAILBOX_BROKER_PUBLIC_BASE_URL: "https://expense-mailbox.test",
};

const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = randomUUID();
const ATTEMPT_ID = randomUUID();
const JOB_ID = randomUUID();
const MATERIALIZE_CANDIDATE_ID = randomUUID();

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

interface SignOptions {
  readonly key: KeyPair["privateKey"];
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string;
  readonly scopes?: readonly string[];
  readonly tokenType?: "tenant" | "service";
}

async function signToken(options: SignOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const claims: Record<string, unknown> =
    options.tokenType === "service"
      ? { scope: (options.scopes ?? []).join(" ") }
      : { email: "owner@example.test", email_verified: true, display_name: "Owner" };

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(options.issuer ?? TENANT_ISSUER)
    .setAudience(options.audience ?? TENANT_AUDIENCE)
    .setSubject(options.subject ?? USER_ID)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(options.key);
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
      beginTicket: "bt1.key-1.fake-nonce.fake-ciphertext",
    })),
    getConnection: vi.fn(async () => null),
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

function createFakeScansDomain(): MailboxScansDomain {
  return {
    startManualScan: vi.fn(),
    startScheduledScan: vi.fn(async (input) => ({
      scanRun: {
        schemaVersion: 1 as const,
        id: randomUUID(),
        connectionId: input.connectionId,
        tenantId: input.tenantId,
        initiatedBy: "schedule" as const,
        entitlementVersion: 1,
        connectionVersion: 1,
        status: "pending" as const,
        discoveredCount: 0,
        stagedCount: 0,
        reviewCount: 0,
        duplicateCount: 0,
        skippedCount: 0,
        failedCount: 0,
        errorCode: null,
        idempotencyKey: input.requestId,
        createdAt: "2026-10-03T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
      },
      status: "started" as const,
    })),
    listScanRuns: vi.fn(),
    loadScanBinding: vi.fn(),
    loadCandidateBinding: vi.fn(),
    recordCandidateMetadata: vi.fn(),
    finalizeScanRun: vi.fn(async (input) => ({
      scanRun: {
        schemaVersion: 1 as const,
        id: input.scanRunId,
        connectionId: CONNECTION_ID,
        tenantId: TENANT_ID,
        initiatedBy: "schedule" as const,
        entitlementVersion: 1,
        connectionVersion: 1,
        status: input.outcome === "succeeded" ? ("completed" as const) : ("failed" as const),
        discoveredCount: 0,
        stagedCount: 0,
        reviewCount: 0,
        duplicateCount: 0,
        skippedCount: 0,
        failedCount: 0,
        errorCode: null,
        idempotencyKey: "idempotency-key",
        createdAt: "2026-10-03T00:00:00.000Z",
        startedAt: "2026-10-03T00:00:00.000Z",
        completedAt: "2026-10-03T00:05:00.000Z",
      },
      leaseReleased: true,
    })),
  };
}

/**
 * Phase 3D-C Task 5 fix round 1 -- fake backing the three new
 * routes/mailbox-internal.ts job-callback routes (materialize-input/
 * status/result), same per-file fake-domain-construction convention as
 * createFakeDomain/createFakeScansDomain above.
 */
function createFakeProcessingJobsDomain(): ProcessingJobsDomain {
  const job = {
    id: JOB_ID,
    tenantId: TENANT_ID,
    personalProfileId: USER_ID,
    businessId: null,
    workflowType: "MailboxMaterializeWorkflow",
    workflowId: `job-${JOB_ID}`,
    taskQueue: "expense-tax-processing",
    runId: "fake-run",
    status: "RUNNING" as const,
    targetAggregateType: "mailbox_candidate",
    targetAggregateId: MATERIALIZE_CANDIDATE_ID,
    expectedAggregateVersion: null,
    inputParams: { mailboxCandidateId: MATERIALIZE_CANDIDATE_ID },
    allowedResultSchemaVersion: "mailbox-materialize-v1",
    result: null,
    errorMessage: null,
    version: 2,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    dispatchedAt: "2026-10-03T00:00:00.000Z",
    completedAt: null,
  };
  return {
    createJob: vi.fn(),
    dispatchPendingJobs: vi.fn(async () => ({ dispatchedCount: 0 })),
    getJob: vi.fn(async () => job),
    recordStatusUpdate: vi.fn(async () => ({ statusCode: 200 as const, body: { ...job, status: "RUNNING" as const }, replayed: false })),
    submitResult: vi.fn(async () => ({ statusCode: 200 as const, body: { ...job, status: "SUCCEEDED" as const }, replayed: false })),
  };
}

const startPayload = () => ({
  scope: { kind: "personal", profileId: USER_ID },
  redirectOrigin: "https://expense-office.test",
  timezone: "America/Los_Angeles",
  localScanTime: "07:00",
  requestId: randomUUID(),
});

const consumePayload = () => ({
  connectionId: CONNECTION_ID,
  stateDigest: "a".repeat(64),
  sessionNonceDigest: "a".repeat(64),
  requestId: randomUUID(),
});

describe("mailbox routes — real registration through buildApp", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();
  let tenantKeys: KeyPair;
  let serviceKeys: KeyPair;
  let attackerKeys: KeyPair;

  beforeAll(async () => {
    [tenantKeys, serviceKeys, attackerKeys] = await Promise.all([
      generateKeyPair("RS256"),
      generateKeyPair("RS256"),
      generateKeyPair("RS256"),
    ]);
  });

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp(envOverrides: Record<string, string> = {}) {
    const mailboxConnectionsDomain = createFakeDomain();
    const mailboxScansDomain = createFakeScansDomain();
    const processingJobsDomain = createFakeProcessingJobsDomain();
    const tenantVerifier = createTokenVerifier({
      tokenType: "tenant",
      issuer: TENANT_ISSUER,
      audience: TENANT_AUDIENCE,
      keyResolver: async () => tenantKeys.publicKey,
      requireVerifiedEmail: true,
    });
    const serviceVerifier = createTokenVerifier({
      tokenType: "service",
      issuer: SERVICE_ISSUER,
      audience: SERVICE_AUDIENCE,
      keyResolver: async () => serviceKeys.publicKey,
    });
    const app = buildApp({
      config: createAppConfig({ env: { ...TEST_ENV, ...envOverrides }, version: "test" }),
      logger: false,
      authVerifiers: { tenant: tenantVerifier, service: serviceVerifier },
      identityDomain: {
        provision: vi.fn(),
        resolve: vi.fn(async () => ({
          id: USER_ID,
          primaryEmail: "owner@example.test",
          displayName: "Owner",
          status: "active" as const,
        })),
      },
      mailboxConnectionsDomain,
      mailboxScansDomain,
      processingJobsDomain,
    });
    apps.add(app);
    return { app, mailboxConnectionsDomain, mailboxScansDomain, processingJobsDomain };
  }

  async function postStart(app: ReturnType<typeof buildApp>, authorization?: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/google/start`,
      headers: authorization !== undefined ? { authorization } : {},
      payload: startPayload(),
    });
  }

  async function postScheduledScan(app: ReturnType<typeof buildApp>, authorization?: string) {
    return app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/connections/${CONNECTION_ID}/scheduled-scans`,
      headers: authorization !== undefined ? { authorization } : {},
      payload: { tenantId: TENANT_ID, requestId: randomUUID() },
    });
  }

  async function postFinalize(app: ReturnType<typeof buildApp>, authorization?: string) {
    return app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${randomUUID()}/finalize`,
      headers: authorization !== undefined ? { authorization } : {},
      payload: { outcome: "succeeded" },
    });
  }

  async function postConsume(app: ReturnType<typeof buildApp>, authorization?: string) {
    return app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/oauth/attempts/${ATTEMPT_ID}/consume`,
      headers: authorization !== undefined ? { authorization } : {},
      payload: consumePayload(),
    });
  }

  async function getMaterializeInput(app: ReturnType<typeof buildApp>, authorization?: string) {
    return app.inject({
      method: "GET",
      url: `/internal/v1/mailbox/jobs/${JOB_ID}/materialize-input`,
      headers: authorization !== undefined ? { authorization } : {},
    });
  }

  async function postMailboxJobStatus(app: ReturnType<typeof buildApp>, authorization?: string) {
    return app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/jobs/${JOB_ID}/status`,
      headers: authorization !== undefined ? { authorization } : {},
      payload: { schemaVersion: 1, status: "RUNNING", idempotencyKey: `t5fr1-${JOB_ID}`, expectedJobVersion: 2 },
    });
  }

  async function postMailboxJobResult(app: ReturnType<typeof buildApp>, authorization?: string) {
    return app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/jobs/${JOB_ID}/result`,
      headers: authorization !== undefined ? { authorization } : {},
      payload: {
        schemaVersion: 1,
        status: "SUCCEEDED",
        idempotencyKey: `t5fr1-result-${JOB_ID}`,
        expectedJobVersion: 2,
        resultSchemaVersion: "mailbox-materialize-v1",
        result: { candidateId: MATERIALIZE_CANDIDATE_ID, status: "queued" },
      },
    });
  }

  describe("customer-facing google/start", () => {
    it("is reachable with a validly-signed tenant token and wraps the response in the broker's begin URL", async () => {
      const { app, mailboxConnectionsDomain } = createTestApp();
      const token = await signToken({ key: tenantKeys.privateKey });

      const response = await postStart(app, `Bearer ${token}`);

      expect(response.statusCode).toBe(201);
      expect(mailboxConnectionsDomain.startConnection).toHaveBeenCalledOnce();
      const body = response.json() as { authorizationUrl: string };
      expect(body.authorizationUrl.startsWith("https://expense-mailbox.test/oauth/google/begin?")).toBe(true);
      expect(body.authorizationUrl).toContain("ticket=");
    });

    it("rejects a request with no token", async () => {
      const { app } = createTestApp();
      expect((await postStart(app)).statusCode).toBe(401);
    });

    it("rejects a tenant token signed by the wrong issuer", async () => {
      const { app } = createTestApp();
      const token = await signToken({ key: tenantKeys.privateKey, issuer: "https://attacker-issuer.test" });
      expect((await postStart(app, `Bearer ${token}`)).statusCode).toBe(401);
    });

    it("rejects a tenant token signed for the wrong audience", async () => {
      const { app } = createTestApp();
      const token = await signToken({ key: tenantKeys.privateKey, audience: "some-other-audience" });
      expect((await postStart(app, `Bearer ${token}`)).statusCode).toBe(401);
    });

    it("rejects a token signed by an attacker holding a different key (same issuer/audience/claims)", async () => {
      const { app, mailboxConnectionsDomain } = createTestApp();
      const token = await signToken({ key: attackerKeys.privateKey });
      expect((await postStart(app, `Bearer ${token}`)).statusCode).toBe(401);
      expect(mailboxConnectionsDomain.startConnection).not.toHaveBeenCalled();
    });

    it("rejects a validly-signed SERVICE token presented as a tenant token (wrong issuer/audience/token type)", async () => {
      const { app, mailboxConnectionsDomain } = createTestApp();
      const token = await signToken({
        key: serviceKeys.privateKey,
        issuer: SERVICE_ISSUER,
        audience: SERVICE_AUDIENCE,
        subject: BROKER_SUBJECT,
        scopes: ["mailbox:write"],
        tokenType: "service",
      });

      const response = await postStart(app, `Bearer ${token}`);

      expect(response.statusCode).toBe(401);
      expect(mailboxConnectionsDomain.startConnection).not.toHaveBeenCalled();
    });
  });

  describe("internal oauth/attempts/:attemptId/consume", () => {
    async function brokerToken(overrides: Partial<SignOptions> = {}): Promise<string> {
      return signToken({
        key: serviceKeys.privateKey,
        issuer: SERVICE_ISSUER,
        audience: SERVICE_AUDIENCE,
        subject: BROKER_SUBJECT,
        scopes: ["mailbox:write"],
        tokenType: "service",
        ...overrides,
      });
    }

    it("is reachable with the broker's own validly-signed service principal", async () => {
      const { app, mailboxConnectionsDomain } = createTestApp();
      const response = await postConsume(app, `Bearer ${await brokerToken()}`);
      expect(response.statusCode).toBe(200);
      expect(mailboxConnectionsDomain.consumeOAuthState).toHaveBeenCalledOnce();
    });

    it("rejects a request with no token", async () => {
      const { app } = createTestApp();
      expect((await postConsume(app)).statusCode).toBe(401);
    });

    it("rejects a validly-signed tenant token (wrong issuer/audience/token type)", async () => {
      const { app, mailboxConnectionsDomain } = createTestApp();
      const token = await signToken({ key: tenantKeys.privateKey });
      const response = await postConsume(app, `Bearer ${token}`);
      expect(response.statusCode).toBe(401);
      expect(mailboxConnectionsDomain.consumeOAuthState).not.toHaveBeenCalled();
    });

    it("rejects a service token signed by the wrong issuer", async () => {
      const { app } = createTestApp();
      const token = await brokerToken({ issuer: "https://attacker-issuer.test" });
      expect((await postConsume(app, `Bearer ${token}`)).statusCode).toBe(401);
    });

    it("rejects a service token signed for the wrong audience", async () => {
      const { app } = createTestApp();
      const token = await brokerToken({ audience: "some-other-audience" });
      expect((await postConsume(app, `Bearer ${token}`)).statusCode).toBe(401);
    });

    it("rejects a service token signed by an attacker holding a different key", async () => {
      const { app, mailboxConnectionsDomain } = createTestApp();
      const token = await signToken({
        key: attackerKeys.privateKey,
        issuer: SERVICE_ISSUER,
        audience: SERVICE_AUDIENCE,
        subject: BROKER_SUBJECT,
        scopes: ["mailbox:write"],
        tokenType: "service",
      });
      expect((await postConsume(app, `Bearer ${token}`)).statusCode).toBe(401);
      expect(mailboxConnectionsDomain.consumeOAuthState).not.toHaveBeenCalled();
    });

    it("rejects a correctly-issued service token with the wrong subject", async () => {
      const { app, mailboxConnectionsDomain } = createTestApp();
      const token = await brokerToken({ subject: "some-other-service" });
      const response = await postConsume(app, `Bearer ${token}`);
      expect(response.statusCode).toBe(403);
      expect(mailboxConnectionsDomain.consumeOAuthState).not.toHaveBeenCalled();
    });

    it("rejects the correct subject missing the required scope", async () => {
      const { app, mailboxConnectionsDomain } = createTestApp();
      const token = await brokerToken({ scopes: [] });
      const response = await postConsume(app, `Bearer ${token}`);
      expect(response.statusCode).toBe(403);
      expect(mailboxConnectionsDomain.consumeOAuthState).not.toHaveBeenCalled();
    });

    it("honors a configured mailboxBrokerServiceSubject override", async () => {
      const { app } = createTestApp({ CLERK_MAILBOX_BROKER_SUBJECT: "custom-broker-subject" });

      const rejected = await postConsume(app, `Bearer ${await brokerToken()}`);
      expect(rejected.statusCode).toBe(403);

      const accepted = await postConsume(
        app,
        `Bearer ${await brokerToken({ subject: "custom-broker-subject" })}`,
      );
      expect(accepted.statusCode).toBe(200);
    });
  });

  describe("internal connections/:connectionId/scheduled-scans (Task 3 fix round 1)", () => {
    async function workerToken(overrides: Partial<SignOptions> = {}): Promise<string> {
      return signToken({
        key: serviceKeys.privateKey,
        issuer: SERVICE_ISSUER,
        audience: SERVICE_AUDIENCE,
        subject: WORKER_SUBJECT,
        scopes: ["mailbox:discover"],
        tokenType: "service",
        ...overrides,
      });
    }

    it("is reachable with the worker's own validly-signed service principal", async () => {
      const { app, mailboxScansDomain } = createTestApp();
      const response = await postScheduledScan(app, `Bearer ${await workerToken()}`);
      expect(response.statusCode).toBe(200);
      expect(mailboxScansDomain.startScheduledScan).toHaveBeenCalledOnce();
    });

    it("rejects a request with no token", async () => {
      const { app } = createTestApp();
      expect((await postScheduledScan(app)).statusCode).toBe(401);
    });

    it("rejects a validly-signed tenant token (wrong issuer/audience/token type)", async () => {
      const { app, mailboxScansDomain } = createTestApp();
      const token = await signToken({ key: tenantKeys.privateKey });
      const response = await postScheduledScan(app, `Bearer ${token}`);
      expect(response.statusCode).toBe(401);
      expect(mailboxScansDomain.startScheduledScan).not.toHaveBeenCalled();
    });

    it("rejects a service token signed by the wrong issuer", async () => {
      const { app } = createTestApp();
      const token = await workerToken({ issuer: "https://attacker-issuer.test" });
      expect((await postScheduledScan(app, `Bearer ${token}`)).statusCode).toBe(401);
    });

    it("rejects a service token signed for the wrong audience", async () => {
      const { app } = createTestApp();
      const token = await workerToken({ audience: "some-other-audience" });
      expect((await postScheduledScan(app, `Bearer ${token}`)).statusCode).toBe(401);
    });

    it("rejects a service token signed by an attacker holding a different key", async () => {
      const { app, mailboxScansDomain } = createTestApp();
      const token = await signToken({
        key: attackerKeys.privateKey,
        issuer: SERVICE_ISSUER,
        audience: SERVICE_AUDIENCE,
        subject: WORKER_SUBJECT,
        scopes: ["mailbox:discover"],
        tokenType: "service",
      });
      expect((await postScheduledScan(app, `Bearer ${token}`)).statusCode).toBe(401);
      expect(mailboxScansDomain.startScheduledScan).not.toHaveBeenCalled();
    });

    it("rejects the broker's own correctly-issued token (wrong subject)", async () => {
      const { app, mailboxScansDomain } = createTestApp();
      const token = await workerToken({ subject: BROKER_SUBJECT, scopes: ["mailbox:write"] });
      const response = await postScheduledScan(app, `Bearer ${token}`);
      expect(response.statusCode).toBe(403);
      expect(mailboxScansDomain.startScheduledScan).not.toHaveBeenCalled();
    });

    it("rejects the correct subject missing the required scope", async () => {
      const { app, mailboxScansDomain } = createTestApp();
      const token = await workerToken({ scopes: [] });
      const response = await postScheduledScan(app, `Bearer ${token}`);
      expect(response.statusCode).toBe(403);
      expect(mailboxScansDomain.startScheduledScan).not.toHaveBeenCalled();
    });

    it("honors a configured mailboxWorkerServiceSubject override", async () => {
      const { app } = createTestApp({ CLERK_MAILBOX_WORKER_APP_SUBJECT: "custom-worker-subject" });

      const rejected = await postScheduledScan(app, `Bearer ${await workerToken()}`);
      expect(rejected.statusCode).toBe(403);

      const accepted = await postScheduledScan(
        app,
        `Bearer ${await workerToken({ subject: "custom-worker-subject" })}`,
      );
      expect(accepted.statusCode).toBe(200);
    });
  });

  describe("internal scan-runs/:scanRunId/finalize (Task 3 fix round 1)", () => {
    async function workerToken(overrides: Partial<SignOptions> = {}): Promise<string> {
      return signToken({
        key: serviceKeys.privateKey,
        issuer: SERVICE_ISSUER,
        audience: SERVICE_AUDIENCE,
        subject: WORKER_SUBJECT,
        scopes: ["mailbox:discover"],
        tokenType: "service",
        ...overrides,
      });
    }

    it("is reachable with the worker's own validly-signed service principal", async () => {
      const { app, mailboxScansDomain } = createTestApp();
      const response = await postFinalize(app, `Bearer ${await workerToken()}`);
      expect(response.statusCode).toBe(200);
      expect(mailboxScansDomain.finalizeScanRun).toHaveBeenCalledOnce();
    });

    it("rejects a request with no token", async () => {
      const { app } = createTestApp();
      expect((await postFinalize(app)).statusCode).toBe(401);
    });

    it("rejects a validly-signed tenant token (wrong issuer/audience/token type)", async () => {
      const { app, mailboxScansDomain } = createTestApp();
      const token = await signToken({ key: tenantKeys.privateKey });
      const response = await postFinalize(app, `Bearer ${token}`);
      expect(response.statusCode).toBe(401);
      expect(mailboxScansDomain.finalizeScanRun).not.toHaveBeenCalled();
    });

    it("rejects a service token signed by an attacker holding a different key", async () => {
      const { app, mailboxScansDomain } = createTestApp();
      const token = await signToken({
        key: attackerKeys.privateKey,
        issuer: SERVICE_ISSUER,
        audience: SERVICE_AUDIENCE,
        subject: WORKER_SUBJECT,
        scopes: ["mailbox:discover"],
        tokenType: "service",
      });
      expect((await postFinalize(app, `Bearer ${token}`)).statusCode).toBe(401);
      expect(mailboxScansDomain.finalizeScanRun).not.toHaveBeenCalled();
    });

    it("rejects the broker's own correctly-issued token (wrong subject)", async () => {
      const { app, mailboxScansDomain } = createTestApp();
      const token = await workerToken({ subject: BROKER_SUBJECT, scopes: ["mailbox:write"] });
      const response = await postFinalize(app, `Bearer ${token}`);
      expect(response.statusCode).toBe(403);
      expect(mailboxScansDomain.finalizeScanRun).not.toHaveBeenCalled();
    });

    it("rejects the correct subject missing the required scope", async () => {
      const { app, mailboxScansDomain } = createTestApp();
      const token = await workerToken({ scopes: [] });
      const response = await postFinalize(app, `Bearer ${token}`);
      expect(response.statusCode).toBe(403);
      expect(mailboxScansDomain.finalizeScanRun).not.toHaveBeenCalled();
    });
  });

  /**
   * Phase 3D-C Task 5 fix round 1 (review Important #1 + #4) -- the
   * three new mailbox-scoped job-callback routes (materialize-input/
   * status/result). Guarded by the worker's own service principal
   * (subject "workflow-worker-mailbox", scope "mailbox:materialize" --
   * distinct from scheduled-scans/finalize's "mailbox:discover" above),
   * same real-signed-fixture rejection matrix as every other describe
   * block in this file: no token, a validly-signed tenant token (wrong
   * issuer/audience/token type simultaneously), an attacker-signed
   * service token (wrong signature), the broker's own correctly-issued
   * token (wrong subject), and the correct subject missing the required
   * scope.
   */
  describe("internal mailbox/jobs/:jobId/{materialize-input,status,result} (Task 5 fix round 1)", () => {
    async function materializeWorkerToken(overrides: Partial<SignOptions> = {}): Promise<string> {
      return signToken({
        key: serviceKeys.privateKey,
        issuer: SERVICE_ISSUER,
        audience: SERVICE_AUDIENCE,
        subject: WORKER_SUBJECT,
        scopes: ["mailbox:materialize"],
        tokenType: "service",
        ...overrides,
      });
    }

    const routes: readonly {
      readonly name: string;
      readonly call: (app: ReturnType<typeof buildApp>, authorization?: string) => ReturnType<typeof getMaterializeInput>;
      readonly domainMethod: (domain: ProcessingJobsDomain) => ReturnType<typeof vi.fn>;
    }[] = [
      {
        name: "GET materialize-input",
        call: getMaterializeInput,
        domainMethod: (domain) => domain.getJob as ReturnType<typeof vi.fn>,
      },
      {
        name: "POST status",
        call: postMailboxJobStatus,
        domainMethod: (domain) => domain.recordStatusUpdate as ReturnType<typeof vi.fn>,
      },
      {
        name: "POST result",
        call: postMailboxJobResult,
        domainMethod: (domain) => domain.submitResult as ReturnType<typeof vi.fn>,
      },
    ];

    for (const route of routes) {
      describe(route.name, () => {
        it("is reachable with the worker's own validly-signed mailbox:materialize principal", async () => {
          const { app, processingJobsDomain } = createTestApp();
          const response = await route.call(app, `Bearer ${await materializeWorkerToken()}`);
          expect(response.statusCode).toBe(200);
          expect(route.domainMethod(processingJobsDomain)).toHaveBeenCalledOnce();
        });

        it("rejects a request with no token", async () => {
          const { app } = createTestApp();
          expect((await route.call(app)).statusCode).toBe(401);
        });

        it("rejects a validly-signed tenant token (wrong issuer/audience/token type)", async () => {
          const { app, processingJobsDomain } = createTestApp();
          const token = await signToken({ key: tenantKeys.privateKey });
          const response = await route.call(app, `Bearer ${token}`);
          expect(response.statusCode).toBe(401);
          expect(route.domainMethod(processingJobsDomain)).not.toHaveBeenCalled();
        });

        it("rejects a service token signed by an attacker holding a different key", async () => {
          const { app, processingJobsDomain } = createTestApp();
          const token = await signToken({
            key: attackerKeys.privateKey,
            issuer: SERVICE_ISSUER,
            audience: SERVICE_AUDIENCE,
            subject: WORKER_SUBJECT,
            scopes: ["mailbox:materialize"],
            tokenType: "service",
          });
          expect((await route.call(app, `Bearer ${token}`)).statusCode).toBe(401);
          expect(route.domainMethod(processingJobsDomain)).not.toHaveBeenCalled();
        });

        it("rejects the broker's own correctly-issued token (wrong subject)", async () => {
          const { app, processingJobsDomain } = createTestApp();
          const token = await materializeWorkerToken({ subject: BROKER_SUBJECT, scopes: ["mailbox:write"] });
          const response = await route.call(app, `Bearer ${token}`);
          expect(response.statusCode).toBe(403);
          expect(route.domainMethod(processingJobsDomain)).not.toHaveBeenCalled();
        });

        it("rejects the correct subject missing the required mailbox:materialize scope (e.g. mailbox:discover only)", async () => {
          const { app, processingJobsDomain } = createTestApp();
          const token = await materializeWorkerToken({ scopes: ["mailbox:discover"] });
          const response = await route.call(app, `Bearer ${token}`);
          expect(response.statusCode).toBe(403);
          expect(route.domainMethod(processingJobsDomain)).not.toHaveBeenCalled();
        });
      });
    }
  });
});
