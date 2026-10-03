/**
 * Phase 3D-A Task 3 — base mailbox worker client: the generic
 * authenticated-request helper against both App API and the broker, and
 * the two distinct token providers it wires up (one shared subject/
 * secret, two audiences). `createMachineTokenProvider` itself (real JWT
 * minting/validation) is already fully covered by
 * test/clients.test.ts/auth tests -- this file uses the client's own
 * `appTokenProvider`/`brokerTokenProvider` override options (same
 * pattern `clients.test.ts` uses for `createAppApiClient`'s
 * `tokenProviders` override) to isolate the request plumbing.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { WorkerConfig } from "../src/config.js";
import { createMailboxAppApiClient, MailboxClientError } from "../src/clients/mailbox-client.js";

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

function fakeFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return vi.fn(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
}

describe("clients/mailbox-client.ts createMailboxAppApiClient", () => {
  it("requestAppApi sends the App token as a Bearer header and parses the JSON response", async () => {
    let capturedAuth = "";
    const client = createMailboxAppApiClient(config, {
      appTokenProvider: async () => "app-token-value",
      brokerTokenProvider: async () => "broker-token-value",
      fetch: fakeFetch((url, init) => {
        capturedAuth = (init.headers as Record<string, string>).authorization;
        expect(url.pathname).toBe("/internal/v1/mailbox/discover");
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    });

    const result = await client.requestAppApi({
      path: "/internal/v1/mailbox/discover",
      method: "GET",
      responseSchema: z.object({ ok: z.boolean() }),
    });

    expect(result.ok).toBe(true);
    expect(capturedAuth).toBe("Bearer app-token-value");
  });

  it("requestBroker targets the broker's base URL with the broker token, independent of requestAppApi", async () => {
    const seen: { origin: string; auth: string }[] = [];
    const client = createMailboxAppApiClient(config, {
      appTokenProvider: async () => "app-token-value",
      brokerTokenProvider: async () => "broker-token-value",
      fetch: fakeFetch((url, init) => {
        seen.push({ origin: url.origin, auth: (init.headers as Record<string, string>).authorization });
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    });

    await client.requestAppApi({ path: "/x", method: "GET", responseSchema: z.object({}) });
    await client.requestBroker({ path: "/y", method: "GET", responseSchema: z.object({}) });

    expect(seen).toEqual([
      { origin: "http://app-api:8100", auth: "Bearer app-token-value" },
      { origin: "http://mailbox-broker:8300", auth: "Bearer broker-token-value" },
    ]);
  });

  it("maps a non-2xx response to a typed MailboxClientError", async () => {
    const client = createMailboxAppApiClient(config, {
      appTokenProvider: async () => "app-token-value",
      brokerTokenProvider: async () => "broker-token-value",
      fetch: fakeFetch(() => new Response(null, { status: 404 })),
    });

    await expect(
      client.requestAppApi({ path: "/missing", method: "GET", responseSchema: z.object({}) }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(MailboxClientError);
      expect((error as MailboxClientError).code).toBe("not_found");
      return true;
    });
  });

  it("maps a 409 to 'conflict' and a 503 to 'unavailable'", async () => {
    async function requestWithStatus(status: number) {
      const client = createMailboxAppApiClient(config, {
        appTokenProvider: async () => "app-token-value",
        brokerTokenProvider: async () => "broker-token-value",
        fetch: fakeFetch(() => new Response(null, { status })),
      });
      return client.requestAppApi({ path: "/x", method: "GET", responseSchema: z.object({}) }).catch(
        (error: unknown) => error as MailboxClientError,
      );
    }

    expect(((await requestWithStatus(409)) as MailboxClientError).code).toBe("conflict");
    expect(((await requestWithStatus(503)) as MailboxClientError).code).toBe("unavailable");
  });

  it("POSTs a JSON body with a content-type header", async () => {
    let capturedBody = "";
    let capturedContentType = "";
    const client = createMailboxAppApiClient(config, {
      appTokenProvider: async () => "app-token-value",
      brokerTokenProvider: async () => "broker-token-value",
      fetch: fakeFetch((_url, init) => {
        capturedBody = String(init.body);
        capturedContentType = (init.headers as Record<string, string>)["content-type"];
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    });

    await client.requestAppApi({
      path: "/x",
      method: "POST",
      body: { foo: "bar" },
      responseSchema: z.object({}),
    });

    expect(capturedBody).toBe(JSON.stringify({ foo: "bar" }));
    expect(capturedContentType).toBe("application/json");
  });

  it("never sends the authorization header to anywhere but the single outbound request", async () => {
    const headersSeen: unknown[] = [];
    const client = createMailboxAppApiClient(config, {
      appTokenProvider: async () => "app-token-value",
      brokerTokenProvider: async () => "broker-token-value",
      fetch: fakeFetch((_url, init) => {
        headersSeen.push(init.headers);
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    });

    await client.requestBroker({ path: "/z", method: "GET", responseSchema: z.object({}) });

    expect(headersSeen).toHaveLength(1);
  });
});
