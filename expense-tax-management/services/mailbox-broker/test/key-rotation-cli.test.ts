/**
 * Phase 3D-A Task 3 — key-rotation-cli.ts: flag parsing (no DB needed)
 * and the `--verify-retired` / rotate exit-code contract against real
 * PostgreSQL (PHASE_3D_A_T3_INTEGRATION=1).
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseCliArgs, runKeyRotationCli } from "../src/key-rotation-cli.js";
import { createConnectionVaultRow } from "../src/token-vault.js";
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
