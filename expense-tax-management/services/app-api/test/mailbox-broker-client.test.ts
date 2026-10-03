/**
 * Phase 3D-A Task 2 — MailboxBrokerClient.
 *
 * Fully local with fakes: a fake Clerk M2M token-mint endpoint and a fake
 * JWKS (no real Google/Clerk credentials or production access). Proves the
 * client acquires and attaches a machine token with the exact audience and
 * subject "app-api-mailbox" before calling the broker, and maps broker
 * error responses without leaking the token.
 */
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  MailboxBrokerClientError,
  createMailboxBrokerClient,
} from "../src/integrations/mailbox-broker-client.js";

const BROKER_BASE_URL = "http://mailbox-broker:8300";
const ISSUER_URL = "https://clerk.test";
const JWKS_URL = "https://clerk.test/.well-known/jwks.json";
const AUDIENCE = "mailbox-service-audience";
const SUBJECT = "app-api-mailbox";
const MINT_ENDPOINT = "https://api.clerk.com/v1/m2m_tokens";

const START_INPUT = {
  connectionId: "11111111-1111-4111-8111-111111111111",
  attemptId: "22222222-2222-4222-8222-222222222222",
  sessionNonce: "raw-session-nonce-never-logged",
  redirectOrigin: "https://expense-office.tobytran.dev",
};

const START_RESULT = {
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
  stateDigest: "a".repeat(64),
  expiresAt: "2026-09-12T00:10:00.000Z",
};

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

function signedJwt(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "JWT" })
    .sign(signingKey);
}

function baseConfig() {
  return {
    baseUrl: BROKER_BASE_URL,
    issuerUrl: ISSUER_URL,
    jwksUrl: JWKS_URL,
    credentials: {
      audience: AUDIENCE,
      subject: SUBJECT,
      machineSecretKey: "ak_test_mailbox_secret",
    },
  };
}

describe("MailboxBrokerClient", () => {
  it("acquires and attaches a machine token with exact audience/subject app-api-mailbox", async () => {
    let capturedAuthorization: string | undefined;
    let capturedBody: unknown;
    const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === MINT_ENDPOINT) {
        const token = await signedJwt({
          iss: ISSUER_URL,
          aud: [AUDIENCE],
          sub: SUBJECT,
          scope: "mailbox:write",
          jti: "token-id",
          nbf: Math.floor(Date.now() / 1_000) - 10,
          exp: Math.floor(Date.now() / 1_000) + 300,
        });
        return jsonResponse({ token });
      }
      if (url === `${BROKER_BASE_URL}/internal/v1/mailbox/oauth/start`) {
        capturedAuthorization = (init?.headers as Record<string, string>).authorization;
        capturedBody = JSON.parse(String(init?.body));
        return jsonResponse(START_RESULT);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const client = createMailboxBrokerClient(baseConfig(), {
      fetch: fetchFake,
      machineTokenOptions: { keyResolver },
    });

    const result = await client.startOAuth(START_INPUT);

    expect(result).toEqual(START_RESULT);
    expect(capturedBody).toEqual(START_INPUT);
    expect(capturedAuthorization).toMatch(/^Bearer /);

    // The request succeeding at all proves machine-token.ts validated the
    // minted token's audience and subject exactly against config -- it
    // throws invalid_token otherwise. Decode independently for a direct
    // assertion on the wire token this client actually sent.
    const sentToken = capturedAuthorization!.slice("Bearer ".length);
    const { payload } = await (await import("jose")).jwtVerify(sentToken, keyResolver);
    expect(payload.aud).toEqual([AUDIENCE]);
    expect(payload.sub).toBe(SUBJECT);
  });

  it("maps a broker 401 response to authentication_failed without leaking the token", async () => {
    const fetchFake = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === MINT_ENDPOINT) {
        const token = await signedJwt({
          iss: ISSUER_URL,
          aud: [AUDIENCE],
          sub: SUBJECT,
          scope: "mailbox:write",
          jti: "token-id",
          exp: Math.floor(Date.now() / 1_000) + 300,
        });
        return jsonResponse({ token });
      }
      return jsonResponse({ error: "forbidden" }, 401);
    }) as typeof fetch;

    const client = createMailboxBrokerClient(baseConfig(), {
      fetch: fetchFake,
      machineTokenOptions: { keyResolver },
    });

    const error = await client.startOAuth(START_INPUT).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailboxBrokerClientError);
    expect((error as MailboxBrokerClientError).code).toBe("authentication_failed");
    expect((error as MailboxBrokerClientError).message).not.toContain("ak_test_mailbox_secret");
  });
});
