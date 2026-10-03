/**
 * Phase 3D-A Task 3 — operator-run vault key rotation.
 *
 * Four-step operator protocol (see task-3-brief.md "Key rotation --
 * concrete protocol"); this module implements step 2, the re-encryption
 * job. Every invocation resumes before it starts anything new:
 * `resolvePendingTokenOperations` first resolves any existing `'pending'`
 * token_operations row, *then* this scans for vault rows still encrypted
 * under the retiring key whose connection has no pending operation.
 */
import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";

import type { MailboxBrokerConnectionAppClient } from "./contracts.js";
import type { VaultDatabase } from "./database/types.js";
import {
  addTokenGenerationCAS,
  countActiveVaultRowsForKey,
  decryptVaultRow,
  destroyTokenGeneration,
  markTokenOperationDispatched,
  persistTokenOperation,
  resolvePendingTokenOperations,
  resolveTokenOperation,
  selectActiveVaultRowsForKey,
  selectPendingTokenOperation,
  TokenOperationAlreadyPendingError,
  type ResolveTokenOperationResult,
  type VaultRow,
} from "./token-vault.js";

const LEASE_TTL_SECONDS = 300;

export interface RotateVaultKeyInput {
  readonly retiringKeyId: string;
  readonly newKeyId: string;
  readonly connectionId?: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

export interface RotateConnectionOutcome {
  readonly connectionId: string;
  readonly outcome: "resolved" | "rotated" | "skipped_pending" | "failed";
  readonly result?: ResolveTokenOperationResult;
  readonly error?: string;
}

export interface RotateVaultKeyResult {
  readonly resumed: readonly { readonly connectionId: string; readonly result: ResolveTokenOperationResult }[];
  readonly rotated: readonly RotateConnectionOutcome[];
}

async function rotateOneConnection(
  database: Kysely<VaultDatabase>,
  appClient: MailboxBrokerConnectionAppClient,
  row: VaultRow,
  retiringKey: Buffer,
  input: RotateVaultKeyInput,
): Promise<RotateConnectionOutcome> {
  const connectionId = row.connection_id;

  // Re-check: resolvePendingTokenOperations ran before this scan, but a
  // truly concurrent second invocation could have persisted a new
  // pending operation for this exact connection in the gap. Skip rather
  // than race it.
  const existingPending = await selectPendingTokenOperation(database, connectionId);
  if (existingPending) {
    return { connectionId, outcome: "skipped_pending" };
  }

  let plaintext: Buffer;
  try {
    plaintext = decryptVaultRow(row, retiringKey, connectionId, row.generation);
  } catch (error) {
    return { connectionId, outcome: "failed", error: (error as Error).message };
  }

  const operationId = randomUUID();
  let leaseId: string;
  let expectedConnectionVersion: number;
  try {
    const lease = await appClient.acquireTokenOperationLease({
      connectionId,
      operationId,
      ttlSeconds: LEASE_TTL_SECONDS,
    });
    leaseId = lease.leaseId;
    expectedConnectionVersion = lease.expectedConnectionVersion;
  } catch (error) {
    // Nothing persisted yet (step (a)-(c) failure path) -- nothing to
    // resume on the next invocation, no lease to release.
    return { connectionId, outcome: "failed", error: (error as Error).message };
  }

  const newGeneration = row.generation + 1;
  const newKey = input.keys.get(input.newKeyId);
  if (!newKey) {
    await appClient.releaseTokenOperationLease({ connectionId, leaseId });
    return {
      connectionId,
      outcome: "failed",
      error: `New vault key "${input.newKeyId}" is not loaded`,
    };
  }

  const cas = await addTokenGenerationCAS(database, {
    connectionId,
    newGeneration,
    plaintext,
    keyId: input.newKeyId,
    key: newKey,
  });
  if (cas.status === "conflict") {
    await appClient.releaseTokenOperationLease({ connectionId, leaseId });
    return { connectionId, outcome: "skipped_pending" };
  }

  try {
    const persisted = await persistTokenOperation(database, {
      operationId,
      connectionId,
      idempotencyKey: operationId,
      leaseId,
      expectedConnectionVersion,
      fromGeneration: row.generation,
      toGeneration: newGeneration,
      vaultReference: cas.vaultReference,
      requestId: operationId,
    });
    // Hand off to the same resolution routine resumed operations use
    // (brief Step 2 (e)). This invocation has not crashed -- it is about
    // to dispatch for the first time -- so advance_requested_at is
    // marked here, immediately before resolution, exactly as
    // "dispatching for the first time" does in the brief's "Resolving a
    // pending operation" text. Only a row still NULL at resolution time
    // (resolvePendingTokenOperations, resuming a *different*, earlier,
    // crashed process's row) hits resolveTokenOperation's crash-cleanup
    // branch.
    await markTokenOperationDispatched(database, persisted.operation_id);
    const result = await resolveTokenOperation(database, appClient, {
      ...persisted,
      advance_requested_at: new Date(),
    });
    return { connectionId, outcome: "rotated", result };
  } catch (error) {
    if (error instanceof TokenOperationAlreadyPendingError) {
      // Lost a true concurrent race after our own CAS succeeded: clean
      // up the vault row we just created and release our lease rather
      // than leave an orphan or fight the winner.
      await destroyTokenGeneration(database, connectionId, newGeneration);
      await appClient.releaseTokenOperationLease({ connectionId, leaseId });
      return { connectionId, outcome: "skipped_pending" };
    }
    throw error;
  }
}

export async function rotateVaultKey(
  database: Kysely<VaultDatabase>,
  appClient: MailboxBrokerConnectionAppClient,
  input: RotateVaultKeyInput,
): Promise<RotateVaultKeyResult> {
  const resumedRaw = await resolvePendingTokenOperations(
    database,
    appClient,
    input.connectionId !== undefined ? { connectionId: input.connectionId } : {},
  );
  const resumed = resumedRaw.map(({ row, result }) => ({
    connectionId: row.connection_id,
    result,
  }));

  const retiringKey = input.keys.get(input.retiringKeyId);
  if (!retiringKey) {
    throw new Error(`Retiring vault key "${input.retiringKeyId}" is not loaded`);
  }

  const activeRows = await selectActiveVaultRowsForKey(database, input.retiringKeyId);
  const targetRows = input.connectionId
    ? activeRows.filter((row) => row.connection_id === input.connectionId)
    : activeRows;

  const rotated: RotateConnectionOutcome[] = [];
  for (const row of targetRows) {
    rotated.push(await rotateOneConnection(database, appClient, row, retiringKey, input));
  }

  return { resumed, rotated };
}

/**
 * Step 3's verification: zero remaining non-disabled references to the
 * retiring key must exist before step 4 (removing it from the deployment
 * bundle) is safe.
 */
export async function countRemainingReferences(
  database: Kysely<VaultDatabase>,
  retiringKeyId: string,
): Promise<number> {
  return countActiveVaultRowsForKey(database, retiringKeyId);
}
