/**
 * Shared Docker-gated ephemeral vault-database helper, used by
 * token-vault.test.ts, key-rotation.test.ts, key-rotation-cli.test.ts,
 * and google-mailbox.test.ts. Same ephemeral-per-run-database pattern as
 * app-api/test/mailbox-oauth-state.test.ts (Task 2), reusing the shared
 * `postgres` compose service rather than this service's own dedicated
 * database -- Task 5 owns the real production bootstrap (separate
 * runtime/migration roles, its own database instance); here, the
 * `postgres` superuser runs both migration and runtime roles directly,
 * since role separation is a production-deployment concern, not a test
 * concern.
 */
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Kysely } from "kysely";

import { createVaultDatabase } from "../../src/database/client.js";
import { runMigrations } from "../../src/database/migrate.js";
import type { VaultDatabase } from "../../src/database/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");

interface ComposeConfig {
  readonly services: Record<string, { readonly environment?: Record<string, string | null> }>;
}

export interface VaultTestDatabase {
  readonly database: Kysely<VaultDatabase>;
  teardown(): Promise<void>;
}

function adminSql(containerId: string, sql: string, db = "postgres"): string {
  const result = spawnSync(
    "docker",
    [
      "exec", "-e", "PGPASSWORD=postgrespassword",
      containerId,
      "psql", "-X", "-v", "ON_ERROR_STOP=1",
      "--host", "127.0.0.1",
      "--username", "postgres",
      "--dbname", db,
      "--tuples-only", "--no-align",
      "--pset", "footer=off",
      "--command", sql,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

export function dockerPostgresAvailable(): boolean {
  try {
    const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
    if (!dockerAvailable) return false;
    const containerId = execFileSync(composeScript, ["ps", "-q", "postgres"], {
      cwd: repoRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return containerId.length > 0;
  } catch {
    return false;
  }
}

export async function createEphemeralVaultDatabase(runKey: string): Promise<VaultTestDatabase> {
  const containerId = execFileSync(composeScript, ["ps", "-q", "postgres"], {
    cwd: repoRoot, env: process.env, encoding: "utf8",
  }).trim();
  if (!containerId) throw new Error("Mailbox Task 3 PostgreSQL prerequisite unavailable");
  // Config resolution (unused beyond confirming compose is readable) kept
  // for parity with Task 2's helper; not otherwise needed since this
  // database uses the superuser role directly.
  JSON.parse(
    execFileSync(composeScript, ["config", "--format", "json"], {
      cwd: repoRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }),
  ) as ComposeConfig;

  const databaseName = `expense_tax_mailbox_vault_t3_${runKey}`;
  adminSql(containerId, `CREATE DATABASE ${databaseName};`);

  // Host port 5433 may be squatted by an unrelated local process (e.g. a
  // cloud-sql proxy) -- see task-7a-report.md "Fix Round 1". Rather than
  // editing this file in place to point at a relay port and reverting
  // before commit, the host/port are overridable via env vars so a local
  // verification run can set MAILBOX_TEST_PG_HOST/MAILBOX_TEST_PG_PORT
  // without ever touching tracked source. CI and the documented default
  // (127.0.0.1:5433) are unaffected.
  const host = process.env.MAILBOX_TEST_PG_HOST ?? "127.0.0.1";
  const port = process.env.MAILBOX_TEST_PG_PORT ?? "5433";
  const databaseUrl = `postgresql://postgres:postgrespassword@${host}:${port}/${databaseName}`;
  await runMigrations(databaseUrl);
  const database = createVaultDatabase(databaseUrl);

  return {
    database,
    async teardown() {
      await database.destroy();
      adminSql(containerId, `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
    },
  };
}
