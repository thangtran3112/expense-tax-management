/**
 * Phase 3D-B Task 6 — phase verification: a consolidated, real-PostgreSQL
 * proof that App API's mailbox discovery/review domain (Tasks 1-5)
 * behaves exactly as the plan's "Canonical B Contracts" and Global
 * Constraints require, end to end through the real route registrations
 * (registerMailboxConnectionRoutes's scan sub-routes,
 * registerMailboxInternalRoutes, registerMailboxCandidateRoutes) rather
 * than only at the domain-function level (Tasks 2/3/4/5's own suites
 * already cover every domain-level edge case exhaustively -- this suite
 * does not re-litigate those, it proves they compose correctly as one
 * phase). No Google/GCP/Clerk network access anywhere -- the broker and
 * workflow worker are both fakes (fixed bearer-token literals, same
 * convention as every other mailbox test in this repo).
 *
 * Gated on PHASE_3D_B_T6_INTEGRATION=1, wired into the zero-skip CI chain
 * (scripts/verify-phase-0n.mjs) the same way Phase 3D-A wired
 * PHASE_3D_A_T6_INTEGRATION (see scripts/check-mailbox-t6-ci-wiring.test.mjs).
 *
 * Covers, in one place:
 *   - migrations 016, 017, 018, then 019 apply in order (real ledger proof)
 *   - single-flight scan lease (lease CAS, permanent requestId replay,
 *     concurrent-overlap rejection) and stale-run rejection once a
 *     successor steals an expired lease
 *   - entitlement pause: a disabled connected_mailbox_scan entitlement
 *     blocks scan start with a typed 403
 *   - fenced page staging: page-order rejection, pre-fence replay state
 *     (preFenceHistoryId) persisting across calls, Gmail history-page
 *     continuation (historyPageToken), and cursor atomicity (the real
 *     settled historyId only ever advances once replay is fully
 *     exhausted) -- fake broker/Gmail, real App persistence
 *   - 404-recovery idempotence (a re-listed provider_message_id is
 *     silently skipped, not a crash) and permanent page-level replay
 *   - scan-run finalization and lease release (worker-only route),
 *     idempotent on a second call, immediately unblocking the next scan
 *   - candidate review: owner/reviewer-grant authorization, outsider
 *     rejection, action idempotency (replayed requestId), a terminal
 *     candidate rejecting a second resolve, and `ingest` producing the
 *     `queued` status 3D-C's ingestion scope consumes
 *   - no cursor/content leakage: every Temporal/broker-facing HTTP
 *     response (scan start/list, broker-binding, candidate-pages,
 *     finalize) carries only opaque IDs/counts/fence digests -- never a
 *     message subject, sender address, content hash, or raw secret --
 *     and no captured request log line contains any of that content or a
 *     bearer token
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthPrincipal } from "../../services/app-api/src/auth/types.js";
import { createAppDatabase } from "../../services/app-api/src/database/client.js";
import { runMigrations } from "../../services/app-api/src/database/migrate.js";
import type { AppDatabase } from "../../services/app-api/src/database/types.js";
import {
  createMailboxCandidatesDomain,
  type MailboxCandidatesDomain,
} from "../../services/app-api/src/domain/mailbox-candidates.js";
import {
  createMailboxScansDomain,
  type MailboxScansDomain,
} from "../../services/app-api/src/domain/mailbox-scans.js";
import type { IdentityResolver } from "../../services/app-api/src/domain/authenticated-user.js";
import type { PlansDomain } from "../../services/app-api/src/domain/plans.js";
import { buildTask6BTestApp } from "../../services/app-api/test/support/mailbox-task6b-app.js";

const integrationEnabled = process.env.PHASE_3D_B_T6_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().replaceAll("-", "").slice(0, 10);
const databaseName = `expense_tax_t6b_mailbox_${runKey}`;

interface ComposeConfig {
  readonly services: Record<string, { readonly environment?: Record<string, string | null> }>;
}

const TENANT_ID = "6b000000-0000-4000-8000-000000000001";
const OWNER_USER_ID = "6b000000-0000-4000-8000-000000000002";
const MEMBER_USER_ID = "6b000000-0000-4000-8000-000000000003";
const OUTSIDER_USER_ID = "6b000000-0000-4000-8000-000000000004";
const PROFILE_ID = "6b000000-0000-4000-8000-000000000005";
const BUSINESS_ID = "6b000000-0000-4000-8000-000000000006";

let postgresContainerId = "";
let runtimePassword = "";
let migratorPassword = "";
let migratorDatabase: Kysely<AppDatabase> | undefined;
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

function migratorSql(sql: string): string {
  return dockerPsql(databaseName, "expense_app_migrator", migratorPassword, sql);
}

function tenantPrincipal(subject: string, displayName: string): AuthPrincipal {
  return {
    tokenType: "tenant",
    subject,
    clientId: null,
    audience: "expense-app",
    issuer: "https://identity.t6b.test",
    roles: [],
    scopes: [],
    tokenId: `${subject}-token-id`,
    email: `${subject}@example.test`,
    emailVerified: true,
    displayName,
  };
}

const identityResolver: IdentityResolver = {
  resolve: async (_issuer, subject) => ({
    id: subject,
    primaryEmail: `${subject}@example.test`,
    displayName: subject,
    status: "active" as const,
  }),
};

/** Mutable so a single fake can flip the connected_mailbox_scan
 * entitlement mid-suite (entitlement-pause test) without rebuilding the
 * domain. */
const plansState = { scanEnabled: true };

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
        currentEntitlementVersion: 5,
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
          isEnabled: plansState.scanEnabled,
          limitValue: null,
          limitPeriod: null,
          source: "plan" as const,
        },
      ];
    },
    listEntitlementSnapshotsAfter: notImplemented,
  };
}

function stagingMessage(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

describe.skipIf(!integrationEnabled)("Phase 3D-B Task 6 — mailbox discovery/review phase verification (live PostgreSQL)", () => {
  let mailboxScansDomain: MailboxScansDomain;
  let mailboxCandidatesDomain: MailboxCandidatesDomain;

  beforeAll(async () => {
    const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
    if (!dockerAvailable) throw new Error("Task 6 (3D-B) PostgreSQL prerequisites unavailable");

    postgresContainerId = execFileSync(composeScript, ["ps", "-q", "postgres"], {
      cwd: repoRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!postgresContainerId) throw new Error("Task 6 (3D-B) PostgreSQL prerequisites unavailable (run ./scripts/compose.sh up -d --wait postgres)");

    const config = JSON.parse(
      execFileSync(composeScript, ["config", "--format", "json"], {
        cwd: repoRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as ComposeConfig;
    runtimePassword = config.services.postgres?.environment?.APP_RUNTIME_DB_PASSWORD ?? "";
    migratorPassword = config.services.postgres?.environment?.APP_MIGRATOR_DB_PASSWORD ?? "";
    if (!runtimePassword || !migratorPassword) throw new Error("Task 6 (3D-B) PostgreSQL prerequisites unavailable");

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
    migratorDatabase = createAppDatabase(migrationDatabaseUrl);
    database = createAppDatabase(runtimeDatabaseUrl);

    runtimeSql(`
      INSERT INTO app.users (id, primary_email, display_name) VALUES
        ('${OWNER_USER_ID}', 't6b-owner-${runKey}@example.test', 'T6B Owner'),
        ('${MEMBER_USER_ID}', 't6b-member-${runKey}@example.test', 'T6B Member'),
        ('${OUTSIDER_USER_ID}', 't6b-outsider-${runKey}@example.test', 'T6B Outsider');
      INSERT INTO app.tenants (id, name, slug, status) VALUES
        ('${TENANT_ID}', 'T6B Tenant', 't6b-tenant-${runKey}', 'active');
      INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status) VALUES
        ('${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active'),
        ('${TENANT_ID}', '${MEMBER_USER_ID}', 'member', 'active'),
        ('${TENANT_ID}', '${OUTSIDER_USER_ID}', 'member', 'active');
      INSERT INTO app.personal_profiles (id, tenant_id, name) VALUES
        ('${PROFILE_ID}', '${TENANT_ID}', 'T6B Profile');
      INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role, status) VALUES
        ('${PROFILE_ID}', '${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active');
      INSERT INTO app.businesses (id, tenant_id, name, industry_code, timezone, base_currency, status)
      VALUES ('${BUSINESS_ID}', '${TENANT_ID}', 'T6B Business', 'restaurant', 'America/Los_Angeles', 'USD', 'active');
      INSERT INTO app.business_memberships (business_id, tenant_id, user_id, role, status) VALUES
        ('${BUSINESS_ID}', '${TENANT_ID}', '${MEMBER_USER_ID}', 'owner', 'active');
    `);

    mailboxScansDomain = createMailboxScansDomain(database, { plansDomain: fakePlansDomain() }, { scanLeaseTtlSeconds: 900 });
    // Phase 3D-C Task 5 gap closure (b2cdc66) added createMailboxCandidatesDomain's
    // required `{ mailboxEnabled }` constructor option (its own `ingest` branch
    // throws FEATURE_DISABLED before creating a materialize job when false) --
    // this suite predates that change and was never updated, so the single
    // `ingest` test below 500'd on `deps.mailboxEnabled` being undefined on
    // every real run of the zero-skip chain since. Caught by Task 7's own
    // end-to-end verification; fixed here (not a Task 5 file).
    mailboxCandidatesDomain = createMailboxCandidatesDomain(database, { mailboxEnabled: true });
  });

  afterAll(async () => {
    await database?.destroy();
    await migratorDatabase?.destroy();
    if (postgresContainerId) {
      adminSql(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
    }
  });

  // ---------------------------------------------------------------- //
  // Migration order: 016, 017, 018, then 019.
  // ---------------------------------------------------------------- //

  it("applies migrations 016 (enrichment), 017 (dispatch routing), 018 (mailbox connections), then 019 (mailbox discovery) in that exact order", () => {
    const names = migratorSql(`SELECT name FROM app_migrations.kysely_migration ORDER BY timestamp;`).split("\n");
    const indexOf = (prefix: string) => names.findIndex((name) => name.startsWith(prefix));
    const i016 = indexOf("016_");
    const i017 = indexOf("017_");
    const i018 = indexOf("018_");
    const i019 = indexOf("019_");
    expect(i016).toBeGreaterThanOrEqual(0);
    expect(i017).toBeGreaterThan(i016);
    expect(i018).toBeGreaterThan(i017);
    expect(i019).toBeGreaterThan(i018);
  });

  it("019 created exactly the tables/columns the plan specifies, alongside 018's own tables", () => {
    const tables = runtimeSql(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'app' ORDER BY table_name;`,
    ).split("\n");
    expect(tables).toContain("mailbox_scan_runs");
    expect(tables).toContain("mailbox_candidates");
    expect(tables).toContain("mailbox_scan_page_outcomes");
    expect(tables).toContain("mailbox_connections"); // 018
    expect(tables).toContain("mailbox_reviewer_grants"); // 018

    const columns = runtimeSql(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'mailbox_connections' ORDER BY column_name;`,
    ).split("\n");
    for (const expected of [
      "current_history_id", "current_cursor_digest", "pre_fence_token",
      "next_page_sequence", "pre_fence_history_id", "history_page_token",
    ]) {
      expect(columns).toContain(expected);
    }
  });

  // ---------------------------------------------------------------- //
  // Full scan lifecycle through real HTTP routes: lease, fences,
  // pre-fence replay, history continuation, cursor atomicity, 404
  // recovery, finalization/lease release, no leakage.
  // ---------------------------------------------------------------- //

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

  it("runs the full scan lifecycle: entitlement pause, single-flight lease + permanent replay, page fences, pre-fence replay/history continuation, cursor atomicity, 404-recovery idempotence, finalization + lease release, no cursor/content leakage", async () => {
    const owner = tenantPrincipal(OWNER_USER_ID, "T6B Owner");
    const { app, logLines } = buildTask6BTestApp({
      mailboxScansDomain,
      mailboxCandidatesDomain,
      identityResolver,
      tenantPrincipalsByToken: { "tenant-token": owner },
    });
    const connectionId = createActiveConnection();

    // --- entitlement pause ------------------------------------------
    plansState.scanEnabled = false;
    const paused = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/${connectionId}/scans`,
      headers: { authorization: "Bearer tenant-token" },
      payload: { requestId: randomUUID() },
    });
    expect(paused.statusCode).toBe(403);
    plansState.scanEnabled = true;

    // --- single-flight lease + permanent replay ----------------------
    const requestIdA = randomUUID();
    const startedA = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/${connectionId}/scans`,
      headers: { authorization: "Bearer tenant-token" },
      payload: { requestId: requestIdA },
    });
    expect(startedA.statusCode).toBe(201);
    const scanRunA = (startedA.json() as { scanRun: { id: string }; status: string }).scanRun;
    expect(startedA.json()).toMatchObject({ status: "started" });

    // Permanent replay: identical requestId returns the same run.
    const replayA = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/${connectionId}/scans`,
      headers: { authorization: "Bearer tenant-token" },
      payload: { requestId: requestIdA },
    });
    expect(replayA.statusCode).toBe(201);
    expect((replayA.json() as { scanRun: { id: string } }).scanRun.id).toBe(scanRunA.id);

    // Concurrent overlap: a different requestId while A's lease is held.
    const overlap = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/${connectionId}/scans`,
      headers: { authorization: "Bearer tenant-token" },
      payload: { requestId: randomUUID() },
    });
    expect(overlap.statusCode).toBe(409);
    expect((overlap.json() as { scanRun: { id: string }; status: string }).status).toBe("skipped_overlap");
    expect((overlap.json() as { scanRun: { id: string } }).scanRun.id).toBe(scanRunA.id);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/${connectionId}/scans`,
      headers: { authorization: "Bearer tenant-token" },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: readonly unknown[] }).items).toHaveLength(1);

    // --- broker binding read: opaque fields only ---------------------
    const bindingResponse1 = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${scanRunA.id}/broker-binding`,
      headers: { authorization: "Bearer broker-token" },
      payload: {},
    });
    expect(bindingResponse1.statusCode).toBe(200);
    const binding1 = bindingResponse1.json() as {
      expectedConnectionVersion: number; currentCursorDigest: string; preFenceToken: string;
      nextPageSequence: number; currentHistoryId: string | null;
      preFenceHistoryId: string | null; historyPageToken: string | null;
    };
    expect(Object.keys(bindingResponse1.json() as object).sort()).toEqual(
      ["connectionId", "currentCursorDigest", "currentHistoryId", "expectedConnectionVersion",
        "historyPageToken", "nextPageSequence", "preFenceHistoryId", "preFenceToken", "scanRunId"].sort(),
    );
    expect(binding1.nextPageSequence).toBe(1);
    expect(binding1.currentHistoryId).toBeNull();

    // Worker-guard negative checks on the finalize route (wrong subject /
    // missing scope never satisfy workerGuard, even with an otherwise
    // well-formed body).
    const wrongWorker = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${scanRunA.id}/finalize`,
      headers: { authorization: "Bearer wrong-worker-token" },
      payload: { outcome: "succeeded" },
    });
    expect(wrongWorker.statusCode).toBe(403);
    const missingScopeWorker = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${scanRunA.id}/finalize`,
      headers: { authorization: "Bearer missing-scope-worker-token" },
      payload: { outcome: "succeeded" },
    });
    expect(missingScopeWorker.statusCode).toBe(403);

    // --- page ordering/fences: page 2 before page 1 ------------------
    const SENT_SENDER = `secret-sender-${runKey}@example.test`;
    const SENT_SUBJECT = `Secret Subject ${runKey}`;
    const SENT_CONTENT_HASH = "d".repeat(64);

    const outOfOrder = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${scanRunA.id}/candidate-pages`,
      headers: { authorization: "Bearer broker-token" },
      payload: {
        connectionId, expectedConnectionVersion: binding1.expectedConnectionVersion,
        cursorBeforeDigest: binding1.currentCursorDigest, preFenceToken: binding1.preFenceToken,
        pageSequence: 2, nextHistoryId: null, nextPreFenceHistoryId: null, nextHistoryPageToken: null,
        messages: [], idempotencyKey: randomUUID(),
      },
    });
    expect(outOfOrder.statusCode).toBe(409);

    // --- page 1: bounded full-sync backlog, pre-fence captured --------
    const repeatedProviderMessageId = `gmail-${randomUUID()}`;
    const page1Key = randomUUID();
    // Hoisted and reused byte-for-byte in page1Replay below -- each
    // stagingMessage() call mints its own fresh providerMessageId when
    // not overridden, so regenerating this array for the replay would
    // (correctly) trip the domain's own conflicting-payload guard
    // instead of the identical-replay path this test means to exercise.
    const page1Messages = [
      stagingMessage({
        providerMessageId: repeatedProviderMessageId,
        senderAddress: SENT_SENDER, subject: SENT_SUBJECT, contentHash: SENT_CONTENT_HASH,
      }),
      stagingMessage({ classification: "ambiguous" as const }),
      stagingMessage({ classification: "not_receipt" as const }),
    ];
    const page1 = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${scanRunA.id}/candidate-pages`,
      headers: { authorization: "Bearer broker-token" },
      payload: {
        connectionId, expectedConnectionVersion: binding1.expectedConnectionVersion,
        cursorBeforeDigest: binding1.currentCursorDigest, preFenceToken: binding1.preFenceToken,
        pageSequence: 1, nextHistoryId: null, nextPreFenceHistoryId: "captured-pre-fence", nextHistoryPageToken: null,
        messages: page1Messages,
        idempotencyKey: page1Key,
      },
    });
    expect(page1.statusCode).toBe(200);
    const page1Body = page1.json() as Record<string, unknown>;
    expect(Object.keys(page1Body).sort()).toEqual(["candidateIds", "counts", "pageSequence", "schemaVersion", "scanRunId"].sort());
    expect(page1Body.counts).toEqual({ discovered: 3, staged: 1, review: 1, failed: 0 });
    expect((page1Body.candidateIds as string[])).toHaveLength(2);

    const bindingResponse2 = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${scanRunA.id}/broker-binding`,
      headers: { authorization: "Bearer broker-token" },
      payload: {},
    });
    const binding2 = bindingResponse2.json() as typeof binding1;
    expect(binding2.preFenceHistoryId).toBe("captured-pre-fence");
    expect(binding2.historyPageToken).toBeNull();
    expect(binding2.currentHistoryId).toBeNull(); // not settled mid-replay (cursor atomicity)

    // --- page 2: Gmail history-page continuation, still unsettled -----
    const page2 = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${scanRunA.id}/candidate-pages`,
      headers: { authorization: "Bearer broker-token" },
      payload: {
        connectionId, expectedConnectionVersion: binding2.expectedConnectionVersion,
        cursorBeforeDigest: binding2.currentCursorDigest, preFenceToken: binding2.preFenceToken,
        pageSequence: 2, nextHistoryId: null, nextPreFenceHistoryId: "captured-pre-fence",
        nextHistoryPageToken: "gmail-history-page-2", messages: [], idempotencyKey: randomUUID(),
      },
    });
    expect(page2.statusCode).toBe(200);

    const bindingResponse3 = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${scanRunA.id}/broker-binding`,
      headers: { authorization: "Bearer broker-token" },
      payload: {},
    });
    const binding3 = bindingResponse3.json() as typeof binding1;
    expect(binding3.historyPageToken).toBe("gmail-history-page-2");
    expect(binding3.currentHistoryId).toBeNull(); // still unsettled

    // --- page 3: replay exhausted, cursor finally settles --------------
    const page3 = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${scanRunA.id}/candidate-pages`,
      headers: { authorization: "Bearer broker-token" },
      payload: {
        connectionId, expectedConnectionVersion: binding3.expectedConnectionVersion,
        cursorBeforeDigest: binding3.currentCursorDigest, preFenceToken: binding3.preFenceToken,
        pageSequence: 3, nextHistoryId: "settled-history-9", nextPreFenceHistoryId: null,
        nextHistoryPageToken: null, messages: [], idempotencyKey: randomUUID(),
      },
    });
    expect(page3.statusCode).toBe(200);

    const bindingResponse4 = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${scanRunA.id}/broker-binding`,
      headers: { authorization: "Bearer broker-token" },
      payload: {},
    });
    const binding4 = bindingResponse4.json() as typeof binding1;
    expect(binding4.preFenceHistoryId).toBeNull();
    expect(binding4.historyPageToken).toBeNull();
    expect(binding4.currentHistoryId).toBe("settled-history-9");

    // --- 404-recovery idempotence: page 4 re-lists page 1's message ---
    const page4 = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${scanRunA.id}/candidate-pages`,
      headers: { authorization: "Bearer broker-token" },
      payload: {
        connectionId, expectedConnectionVersion: binding4.expectedConnectionVersion,
        cursorBeforeDigest: binding4.currentCursorDigest, preFenceToken: binding4.preFenceToken,
        pageSequence: 4, nextHistoryId: null, nextPreFenceHistoryId: null, nextHistoryPageToken: null,
        messages: [
          // Identical payload to page 1's original staging of this
          // message (same subject/sender/contentHash) -- a 404-recovery
          // bounded full sync re-lists it unchanged; only a genuinely
          // *different* payload for the same provider_message_id is a
          // real IDEMPOTENCY_CONFLICT (covered by Task 2's own suite).
          stagingMessage({
            providerMessageId: repeatedProviderMessageId,
            senderAddress: SENT_SENDER, subject: SENT_SUBJECT, contentHash: SENT_CONTENT_HASH,
          }),
        ],
        idempotencyKey: randomUUID(),
      },
    });
    expect(page4.statusCode).toBe(200);
    expect((page4.json() as { counts: { discovered: number } }).counts).toEqual({ discovered: 1, staged: 0, review: 0, failed: 0 });
    expect((page4.json() as { candidateIds: string[] }).candidateIds).toHaveLength(0); // already staged, not duplicated
    const repeatedCount = runtimeSql(
      `SELECT count(*) FROM app.mailbox_candidates WHERE connection_id = '${connectionId}' AND provider_message_id = '${repeatedProviderMessageId}'`,
    );
    expect(repeatedCount).toBe("1");

    // Permanent page-level replay: resubmitting page 1's exact payload
    // and idempotencyKey returns the original cached result.
    const page1Replay = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${scanRunA.id}/candidate-pages`,
      headers: { authorization: "Bearer broker-token" },
      payload: {
        connectionId, expectedConnectionVersion: binding1.expectedConnectionVersion,
        cursorBeforeDigest: binding1.currentCursorDigest, preFenceToken: binding1.preFenceToken,
        pageSequence: 1, nextHistoryId: null, nextPreFenceHistoryId: "captured-pre-fence", nextHistoryPageToken: null,
        messages: page1Messages,
        idempotencyKey: page1Key,
      },
    });
    expect(page1Replay.statusCode).toBe(200);
    expect(page1Replay.json()).toEqual(page1Body);

    // --- stale-run rejection: a successor steals the expired lease ----
    runtimeSql(
      `UPDATE app.mailbox_connections SET active_scan_lease_expires_at = now() - interval '1 hour' WHERE id = '${connectionId}'`,
    );
    const startedB = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/${connectionId}/scans`,
      headers: { authorization: "Bearer tenant-token" },
      payload: { requestId: randomUUID() },
    });
    expect(startedB.statusCode).toBe(201);
    const scanRunB = (startedB.json() as { scanRun: { id: string } }).scanRun;
    expect(scanRunB.id).not.toBe(scanRunA.id);

    const staleBinding = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${scanRunA.id}/broker-binding`,
      headers: { authorization: "Bearer broker-token" },
      payload: {},
    });
    expect(staleBinding.statusCode).toBe(409);
    const stalePage = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${scanRunA.id}/candidate-pages`,
      headers: { authorization: "Bearer broker-token" },
      payload: {
        connectionId, expectedConnectionVersion: binding4.expectedConnectionVersion,
        cursorBeforeDigest: binding4.currentCursorDigest, preFenceToken: binding4.preFenceToken,
        pageSequence: 5, nextHistoryId: null, nextPreFenceHistoryId: null, nextHistoryPageToken: null,
        messages: [], idempotencyKey: randomUUID(),
      },
    });
    expect(stalePage.statusCode).toBe(409);

    // --- finalization + lease release, idempotent ----------------------
    const finalize1 = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${scanRunB.id}/finalize`,
      headers: { authorization: "Bearer worker-token" },
      payload: { outcome: "succeeded" },
    });
    expect(finalize1.statusCode).toBe(200);
    expect(finalize1.json()).toEqual({ scanRunId: scanRunB.id, status: "completed", leaseReleased: true });

    const finalize2 = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/scan-runs/${scanRunB.id}/finalize`,
      headers: { authorization: "Bearer worker-token" },
      payload: { outcome: "succeeded" },
    });
    expect(finalize2.statusCode).toBe(200);
    expect(finalize2.json()).toEqual({ scanRunId: scanRunB.id, status: "completed", leaseReleased: false });

    // Lease released: a new scan can start immediately, no TTL wait.
    const startedC = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/${connectionId}/scans`,
      headers: { authorization: "Bearer tenant-token" },
      payload: { requestId: randomUUID() },
    });
    expect(startedC.statusCode).toBe(201);
    expect((startedC.json() as { status: string }).status).toBe("started");

    // --- no cursor/content leakage: inspect every captured log line ---
    const logText = logLines();
    expect(logText).not.toContain(SENT_SENDER);
    expect(logText).not.toContain(SENT_SUBJECT);
    expect(logText).not.toContain(SENT_CONTENT_HASH);
    expect(logText).not.toMatch(/Bearer\s+(broker-token|worker-token|tenant-token)/);
  });

  // ---------------------------------------------------------------- //
  // Candidate review: authorization, idempotency, terminal rejection,
  // and the `ingest` -> `queued` transition 3D-C consumes.
  // ---------------------------------------------------------------- //

  const DUMMY_HASH = "a".repeat(64);

  function createConnectionAndScanRunForReview(): { connectionId: string; scanRunId: string } {
    const connectionId = randomUUID();
    const scanRunId = randomUUID();
    runtimeSql(`
      INSERT INTO app.mailbox_connections (
        id, tenant_id, personal_profile_id, owner_user_id, provider,
        provider_account_id, account_email, status, timezone, local_scan_time, vault_reference
      ) VALUES (
        '${connectionId}', '${TENANT_ID}', '${PROFILE_ID}', '${OWNER_USER_ID}', 'gmail',
        'acct-${connectionId}', 'owner@example.test', 'active', 'America/Los_Angeles', '07:00', 'vault-${connectionId}'
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

  function insertReviewCandidate(connectionId: string, scanRunId: string): string {
    const candidateId = randomUUID();
    runtimeSql(`
      INSERT INTO app.mailbox_candidates (
        id, scan_run_id, connection_id, tenant_id, received_at, sender_address, sender_domain,
        subject, content_hash, classification, confidence, evidence, status,
        idempotency_key, normalized_request_hash, provider_message_id
      ) VALUES (
        '${candidateId}', '${scanRunId}', '${connectionId}', '${TENANT_ID}', now(),
        'sender@shopwaveco.example', 'shopwaveco.example', 'Your order confirmation',
        '${DUMMY_HASH}', 'ambiguous', 0.5, '{}', 'review',
        'cand-${candidateId}', '${DUMMY_HASH}', 'provider-${candidateId}'
      )
    `);
    return candidateId;
  }

  function grantReviewer(connectionId: string, userId: string): void {
    runtimeSql(`
      INSERT INTO app.mailbox_reviewer_grants (id, connection_id, tenant_id, user_id, role)
      VALUES ('${randomUUID()}', '${connectionId}', '${TENANT_ID}', '${userId}', 'reviewer')
    `);
  }

  it("review actions: owner/outsider authorization, idempotent replay, terminal rejection, reviewer-grant ingest to `queued`", async () => {
    const owner = tenantPrincipal(OWNER_USER_ID, "T6B Owner");
    const member = tenantPrincipal(MEMBER_USER_ID, "T6B Member");
    const outsider = tenantPrincipal(OUTSIDER_USER_ID, "T6B Outsider");
    const { app } = buildTask6BTestApp({
      mailboxScansDomain,
      mailboxCandidatesDomain,
      identityResolver,
      tenantPrincipalsByToken: { "owner-token": owner, "member-token": member, "outsider-token": outsider },
    });

    const { connectionId, scanRunId } = createConnectionAndScanRunForReview();
    const candidateForSkip = insertReviewCandidate(connectionId, scanRunId);
    const candidateForIngest = insertReviewCandidate(connectionId, scanRunId);

    // Outsider: no owner relationship, no reviewer grant.
    const outsiderList = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/${connectionId}/candidates`,
      headers: { authorization: "Bearer outsider-token" },
    });
    expect(outsiderList.statusCode).toBe(403);

    // Owner: full access.
    const ownerList = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/${connectionId}/candidates`,
      headers: { authorization: "Bearer owner-token" },
    });
    expect(ownerList.statusCode).toBe(200);
    expect((ownerList.json() as { items: readonly unknown[] }).items).toHaveLength(2);

    const resolveRequestId = randomUUID();
    const skip1 = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/${connectionId}/candidates/${candidateForSkip}/resolve`,
      headers: { authorization: "Bearer owner-token" },
      payload: { action: "skip", expectedCandidateVersion: 1, requestId: resolveRequestId },
    });
    expect(skip1.statusCode).toBe(200);
    expect((skip1.json() as { status: string }).status).toBe("skipped");

    // Idempotent replay: identical requestId returns the identical result.
    const skip1Replay = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/${connectionId}/candidates/${candidateForSkip}/resolve`,
      headers: { authorization: "Bearer owner-token" },
      payload: { action: "skip", expectedCandidateVersion: 1, requestId: resolveRequestId },
    });
    expect(skip1Replay.statusCode).toBe(200);
    expect(skip1Replay.json()).toEqual(skip1.json());

    // A terminal candidate rejects a second (non-replay) resolve.
    const skipAgain = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/${connectionId}/candidates/${candidateForSkip}/resolve`,
      headers: { authorization: "Bearer owner-token" },
      payload: { action: "skip", expectedCandidateVersion: 1, requestId: randomUUID() },
    });
    expect(skipAgain.statusCode).toBe(409);

    // Outsider cannot resolve either.
    const outsiderResolve = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/${connectionId}/candidates/${candidateForIngest}/resolve`,
      headers: { authorization: "Bearer outsider-token" },
      payload: { action: "skip", expectedCandidateVersion: 1, requestId: randomUUID() },
    });
    expect(outsiderResolve.statusCode).toBe(403);

    // Reviewer-grant (non-owner, no scope membership on the connection's
    // own Personal scope) can still list/resolve once granted.
    grantReviewer(connectionId, MEMBER_USER_ID);
    const memberList = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/${connectionId}/candidates`,
      headers: { authorization: "Bearer member-token" },
    });
    expect(memberList.statusCode).toBe(200);

    // `ingest` assigns a target scope and queues processing -- the exact
    // `queued` status 3D-C's ingestion domain consumes. Member has
    // current membership on BUSINESS_ID (the target scope), independent
    // of the connection's own Personal scope.
    const ingest = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/${connectionId}/candidates/${candidateForIngest}/resolve`,
      headers: { authorization: "Bearer member-token" },
      payload: {
        action: "ingest",
        scope: { kind: "business", businessId: BUSINESS_ID },
        expectedCandidateVersion: 1,
        requestId: randomUUID(),
      },
    });
    expect(ingest.statusCode).toBe(200);
    expect((ingest.json() as { status: string }).status).toBe("queued");
  });
});
