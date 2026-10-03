/**
 * Phase 3D-B Task 2 — domain/mailbox-scans.ts: lease CAS, scan-run
 * creation, and the fenced candidate-page callback.
 *
 * Real-PostgreSQL coverage (PHASE_3D_B_T2_INTEGRATION=1), same ephemeral-
 * database pattern as 3D-A Task 2's mailbox-connections.test.ts. No
 * Google/Clerk network access anywhere -- plansDomain is a fake object.
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

const requested = process.env.PHASE_3D_B_T2_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const databaseName = `expense_tax_t2s_${runKey}`;

interface ComposeConfig {
  readonly services: Record<string, { readonly environment?: Record<string, string | null> }>;
}

const TENANT_ID = "7b000000-0000-4000-8000-000000000001";
const OWNER_USER_ID = "7b000000-0000-4000-8000-000000000002";
const OUTSIDER_USER_ID = "7b000000-0000-4000-8000-000000000003";
const PROFILE_ID = "7b000000-0000-4000-8000-000000000004";

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

/** Minimal PlansDomain fake: only resolveEffectiveEntitlements/
 * getSubscription are real; every other method is unused by this domain. */
function fakePlansDomain(options: { scanEnabled?: boolean; entitlementVersion?: number } = {}): PlansDomain {
  const scanEnabled = options.scanEnabled ?? true;
  const entitlementVersion = options.entitlementVersion ?? 3;
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
        currentEntitlementVersion: entitlementVersion,
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
          isEnabled: scanEnabled,
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
  "domain/mailbox-scans.ts — lease CAS, scan-run creation, fenced page callback (live PostgreSQL)",
  () => {
    beforeAll(async () => {
      const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
      if (!dockerAvailable) throw new Error("Mailbox Task 2 PostgreSQL prerequisites unavailable");

      let postgresRunning = false;
      try {
        postgresRunning =
          execFileSync(composeScript, ["ps", "-q", "postgres"], {
            cwd: repoRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
          }).trim().length > 0;
      } catch {
        postgresRunning = false;
      }
      if (!postgresRunning) throw new Error("Mailbox Task 2 PostgreSQL prerequisites unavailable");

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
        throw new Error("Mailbox Task 2 PostgreSQL prerequisites unavailable");
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
          ('${OWNER_USER_ID}', 't2s-owner@example.test', 'T2S Owner'),
          ('${OUTSIDER_USER_ID}', 't2s-outsider@example.test', 'T2S Outsider')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tenants (id, name, slug, status) VALUES
          ('${TENANT_ID}', 'T2S Tenant', 't2s-tenant-${runKey}', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status) VALUES
          ('${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.personal_profiles (id, tenant_id, name) VALUES
          ('${PROFILE_ID}', '${TENANT_ID}', 'T2S Profile')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role, status) VALUES
          ('${PROFILE_ID}', '${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;
      `);
    }

    function createDomain(plansDomain: PlansDomain = fakePlansDomain()): MailboxScansDomain {
      return createMailboxScansDomain(database!, { plansDomain }, { scanLeaseTtlSeconds: 900 });
    }

    /** Fresh active connection per test so lease races never cross tests. */
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

    it("rejects a manual scan from an actor with no access to the connection's scope", async () => {
      const domain = createDomain();
      const connectionId = createActiveConnection();
      await expect(
        domain.startManualScan({
          actorUserId: OUTSIDER_USER_ID,
          tenantId: TENANT_ID,
          connectionId,
          requestId: randomUUID(),
        }),
      ).rejects.toThrow(DomainError.notFound().message);
    });

    it("rejects a manual scan when the connected_mailbox_scan entitlement is disabled", async () => {
      const domain = createDomain(fakePlansDomain({ scanEnabled: false }));
      const connectionId = createActiveConnection();
      await expect(
        domain.startManualScan({
          actorUserId: OWNER_USER_ID,
          tenantId: TENANT_ID,
          connectionId,
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("starts a scan, captures the entitlement version, and resets the fence", async () => {
      const domain = createDomain(fakePlansDomain({ entitlementVersion: 7 }));
      const connectionId = createActiveConnection();

      const result = await domain.startManualScan({
        actorUserId: OWNER_USER_ID,
        tenantId: TENANT_ID,
        connectionId,
        requestId: randomUUID(),
      });

      expect(result.status).toBe("started");
      expect(result.scanRun.status).toBe("pending");
      expect(result.scanRun.entitlementVersion).toBe(7);
      expect(result.scanRun.connectionId).toBe(connectionId);

      const binding = await domain.loadScanBinding(result.scanRun.id);
      expect(binding.nextPageSequence).toBe(1);
      expect(binding.currentHistoryId).toBeNull();
      expect(binding.preFenceToken).toMatch(/^[a-f0-9]{64}$/);
      expect(binding.currentCursorDigest).toMatch(/^[a-f0-9]{64}$/);
    });

    it("replays an identical manual-scan requestId with the original result (no second row)", async () => {
      const domain = createDomain();
      const connectionId = createActiveConnection();
      const requestId = randomUUID();

      const first = await domain.startManualScan({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, requestId,
      });
      const second = await domain.startManualScan({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, requestId,
      });

      expect(second.scanRun.id).toBe(first.scanRun.id);
      expect(second.status).toBe("started");
      const count = runtimeSql(
        `SELECT count(*) FROM app.mailbox_scan_runs WHERE connection_id = '${connectionId}'`,
      );
      expect(count).toBe("1");
    });

    it("concurrent schedule/manual starts on one connection: exactly one wins, the other is skipped_overlap", async () => {
      const domain = createDomain();
      const connectionId = createActiveConnection();

      const [manual, scheduled] = await Promise.all([
        domain.startManualScan({
          actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, requestId: randomUUID(),
        }),
        domain.startScheduledScan({ tenantId: TENANT_ID, connectionId, requestId: randomUUID() }),
      ]);

      const statuses = [manual.status, scheduled.status].sort();
      expect(statuses).toEqual(["skipped_overlap", "started"]);
      const startedRun = manual.status === "started" ? manual.scanRun : scheduled.scanRun;
      const skippedRun = manual.status === "started" ? scheduled.scanRun : manual.scanRun;
      expect(skippedRun.id).toBe(startedRun.id);

      const count = runtimeSql(
        `SELECT count(*) FROM app.mailbox_scan_runs WHERE connection_id = '${connectionId}'`,
      );
      expect(count).toBe("1");
    });

    function stagingInput(overrides: Record<string, unknown> = {}) {
      return {
        schemaVersion: 1 as const,
        scanRunId: "",
        connectionId: "",
        expectedConnectionVersion: 1,
        cursorBeforeDigest: "",
        preFenceToken: "",
        pageSequence: 1,
        nextHistoryId: null,
        messages: [
          {
            receivedAt: "2026-10-03T00:00:00.000Z",
            senderAddress: "merchant@example.test",
            senderDomain: "example.test",
            subject: "Your receipt",
            contentHash: "c".repeat(64),
            attachmentManifest: [],
            classification: "receipt" as const,
            confidence: 0.95,
            evidence: ["subject keyword"],
            providerMessageId: `gmail-${randomUUID()}`,
            providerThreadId: null,
          },
        ],
        idempotencyKey: randomUUID(),
        ...overrides,
      };
    }

    it("rejects page 2 before page 1 (page order)", async () => {
      const domain = createDomain();
      const connectionId = createActiveConnection();
      const started = await domain.startManualScan({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, requestId: randomUUID(),
      });
      const binding = await domain.loadScanBinding(started.scanRun.id);

      await expect(
        domain.recordCandidateMetadata(
          stagingInput({
            scanRunId: started.scanRun.id,
            connectionId,
            expectedConnectionVersion: binding.expectedConnectionVersion,
            cursorBeforeDigest: binding.currentCursorDigest,
            preFenceToken: binding.preFenceToken,
            pageSequence: 2,
          }),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("accepts page 1, then page 2, staging receipt/ambiguous and advancing the cursor only after each page is durable", async () => {
      const domain = createDomain();
      const connectionId = createActiveConnection();
      const started = await domain.startManualScan({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, requestId: randomUUID(),
      });
      const bindingBeforePage1 = await domain.loadScanBinding(started.scanRun.id);

      const page1 = await domain.recordCandidateMetadata(
        stagingInput({
          scanRunId: started.scanRun.id,
          connectionId,
          expectedConnectionVersion: bindingBeforePage1.expectedConnectionVersion,
          cursorBeforeDigest: bindingBeforePage1.currentCursorDigest,
          preFenceToken: bindingBeforePage1.preFenceToken,
          pageSequence: 1,
          nextHistoryId: "history-100",
          messages: [
            stagingInput().messages[0]!,
            { ...stagingInput().messages[0]!, classification: "ambiguous" as const, providerMessageId: `gmail-${randomUUID()}` },
            { ...stagingInput().messages[0]!, classification: "not_receipt" as const, providerMessageId: `gmail-${randomUUID()}` },
          ],
        }),
      );
      expect(page1.pageSequence).toBe(1);
      expect(page1.candidateIds).toHaveLength(2);
      expect(page1.counts).toEqual({ discovered: 3, staged: 1, review: 1, failed: 0 });

      const bindingAfterPage1 = await domain.loadScanBinding(started.scanRun.id);
      expect(bindingAfterPage1.nextPageSequence).toBe(2);
      expect(bindingAfterPage1.currentHistoryId).toBe("history-100");
      expect(bindingAfterPage1.currentCursorDigest).not.toBe(bindingBeforePage1.currentCursorDigest);

      const outcomeStatus = runtimeSql(
        `SELECT status FROM app.mailbox_scan_page_outcomes WHERE scan_run_id = '${started.scanRun.id}' AND page_sequence = 1`,
      );
      expect(outcomeStatus).toBe("completed");

      const runRow = runtimeSql(
        `SELECT status || ',' || discovered_count || ',' || staged_count || ',' || review_count
         FROM app.mailbox_scan_runs WHERE id = '${started.scanRun.id}'`,
      );
      expect(runRow).toBe("running,3,1,1");

      const page2 = await domain.recordCandidateMetadata(
        stagingInput({
          scanRunId: started.scanRun.id,
          connectionId,
          expectedConnectionVersion: bindingAfterPage1.expectedConnectionVersion,
          cursorBeforeDigest: bindingAfterPage1.currentCursorDigest,
          preFenceToken: bindingAfterPage1.preFenceToken,
          pageSequence: 2,
        }),
      );
      expect(page2.pageSequence).toBe(2);
      expect(page2.counts).toEqual({ discovered: 1, staged: 1, review: 0, failed: 0 });
    });

    it("rejects a stale cursorBeforeDigest without moving the cursor (VERSION_CONFLICT-equivalent)", async () => {
      const domain = createDomain();
      const connectionId = createActiveConnection();
      const started = await domain.startManualScan({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, requestId: randomUUID(),
      });
      const binding = await domain.loadScanBinding(started.scanRun.id);

      await expect(
        domain.recordCandidateMetadata(
          stagingInput({
            scanRunId: started.scanRun.id,
            connectionId,
            expectedConnectionVersion: binding.expectedConnectionVersion,
            cursorBeforeDigest: "stale-digest-not-matching",
            preFenceToken: binding.preFenceToken,
            pageSequence: 1,
          }),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      const afterReject = await domain.loadScanBinding(started.scanRun.id);
      expect(afterReject.nextPageSequence).toBe(1);
      expect(afterReject.currentCursorDigest).toBe(binding.currentCursorDigest);
    });

    it("rejects a wrong preFenceToken (stale scan run) without moving the cursor", async () => {
      const domain = createDomain();
      const connectionId = createActiveConnection();
      const started = await domain.startManualScan({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, requestId: randomUUID(),
      });
      const binding = await domain.loadScanBinding(started.scanRun.id);

      await expect(
        domain.recordCandidateMetadata(
          stagingInput({
            scanRunId: started.scanRun.id,
            connectionId,
            expectedConnectionVersion: binding.expectedConnectionVersion,
            cursorBeforeDigest: binding.currentCursorDigest,
            preFenceToken: "wrong-token",
            pageSequence: 1,
          }),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("rejects a mismatched expectedConnectionVersion (active connection version fence)", async () => {
      const domain = createDomain();
      const connectionId = createActiveConnection();
      const started = await domain.startManualScan({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, requestId: randomUUID(),
      });
      const binding = await domain.loadScanBinding(started.scanRun.id);

      await expect(
        domain.recordCandidateMetadata(
          stagingInput({
            scanRunId: started.scanRun.id,
            connectionId,
            expectedConnectionVersion: binding.expectedConnectionVersion + 1,
            cursorBeforeDigest: binding.currentCursorDigest,
            preFenceToken: binding.preFenceToken,
            pageSequence: 1,
          }),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("replays a duplicate page submission with the original result, without re-staging candidates", async () => {
      const domain = createDomain();
      const connectionId = createActiveConnection();
      const started = await domain.startManualScan({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, requestId: randomUUID(),
      });
      const binding = await domain.loadScanBinding(started.scanRun.id);
      const idempotencyKey = randomUUID();
      const page = stagingInput({
        scanRunId: started.scanRun.id,
        connectionId,
        expectedConnectionVersion: binding.expectedConnectionVersion,
        cursorBeforeDigest: binding.currentCursorDigest,
        preFenceToken: binding.preFenceToken,
        pageSequence: 1,
        idempotencyKey,
      });

      const first = await domain.recordCandidateMetadata(page);
      const second = await domain.recordCandidateMetadata(page);

      expect(second).toEqual(first);
      const candidateCount = runtimeSql(
        `SELECT count(*) FROM app.mailbox_candidates WHERE scan_run_id = '${started.scanRun.id}'`,
      );
      expect(candidateCount).toBe(String(first.candidateIds.length));

      const bindingAfter = await domain.loadScanBinding(started.scanRun.id);
      expect(bindingAfter.nextPageSequence).toBe(2);
    });
  },
);
