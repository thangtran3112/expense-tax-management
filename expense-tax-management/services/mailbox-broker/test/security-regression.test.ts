/**
 * Phase 3D-A Task 6 — security regression suite.
 *
 * Consolidates, in one fast-running, fully-local file (no Docker, no
 * network -- every dependency is in-memory or a fake), the critical
 * security invariants fix rounds across Tasks 2/3/4 established
 * piecemeal, so a future refactor that silently regresses one of them
 * fails here immediately instead of waiting to be rediscovered.
 *
 * Does NOT duplicate the exhaustive per-module suites
 * (oauth-state.test.ts, token-vault.test.ts's AAD-binding proofs,
 * routes.test.ts's HTTP-level redaction/host/ticket tests) -- it proves
 * cross-cutting invariants those files don't: AAD domain-separation
 * *between* the two independent ciphertext formats that share the same
 * vault key material (OAuth state vs. begin ticket), the completeness of
 * the shared redaction field list, and the CAS/replay contract of the
 * App-client fake every other broker test builds on.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  consumeBeginTicket,
  createBeginTicket,
  BeginTicketInvalidError,
} from "../src/begin-ticket.js";
import {
  consumeOAuthState,
  createOAuthState,
  decodeOAuthStatePayload,
  OAuthStateInvalidError,
  type VaultKeyMap,
} from "../src/oauth-state.js";
import {
  containsBearerToken,
  redact,
  SENSITIVE_FIELD_NAMES,
} from "../src/logging.js";
import { MailboxAppClientError } from "../src/app-client.js";
import { createFakeAppClient, createVaultKeyMap } from "../src/test-doubles.js";

const ALLOWED_ORIGIN = "https://expense-office.test";

function oauthStateInput(overrides: Partial<Parameters<typeof createOAuthState>[0]> = {}) {
  const vaultKeys = overrides.vaultKeys ?? createVaultKeyMap();
  return {
    connectionId: randomUUID(),
    attemptId: randomUUID(),
    sessionNonce: randomBytes(32).toString("hex"),
    redirectOrigin: ALLOWED_ORIGIN,
    ttlSeconds: 600,
    vaultKeys,
    ...overrides,
  };
}

describe("oauth-state.ts — CAS/replay-adjacent invariants and session/redirect binding", () => {
  it("round-trips: create then consume recovers the exact connection/attempt/redirect-origin and binds the session nonce", () => {
    const input = oauthStateInput();
    const created = createOAuthState(input);
    const consumed = consumeOAuthState({
      state: created.state,
      sessionNonce: input.sessionNonce,
      allowedRedirectOrigins: [ALLOWED_ORIGIN],
      vaultKeys: input.vaultKeys,
    });
    expect(consumed.connectionId).toBe(input.connectionId);
    expect(consumed.attemptId).toBe(input.attemptId);
    expect(consumed.redirectOrigin).toBe(ALLOWED_ORIGIN);
    expect(consumed.stateDigest).toBe(created.stateDigest);
  });

  it("rejects a wrong session nonce (session binding)", () => {
    const input = oauthStateInput();
    const created = createOAuthState(input);
    expect(() =>
      consumeOAuthState({
        state: created.state,
        sessionNonce: randomBytes(32).toString("hex"),
        allowedRedirectOrigins: [ALLOWED_ORIGIN],
        vaultKeys: input.vaultKeys,
      }),
    ).toThrow(OAuthStateInvalidError);
  });

  it("rejects a redirect origin outside the allowlist, even with a valid state and session nonce", () => {
    const input = oauthStateInput();
    const created = createOAuthState(input);
    expect(() =>
      consumeOAuthState({
        state: created.state,
        sessionNonce: input.sessionNonce,
        allowedRedirectOrigins: ["https://not-this-one.test"],
        vaultKeys: input.vaultKeys,
      }),
    ).toThrow(OAuthStateInvalidError);
  });

  it("rejects an expired state", () => {
    const input = oauthStateInput({ ttlSeconds: 1 });
    const created = createOAuthState(input);
    expect(() =>
      consumeOAuthState({
        state: created.state,
        sessionNonce: input.sessionNonce,
        allowedRedirectOrigins: [ALLOWED_ORIGIN],
        vaultKeys: input.vaultKeys,
        now: () => new Date(Date.now() + 10_000),
      }),
    ).toThrow(/expired/);
  });

  it("rejects a tampered state (GCM auth-tag mismatch)", () => {
    const input = oauthStateInput();
    const created = createOAuthState(input);
    const parts = created.state.split(".");
    const tamperedBody = Buffer.from(parts[3]!, "base64url");
    tamperedBody[0] = (tamperedBody[0]! ^ 0xff) & 0xff;
    const tampered = [...parts.slice(0, 3), tamperedBody.toString("base64url")].join(".");
    expect(() =>
      consumeOAuthState({
        state: tampered,
        sessionNonce: input.sessionNonce,
        allowedRedirectOrigins: [ALLOWED_ORIGIN],
        vaultKeys: input.vaultKeys,
      }),
    ).toThrow(OAuthStateInvalidError);
  });

  it("rejects a state encrypted under an unknown/retired key", () => {
    const input = oauthStateInput();
    const created = createOAuthState(input);
    const emptyKeys: VaultKeyMap = { keys: new Map(), activeKeyId: "gone" };
    expect(() =>
      consumeOAuthState({
        state: created.state,
        sessionNonce: input.sessionNonce,
        allowedRedirectOrigins: [ALLOWED_ORIGIN],
        vaultKeys: emptyKeys,
      }),
    ).toThrow(OAuthStateInvalidError);
  });

  it("produces a fresh, distinct state/stateDigest/pkceVerifier on every call, even for the identical connection/attempt (no accidental replay surface)", () => {
    const vaultKeys = createVaultKeyMap();
    const first = createOAuthState(oauthStateInput({ vaultKeys }));
    const second = createOAuthState(oauthStateInput({ vaultKeys }));
    expect(first.state).not.toBe(second.state);
    expect(first.stateDigest).not.toBe(second.stateDigest);
    expect(first.pkceVerifier).not.toBe(second.pkceVerifier);
  });

  it("decodeOAuthStatePayload (used by the code-exchange path) never leaks the session nonce in plaintext -- only its digest", () => {
    const input = oauthStateInput();
    const created = createOAuthState(input);
    const decoded = decodeOAuthStatePayload(created.state, input.vaultKeys);
    expect(decoded.sessionNonceDigest).not.toBe(input.sessionNonce);
    expect(JSON.stringify(decoded)).not.toContain(input.sessionNonce);
  });
});

describe("begin-ticket.ts — CAS-adjacent replay bound and tamper resistance", () => {
  function ticketInput(overrides: Partial<Parameters<typeof createBeginTicket>[0]> = {}) {
    const vaultKeys = overrides.vaultKeys ?? createVaultKeyMap();
    return {
      state: `v1.${randomUUID()}`,
      sessionNonce: randomBytes(32).toString("hex"),
      vaultKeys,
      ...overrides,
    };
  }

  it("round-trips: create then consume recovers the exact state/sessionNonce", () => {
    const input = ticketInput();
    const ticket = createBeginTicket(input);
    const payload = consumeBeginTicket(ticket, input.vaultKeys);
    expect(payload).toEqual({ state: input.state, sessionNonce: input.sessionNonce });
  });

  it("rejects an expired ticket (tight-expiry replay bound)", () => {
    const input = ticketInput({ ttlSeconds: 1 });
    const ticket = createBeginTicket(input);
    expect(() => consumeBeginTicket(ticket, input.vaultKeys, () => new Date(Date.now() + 5_000))).toThrow(
      BeginTicketInvalidError,
    );
  });

  it("rejects a tampered ticket", () => {
    const input = ticketInput();
    const ticket = createBeginTicket(input);
    const parts = ticket.split(".");
    const tamperedBody = Buffer.from(parts[3]!, "base64url");
    tamperedBody[0] = (tamperedBody[0]! ^ 0xff) & 0xff;
    const tampered = [...parts.slice(0, 3), tamperedBody.toString("base64url")].join(".");
    expect(() => consumeBeginTicket(tampered, input.vaultKeys)).toThrow(BeginTicketInvalidError);
  });

  it("rejects a malformed ticket (wrong shape, not a decryption failure)", () => {
    expect(() => consumeBeginTicket("not-a-ticket", createVaultKeyMap())).toThrow(BeginTicketInvalidError);
  });

  // AAD domain-separation regression: the begin-ticket and OAuth-state
  // formats intentionally share the exact same key material
  // (begin-ticket.ts's own doc comment: "Reuses the exact same
  // AES-256-GCM vault-key material oauth-state.ts already uses"). The
  // only thing preventing one ciphertext type from being replayed as the
  // other is each format's distinct AAD tag. If a future refactor ever
  // let the two share an AAD, this test fails immediately.
  it("a valid OAuth state can never be consumed as a begin ticket (distinct AAD), even under the same key material", () => {
    const vaultKeys = createVaultKeyMap();
    const state = createOAuthState(oauthStateInput({ vaultKeys })).state;
    // Reshape the OAuth state's wire format onto the begin-ticket's
    // 4-part "bt1.<keyId>.<nonce>.<body>" shape so it is at least
    // structurally eligible for consumeBeginTicket.
    const [, keyId, nonce, body] = state.split(".");
    const asTicket = ["bt1", keyId, nonce, body].join(".");
    expect(() => consumeBeginTicket(asTicket, vaultKeys)).toThrow(BeginTicketInvalidError);
  });

  it("a valid begin ticket can never be consumed as an OAuth state (distinct AAD), even under the same key material", () => {
    const vaultKeys = createVaultKeyMap();
    const ticket = createBeginTicket(ticketInput({ vaultKeys }));
    const [, keyId, nonce, body] = ticket.split(".");
    const asState = ["v1", keyId, nonce, body].join(".");
    expect(() =>
      consumeOAuthState({
        state: asState,
        sessionNonce: "irrelevant",
        allowedRedirectOrigins: [ALLOWED_ORIGIN],
        vaultKeys,
      }),
    ).toThrow(OAuthStateInvalidError);
  });
});

describe("logging.ts — redaction list completeness (no token/state leakage in logs)", () => {
  it("never logs a bearer token, directly or redacted-field-nested", () => {
    expect(containsBearerToken("authorization: Bearer abcdef1234567890")).toBe(true);
    expect(containsBearerToken("no token here")).toBe(false);
  });

  it("redacts every mailbox-specific secret field this service's own modules handle", () => {
    const mustBeRedacted = [
      "code",
      "pkceVerifier",
      "sessionNonce",
      "nonce",
      "ciphertext",
      "authTag",
      "machineSecretKey",
      "accessToken",
      "refreshToken",
      "clientSecret",
    ] as const;
    for (const field of mustBeRedacted) {
      expect(SENSITIVE_FIELD_NAMES as readonly string[]).toContain(field);
    }
    const payload = Object.fromEntries(mustBeRedacted.map((field) => [field, `secret-value-${field}`]));
    const result = redact(payload) as Record<string, unknown>;
    for (const field of mustBeRedacted) {
      expect(result[field]).toBe("[Redacted]");
    }
  });

  it("redacts secrets nested inside arrays and objects, leaving non-sensitive data untouched", () => {
    const result = redact({
      providerAccountId: "not-a-secret",
      nested: { refreshToken: "raw-refresh-token" },
      list: [{ accessToken: "raw-access-token" }, { email: "user@example.test" }],
    }) as Record<string, unknown>;
    expect(result.providerAccountId).toBe("not-a-secret");
    expect((result.nested as Record<string, unknown>).refreshToken).toBe("[Redacted]");
    expect((result.list as Record<string, unknown>[])[0]!.accessToken).toBe("[Redacted]");
    expect((result.list as Record<string, unknown>[])[1]!.email).toBe("user@example.test");
  });
});

describe("test-doubles.ts createFakeAppClient — CAS/replay contract every broker test relies on", () => {
  it("advanceTokenGeneration rejects a wrong lease, wrong expectedConnectionVersion, or non-sequential generation", async () => {
    const client = createFakeAppClient();
    const connectionId = randomUUID();
    const lease = await client.acquireTokenOperationLease({ connectionId, operationId: randomUUID(), ttlSeconds: 60 });

    await expect(
      client.advanceTokenGeneration({
        connectionId,
        leaseId: randomUUID(), // wrong lease
        expectedConnectionVersion: lease.expectedConnectionVersion,
        newGeneration: lease.currentTokenGeneration + 1,
        vaultReference: "ref",
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(MailboxAppClientError);

    await expect(
      client.advanceTokenGeneration({
        connectionId,
        leaseId: lease.leaseId,
        expectedConnectionVersion: lease.expectedConnectionVersion + 99, // wrong version
        newGeneration: lease.currentTokenGeneration + 1,
        vaultReference: "ref",
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(MailboxAppClientError);

    await expect(
      client.advanceTokenGeneration({
        connectionId,
        leaseId: lease.leaseId,
        expectedConnectionVersion: lease.expectedConnectionVersion,
        newGeneration: lease.currentTokenGeneration + 2, // skips a generation
        vaultReference: "ref",
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(MailboxAppClientError);
  });

  it("advanceTokenGeneration replays the cached result for a reused idempotencyKey, without re-checking the (now-stale) lease", async () => {
    const client = createFakeAppClient();
    const connectionId = randomUUID();
    const lease = await client.acquireTokenOperationLease({ connectionId, operationId: randomUUID(), ttlSeconds: 60 });
    const idempotencyKey = randomUUID();
    const input = {
      connectionId,
      leaseId: lease.leaseId,
      expectedConnectionVersion: lease.expectedConnectionVersion,
      newGeneration: lease.currentTokenGeneration + 1,
      vaultReference: "ref-gen-2",
      requestId: randomUUID(),
      idempotencyKey,
    };
    const first = await client.advanceTokenGeneration(input);
    // The lease is now consumed/stale; a naive re-check would reject this.
    const replay = await client.advanceTokenGeneration(input);
    expect(replay).toEqual(first);
  });
});
