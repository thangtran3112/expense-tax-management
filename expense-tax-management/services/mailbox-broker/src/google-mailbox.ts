/**
 * Phase 3D-A Task 3 — Gmail `MailboxProviderAdapter` implementation.
 *
 * Offline access, exact readonly scope
 * (`https://www.googleapis.com/auth/gmail.readonly`) -- no mailbox
 * modification, Pub/Sub, or Outlook implementation. Access tokens exist
 * only in broker memory (`liveClients`, this module's in-process cache,
 * keyed by connectionId, lost on restart by design -- AGENTS.md "Secrets
 * and OAuth Tokens"). Refresh tokens are AES-256-GCM ciphertext in the
 * token vault (token-vault.ts) only.
 *
 * No real Google network access in this task's tests: `createOAuth2Client`
 * is injectable (`GmailMailboxProviderOptions.createOAuth2Client`),
 * defaulting to a real `googleapis` `OAuth2Client`; tests substitute a
 * fake from `test-doubles.ts`. True Google-credential verification is
 * operator-gated (Task 6), per the brief.
 */
import { randomUUID } from "node:crypto";

import { google } from "googleapis";
import type { Kysely } from "kysely";

import type {
  ConnectedAccount,
  MailboxProvider,
  MailboxProviderAdapter,
  OAuthCallbackInput,
  OAuthStartInput,
  OAuthStartResult,
  RevokeConnectionInput,
} from "./contracts.js";
import type { MailboxBrokerConnectionAppClient } from "./contracts.js";
import type { VaultDatabase } from "./database/types.js";
import {
  createOAuthState,
  decodeOAuthStatePayload,
  OAuthStateInvalidError,
  type VaultKeyMap,
} from "./oauth-state.js";
import {
  addTokenGenerationCAS,
  createConnectionVaultRow,
  destroyTokenGeneration,
  disableTokenGeneration,
  revokeTokenGenerations,
  selectActiveVaultRowForConnection,
  decryptVaultRow,
} from "./token-vault.js";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export interface GmailProfile {
  readonly emailAddress: string;
  readonly historyId: string;
}

/** Minimal surface this module needs from googleapis' OAuth2Client -- the real shape, kept narrow so tests can substitute a fake. */
export interface OAuth2ClientLike {
  generateAuthUrl(options: Record<string, unknown>): string;
  getToken(options: {
    code: string;
    codeVerifier?: string;
  }): Promise<{ tokens: GoogleTokens }>;
  setCredentials(tokens: GoogleTokens): void;
  on(event: "tokens", listener: (tokens: GoogleTokens) => void): void;
  revokeToken(token: string): Promise<unknown>;
}

export interface GoogleTokens {
  readonly access_token?: string | null;
  readonly refresh_token?: string | null;
  readonly scope?: string;
  readonly expiry_date?: number | null;
}

export interface GmailMailboxProviderOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly vaultKeys: VaultKeyMap;
  readonly database: Kysely<VaultDatabase>;
  readonly appClient: MailboxBrokerConnectionAppClient;
  readonly stateTtlSeconds?: number;
  readonly leaseTtlSeconds?: number;
  readonly createOAuth2Client?: () => OAuth2ClientLike;
  readonly fetchProfile?: (client: OAuth2ClientLike) => Promise<GmailProfile>;
  readonly onRefreshRotationError?: (connectionId: string, error: unknown) => void;
}

function defaultOAuth2ClientFactory(options: GmailMailboxProviderOptions): () => OAuth2ClientLike {
  return () =>
    new google.auth.OAuth2(
      options.clientId,
      options.clientSecret,
      options.redirectUri,
    ) as unknown as OAuth2ClientLike;
}

type GmailAuthParam = NonNullable<Parameters<typeof google.gmail>[0]["auth"]>;

function defaultFetchProfile(client: OAuth2ClientLike): Promise<GmailProfile> {
  const gmail = google.gmail({ version: "v1", auth: client as unknown as GmailAuthParam });
  return gmail.users.getProfile({ userId: "me" }).then((response) => {
    const emailAddress = response.data.emailAddress;
    const historyId = response.data.historyId;
    if (!emailAddress || !historyId) {
      throw new Error("Gmail profile response missing emailAddress/historyId");
    }
    return { emailAddress, historyId };
  });
}

/**
 * Not individually exported in the brief's Interfaces list, but the only
 * way to learn a connection's currently-active generation before
 * rotating it (needed by both `exchangeAuthorizationCode`'s follow-on
 * rotation listener and `revoke`). Added to token-vault.ts as an
 * additive query helper alongside the four named CAS primitives.
 */
async function currentGeneration(
  database: Kysely<VaultDatabase>,
  connectionId: string,
): Promise<{ generation: number; keyId: string } | undefined> {
  const row = await selectActiveVaultRowForConnection(database, connectionId);
  return row ? { generation: row.generation, keyId: row.key_id } : undefined;
}

async function rotateRefreshToken(
  connectionId: string,
  newRefreshToken: string,
  options: GmailMailboxProviderOptions,
): Promise<void> {
  const active = await currentGeneration(options.database, connectionId);
  if (!active) return; // connection has no vault row (e.g. already revoked); nothing to rotate

  const operationId = randomUUID();
  const lease = await options.appClient.acquireTokenOperationLease({
    connectionId,
    operationId,
    ttlSeconds: options.leaseTtlSeconds ?? 300,
  });

  const activeKey = options.vaultKeys.keys.get(options.vaultKeys.activeKeyId);
  if (!activeKey) {
    await options.appClient.releaseTokenOperationLease({ connectionId, leaseId: lease.leaseId });
    throw new Error(`Active vault key "${options.vaultKeys.activeKeyId}" is not loaded`);
  }

  const newGeneration = active.generation + 1;
  const cas = await addTokenGenerationCAS(options.database, {
    connectionId,
    newGeneration,
    plaintext: Buffer.from(newRefreshToken, "utf8"),
    keyId: options.vaultKeys.activeKeyId,
    key: activeKey,
  });
  if (cas.status === "conflict") {
    // Vault write lost a race (e.g. concurrent key rotation already
    // claimed this generation). Release the lease and leave the prior
    // generation active -- never call advanceTokenGeneration.
    await options.appClient.releaseTokenOperationLease({ connectionId, leaseId: lease.leaseId });
    return;
  }

  try {
    await options.appClient.advanceTokenGeneration({
      connectionId,
      leaseId: lease.leaseId,
      expectedConnectionVersion: lease.expectedConnectionVersion,
      newGeneration,
      vaultReference: cas.vaultReference,
      requestId: operationId,
      idempotencyKey: operationId,
    });
  } catch (error) {
    await destroyTokenGeneration(options.database, connectionId, newGeneration);
    await options.appClient.releaseTokenOperationLease({ connectionId, leaseId: lease.leaseId });
    throw error;
  }

  // advanceTokenGeneration succeeded -- only now disable the prior
  // generation (it already cleared the lease as part of its own CAS).
  await disableTokenGeneration(options.database, connectionId, active.generation);
}

export function createGmailMailboxProvider(
  options: GmailMailboxProviderOptions,
): MailboxProviderAdapter {
  const createClient = options.createOAuth2Client ?? defaultOAuth2ClientFactory(options);
  const fetchProfile = options.fetchProfile ?? defaultFetchProfile;
  const liveClients = new Map<string, OAuth2ClientLike>();

  function registerRefreshRotation(connectionId: string, client: OAuth2ClientLike): void {
    client.on("tokens", (tokens) => {
      if (!tokens.refresh_token) return; // plain access-token refresh; nothing to persist
      rotateRefreshToken(connectionId, tokens.refresh_token, options).catch((error: unknown) => {
        options.onRefreshRotationError?.(connectionId, error);
      });
    });
  }

  return {
    async createAuthorizationUrl(input: OAuthStartInput): Promise<OAuthStartResult> {
      const stateResult = createOAuthState({
        connectionId: input.connectionId,
        attemptId: input.attemptId,
        sessionNonce: input.sessionNonce,
        redirectOrigin: input.redirectOrigin,
        ttlSeconds: options.stateTtlSeconds ?? 600,
        vaultKeys: options.vaultKeys,
      });

      const client = createClient();
      const authorizationUrl = client.generateAuthUrl({
        access_type: "offline",
        scope: [GMAIL_READONLY_SCOPE],
        include_granted_scopes: false,
        prompt: "consent",
        state: stateResult.state,
        code_challenge: stateResult.codeChallenge,
        code_challenge_method: "S256",
      });

      return {
        authorizationUrl,
        stateDigest: stateResult.stateDigest,
        expiresAt: stateResult.expiresAt,
      };
    },

    async exchangeAuthorizationCode(input: OAuthCallbackInput): Promise<ConnectedAccount> {
      const payload = decodeOAuthStatePayload(input.state, options.vaultKeys);
      if (payload.redirectOrigin !== input.requestOrigin) {
        throw new OAuthStateInvalidError("request origin mismatch");
      }

      const client = createClient();
      const { tokens } = await client.getToken({
        code: input.code,
        codeVerifier: payload.pkceVerifier,
      });

      if (!tokens.refresh_token) {
        throw new Error("Google did not return a refresh token (offline access required)");
      }

      const grantedScopes = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
      if (grantedScopes.length !== 1 || grantedScopes[0] !== GMAIL_READONLY_SCOPE) {
        throw new Error(`Unexpected Gmail OAuth scope grant: ${tokens.scope ?? ""}`);
      }

      client.setCredentials(tokens);
      const profile = await fetchProfile(client);

      const { vaultReference, tokenGeneration } = await createConnectionVaultRow(
        options.database,
        {
          connectionId: payload.connectionId,
          plaintext: Buffer.from(tokens.refresh_token, "utf8"),
          vaultKeys: options.vaultKeys,
        },
      );

      liveClients.set(payload.connectionId, client);
      registerRefreshRotation(payload.connectionId, client);

      return {
        providerAccountId: profile.emailAddress,
        email: profile.emailAddress,
        grantedScopes,
        initialHistoryId: profile.historyId,
        vaultReference,
        tokenGeneration,
      };
    },

    async revoke(input: RevokeConnectionInput): Promise<void> {
      const active = await currentGeneration(options.database, input.connectionId);
      const client = liveClients.get(input.connectionId) ?? createClient();

      if (active) {
        const row = await selectActiveVaultRowForConnection(options.database, input.connectionId);
        const key = row ? options.vaultKeys.keys.get(row.key_id) : undefined;
        if (row && key) {
          const refreshToken = decryptVaultRow(row, key, input.connectionId, row.generation).toString(
            "utf8",
          );
          await client.revokeToken(refreshToken);
        }
      }

      await revokeTokenGenerations(options.database, input.connectionId);
      liveClients.delete(input.connectionId);
    },
  };
}

export function createMailboxProviderAdapter(
  provider: MailboxProvider,
  options: GmailMailboxProviderOptions,
): MailboxProviderAdapter {
  if (provider === "outlook") {
    const error = new Error("PROVIDER_UNSUPPORTED");
    error.name = "PROVIDER_UNSUPPORTED";
    throw error;
  }
  return createGmailMailboxProvider(options);
}
