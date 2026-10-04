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
  DiscoveryInput,
  DiscoveryPageV1,
  MailboxBrokerDiscoveryAppClient,
  MailboxDiscoveryProviderAdapter,
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
  createDiscoveryEngine,
  GmailApiError,
  type GmailDiscoveryClientLike,
  type GmailMessageDetail,
} from "./discovery.js";
import { STRUCTURED_RECEIPT_MAX_DECODED_BYTES } from "./structured-receipt.js";
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
  /**
   * Phase 3D-B Task 4 -- `discover()` support. Optional and separate from
   * the required `appClient` above: most existing callers of this
   * factory (every OAuth-only test in this suite, unchanged) never call
   * `discover()`, so they are not required to supply a discovery-capable
   * client. The real `server.ts` passes the same `createMailboxAppClient`
   * instance for both (it already implements both interfaces).
   */
  readonly discoveryAppClient?: MailboxBrokerDiscoveryAppClient;
  /** Defaults to a real `googleapis` Gmail v1 client wrapper; tests substitute a fake (no real Google network access). */
  readonly createGmailDiscoveryClient?: (client: OAuth2ClientLike) => GmailDiscoveryClientLike;
  readonly discoveryPageSize?: number;
  readonly discoveryLookbackDays?: number;
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
 * Phase 3D-B Task 4 -- real `googleapis` Gmail v1 wrapper satisfying
 * `GmailDiscoveryClientLike` (discovery.ts). Operator-gated (no test in
 * this task makes a real Google network call, per the brief); covered
 * indirectly by discovery.test.ts's fakes exercising the narrow
 * interface this wraps.
 *
 * Fix round 1 (review Important #6) -- `mapGoogleApiError` never
 * re-throws the raw googleapis error (which can carry request URLs,
 * headers, or other internals in its message/body): every failure maps
 * to one of `GmailApiError`'s five typed, static-message codes, falling
 * back to `"unknown"` for anything unrecognized. Reads a `Retry-After`
 * response header (seconds) when present and attaches it so
 * `withGoogleRetry` can honor it.
 */
function parseRetryAfterMs(error: unknown): number | undefined {
  const headers = (error as { response?: { headers?: Record<string, unknown> } } | undefined)?.response
    ?.headers;
  const raw = headers?.["retry-after"];
  const seconds = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : undefined;
  return seconds !== undefined && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function mapGoogleApiError(error: unknown): never {
  const status = (error as { code?: number; response?: { status?: number } } | undefined)?.response
    ?.status ?? (error as { code?: number } | undefined)?.code;
  const retryAfterMs = parseRetryAfterMs(error);
  if (status === 404) throw new GmailApiError("not_found");
  if (status === 401) throw new GmailApiError("reauth_required");
  if (status === 429) throw new GmailApiError("rate_limited", "Gmail API request failed: rate_limited", retryAfterMs);
  if (typeof status === "number" && status >= 500) {
    throw new GmailApiError("unavailable", "Gmail API request failed: unavailable", retryAfterMs);
  }
  throw new GmailApiError("unknown");
}

function createRealGmailDiscoveryClient(client: OAuth2ClientLike): GmailDiscoveryClientLike {
  const gmail = google.gmail({ version: "v1", auth: client as unknown as GmailAuthParam });

  function parseAttachmentParts(
    part:
      | {
          parts?: unknown[];
          filename?: string | null;
          mimeType?: string | null;
          body?: { attachmentId?: string | null; size?: number | null };
        }
      | undefined,
  ): { attachmentId: string; filename: string; mimeType: string; sizeBytes: number }[] {
    if (!part) return [];
    const results: { attachmentId: string; filename: string; mimeType: string; sizeBytes: number }[] = [];
    if (part.filename && part.body?.attachmentId && part.mimeType) {
      results.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType,
        sizeBytes: part.body.size ?? 0,
      });
    }
    for (const child of part.parts ?? []) {
      results.push(...parseAttachmentParts(child as typeof part));
    }
    return results;
  }

  /**
   * Depth-first search for the first `text/html` MIME part's inline
   * `body.data` (base64url) -- never an attachment part (those have no
   * inline `body.data`, only `body.attachmentId`, and are out of scope
   * for structured-receipt parsing).
   */
  function findHtmlPartData(
    part: { parts?: unknown[]; mimeType?: string | null; body?: { data?: string | null } } | undefined,
  ): string | null {
    if (!part) return null;
    if (part.mimeType === "text/html" && part.body?.data) return part.body.data;
    for (const child of part.parts ?? []) {
      const found = findHtmlPartData(child as typeof part);
      if (found !== null) return found;
    }
    return null;
  }

  async function* chunksOf(buffer: Buffer, chunkSize = 64 * 1024): AsyncIterable<Buffer> {
    for (let offset = 0; offset < buffer.length; offset += chunkSize) {
      yield buffer.subarray(offset, offset + chunkSize);
    }
  }

  return {
    async listMessageIds(input) {
      try {
        const response = await gmail.users.messages.list({
          userId: "me",
          q: input.query,
          maxResults: input.maxResults,
        });
        return {
          ids: (response.data.messages ?? []).map((message) => ({
            id: message.id as string,
            threadId: message.threadId ?? null,
          })),
        };
      } catch (error) {
        mapGoogleApiError(error);
      }
    },

    async listHistory(input) {
      // Fix round 2 (review Critical #2, re-review) -- exactly one raw
      // Gmail API page per call: `pageToken` resumes a prior call,
      // `nextPageToken` is surfaced (never aggregated/truncated
      // internally), so discovery.ts decides whether to continue and
      // never advances the cursor while one remains.
      try {
        const response = await gmail.users.history.list({
          userId: "me",
          startHistoryId: input.startHistoryId,
          historyTypes: ["messageAdded"],
          ...(input.pageToken ? { pageToken: input.pageToken } : {}),
        });
        const ids: { id: string; threadId: string | null }[] = [];
        for (const entry of response.data.history ?? []) {
          for (const added of entry.messagesAdded ?? []) {
            if (added.message?.id) {
              ids.push({ id: added.message.id, threadId: added.message.threadId ?? null });
            }
          }
        }
        return {
          historyId: response.data.historyId ?? input.startHistoryId,
          ids,
          nextPageToken: response.data.nextPageToken ?? null,
        };
      } catch (error) {
        mapGoogleApiError(error);
      }
    },

    async getMessage(id): Promise<GmailMessageDetail> {
      try {
        const response = await gmail.users.messages.get({ userId: "me", id, format: "full" });
        const headers = response.data.payload?.headers ?? [];
        const header = (name: string) =>
          headers.find((candidate) => candidate.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
        const dateHeader = header("date");
        return {
          id: response.data.id as string,
          threadId: response.data.threadId ?? null,
          receivedAt: dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString(),
          senderAddress: header("from"),
          subject: header("subject"),
          attachments: parseAttachmentParts(response.data.payload ?? undefined),
        };
      } catch (error) {
        mapGoogleApiError(error);
      }
    },

    async getAttachment(input) {
      try {
        const response = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId: input.messageId,
          id: input.attachmentId,
        });
        return Buffer.from(response.data.data ?? "", "base64url");
      } catch (error) {
        mapGoogleApiError(error);
      }
    },

    async getProfileHistoryId() {
      try {
        const response = await gmail.users.getProfile({ userId: "me" });
        if (!response.data.historyId) throw new Error("Gmail profile response missing historyId");
        return response.data.historyId;
      } catch (error) {
        mapGoogleApiError(error);
      }
    },

    /**
     * Phase 3D-C Task 5 gap closure -- bounded `text/html` body fetch.
     * Gmail's API has no partial/range fetch for a message body, so the
     * full message still arrives over the wire in one response (same as
     * `getMessage` above); the bound this enforces is on what gets
     * decoded and handed onward: never more than
     * `STRUCTURED_RECEIPT_MAX_DECODED_BYTES + 1` bytes, so the parser's
     * own existing `readBoundedUtf8` bound check (structured-receipt.ts)
     * still sees -- and rejects -- an oversized body, without this
     * function ever buffering the full oversized content for longer than
     * one `Buffer.subarray` call. Never logs or returns the body through
     * any path other than this bounded AsyncIterable.
     */
    async getMessageHtmlBody(id) {
      try {
        const response = await gmail.users.messages.get({ userId: "me", id, format: "full" });
        const htmlData = findHtmlPartData(response.data.payload ?? undefined);
        if (htmlData === null) return null;
        const decoded = Buffer.from(htmlData, "base64url");
        const bounded =
          decoded.length > STRUCTURED_RECEIPT_MAX_DECODED_BYTES
            ? decoded.subarray(0, STRUCTURED_RECEIPT_MAX_DECODED_BYTES + 1)
            : decoded;
        return chunksOf(bounded);
      } catch (error) {
        mapGoogleApiError(error);
      }
    },
  };
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
): MailboxProviderAdapter & MailboxDiscoveryProviderAdapter {
  const createClient = options.createOAuth2Client ?? defaultOAuth2ClientFactory(options);
  const fetchProfile = options.fetchProfile ?? defaultFetchProfile;
  const createDiscoveryClient = options.createGmailDiscoveryClient ?? createRealGmailDiscoveryClient;
  const liveClients = new Map<string, OAuth2ClientLike>();

  function registerRefreshRotation(connectionId: string, client: OAuth2ClientLike): void {
    client.on("tokens", (tokens) => {
      if (!tokens.refresh_token) return; // plain access-token refresh; nothing to persist
      rotateRefreshToken(connectionId, tokens.refresh_token, options).catch((error: unknown) => {
        options.onRefreshRotationError?.(connectionId, error);
      });
    });
  }

  /**
   * Phase 3D-B Task 4 -- `discover()` needs an authenticated OAuth2Client
   * for a connection independent of whether this same broker process
   * instance handled that connection's original OAuth exchange (a
   * discovery call can land on any broker replica). Reconstructs one
   * from the token vault's active generation when not already cached.
   */
  async function loadOrCreateOAuth2Client(connectionId: string): Promise<OAuth2ClientLike> {
    const cached = liveClients.get(connectionId);
    if (cached) return cached;

    const row = await selectActiveVaultRowForConnection(options.database, connectionId);
    if (!row) throw new Error(`No active vault row for connection "${connectionId}"`);
    const key = options.vaultKeys.keys.get(row.key_id);
    if (!key) throw new Error(`Vault key "${row.key_id}" is not loaded`);
    const refreshToken = decryptVaultRow(row, key, connectionId, row.generation).toString("utf8");

    const client = createClient();
    client.setCredentials({ refresh_token: refreshToken });
    liveClients.set(connectionId, client);
    registerRefreshRotation(connectionId, client);
    return client;
  }

  const discoveryEngine = createDiscoveryEngine({
    appClient: options.discoveryAppClient ?? {
      loadScanBinding(): Promise<never> {
        throw new Error("discover() requires GmailMailboxProviderOptions.discoveryAppClient to be configured");
      },
      stageCandidateMetadata(): Promise<never> {
        throw new Error("discover() requires GmailMailboxProviderOptions.discoveryAppClient to be configured");
      },
    },
    getGmailClient: async (connectionId) => createDiscoveryClient(await loadOrCreateOAuth2Client(connectionId)),
    ...(options.discoveryPageSize !== undefined ? { pageSize: options.discoveryPageSize } : {}),
    ...(options.discoveryLookbackDays !== undefined ? { lookbackDays: options.discoveryLookbackDays } : {}),
  });

  return {
    async discover(input: DiscoveryInput): Promise<DiscoveryPageV1> {
      return discoveryEngine.discover(input);
    },

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
): MailboxProviderAdapter & MailboxDiscoveryProviderAdapter {
  if (provider === "outlook") {
    const error = new Error("PROVIDER_UNSUPPORTED");
    error.name = "PROVIDER_UNSUPPORTED";
    throw error;
  }
  return createGmailMailboxProvider(options);
}
