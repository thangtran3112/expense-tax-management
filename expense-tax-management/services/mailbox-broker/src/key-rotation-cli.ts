/**
 * Phase 3D-A Task 3 — operator-run key-rotation CLI.
 *
 * `docker exec <mailbox-broker-container> node dist/key-rotation-cli.js
 * --retiring-key-id=<old> --new-key-id=<new> [--connection-id=<uuid>]`
 * (omit --connection-id to rotate every connection), or
 * `--verify-retired=<old>` for step 3's zero-references check.
 *
 * Controller ruling (carried from the plan review): skips ONLY
 * connections whose rotation operation is `confirmed`; a `rejected`
 * operation's connection is retried with a fresh lease/generation on the
 * next invocation (a `rejected` outcome always leaves that connection
 * still encrypted under the retiring key, so it is picked right back up
 * by the next scan of `selectActiveVaultRowsForKey` -- no special-casing
 * needed here beyond not treating `rejected` as done).
 */
import { pathToFileURL } from "node:url";

import type { Kysely } from "kysely";

import type { MailboxBrokerConnectionAppClient } from "./contracts.js";
import type { VaultDatabase } from "./database/types.js";
import { countRemainingReferences, rotateVaultKey } from "./key-rotation.js";

export interface KeyRotationCliDependencies {
  readonly database: Kysely<VaultDatabase>;
  readonly appClient: MailboxBrokerConnectionAppClient;
  readonly keys: ReadonlyMap<string, Buffer>;
  readonly log?: (message: string) => void;
}

export interface ParsedCliArgs {
  readonly retiringKeyId?: string;
  readonly newKeyId?: string;
  readonly connectionId?: string;
  readonly verifyRetired?: string;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const result: Record<string, string> = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match) continue;
    const [, rawKey, value] = match;
    if (rawKey === "retiring-key-id") result.retiringKeyId = value ?? "";
    else if (rawKey === "new-key-id") result.newKeyId = value ?? "";
    else if (rawKey === "connection-id") result.connectionId = value ?? "";
    else if (rawKey === "verify-retired") result.verifyRetired = value ?? "";
  }
  return result;
}

export async function runKeyRotationCli(
  argv: readonly string[],
  deps: KeyRotationCliDependencies,
): Promise<number> {
  const log = deps.log ?? console.info;
  const args = parseCliArgs(argv);

  if (args.verifyRetired !== undefined) {
    const remaining = await countRemainingReferences(deps.database, args.verifyRetired);
    log(`remaining references to key "${args.verifyRetired}": ${remaining}`);
    return remaining === 0 ? 0 : 1;
  }

  if (!args.retiringKeyId || !args.newKeyId) {
    log("Usage: key-rotation-cli --retiring-key-id=<old> --new-key-id=<new> [--connection-id=<uuid>]");
    return 1;
  }

  const result = await rotateVaultKey(deps.database, deps.appClient, {
    retiringKeyId: args.retiringKeyId,
    newKeyId: args.newKeyId,
    ...(args.connectionId !== undefined ? { connectionId: args.connectionId } : {}),
    keys: deps.keys,
  });

  for (const resumedEntry of result.resumed) {
    log(`resumed ${resumedEntry.connectionId}: ${resumedEntry.result.status}`);
  }
  for (const rotatedEntry of result.rotated) {
    log(
      `rotated ${rotatedEntry.connectionId}: ${rotatedEntry.outcome}` +
        (rotatedEntry.result ? ` (${rotatedEntry.result.status})` : "") +
        (rotatedEntry.error ? ` -- ${rotatedEntry.error}` : ""),
    );
  }

  const anyAmbiguous =
    result.resumed.some((entry) => entry.result.status === "pending") ||
    result.rotated.some((entry) => entry.result?.status === "pending" || entry.outcome === "failed");

  return anyAmbiguous ? 1 : 0;
}

async function main(): Promise<void> {
  const { brokerConfigFromEnv } = await import("./config.js");
  const { createVaultDatabase } = await import("./database/client.js");
  const { createMailboxAppClient } = await import("./app-client.js");

  const config = brokerConfigFromEnv();
  const database = createVaultDatabase(config.databaseUrl);
  const appClient = createMailboxAppClient({
    baseUrl: config.outboundApp.baseUrl,
    issuerUrl: config.outboundApp.issuerUrl,
    jwksUrl: config.outboundApp.jwksUrl,
    credentials: config.outboundApp.credentials,
  });

  try {
    const exitCode = await runKeyRotationCli(process.argv.slice(2), {
      database,
      appClient,
      keys: config.vault.keys,
    });
    process.exitCode = exitCode;
  } finally {
    await database.destroy();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error("Mailbox broker key rotation failed", error);
    process.exitCode = 1;
  });
}
