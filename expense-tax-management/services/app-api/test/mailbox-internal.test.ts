/**
 * Phase 3D-B Task 2 — routes/mailbox-internal.ts: broker-guard enforcement
 * and request/response wiring for the two internal discovery routes.
 *
 * No Docker/live DB: domain/mailbox-scans.ts's own transactional behavior
 * is covered by mailbox-scans.test.ts (live PostgreSQL). This file injects
 * a fake MailboxScansDomain, same minimal-harness convention
 * domain-auth.test.ts uses (bare Fastify + registerAuthPlugin with fake
 * verifiers, no config/full buildApp needed).
 */
import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthPrincipal } from "../src/auth/types.js";
import type { MailboxScansDomain } from "../src/domain/mailbox-scans.js";
import { registerErrorHandlers } from "../src/errors.js";
import { registerAuthPlugin } from "../src/plugins/auth.js";
import { registerMailboxInternalRoutes } from "../src/routes/mailbox-internal.js";

const SCAN_RUN_ID = randomUUID();
const CONNECTION_ID = randomUUID();

function brokerPrincipal(overrides: Partial<AuthPrincipal> = {}): AuthPrincipal {
  return {
    tokenType: "service",
    subject: "mailbox-broker-app",
    clientId: null,
    audience: "app-service",
    issuer: "https://services.test",
    roles: [],
    scopes: ["mailbox:write"],
    tokenId: "token-1",
    email: null,
    emailVerified: null,
    displayName: null,
    ...overrides,
  };
}

const CANDIDATE_ID = randomUUID();

function createFakeDomain(): MailboxScansDomain & {
  readonly loadScanBinding: ReturnType<typeof vi.fn>;
  readonly loadCandidateBinding: ReturnType<typeof vi.fn>;
  readonly recordCandidateMetadata: ReturnType<typeof vi.fn>;
} {
  return {
    startManualScan: vi.fn(),
    startScheduledScan: vi.fn(),
    listScanRuns: vi.fn(),
    loadScanBinding: vi.fn(async (scanRunId: string) => ({
      scanRunId,
      connectionId: CONNECTION_ID,
      expectedConnectionVersion: 1,
      currentHistoryId: null,
      currentCursorDigest: "a".repeat(64),
      preFenceToken: "b".repeat(64),
      nextPageSequence: 1,
    })),
    loadCandidateBinding: vi.fn(async (candidateId: string) => ({
      candidateId,
      connectionId: CONNECTION_ID,
      expectedCandidateVersion: 1,
      providerMessageId: "gmail-message-1",
      providerThreadId: null,
    })),
    recordCandidateMetadata: vi.fn(async (input) => ({
      schemaVersion: 1 as const,
      scanRunId: input.scanRunId,
      pageSequence: input.pageSequence,
      candidateIds: [randomUUID()],
      counts: { discovered: 1, staged: 1, review: 0, failed: 0 },
    })),
  };
}

describe("routes/mailbox-internal.ts", () => {
  const apps = new Set<ReturnType<typeof Fastify>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createApp(resolvePrincipal: () => Promise<AuthPrincipal>) {
    const app = Fastify({ logger: false });
    apps.add(app);
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerErrorHandlers(app);
    registerAuthPlugin(app, {
      authVerifiers: {
        tenant: { verify: vi.fn(async () => brokerPrincipal()) },
        service: { verify: resolvePrincipal },
      },
    });
    const mailboxScansDomain = createFakeDomain();
    app.register(registerMailboxInternalRoutes, { mailboxScansDomain });
    return { app: app.withTypeProvider<ZodTypeProvider>(), mailboxScansDomain };
  }

  it("broker-binding: accepts the real broker principal and returns the binding", async () => {
    const { app, mailboxScansDomain } = createApp(async () => brokerPrincipal());
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${SCAN_RUN_ID}/broker-binding`,
      headers: { authorization: "Bearer fake" },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ scanRunId: SCAN_RUN_ID, nextPageSequence: 1 });
    expect(mailboxScansDomain.loadScanBinding).toHaveBeenCalledWith(SCAN_RUN_ID);
  });

  it("broker-binding: rejects a wrong service subject with 403", async () => {
    const { app } = createApp(async () => brokerPrincipal({ subject: "someone-else" }));
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${SCAN_RUN_ID}/broker-binding`,
      headers: { authorization: "Bearer fake" },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
  });

  it("broker-binding: rejects a service principal missing the mailbox:write scope", async () => {
    const { app } = createApp(async () => brokerPrincipal({ scopes: [] }));
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${SCAN_RUN_ID}/broker-binding`,
      headers: { authorization: "Bearer fake" },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
  });

  it("candidate broker-binding: accepts a principal with mailbox:materialize and returns the binding", async () => {
    const { app, mailboxScansDomain } = createApp(async () =>
      brokerPrincipal({ scopes: ["mailbox:materialize"] }),
    );
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/candidates/${CANDIDATE_ID}/broker-binding`,
      headers: { authorization: "Bearer fake" },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      candidateId: CANDIDATE_ID,
      connectionId: CONNECTION_ID,
      expectedCandidateVersion: 1,
      providerMessageId: "gmail-message-1",
      providerThreadId: null,
    });
    expect(mailboxScansDomain.loadCandidateBinding).toHaveBeenCalledWith(CANDIDATE_ID);
  });

  it("candidate broker-binding: rejects a principal with only mailbox:write (wrong scope for this route)", async () => {
    const { app } = createApp(async () => brokerPrincipal({ scopes: ["mailbox:write"] }));
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/candidates/${CANDIDATE_ID}/broker-binding`,
      headers: { authorization: "Bearer fake" },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
  });

  it("candidate broker-binding: rejects a wrong service subject with 403", async () => {
    const { app } = createApp(async () =>
      brokerPrincipal({ subject: "someone-else", scopes: ["mailbox:materialize"] }),
    );
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/candidates/${CANDIDATE_ID}/broker-binding`,
      headers: { authorization: "Bearer fake" },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
  });

  it("candidate-pages: forwards the body to recordCandidateMetadata and returns its result", async () => {
    const { app, mailboxScansDomain } = createApp(async () => brokerPrincipal());
    await app.ready();

    const body = {
      connectionId: CONNECTION_ID,
      expectedConnectionVersion: 1,
      cursorBeforeDigest: "a".repeat(64),
      preFenceToken: "b".repeat(64),
      pageSequence: 1,
      nextHistoryId: null,
      messages: [
        {
          receivedAt: "2026-10-03T00:00:00.000Z",
          senderAddress: "merchant@example.test",
          senderDomain: "example.test",
          subject: "Your receipt",
          contentHash: "c".repeat(64),
          attachmentManifest: [],
          classification: "receipt" as const,
          confidence: 0.95,
          evidence: ["subject keyword"],
          providerMessageId: "gmail-message-1",
          providerThreadId: null,
        },
      ],
      idempotencyKey: "page-1",
    };

    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${SCAN_RUN_ID}/candidate-pages`,
      headers: { authorization: "Bearer fake" },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scanRunId: SCAN_RUN_ID,
      pageSequence: 1,
      counts: { discovered: 1, staged: 1, review: 0, failed: 0 },
    });
    expect(mailboxScansDomain.recordCandidateMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ scanRunId: SCAN_RUN_ID, connectionId: CONNECTION_ID, pageSequence: 1 }),
    );
  });

  it("candidate-pages: rejects a tenant-token caller (no service principal at all)", async () => {
    const { app } = createApp(async () => {
      throw new Error("service token verification should not be reached without a bearer token");
    });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${SCAN_RUN_ID}/candidate-pages`,
      payload: {
        connectionId: CONNECTION_ID,
        expectedConnectionVersion: 1,
        cursorBeforeDigest: "a".repeat(64),
        preFenceToken: "b".repeat(64),
        pageSequence: 1,
        nextHistoryId: null,
        messages: [],
        idempotencyKey: "page-1",
      },
    });

    expect(response.statusCode).toBe(401);
  });
});
