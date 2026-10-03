/**
 * Phase 3D-A Task 3 — token vault CAS/AAD primitives and the crash-safe
 * token_operations ledger used by key rotation.
 *
 * AES-256-GCM, 96-bit random nonce. AAD for every encrypt/decrypt call is
 * the UTF-8 bytes of `${connectionId}:${keyId}:${generation}` -- ciphertext
 * from one connection/key/generation can never be decrypted, or silently
 * substituted, into another row. `UNIQUE (key_id, nonce)` (migration
 * 001) makes a generated-nonce collision under the same key impossible to
 * persist; `insertVaultRow` retries with a freshly generated nonce on
 * that exact unique-violation.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { Kysely, Selectable } from "kysely";

import type {
  TokenOperationStatus,
  TokenOperationTable,
  TokenVaultTable,
  VaultDatabase,
} from "./database/types.js";
import type { MailboxBrokerConnectionAppClient } from "./contracts.js";
import { MailboxAppClientError } from "./app-client.js";

export type VaultRow = Selectable<TokenVaultTable>;
export type TokenOperationRow = Selectable<TokenOperationTable>;

export interface VaultKeyMap {
  readonly keys: ReadonlyMap<string, Buffer>;
  readonly activeKeyId: string;
}

const MAX_NONCE_RETRIES = 5;

function aad(connectionId: string, keyId: string, generation: number): Buffer {
  return Buffer.from(`${connectionId}:${keyId}:${generation}`, "utf8");
}

function encryptPayload(
  plaintext: Buffer,
  key: Buffer,
  keyId: string,
  connectionId: string,
  generation: number,
): { nonce: Buffer; ciphertext: Buffer; authTag: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(connectionId, keyId, generation));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { nonce, ciphertext, authTag };
}

/**
 * Decrypts a vault row. Throws (Node crypto's native GCM tag-mismatch
 * error) if the ciphertext was tampered with, or if `key`/`connectionId`/
 * `generation` do not match the row's own AAD binding -- the row can
 * never be decrypted under another connection/key/generation's identity.
 */
export function decryptVaultRow(
  row: Pick<VaultRow, "key_id" | "nonce" | "ciphertext" | "auth_tag">,
  key: Buffer,
  connectionId: string,
  generation: number,
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, row.nonce);
  decipher.setAuthTag(row.auth_tag);
  decipher.setAAD(aad(connectionId, row.key_id, generation));
  return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
}

function isNonceUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const databaseError = error as { code?: unknown; constraint?: unknown };
  return (
    databaseError.code === "23505" &&
    databaseError.constraint === "token_vault_key_nonce_unique"
  );
}

function isGenerationPrimaryKeyViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const databaseError = error as { code?: unknown; constraint?: unknown };
  return (
    databaseError.code === "23505" &&
    (databaseError.constraint === "token_vault_pkey" ||
      String(databaseError.constraint ?? "").includes("pkey"))
  );
}

async function insertVaultRow(
  database: Kysely<VaultDatabase>,
  input: {
    readonly connectionId: string;
    readonly generation: number;
    readonly keyId: string;
    readonly key: Buffer;
    readonly plaintext: Buffer;
  },
): Promise<{ status: "created" } | { status: "generation_conflict" }> {
  for (let attempt = 0; attempt < MAX_NONCE_RETRIES; attempt += 1) {
    const { nonce, ciphertext, authTag } = encryptPayload(
      input.plaintext,
      input.key,
      input.keyId,
      input.connectionId,
      input.generation,
    );
    try {
      await database
        .insertInto("token_vault")
        .values({
          connection_id: input.connectionId,
          generation: input.generation,
          key_id: input.keyId,
          nonce,
          ciphertext,
          auth_tag: authTag,
          disabled_at: null,
        })
        .execute();
      return { status: "created" };
    } catch (error) {
      if (isNonceUniqueViolation(error)) {
        continue; // negligible-probability collision; retry with a fresh nonce
      }
      if (isGenerationPrimaryKeyViolation(error)) {
        return { status: "generation_conflict" };
      }
      throw error;
    }
  }
  throw new Error("Exhausted nonce retries creating a token vault row");
}

export interface CreateConnectionVaultRowInput {
  readonly connectionId: string;
  readonly plaintext: Buffer;
  readonly vaultKeys: VaultKeyMap;
}

export interface CreateConnectionVaultRowResult {
  readonly vaultReference: string;
  readonly tokenGeneration: 1;
}

/**
 * Initial vault row (generation 1), written once the broker's OAuth
 * exchange succeeds. Always uses the currently active key.
 * `vaultReference` is the opaque pointer App API persists -- here,
 * simply the connectionId itself, since the vault's own primary key is
 * `(connection_id, generation)` and App tracks which generation is
 * active as its own `token_generation` counter (never derived from this
 * string).
 */
export async function createConnectionVaultRow(
  database: Kysely<VaultDatabase>,
  input: CreateConnectionVaultRowInput,
): Promise<CreateConnectionVaultRowResult> {
  const key = input.vaultKeys.keys.get(input.vaultKeys.activeKeyId);
  if (!key) {
    throw new Error(`Active vault key "${input.vaultKeys.activeKeyId}" is not loaded`);
  }
  const result = await insertVaultRow(database, {
    connectionId: input.connectionId,
    generation: 1,
    keyId: input.vaultKeys.activeKeyId,
    key,
    plaintext: input.plaintext,
  });
  if (result.status === "generation_conflict") {
    throw new Error(
      `Vault row for connection ${input.connectionId} generation 1 already exists`,
    );
  }
  return { vaultReference: input.connectionId, tokenGeneration: 1 };
}

export interface AddTokenGenerationCasInput {
  readonly connectionId: string;
  readonly newGeneration: number;
  readonly plaintext: Buffer;
  readonly keyId: string;
  readonly key: Buffer;
}

export type AddTokenGenerationCasResult =
  | { readonly status: "created"; readonly vaultReference: string; readonly generation: number }
  | { readonly status: "conflict" };

/**
 * Inserts a new generation's vault row under an explicit key (the active
 * key for refresh-token rotation; the new key for key rotation). The
 * insert's own primary key `(connection_id, generation)` is the CAS: if
 * a concurrent writer already created this exact generation, the insert
 * loses the race and this returns `{status:"conflict"}` instead of a raw
 * database error -- the caller must abort (release its lease, do not
 * disable anything) rather than assume it won.
 */
export async function addTokenGenerationCAS(
  database: Kysely<VaultDatabase>,
  input: AddTokenGenerationCasInput,
): Promise<AddTokenGenerationCasResult> {
  const result = await insertVaultRow(database, {
    connectionId: input.connectionId,
    generation: input.newGeneration,
    keyId: input.keyId,
    key: input.key,
    plaintext: input.plaintext,
  });
  if (result.status === "generation_conflict") {
    return { status: "conflict" };
  }
  return {
    status: "created",
    vaultReference: input.connectionId,
    generation: input.newGeneration,
  };
}

/**
 * Hard-deletes a single vault-row generation. Used only when App never
 * pointed to this generation (the crash-before-dispatch cleanup path,
 * and the confirmed-rejection path) -- there is nothing to preserve.
 * Idempotent: deleting an already-absent row is a harmless no-op.
 */
export async function destroyTokenGeneration(
  database: Kysely<VaultDatabase>,
  connectionId: string,
  generation: number,
): Promise<void> {
  await database
    .deleteFrom("token_vault")
    .where("connection_id", "=", connectionId)
    .where("generation", "=", generation)
    .execute();
}

/**
 * Idempotent single-generation disable (`UPDATE ... WHERE disabled_at IS
 * NULL`), used after a confirmed-successful `advanceTokenGeneration` to
 * retire exactly the prior generation -- never a delete, since the row
 * stays decryptable for audit/incident purposes even once disabled.
 */
export async function disableTokenGeneration(
  database: Kysely<VaultDatabase>,
  connectionId: string,
  generation: number,
): Promise<void> {
  await database
    .updateTable("token_vault")
    .set({ disabled_at: new Date() })
    .where("connection_id", "=", connectionId)
    .where("generation", "=", generation)
    .where("disabled_at", "is", null)
    .execute();
}

/**
 * Disables every still-active generation for a connection (full
 * connection revocation) -- distinct from `disableTokenGeneration`,
 * which retires only one specific generation during rotation.
 */
export async function revokeTokenGenerations(
  database: Kysely<VaultDatabase>,
  connectionId: string,
): Promise<void> {
  await database
    .updateTable("token_vault")
    .set({ disabled_at: new Date() })
    .where("connection_id", "=", connectionId)
    .where("disabled_at", "is", null)
    .execute();
}

export async function selectVaultRow(
  database: Kysely<VaultDatabase>,
  connectionId: string,
  generation: number,
): Promise<VaultRow | undefined> {
  return database
    .selectFrom("token_vault")
    .selectAll()
    .where("connection_id", "=", connectionId)
    .where("generation", "=", generation)
    .executeTakeFirst();
}

/**
 * The single currently-active (non-disabled) generation for a connection,
 * if any -- exactly one should exist at a time outside a brief in-flight
 * rotation window. Used by google-mailbox.ts to learn the generation to
 * roll forward from (refresh-token rotation) or revoke (connection
 * revocation).
 */
export async function selectActiveVaultRowForConnection(
  database: Kysely<VaultDatabase>,
  connectionId: string,
): Promise<VaultRow | undefined> {
  return database
    .selectFrom("token_vault")
    .selectAll()
    .where("connection_id", "=", connectionId)
    .where("disabled_at", "is", null)
    .orderBy("generation", "desc")
    .executeTakeFirst();
}

export async function selectActiveVaultRowsForKey(
  database: Kysely<VaultDatabase>,
  keyId: string,
): Promise<readonly VaultRow[]> {
  return database
    .selectFrom("token_vault")
    .selectAll()
    .where("key_id", "=", keyId)
    .where("disabled_at", "is", null)
    .execute();
}

export async function countActiveVaultRowsForKey(
  database: Kysely<VaultDatabase>,
  keyId: string,
): Promise<number> {
  const rows = await selectActiveVaultRowsForKey(database, keyId);
  return rows.length;
}

// -------------------------------------------------------------------- //
// token_operations: crash-safe key-rotation ledger
// -------------------------------------------------------------------- //

export interface PersistTokenOperationInput {
  readonly operationId: string;
  readonly connectionId: string;
  readonly idempotencyKey: string;
  readonly leaseId: string;
  readonly expectedConnectionVersion: number;
  readonly fromGeneration: number;
  readonly toGeneration: number;
  readonly vaultReference: string;
  readonly requestId: string;
}

export class TokenOperationAlreadyPendingError extends Error {
  constructor(readonly connectionId: string) {
    super(`Connection ${connectionId} already has a pending token operation`);
    this.name = "TokenOperationAlreadyPendingError";
  }
}

function isPendingOperationUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const databaseError = error as { code?: unknown; constraint?: unknown };
  return (
    databaseError.code === "23505" &&
    databaseError.constraint === "token_operations_pending_unique"
  );
}

/**
 * Persists the token_operations row *before* any `advanceTokenGeneration`
 * call is made (committed to the vault database first). Throws
 * `TokenOperationAlreadyPendingError` if a second, concurrent CLI
 * invocation already holds the connection's one-pending-operation slot
 * (the partial unique index on `connection_id WHERE status='pending'`).
 */
export async function persistTokenOperation(
  database: Kysely<VaultDatabase>,
  input: PersistTokenOperationInput,
): Promise<TokenOperationRow> {
  try {
    return await database
      .insertInto("token_operations")
      .values({
        operation_id: input.operationId,
        connection_id: input.connectionId,
        idempotency_key: input.idempotencyKey,
        lease_id: input.leaseId,
        expected_connection_version: input.expectedConnectionVersion,
        from_generation: input.fromGeneration,
        to_generation: input.toGeneration,
        vault_reference: input.vaultReference,
        request_id: input.requestId,
        advance_requested_at: null,
        status: "pending",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  } catch (error) {
    if (isPendingOperationUniqueViolation(error)) {
      throw new TokenOperationAlreadyPendingError(input.connectionId);
    }
    throw error;
  }
}

/**
 * Idempotent: harmless to overwrite on a resumed row (its presence, not
 * its exact value, is what matters per the brief).
 */
export async function markTokenOperationDispatched(
  database: Kysely<VaultDatabase>,
  operationId: string,
): Promise<void> {
  await database
    .updateTable("token_operations")
    .set({ advance_requested_at: new Date() })
    .where("operation_id", "=", operationId)
    .execute();
}

async function markTokenOperationResolved(
  database: Kysely<VaultDatabase>,
  operationId: string,
  status: Exclude<TokenOperationStatus, "pending">,
): Promise<void> {
  await database
    .updateTable("token_operations")
    .set({ status, resolved_at: new Date() })
    .where("operation_id", "=", operationId)
    .execute();
}

export type ResolveTokenOperationResult =
  | { readonly status: "confirmed" }
  | { readonly status: "rejected" }
  | { readonly status: "pending" };

const ADVANCE_MAX_ATTEMPTS = 5;
const ADVANCE_BASE_DELAY_MS = 50;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolves a single `'pending'` `token_operations` row to a definitive
 * outcome, using only the row's own stored parameters -- never freshly
 * generated values -- so a resumed call is always a safe replay. Shared
 * by both the resume path (`resolvePendingTokenOperations`) and the
 * fresh-persist path (`rotateVaultKey` step (e), same routine).
 */
export async function resolveTokenOperation(
  database: Kysely<VaultDatabase>,
  appClient: MailboxBrokerConnectionAppClient,
  row: TokenOperationRow,
): Promise<ResolveTokenOperationResult> {
  if (row.advance_requested_at === null) {
    // advanceTokenGeneration is known with certainty to have never been
    // dispatched -- the process died between persisting this row and
    // making that call. Nothing to reconcile with App; clean up locally.
    await destroyTokenGeneration(database, row.connection_id, row.to_generation);
    await appClient.releaseTokenOperationLease({
      connectionId: row.connection_id,
      leaseId: row.lease_id,
    });
    await markTokenOperationResolved(database, row.operation_id, "rejected");
    return { status: "rejected" };
  }

  await markTokenOperationDispatched(database, row.operation_id);

  for (let attempt = 0; attempt < ADVANCE_MAX_ATTEMPTS; attempt += 1) {
    try {
      await appClient.advanceTokenGeneration({
        connectionId: row.connection_id,
        leaseId: row.lease_id,
        expectedConnectionVersion: row.expected_connection_version,
        newGeneration: row.to_generation,
        vaultReference: row.vault_reference,
        requestId: row.request_id,
        idempotencyKey: row.idempotency_key,
      });
      // advanceTokenGeneration already cleared the lease as part of its
      // own CAS -- do not call releaseTokenOperationLease again here.
      await disableTokenGeneration(database, row.connection_id, row.from_generation);
      await markTokenOperationResolved(database, row.operation_id, "confirmed");
      return { status: "confirmed" };
    } catch (error) {
      if (error instanceof MailboxAppClientError && error.isDefinitiveRejection()) {
        await destroyTokenGeneration(database, row.connection_id, row.to_generation);
        await appClient.releaseTokenOperationLease({
          connectionId: row.connection_id,
          leaseId: row.lease_id,
        });
        await markTokenOperationResolved(database, row.operation_id, "rejected");
        return { status: "rejected" };
      }
      // Ambiguous (transient) failure -- retry with bounded backoff. The
      // identical idempotencyKey makes every retry a safe replay.
      if (attempt < ADVANCE_MAX_ATTEMPTS - 1) {
        await delay(ADVANCE_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
    }
  }

  // Retries exhausted with no definitive response ever received: leave
  // the operation 'pending' with advance_requested_at already set. The
  // prior generation stays active; nothing is lost. Caller should exit
  // non-zero so the operator reruns the identical command.
  return { status: "pending" };
}

export interface ResolvePendingTokenOperationsOptions {
  readonly connectionId?: string;
}

/**
 * Resumes every existing `'pending'` token_operations row (optionally
 * scoped to one connection), resolving each via `resolveTokenOperation`.
 * `rotateVaultKey` calls this *before* it looks for any additional vault
 * rows still encrypted under the retiring key.
 */
export async function resolvePendingTokenOperations(
  database: Kysely<VaultDatabase>,
  appClient: MailboxBrokerConnectionAppClient,
  options: ResolvePendingTokenOperationsOptions = {},
): Promise<readonly { readonly row: TokenOperationRow; readonly result: ResolveTokenOperationResult }[]> {
  let query = database.selectFrom("token_operations").selectAll().where("status", "=", "pending");
  if (options.connectionId !== undefined) {
    query = query.where("connection_id", "=", options.connectionId);
  }
  const rows = await query.execute();

  const results: { readonly row: TokenOperationRow; readonly result: ResolveTokenOperationResult }[] = [];
  for (const row of rows) {
    const result = await resolveTokenOperation(database, appClient, row);
    results.push({ row, result });
  }
  return results;
}

export async function selectPendingTokenOperation(
  database: Kysely<VaultDatabase>,
  connectionId: string,
): Promise<TokenOperationRow | undefined> {
  return database
    .selectFrom("token_operations")
    .selectAll()
    .where("connection_id", "=", connectionId)
    .where("status", "=", "pending")
    .executeTakeFirst();
}
