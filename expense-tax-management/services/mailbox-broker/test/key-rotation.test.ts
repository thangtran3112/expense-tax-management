/**
 * Phase 3D-A Task 3 — key-rotation.ts (rotateVaultKey) against real
 * PostgreSQL (PHASE_3D_A_T3_INTEGRATION=1). New key encrypts new writes,
 * old key still decrypts its own rows during the dual-key window, the
 * CLI-level job resumes correctly against partially-rotated connections,
 * and retirement verification is nonzero while any non-disabled row
 * still references the retiring key.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { countRemainingReferences, rotateVaultKey } from "../src/key-rotation.js";
import {
  createConnectionVaultRow,
  decryptVaultRow,
  persistTokenOperation,
  selectVaultRow,
} from "../src/token-vault.js";
import { createFakeAppClient, createVaultKeyMap } from "../src/test-doubles.js";
import {
  createEphemeralVaultDatabase,
  dockerPostgresAvailable,
  type VaultTestDatabase,
} from "./support/vault-database.js";

const requested = process.env.PHASE_3D_A_T3_INTEGRATION === "1";
const runKey = randomUUID().replaceAll("-", "").slice(0, 10);

describe.skipIf(!requested)("key-rotation.ts rotateVaultKey (live PostgreSQL)", () => {
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

  it("rotates an active connection from the retiring key to the new key", async () => {
    const retiringKeyId = "retiring";
    const newKeyId = "new";
    const vaultKeys = createVaultKeyMap({ activeKeyId: retiringKeyId });
    const retiringKey = vaultKeys.keys.get(retiringKeyId)!;
    const newKeyMaterial = (await import("node:crypto")).randomBytes(32);
    const keys = new Map([
      [retiringKeyId, retiringKey],
      [newKeyId, newKeyMaterial],
    ]);

    const connectionId = randomUUID();
    const plaintext = Buffer.from("refresh-token-under-retiring-key");
    await createConnectionVaultRow(database(), { connectionId, plaintext, vaultKeys });

    const appClient = createFakeAppClient();
    const result = await rotateVaultKey(database(), appClient, {
      retiringKeyId,
      newKeyId,
      keys,
    });

    expect(result.rotated).toHaveLength(1);
    expect(result.rotated[0]!.outcome).toBe("rotated");
    expect(result.rotated[0]!.result?.status).toBe("confirmed");

    const oldRow = await selectVaultRow(database(), connectionId, 1);
    const newRow = await selectVaultRow(database(), connectionId, 2);
    expect(oldRow?.disabled_at).not.toBeNull(); // prior generation disabled, not deleted
    expect(newRow?.disabled_at).toBeNull();

    const decrypted = decryptVaultRow(newRow!, newKeyMaterial, connectionId, 2);
    expect(decrypted.equals(plaintext)).toBe(true);

    expect(await countRemainingReferences(database(), retiringKeyId)).toBe(0);
  });

  it("decrypts under the retiring key for any connection not yet rotated (dual-key window)", async () => {
    const retiringKeyId = "retiring-2";
    const vaultKeys = createVaultKeyMap({ activeKeyId: retiringKeyId });
    const connectionId = randomUUID();
    await createConnectionVaultRow(database(), {
      connectionId,
      plaintext: Buffer.from("still-under-old-key"),
      vaultKeys,
    });

    const row = await selectVaultRow(database(), connectionId, 1);
    const decrypted = decryptVaultRow(row!, vaultKeys.keys.get(retiringKeyId)!, connectionId, 1);
    expect(decrypted.toString()).toBe("still-under-old-key");
  });

  it("skips a connection that already has a pending token operation rather than racing it", async () => {
    const retiringKeyId = "retiring-3";
    const newKeyId = "new-3";
    const vaultKeys = createVaultKeyMap({ activeKeyId: retiringKeyId });
    const newKeyMaterial = (await import("node:crypto")).randomBytes(32);
    const keys = new Map([
      [retiringKeyId, vaultKeys.keys.get(retiringKeyId)!],
      [newKeyId, newKeyMaterial],
    ]);
    const connectionId = randomUUID();
    await createConnectionVaultRow(database(), {
      connectionId,
      plaintext: Buffer.from("x"),
      vaultKeys,
    });

    // Simulate a concurrent in-flight rotation already holding the slot.
    await persistTokenOperation(database(), {
      operationId: randomUUID(),
      connectionId,
      idempotencyKey: randomUUID(),
      leaseId: randomUUID(),
      expectedConnectionVersion: 1,
      fromGeneration: 1,
      toGeneration: 2,
      vaultReference: connectionId,
      requestId: randomUUID(),
    });

    const appClient = createFakeAppClient();
    const result = await rotateVaultKey(database(), appClient, {
      retiringKeyId,
      newKeyId,
      connectionId,
      keys,
    });

    // resolvePendingTokenOperations (resume phase) resolves the existing
    // pending row itself (crash-before-dispatch -> rejected); the scan
    // phase then finds no remaining pending op and proceeds to rotate.
    expect(result.resumed).toHaveLength(1);
    expect(result.resumed[0]!.result.status).toBe("rejected");
  });

  it("countRemainingReferences is nonzero while any non-disabled row still uses the retiring key", async () => {
    const retiringKeyId = "retiring-4";
    const vaultKeys = createVaultKeyMap({ activeKeyId: retiringKeyId });
    const connectionId = randomUUID();
    await createConnectionVaultRow(database(), {
      connectionId,
      plaintext: Buffer.from("x"),
      vaultKeys,
    });

    expect(await countRemainingReferences(database(), retiringKeyId)).toBeGreaterThan(0);
  });

  it("every invocation resumes pending operations before scanning for new work (resolve-pending-before-new-work ordering)", async () => {
    const retiringKeyId = "retiring-5";
    const newKeyId = "new-5";
    const vaultKeys = createVaultKeyMap({ activeKeyId: retiringKeyId });
    const newKeyMaterial = (await import("node:crypto")).randomBytes(32);
    const keys = new Map([
      [retiringKeyId, vaultKeys.keys.get(retiringKeyId)!],
      [newKeyId, newKeyMaterial],
    ]);

    const alreadyRotating = randomUUID();
    await createConnectionVaultRow(database(), {
      connectionId: alreadyRotating,
      plaintext: Buffer.from("a"),
      vaultKeys,
    });
    await persistTokenOperation(database(), {
      operationId: randomUUID(),
      connectionId: alreadyRotating,
      idempotencyKey: randomUUID(),
      leaseId: randomUUID(),
      expectedConnectionVersion: 1,
      fromGeneration: 1,
      toGeneration: 2,
      vaultReference: alreadyRotating,
      requestId: randomUUID(),
    });

    const freshConnection = randomUUID();
    await createConnectionVaultRow(database(), {
      connectionId: freshConnection,
      plaintext: Buffer.from("b"),
      vaultKeys,
    });

    const appClient = createFakeAppClient();
    const result = await rotateVaultKey(database(), appClient, { retiringKeyId, newKeyId, keys });

    expect(result.resumed.map((entry) => entry.connectionId)).toContain(alreadyRotating);
    expect(result.rotated.map((entry) => entry.connectionId)).toContain(freshConnection);
  });
});
