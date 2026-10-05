import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppConfig } from "../src/config.js";
import type { OcrJobsDomain } from "../src/domain/ocr.js";

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
  LOCAL_STORAGE_DIR: "/tmp/expense-tax-ocr-test",
  STORAGE_LOCAL_BASE_URL: "http://127.0.0.1:8100",
  STORAGE_URL_SIGNING_KEY: "test-signing-key-not-secret",
};

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const FILE_ID = "44444444-4444-4444-8444-444444444444";
const TIMESTAMP = "2026-09-08T00:00:00.000Z";
const ACTOR_USER_ID = "55555555-5555-4555-8555-555555555555";

const JOB = {
  id: JOB_ID,
  tenantId: TENANT_ID,
  personalProfileId: PROFILE_ID,
  businessId: null,
  workflowType: "OcrReceiptWorkflow",
  workflowId: `job-${JOB_ID}`,
  taskQueue: "expense-tax-processing",
  runId: "run-1",
  status: "DISPATCHED" as const,
  targetAggregateType: "expense",
  targetAggregateId: null,
  expectedAggregateVersion: null,
  inputParams: { modeKey: "ocr_mode_balanced" },
  allowedResultSchemaVersion: "ocr-extraction-v1",
  result: null,
  errorMessage: null,
  version: 2,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  dispatchedAt: TIMESTAMP,
  completedAt: null,
};

function tenantPrincipal(): AuthPrincipal {
  return {
    tokenType: "tenant",
    subject: "identity-subject",
    clientId: null,
    audience: "expense-app",
    issuer: "https://identity.test",
    roles: [],
    scopes: [],
    tokenId: "tenant-token-id",
    email: "owner@example.test",
    emailVerified: true,
    displayName: "Owner",
  };
}

function servicePrincipal(
  clientId: string,
  scopes: readonly string[],
): AuthPrincipal {
  return {
    tokenType: "service",
    subject: clientId === "ai-worker" ? "ai-worker-app-machine" : clientId,
    clientId,
    audience: "expense-app-internal",
    issuer: "https://services.test",
    roles: [],
    scopes,
    tokenId: `${clientId}-token-id`,
    email: null,
    emailVerified: null,
    displayName: null,
  };
}

describe("App API OCR routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const ocrJobsDomain: OcrJobsDomain = {
      createOcrJob: vi.fn(async () => ({
        statusCode: 201 as const,
        body: JOB,
        replayed: false,
      })),
      listOcrJobs: vi.fn(async () => ({ items: [JOB] })),
      getOcrInput: vi.fn(async () => ({
        schemaVersion: 1 as const,
        fileId: FILE_ID,
        modeKey: "ocr_mode_balanced" as const,
        expectedSha256: null,
        tenantId: TENANT_ID,
      })),
    };
    const resolve = vi.fn(async () => ({
      id: ACTOR_USER_ID,
      primaryEmail: "owner@example.test",
      displayName: "Owner",
      status: "active" as const,
    }));
    const tenantVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => {
        if (token !== "tenant-token") throw new Error("wrong token");
        return tenantPrincipal();
      }),
    };
    const serviceVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => {
        if (token === "ai-worker-token") {
          return servicePrincipal("ai-worker", ["jobs:write"]);
        }
        if (token === "wrong-scope-token") {
          return servicePrincipal("ai-worker", ["reservations:write"]);
        }
        throw new Error("wrong token");
      }),
    };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: { tenant: tenantVerifier, service: serviceVerifier },
      identityDomain: { provision: vi.fn(), resolve },
      ocrJobsDomain,
    });
    apps.add(app);
    return { app, ocrJobsDomain };
  }

  const collection = `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}/files/${FILE_ID}`;

  it("creates an OCR job for an authenticated tenant user", async () => {
    const { app, ocrJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `${collection}/ocr-jobs`,
      headers: {
        authorization: "Bearer tenant-token",
        "idempotency-key": "ocr-1",
      },
      payload: { modeKey: "ocr_mode_balanced" },
    });

    expect(response.statusCode).toBe(201);
    expect(ocrJobsDomain.createOcrJob).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: ACTOR_USER_ID,
        tenantId: TENANT_ID,
        scope: { kind: "personal", profileId: PROFILE_ID },
        fileId: FILE_ID,
        modeKey: "ocr_mode_balanced",
        idempotencyKey: "ocr-1",
      }),
    );
  });

  it("rejects an unknown mode key before touching the domain", async () => {
    const { app, ocrJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `${collection}/ocr-jobs`,
      headers: {
        authorization: "Bearer tenant-token",
        "idempotency-key": "ocr-1",
      },
      payload: { modeKey: "ocr_mode_turbo" },
    });

    expect(response.statusCode).toBe(400);
    expect(ocrJobsDomain.createOcrJob).not.toHaveBeenCalled();
  });

  it("lists OCR jobs for a file", async () => {
    const { app, ocrJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `${collection}/ocr-jobs`,
      headers: { authorization: "Bearer tenant-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(ocrJobsDomain.listOcrJobs).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: FILE_ID }),
    );
  });

  it("serves job-bound OCR input to the worker principal", async () => {
    const { app, ocrJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/jobs/${JOB_ID}/ocr-input`,
      headers: { authorization: "Bearer ai-worker-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      fileId: FILE_ID,
      modeKey: "ocr_mode_balanced",
      tenantId: TENANT_ID,
    });
    expect(ocrJobsDomain.getOcrInput).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        actorServicePrincipal: "ai-worker",
      }),
    );
  });

  it("forbids a worker token without the jobs:write scope from reading OCR input", async () => {
    const { app, ocrJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/jobs/${JOB_ID}/ocr-input`,
      headers: { authorization: "Bearer wrong-scope-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(ocrJobsDomain.getOcrInput).not.toHaveBeenCalled();
  });

  it("rejects tenant tokens on the OCR input route", async () => {
    const { app, ocrJobsDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/jobs/${JOB_ID}/ocr-input`,
      headers: { authorization: "Bearer tenant-token" },
    });

    expect(response.statusCode).toBe(401);
    expect(ocrJobsDomain.getOcrInput).not.toHaveBeenCalled();
  });
});
