/**
 * Phase 3D-A Task 3 — shared test doubles. No real Google, GCP, or Clerk
 * network calls anywhere in this module; every fake is an in-memory
 * stand-in with the exact surface its real counterpart exposes to this
 * service's own code.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWTPayload } from "jose";
import { vi } from "vitest";

import { MailboxAppClientError } from "./app-client.js";
import type {
  AdvanceTokenGenerationResult,
  MailboxBrokerConnectionAppClient,
  TokenOperationLeaseV1,
} from "./contracts.js";
import type { GoogleTokens, OAuth2ClientLike } from "./google-mailbox.js";
import type { VaultKeyMap } from "./oauth-state.js";

/** A fresh 32-byte AES-256 key, base64-encoded -- matches MAILBOX_VAULT_KEYS' own entry shape. */
export function generateVaultKeyMaterial(): string {
  return randomBytes(32).toString("base64");
}

export function createVaultKeyMap(options: {
  readonly activeKeyId?: string;
  readonly extraKeys?: Readonly<Record<string, Buffer>>;
} = {}): VaultKeyMap {
  const activeKeyId = options.activeKeyId ?? "key-1";
  const keys = new Map<string, Buffer>([[activeKeyId, randomBytes(32)]]);
  for (const [keyId, material] of Object.entries(options.extraKeys ?? {})) {
    keys.set(keyId, material);
  }
  return { keys, activeKeyId };
}

export interface FakeAppClientState {
  readonly connections: Map<
    string,
    { connectionVersion: number; tokenGeneration: number; leaseId: string | null }
  >;
}

export interface FakeAppClientOptions {
  readonly advanceTokenGenerationImpl?: MailboxBrokerConnectionAppClient["advanceTokenGeneration"];
}

/**
 * A fake `MailboxBrokerConnectionAppClient` with just enough CAS
 * semantics (lease/advance/release) to drive key-rotation and
 * refresh-token-rotation ordering tests without a real App API or
 * network.
 */
export function createFakeAppClient(
  options: FakeAppClientOptions = {},
): MailboxBrokerConnectionAppClient & { readonly state: FakeAppClientState } {
  const state: FakeAppClientState = { connections: new Map() };
  const idempotencyLedger = new Map<string, AdvanceTokenGenerationResult>();

  function connectionRecord(connectionId: string) {
    let record = state.connections.get(connectionId);
    if (!record) {
      record = { connectionVersion: 1, tokenGeneration: 1, leaseId: null };
      state.connections.set(connectionId, record);
    }
    return record;
  }

  return {
    state,
    consumeOAuthAttempt: vi.fn(async () => ({
      status: "consumed" as const,
      connectionVersion: 1,
    })),
    completeConnection: vi.fn(async (input) => ({
      schemaVersion: 1 as const,
      id: input.connectionId,
      tenantId: "tenant",
      ownerUserId: "owner",
      provider: "gmail" as const,
      providerAccountId: input.providerAccountId,
      accountEmail: input.email,
      scope: { kind: "personal" as const, profileId: "profile" },
      status: "active" as const,
      grantedScopes: input.grantedScopes,
      timezone: "UTC",
      localScanTime: "07:00",
      scanEnabled: true,
      lastScanAt: null,
      nextScheduleAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revokedAt: null,
    })),
    acquireTokenOperationLease: vi.fn(async (input): Promise<TokenOperationLeaseV1> => {
      const record = connectionRecord(input.connectionId);
      const leaseId = randomUUID();
      record.leaseId = leaseId;
      return {
        connectionId: input.connectionId,
        leaseId,
        expiresAt: new Date(Date.now() + input.ttlSeconds * 1_000).toISOString(),
        expectedConnectionVersion: record.connectionVersion,
        currentTokenGeneration: record.tokenGeneration,
      };
    }),
    advanceTokenGeneration:
      options.advanceTokenGenerationImpl ??
      vi.fn(async (input) => {
        // Real App API's advanceTokenGeneration is a permanent-ledger
        // idempotent operation keyed on idempotencyKey (Task 2): a
        // resumed call with the exact same idempotencyKey replays the
        // original committed result, it never re-checks lease/version.
        const existing = idempotencyLedger.get(input.idempotencyKey);
        if (existing) return existing;

        const record = connectionRecord(input.connectionId);
        if (
          record.leaseId !== input.leaseId ||
          record.connectionVersion !== input.expectedConnectionVersion ||
          input.newGeneration !== record.tokenGeneration + 1
        ) {
          throw new MailboxAppClientError("conflict", 409);
        }
        record.tokenGeneration = input.newGeneration;
        record.connectionVersion += 1;
        record.leaseId = null;
        const result = {
          connectionVersion: record.connectionVersion,
          tokenGeneration: record.tokenGeneration,
          vaultReference: input.vaultReference,
        };
        idempotencyLedger.set(input.idempotencyKey, result);
        return result;
      }),
    releaseTokenOperationLease: vi.fn(async (input) => {
      const record = state.connections.get(input.connectionId);
      if (record && record.leaseId === input.leaseId) {
        record.leaseId = null;
      }
    }),
    recordRevocation: vi.fn(async (input) => ({
      schemaVersion: 1 as const,
      id: input.connectionId,
      tenantId: "tenant",
      ownerUserId: "owner",
      provider: "gmail" as const,
      providerAccountId: "revoked",
      accountEmail: "revoked@example.test",
      scope: { kind: "personal" as const, profileId: "profile" },
      status: input.status,
      grantedScopes: [],
      timezone: "UTC",
      localScanTime: "07:00",
      scanEnabled: false,
      lastScanAt: null,
      nextScheduleAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revokedAt: new Date().toISOString(),
    })),
  };
}

export interface FakeOAuth2ClientOptions {
  readonly tokens?: GoogleTokens;
}

/** A fake `OAuth2ClientLike` -- no real Google network access. */
export function createFakeOAuth2Client(options: FakeOAuth2ClientOptions = {}): OAuth2ClientLike & {
  emitTokens(tokens: GoogleTokens): void;
} {
  const listeners: ((tokens: GoogleTokens) => void)[] = [];
  return {
    generateAuthUrl: vi.fn((input: Record<string, unknown>) => {
      const params = new URLSearchParams({ state: String(input.state ?? "") });
      return `https://accounts.google.test/o/oauth2/auth?${params.toString()}`;
    }),
    getToken: vi.fn(async () => ({
      tokens: options.tokens ?? {
        access_token: "fake-access-token",
        refresh_token: "fake-refresh-token",
        scope: "https://www.googleapis.com/auth/gmail.readonly",
        expiry_date: Date.now() + 3_600_000,
      },
    })),
    setCredentials: vi.fn(),
    on: vi.fn((_event: "tokens", listener: (tokens: GoogleTokens) => void) => {
      listeners.push(listener);
    }),
    revokeToken: vi.fn(async () => undefined),
    emitTokens(tokens: GoogleTokens) {
      for (const listener of listeners) listener(tokens);
    },
  };
}

export interface FakeClerkIssuer {
  readonly issuerUrl: string;
  readonly jwksUrl: string;
  readonly keyResolver: (
    protectedHeader: unknown,
    token: unknown,
  ) => Promise<CryptoKey>;
  mint(claims: {
    readonly subject: string;
    readonly audience: string;
    readonly scopes: readonly string[];
    readonly expiresInSeconds?: number;
  }): Promise<string>;
}

/**
 * A fake Clerk JWKS + signer, entirely in-memory (no network). Used by
 * auth.test.ts and app-client.test.ts/machine-token round-trips.
 */
export async function createFakeClerkIssuer(options: {
  readonly issuerUrl?: string;
} = {}): Promise<FakeClerkIssuer> {
  const issuerUrl = options.issuerUrl ?? "https://clerk.test";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);

  const keyResolver = async () => {
    return (await importJWK({ ...publicJwk, alg: "RS256" }, "RS256")) as CryptoKey;
  };

  return {
    issuerUrl,
    jwksUrl: `${issuerUrl}/.well-known/jwks.json`,
    keyResolver,
    async mint(claims): Promise<string> {
      const payload: JWTPayload = { scope: claims.scopes.join(" ") };
      return new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(issuerUrl)
        .setAudience(claims.audience)
        .setSubject(claims.subject)
        .setJti(randomUUID())
        .setIssuedAt()
        .setExpirationTime(`${claims.expiresInSeconds ?? 300}s`)
        .sign(privateKey);
    },
  };
}
