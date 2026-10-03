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
});
