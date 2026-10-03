/**
 * Phase 3D-A Task 3 — key-rotation-cli.ts: flag parsing (no DB needed)
 * and the `--verify-retired` / rotate exit-code contract against real
 * PostgreSQL (PHASE_3D_A_T3_INTEGRATION=1).
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MailboxAppClientError } from "../src/app-client.js";
import { parseCliArgs, runKeyRotationCli } from "../src/key-rotation-cli.js";
import { countRemainingReferences } from "../src/key-rotation.js";
import { createConnectionVaultRow, selectVaultRow } from "../src/token-vault.js";
import { createFakeAppClient, createVaultKeyMap } from "../src/test-doubles.js";
import {
  createEphemeralVaultDatabase,
  dockerPostgresAvailable,
  type VaultTestDatabase,
} from "./support/vault-database.js";

describe("parseCliArgs", () => {
  it("parses --retiring-key-id/--new-key-id/--connection-id", () => {
    expect(
      parseCliArgs([
        "--retiring-key-id=old",
        "--new-key-id=new",
        "--connection-id=11111111-1111-4111-8111-111111111111",
      ]),
    ).toEqual({
      retiringKeyId: "old",
      newKeyId: "new",
      connectionId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("parses --verify-retired independently", () => {
    expect(parseCliArgs(["--verify-retired=old"])).toEqual({ verifyRetired: "old" });
  });

  it("ignores unrecognized flags", () => {
    expect(parseCliArgs(["--unknown=x", "--retiring-key-id=old"])).toEqual({
      retiringKeyId: "old",
    });
  });
});

const requested = process.env.PHASE_3D_A_T3_INTEGRATION === "1";
const runKey = randomUUID().replaceAll("-", "").slice(0, 10);

describe.skipIf(!requested)("runKeyRotationCli (live PostgreSQL)", () => {
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

  it("--verify-retired returns exit code 0 when zero references remain", async () => {
    const logs: string[] = [];
    const exitCode = await runKeyRotationCli(["--verify-retired=never-used-key"], {
      database: instance.database,
      appClient: createFakeAppClient(),
      keys: new Map(),
      log: (message) => logs.push(message),
    });
    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("remaining references");
  });

  it("--verify-retired returns exit code 1 while a non-disabled row still references the key", async () => {
    const retiringKeyId = "cli-retiring";
    const vaultKeys = createVaultKeyMap({ activeKeyId: retiringKeyId });
    await createConnectionVaultRow(instance.database, {
      connectionId: randomUUID(),
      plaintext: Buffer.from("x"),
      vaultKeys,
    });

    const exitCode = await runKeyRotationCli([`--verify-retired=${retiringKeyId}`], {
      database: instance.database,
      appClient: createFakeAppClient(),
      keys: new Map(),
      log: () => undefined,
    });
    expect(exitCode).toBe(1);
  });

  it("rotates every connection still under the retiring key and returns exit code 0 on full success", async () => {
    const retiringKeyId = "cli-rotate-retiring";
    const newKeyId = "cli-rotate-new";
    const vaultKeys = createVaultKeyMap({ activeKeyId: retiringKeyId });
    const newKeyMaterial = randomBytes(32);
    const connectionId = randomUUID();
    await createConnectionVaultRow(instance.database, {
      connectionId,
      plaintext: Buffer.from("x"),
      vaultKeys,
    });

    const logs: string[] = [];
    const exitCode = await runKeyRotationCli(
      [`--retiring-key-id=${retiringKeyId}`, `--new-key-id=${newKeyId}`],
      {
        database: instance.database,
        appClient: createFakeAppClient(),
        keys: new Map([[retiringKeyId, vaultKeys.keys.get(retiringKeyId)!], [newKeyId, newKeyMaterial]]),
        log: (message) => logs.push(message),
      },
    );

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("rotated");

    const verifyExitCode = await runKeyRotationCli([`--verify-retired=${retiringKeyId}`], {
      database: instance.database,
      appClient: createFakeAppClient(),
      keys: new Map(),
      log: () => undefined,
    });
    expect(verifyExitCode).toBe(0);
  });

  describe("Fix round 1 — CLI-boundary coverage of the controller ruling (review Important finding)", () => {
    it("a confirmed rejection (IDEMPOTENCY_CONFLICT) returns exit code 0 and logs the rejected outcome, leaving the connection still under the retiring key", async () => {
      const retiringKeyId = "cli-rejected-retiring";
      const newKeyId = "cli-rejected-new";
      const vaultKeys = createVaultKeyMap({ activeKeyId: retiringKeyId });
      const newKeyMaterial = randomBytes(32);
      const connectionId = randomUUID();
      await createConnectionVaultRow(instance.database, {
        connectionId,
        plaintext: Buffer.from("x"),
        vaultKeys,
      });

      const rejectingAppClient = createFakeAppClient({
        advanceTokenGenerationImpl: async () => {
          throw new MailboxAppClientError("idempotency_conflict", 409);
        },
      });

      const logs: string[] = [];
      const exitCode = await runKeyRotationCli(
        [`--retiring-key-id=${retiringKeyId}`, `--new-key-id=${newKeyId}`],
        {
          database: instance.database,
          appClient: rejectingAppClient,
          keys: new Map([
            [retiringKeyId, vaultKeys.keys.get(retiringKeyId)!],
            [newKeyId, newKeyMaterial],
          ]),
          log: (message) => logs.push(message),
        },
      );

      // Controller ruling: a confirmed rejection is NOT ambiguous -- exit
      // code 0, not 1 -- even though the connection did not rotate.
      expect(exitCode).toBe(0);
      expect(logs.join("\n")).toContain("rotated");
      expect(logs.join("\n")).toContain("rejected");

      // The connection was never advanced: generation 1 (retiring key)
      // is still active and un-disabled; generation 2 was destroyed.
      const generation1 = await selectVaultRow(instance.database, connectionId, 1);
      const generation2 = await selectVaultRow(instance.database, connectionId, 2);
      expect(generation1?.disabled_at).toBeNull();
      expect(generation1?.key_id).toBe(retiringKeyId);
      expect(generation2).toBeUndefined();

      // --verify-retired must still report a nonzero reference -- the
      // connection was never actually migrated off the retiring key.
      expect(await countRemainingReferences(instance.database, retiringKeyId)).toBe(1);
    });

    it("a rejected connection is retried on the next invocation with a fresh lease and generation, and completes", async () => {
      const retiringKeyId = "cli-retry-retiring";
      const newKeyId = "cli-retry-new";
      const vaultKeys = createVaultKeyMap({ activeKeyId: retiringKeyId });
      const newKeyMaterial = randomBytes(32);
      const connectionId = randomUUID();
      await createConnectionVaultRow(instance.database, {
        connectionId,
        plaintext: Buffer.from("retry-me"),
        vaultKeys,
      });
      const keys = new Map([
        [retiringKeyId, vaultKeys.keys.get(retiringKeyId)!],
        [newKeyId, newKeyMaterial],
      ]);

      const rejectingAppClient = createFakeAppClient({
        advanceTokenGenerationImpl: async () => {
          throw new MailboxAppClientError("idempotency_conflict", 409);
        },
      });
      const firstRun = await runKeyRotationCli(
        [`--retiring-key-id=${retiringKeyId}`, `--new-key-id=${newKeyId}`],
        { database: instance.database, appClient: rejectingAppClient, keys, log: () => undefined },
      );
      expect(firstRun).toBe(0);
      expect(await countRemainingReferences(instance.database, retiringKeyId)).toBe(1);

      // Second invocation: a normal (non-rejecting) app client, simulating
      // the operator re-running the identical command after the transient
      // conflict clears. No --connection-id was ever needed: the
      // connection is picked up again purely because it is still active
      // under the retiring key -- no special-case code, per the ruling.
      const healthyAppClient = createFakeAppClient();
      const secondRun = await runKeyRotationCli(
        [`--retiring-key-id=${retiringKeyId}`, `--new-key-id=${newKeyId}`],
        { database: instance.database, appClient: healthyAppClient, keys, log: () => undefined },
      );
      expect(secondRun).toBe(0);

      // A fresh lease/generation was used -- not a replay of the first
      // (rejected) attempt's lease, which the healthy fake client would
      // reject as a version mismatch if reused.
      expect(healthyAppClient.acquireTokenOperationLease).toHaveBeenCalledOnce();
      expect(healthyAppClient.advanceTokenGeneration).toHaveBeenCalledWith(
        expect.objectContaining({ newGeneration: 2 }),
      );

      const generation2 = await selectVaultRow(instance.database, connectionId, 2);
      expect(generation2?.key_id).toBe(newKeyId);
      expect(generation2?.disabled_at).toBeNull();
      expect(await countRemainingReferences(instance.database, retiringKeyId)).toBe(0);
    });

    it("an ambiguous (retries-exhausted) failure returns exit code 1 -- distinct from a confirmed rejection's exit code 0", async () => {
      const retiringKeyId = "cli-ambiguous-retiring";
      const newKeyId = "cli-ambiguous-new";
      const vaultKeys = createVaultKeyMap({ activeKeyId: retiringKeyId });
      const newKeyMaterial = randomBytes(32);
      const connectionId = randomUUID();
      await createConnectionVaultRow(instance.database, {
        connectionId,
        plaintext: Buffer.from("x"),
        vaultKeys,
      });

      // A transient (non-MailboxAppClientError) failure on every attempt
      // is never a *definitive* rejection -- resolveTokenOperation retries
      // with backoff, exhausts its attempts, and leaves the operation
      // 'pending' (ambiguous), which the CLI must surface as exit code 1.
      const flakyAppClient = createFakeAppClient({
        advanceTokenGenerationImpl: async () => {
          throw new Error("ECONNRESET");
        },
      });

      const logs: string[] = [];
      const exitCode = await runKeyRotationCli(
        [`--retiring-key-id=${retiringKeyId}`, `--new-key-id=${newKeyId}`],
        {
          database: instance.database,
          appClient: flakyAppClient,
          keys: new Map([
            [retiringKeyId, vaultKeys.keys.get(retiringKeyId)!],
            [newKeyId, newKeyMaterial],
          ]),
          log: (message) => logs.push(message),
        },
      );

      expect(exitCode).toBe(1);
      expect(logs.join("\n")).toContain("pending");

      // The operation is left pending (not rejected, not confirmed) --
      // the next invocation must resume it rather than start a new one.
      const generation2 = await selectVaultRow(instance.database, connectionId, 2);
      expect(generation2).toBeDefined(); // not cleaned up -- still ambiguous
    }, 10_000);
  });

  it("prints usage and returns exit code 1 when neither rotation flags nor --verify-retired are given", async () => {
    const logs: string[] = [];
    const exitCode = await runKeyRotationCli([], {
      database: instance.database,
      appClient: createFakeAppClient(),
      keys: new Map(),
      log: (message) => logs.push(message),
    });
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Usage");
  });
});
