/**
 * Phase 3D-A Task 2 — App connection/OAuth domain and exact state-consume
 * compare-and-set.
 *
 * App API owns all connection metadata, OAuth attempt state, and the
 * permanent operation-key ledger (migration 018, Task 1). The broker owns
 * Google OAuth, provider calls, and its own token-vault database; this
 * module never sees a token, authorization code, or PKCE verifier --
 * only the opaque vaultReference pointer and the connection's active
 * tokenGeneration.
 *
 * Six domain functions (see task-2-brief.md "Interfaces"):
 * - startConnection: entitlement/scope-checked, creates (or reuses) the
 *   connection row and an OAuth attempt, calls the broker for an
 *   authorizationUrl, and persists only sha256(sessionNonce).
 * - consumeOAuthState: the broker's one-time state-consume CAS --
 *   constant-time digest compare, redirect-origin allowlist, expiry.
 * - completeConnection: generation-1 activation CAS from 'consumed';
 *   replay-safe via the permanent operation-key ledger.
 * - acquireTokenOperationLease / advanceTokenGeneration /
 *   releaseTokenOperationLease: the token-generation pointer CAS described
 *   in the plan's "Canonical A Contracts" section.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import {
  mailboxIdempotencyKey,
  type AdvanceTokenGenerationInput,
  type AdvanceTokenGenerationResult,
  type MailboxConnectionRecordV1,
  type MailboxConnectionV1,
  type MailboxOAuthAttemptV1,
  type MailboxScope,
  type TokenOperationLeaseV1,
} from "@expense-tax/contracts";
import { sql, type Kysely, type Selectable } from "kysely";

import type { AppDatabase } from "../database/types.js";
import { DomainError } from "../errors.js";
import { requireScopeRole } from "./files.js";
import { hashNormalizedRequest, toJsonValue } from "./idempotency.js";
import type { MailboxBrokerClient } from "../integrations/mailbox-broker-client.js";

type ConnectionRow = Selectable<AppDatabase["app.mailbox_connections"]>;
type AttemptRow = Selectable<AppDatabase["app.mailbox_oauth_attempts"]>;

/**
 * Placeholder values for the NOT NULL provider_account_id/account_email/
 * vault_reference columns (migration 018) before the broker's OAuth
 * exchange completes. completeConnection overwrites all three atomically.
 */
const PENDING_PLACEHOLDER = "pending-activation";

const HEX64 = /^[a-f0-9]{64}$/;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time compare of two lowercase-hex SHA-256 digests. */
function digestsEqual(a: string, b: string): boolean {
  if (!HEX64.test(a) || !HEX64.test(b)) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function toMailboxScope(
  row: Pick<ConnectionRow, "personal_profile_id" | "business_id">,
): MailboxScope {
  return row.personal_profile_id !== null
    ? { kind: "personal", profileId: row.personal_profile_id }
    : { kind: "business", businessId: row.business_id as string };
}

function toMailboxConnectionV1(row: ConnectionRow): MailboxConnectionV1 {
  return {
    schemaVersion: 1,
    id: row.id,
    tenantId: row.tenant_id,
    ownerUserId: row.owner_user_id,
    provider: row.provider,
    providerAccountId: row.provider_account_id,
    accountEmail: row.account_email,
    scope: toMailboxScope(row),
    status: row.status,
    grantedScopes: row.granted_scopes,
    timezone: row.timezone,
    localScanTime: row.local_scan_time,
    scanEnabled: row.scan_enabled,
    lastScanAt: row.last_scan_at ? row.last_scan_at.toISOString() : null,
    nextScheduleAt: row.next_schedule_at ? row.next_schedule_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}

function toMailboxConnectionRecordV1(row: ConnectionRow): MailboxConnectionRecordV1 {
  return {
    ...toMailboxConnectionV1(row),
    vaultReference: row.vault_reference,
    tokenGeneration: row.token_generation,
    connectionVersion: row.connection_version,
    tokenOperationLeaseId: row.token_operation_lease_id,
    tokenOperationLeaseExpiresAt: row.token_operation_lease_expires_at
      ? row.token_operation_lease_expires_at.toISOString()
      : null,
    activeScanRunId: row.active_scan_run_id,
    activeScanLeaseExpiresAt: row.active_scan_lease_expires_at
      ? row.active_scan_lease_expires_at.toISOString()
      : null,
  };
}

function toMailboxOAuthAttemptV1(row: AttemptRow): MailboxOAuthAttemptV1 {
  return {
    schemaVersion: 1,
    id: row.id,
    connectionId: row.connection_id,
    tenantId: row.tenant_id,
    actorUserId: row.actor_user_id,
    stateDigest: row.state_digest,
    sessionNonceDigest: row.session_nonce_digest,
    redirectOrigin: row.redirect_origin,
    expiresAt: row.expires_at.toISOString(),
    status: row.status,
    createdAt: row.created_at.toISOString(),
    consumedAt: row.consumed_at ? row.consumed_at.toISOString() : null,
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

export interface StartConnectionInput {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly scope: MailboxScope;
  readonly sessionNonce: string;
  readonly redirectOrigin: string;
  readonly timezone: string;
  readonly localScanTime: string;
  readonly requestId: string;
}

export interface StartConnectionResult {
  readonly connection: MailboxConnectionV1;
  readonly attempt: MailboxOAuthAttemptV1;
  readonly authorizationUrl: string;
}

export interface ConsumeOAuthStateInput {
  readonly attemptId: string;
  readonly connectionId: string;
  readonly stateDigest: string;
  readonly sessionNonceDigest: string;
  readonly requestId: string;
}

export interface ConsumeOAuthStateResult {
  readonly connectionId: string;
  readonly attemptId: string;
  readonly redirectOrigin: string;
}

export interface CompleteConnectionInput {
  readonly attemptId: string;
  readonly connectionId: string;
  readonly vaultReference: string;
  readonly providerAccountId: string;
  readonly accountEmail: string;
  readonly grantedScopes: readonly string[];
  readonly initialHistoryId: string;
  readonly tokenGeneration: number;
  readonly requestId: string;
}

export interface AcquireTokenOperationLeaseInput {
  readonly connectionId: string;
  readonly operationId: string;
  readonly ttlSeconds: number;
}

export interface ReleaseTokenOperationLeaseInput {
  readonly connectionId: string;
  readonly leaseId: string;
}

export interface MailboxConnectionsDomain {
  startConnection(input: StartConnectionInput): Promise<StartConnectionResult>;
  consumeOAuthState(input: ConsumeOAuthStateInput): Promise<ConsumeOAuthStateResult>;
  completeConnection(input: CompleteConnectionInput): Promise<MailboxConnectionRecordV1>;
  acquireTokenOperationLease(
    input: AcquireTokenOperationLeaseInput,
  ): Promise<TokenOperationLeaseV1>;
  advanceTokenGeneration(
    input: AdvanceTokenGenerationInput,
  ): Promise<AdvanceTokenGenerationResult>;
  releaseTokenOperationLease(input: ReleaseTokenOperationLeaseInput): Promise<void>;
}

export interface MailboxConnectionsDomainOptions {
  /**
   * Exact-match allowlist of trusted redirect origins. Checked both when a
   * connection attempt is started (reject an untrusted caller-supplied
   * origin outright) and defensively again at consume time (the stored
   * origin must still be trusted).
   */
  readonly allowedRedirectOrigins: readonly string[];
}

async function findOrCreateConnectionId(
  database: Kysely<AppDatabase>,
  input: StartConnectionInput,
): Promise<string> {
  const existing =
    input.scope.kind === "personal"
      ? await database
          .selectFrom("app.mailbox_connections")
          .select("id")
          .where("tenant_id", "=", input.tenantId)
          .where("provider", "=", "gmail")
          .where("personal_profile_id", "=", input.scope.profileId)
          .where("status", "!=", "revoked")
          .executeTakeFirst()
      : await database
          .selectFrom("app.mailbox_connections")
          .select("id")
          .where("tenant_id", "=", input.tenantId)
          .where("provider", "=", "gmail")
          .where("business_id", "=", input.scope.businessId)
          .where("status", "!=", "revoked")
          .executeTakeFirst();

  if (existing) return existing.id;

  const id = randomUUID();
  const now = new Date();
  await database
    .insertInto("app.mailbox_connections")
    .values({
      id,
      tenant_id: input.tenantId,
      personal_profile_id: input.scope.kind === "personal" ? input.scope.profileId : null,
      business_id: input.scope.kind === "business" ? input.scope.businessId : null,
      owner_user_id: input.actorUserId,
      provider: "gmail",
      provider_account_id: PENDING_PLACEHOLDER,
      account_email: PENDING_PLACEHOLDER,
      status: "pending",
      granted_scopes: [],
      timezone: input.timezone,
      local_scan_time: input.localScanTime,
      scan_enabled: true,
      vault_reference: PENDING_PLACEHOLDER,
      created_at: now,
      updated_at: now,
    })
    .execute();

  return id;
}

export function createMailboxConnectionsDomain(
  database: Kysely<AppDatabase>,
  brokerClient: MailboxBrokerClient,
  options: MailboxConnectionsDomainOptions,
): MailboxConnectionsDomain {
  const allowedRedirectOrigins = new Set(options.allowedRedirectOrigins);

  return {
    async startConnection(input) {
      await requireScopeRole(database, {
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        scope: input.scope,
      });
      if (!allowedRedirectOrigins.has(input.redirectOrigin)) {
        throw DomainError.validation();
      }

      const sessionNonceDigest = sha256Hex(input.sessionNonce);
      const connectionId = await findOrCreateConnectionId(database, input);
      const attemptId = randomUUID();

      const started = await brokerClient.startOAuth({
        connectionId,
        attemptId,
        sessionNonce: input.sessionNonce,
        redirectOrigin: input.redirectOrigin,
      });

      const now = new Date();
      const attemptRow = await database
        .insertInto("app.mailbox_oauth_attempts")
        .values({
          id: attemptId,
          connection_id: connectionId,
          tenant_id: input.tenantId,
          actor_user_id: input.actorUserId,
          state_digest: started.stateDigest,
          session_nonce_digest: sessionNonceDigest,
          redirect_origin: input.redirectOrigin,
          expires_at: new Date(started.expiresAt),
          status: "pending",
          created_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const connectionRow = await database
        .selectFrom("app.mailbox_connections")
        .selectAll()
        .where("id", "=", connectionId)
        .where("tenant_id", "=", input.tenantId)
        .executeTakeFirstOrThrow();

      return {
        connection: toMailboxConnectionV1(connectionRow),
        attempt: toMailboxOAuthAttemptV1(attemptRow),
        authorizationUrl: started.authorizationUrl,
      };
    },

    async consumeOAuthState(input) {
      // Expiry must be persisted even though the call ultimately fails, so
      // it is marked and committed in its own pass before throwing --
      // transaction().execute() rolls back on any thrown error, which would
      // otherwise silently undo the 'expired' write together with the
      // rejection.
      const expired = await database.transaction().execute(async (transaction) => {
        const attempt = await transaction
          .selectFrom("app.mailbox_oauth_attempts")
          .selectAll()
          .where("id", "=", input.attemptId)
          .where("connection_id", "=", input.connectionId)
          .forUpdate()
          .executeTakeFirst();

        if (!attempt) throw DomainError.notFound();
        if (attempt.status !== "pending") throw DomainError.conflict();

        if (attempt.expires_at.getTime() <= Date.now()) {
          await transaction
            .updateTable("app.mailbox_oauth_attempts")
            .set({ status: "expired" })
            .where("id", "=", attempt.id)
            .where("status", "=", "pending")
            .execute();
          return true;
        }
        return false;
      });
      if (expired) throw DomainError.gone("OAuth attempt has expired");

      return database.transaction().execute(async (transaction) => {
        const attempt = await transaction
          .selectFrom("app.mailbox_oauth_attempts")
          .selectAll()
          .where("id", "=", input.attemptId)
          .where("connection_id", "=", input.connectionId)
          .forUpdate()
          .executeTakeFirst();

        if (!attempt) throw DomainError.notFound();
        if (attempt.status !== "pending") throw DomainError.conflict();

        const now = new Date();
        if (!digestsEqual(input.stateDigest, attempt.state_digest)) {
          throw DomainError.notFound();
        }
        if (!digestsEqual(input.sessionNonceDigest, attempt.session_nonce_digest)) {
          throw DomainError.notFound();
        }
        if (!allowedRedirectOrigins.has(attempt.redirect_origin)) {
          throw DomainError.validation();
        }

        const updated = await transaction
          .updateTable("app.mailbox_oauth_attempts")
          .set({ status: "consumed", consumed_at: now })
          .where("id", "=", attempt.id)
          .where("status", "=", "pending")
          .returningAll()
          .executeTakeFirst();

        if (!updated) throw DomainError.conflict();

        return {
          connectionId: updated.connection_id,
          attemptId: updated.id,
          redirectOrigin: updated.redirect_origin,
        };
      });
    },

    async completeConnection(input) {
      const operationKey = `complete-connection:${input.attemptId}`;
      const payloadHash = hashNormalizedRequest({
        vaultReference: input.vaultReference,
        providerAccountId: input.providerAccountId,
        accountEmail: input.accountEmail,
        grantedScopes: [...input.grantedScopes].sort(),
        tokenGeneration: input.tokenGeneration,
      });

      return database.transaction().execute(async (transaction) => {
        const attempt = await transaction
          .selectFrom("app.mailbox_oauth_attempts")
          .selectAll()
          .where("id", "=", input.attemptId)
          .where("connection_id", "=", input.connectionId)
          .forUpdate()
          .executeTakeFirst();

        if (!attempt) throw DomainError.notFound();

        if (attempt.status === "completed") {
          const existingKey = await transaction
            .selectFrom("app.mailbox_operation_keys")
            .select(["normalized_request_hash", "response_json"])
            .where("tenant_id", "=", attempt.tenant_id)
            .where("operation_key", "=", operationKey)
            .executeTakeFirst();
          if (!existingKey || existingKey.normalized_request_hash !== payloadHash) {
            // OAUTH_REPLAY: a completed attempt cannot be completed again
            // with different activation data.
            throw DomainError.conflict();
          }
          return existingKey.response_json as unknown as MailboxConnectionRecordV1;
        }

        // completion-before-consume: only a 'consumed' attempt may activate.
        if (attempt.status !== "consumed") throw DomainError.conflict();

        const connection = await transaction
          .selectFrom("app.mailbox_connections")
          .selectAll()
          .where("id", "=", input.connectionId)
          .where("tenant_id", "=", attempt.tenant_id)
          .forUpdate()
          .executeTakeFirst();
        if (!connection) throw DomainError.notFound();

        const now = new Date();
        const updatedConnection = await transaction
          .updateTable("app.mailbox_connections")
          .set({
            status: "active",
            provider_account_id: input.providerAccountId,
            account_email: input.accountEmail,
            granted_scopes: [...input.grantedScopes],
            vault_reference: input.vaultReference,
            token_generation: input.tokenGeneration,
            connection_version: sql<number>`connection_version + 1`,
            updated_at: now,
          })
          .where("id", "=", input.connectionId)
          .returningAll()
          .executeTakeFirstOrThrow();

        await transaction
          .updateTable("app.mailbox_oauth_attempts")
          .set({ status: "completed", completed_at: now })
          .where("id", "=", input.attemptId)
          .execute();

        const record = toMailboxConnectionRecordV1(updatedConnection);

        await transaction
          .insertInto("app.mailbox_operation_keys")
          .values({
            id: randomUUID(),
            tenant_id: attempt.tenant_id,
            connection_id: input.connectionId,
            operation_key: operationKey,
            idempotency_key: input.attemptId,
            normalized_request_hash: payloadHash,
            response_json: toJsonValue(record),
            created_at: now,
          })
          .execute();

        return record;
      });
    },

    async acquireTokenOperationLease(input) {
      return database.transaction().execute(async (transaction) => {
        const connection = await transaction
          .selectFrom("app.mailbox_connections")
          .selectAll()
          .where("id", "=", input.connectionId)
          .forUpdate()
          .executeTakeFirst();
        if (!connection) throw DomainError.notFound();

        const now = new Date();
        const leaseActive =
          connection.token_operation_lease_id !== null &&
          connection.token_operation_lease_expires_at !== null &&
          connection.token_operation_lease_expires_at.getTime() > now.getTime();
        if (leaseActive) throw DomainError.conflict();

        const leaseId = randomUUID();
        const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1_000);

        const updated = await transaction
          .updateTable("app.mailbox_connections")
          .set({
            token_operation_lease_id: leaseId,
            token_operation_lease_expires_at: expiresAt,
          })
          .where("id", "=", input.connectionId)
          .where("connection_version", "=", connection.connection_version)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw DomainError.conflict();

        return {
          connectionId: updated.id,
          leaseId,
          expiresAt: expiresAt.toISOString(),
          expectedConnectionVersion: updated.connection_version,
          currentTokenGeneration: updated.token_generation,
        };
      });
    },

    async advanceTokenGeneration(input) {
      const operationKey = mailboxIdempotencyKey(
        input.connectionId,
        "advance-generation",
        String(input.newGeneration),
        input.expectedConnectionVersion,
      );
      const payloadHash = hashNormalizedRequest({ vaultReference: input.vaultReference });

      return database.transaction().execute(async (transaction) => {
        const connection = await transaction
          .selectFrom("app.mailbox_connections")
          .selectAll()
          .where("id", "=", input.connectionId)
          .forUpdate()
          .executeTakeFirst();
        if (!connection) throw DomainError.notFound();

        const existingKey = await transaction
          .selectFrom("app.mailbox_operation_keys")
          .select(["normalized_request_hash", "response_json"])
          .where("tenant_id", "=", connection.tenant_id)
          .where("operation_key", "=", operationKey)
          .where("idempotency_key", "=", input.idempotencyKey)
          .executeTakeFirst();

        if (existingKey) {
          if (existingKey.normalized_request_hash !== payloadHash) {
            throw DomainError.idempotencyConflict();
          }
          return existingKey.response_json as unknown as AdvanceTokenGenerationResult;
        }

        const now = new Date();
        const leaseValid =
          connection.token_operation_lease_id === input.leaseId &&
          connection.token_operation_lease_expires_at !== null &&
          connection.token_operation_lease_expires_at.getTime() > now.getTime();
        if (
          !leaseValid ||
          connection.connection_version !== input.expectedConnectionVersion ||
          input.newGeneration !== connection.token_generation + 1
        ) {
          throw DomainError.conflict();
        }

        const updated = await transaction
          .updateTable("app.mailbox_connections")
          .set({
            token_generation: input.newGeneration,
            vault_reference: input.vaultReference,
            connection_version: sql<number>`connection_version + 1`,
            token_operation_lease_id: null,
            token_operation_lease_expires_at: null,
            updated_at: now,
          })
          .where("id", "=", input.connectionId)
          .where("connection_version", "=", input.expectedConnectionVersion)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw DomainError.conflict();

        const result: AdvanceTokenGenerationResult = {
          connectionVersion: updated.connection_version,
          tokenGeneration: updated.token_generation,
          vaultReference: updated.vault_reference,
        };

        await transaction
          .insertInto("app.mailbox_operation_keys")
          .values({
            id: randomUUID(),
            tenant_id: connection.tenant_id,
            connection_id: input.connectionId,
            operation_key: operationKey,
            idempotency_key: input.idempotencyKey,
            normalized_request_hash: payloadHash,
            response_json: toJsonValue(result),
            created_at: now,
          })
          .execute();

        return result;
      });
    },

    async releaseTokenOperationLease(input) {
      // Explicitly idempotent: no-op (not an error) when the connection's
      // current lease doesn't match -- already cleared by a successful
      // advanceTokenGeneration, already released, or never matched.
      await database
        .updateTable("app.mailbox_connections")
        .set({ token_operation_lease_id: null, token_operation_lease_expires_at: null })
        .where("id", "=", input.connectionId)
        .where("token_operation_lease_id", "=", input.leaseId)
        .execute();
    },
  };
}
