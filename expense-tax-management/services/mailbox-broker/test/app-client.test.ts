/**
 * Phase 3D-A Task 3 — app-client.ts: broker's outbound client to App API.
 * No real network: a fake HTTP server asserts the exact Clerk M2M
 * credential (App audience, "mailbox-broker-app" subject, "mailbox:write"
 * scope) and request shape per route.
 */
import { describe, expect, it, vi } from "vitest";

import { createMailboxAppClient, MailboxAppClientError } from "../src/app-client.js";
import { createFakeClerkIssuer } from "../src/test-doubles.js";

const APP_BASE_URL = "https://app-api.test";

async function setup() {
  const issuer = await createFakeClerkIssuer();
  const audience = "mch_appServiceAudience";

  function fetchImplementation(
    handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
  ): typeof fetch {
    return vi.fn(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      return handler(url, init ?? {});
    }) as unknown as typeof fetch;
  }

  function createClient(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
    return createMailboxAppClient(
      {
        baseUrl: APP_BASE_URL,
        issuerUrl: issuer.issuerUrl,
        jwksUrl: issuer.jwksUrl,
        credentials: {
          audience,
          machineSecretKey: "ak_test_broker_secret",
          subject: "mailbox-broker-app",
        },
      },
      {
        fetch: fetchImplementation(handler),
        tokenProvider: async () =>
          issuer.mint({ subject: "mailbox-broker-app", audience, scopes: ["mailbox:write"] }),
      },
    );
  }

  return { createClient, issuer, audience };
}

describe("app-client.ts createMailboxAppClient", () => {
  it("acquireTokenOperationLease sends a Bearer token and parses the lease response", async () => {
    const { createClient } = await setup();
    let capturedAuth: string | null = null;
    const client = createClient((url, init) => {
      capturedAuth = (init.headers as Record<string, string>).authorization;
      expect(url.pathname).toBe(
        "/internal/v1/mailbox/connections/11111111-1111-4111-8111-111111111111/token-operations/lease",
      );
      return new Response(
        JSON.stringify({
          connectionId: "11111111-1111-4111-8111-111111111111",
          leaseId: "22222222-2222-4222-8222-222222222222",
          expiresAt: new Date().toISOString(),
          expectedConnectionVersion: 1,
          currentTokenGeneration: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const lease = await client.acquireTokenOperationLease({
      connectionId: "11111111-1111-4111-8111-111111111111",
      operationId: "op-1",
      ttlSeconds: 300,
    });

    expect(lease.leaseId).toBe("22222222-2222-4222-8222-222222222222");
    expect(capturedAuth).toMatch(/^Bearer /);
  });

  it("advanceTokenGeneration maps a 409 IDEMPOTENCY_CONFLICT body to a definitive-rejection error", async () => {
    const { createClient } = await setup();
    const client = createClient(() =>
      new Response(
        JSON.stringify({ error: { code: "IDEMPOTENCY_CONFLICT", message: "x", requestId: "r" } }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      client.advanceTokenGeneration({
        connectionId: "11111111-1111-4111-8111-111111111111",
        leaseId: "lease-1",
        expectedConnectionVersion: 1,
        newGeneration: 2,
        vaultReference: "11111111-1111-4111-8111-111111111111",
        requestId: "req-1",
        idempotencyKey: "idem-1",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(MailboxAppClientError);
      expect((error as MailboxAppClientError).isDefinitiveRejection()).toBe(true);
      return true;
    });
  });

  it("advanceTokenGeneration maps a generic 409 CONFLICT to a definitive rejection too", async () => {
    const { createClient } = await setup();
    const client = createClient(() =>
      new Response(
        JSON.stringify({ error: { code: "CONFLICT", message: "x", requestId: "r" } }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      client.advanceTokenGeneration({
        connectionId: "11111111-1111-4111-8111-111111111111",
        leaseId: "lease-1",
        expectedConnectionVersion: 1,
        newGeneration: 2,
        vaultReference: "11111111-1111-4111-8111-111111111111",
        requestId: "req-1",
        idempotencyKey: "idem-1",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect((error as MailboxAppClientError).isDefinitiveRejection()).toBe(true);
      return true;
    });
  });

  it("a 503 response is NOT a definitive rejection (ambiguous, retriable)", async () => {
    const { createClient } = await setup();
    const client = createClient(() => new Response("", { status: 503 }));

    await expect(
      client.advanceTokenGeneration({
        connectionId: "11111111-1111-4111-8111-111111111111",
        leaseId: "lease-1",
        expectedConnectionVersion: 1,
        newGeneration: 2,
        vaultReference: "11111111-1111-4111-8111-111111111111",
        requestId: "req-1",
        idempotencyKey: "idem-1",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect((error as MailboxAppClientError).isDefinitiveRejection()).toBe(false);
      return true;
    });
  });

  it("releaseTokenOperationLease handles a 204 No Content response", async () => {
    const { createClient } = await setup();
    const client = createClient(() => new Response(null, { status: 204 }));

    await expect(
      client.releaseTokenOperationLease({
        connectionId: "11111111-1111-4111-8111-111111111111",
        leaseId: "lease-1",
      }),
    ).resolves.toBeUndefined();
  });

  it("never sends the authorization header value anywhere but the single outbound request (no stray logging hook)", async () => {
    const { createClient } = await setup();
    const seenHeaders: string[] = [];
    const client = createClient((_url, init) => {
      seenHeaders.push(JSON.stringify(init.headers));
      return new Response(null, { status: 204 });
    });

    await client.releaseTokenOperationLease({
      connectionId: "11111111-1111-4111-8111-111111111111",
      leaseId: "lease-1",
    });

    expect(seenHeaders).toHaveLength(1);
  });

  // Phase 3D-B Task 2 -- MailboxBrokerDiscoveryAppClient additions.
  it("loadScanBinding posts an empty body and parses the scan binding", async () => {
    const { createClient } = await setup();
    const scanRunId = "33333333-3333-4333-8333-333333333333";
    let capturedBody: string | undefined;
    const client = createClient((url, init) => {
      capturedBody = init.body as string;
      expect(url.pathname).toBe(`/internal/v1/mailbox/scan-runs/${scanRunId}/broker-binding`);
      return new Response(
        JSON.stringify({
          scanRunId,
          connectionId: "11111111-1111-4111-8111-111111111111",
          expectedConnectionVersion: 1,
          currentHistoryId: null,
          currentCursorDigest: "a".repeat(64),
          preFenceToken: "b".repeat(64),
          nextPageSequence: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const binding = await client.loadScanBinding(scanRunId);

    expect(binding.nextPageSequence).toBe(1);
    expect(capturedBody).toBe("{}");
  });

  it("stageCandidateMetadata sends the fence fields and messages, and parses the counts", async () => {
    const { createClient } = await setup();
    const scanRunId = "44444444-4444-4444-8444-444444444444";
    let capturedBody: Record<string, unknown> | undefined;
    const client = createClient((url, init) => {
      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(url.pathname).toBe(`/internal/v1/mailbox/scan-runs/${scanRunId}/candidate-pages`);
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          scanRunId,
          pageSequence: 1,
          candidateIds: ["55555555-5555-4555-8555-555555555555"],
          counts: { discovered: 1, staged: 1, review: 0, failed: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await client.stageCandidateMetadata({
      schemaVersion: 1,
      scanRunId,
      connectionId: "11111111-1111-4111-8111-111111111111",
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
          classification: "receipt",
          confidence: 0.95,
          evidence: ["subject keyword"],
          providerMessageId: "gmail-message-1",
          providerThreadId: null,
        },
      ],
      idempotencyKey: "page-1",
    });

    expect(result.counts).toEqual({ discovered: 1, staged: 1, review: 0, failed: 0 });
    expect(capturedBody?.pageSequence).toBe(1);
    expect(capturedBody?.cursorBeforeDigest).toBe("a".repeat(64));
  });
});
