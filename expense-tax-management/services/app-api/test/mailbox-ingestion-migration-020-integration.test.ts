/**
 * Phase 3D-C Task 1, fix round 1 — real-PostgreSQL proofs for migration
 * 020's database-level invariants, added after review found four gaps
 * that only a live server (not the structural regex suite in
 * mailbox-ingestion-database.test.ts) can prove:
 *
 *   1. app.mailbox_ingestion_operations' status progression is forward-only:
 *      pending -> started -> completed|failed only, never pending ->
 *      completed directly, never backward, and terminal rows are fully
 *      immutable.
 *   2. An operation row's candidate_id must belong to the SAME
 *      connection_id as the operation itself -- a same-tenant,
 *      cross-connection candidate/operation pairing is rejected at the
 *      FK level.
 *   3. Once an app.expense_sources row references a mailbox_candidates
 *      row, that candidate's scope (candidate_personal_profile_id/
 *      candidate_business_id) and connection_id become immutable; an
 *      unreferenced candidate's scope remains mutable (control case).
 *   4. response_json is constrained to the documented allow-listed,
 *      scalar-only field set -- an unexpected field, a nested object/
 *      array value, or an oversized value is rejected.
 *
 * This is pure schema/constraint coverage -- no domain layer, no
 * Google/Clerk network access. Real-PostgreSQL coverage gated on
 * PHASE_3D_C_T1_INTEGRATION=1, same ephemeral-database pattern as
 * mailbox-connections-migration-018-integration.test.ts.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAppDatabase } from "../src/database/client.js";
import type { AppDatabase } from "../src/database/types.js";
import { runMigrations } from "../src/database/migrate.js";

const requested = process.env.PHASE_3D_C_T1_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const databaseName = `expense_tax_3dc_t1fr1_${runKey}`;

interface ComposeConfig {
  readonly services: Record<string, { readonly environment?: Record<string, string | null> }>;
}

const TENANT_ID = "7e000000-0000-4000-8000-000000000001";
const OWNER_USER_ID = "7e000000-0000-4000-8000-000000000002";
const PROFILE_ID = "7e000000-0000-4000-8000-000000000003";
const BUSINESS_ID = "7e000000-0000-4000-8000-000000000004";
const CONNECTION_A_ID = "7e000000-0000-4000-8000-00000000000a";
const CONNECTION_B_ID = "7e000000-0000-4000-8000-00000000000b";
const SCAN_RUN_A_ID = "7e000000-0000-4000-8000-0000000000aa";
const SCAN_RUN_B_ID = "7e000000-0000-4000-8000-0000000000bb";

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
  "migration 020 — database-level constraint proofs (live PostgreSQL)",
  () => {
    beforeAll(async () => {
      const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
      if (!dockerAvailable) throw new Error("Mailbox 3D-C Task 1 fix-round-1 PostgreSQL prerequisites unavailable");

      let postgresRunning = false;
      try {
        postgresRunning =
          execFileSync(composeScript, ["ps", "-q", "postgres"], {
            cwd: repoRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
          }).trim().length > 0;
      } catch {
        postgresRunning = false;
      }
      if (!postgresRunning) throw new Error("Mailbox 3D-C Task 1 fix-round-1 PostgreSQL prerequisites unavailable");

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
        throw new Error("Mailbox 3D-C Task 1 fix-round-1 PostgreSQL prerequisites unavailable");
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
        VALUES ('${OWNER_USER_ID}', '3dc-t1fr1-owner@example.test', '3D-C T1FR1 Owner')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tenants (id, name, slug, status)
        VALUES ('${TENANT_ID}', '3D-C T1FR1 Tenant', '3dc-t1fr1-tenant-${runKey}', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status)
        VALUES ('${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.personal_profiles (id, tenant_id, name)
        VALUES ('${PROFILE_ID}', '${TENANT_ID}', '3D-C T1FR1 Profile')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.businesses (id, tenant_id, name, industry_code, timezone, base_currency, status)
        VALUES ('${BUSINESS_ID}', '${TENANT_ID}', '3D-C T1FR1 Business', 'restaurant', 'UTC', 'USD', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.mailbox_connections
          (id, tenant_id, personal_profile_id, owner_user_id, provider, provider_account_id,
           account_email, status, timezone, local_scan_time, vault_reference)
        VALUES
          ('${CONNECTION_A_ID}', '${TENANT_ID}', '${PROFILE_ID}', '${OWNER_USER_ID}', 'gmail',
           'acct-conn-a-${runKey}', 'owner@example.test', 'active', 'America/Los_Angeles', '06:30',
           'vault:ref:conn-a')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.mailbox_connections
          (id, tenant_id, personal_profile_id, owner_user_id, provider, provider_account_id,
           account_email, status, timezone, local_scan_time, vault_reference)
        VALUES
          ('${CONNECTION_B_ID}', '${TENANT_ID}', '${PROFILE_ID}', '${OWNER_USER_ID}', 'gmail',
           'acct-conn-b-${runKey}', 'owner@example.test', 'active', 'America/Los_Angeles', '06:30',
           'vault:ref:conn-b')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.mailbox_scan_runs
          (id, connection_id, tenant_id, initiated_by, entitlement_version, connection_version,
           idempotency_key, normalized_request_hash)
        VALUES
          ('${SCAN_RUN_A_ID}', '${CONNECTION_A_ID}', '${TENANT_ID}', '${OWNER_USER_ID}', 1, 1,
           'scan-a-${runKey}', '${"a".repeat(64)}')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.mailbox_scan_runs
          (id, connection_id, tenant_id, initiated_by, entitlement_version, connection_version,
           idempotency_key, normalized_request_hash)
        VALUES
          ('${SCAN_RUN_B_ID}', '${CONNECTION_B_ID}', '${TENANT_ID}', '${OWNER_USER_ID}', 1, 1,
           'scan-b-${runKey}', '${"b".repeat(64)}')
        ON CONFLICT DO NOTHING;
      `);
    });

    afterAll(async () => {
      await database?.destroy();
      if (postgresContainerId && databaseName) {
        adminSql(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
      }
    });

    function insertCandidateSql(opts: {
      id: string;
      connectionId: string;
      scanRunId: string;
      status?: string;
      scope?: "personal" | "business" | null;
    }): string {
      const scope = opts.scope ?? "personal";
      const personalProfileId = scope === "personal" ? `'${PROFILE_ID}'` : "NULL";
      const businessId = scope === "business" ? `'${BUSINESS_ID}'` : "NULL";
      return `
        INSERT INTO app.mailbox_candidates
          (id, scan_run_id, connection_id, tenant_id, received_at, sender_address, sender_domain,
           content_hash, classification, confidence, candidate_personal_profile_id,
           candidate_business_id, status, idempotency_key, normalized_request_hash,
           provider_message_id)
        VALUES
          ('${opts.id}', '${opts.scanRunId}', '${opts.connectionId}', '${TENANT_ID}', now(),
           'merchant@example.test', 'example.test', '${"c".repeat(64)}', 'receipt', 0.9,
           ${personalProfileId}, ${businessId}, '${opts.status ?? "queued"}',
           'cand-${opts.id}', '${"d".repeat(64)}', 'msg-${opts.id}')
        ON CONFLICT DO NOTHING;
      `;
    }

    function insertOperationSql(opts: {
      id: string;
      connectionId: string;
      candidateId: string;
      operationKey?: string;
      idempotencyKey?: string;
      responseJson?: string;
    }): string {
      const response = opts.responseJson ? `'${opts.responseJson}'::jsonb` : "NULL";
      return `
        INSERT INTO app.mailbox_ingestion_operations
          (id, tenant_id, connection_id, candidate_id, operation_kind, operation_key,
           idempotency_key, normalized_request_hash, response_json)
        VALUES
          ('${opts.id}', '${TENANT_ID}', '${opts.connectionId}', '${opts.candidateId}',
           'materialize_candidate', '${opts.operationKey ?? `op-${opts.id}`}',
           '${opts.idempotencyKey ?? `idem-${opts.id}`}', '${"e".repeat(64)}', ${response});
      `;
    }

    describe("finding 1 — forward-only operation status progression", () => {
      it("rejects pending -> completed directly (must pass through started)", () => {
        const candidateId = randomUUID();
        const operationId = randomUUID();
        runtimeSqlOk(insertCandidateSql({ id: candidateId, connectionId: CONNECTION_A_ID, scanRunId: SCAN_RUN_A_ID }));
        runtimeSqlOk(insertOperationSql({ id: operationId, connectionId: CONNECTION_A_ID, candidateId }));

        const result = runtimeSqlExpectError(`
          UPDATE app.mailbox_ingestion_operations SET status = 'completed' WHERE id = '${operationId}';
        `);
        expect(result).toContain("STDERR:");
        expect(result).toMatch(/invalid mailbox ingestion operation status transition: pending -> completed/);
      });

      it("rejects started -> pending (backward)", () => {
        const candidateId = randomUUID();
        const operationId = randomUUID();
        runtimeSqlOk(insertCandidateSql({ id: candidateId, connectionId: CONNECTION_A_ID, scanRunId: SCAN_RUN_A_ID }));
        runtimeSqlOk(insertOperationSql({ id: operationId, connectionId: CONNECTION_A_ID, candidateId }));
        runtimeSqlOk(`UPDATE app.mailbox_ingestion_operations SET status = 'started' WHERE id = '${operationId}';`);

        const result = runtimeSqlExpectError(`
          UPDATE app.mailbox_ingestion_operations SET status = 'pending' WHERE id = '${operationId}';
        `);
        expect(result).toContain("STDERR:");
        expect(result).toMatch(/invalid mailbox ingestion operation status transition: started -> pending/);
      });

      it("allows the real lifecycle: pending -> started -> completed", () => {
        const candidateId = randomUUID();
        const operationId = randomUUID();
        runtimeSqlOk(insertCandidateSql({ id: candidateId, connectionId: CONNECTION_A_ID, scanRunId: SCAN_RUN_A_ID }));
        runtimeSqlOk(insertOperationSql({ id: operationId, connectionId: CONNECTION_A_ID, candidateId }));

        expect(() =>
          runtimeSqlOk(`UPDATE app.mailbox_ingestion_operations SET status = 'started' WHERE id = '${operationId}';`),
        ).not.toThrow();
        expect(() =>
          runtimeSqlOk(`UPDATE app.mailbox_ingestion_operations SET status = 'completed' WHERE id = '${operationId}';`),
        ).not.toThrow();
      });

      it("allows started -> failed", () => {
        const candidateId = randomUUID();
        const operationId = randomUUID();
        runtimeSqlOk(insertCandidateSql({ id: candidateId, connectionId: CONNECTION_A_ID, scanRunId: SCAN_RUN_A_ID }));
        runtimeSqlOk(insertOperationSql({ id: operationId, connectionId: CONNECTION_A_ID, candidateId }));
        runtimeSqlOk(`UPDATE app.mailbox_ingestion_operations SET status = 'started' WHERE id = '${operationId}';`);

        expect(() =>
          runtimeSqlOk(`UPDATE app.mailbox_ingestion_operations SET status = 'failed' WHERE id = '${operationId}';`),
        ).not.toThrow();
      });

      it("rejects any update on a terminal (completed) row, including a same-status touch", () => {
        const candidateId = randomUUID();
        const operationId = randomUUID();
        runtimeSqlOk(insertCandidateSql({ id: candidateId, connectionId: CONNECTION_A_ID, scanRunId: SCAN_RUN_A_ID }));
        runtimeSqlOk(insertOperationSql({ id: operationId, connectionId: CONNECTION_A_ID, candidateId }));
        runtimeSqlOk(`UPDATE app.mailbox_ingestion_operations SET status = 'started' WHERE id = '${operationId}';`);
        runtimeSqlOk(`UPDATE app.mailbox_ingestion_operations SET status = 'completed' WHERE id = '${operationId}';`);

        const result = runtimeSqlExpectError(`
          UPDATE app.mailbox_ingestion_operations SET status = 'completed' WHERE id = '${operationId}';
        `);
        expect(result).toContain("STDERR:");
        expect(result).toMatch(/terminal mailbox ingestion operation is immutable: completed/);
      });
    });

    describe("finding 2 — operation's candidate must belong to the operation's own connection", () => {
      it("rejects an operation whose connection_id does not match its candidate's own connection_id", () => {
        const candidateId = randomUUID();
        runtimeSqlOk(insertCandidateSql({ id: candidateId, connectionId: CONNECTION_A_ID, scanRunId: SCAN_RUN_A_ID }));

        const result = runtimeSqlExpectError(
          insertOperationSql({ id: randomUUID(), connectionId: CONNECTION_B_ID, candidateId }),
        );
        expect(result).toContain("STDERR:");
        expect(result).toMatch(
          /violates foreign key constraint "mailbox_ingestion_operations_candidate_connection_tenant_fk"/,
        );
      });

      it("allows an operation whose connection_id matches its candidate's own connection_id (control case)", () => {
        const candidateId = randomUUID();
        runtimeSqlOk(insertCandidateSql({ id: candidateId, connectionId: CONNECTION_B_ID, scanRunId: SCAN_RUN_B_ID }));

        expect(() =>
          runtimeSqlOk(insertOperationSql({ id: randomUUID(), connectionId: CONNECTION_B_ID, candidateId })),
        ).not.toThrow();
      });
    });

    describe("finding 3 — referenced candidate scope/connection immutability", () => {
      function insertExpenseAndSourceSql(expenseId: string, sourceId: string, candidateId: string): string {
        return `
          INSERT INTO app.expenses
            (id, tenant_id, created_by_user_id, personal_profile_id, merchant, amount, currency, incurred_on)
          VALUES
            ('${expenseId}', '${TENANT_ID}', '${OWNER_USER_ID}', '${PROFILE_ID}', 'Merchant', 10.00, 'USD', '2026-01-01');

          INSERT INTO app.expense_sources
            (id, tenant_id, personal_profile_id, expense_id, source_type, mailbox_candidate_id)
          VALUES
            ('${sourceId}', '${TENANT_ID}', '${PROFILE_ID}', '${expenseId}', 'connected_mailbox', '${candidateId}');
        `;
      }

      it("rejects a scope change on a candidate once an expense_sources row references it", () => {
        const candidateId = randomUUID();
        runtimeSqlOk(insertCandidateSql({ id: candidateId, connectionId: CONNECTION_A_ID, scanRunId: SCAN_RUN_A_ID }));
        runtimeSqlOk(insertExpenseAndSourceSql(randomUUID(), randomUUID(), candidateId));

        const result = runtimeSqlExpectError(`
          UPDATE app.mailbox_candidates
          SET candidate_personal_profile_id = NULL, candidate_business_id = '${BUSINESS_ID}'
          WHERE id = '${candidateId}';
        `);
        expect(result).toContain("STDERR:");
        expect(result).toMatch(/referenced mailbox candidate scope\/connection is immutable/);
      });

      it("rejects a connection_id change on a referenced candidate", () => {
        const candidateId = randomUUID();
        runtimeSqlOk(insertCandidateSql({ id: candidateId, connectionId: CONNECTION_A_ID, scanRunId: SCAN_RUN_A_ID }));
        runtimeSqlOk(insertExpenseAndSourceSql(randomUUID(), randomUUID(), candidateId));

        const result = runtimeSqlExpectError(`
          UPDATE app.mailbox_candidates SET connection_id = '${CONNECTION_B_ID}' WHERE id = '${candidateId}';
        `);
        expect(result).toContain("STDERR:");
        expect(result).toMatch(/referenced mailbox candidate scope\/connection is immutable/);
      });

      it("allows a scope change on an UNreferenced candidate (control case proving the guard didn't over-constrain)", () => {
        const candidateId = randomUUID();
        runtimeSqlOk(insertCandidateSql({ id: candidateId, connectionId: CONNECTION_A_ID, scanRunId: SCAN_RUN_A_ID }));

        expect(() =>
          runtimeSqlOk(`
            UPDATE app.mailbox_candidates
            SET candidate_personal_profile_id = NULL, candidate_business_id = '${BUSINESS_ID}'
            WHERE id = '${candidateId}';
          `),
        ).not.toThrow();
      });
    });

    describe("finding 4 — response_json is constrained to allow-listed scalar fields", () => {
      it("accepts a response shaped like MailboxMaterializationResultV1", () => {
        const candidateId = randomUUID();
        runtimeSqlOk(insertCandidateSql({ id: candidateId, connectionId: CONNECTION_A_ID, scanRunId: SCAN_RUN_A_ID }));

        expect(() =>
          runtimeSqlOk(
            insertOperationSql({
              id: randomUUID(),
              connectionId: CONNECTION_A_ID,
              candidateId,
              responseJson: JSON.stringify({
                schemaVersion: 1,
                candidateId,
                status: "processed",
                processingJobId: null,
                expenseId: null,
                sourceId: null,
                duplicateMatchId: null,
                idempotencyKey: "idem-1",
              }).replaceAll("'", "''"),
            }),
          ),
        ).not.toThrow();
      });

      it("rejects an unexpected field (e.g. raw HTML smuggled in)", () => {
        const candidateId = randomUUID();
        runtimeSqlOk(insertCandidateSql({ id: candidateId, connectionId: CONNECTION_A_ID, scanRunId: SCAN_RUN_A_ID }));

        const result = runtimeSqlExpectError(
          insertOperationSql({
            id: randomUUID(),
            connectionId: CONNECTION_A_ID,
            candidateId,
            responseJson: JSON.stringify({ rawHtml: "<html>not allowed</html>" }),
          }),
        );
        expect(result).toContain("STDERR:");
        expect(result).toMatch(/mailbox ingestion operation response_json carries an unexpected field: rawHtml/);
      });

      it("rejects a nested object/array value under an otherwise-allowed key", () => {
        const candidateId = randomUUID();
        runtimeSqlOk(insertCandidateSql({ id: candidateId, connectionId: CONNECTION_A_ID, scanRunId: SCAN_RUN_A_ID }));

        const result = runtimeSqlExpectError(
          insertOperationSql({
            id: randomUUID(),
            connectionId: CONNECTION_A_ID,
            candidateId,
            responseJson: JSON.stringify({ candidateId: { nested: "x" } }),
          }),
        );
        expect(result).toContain("STDERR:");
        expect(result).toMatch(/must be a scalar, not object/);
      });

      it("rejects an oversized string value under an otherwise-allowed key", () => {
        const candidateId = randomUUID();
        runtimeSqlOk(insertCandidateSql({ id: candidateId, connectionId: CONNECTION_A_ID, scanRunId: SCAN_RUN_A_ID }));

        const result = runtimeSqlExpectError(
          insertOperationSql({
            id: randomUUID(),
            connectionId: CONNECTION_A_ID,
            candidateId,
            responseJson: JSON.stringify({ errorCode: "x".repeat(2001) }),
          }),
        );
        expect(result).toContain("STDERR:");
        expect(result).toMatch(/exceeds the 2000-character bound/);
      });

      it("rejects a top-level JSON array", () => {
        const candidateId = randomUUID();
        runtimeSqlOk(insertCandidateSql({ id: candidateId, connectionId: CONNECTION_A_ID, scanRunId: SCAN_RUN_A_ID }));

        const result = runtimeSqlExpectError(
          insertOperationSql({
            id: randomUUID(),
            connectionId: CONNECTION_A_ID,
            candidateId,
            responseJson: JSON.stringify(["not", "an", "object"]),
          }),
        );
        expect(result).toContain("STDERR:");
        expect(result).toMatch(/response_json must be a JSON object/);
      });
    });
  },
);
