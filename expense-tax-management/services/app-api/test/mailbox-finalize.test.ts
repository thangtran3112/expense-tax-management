/**
 * Phase 3D-B Task 3 fix round 1 (Important finding 1) — domain/mailbox-
 * scans.ts's finalizeScanRun: terminal status + lease release, only when
 * this run still holds the lease. Same ephemeral-database pattern as
 * mailbox-scans.test.ts (PHASE_3D_B_T3_INTEGRATION=1).
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
import {
  createMailboxScansDomain,
  type MailboxScansDomain,
} from "../src/domain/mailbox-scans.js";
import type { PlansDomain } from "../src/domain/plans.js";
import { DomainError } from "../src/errors.js";

const requested = process.env.PHASE_3D_B_T3_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const databaseName = `expense_tax_t3f_${runKey}`;

interface ComposeConfig {
  readonly services: Record<string, { readonly environment?: Record<string, string | null> }>;
}

const TENANT_ID = "7c000000-0000-4000-8000-000000000001";
const OWNER_USER_ID = "7c000000-0000-4000-8000-000000000002";
const PROFILE_ID = "7c000000-0000-4000-8000-000000000003";

let postgresContainerId = "";
let runtimePassword = "";
let migratorPassword = "";
let database: Kysely<AppDatabase> | undefined;

function dockerPsql(dbName: string, username: string, password: string, sql: string): string {
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
      "--command", sql,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function adminSql(sql: string, db = "postgres"): string {
  return dockerPsql(db, "postgres", "postgrespassword", sql);
}

function runtimeSql(sql: string): string {
  return dockerPsql(databaseName, "expense_app_runtime", runtimePassword, sql);
}

function fakePlansDomain(): PlansDomain {
  const notImplemented = async (): Promise<never> => {
    throw new Error("not implemented in this fake");
  };
  return {
    createPlan: notImplemented,
    createPlanVersion: notImplemented,
    createFeatureDefinition: notImplemented,
    listPlansAdmin: notImplemented,
    listActivePlans: notImplemented,
    async getSubscription() {
      return {
        tenantId: TENANT_ID,
        planKey: "trial",
        planVersionId: randomUUID(),
        status: "active" as const,
        currentEntitlementVersion: 3,
        startedAt: new Date().toISOString(),
        version: 1,
        updatedAt: new Date().toISOString(),
      };
    },
    updateSubscription: notImplemented,
    addAddon: notImplemented,
    removeAddon: notImplemented,
    async resolveEffectiveEntitlements() {
      return [
        {
          featureKey: "connected_mailbox_scan" as const,
          isEnabled: true,
          limitValue: null,
          limitPeriod: null,
          source: "plan" as const,
        },
      ];
    },
    listEntitlementSnapshotsAfter: notImplemented,
  };
}

describe.skipIf(!requested)(
  "domain/mailbox-scans.ts — finalizeScanRun (live PostgreSQL)",
  () => {
    beforeAll(async () => {
      const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
      if (!dockerAvailable) throw new Error("Mailbox Task 3 PostgreSQL prerequisites unavailable");

      let postgresRunning = false;
      try {
        postgresRunning =
          execFileSync(composeScript, ["ps", "-q", "postgres"], {
            cwd: repoRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
          }).trim().length > 0;
      } catch {
        postgresRunning = false;
      }
      if (!postgresRunning) throw new Error("Mailbox Task 3 PostgreSQL prerequisites unavailable");

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
        throw new Error("Mailbox Task 3 PostgreSQL prerequisites unavailable");
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
      seedFixtures();
    });

    afterAll(async () => {
      await database?.destroy();
      if (postgresContainerId && databaseName) {
        adminSql(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
      }
    });

    function seedFixtures(): void {
      runtimeSql(`
        INSERT INTO app.users (id, primary_email, display_name) VALUES
          ('${OWNER_USER_ID}', 't3f-owner@example.test', 'T3F Owner')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tenants (id, name, slug, status) VALUES
          ('${TENANT_ID}', 'T3F Tenant', 't3f-tenant-${runKey}', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status) VALUES
          ('${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.personal_profiles (id, tenant_id, name) VALUES
          ('${PROFILE_ID}', '${TENANT_ID}', 'T3F Profile')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role, status) VALUES
          ('${PROFILE_ID}', '${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;
      `);
    }

    function createDomain(): MailboxScansDomain {
      return createMailboxScansDomain(database!, { plansDomain: fakePlansDomain() }, { scanLeaseTtlSeconds: 900 });
    }

    function createActiveConnection(): string {
      const connectionId = randomUUID();
      runtimeSql(`
        INSERT INTO app.mailbox_connections (
          id, tenant_id, personal_profile_id, owner_user_id, provider,
          provider_account_id, account_email, status, timezone, local_scan_time,
          vault_reference
        ) VALUES (
          '${connectionId}', '${TENANT_ID}', '${PROFILE_ID}', '${OWNER_USER_ID}', 'gmail',
          'acct-${connectionId}', 'owner@example.test', 'active', 'America/Los_Angeles', '07:00',
          'vault-${connectionId}'
        )
      `);
      return connectionId;
    }

    it("finalizes succeeded, releases the lease, and lets the next scan start immediately", async () => {
      const domain = createDomain();
      const connectionId = createActiveConnection();
      const started = await domain.startManualScan({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, requestId: randomUUID(),
      });
      expect(started.status).toBe("started");

      const result = await domain.finalizeScanRun({
        scanRunId: started.scanRun.id,
        outcome: "succeeded",
      });
      expect(result.scanRun.status).toBe("completed");
      expect(result.scanRun.completedAt).not.toBeNull();
      expect(result.leaseReleased).toBe(true);

      const next = await domain.startManualScan({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, requestId: randomUUID(),
      });
      expect(next.status).toBe("started");
      expect(next.scanRun.id).not.toBe(started.scanRun.id);
    });

    it("finalizes failed and releases the lease", async () => {
      const domain = createDomain();
      const connectionId = createActiveConnection();
      const started = await domain.startManualScan({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, requestId: randomUUID(),
      });

      const result = await domain.finalizeScanRun({
        scanRunId: started.scanRun.id,
        outcome: "failed",
      });
      expect(result.scanRun.status).toBe("failed");
      expect(result.leaseReleased).toBe(true);

      const next = await domain.startManualScan({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, requestId: randomUUID(),
      });
      expect(next.status).toBe("started");
    });

    it("rejects an unknown scan run", async () => {
      const domain = createDomain();
      await expect(
        domain.finalizeScanRun({ scanRunId: randomUUID(), outcome: "succeeded" }),
      ).rejects.toThrow(DomainError.notFound().message);
    });

    it("a stale run's finalize cannot release a successor's lease, but still finalizes its own row", async () => {
      const domain = createDomain();
      const connectionId = createActiveConnection();
      const runA = await domain.startManualScan({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, requestId: randomUUID(),
      });

      // Back-date run A's lease so a second start wins the CAS (same
      // technique mailbox-scans.test.ts's own lease-theft test uses).
      runtimeSql(`
        UPDATE app.mailbox_connections
        SET active_scan_lease_expires_at = now() - interval '1 minute'
        WHERE id = '${connectionId}'
      `);
      const runB = await domain.startManualScan({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, requestId: randomUUID(),
      });
      expect(runB.status).toBe("started");
      expect(runB.scanRun.id).not.toBe(runA.scanRun.id);

      const staleFinalize = await domain.finalizeScanRun({
        scanRunId: runA.scanRun.id,
        outcome: "failed",
      });
      expect(staleFinalize.scanRun.status).toBe("failed");
      expect(staleFinalize.leaseReleased).toBe(false);

      // Run B's lease must still be intact -- a third start attempt is
      // still an overlap, not a fresh start.
      const overlapCheck = await domain.startManualScan({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, requestId: randomUUID(),
      });
      expect(overlapCheck.status).toBe("skipped_overlap");
      expect(overlapCheck.scanRun.id).toBe(runB.scanRun.id);

      const finalizeB = await domain.finalizeScanRun({ scanRunId: runB.scanRun.id, outcome: "succeeded" });
      expect(finalizeB.leaseReleased).toBe(true);
    });

    it("is idempotent: finalizing an already-terminal run returns its state without a second release", async () => {
      const domain = createDomain();
      const connectionId = createActiveConnection();
      const started = await domain.startManualScan({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, requestId: randomUUID(),
      });

      const first = await domain.finalizeScanRun({ scanRunId: started.scanRun.id, outcome: "succeeded" });
      expect(first.leaseReleased).toBe(true);

      const second = await domain.finalizeScanRun({ scanRunId: started.scanRun.id, outcome: "failed" });
      expect(second.scanRun.status).toBe("completed");
      expect(second.leaseReleased).toBe(false);
    });
  },
);
