/**
 * Phase 3D-A Task 1, fix round 1 — real-PostgreSQL proofs for migration
 * 018's database-level constraints, added after review found three gaps
 * that only a live server (not the structural regex suite in
 * mailbox-connections-database.test.ts) can prove:
 *
 *   1. Active-connection uniqueness is scope-specific (two partial unique
 *      indexes), not one composite index spanning both nullable scope
 *      columns -- PostgreSQL treats NULL as distinct from NULL, so a
 *      single index would never catch two duplicate personal (or two
 *      duplicate business) connections.
 *   2. The operation-key ledger's permanent-uniqueness constraint covers
 *      only the (tenant_id, operation_key, idempotency_key) triple, so a
 *      second insert for the same triple collides at the DB level even
 *      when its normalized_request_hash differs (domain code is
 *      responsible for comparing the hash and raising a typed
 *      IDEMPOTENCY_CONFLICT before ever attempting that insert).
 *   3. OAuth attempt status transitions are forward-only: a 'consumed'
 *      row can reach 'completed' or 'cancelled', never back to 'pending'.
 *
 * This is pure schema/constraint coverage -- no domain layer, no
 * Google/Clerk network access. Real-PostgreSQL coverage gated on
 * PHASE_3D_A_T1_INTEGRATION=1, same ephemeral-database pattern as the
 * Task 2 integration suites (mailbox-connections.test.ts etc.).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAppDatabase } from "../src/database/client.js";
import type { AppDatabase } from "../src/database/types.js";
import { runMigrations } from "../src/database/migrate.js";

const requested = process.env.PHASE_3D_A_T1_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const databaseName = `expense_tax_t1fr1_${runKey}`;

interface ComposeConfig {
  readonly services: Record<string, { readonly environment?: Record<string, string | null> }>;
}

const TENANT_ID = "7d000000-0000-4000-8000-000000000001";
const OWNER_USER_ID = "7d000000-0000-4000-8000-000000000002";
const PROFILE_ID = "7d000000-0000-4000-8000-000000000003";
const BUSINESS_ID = "7d000000-0000-4000-8000-000000000004";

let postgresContainerId = "";
let runtimePassword = "";
let migratorPassword = "";
let database: Kysely<AppDatabase> | undefined;

function dockerPsql(dbName: string, username: string, password: string, sqlText: string): string {
  const result = spawnSync(
    "docker",
    [
      "exec", "-e", `PGPASSWORD=${password}`,
      postgresContainerId,
      "psql", "-X", "-v", "ON_ERROR_STOP=1",
      "--host", "127.0.0.1",
      "--username", username,
      "--dbname", dbName,
      "--tuples-only", "--no-align",
      "--pset", "footer=off",
      "--command", sqlText,
    ],
    { encoding: "utf8" },
  );
  return result.stdout.trim() + (result.status !== 0 ? `\nSTDERR:${result.stderr}` : "");
}

function adminSql(sqlText: string, db = "postgres"): string {
  const result = dockerPsql(db, "postgres", "postgrespassword", sqlText);
  if (result.includes("STDERR:")) throw new Error(result);
  return result;
}

function runtimeSqlOk(sqlText: string): string {
  const result = dockerPsql(databaseName, "expense_app_runtime", runtimePassword, sqlText);
  if (result.includes("STDERR:")) throw new Error(result);
  return result;
}

/** Runs SQL expected to fail; returns the combined stdout/stderr for assertion. */
function runtimeSqlExpectError(sqlText: string): string {
  return dockerPsql(databaseName, "expense_app_runtime", runtimePassword, sqlText);
}

describe.skipIf(!requested)(
  "migration 018 — database-level constraint proofs (live PostgreSQL)",
  () => {
    beforeAll(async () => {
      const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
      if (!dockerAvailable) throw new Error("Mailbox Task 1 fix-round-1 PostgreSQL prerequisites unavailable");

      let postgresRunning = false;
      try {
        postgresRunning =
          execFileSync(composeScript, ["ps", "-q", "postgres"], {
            cwd: repoRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
          }).trim().length > 0;
      } catch {
        postgresRunning = false;
      }
      if (!postgresRunning) throw new Error("Mailbox Task 1 fix-round-1 PostgreSQL prerequisites unavailable");

      const config = JSON.parse(
        execFileSync(composeScript, ["config", "--format", "json"], {
          cwd: repoRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        }),
      ) as ComposeConfig;
      postgresContainerId = execFileSync(composeScript, ["ps", "-q", "postgres"], {
        cwd: repoRoot, env: process.env, encoding: "utf8",
      }).trim();
      runtimePassword = config.services.postgres?.environment?.APP_RUNTIME_DB_PASSWORD ?? "";
      migratorPassword = config.services.postgres?.environment?.APP_MIGRATOR_DB_PASSWORD ?? "";
      if (!postgresContainerId || !runtimePassword || !migratorPassword) {
        throw new Error("Mailbox Task 1 fix-round-1 PostgreSQL prerequisites unavailable");
      }

      adminSql(`CREATE DATABASE ${databaseName};`);
      adminSql(
        `CREATE SCHEMA app AUTHORIZATION expense_app_migrator;
         CREATE SCHEMA app_migrations AUTHORIZATION expense_app_migrator;
         GRANT USAGE ON SCHEMA app TO expense_app_runtime;`,
        databaseName,
      );
      const migrationDatabaseUrl = `postgresql://expense_app_migrator:${encodeURIComponent(migratorPassword)}@127.0.0.1:5433/${databaseName}`;
      const runtimeDatabaseUrl = `postgresql://expense_app_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5433/${databaseName}`;
      await runMigrations(migrationDatabaseUrl);
      adminSql(
        `GRANT USAGE ON SCHEMA app TO expense_app_runtime;
         GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO expense_app_runtime;
         GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA app TO expense_app_runtime;
         REVOKE UPDATE, DELETE ON app.mailbox_operation_keys FROM expense_app_runtime;`,
        databaseName,
      );
      database = createAppDatabase(runtimeDatabaseUrl);

      runtimeSqlOk(`
        INSERT INTO app.users (id, primary_email, display_name)
        VALUES ('${OWNER_USER_ID}', 't1fr1-owner@example.test', 'T1FR1 Owner')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tenants (id, name, slug, status)
        VALUES ('${TENANT_ID}', 'T1FR1 Tenant', 't1fr1-tenant-${runKey}', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status)
        VALUES ('${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.personal_profiles (id, tenant_id, name)
        VALUES ('${PROFILE_ID}', '${TENANT_ID}', 'T1FR1 Profile')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.businesses (id, tenant_id, name, industry_code, timezone, base_currency, status)
        VALUES ('${BUSINESS_ID}', '${TENANT_ID}', 'T1FR1 Business', 'restaurant', 'UTC', 'USD', 'active')
        ON CONFLICT DO NOTHING;
      `);
    });

    afterAll(async () => {
      await database?.destroy();
      if (postgresContainerId && databaseName) {
        adminSql(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
      }
    });

    function insertConnectionSql(opts: {
      id: string;
      scope: "personal" | "business";
      providerAccountId: string;
      status?: string;
    }): string {
      const personalProfileId = opts.scope === "personal" ? `'${PROFILE_ID}'` : "NULL";
      const businessId = opts.scope === "business" ? `'${BUSINESS_ID}'` : "NULL";
      return `
        INSERT INTO app.mailbox_connections
          (id, tenant_id, personal_profile_id, business_id, owner_user_id, provider,
           provider_account_id, account_email, status, timezone, local_scan_time,
           vault_reference, revoked_at)
        VALUES
          ('${opts.id}', '${TENANT_ID}', ${personalProfileId}, ${businessId}, '${OWNER_USER_ID}',
           'gmail', '${opts.providerAccountId}', 'owner@example.test',
           '${opts.status ?? "active"}', 'America/Los_Angeles', '06:30', 'vault:ref:${opts.id}',
           ${opts.status === "revoked" ? "now()" : "NULL"});
      `;
    }

    describe("finding 1 — scope-specific active-connection uniqueness", () => {
      it("rejects a second active personal connection for the same (tenant, profile, provider, account)", () => {
        const accountId = `acct-personal-dup-${runKey}`;
        runtimeSqlOk(insertConnectionSql({ id: randomUUID(), scope: "personal", providerAccountId: accountId }));
        const result = runtimeSqlExpectError(
          insertConnectionSql({ id: randomUUID(), scope: "personal", providerAccountId: accountId }),
        );
        expect(result).toContain("STDERR:");
        expect(result).toMatch(/duplicate key value violates unique constraint "mailbox_connections_active_personal_unique"/);
      });

      it("rejects a second active business connection for the same (tenant, business, provider, account)", () => {
        const accountId = `acct-business-dup-${runKey}`;
        runtimeSqlOk(insertConnectionSql({ id: randomUUID(), scope: "business", providerAccountId: accountId }));
        const result = runtimeSqlExpectError(
          insertConnectionSql({ id: randomUUID(), scope: "business", providerAccountId: accountId }),
        );
        expect(result).toContain("STDERR:");
        expect(result).toMatch(/duplicate key value violates unique constraint "mailbox_connections_active_business_unique"/);
      });

      it("does NOT cross-block: an active personal and an active business connection may share the same provider_account_id (control case proving the split didn't over-constrain)", () => {
        const accountId = `acct-cross-scope-${runKey}`;
        expect(() =>
          runtimeSqlOk(insertConnectionSql({ id: randomUUID(), scope: "personal", providerAccountId: accountId })),
        ).not.toThrow();
        expect(() =>
          runtimeSqlOk(insertConnectionSql({ id: randomUUID(), scope: "business", providerAccountId: accountId })),
        ).not.toThrow();
      });

      it("allows a new active connection to the same account after the prior one is revoked (history preserved, not a live duplicate)", () => {
        const accountId = `acct-reconnect-${runKey}`;
        runtimeSqlOk(
          insertConnectionSql({ id: randomUUID(), scope: "personal", providerAccountId: accountId, status: "revoked" }),
        );
        expect(() =>
          runtimeSqlOk(insertConnectionSql({ id: randomUUID(), scope: "personal", providerAccountId: accountId })),
        ).not.toThrow();
      });
    });

    describe("finding 2 — operation-key ledger permanent uniqueness is the (tenant, operation_key, idempotency_key) triple", () => {
      it("rejects a second row for the same triple even with a different normalized_request_hash", () => {
        const operationKey = `op-${runKey}`;
        const idempotencyKey = `idem-${runKey}`;
        const hashA = "a".repeat(64);
        const hashB = "b".repeat(64);

        runtimeSqlOk(`
          INSERT INTO app.mailbox_operation_keys
            (id, tenant_id, operation_key, idempotency_key, normalized_request_hash)
          VALUES ('${randomUUID()}', '${TENANT_ID}', '${operationKey}', '${idempotencyKey}', '${hashA}');
        `);

        const result = runtimeSqlExpectError(`
          INSERT INTO app.mailbox_operation_keys
            (id, tenant_id, operation_key, idempotency_key, normalized_request_hash)
          VALUES ('${randomUUID()}', '${TENANT_ID}', '${operationKey}', '${idempotencyKey}', '${hashB}');
        `);
        expect(result).toContain("STDERR:");
        expect(result).toMatch(/duplicate key value violates unique constraint "mailbox_operation_keys_permanent_unique"/);
      });

      it("allows a different idempotency_key under the same operation_key (not over-constrained)", () => {
        const operationKey = `op-distinct-${runKey}`;
        expect(() =>
          runtimeSqlOk(`
            INSERT INTO app.mailbox_operation_keys
              (id, tenant_id, operation_key, idempotency_key, normalized_request_hash)
            VALUES ('${randomUUID()}', '${TENANT_ID}', '${operationKey}', 'idem-a-${runKey}', '${"c".repeat(64)}');
          `),
        ).not.toThrow();
        expect(() =>
          runtimeSqlOk(`
            INSERT INTO app.mailbox_operation_keys
              (id, tenant_id, operation_key, idempotency_key, normalized_request_hash)
            VALUES ('${randomUUID()}', '${TENANT_ID}', '${operationKey}', 'idem-b-${runKey}', '${"d".repeat(64)}');
          `),
        ).not.toThrow();
      });
    });

    describe("finding 3 — OAuth attempt status transitions are forward-only", () => {
      function insertConnection(id: string): void {
        runtimeSqlOk(insertConnectionSql({ id, scope: "personal", providerAccountId: `acct-oauth-${id}` }));
      }

      function insertAttempt(id: string, connectionId: string): void {
        const digest = createHash("sha256").update(id).digest("hex");
        runtimeSqlOk(`
          INSERT INTO app.mailbox_oauth_attempts
            (id, connection_id, tenant_id, actor_user_id, state_digest, session_nonce_digest,
             redirect_origin, expires_at, status)
          VALUES
            ('${id}', '${connectionId}', '${TENANT_ID}', '${OWNER_USER_ID}',
             '${digest}', '${digest}', 'https://expense-office.test',
             now() + interval '10 minutes', 'pending');
        `);
      }

      it("rejects consumed -> pending (the gap a terminal-only guard would miss)", () => {
        const connectionId = randomUUID();
        const attemptId = randomUUID();
        insertConnection(connectionId);
        insertAttempt(attemptId, connectionId);

        runtimeSqlOk(`
          UPDATE app.mailbox_oauth_attempts SET status = 'consumed', consumed_at = now()
          WHERE id = '${attemptId}';
        `);

        const result = runtimeSqlExpectError(`
          UPDATE app.mailbox_oauth_attempts SET status = 'pending', consumed_at = NULL
          WHERE id = '${attemptId}';
        `);
        expect(result).toContain("STDERR:");
        expect(result).toMatch(/invalid mailbox OAuth attempt status transition: consumed -> pending/);
      });

      it("allows the real lifecycle: pending -> consumed -> completed", () => {
        const connectionId = randomUUID();
        const attemptId = randomUUID();
        insertConnection(connectionId);
        insertAttempt(attemptId, connectionId);

        expect(() =>
          runtimeSqlOk(`
            UPDATE app.mailbox_oauth_attempts SET status = 'consumed', consumed_at = now()
            WHERE id = '${attemptId}';
          `),
        ).not.toThrow();
        expect(() =>
          runtimeSqlOk(`
            UPDATE app.mailbox_oauth_attempts SET status = 'completed', completed_at = now()
            WHERE id = '${attemptId}';
          `),
        ).not.toThrow();
      });

      it("rejects completed -> anything (still terminal, unchanged behavior)", () => {
        const connectionId = randomUUID();
        const attemptId = randomUUID();
        insertConnection(connectionId);
        insertAttempt(attemptId, connectionId);
        runtimeSqlOk(`
          UPDATE app.mailbox_oauth_attempts SET status = 'consumed', consumed_at = now()
          WHERE id = '${attemptId}';
        `);
        runtimeSqlOk(`
          UPDATE app.mailbox_oauth_attempts SET status = 'completed', completed_at = now()
          WHERE id = '${attemptId}';
        `);

        const result = runtimeSqlExpectError(`
          UPDATE app.mailbox_oauth_attempts SET status = 'cancelled'
          WHERE id = '${attemptId}';
        `);
        expect(result).toContain("STDERR:");
        // Terminal rows are now rejected by the immutability check before
        // the transition-edge check ever runs, so the message is the
        // terminal one, not "invalid ... transition: completed -> cancelled".
        expect(result).toMatch(/terminal mailbox OAuth attempt is immutable: completed/);
      });

      it("rejects a same-status UPDATE of a terminal (completed) row -- terminal rows are fully immutable, not just forward-only", () => {
        const connectionId = randomUUID();
        const attemptId = randomUUID();
        insertConnection(connectionId);
        insertAttempt(attemptId, connectionId);
        runtimeSqlOk(`
          UPDATE app.mailbox_oauth_attempts SET status = 'consumed', consumed_at = now()
          WHERE id = '${attemptId}';
        `);
        runtimeSqlOk(`
          UPDATE app.mailbox_oauth_attempts SET status = 'completed', completed_at = now()
          WHERE id = '${attemptId}';
        `);

        // Same status, only touching an otherwise-mutable-looking column
        // (completed_at) -- a same-status early return in the trigger
        // would let this through even though the row is terminal.
        const result = runtimeSqlExpectError(`
          UPDATE app.mailbox_oauth_attempts SET status = 'completed', completed_at = now()
          WHERE id = '${attemptId}';
        `);
        expect(result).toContain("STDERR:");
        expect(result).toMatch(/terminal mailbox OAuth attempt is immutable/);
      });

      it("rejects a same-status UPDATE of a terminal (expired) row", () => {
        const connectionId = randomUUID();
        const attemptId = randomUUID();
        insertConnection(connectionId);
        insertAttempt(attemptId, connectionId);
        runtimeSqlOk(`
          UPDATE app.mailbox_oauth_attempts SET status = 'expired'
          WHERE id = '${attemptId}';
        `);

        const result = runtimeSqlExpectError(`
          UPDATE app.mailbox_oauth_attempts SET status = 'expired'
          WHERE id = '${attemptId}';
        `);
        expect(result).toContain("STDERR:");
        expect(result).toMatch(/terminal mailbox OAuth attempt is immutable/);
      });

      it("allows pending -> expired directly", () => {
        const connectionId = randomUUID();
        const attemptId = randomUUID();
        insertConnection(connectionId);
        insertAttempt(attemptId, connectionId);

        expect(() =>
          runtimeSqlOk(`
            UPDATE app.mailbox_oauth_attempts SET status = 'expired'
            WHERE id = '${attemptId}';
          `),
        ).not.toThrow();
      });
    });
  },
);
