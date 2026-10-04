import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppConfig } from "../src/config.js";
import type { EnrichmentJobsDomain } from "../src/domain/enrichment-jobs.js";
import type { ProcessingJobsDomain } from "../src/domain/processing-jobs.js";
import type { TemporalWorkflowStarter } from "../src/temporal/client.js";

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
  CLERK_APP_ENRICHMENT_INPUT_SCOPE: "jobs:enrichment-input",
  CLERK_APP_ENRICHMENT_RESULT_SCOPE: "jobs:enrichment-result",
  APP_DATABASE_URL: "postgresql://app-runtime.test/app",
};

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const TIMESTAMP = "2026-09-08T00:00:00.000Z";

const JOB = {
  id: JOB_ID,
  tenantId: TENANT_ID,
  personalProfileId: PROFILE_ID,
  businessId: null,
  workflowType: "FoundationEchoWorkflow",
  workflowId: `job-${JOB_ID}`,
  taskQueue: "expense-tax-processing",
  runId: null,
  status: "PENDING" as const,
  targetAggregateType: null,
  targetAggregateId: null,
  expectedAggregateVersion: null,
  inputParams: {},
  allowedResultSchemaVersion: "foundation-echo-v1",
  result: null,
  errorMessage: null,
  version: 1,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  dispatchedAt: null,
  completedAt: null,
};

function servicePrincipal(
  clientId: string,
  scopes: readonly string[],
  audience = "expense-app-internal",
): AuthPrincipal {
  return {
    tokenType: "service",
    subject: clientId === "ai-worker" ? "ai-worker-app-machine" : clientId,
    clientId,
    audience,
    issuer: "https://services.test",
    roles: [],
    scopes,
    tokenId: `${clientId}-token-id`,
    email: null,
    emailVerified: null,
    displayName: null,
  };
}

describe("App API job routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const processingJobsDomain: ProcessingJobsDomain = {
      createJob: vi.fn(async () => JOB),
      dispatchPendingJobs: vi.fn(async () => ({ dispatchedCount: 0 })),
      recordStatusUpdate: vi.fn(async () => ({
        statusCode: 200 as const,
        body: { ...JOB, status: "RUNNING" as const, version: 2 },
        replayed: false,
      })),
      submitResult: vi.fn(async () => ({
        statusCode: 200 as const,
        body: { ...JOB, status: "SUCCEEDED" as const, version: 3 },
        replayed: false,
      })),
      getJob: vi.fn(async () => JOB),
    };
    const enrichmentJobsDomain: EnrichmentJobsDomain = {
      getEnrichmentInput: vi.fn(async () => ({
        outcome: "evaluate" as const,
        input: {
          schemaVersion: 1 as const,
          jobId: JOB_ID,
          expenseId: "55555555-5555-4555-8555-555555555555",
          expenseVersion: 1,
          normalizedMerchant: "market",
          incurredOn: "2026-09-12",
          spendingCategoryId: null,
          rulesVersion: 1,
          eligibleTagKeys: [],
          eligibleSpendingCategoryIds: [],
          eligibleTaxSnapshot: null,
          history: {
            exampleCount: 0,
            candidateTagKeys: [],
            candidateSpendingCategoryIds: [],
            candidateTaxCategoryIds: [],
          },
        },
      })),
      submitEnrichmentResult: vi.fn(async () => ({
        statusCode: 200 as const,
        body: { ...JOB, status: "SUCCEEDED" as const, version: 3 },
        replayed: false,
      })),
    };
    const temporalStarter: TemporalWorkflowStarter = {
      start: vi.fn(async () => ({ runId: "fake-run-id" })),
      close: vi.fn(async () => undefined),
    };
    const serviceVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => {
        if (token === "platform-admin-token") {
          return servicePrincipal("platform-admin", ["jobs:manage"]);
        }
        if (token === "platform-admin-missing-scope-token") {
          return servicePrincipal("platform-admin", []);
        }
        if (token === "ai-worker-token") {
          return servicePrincipal("ai-worker", ["jobs:write"]);
        }
        if (token === "wrong-principal-token") {
          return servicePrincipal("ai-worker", ["jobs:manage"]);
        }
        if (token === "enrichment-input-token") {
          return servicePrincipal("ai-worker-app-machine", ["jobs:enrichment-input"]);
        }
        if (token === "enrichment-result-token") {
          return servicePrincipal("ai-worker-app-machine", ["jobs:enrichment-result"]);
        }
        if (token === "enrichment-write-only-token") {
          // jobs:write only — not sufficient for input or result routes
          return servicePrincipal("ai-worker-app-machine", ["jobs:write"]);
        }
        if (token === "enrichment-wrong-subject-token") {
          // wrong subject — input scope present but subject mismatch
          return servicePrincipal("wrong-subject", ["jobs:enrichment-input"]);
        }
        if (token === "enrichment-wrong-audience-token") {
          // Production Clerk verifier rejects tokens with wrong audience.
          // Simulate that by throwing — returns 401 before subject/scope guard.
          throw new Error("wrong audience");
        }
        throw new Error("wrong token");
      }),
    };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: {
        tenant: { verify: vi.fn(async () => { throw new Error("no tenant tokens in this test"); }) },
        service: serviceVerifier,
      },
      processingJobsDomain,
      enrichmentJobsDomain,
      temporalStarter,
    });
    apps.add(app);
    return { app, processingJobsDomain, enrichmentJobsDomain, temporalStarter };
  }

  it("creates a foundation-echo job for an admin service principal", async () => {
    const { app, processingJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/jobs/foundation-echo",
      headers: { authorization: "Bearer platform-admin-token" },
      payload: { tenantId: TENANT_ID, personalProfileId: PROFILE_ID },
    });

    expect(response.statusCode).toBe(201);
    expect(processingJobsDomain.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        scope: { personalProfileId: PROFILE_ID },
        workflowType: "FoundationEchoWorkflow",
        actorServicePrincipal: "platform-admin",
      }),
    );
    // Task 7 Stage A: the route must not supply a task queue itself --
    // createJobInTransaction derives it from the dispatch-routing row.
    expect(processingJobsDomain.createJob).toHaveBeenCalledWith(
      expect.not.objectContaining({ taskQueue: expect.anything() }),
    );
  });

  it("forbids a service token missing the jobs:manage scope from creating a job", async () => {
    const { app, processingJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/jobs/foundation-echo",
      headers: { authorization: "Bearer platform-admin-missing-scope-token" },
      payload: { tenantId: TENANT_ID, personalProfileId: PROFILE_ID },
    });

    expect(response.statusCode).toBe(403);
    expect(processingJobsDomain.createJob).not.toHaveBeenCalled();
  });

  it("rejects a foundation-echo request with neither Personal nor business scope", async () => {
    const { app, processingJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/jobs/foundation-echo",
      headers: { authorization: "Bearer platform-admin-token" },
      payload: { tenantId: TENANT_ID },
    });

    expect(response.statusCode).toBe(400);
    expect(processingJobsDomain.createJob).not.toHaveBeenCalled();
  });

  it("dispatches pending jobs only for the admin service principal", async () => {
    const { app, processingJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/jobs/dispatch",
      headers: { authorization: "Bearer platform-admin-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ dispatchedCount: 0 });
    expect(processingJobsDomain.dispatchPendingJobs).toHaveBeenCalledOnce();
  });

  it("allows the ai-worker service principal to record a status update", async () => {
    const { app, processingJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/status`,
      headers: { authorization: "Bearer ai-worker-token" },
      payload: {
        schemaVersion: 1,
        status: "RUNNING",
        idempotencyKey: "attempt-1",
        expectedJobVersion: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("RUNNING");
    expect(processingJobsDomain.recordStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        actorServicePrincipal: "ai-worker",
      }),
    );
  });

  it("forbids the platform-admin service principal (wrong scope shape) from recording a status update", async () => {
    const { app, processingJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/status`,
      headers: { authorization: "Bearer platform-admin-token" },
      payload: {
        schemaVersion: 1,
        status: "RUNNING",
        idempotencyKey: "attempt-1",
        expectedJobVersion: 1,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(processingJobsDomain.recordStatusUpdate).not.toHaveBeenCalled();
  });

  it("forbids an ai-worker token that only carries the jobs:manage scope from writing a status update", async () => {
    const { app, processingJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/status`,
      headers: { authorization: "Bearer wrong-principal-token" },
      payload: {
        schemaVersion: 1,
        status: "RUNNING",
        idempotencyKey: "attempt-1",
        expectedJobVersion: 1,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(processingJobsDomain.recordStatusUpdate).not.toHaveBeenCalled();
  });

  it("allows the ai-worker service principal to submit a result", async () => {
    const { app, processingJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/result`,
      headers: { authorization: "Bearer ai-worker-token" },
      payload: {
        schemaVersion: 1,
        status: "SUCCEEDED",
        idempotencyKey: "attempt-1",
        expectedJobVersion: 2,
        resultSchemaVersion: "foundation-echo-v1",
        result: { echo: JOB_ID },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("SUCCEEDED");
    expect(processingJobsDomain.submitResult).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB_ID, actorServicePrincipal: "ai-worker" }),
    );
  });

  it("reads a job for the admin service principal", async () => {
    const { app, processingJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/jobs/${JOB_ID}`,
      headers: { authorization: "Bearer platform-admin-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe(JOB_ID);
    expect(processingJobsDomain.getJob).toHaveBeenCalledWith(JOB_ID);
  });

  // ---- enrichment input route ----

  it("serves enrichment input to the worker with exact subject + jobs:enrichment-input scope", async () => {
    const { app, enrichmentJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/jobs/${JOB_ID}/enrichment-input`,
      headers: { authorization: "Bearer enrichment-input-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe("evaluate");
    expect(enrichmentJobsDomain.getEnrichmentInput).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB_ID }),
    );
  });

  it("forbids enrichment input with jobs:write only (wrong scope)", async () => {
    const { app, enrichmentJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/jobs/${JOB_ID}/enrichment-input`,
      headers: { authorization: "Bearer enrichment-write-only-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(enrichmentJobsDomain.getEnrichmentInput).not.toHaveBeenCalled();
  });

  it("forbids enrichment input with wrong subject (even if scope present)", async () => {
    const { app, enrichmentJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/jobs/${JOB_ID}/enrichment-input`,
      headers: { authorization: "Bearer enrichment-wrong-subject-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(enrichmentJobsDomain.getEnrichmentInput).not.toHaveBeenCalled();
  });

  it("forbids enrichment input with result scope (wrong scope for this route)", async () => {
    const { app, enrichmentJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/jobs/${JOB_ID}/enrichment-input`,
      headers: { authorization: "Bearer enrichment-result-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(enrichmentJobsDomain.getEnrichmentInput).not.toHaveBeenCalled();
  });

  // ---- enrichment result route ----

  it("accepts enrichment result from the worker with exact subject + jobs:enrichment-result scope", async () => {
    const { app, enrichmentJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/enrichment-result`,
      headers: { authorization: "Bearer enrichment-result-token" },
      payload: {
        schemaVersion: 1,
        idempotencyKey: "result-attempt-1",
        expectedJobVersion: 2,
        result: {
          schemaVersion: 1,
          rulesVersion: 1,
          outcome: "stale",
          ruleTagKeys: [],
          suggestions: [],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(enrichmentJobsDomain.submitEnrichmentResult).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB_ID }),
    );
  });

  it("forbids enrichment result with jobs:write only (wrong scope)", async () => {
    const { app, enrichmentJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/enrichment-result`,
      headers: { authorization: "Bearer enrichment-write-only-token" },
      payload: {
        schemaVersion: 1,
        idempotencyKey: "result-attempt-1",
        expectedJobVersion: 2,
        result: {
          schemaVersion: 1,
          rulesVersion: 1,
          outcome: "stale",
          ruleTagKeys: [],
          suggestions: [],
        },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(enrichmentJobsDomain.submitEnrichmentResult).not.toHaveBeenCalled();
  });

  it("forbids enrichment result with input scope (wrong scope for this route)", async () => {
    const { app, enrichmentJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/enrichment-result`,
      headers: { authorization: "Bearer enrichment-input-token" },
      payload: {
        schemaVersion: 1,
        idempotencyKey: "result-attempt-1",
        expectedJobVersion: 2,
        result: {
          schemaVersion: 1,
          rulesVersion: 1,
          outcome: "stale",
          ruleTagKeys: [],
          suggestions: [],
        },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(enrichmentJobsDomain.submitEnrichmentResult).not.toHaveBeenCalled();
  });

  it("existing OCR jobs:write guard still requires jobs:write (not enrichment scopes)", async () => {
    const { app, processingJobsDomain } = createTestApp();
    // ai-worker-token has jobs:write and subject ai-worker-app-machine
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/status`,
      headers: { authorization: "Bearer ai-worker-token" },
      payload: {
        schemaVersion: 1,
        status: "RUNNING",
        idempotencyKey: "attempt-1",
        expectedJobVersion: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(processingJobsDomain.recordStatusUpdate).toHaveBeenCalled();
  });

  // ---- I3: audience tests for enrichment routes ----

  it("I3: forbids enrichment input when token has wrong audience (foundry audience → 401 from verifier)", async () => {
    const { app, enrichmentJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/jobs/${JOB_ID}/enrichment-input`,
      headers: { authorization: "Bearer enrichment-wrong-audience-token" },
    });

    // Production Clerk verifier rejects tokens with wrong audience at verification time.
    // Mock throws → verifyRequest returns 401.
    expect(response.statusCode).toBe(401);
    expect(enrichmentJobsDomain.getEnrichmentInput).not.toHaveBeenCalled();
  });

  it("I3: forbids enrichment input token on enrichment-result route (cross-scope denial)", async () => {
    const { app, enrichmentJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/enrichment-result`,
      headers: { authorization: "Bearer enrichment-input-token" },
      payload: {
        schemaVersion: 1,
        idempotencyKey: "k-cross",
        expectedJobVersion: 3,
        result: {
          schemaVersion: 1,
          rulesVersion: 1,
          outcome: "stale",
          ruleTagKeys: [],
          suggestions: [],
        },
      },
    });

    // enrichment-input token only has jobs:enrichment-input, not jobs:enrichment-result
    expect(response.statusCode).toBe(403);
    expect(enrichmentJobsDomain.submitEnrichmentResult).not.toHaveBeenCalled();
  });

  // ---- I2: Schema proof — both enrichment routes register and parse cleanly ----

  it("I2: enrichment input route returns 200 with outcome field present in response", async () => {
    const { app } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/jobs/${JOB_ID}/enrichment-input`,
      headers: { authorization: "Bearer enrichment-input-token" },
    });

    expect(response.statusCode).toBe(200);
    // Response must contain schemaVersion and outcome at minimum
    const body = response.json() as Record<string, unknown>;
    expect(body.outcome).toBe("evaluate");
  });

  it("I2: enrichment result route validates body schema strictly (rejects missing idempotencyKey)", async () => {
    const { app, enrichmentJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/enrichment-result`,
      headers: { authorization: "Bearer enrichment-result-token" },
      payload: {
        // Missing idempotencyKey — schema must reject
        schemaVersion: 1,
        expectedJobVersion: 2,
        result: {
          schemaVersion: 1,
          rulesVersion: 1,
          outcome: "stale",
          ruleTagKeys: [],
          suggestions: [],
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(enrichmentJobsDomain.submitEnrichmentResult).not.toHaveBeenCalled();
  });

  it("I2: enrichment result route validates schemaVersion literal 1 (rejects 2)", async () => {
    const { app, enrichmentJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/enrichment-result`,
      headers: { authorization: "Bearer enrichment-result-token" },
      payload: {
        schemaVersion: 2, // Must be 1
        idempotencyKey: "k1",
        expectedJobVersion: 2,
        result: {
          schemaVersion: 1,
          rulesVersion: 1,
          outcome: "stale",
          ruleTagKeys: [],
          suggestions: [],
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(enrichmentJobsDomain.submitEnrichmentResult).not.toHaveBeenCalled();
  });

  // ---- R2-1: strict result.result schema — validates nested fields at HTTP layer ----

  it("R2-1: rejects result body where result.schemaVersion is missing (HTTP schema, not just domain)", async () => {
    const { app, enrichmentJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/enrichment-result`,
      headers: { authorization: "Bearer enrichment-result-token" },
      payload: {
        schemaVersion: 1,
        idempotencyKey: "k-no-schema",
        expectedJobVersion: 2,
        result: {
          // Missing schemaVersion — HTTP layer must reject this
          rulesVersion: 1,
          outcome: "stale",
          ruleTagKeys: [],
          suggestions: [],
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(enrichmentJobsDomain.submitEnrichmentResult).not.toHaveBeenCalled();
  });

  it("R2-1: rejects result body where result.rulesVersion is missing (HTTP schema)", async () => {
    const { app, enrichmentJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/enrichment-result`,
      headers: { authorization: "Bearer enrichment-result-token" },
      payload: {
        schemaVersion: 1,
        idempotencyKey: "k-no-rules",
        expectedJobVersion: 2,
        result: {
          schemaVersion: 1,
          // Missing rulesVersion — HTTP layer must reject
          outcome: "stale",
          ruleTagKeys: [],
          suggestions: [],
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(enrichmentJobsDomain.submitEnrichmentResult).not.toHaveBeenCalled();
  });

  it("R2-1: rejects result body where result.outcome is invalid enum (HTTP schema)", async () => {
    const { app, enrichmentJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/enrichment-result`,
      headers: { authorization: "Bearer enrichment-result-token" },
      payload: {
        schemaVersion: 1,
        idempotencyKey: "k-bad-outcome",
        expectedJobVersion: 2,
        result: {
          schemaVersion: 1,
          rulesVersion: 1,
          outcome: "unknown-value", // Not in enum — HTTP layer must reject
          ruleTagKeys: [],
          suggestions: [],
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(enrichmentJobsDomain.submitEnrichmentResult).not.toHaveBeenCalled();
  });

  it("R2-1: rejects result body where result.ruleTagKeys is not an array (HTTP schema)", async () => {
    const { app, enrichmentJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/enrichment-result`,
      headers: { authorization: "Bearer enrichment-result-token" },
      payload: {
        schemaVersion: 1,
        idempotencyKey: "k-bad-tags",
        expectedJobVersion: 2,
        result: {
          schemaVersion: 1,
          rulesVersion: 1,
          outcome: "applied",
          ruleTagKeys: "not-an-array", // Must be array — HTTP layer must reject
          suggestions: [],
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(enrichmentJobsDomain.submitEnrichmentResult).not.toHaveBeenCalled();
  });

  it("R2-1: enrichment input response includes eligibleTaxSnapshot as typed object or null (not opaque)", async () => {
    const { app } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/jobs/${JOB_ID}/enrichment-input`,
      headers: { authorization: "Bearer enrichment-input-token" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.outcome).toBe("evaluate");
    // eligibleTaxSnapshot must be present as a typed field (not undefined/missing)
    const input = body.input as Record<string, unknown>;
    expect("eligibleTaxSnapshot" in input).toBe(true);
    // history must be a typed object with required fields
    const history = input.history as Record<string, unknown>;
    expect(typeof history.exampleCount).toBe("number");
    expect(Array.isArray(history.candidateTagKeys)).toBe(true);
  });

  // ---- R3-2: strict schema rejects unknown fields at HTTP route layer ----

  it("R3-2: enrichment result route rejects submit body with unknown top-level field", async () => {
    const { app, enrichmentJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/enrichment-result`,
      headers: { authorization: "Bearer enrichment-result-token" },
      payload: {
        schemaVersion: 1,
        idempotencyKey: "k-unknown",
        expectedJobVersion: 2,
        result: {
          schemaVersion: 1,
          rulesVersion: 1,
          outcome: "stale",
          ruleTagKeys: [],
          suggestions: [],
        },
        unknownTopLevelField: "should be rejected",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(enrichmentJobsDomain.submitEnrichmentResult).not.toHaveBeenCalled();
  });

  it("R3-2: enrichment result route rejects result with unknown field inside result object", async () => {
    const { app, enrichmentJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/enrichment-result`,
      headers: { authorization: "Bearer enrichment-result-token" },
      payload: {
        schemaVersion: 1,
        idempotencyKey: "k-result-unknown",
        expectedJobVersion: 2,
        result: {
          schemaVersion: 1,
          rulesVersion: 1,
          outcome: "stale",
          ruleTagKeys: [],
          suggestions: [],
          surpriseField: "not allowed",
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(enrichmentJobsDomain.submitEnrichmentResult).not.toHaveBeenCalled();
  });

  // ---- R3-3: evidenceHash must be canonical lowercase hex SHA-256 ----

  it("R3-3: enrichment result route rejects uppercase evidenceHash (not canonical hex)", async () => {
    const { app, enrichmentJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/jobs/${JOB_ID}/enrichment-result`,
      headers: { authorization: "Bearer enrichment-result-token" },
      payload: {
        schemaVersion: 1,
        idempotencyKey: "k-bad-hash",
        expectedJobVersion: 2,
        result: {
          schemaVersion: 1,
          rulesVersion: 1,
          outcome: "applied",
          ruleTagKeys: [],
          suggestions: [
            {
              kind: "tag",
              source: "historical",
              tagKey: "merchant:test",
              confidence: 0.9,
              evidenceHash: "A".repeat(64), // uppercase — must be rejected
              aggregateCounts: { exampleCount: 3, matchCount: 3 },
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(enrichmentJobsDomain.submitEnrichmentResult).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------ //
  // Phase 3D-C Task 5 gap closure -- read-only materialize-input resolver
  // for MailboxMaterializeWorkflow's combined activity.
  // ------------------------------------------------------------------ //

  it("materialize-input returns the candidateId from the job's own input_params for the worker principal", async () => {
    const { app, processingJobsDomain } = createTestApp();
    (processingJobsDomain.getJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...JOB,
      workflowType: "MailboxMaterializeWorkflow",
      inputParams: { mailboxCandidateId: "66666666-6666-4666-8666-666666666666" },
    });

    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/jobs/${JOB_ID}/materialize-input`,
      headers: { authorization: "Bearer ai-worker-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ candidateId: "66666666-6666-4666-8666-666666666666" });
    expect(processingJobsDomain.getJob).toHaveBeenCalledWith(JOB_ID);
  });

  it("materialize-input rejects a job whose input_params carries no candidateId", async () => {
    const { app } = createTestApp();

    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/jobs/${JOB_ID}/materialize-input`,
      headers: { authorization: "Bearer ai-worker-token" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("materialize-input rejects the platform-admin principal (wrong scope)", async () => {
    const { app } = createTestApp();

    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/jobs/${JOB_ID}/materialize-input`,
      headers: { authorization: "Bearer platform-admin-token" },
    });

    expect(response.statusCode).toBe(403);
  });
});
