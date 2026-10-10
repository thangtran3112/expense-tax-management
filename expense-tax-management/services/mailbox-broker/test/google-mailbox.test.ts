/**
 * Phase 3D-A Task 3 — google-mailbox.ts: createGmailMailboxProvider. Not
 * individually listed in the brief's Create-file list, but this project
 * follows test-first for every behavior change (AGENTS.md); the
 * refresh-token-rotation ordering guarantee (lease before vault write
 * before advanceTokenGeneration before disabling the prior generation)
 * is exactly the kind of invariant the brief's Step 1 demands tests for.
 *
 * No real Google network access: `createOAuth2Client` is injected with
 * `test-doubles.ts`'s fake. Real-Google-credential verification is
 * operator-gated (Task 6), per the brief.
 */
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createGmailMailboxProvider,
  createMailboxProviderAdapter,
  decodeBase64UrlBounded,
  GMAIL_READONLY_SCOPE,
  parseReceivedAt,
} from "../src/google-mailbox.js";
import { createOAuthState } from "../src/oauth-state.js";
import { decryptVaultRow, selectVaultRow } from "../src/token-vault.js";
import {
  createFakeAppClient,
  createFakeOAuth2Client,
  createVaultKeyMap,
} from "../src/test-doubles.js";
import {
  createEphemeralVaultDatabase,
  dockerPostgresAvailable,
  type VaultTestDatabase,
} from "./support/vault-database.js";

const ALLOWED_ORIGIN = "https://expense-office.test";

describe("google-mailbox.ts createMailboxProviderAdapter", () => {
  it("rejects provider 'outlook' with PROVIDER_UNSUPPORTED (no database touched)", () => {
    const vaultKeys = createVaultKeyMap();
    const appClient = createFakeAppClient();

    expect(() =>
      createMailboxProviderAdapter("outlook", {
        clientId: "client",
        clientSecret: "secret",
        redirectUri: "https://broker.test/callback",
        vaultKeys,
        database: undefined as never,
        appClient,
      }),
    ).toThrow("PROVIDER_UNSUPPORTED");
  });
});

const requested = process.env.PHASE_3D_A_T3_INTEGRATION === "1";
const runKey = randomUUID().replaceAll("-", "").slice(0, 10);

describe.skipIf(!requested)("google-mailbox.ts createGmailMailboxProvider (live PostgreSQL)", () => {
  let instance: VaultTestDatabase;

  beforeAll(async () => {
    if (!dockerPostgresAvailable()) {
      throw new Error("Mailbox Task 3 PostgreSQL prerequisite unavailable");
    }
    instance = await createEphemeralVaultDatabase(runKey);
  });

  afterAll(async () => {
    await instance?.teardown();
  });

  function database() {
    return instance.database;
  }

  it("createAuthorizationUrl requests offline access, the exact readonly scope, and S256 PKCE", async () => {
    const vaultKeys = createVaultKeyMap();
    const appClient = createFakeAppClient();
    const fakeClient = createFakeOAuth2Client();
    const provider = createGmailMailboxProvider({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://broker.test/callback",
      vaultKeys,
      database: database(),
      appClient,
      createOAuth2Client: () => fakeClient,
    });

    const result = await provider.createAuthorizationUrl({
      connectionId: randomUUID(),
      attemptId: randomUUID(),
      sessionNonce: "nonce",
      redirectOrigin: ALLOWED_ORIGIN,
    });

    expect(result.authorizationUrl).toContain("accounts.google.test");
    expect(fakeClient.generateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        access_type: "offline",
        scope: [GMAIL_READONLY_SCOPE],
        code_challenge_method: "S256",
      }),
    );
  });

  it("exchangeAuthorizationCode writes the refresh token to the vault and returns ConnectedAccount", async () => {
    const vaultKeys = createVaultKeyMap();
    const appClient = createFakeAppClient();
    const fakeClient = createFakeOAuth2Client();
    const connectionId = randomUUID();
    const attemptId = randomUUID();

    const provider = createGmailMailboxProvider({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://broker.test/callback",
      vaultKeys,
      database: database(),
      appClient,
      createOAuth2Client: () => fakeClient,
      fetchProfile: async () => ({ emailAddress: "user@example.test", historyId: "12345" }),
    });

    const state = createOAuthState({
      connectionId,
      attemptId,
      sessionNonce: "nonce",
      redirectOrigin: ALLOWED_ORIGIN,
      ttlSeconds: 600,
      vaultKeys,
    });

    const account = await provider.exchangeAuthorizationCode({
      code: "auth-code",
      state: state.state,
      requestOrigin: ALLOWED_ORIGIN,
    });

    expect(account.providerAccountId).toBe("user@example.test");
    expect(account.email).toBe("user@example.test");
    expect(account.grantedScopes).toEqual([GMAIL_READONLY_SCOPE]);
    expect(account.initialHistoryId).toBe("12345");
    expect(account.tokenGeneration).toBe(1);

    const row = await selectVaultRow(database(), connectionId, 1);
    expect(row).toBeDefined();
    const decrypted = decryptVaultRow(row!, vaultKeys.keys.get(vaultKeys.activeKeyId)!, connectionId, 1);
    expect(decrypted.toString()).toBe("fake-refresh-token");
  });

  it("rejects a request-origin mismatch between the callback and the encrypted state", async () => {
    const vaultKeys = createVaultKeyMap();
    const appClient = createFakeAppClient();
    const fakeClient = createFakeOAuth2Client();
    const provider = createGmailMailboxProvider({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://broker.test/callback",
      vaultKeys,
      database: database(),
      appClient,
      createOAuth2Client: () => fakeClient,
    });

    const state = createOAuthState({
      connectionId: randomUUID(),
      attemptId: randomUUID(),
      sessionNonce: "nonce",
      redirectOrigin: ALLOWED_ORIGIN,
      ttlSeconds: 600,
      vaultKeys,
    });

    await expect(
      provider.exchangeAuthorizationCode({
        code: "auth-code",
        state: state.state,
        requestOrigin: "https://evil.test",
      }),
    ).rejects.toThrow();
  });

  it("refresh-token rotation: acquires a lease, writes the new generation, advances, then disables the prior generation -- in that order", async () => {
    const vaultKeys = createVaultKeyMap();
    const appClient = createFakeAppClient();
    const fakeClient = createFakeOAuth2Client();
    const connectionId = randomUUID();

    const provider = createGmailMailboxProvider({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://broker.test/callback",
      vaultKeys,
      database: database(),
      appClient,
      createOAuth2Client: () => fakeClient,
      fetchProfile: async () => ({ emailAddress: "user2@example.test", historyId: "1" }),
    });

    const state = createOAuthState({
      connectionId,
      attemptId: randomUUID(),
      sessionNonce: "nonce",
      redirectOrigin: ALLOWED_ORIGIN,
      ttlSeconds: 600,
      vaultKeys,
    });
    await provider.exchangeAuthorizationCode({
      code: "auth-code",
      state: state.state,
      requestOrigin: ALLOWED_ORIGIN,
    });

    const callOrder: string[] = [];
    appClient.acquireTokenOperationLease.mockImplementationOnce(async (input) => {
      callOrder.push("acquireTokenOperationLease");
      const record = appClient.state.connections.get(input.connectionId) ?? {
        connectionVersion: 1,
        tokenGeneration: 1,
        leaseId: null,
      };
      record.leaseId = "lease-rotation";
      appClient.state.connections.set(input.connectionId, record);
      return {
        connectionId: input.connectionId,
        leaseId: "lease-rotation",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        expectedConnectionVersion: record.connectionVersion,
        currentTokenGeneration: record.tokenGeneration,
      };
    });
    const realAdvance = appClient.advanceTokenGeneration.getMockImplementation()!;
    appClient.advanceTokenGeneration.mockImplementationOnce(async (input) => {
      // Vault write (new generation row) must exist *before* this call.
      const row = await selectVaultRow(database(), connectionId, 2);
      expect(row).toBeDefined();
      callOrder.push("advanceTokenGeneration");
      return realAdvance(input);
    });

    fakeClient.emitTokens({ refresh_token: "rotated-refresh-token" });
    // Rotation runs asynchronously (fire-and-forget inside the 'tokens'
    // listener); wait for it to settle by polling for the new generation.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await selectVaultRow(database(), connectionId, 2)) !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(callOrder).toEqual(["acquireTokenOperationLease", "advanceTokenGeneration"]);

    const oldRow = await selectVaultRow(database(), connectionId, 1);
    const newRow = await selectVaultRow(database(), connectionId, 2);
    expect(oldRow?.disabled_at).not.toBeNull(); // disabled only after advance confirmed
    expect(newRow?.disabled_at).toBeNull();
    const decrypted = decryptVaultRow(newRow!, vaultKeys.keys.get(vaultKeys.activeKeyId)!, connectionId, 2);
    expect(decrypted.toString()).toBe("rotated-refresh-token");
  });

  it("revoke calls Google's revokeToken with the decrypted refresh token and disables every generation", async () => {
    const vaultKeys = createVaultKeyMap();
    const appClient = createFakeAppClient();
    const fakeClient = createFakeOAuth2Client();
    const connectionId = randomUUID();

    const provider = createGmailMailboxProvider({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://broker.test/callback",
      vaultKeys,
      database: database(),
      appClient,
      createOAuth2Client: () => fakeClient,
      fetchProfile: async () => ({ emailAddress: "user3@example.test", historyId: "1" }),
    });

    const state = createOAuthState({
      connectionId,
      attemptId: randomUUID(),
      sessionNonce: "nonce",
      redirectOrigin: ALLOWED_ORIGIN,
      ttlSeconds: 600,
      vaultKeys,
    });
    await provider.exchangeAuthorizationCode({
      code: "auth-code",
      state: state.state,
      requestOrigin: ALLOWED_ORIGIN,
    });

    await provider.revoke({ connectionId, operationId: randomUUID() });

    expect(fakeClient.revokeToken).toHaveBeenCalledWith("fake-refresh-token");
    const row = await selectVaultRow(database(), connectionId, 1);
    expect(row?.disabled_at).not.toBeNull();
  });

  it("discover() reconstructs an OAuth2Client from the vault's active generation when none is cached (e.g. a different broker replica)", async () => {
    const vaultKeys = createVaultKeyMap();
    const connectionId = randomUUID();

    // Provider A: a real OAuth exchange, same role as 3D-A's own flow,
    // populating the vault row that provider B (below) must read back.
    const providerA = createGmailMailboxProvider({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://broker.test/callback",
      vaultKeys,
      database: database(),
      appClient: createFakeAppClient(),
      createOAuth2Client: () => createFakeOAuth2Client(),
      fetchProfile: async () => ({ emailAddress: "user4@example.test", historyId: "1" }),
    });
    const state = createOAuthState({
      connectionId,
      attemptId: randomUUID(),
      sessionNonce: "nonce",
      redirectOrigin: ALLOWED_ORIGIN,
      ttlSeconds: 600,
      vaultKeys,
    });
    await providerA.exchangeAuthorizationCode({
      code: "auth-code",
      state: state.state,
      requestOrigin: ALLOWED_ORIGIN,
    });

    // Provider B: a fresh factory instance (its own empty `liveClients`
    // cache), pointed at the same vault database/keys -- simulates a
    // discover() call landing on a different broker replica than the one
    // that handled the original OAuth callback.
    const discoveryAppClient = {
      loadScanBinding: async (scanRunId: string) => ({
        scanRunId,
        connectionId,
        expectedConnectionVersion: 1,
        currentHistoryId: null,
        currentCursorDigest: "cursor-0",
        preFenceToken: "fence-0",
        nextPageSequence: 1,
      }),
      stageCandidateMetadata: async (input: { scanRunId: string; pageSequence: number }) => ({
        schemaVersion: 1 as const,
        scanRunId: input.scanRunId,
        pageSequence: input.pageSequence,
        candidateIds: [],
        counts: { discovered: 0, staged: 0, review: 0, failed: 0 },
      }),
    };
    const freshOAuth2Client = createFakeOAuth2Client();
    const discoveryGmailClient = {
      listMessageIds: async () => ({ ids: [] }),
      listHistory: async () => ({ historyId: "history-1", ids: [] }),
      getMessage: async () => {
        throw new Error("not reached in this test");
      },
      getAttachment: async () => Buffer.alloc(0),
      getProfileHistoryId: async () => "history-1",
    };

    const providerB = createGmailMailboxProvider({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://broker.test/callback",
      vaultKeys,
      database: database(),
      appClient: createFakeAppClient(),
      createOAuth2Client: () => freshOAuth2Client,
      discoveryAppClient,
      createGmailDiscoveryClient: () => discoveryGmailClient,
    });

    const scanRunId = randomUUID();
    const page = await providerB.discover({ connectionId, scanRunId });

    expect(freshOAuth2Client.setCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ refresh_token: "fake-refresh-token" }),
    );
    expect(page).toEqual({ scanRunId, pageSequence: 1, candidateCount: 0, retryCount: 0 });
  });
});

/**
 * Phase 3D-C Task 5 fix round 1 (review Important #3) -- pure, no
 * googleapis/network dependency, so directly unit-testable without the
 * "operator-gated, no real Google network" exemption the Gmail-API
 * wrapper methods around it still correctly claim.
 */
describe("decodeBase64UrlBounded", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("decodes a small input (under budget) completely and correctly", () => {
    const original = Buffer.from("a".repeat(100), "utf8");
    const result = decodeBase64UrlBounded(original.toString("base64url"), 1_000);
    expect(result.equals(original)).toBe(true);
  });

  it("never allocates/decodes beyond budget + 1 bytes, even for a huge input -- Buffer.from is called with a bounded-length string, never the full one", () => {
    const budget = 1_000;
    // ~10 MiB of base64url input (~7.5 MiB decoded) -- cheap to construct
    // (no real I/O), but large enough to prove the original "decode
    // everything, then subarray" bug would have fully decoded it.
    const huge = "A".repeat(10 * 1024 * 1024);
    const maxBase64CharsNeeded = Math.ceil((budget + 2) / 3) * 4;

    const bufferFromSpy = vi.spyOn(Buffer, "from");
    const result = decodeBase64UrlBounded(huge, budget);

    expect(result.length).toBe(budget + 1);
    expect(bufferFromSpy).toHaveBeenCalledTimes(1);
    const [decodedArg] = bufferFromSpy.mock.calls[0] as [string, string];
    expect(decodedArg.length).toBe(maxBase64CharsNeeded);
    expect(decodedArg.length).toBeLessThan(huge.length);
  });

  it("returns exactly budget bytes when the input decodes to precisely the budget (boundary, not oversized)", () => {
    const budget = 300;
    const exact = Buffer.alloc(budget, 0x41);
    const result = decodeBase64UrlBounded(exact.toString("base64url"), budget);
    expect(result.length).toBe(budget);
    expect(result.equals(exact)).toBe(true);
  });

  it("returns exactly budget + 1 bytes when the input is one byte over budget", () => {
    const budget = 300;
    const overByOne = Buffer.alloc(budget + 1, 0x42);
    const result = decodeBase64UrlBounded(overByOne.toString("base64url"), budget);
    expect(result.length).toBe(budget + 1);
    expect(result.equals(overByOne)).toBe(true);
  });
});

/**
 * Production bug fix -- a Gmail message's `Date` header is sender-
 * controlled and frequently unparseable (spam, broken clients);
 * `new Date(header).toISOString()` used to throw a RangeError on an
 * invalid value, which getMessage's old single `try` around the whole
 * method turned into a Gmail API "unknown" (503) that never let the
 * cursor advance. Pure, no googleapis/network dependency, directly
 * unit-testable the same way as decodeBase64UrlBounded above.
 */
describe("parseReceivedAt", () => {
  it("falls back to internalDate when the Date header is unparseable", () => {
    const internalDateMs = Date.UTC(2026, 9, 1, 12, 0, 0);
    const result = parseReceivedAt("not a date", String(internalDateMs));
    expect(result).toBe(new Date(internalDateMs).toISOString());
  });

  it("falls back to internalDate when there is no Date header", () => {
    const internalDateMs = Date.UTC(2026, 9, 1, 12, 0, 0);
    const result = parseReceivedAt("", String(internalDateMs));
    expect(result).toBe(new Date(internalDateMs).toISOString());
  });

  it("falls back to now() when neither the Date header nor internalDate is usable", () => {
    const fakeNow = new Date("2026-10-10T00:00:00.000Z");
    const result = parseReceivedAt("not a date", "also not a number", () => fakeNow);
    expect(result).toBe(fakeNow.toISOString());
  });

  it("falls back to now() when internalDate is missing entirely", () => {
    const fakeNow = new Date("2026-10-10T00:00:00.000Z");
    const result = parseReceivedAt("not a date", undefined, () => fakeNow);
    expect(result).toBe(fakeNow.toISOString());
  });

  it("uses a valid Date header even when internalDate differs", () => {
    const result = parseReceivedAt("Tue, 10 Oct 2026 12:00:00 +0000", String(Date.UTC(2020, 0, 1)));
    expect(result).toBe("2026-10-10T12:00:00.000Z");
  });
});
