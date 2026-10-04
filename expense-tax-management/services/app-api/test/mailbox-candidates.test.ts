/**
 * Phase 3D-B Task 5 — domain/mailbox-candidates.ts: authorized list/
 * detail, review-action resolve transaction, reviewer grants, retry-only
 * transient errors, and terminal-status guards.
 *
 * Real-PostgreSQL coverage (PHASE_3D_B_T5_INTEGRATION=1), same ephemeral-
 * database pattern as Task 2's mailbox-scans.test.ts. No Google/Clerk
 * network access anywhere.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MailboxCandidateV1Schema } from "@expense-tax/contracts";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAppDatabase } from "../src/database/client.js";
import type { AppDatabase } from "../src/database/types.js";
import { runMigrations } from "../src/database/migrate.js";
import {
  createMailboxCandidatesDomain,
  type MailboxCandidatesDomain,
} from "../src/domain/mailbox-candidates.js";
import { createExpenseDomain } from "../src/domain/expenses.js";
import { createProcessingJobsDomain } from "../src/domain/processing-jobs.js";
import type { StartWorkflowInput, TemporalWorkflowStarter } from "../src/temporal/client.js";

const requested = process.env.PHASE_3D_B_T5_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const databaseName = `expense_tax_t5c_${runKey}`;

interface ComposeConfig {
  readonly services: Record<string, { readonly environment?: Record<string, string | null> }>;
}

const TENANT_ID = "7c000000-0000-4000-8000-000000000001";
const OWNER_USER_ID = "7c000000-0000-4000-8000-000000000002";
const MEMBER_USER_ID = "7c000000-0000-4000-8000-000000000003";
const OUTSIDER_USER_ID = "7c000000-0000-4000-8000-000000000004";
const PROFILE_ID = "7c000000-0000-4000-8000-000000000005";
const BUSINESS_ID = "7c000000-0000-4000-8000-000000000006";

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

const DUMMY_HASH = "a".repeat(64);

describe.skipIf(!requested)(
  "domain/mailbox-candidates.ts — authorized review actions (live PostgreSQL)",
  () => {
    beforeAll(async () => {
      const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
      if (!dockerAvailable) throw new Error("Mailbox Task 5 PostgreSQL prerequisites unavailable");

      let postgresRunning = false;
      try {
        postgresRunning =
          execFileSync(composeScript, ["ps", "-q", "postgres"], {
            cwd: repoRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
          }).trim().length > 0;
      } catch {
        postgresRunning = false;
      }
      if (!postgresRunning) throw new Error("Mailbox Task 5 PostgreSQL prerequisites unavailable");

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
        throw new Error("Mailbox Task 5 PostgreSQL prerequisites unavailable");
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
          ('${OWNER_USER_ID}', 't5c-owner@example.test', 'T5C Owner'),
          ('${MEMBER_USER_ID}', 't5c-member@example.test', 'T5C Member'),
          ('${OUTSIDER_USER_ID}', 't5c-outsider@example.test', 'T5C Outsider')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tenants (id, name, slug, status) VALUES
          ('${TENANT_ID}', 'T5C Tenant', 't5c-tenant-${runKey}', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status) VALUES
          ('${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active'),
          ('${TENANT_ID}', '${MEMBER_USER_ID}', 'member', 'active'),
          ('${TENANT_ID}', '${OUTSIDER_USER_ID}', 'member', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.personal_profiles (id, tenant_id, name) VALUES
          ('${PROFILE_ID}', '${TENANT_ID}', 'T5C Profile')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role, status) VALUES
          ('${PROFILE_ID}', '${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.businesses (id, tenant_id, name, industry_code, timezone, base_currency, status)
        VALUES ('${BUSINESS_ID}', '${TENANT_ID}', 'T5C Business', 'restaurant', 'America/Los_Angeles', 'USD', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.business_memberships (business_id, tenant_id, user_id, role, status) VALUES
          ('${BUSINESS_ID}', '${TENANT_ID}', '${MEMBER_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;
      `);
    }

    function createDomain(mailboxEnabled = true): MailboxCandidatesDomain {
      return createMailboxCandidatesDomain(database!, { mailboxEnabled });
    }

    /** Fresh connection + scan run per test so fixtures never collide. */
    function createConnectionAndScanRun(): { connectionId: string; scanRunId: string } {
      const connectionId = randomUUID();
      const scanRunId = randomUUID();
      runtimeSql(`
        INSERT INTO app.mailbox_connections (
          id, tenant_id, personal_profile_id, owner_user_id, provider,
          provider_account_id, account_email, status, timezone, local_scan_time,
          vault_reference
        ) VALUES (
          '${connectionId}', '${TENANT_ID}', '${PROFILE_ID}', '${OWNER_USER_ID}', 'gmail',
          'acct-${connectionId}', 'owner@example.test', 'active', 'America/Los_Angeles', '07:00',
          'vault-${connectionId}'
        );
        INSERT INTO app.mailbox_scan_runs (
          id, connection_id, tenant_id, initiated_by, entitlement_version, connection_version,
          status, idempotency_key, normalized_request_hash, completed_at
        ) VALUES (
          '${scanRunId}', '${connectionId}', '${TENANT_ID}', '${OWNER_USER_ID}', 1, 1,
          'completed', 'seed-${scanRunId}', '${DUMMY_HASH}', now()
        );
      `);
      return { connectionId, scanRunId };
    }

    function insertCandidate(
      connectionId: string,
      scanRunId: string,
      overrides: {
        readonly status?: string;
        readonly classification?: string;
        readonly errorCode?: string | null;
        readonly scopePersonal?: string | null;
        readonly scopeBusiness?: string | null;
      } = {},
    ): string {
      const candidateId = randomUUID();
      const status = overrides.status ?? "review";
      const classification = overrides.classification ?? "ambiguous";
      const errorCode = overrides.errorCode ?? null;
      runtimeSql(`
        INSERT INTO app.mailbox_candidates (
          id, scan_run_id, connection_id, tenant_id, received_at, sender_address, sender_domain,
          subject, content_hash, classification, confidence, evidence,
          candidate_personal_profile_id, candidate_business_id, status, error_code,
          idempotency_key, normalized_request_hash, provider_message_id
        ) VALUES (
          '${candidateId}', '${scanRunId}', '${connectionId}', '${TENANT_ID}', now(),
          'sender@shopwaveco.example', 'shopwaveco.example', 'Your order confirmation',
          '${DUMMY_HASH}', '${classification}', 0.5, '{}',
          ${overrides.scopePersonal ? `'${overrides.scopePersonal}'` : "NULL"},
          ${overrides.scopeBusiness ? `'${overrides.scopeBusiness}'` : "NULL"},
          '${status}', ${errorCode ? `'${errorCode}'` : "NULL"},
          'cand-${candidateId}', '${DUMMY_HASH}', 'provider-${candidateId}'
        )
      `);
      return candidateId;
    }

    function grantReviewer(connectionId: string, userId: string, revoked = false): void {
      runtimeSql(`
        INSERT INTO app.mailbox_reviewer_grants (id, connection_id, tenant_id, user_id, role, revoked_at)
        VALUES ('${randomUUID()}', '${connectionId}', '${TENANT_ID}', '${userId}', 'reviewer',
          ${revoked ? "now()" : "NULL"})
      `);
    }

    /**
     * Phase 3D-C Task 5 gap closure 2 -- directly seeds a mailbox job row
     * (materialize or per-attachment OCR) so tests can exercise
     * maybeFailMailboxCandidateInTransaction (processing-jobs.ts) through
     * the domain's own recordStatusUpdate/submitResult without needing a
     * real Temporal worker.
     */
    function insertMailboxJob(
      candidateId: string,
      workflowType: "MailboxMaterializeWorkflow" | "MailboxOcrReceiptWorkflow",
      status: "DISPATCHED" | "RUNNING" | "PENDING" | "SUCCEEDED" | "FAILED" = "DISPATCHED",
    ): string {
      const jobId = randomUUID();
      const resultSchemaVersion =
        workflowType === "MailboxMaterializeWorkflow" ? "mailbox-materialize-v1" : "ocr-extraction-v1";
      const targetAggregateType = workflowType === "MailboxMaterializeWorkflow" ? "mailbox_candidate" : "NULL";
      // Fix round 1 (review finding #1 coverage) -- processing_jobs_
      // completion_state_check requires completed_at set (only) for a
      // terminal status; the pre-existing DISPATCHED/RUNNING-only helper
      // never had to satisfy this.
      const isTerminal = status === "SUCCEEDED" || status === "FAILED";
      runtimeSql(`
        INSERT INTO app.processing_jobs (
          id, tenant_id, personal_profile_id, workflow_type, workflow_id, task_queue,
          dispatch_generation, dispatch_namespace, run_id, status,
          ${workflowType === "MailboxMaterializeWorkflow" ? "target_aggregate_type, target_aggregate_id," : ""}
          input_params, allowed_result_schema_version, version, created_at, updated_at, dispatched_at, completed_at
        ) VALUES (
          '${jobId}', '${TENANT_ID}', '${PROFILE_ID}', '${workflowType}', 'job-${jobId}',
          'expense-tax-processing', 1, 'expense-tax', 'fake-run-${jobId}', '${status}',
          ${workflowType === "MailboxMaterializeWorkflow" ? `'${targetAggregateType}', '${candidateId}',` : ""}
          '{"mailboxCandidateId": "${candidateId}"}', '${resultSchemaVersion}', 2, now(), now(), now(),
          ${isTerminal ? "now()" : "NULL"}
        );
      `);
      return jobId;
    }

    function noopStarter(): TemporalWorkflowStarter {
      return {
        start: async () => ({ runId: "unused" }),
        close: async () => undefined,
      };
    }

    // ---------------------------------------------------------------- //
    // Authorization: owner / exact reviewer grants / outsider
    // ---------------------------------------------------------------- //

    it("rejects list access for an actor with no scope membership, no reviewer grant, and no owner relationship", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      insertCandidate(connectionId, scanRunId);

      await expect(
        domain.listCandidates({ actorUserId: OUTSIDER_USER_ID, tenantId: TENANT_ID, connectionId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("grants list/resolve access to a non-owner with an exact non-revoked reviewer grant", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId);
      grantReviewer(connectionId, OUTSIDER_USER_ID);

      const result = await domain.listCandidates({
        actorUserId: OUTSIDER_USER_ID, tenantId: TENANT_ID, connectionId,
      });
      expect(result.items.map((item) => item.id)).toContain(candidateId);
    });

    it("rejects access for a user whose reviewer grant has been revoked", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      insertCandidate(connectionId, scanRunId);
      grantReviewer(connectionId, OUTSIDER_USER_ID, true);

      await expect(
        domain.listCandidates({ actorUserId: OUTSIDER_USER_ID, tenantId: TENANT_ID, connectionId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("the connection owner always has access without a reviewer grant", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      insertCandidate(connectionId, scanRunId);

      await expect(
        domain.listCandidates({ actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId }),
      ).resolves.toMatchObject({});
    });

    // ---------------------------------------------------------------- //
    // Fix round 1 (review Important #2): no generic scope-membership
    // shortcut; revoked connection removes owner/reviewer access; an
    // inactive tenant membership removes owner access even though the
    // connection row's owner_user_id is unchanged.
    // ---------------------------------------------------------------- //

    it("rejects a user with ordinary Personal/business scope membership but no owner relationship and no reviewer grant", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      insertCandidate(connectionId, scanRunId);
      // MEMBER_USER_ID is a business_memberships owner (seeded globally)
      // but has no reviewer grant on *this* connection and is not its
      // owner_user_id -- scope membership alone must not grant access.
      await expect(
        domain.listCandidates({ actorUserId: MEMBER_USER_ID, tenantId: TENANT_ID, connectionId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("rejects the connection owner's own access once the connection is revoked", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      insertCandidate(connectionId, scanRunId);
      runtimeSql(`UPDATE app.mailbox_connections SET status = 'revoked', revoked_at = now() WHERE id = '${connectionId}'`);

      await expect(
        domain.listCandidates({ actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("rejects a non-revoked reviewer grant once the connection itself is revoked", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      insertCandidate(connectionId, scanRunId);
      grantReviewer(connectionId, OUTSIDER_USER_ID);
      runtimeSql(`UPDATE app.mailbox_connections SET status = 'revoked', revoked_at = now() WHERE id = '${connectionId}'`);

      await expect(
        domain.listCandidates({ actorUserId: OUTSIDER_USER_ID, tenantId: TENANT_ID, connectionId }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("still allows review while the connection is only reauth_required (reauth pauses scanning only, per the approved mockup)", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      insertCandidate(connectionId, scanRunId);
      runtimeSql(`UPDATE app.mailbox_connections SET status = 'reauth_required' WHERE id = '${connectionId}'`);

      await expect(
        domain.listCandidates({ actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId }),
      ).resolves.toMatchObject({});
    });

    it("rejects the owner once their own tenant membership is inactive", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      insertCandidate(connectionId, scanRunId);
      runtimeSql(
        `UPDATE app.tenant_memberships SET status = 'inactive' WHERE tenant_id = '${TENANT_ID}' AND user_id = '${OWNER_USER_ID}'`,
      );

      try {
        await expect(
          domain.listCandidates({ actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      } finally {
        // Restore -- OWNER_USER_ID's tenant membership is shared fixture
        // state reused by every other test in this file.
        runtimeSql(
          `UPDATE app.tenant_memberships SET status = 'active' WHERE tenant_id = '${TENANT_ID}' AND user_id = '${OWNER_USER_ID}'`,
        );
      }
    });

    // ---------------------------------------------------------------- //
    // Ambiguous-scope candidates visible in the review list
    // ---------------------------------------------------------------- //

    it("lists an ambiguous (unassigned-scope) candidate for the owner", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId, { classification: "ambiguous" });

      const result = await domain.listCandidates({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, classification: "ambiguous",
      });
      const item = result.items.find((candidate) => candidate.id === candidateId);
      expect(item?.scope).toBeNull();
      expect(item?.status).toBe("review");
    });

    // ---------------------------------------------------------------- //
    // Current target-scope membership required for `ingest`
    // ---------------------------------------------------------------- //

    it("rejects ingest into a business scope the actor is not currently a member of", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId);
      grantReviewer(connectionId, OUTSIDER_USER_ID);

      // Same "no access" convention `requireScopeRole` uses everywhere
      // else in this codebase (e.g. mailbox-scans.test.ts's own "rejects
      // a manual scan from an actor with no access to the connection's
      // scope"): NOT_FOUND, not FORBIDDEN -- no access is indistinguishable
      // from no such scope, by design.
      await expect(
        domain.resolveCandidate({
          actorUserId: OUTSIDER_USER_ID,
          tenantId: TENANT_ID,
          connectionId,
          candidateId,
          action: "ingest",
          scope: { kind: "business", businessId: BUSINESS_ID },
          expectedCandidateVersion: 1,
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("allows ingest into a business scope the actor currently belongs to", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId);
      grantReviewer(connectionId, MEMBER_USER_ID);

      const result = await domain.resolveCandidate({
        actorUserId: MEMBER_USER_ID,
        tenantId: TENANT_ID,
        connectionId,
        candidateId,
        action: "ingest",
        scope: { kind: "business", businessId: BUSINESS_ID },
        expectedCandidateVersion: 1,
        requestId: randomUUID(),
      });
      expect(result.status).toBe("queued");
      expect(result.scope).toEqual({ kind: "business", businessId: BUSINESS_ID });
    });

    // ---------------------------------------------------------------- //
    // Duplicate-pending / terminal-status candidates cannot be resolved
    // ---------------------------------------------------------------- //

    it("rejects resolving a candidate already in a terminal 'duplicate' status", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId, { status: "duplicate" });

      await expect(
        domain.resolveCandidate({
          actorUserId: OWNER_USER_ID,
          tenantId: TENANT_ID,
          connectionId,
          candidateId,
          action: "skip",
          expectedCandidateVersion: 1,
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      const status = runtimeSql(`SELECT status FROM app.mailbox_candidates WHERE id = '${candidateId}'`);
      expect(status).toBe("duplicate");
    });

    // ---------------------------------------------------------------- //
    // skip / not_receipt both terminal; version conflict; idempotent replay
    // ---------------------------------------------------------------- //

    it("skip and not_receipt both set status to skipped, told apart by audit action only", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const skipId = insertCandidate(connectionId, scanRunId);
      const notReceiptId = insertCandidate(connectionId, scanRunId);

      const skipped = await domain.resolveCandidate({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, candidateId: skipId,
        action: "skip", expectedCandidateVersion: 1, requestId: randomUUID(),
      });
      const notReceipt = await domain.resolveCandidate({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, candidateId: notReceiptId,
        action: "not_receipt", expectedCandidateVersion: 1, requestId: randomUUID(),
      });
      expect(skipped.status).toBe("skipped");
      expect(notReceipt.status).toBe("skipped");

      const skipAudit = runtimeSql(
        `SELECT action FROM app.app_audit_events WHERE resource_id = '${skipId}' ORDER BY id DESC LIMIT 1`,
      );
      const notReceiptAudit = runtimeSql(
        `SELECT action FROM app.app_audit_events WHERE resource_id = '${notReceiptId}' ORDER BY id DESC LIMIT 1`,
      );
      expect(skipAudit).toBe("mailbox_candidate.skip");
      expect(notReceiptAudit).toBe("mailbox_candidate.not_receipt");
    });

    it("rejects a resolve with a stale expectedCandidateVersion", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId);

      await expect(
        domain.resolveCandidate({
          actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, candidateId,
          action: "skip", expectedCandidateVersion: 99, requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    });

    it("replays an identical resolve requestId with the original result (no second mutation)", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId);
      const requestId = randomUUID();

      const first = await domain.resolveCandidate({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, candidateId,
        action: "skip", expectedCandidateVersion: 1, requestId,
      });
      const second = await domain.resolveCandidate({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, candidateId,
        action: "skip", expectedCandidateVersion: 1, requestId,
      });
      expect(second).toEqual(first);
      const version = runtimeSql(`SELECT version FROM app.mailbox_candidates WHERE id = '${candidateId}'`);
      expect(version).toBe("2");
    });

    // ---------------------------------------------------------------- //
    // retry: transient errors only
    // ---------------------------------------------------------------- //

    it("allows retry for a failed candidate with a transient error code, resetting it to review", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId, {
        status: "failed", errorCode: "GOOGLE_RATE_LIMITED",
      });

      const result = await domain.resolveCandidate({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, candidateId,
        action: "retry", expectedCandidateVersion: 1, requestId: randomUUID(),
      });
      expect(result.status).toBe("review");
      expect(result.errorCode).toBeNull();
    });

    it("rejects retry for a failed candidate with a permanent (non-transient) error code", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId, {
        status: "failed", errorCode: "GOOGLE_REAUTH_REQUIRED",
      });

      await expect(
        domain.resolveCandidate({
          actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, candidateId,
          action: "retry", expectedCandidateVersion: 1, requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("rejects retry for a candidate that is not currently failed", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId, { status: "review" });

      await expect(
        domain.resolveCandidate({
          actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, candidateId,
          action: "retry", expectedCandidateVersion: 1, requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    // ---------------------------------------------------------------- //
    // No raw body -- the public contract has no such field, structurally
    // ---------------------------------------------------------------- //

    it("the returned candidate validates against the strict public contract (no raw-body field can sneak through)", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId);

      const result = await domain.resolveCandidate({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, candidateId,
        action: "skip", expectedCandidateVersion: 1, requestId: randomUUID(),
      });
      expect(() => MailboxCandidateV1Schema.parse(result)).not.toThrow();
    });

    // ---------------------------------------------------------------- //
    // Phase 3D-C Task 5 gap closure (controller ruling) -- ingest creates
    // a MailboxMaterializeWorkflow processing job + outbox row in the
    // SAME transaction, stamped with the fixed TypeScript target.
    // ---------------------------------------------------------------- //

    it("ingest creates exactly one MailboxMaterializeWorkflow job + outbox row, stamped with the fixed TypeScript target", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId);

      const result = await domain.resolveCandidate({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, candidateId,
        action: "ingest", scope: { kind: "personal", profileId: PROFILE_ID },
        expectedCandidateVersion: 1, requestId: randomUUID(),
      });
      expect(result.status).toBe("queued");
      expect(result.processingJobId).not.toBeNull();

      const jobCount = runtimeSql(
        `SELECT count(*) FROM app.processing_jobs WHERE target_aggregate_type = 'mailbox_candidate' AND target_aggregate_id = '${candidateId}' AND workflow_type = 'MailboxMaterializeWorkflow'`,
      );
      expect(jobCount).toBe("1");
      const jobRow = runtimeSql(
        `SELECT task_queue, dispatch_namespace, status FROM app.processing_jobs WHERE id = '${result.processingJobId}'`,
      );
      expect(jobRow).toBe("expense-tax-processing|expense-tax|PENDING");

      const outboxCount = runtimeSql(
        `SELECT count(*) FROM app.processing_job_dispatch_outbox WHERE processing_job_id = '${result.processingJobId}'`,
      );
      expect(outboxCount).toBe("1");
    });

    it("creates at most one materialize job for concurrent duplicate ingest requests on the same candidate+version", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId);

      const attempt = () =>
        domain.resolveCandidate({
          actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, candidateId,
          action: "ingest", scope: { kind: "personal", profileId: PROFILE_ID },
          expectedCandidateVersion: 1, requestId: randomUUID(),
        });

      const results = await Promise.allSettled([attempt(), attempt()]);
      const fulfilledCount = results.filter((settled) => settled.status === "fulfilled").length;
      expect(fulfilledCount).toBeGreaterThanOrEqual(1);

      const jobCount = runtimeSql(
        `SELECT count(*) FROM app.processing_jobs WHERE target_aggregate_type = 'mailbox_candidate' AND target_aggregate_id = '${candidateId}' AND workflow_type = 'MailboxMaterializeWorkflow'`,
      );
      expect(jobCount).toBe("1");
    });

    it("dispatchPendingJobs starts MailboxMaterializeWorkflow with the fixed TypeScript namespace/task queue", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId);
      const result = await domain.resolveCandidate({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, candidateId,
        action: "ingest", scope: { kind: "personal", profileId: PROFILE_ID },
        expectedCandidateVersion: 1, requestId: randomUUID(),
      });

      const calls: StartWorkflowInput[] = [];
      const recordingStarter: TemporalWorkflowStarter = {
        start: async (input) => {
          calls.push(input);
          return { runId: "fake-run-materialize-1" };
        },
        close: async () => undefined,
      };
      const processingJobsDomain = createProcessingJobsDomain(database!, recordingStarter);
      await processingJobsDomain.dispatchPendingJobs({ limit: 10 });

      expect(calls).toContainEqual(
        expect.objectContaining({
          workflowType: "MailboxMaterializeWorkflow",
          taskQueue: "expense-tax-processing",
          namespace: "expense-tax",
        }),
      );
      const status = runtimeSql(`SELECT status FROM app.processing_jobs WHERE id = '${result.processingJobId}'`);
      expect(status).toBe("DISPATCHED");
    });

    it("refuses ingest when the mailbox feature is disabled, before any side effect", async () => {
      const domain = createDomain(false);
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId);

      await expect(
        domain.resolveCandidate({
          actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, candidateId,
          action: "ingest", scope: { kind: "personal", profileId: PROFILE_ID },
          expectedCandidateVersion: 1, requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "FEATURE_DISABLED" });

      const status = runtimeSql(`SELECT status FROM app.mailbox_candidates WHERE id = '${candidateId}'`);
      expect(status).toBe("review");
      const jobCount = runtimeSql(
        `SELECT count(*) FROM app.processing_jobs WHERE target_aggregate_type = 'mailbox_candidate' AND target_aggregate_id = '${candidateId}'`,
      );
      expect(jobCount).toBe("0");
    });

    it("re-enqueues a fresh materialize job when the previous one is terminal-failed", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId, {
        status: "failed", errorCode: "GOOGLE_RATE_LIMITED",
      });

      // retry clears the Gmail-transient failure back to review (existing
      // behavior, unrelated to materialize jobs).
      const retried = await domain.resolveCandidate({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, candidateId,
        action: "retry", expectedCandidateVersion: 1, requestId: randomUUID(),
      });
      expect(retried.status).toBe("review");

      // Seed a prior terminal-FAILED materialize job directly -- simulates
      // a previous ingest attempt whose MailboxMaterializeWorkflow failed.
      const staleJobId = randomUUID();
      runtimeSql(`
        INSERT INTO app.processing_jobs (
          id, tenant_id, personal_profile_id, workflow_type, workflow_id, task_queue,
          dispatch_generation, dispatch_namespace, run_id, status, target_aggregate_type, target_aggregate_id,
          input_params, allowed_result_schema_version, version, created_at, updated_at, dispatched_at, completed_at
        ) VALUES (
          '${staleJobId}', '${TENANT_ID}', '${PROFILE_ID}', 'MailboxMaterializeWorkflow', 'job-${staleJobId}',
          'expense-tax-processing', 1, 'expense-tax', 'fake-run-stale', 'FAILED', 'mailbox_candidate', '${candidateId}',
          '{}', 'mailbox-materialize-v1', 2, now(), now(), now(), now()
        );
      `);

      const result = await domain.resolveCandidate({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, candidateId,
        action: "ingest", scope: { kind: "personal", profileId: PROFILE_ID },
        expectedCandidateVersion: 2, requestId: randomUUID(),
      });
      expect(result.status).toBe("queued");
      expect(result.processingJobId).not.toBe(staleJobId);

      const jobCount = runtimeSql(
        `SELECT count(*) FROM app.processing_jobs WHERE target_aggregate_type = 'mailbox_candidate' AND target_aggregate_id = '${candidateId}'`,
      );
      expect(jobCount).toBe("2");
    });

    // ---------------------------------------------------------------- //
    // Phase 3D-C Task 5 gap closure 2 (controller ruling) -- candidate
    // terminal failure on a MailboxMaterializeWorkflow/
    // MailboxOcrReceiptWorkflow job reaching FAILED, through
    // processing-jobs.ts's recordStatusUpdate/submitResult.
    // ---------------------------------------------------------------- //

    it("a materialize job's own terminal failure, with no sibling jobs, fails the candidate immediately (MAILBOX_MATERIALIZE_FAILED)", async () => {
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId, { status: "queued" });
      const jobId = insertMailboxJob(candidateId, "MailboxMaterializeWorkflow");

      const processingJobsDomain = createProcessingJobsDomain(database!, noopStarter());
      await processingJobsDomain.recordStatusUpdate({
        jobId,
        request: { schemaVersion: 1, status: "FAILED", idempotencyKey: `t5g2-${jobId}`, expectedJobVersion: 2 },
        actorServicePrincipal: "workflow-worker",
        requestId: randomUUID(),
      });

      const row = runtimeSql(`SELECT status, error_code FROM app.mailbox_candidates WHERE id = '${candidateId}'`);
      expect(row).toBe("failed|MAILBOX_MATERIALIZE_FAILED");
    });

    it("one of several attachment-OCR jobs failing does NOT fail the candidate while a sibling is still in flight", async () => {
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId, { status: "queued" });
      const failingJobId = insertMailboxJob(candidateId, "MailboxOcrReceiptWorkflow");
      insertMailboxJob(candidateId, "MailboxOcrReceiptWorkflow"); // sibling still DISPATCHED

      const processingJobsDomain = createProcessingJobsDomain(database!, noopStarter());
      await processingJobsDomain.recordStatusUpdate({
        jobId: failingJobId,
        request: { schemaVersion: 1, status: "FAILED", idempotencyKey: `t5g2-${failingJobId}`, expectedJobVersion: 2 },
        actorServicePrincipal: "workflow-worker",
        requestId: randomUUID(),
      });

      const row = runtimeSql(`SELECT status, error_code FROM app.mailbox_candidates WHERE id = '${candidateId}'`);
      expect(row).toBe("queued|");
    });

    it("fails the candidate (OCR_EXTRACTION_FAILED) only once EVERY attachment-OCR job has failed", async () => {
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId, { status: "queued" });
      const firstJobId = insertMailboxJob(candidateId, "MailboxOcrReceiptWorkflow");
      const secondJobId = insertMailboxJob(candidateId, "MailboxOcrReceiptWorkflow");

      const processingJobsDomain = createProcessingJobsDomain(database!, noopStarter());
      await processingJobsDomain.recordStatusUpdate({
        jobId: firstJobId,
        request: { schemaVersion: 1, status: "FAILED", idempotencyKey: `t5g2-${firstJobId}`, expectedJobVersion: 2 },
        actorServicePrincipal: "workflow-worker",
        requestId: randomUUID(),
      });
      let row = runtimeSql(`SELECT status, error_code FROM app.mailbox_candidates WHERE id = '${candidateId}'`);
      expect(row).toBe("queued|"); // one sibling (secondJobId) still in flight

      await processingJobsDomain.recordStatusUpdate({
        jobId: secondJobId,
        request: { schemaVersion: 1, status: "FAILED", idempotencyKey: `t5g2-${secondJobId}`, expectedJobVersion: 2 },
        actorServicePrincipal: "workflow-worker",
        requestId: randomUUID(),
      });
      row = runtimeSql(`SELECT status, error_code FROM app.mailbox_candidates WHERE id = '${candidateId}'`);
      expect(row).toBe("failed|OCR_EXTRACTION_FAILED");
    });

    it("a sibling's success (candidate already processed) is never overwritten by a later sibling's failure", async () => {
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId, { status: "queued" });
      const failingJobId = insertMailboxJob(candidateId, "MailboxOcrReceiptWorkflow");
      insertMailboxJob(candidateId, "MailboxOcrReceiptWorkflow"); // the "succeeded" sibling
      // Simulate the succeeded sibling having already materialized the
      // candidate (recordConnectedMailboxEvidenceInTransaction's own
      // success path, exercised by mailbox-ingestion.test.ts) -- directly
      // flip status here, since that full pipeline is out of this file's
      // own scope.
      runtimeSql(`UPDATE app.mailbox_candidates SET status = 'processed' WHERE id = '${candidateId}'`);

      const processingJobsDomain = createProcessingJobsDomain(database!, noopStarter());
      await processingJobsDomain.recordStatusUpdate({
        jobId: failingJobId,
        request: { schemaVersion: 1, status: "FAILED", idempotencyKey: `t5g2-${failingJobId}`, expectedJobVersion: 2 },
        actorServicePrincipal: "workflow-worker",
        requestId: randomUUID(),
      });

      const row = runtimeSql(`SELECT status, error_code FROM app.mailbox_candidates WHERE id = '${candidateId}'`);
      expect(row).toBe("processed|");
    });

    it("submitResult's own FAILED path (the legacy result-submission shape) applies the same rule", async () => {
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId, { status: "queued" });
      const jobId = insertMailboxJob(candidateId, "MailboxOcrReceiptWorkflow");

      const processingJobsDomain = createProcessingJobsDomain(database!, noopStarter());
      await processingJobsDomain.submitResult({
        jobId,
        request: {
          schemaVersion: 1,
          status: "FAILED",
          idempotencyKey: `t5g2-submit-${jobId}`,
          expectedJobVersion: 2,
          resultSchemaVersion: "ocr-extraction-v1",
          result: { error: "OCR_FAILED" },
        },
        actorServicePrincipal: "workflow-worker",
        requestId: randomUUID(),
      });

      const row = runtimeSql(`SELECT status, error_code FROM app.mailbox_candidates WHERE id = '${candidateId}'`);
      expect(row).toBe("failed|OCR_EXTRACTION_FAILED");
    });

    it("retry on a processing-caused failure (OCR_EXTRACTION_FAILED) clears to review, same as a Gmail-transient one -- migration 019 allows no other transition out of 'failed'", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId, {
        status: "failed", errorCode: "OCR_EXTRACTION_FAILED", scopePersonal: PROFILE_ID,
      });

      const result = await domain.resolveCandidate({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, candidateId,
        action: "retry", expectedCandidateVersion: 1, requestId: randomUUID(),
      });

      expect(result.status).toBe("review");
      expect(result.errorCode).toBeNull();
    });

    it("retry on a MAILBOX_MATERIALIZE_FAILED candidate, then ingest again, re-enqueues a fresh materialize job (full two-step recovery)", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId, {
        status: "failed", errorCode: "MAILBOX_MATERIALIZE_FAILED", scopePersonal: PROFILE_ID,
      });

      const retried = await domain.resolveCandidate({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, candidateId,
        action: "retry", expectedCandidateVersion: 1, requestId: randomUUID(),
      });
      expect(retried.status).toBe("review");

      const reingested = await domain.resolveCandidate({
        actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, candidateId,
        action: "ingest", scope: { kind: "personal", profileId: PROFILE_ID },
        expectedCandidateVersion: retried.version, requestId: randomUUID(),
      });
      expect(reingested.status).toBe("queued");
      expect(reingested.processingJobId).not.toBeNull();

      const jobCount = runtimeSql(
        `SELECT count(*) FROM app.processing_jobs WHERE target_aggregate_type = 'mailbox_candidate' AND target_aggregate_id = '${candidateId}'`,
      );
      expect(jobCount).toBe("1"); // no prior job existed for this candidate (seeded status directly)
    });

    it("rejects retry for a candidate failed with a non-retryable error code (neither Gmail-transient nor processing-caused)", async () => {
      const domain = createDomain();
      const { connectionId, scanRunId } = createConnectionAndScanRun();
      const candidateId = insertCandidate(connectionId, scanRunId, {
        status: "failed", errorCode: "ENTITLEMENT_DISABLED",
      });

      await expect(
        domain.resolveCandidate({
          actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, candidateId,
          action: "retry", expectedCandidateVersion: 1, requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    // ---------------------------------------------------------------- //
    // Phase 3D-C Task 6 fix round 1 (review findings #1, #4) -- bucket
    // filtering/counts and the read-only ingestion-progress summary.
    // ---------------------------------------------------------------- //

    describe("ingestion-status board (fix round 1)", () => {
      it("bucket 'in_progress' returns only scope-assigned queued candidates, with a totalCount ignoring the cursor/limit", async () => {
        const domain = createDomain();
        const { connectionId, scanRunId } = createConnectionAndScanRun();
        const assignedQueued = insertCandidate(connectionId, scanRunId, {
          status: "queued", scopePersonal: PROFILE_ID,
        });
        insertCandidate(connectionId, scanRunId, { status: "queued" }); // unassigned -- never approved
        insertCandidate(connectionId, scanRunId, { status: "processed", scopePersonal: PROFILE_ID }); // wrong bucket

        const result = await domain.listCandidates({
          actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, bucket: "in_progress",
        });

        expect(result.items.map((item) => item.id)).toEqual([assignedQueued]);
        expect(result.totalCount).toBe(1);
      });

      it("bucket 'needs_attention' covers duplicate/review/failed (scope-assigned only); bucket 'completed' covers processed only", async () => {
        const domain = createDomain();
        const { connectionId, scanRunId } = createConnectionAndScanRun();
        const duplicateId = insertCandidate(connectionId, scanRunId, { status: "duplicate", scopePersonal: PROFILE_ID });
        const reviewId = insertCandidate(connectionId, scanRunId, { status: "review", scopePersonal: PROFILE_ID });
        const failedId = insertCandidate(connectionId, scanRunId, { status: "failed", scopePersonal: PROFILE_ID });
        const processedId = insertCandidate(connectionId, scanRunId, { status: "processed", scopePersonal: PROFILE_ID });

        const needsAttention = await domain.listCandidates({
          actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, bucket: "needs_attention",
        });
        expect(new Set(needsAttention.items.map((item) => item.id))).toEqual(
          new Set([duplicateId, reviewId, failedId]),
        );
        expect(needsAttention.totalCount).toBe(3);

        const completed = await domain.listCandidates({
          actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, bucket: "completed",
        });
        expect(completed.items.map((item) => item.id)).toEqual([processedId]);
        expect(completed.totalCount).toBe(1);
      });

      it("a classification-filtered call (candidate review panel) never computes totalCount", async () => {
        const domain = createDomain();
        const { connectionId, scanRunId } = createConnectionAndScanRun();
        insertCandidate(connectionId, scanRunId, { classification: "receipt" });

        const result = await domain.listCandidates({
          actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, classification: "receipt",
        });
        expect(result.totalCount).toBeUndefined();
      });

      it("ingestionProgress is null for a non-queued candidate even with job rows present", async () => {
        const domain = createDomain();
        const { connectionId, scanRunId } = createConnectionAndScanRun();
        const candidateId = insertCandidate(connectionId, scanRunId, {
          status: "review", scopePersonal: PROFILE_ID,
        });
        insertMailboxJob(candidateId, "MailboxMaterializeWorkflow", "RUNNING");

        const result = await domain.listCandidates({
          actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, bucket: "needs_attention",
        });
        const candidate = result.items.find((item) => item.id === candidateId);
        expect(candidate?.ingestionProgress).toBeNull();
      });

      it("ingestionProgress is null for a queued candidate with no materialize job yet (plain 'Queued')", async () => {
        const domain = createDomain();
        const { connectionId, scanRunId } = createConnectionAndScanRun();
        const candidateId = insertCandidate(connectionId, scanRunId, {
          status: "queued", scopePersonal: PROFILE_ID,
        });

        const result = await domain.listCandidates({
          actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, bucket: "in_progress",
        });
        expect(result.items.find((item) => item.id === candidateId)?.ingestionProgress).toBeNull();
      });

      it("ingestionProgress is 'materializing' while the materialize job is RUNNING with no OCR job yet", async () => {
        const domain = createDomain();
        const { connectionId, scanRunId } = createConnectionAndScanRun();
        const candidateId = insertCandidate(connectionId, scanRunId, {
          status: "queued", scopePersonal: PROFILE_ID,
        });
        insertMailboxJob(candidateId, "MailboxMaterializeWorkflow", "RUNNING");

        const result = await domain.listCandidates({
          actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, bucket: "in_progress",
        });
        const candidate = result.items.find((item) => item.id === candidateId);
        expect(candidate?.ingestionProgress).toEqual({
          phase: "materializing",
          attachments: { total: 0, succeeded: 0, failed: 0, pending: 0 },
        });
      });

      it("ingestionProgress is 'processing_attachments' once materialize SUCCEEDED and an OCR job is still pending, counting succeeded/pending OCR jobs", async () => {
        const domain = createDomain();
        const { connectionId, scanRunId } = createConnectionAndScanRun();
        const candidateId = insertCandidate(connectionId, scanRunId, {
          status: "queued", scopePersonal: PROFILE_ID,
        });
        insertMailboxJob(candidateId, "MailboxMaterializeWorkflow", "SUCCEEDED");
        insertMailboxJob(candidateId, "MailboxOcrReceiptWorkflow", "SUCCEEDED");
        insertMailboxJob(candidateId, "MailboxOcrReceiptWorkflow", "DISPATCHED");

        const result = await domain.listCandidates({
          actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, bucket: "in_progress",
        });
        const candidate = result.items.find((item) => item.id === candidateId);
        expect(candidate?.ingestionProgress).toEqual({
          phase: "processing_attachments",
          attachments: { total: 0, succeeded: 1, failed: 0, pending: 1 },
        });
      });

      it("ingestionProgress is null once materialize SUCCEEDED and every OCR job is already terminal (nothing pending)", async () => {
        const domain = createDomain();
        const { connectionId, scanRunId } = createConnectionAndScanRun();
        const candidateId = insertCandidate(connectionId, scanRunId, {
          status: "queued", scopePersonal: PROFILE_ID,
        });
        insertMailboxJob(candidateId, "MailboxMaterializeWorkflow", "SUCCEEDED");
        insertMailboxJob(candidateId, "MailboxOcrReceiptWorkflow", "SUCCEEDED");

        const result = await domain.listCandidates({
          actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, connectionId, bucket: "in_progress",
        });
        expect(result.items.find((item) => item.id === candidateId)?.ingestionProgress).toBeNull();
      });
    });

    // ---------------------------------------------------------------- //
    // Phase 3D-C Task 6 fix round 1 (review finding #6) -- Office
    // expense-detail "Source" block provenance, read directly off the
    // already-persisted expense_sources/mailbox_candidates/
    // mailbox_connections join (domain/expenses.ts's
    // loadMailboxProvenance). Reuses this file's own real-PostgreSQL
    // harness (mailbox connections/candidates already migrated here)
    // rather than standing up a second Docker-gated file.
    // ---------------------------------------------------------------- //

    describe("expense-detail connected-mailbox provenance (fix round 1)", () => {
      function insertExpenseWithMailboxSource(candidateId: string): { expenseId: string; sourceId: string } {
        const expenseId = randomUUID();
        const sourceId = randomUUID();
        runtimeSql(`
          INSERT INTO app.expenses
            (id, tenant_id, created_by_user_id, personal_profile_id, merchant, amount, currency, incurred_on, source)
          VALUES
            ('${expenseId}', '${TENANT_ID}', '${OWNER_USER_ID}', '${PROFILE_ID}', 'Merchant', 10.00, 'USD', '2026-01-01', 'connected_mailbox');
          INSERT INTO app.expense_sources
            (id, tenant_id, personal_profile_id, expense_id, source_type, mailbox_candidate_id)
          VALUES
            ('${sourceId}', '${TENANT_ID}', '${PROFILE_ID}', '${expenseId}', 'connected_mailbox', '${candidateId}');
        `);
        return { expenseId, sourceId };
      }

      it("a connected-mailbox expense's detail read includes sender/received/mailbox-account provenance, metadata only", async () => {
        const { connectionId, scanRunId } = createConnectionAndScanRun();
        const candidateId = insertCandidate(connectionId, scanRunId, {
          status: "processed", scopePersonal: PROFILE_ID,
        });
        const { expenseId } = insertExpenseWithMailboxSource(candidateId);

        const expenseDomain = createExpenseDomain(database!);
        const expense = await expenseDomain.getPersonal({
          actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, profileId: PROFILE_ID, expenseId,
        });

        expect(expense.mailboxProvenance).toEqual({
          senderAddress: "sender@shopwaveco.example",
          receivedAt: expect.any(String),
          mailboxAccountEmail: "owner@example.test",
          pendingDuplicateReview: false,
        });
      });

      it("pendingDuplicateReview is true when the referenced candidate is still status 'duplicate'", async () => {
        const { connectionId, scanRunId } = createConnectionAndScanRun();
        const candidateId = insertCandidate(connectionId, scanRunId, {
          status: "duplicate", scopePersonal: PROFILE_ID,
        });
        const { expenseId } = insertExpenseWithMailboxSource(candidateId);

        const expenseDomain = createExpenseDomain(database!);
        const expense = await expenseDomain.getPersonal({
          actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, profileId: PROFILE_ID, expenseId,
        });

        expect(expense.mailboxProvenance?.pendingDuplicateReview).toBe(true);
      });

      it("a manual (non-connected-mailbox) expense never carries mailboxProvenance", async () => {
        const expenseId = randomUUID();
        runtimeSql(`
          INSERT INTO app.expenses
            (id, tenant_id, created_by_user_id, personal_profile_id, merchant, amount, currency, incurred_on, source)
          VALUES
            ('${expenseId}', '${TENANT_ID}', '${OWNER_USER_ID}', '${PROFILE_ID}', 'Manual Merchant', 5.00, 'USD', '2026-01-01', 'manual');
        `);

        const expenseDomain = createExpenseDomain(database!);
        const expense = await expenseDomain.getPersonal({
          actorUserId: OWNER_USER_ID, tenantId: TENANT_ID, profileId: PROFILE_ID, expenseId,
        });

        expect(expense.mailboxProvenance).toBeNull();
      });
    });
  },
);
