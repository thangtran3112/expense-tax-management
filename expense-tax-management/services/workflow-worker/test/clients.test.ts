import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { WorkerConfig } from "../src/config.js";
import {
  MachineTokenError,
  createMachineTokenProvider,
} from "../src/auth/machine-token.js";
import {
  AppApiClientError,
  createAppApiClient,
} from "../src/clients/app-api.js";
import {
  FoundryClientError,
  createFoundryClient,
} from "../src/clients/foundry.js";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const FILE_ID = "44444444-4444-4444-8444-444444444444";
const MODEL_ID = "55555555-5555-4555-8555-555555555555";
const MODE_ID = "66666666-6666-4666-8666-666666666666";
const ROUTE_ID = "77777777-7777-4777-8777-777777777777";
const RESERVATION_ID = "88888888-8888-4888-8888-888888888888";
const TIMESTAMP = "2026-09-20T00:00:00.000Z";

const config: WorkerConfig = {
  temporal: {
    address: "temporal:7233",
    namespace: "expense-tax",
    taskQueue: "expense-tax-processing",
  },
  services: {
    appApiBaseUrl: "http://app-api:8100",
    foundryBaseUrl: "http://foundry-service:8200",
    mailboxBrokerBaseUrl: "http://mailbox-broker:8300",
  },
  clerk: {
    issuerUrl: "https://clerk.test",
    jwksUrl: "https://clerk.test/.well-known/jwks.json",
    app: {
      audience: "mch_appAudience",
      machineSecretKey: "ak_test_app_secret",
      subject: "mch_app",
    },
    foundry: {
      audience: "mch_foundryAudience",
      machineSecretKey: "ak_test_foundry_secret",
      subject: "mch_foundry",
    },
    mailboxApp: {
      audience: "mch_appAudience",
      machineSecretKey: "ak_test_mailbox_secret",
      subject: "workflow-worker-mailbox",
    },
    mailboxBroker: {
      audience: "mch_mailboxAudience",
      machineSecretKey: "ak_test_mailbox_secret",
      subject: "workflow-worker-mailbox",
    },
  },
};

const processingJob = {
  id: JOB_ID,
  tenantId: TENANT_ID,
  personalProfileId: PROFILE_ID,
  businessId: null,
  workflowType: "OcrReceiptWorkflow",
  workflowId: `job-${JOB_ID}`,
  taskQueue: "expense-tax-processing",
  runId: null,
  status: "RUNNING",
  targetAggregateType: "expense",
  targetAggregateId: null,
  expectedAggregateVersion: null,
  inputParams: {},
  allowedResultSchemaVersion: "ocr-extraction-v1",
  result: null,
  errorMessage: null,
  version: 3,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  dispatchedAt: TIMESTAMP,
  completedAt: null,
} as const;

const effectiveRoute = {
  aiModeId: MODE_ID,
  routeVersionId: ROUTE_ID,
  routeVersionNumber: 1,
  aiModelId: MODEL_ID,
  providerKind: "fake",
  providerModelId: "fake-ocr-v1",
} as const;

const reservation = {
  id: RESERVATION_ID,
  tenantId: TENANT_ID,
  operation: "RECEIPT_OCR",
  aiModelId: MODEL_ID,
  idempotencyKey: "reserve-1",
  status: "RESERVED",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  callStartedAt: null,
  resolvedAt: null,
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let signingKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let keyResolver: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const keyPair = await generateKeyPair("RS256", { extractable: true });
  signingKey = keyPair.privateKey;
  const publicJwk = await exportJWK(keyPair.publicKey);
  keyResolver = createLocalJWKSet({
    keys: [{ ...publicJwk, alg: "RS256", kid: "test-key", use: "sig" }],
  });
});

function signedJwt(
  payload: Record<string, unknown>,
  key = signingKey,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "JWT" })
    .sign(key);
}

function unsignedJwt(
  payload: Record<string, unknown>,
  algorithm: string,
): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: algorithm, typ: "JWT" })}.${encode(payload)}.signature`;
}

function validClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: config.clerk.issuerUrl,
    aud: [config.clerk.app.audience],
    sub: config.clerk.app.subject,
    scope: "jobs:write files:read",
    jti: "token-id",
    nbf: 990,
    exp: 1_300,
    ...overrides,
  };
}

function appTokenProviders() {
  return {
    jobs: vi.fn().mockResolvedValue("jobs-token"),
    enrichmentInput: vi.fn().mockResolvedValue("input-token"),
    enrichmentResult: vi.fn().mockResolvedValue("result-token"),
  };
}

describe("machine token provider", () => {
  it("mints and caches a token with exact identity and scopes", async () => {
    const token = await signedJwt(validClaims());
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ token }));
    const getToken = createMachineTokenProvider(
      {
        issuerUrl: config.clerk.issuerUrl,
        jwksUrl: config.clerk.jwksUrl,
        credentials: config.clerk.app,
        scopes: ["jobs:write", "files:read"],
      },
      {
        fetch: fetchMock,
        keyResolver,
        nowSeconds: () => 1_000,
        timeoutMs: 50,
      },
    );

    await expect(getToken()).resolves.toBe(token);
    await expect(getToken()).resolves.toBe(token);
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.clerk.com/v1/m2m_tokens");
    expect(init.headers).toEqual({
      authorization: "Bearer ak_test_app_secret",
      "content-type": "application/json",
    });
    expect(init.redirect).toBe("error");
    expect(JSON.parse(String(init.body))).toEqual({
      token_format: "jwt",
      seconds_until_expiration: 300,
      claims: { scope: "jobs:write files:read" },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("accepts Clerk M2M responses without a not-before claim", async () => {
    const token = await signedJwt(
      validClaims({
        nbf: undefined,
        iat: 900,
        scopes: ["jobs:write", "files:read"],
      }),
    );
    const getToken = createMachineTokenProvider(
      {
        issuerUrl: config.clerk.issuerUrl,
        jwksUrl: config.clerk.jwksUrl,
        credentials: config.clerk.app,
        scopes: ["jobs:write", "files:read"],
      },
      {
        fetch: vi.fn().mockResolvedValue(
          jsonResponse(
            {
              object: "m2m_token",
              id: "m2m_123",
              subject: config.clerk.app.subject,
              scopes: [],
              claims: { scope: "jobs:write files:read" },
              secret: "provider-machine-secret",
              token,
              created_at: 900,
              updated_at: 900,
              last_used_at: null,
              expiration: 1_300,
              expired: false,
              revoked: false,
              revocation_reason: null,
            },
            201,
          ),
        ),
        keyResolver,
        nowSeconds: () => 1_000,
      },
    );

    await expect(getToken()).resolves.toBe(token);
  });

  it.each([
    ["issuer", { iss: "https://wrong.test" }],
    ["audience", { aud: ["mch_wrong"] }],
    ["subject", { sub: "mch_wrong" }],
    ["missing scope", { scope: "jobs:write" }],
    ["extra scope", { scope: "jobs:write files:read admin" }],
    ["duplicate scope", { scope: "jobs:write files:read files:read" }],
    ["missing expiry", { exp: undefined }],
    ["expired token", { exp: 999 }],
    ["future not-before", { nbf: 1_031 }],
    ["missing token ID", { jti: undefined }],
  ] as const)("rejects a token with wrong %s", async (_label, override) => {
    const token = await signedJwt(validClaims(override));
    const getToken = createMachineTokenProvider(
      {
        issuerUrl: config.clerk.issuerUrl,
        jwksUrl: config.clerk.jwksUrl,
        credentials: config.clerk.app,
        scopes: ["jobs:write", "files:read"],
      },
      {
        fetch: vi.fn().mockResolvedValue(jsonResponse({ token })),
        keyResolver,
        nowSeconds: () => 1_000,
      },
    );

    await expect(getToken()).rejects.toMatchObject<MachineTokenError>({
      code: "invalid_token",
    });
  });

  it("accepts an exact string audience", async () => {
    const token = await signedJwt(
      validClaims({ aud: config.clerk.app.audience }),
    );
    const getToken = createMachineTokenProvider(
      {
        issuerUrl: config.clerk.issuerUrl,
        jwksUrl: config.clerk.jwksUrl,
        credentials: config.clerk.app,
        scopes: ["jobs:write", "files:read"],
      },
      {
        fetch: vi.fn().mockResolvedValue(jsonResponse({ token })),
        keyResolver,
        nowSeconds: () => 1_000,
      },
    );

    await expect(getToken()).resolves.toBe(token);
  });

  it("rejects a token signed by an untrusted key", async () => {
    const attacker = await generateKeyPair("RS256");
    const token = await signedJwt(validClaims(), attacker.privateKey);
    const getToken = createMachineTokenProvider(
      {
        issuerUrl: config.clerk.issuerUrl,
        jwksUrl: config.clerk.jwksUrl,
        credentials: config.clerk.app,
        scopes: ["jobs:write", "files:read"],
      },
      {
        fetch: vi.fn().mockResolvedValue(jsonResponse({ token })),
        keyResolver,
        nowSeconds: () => 1_000,
      },
    );

    await expect(getToken()).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("rejects a token using a non-RS256 algorithm", async () => {
    const token = unsignedJwt(validClaims(), "HS256");
    const getToken = createMachineTokenProvider(
      {
        issuerUrl: config.clerk.issuerUrl,
        jwksUrl: config.clerk.jwksUrl,
        credentials: config.clerk.app,
        scopes: ["jobs:write", "files:read"],
      },
      {
        fetch: vi.fn().mockResolvedValue(jsonResponse({ token })),
        keyResolver,
        nowSeconds: () => 1_000,
      },
    );

    await expect(getToken()).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("single-flights concurrent token refresh", async () => {
    const token = await signedJwt(validClaims());
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ token }));
    const getToken = createMachineTokenProvider(
      {
        issuerUrl: config.clerk.issuerUrl,
        jwksUrl: config.clerk.jwksUrl,
        credentials: config.clerk.app,
        scopes: ["jobs:write", "files:read"],
      },
      { fetch: fetchMock, keyResolver, nowSeconds: () => 1_000 },
    );

    await expect(
      Promise.all([getToken(), getToken(), getToken()]),
    ).resolves.toEqual([token, token, token]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("times out token acquisition", async () => {
    const pendingFetch = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("secret-value", "AbortError")),
        );
      }),
    );
    const getToken = createMachineTokenProvider(
      {
        issuerUrl: config.clerk.issuerUrl,
        jwksUrl: config.clerk.jwksUrl,
        credentials: config.clerk.app,
        scopes: ["jobs:write"],
      },
      { fetch: pendingFetch, keyResolver, timeoutMs: 5 },
    );

    await expect(getToken()).rejects.toMatchObject({ code: "timeout" });
  });

  it("preserves timeout errors while reading token responses", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const response = {
      body: { cancel },
      json: vi.fn(() => new Promise(() => {})),
      ok: true,
    } as unknown as Response;
    const getToken = createMachineTokenProvider(
      {
        issuerUrl: config.clerk.issuerUrl,
        jwksUrl: config.clerk.jwksUrl,
        credentials: config.clerk.app,
        scopes: ["jobs:write"],
      },
      {
        fetch: vi.fn().mockResolvedValue(response),
        keyResolver,
        timeoutMs: 5,
      },
    );

    await expect(getToken()).rejects.toMatchObject({ code: "timeout" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels JWKS fetches at the shared acquisition deadline", async () => {
    const token = await signedJwt(validClaims());
    const jwksFetch = vi.fn((_url: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("jwks-secret", "AbortError")),
        );
      }),
    );
    const getToken = createMachineTokenProvider(
      {
        issuerUrl: config.clerk.issuerUrl,
        jwksUrl: config.clerk.jwksUrl,
        credentials: config.clerk.app,
        scopes: ["jobs:write", "files:read"],
      },
      {
        fetch: vi.fn().mockResolvedValue(jsonResponse({ token })),
        jwksFetch,
        nowSeconds: () => 1_000,
        timeoutMs: 5,
      },
    );

    await expect(getToken()).rejects.toMatchObject({ code: "timeout" });
    expect(jwksFetch).toHaveBeenCalledOnce();
  });

  it("classifies JWKS outages as acquisition failures", async () => {
    const token = await signedJwt(validClaims());
    const getToken = createMachineTokenProvider(
      {
        issuerUrl: config.clerk.issuerUrl,
        jwksUrl: config.clerk.jwksUrl,
        credentials: config.clerk.app,
        scopes: ["jobs:write", "files:read"],
      },
      {
        fetch: vi.fn().mockResolvedValue(jsonResponse({ token })),
        keyResolver: vi.fn().mockRejectedValue(new TypeError("network-secret")),
        nowSeconds: () => 1_000,
      },
    );

    await expect(getToken()).rejects.toMatchObject({
      code: "acquisition_failed",
    });
  });

  it("redacts credential and provider response failures", async () => {
    const providerBody = "provider-secret-body";
    const getToken = createMachineTokenProvider(
      {
        issuerUrl: config.clerk.issuerUrl,
        jwksUrl: config.clerk.jwksUrl,
        credentials: config.clerk.app,
        scopes: ["jobs:write"],
      },
      {
        fetch: vi
          .fn()
          .mockResolvedValue(new Response(providerBody, { status: 401 })),
      },
    );

    const error = await getToken().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "authentication_failed" });
    expect(String(error)).not.toContain(config.clerk.app.machineSecretKey);
    expect(String(error)).not.toContain(providerBody);
  });
});

describe("App API client", () => {
  it("sends validated status updates with the jobs token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(processingJob));
    const tokenProviders = appTokenProviders();
    const client = createAppApiClient(config, {
      fetch: fetchMock,
      tokenProviders,
    });

    await expect(
      client.updateStatus(JOB_ID, {
        schemaVersion: 1,
        status: "RUNNING",
        expectedJobVersion: 2,
        idempotencyKey: "status-1",
      }),
    ).resolves.toEqual(processingJob);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`http://app-api:8100/internal/v1/jobs/${JOB_ID}/status`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      authorization: "Bearer jobs-token",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      schemaVersion: 1,
      status: "RUNNING",
      expectedJobVersion: 2,
      idempotencyKey: "status-1",
    });
    expect(tokenProviders.jobs).toHaveBeenCalledOnce();
    expect(tokenProviders.enrichmentInput).not.toHaveBeenCalled();
    expect(tokenProviders.enrichmentResult).not.toHaveBeenCalled();
  });

  it("uses isolated enrichment tokens and validates responses", async () => {
    const input = { outcome: "skipped" } as const;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(input))
      .mockResolvedValueOnce(jsonResponse(processingJob));
    const tokenProviders = appTokenProviders();
    const client = createAppApiClient(config, {
      fetch: fetchMock,
      tokenProviders,
    });

    await expect(client.getEnrichmentInput(JOB_ID)).resolves.toEqual(input);
    await expect(
      client.submitEnrichmentResult(JOB_ID, {
        schemaVersion: 1,
        expectedJobVersion: 3,
        idempotencyKey: "enrichment-1",
        result: {
          schemaVersion: 1,
          rulesVersion: 1,
          outcome: "skipped",
          suggestions: [],
          ruleTagKeys: [],
        },
      }),
    ).resolves.toEqual(processingJob);

    expect(tokenProviders.enrichmentInput).toHaveBeenCalledOnce();
    expect(tokenProviders.enrichmentResult).toHaveBeenCalledOnce();
    expect(tokenProviders.jobs).not.toHaveBeenCalled();
  });

  it("maps non-2xx responses without leaking tokens or provider bodies", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ secret: "provider-body" }, 409));
    const client = createAppApiClient(config, {
      fetch: fetchMock,
      tokenProviders: appTokenProviders(),
    });

    const error = await client
      .getOcrInput(JOB_ID)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject<AppApiClientError>({
      code: "conflict",
      status: 409,
    });
    expect(String(error)).not.toContain("jobs-token");
    expect(String(error)).not.toContain("provider-body");
  });

  it("rejects invalid response payloads", async () => {
    const client = createAppApiClient(config, {
      fetch: vi.fn().mockResolvedValue(jsonResponse({ schemaVersion: 2 })),
      tokenProviders: appTokenProviders(),
    });

    await expect(client.getOcrInput(JOB_ID)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("aborts bounded requests", async () => {
    const pendingFetch = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("provider-secret", "AbortError")),
        );
      }),
    );
    const client = createAppApiClient(config, {
      fetch: pendingFetch,
      timeoutMs: 5,
      tokenProviders: appTokenProviders(),
    });

    await expect(client.getOcrInput(JOB_ID)).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("bounds custom token-provider acquisition", async () => {
    const fetchMock = vi.fn();
    const client = createAppApiClient(config, {
      fetch: fetchMock,
      timeoutMs: 5,
      tokenProviders: {
        ...appTokenProviders(),
        jobs: vi.fn(() => new Promise<string>(() => {})),
      },
    });

    await expect(client.getOcrInput(JOB_ID)).rejects.toMatchObject({
      code: "timeout",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps machine-token failures to authentication failures", async () => {
    const fetchMock = vi.fn();
    const client = createAppApiClient(config, {
      fetch: fetchMock,
      tokenProviders: {
        ...appTokenProviders(),
        jobs: vi
          .fn()
          .mockRejectedValue(new MachineTokenError("invalid_token")),
      },
    });

    await expect(client.getOcrInput(JOB_ID)).rejects.toMatchObject({
      code: "authentication_failed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps token-provider outages to service unavailability", async () => {
    const fetchMock = vi.fn();
    const client = createAppApiClient(config, {
      fetch: fetchMock,
      tokenProviders: {
        ...appTokenProviders(),
        jobs: vi
          .fn()
          .mockRejectedValue(new MachineTokenError("acquisition_failed")),
      },
    });

    await expect(client.getOcrInput(JOB_ID)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves timeout errors while reading JSON responses", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const response = {
      body: { cancel },
      json: vi.fn(() => new Promise(() => {})),
      ok: true,
      status: 200,
    } as unknown as Response;
    const client = createAppApiClient(config, {
      fetch: vi.fn().mockResolvedValue(response),
      timeoutMs: 5,
      tokenProviders: appTokenProviders(),
    });

    await expect(client.getOcrInput(JOB_ID)).rejects.toMatchObject({
      code: "timeout",
      status: 200,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects unallowlisted signed file origins", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        url: "http://169.254.169.254/latest/meta-data",
        expiresAt: TIMESTAMP,
      }),
    );
    const client = createAppApiClient(config, {
      fetch: fetchMock,
      tokenProviders: appTokenProviders(),
    });

    await expect(client.downloadFile(FILE_ID)).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("downloads loopback-published App content through the internal App origin", async () => {
    const path = `/api/v1/file-content/${FILE_ID}?expires=1000000000&signature=${"a".repeat(64)}`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        url: `http://127.0.0.1:8100${path}`,
        expiresAt: TIMESTAMP,
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    const client = createAppApiClient(config, {
      fetch: fetchMock,
      tokenProviders: appTokenProviders(),
    });

    await expect(client.downloadFile(FILE_ID)).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`${config.services.appApiBaseUrl}${path}`);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "GET", redirect: "error" });
  });

  it.each([
    `/api/v1/file-content/${JOB_ID}`,
    "/admin",
  ])("does not rewrite loopback signed URL for %s", async (path) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      url: `http://127.0.0.1:8100${path}?expires=1000000000&signature=${"a".repeat(64)}`,
      expiresAt: TIMESTAMP,
    }));
    const client = createAppApiClient(config, {
      fetch: fetchMock,
      tokenProviders: appTokenProviders(),
    });

    await expect(client.downloadFile(FILE_ID)).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("never includes signed file URLs in download errors", async () => {
    const signedUrl = `https://storage.test/file?signature=provider-secret`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ url: signedUrl, expiresAt: TIMESTAMP }),
      )
      .mockResolvedValueOnce(new Response("storage-secret", { status: 503 }));
    const client = createAppApiClient(config, {
      allowedFileOrigins: ["https://storage.test"],
      fetch: fetchMock,
      tokenProviders: appTokenProviders(),
    });

    const error = await client.downloadFile(FILE_ID).catch((caught) => caught);
    expect(error).toMatchObject({ code: "unavailable", status: 503 });
    expect(String(error)).not.toContain(signedUrl);
    expect(String(error)).not.toContain("storage-secret");
  });

  it("maps signed file body-read failures to redacted errors", async () => {
    const signedUrl = "https://storage.test/file?signature=secret";
    const brokenResponse = {
      arrayBuffer: vi.fn().mockRejectedValue(new Error(signedUrl)),
      body: null,
      ok: true,
      status: 200,
    } as unknown as Response;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ url: signedUrl, expiresAt: TIMESTAMP }),
      )
      .mockResolvedValueOnce(brokenResponse);
    const client = createAppApiClient(config, {
      allowedFileOrigins: ["https://storage.test"],
      fetch: fetchMock,
      tokenProviders: appTokenProviders(),
    });

    const error = await client.downloadFile(FILE_ID).catch((caught) => caught);
    expect(error).toMatchObject({ code: "invalid_response", status: 200 });
    expect(String(error)).not.toContain(signedUrl);
  });

  it("preserves timeout errors while reading signed file bodies", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const signedUrl = "https://storage.test/file";
    const response = {
      arrayBuffer: vi.fn(() => new Promise(() => {})),
      body: { cancel },
      ok: true,
      status: 200,
    } as unknown as Response;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ url: signedUrl, expiresAt: TIMESTAMP }),
      )
      .mockResolvedValueOnce(response);
    const client = createAppApiClient(config, {
      allowedFileOrigins: ["https://storage.test"],
      fetch: fetchMock,
      timeoutMs: 5,
      tokenProviders: appTokenProviders(),
    });

    await expect(client.downloadFile(FILE_ID)).rejects.toMatchObject({
      code: "timeout",
      status: 200,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels non-2xx response bodies before throwing", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const response = {
      body: { cancel },
      ok: false,
      status: 503,
    } as unknown as Response;
    const client = createAppApiClient(config, {
      fetch: vi.fn().mockResolvedValue(response),
      tokenProviders: appTokenProviders(),
    });

    await expect(client.getOcrInput(JOB_ID)).rejects.toMatchObject({
      code: "unavailable",
      status: 503,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds non-2xx response cleanup", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = {
      body: { cancel },
      ok: false,
      status: 503,
    } as unknown as Response;
    const client = createAppApiClient(config, {
      fetch: vi.fn().mockResolvedValue(response),
      timeoutMs: 5,
      tokenProviders: appTokenProviders(),
    });

    await expect(client.getOcrInput(JOB_ID)).rejects.toMatchObject({
      code: "unavailable",
      status: 503,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("Foundry client", () => {
  it("validates route queries and responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(effectiveRoute));
    const routesToken = vi.fn().mockResolvedValue("routes-token");
    const client = createFoundryClient(config, {
      fetch: fetchMock,
      tokenProviders: {
        routes: routesToken,
        reservations: vi.fn().mockResolvedValue("reservations-token"),
      },
    });

    await expect(
      client.getEffectiveRoute({
        operation: "RECEIPT_OCR",
        modeKey: "ocr_mode_fast",
      }),
    ).resolves.toEqual(effectiveRoute);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "http://foundry-service:8200/internal/v1/effective-route?operation=RECEIPT_OCR&modeKey=ocr_mode_fast",
    );
    expect(init.headers).toEqual({ authorization: "Bearer routes-token" });
    expect(routesToken).toHaveBeenCalledOnce();
  });

  it("validates reservation requests and responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(reservation, 201));
    const reservationsToken = vi.fn().mockResolvedValue("reservations-token");
    const client = createFoundryClient(config, {
      fetch: fetchMock,
      tokenProviders: {
        routes: vi.fn().mockResolvedValue("routes-token"),
        reservations: reservationsToken,
      },
    });

    await expect(
      client.reserve({
        tenantId: TENANT_ID,
        operation: "RECEIPT_OCR",
        aiModelId: MODEL_ID,
        idempotencyKey: "reserve-1",
      }),
    ).resolves.toEqual(reservation);
    expect(reservationsToken).toHaveBeenCalledOnce();
  });

  it("rejects malformed Foundry responses", async () => {
    const client = createFoundryClient(config, {
      fetch: vi.fn().mockResolvedValue(jsonResponse({ providerKind: "fake" })),
      tokenProviders: {
        routes: vi.fn().mockResolvedValue("routes-token"),
        reservations: vi.fn().mockResolvedValue("reservations-token"),
      },
    });

    await expect(
      client.getEffectiveRoute({
        operation: "RECEIPT_OCR",
        modeKey: "ocr_mode_fast",
      }),
    ).rejects.toMatchObject<FoundryClientError>({
      code: "invalid_response",
    });
  });

  it("maps machine-token failures to authentication failures", async () => {
    const fetchMock = vi.fn();
    const client = createFoundryClient(config, {
      fetch: fetchMock,
      tokenProviders: {
        routes: vi
          .fn()
          .mockRejectedValue(new MachineTokenError("invalid_token")),
        reservations: vi.fn().mockResolvedValue("reservations-token"),
      },
    });

    await expect(
      client.getEffectiveRoute({
        operation: "RECEIPT_OCR",
        modeKey: "ocr_mode_fast",
      }),
    ).rejects.toMatchObject({ code: "authentication_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
