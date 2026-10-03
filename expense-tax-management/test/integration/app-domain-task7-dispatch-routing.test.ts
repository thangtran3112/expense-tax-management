import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createAppDatabase } from "../../services/app-api/src/database/client.js";
import type { AppDatabase } from "../../services/app-api/src/database/types.js";
import { createEnrichmentJobInTransaction } from "../../services/app-api/src/domain/enrichment-jobs.js";
import {
  createJobInTransaction,
  createProcessingJobsDomain,
} from "../../services/app-api/src/domain/processing-jobs.js";
import type { TemporalWorkflowStarter, StartWorkflowInput } from "../../services/app-api/src/temporal/client.js";
import {
  advanceDispatchRouting,
  getDispatchRoutingStatus,
} from "../../services/app-api/src/temporal/dispatch-routing.js";

/**
 * Task 7 Stage A: transactional Temporal dispatch routing fence.
 *
 * Proves, against real PostgreSQL:
 *   - the singleton routing row + runtime SELECT-only grant
 *   - every enqueue path stamps generation/namespace/queue from that row
 *   - FOR SHARE in an open enqueue transaction blocks `advance`'s FOR
 *     UPDATE until it commits (the actual fence, not just the schema)
 *   - old-generation jobs keep draining to their stamped target after a
 *     cutover; new jobs get the new target
 *   - the dispatcher starts each row's workflow with its own namespace/queue
 *   - `advance` refuses a stale --from-generation; `status` counts per
 *     generation
 */
const integrationEnabled = process.env.PHASE_T7A_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().slice(0, 8);

let postgresContainerId = "";
let runtimePassword = "";
let migratorPassword = "";
let runtimeDatabase: Kysely<AppDatabase>;
let migratorDatabase: Kysely<AppDatabase>;

interface ComposeConfig {
  readonly services: Record<
    string,
    { readonly environment?: Record<string, string | null> }
  >;
}

function runAs(role: "expense_app_runtime" | "expense_app_migrator", password: string, sql: string) {
  return spawnSync(
    "docker",
    [
      "exec",
      "-e",
      `PGPASSWORD=${password}`,
      postgresContainerId,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "--host",
      "127.0.0.1",
      "--username",
      role,
      "--dbname",
      "expense_tax_db",
      "--tuples-only",
      "--no-align",
      "--pset",
      "footer=off",
      "--command",
      sql,
    ],
    { encoding: "utf8" },
  );
}

function executeSql(sql: string): string {
  const result = runAs("expense_app_runtime", runtimePassword, sql);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function executeMigratorSql(sql: string): string {
  const result = runAs("expense_app_migrator", migratorPassword, sql);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/** Resets the singleton row to generation 1 / legacy routing (this
 * migration's own seed value), so every test starts from, and leaves
 * behind, the same baseline other integration suites assume. */
function resetRoutingToGenerationOne(): void {
  executeMigratorSql(`
    UPDATE app.temporal_dispatch_routing
    SET generation = 1, temporal_namespace = 'default', task_queue = 'expense-tax-ai-worker', updated_at = now()
    WHERE singleton;
  `);
}

function seedTenantWithPersonalProfile(): {
  tenantId: string;
  profileId: string;
  userId: string;
} {
  const userId = randomUUID();
  const tenantId = randomUUID();
  const profileId = randomUUID();
  executeSql(`
    INSERT INTO app.users (id, primary_email, display_name)
    VALUES ('${userId}', 't7a-${runKey}-${userId.slice(0, 6)}@example.test', 'T7A User');
    INSERT INTO app.tenants (id, name, slug)
    VALUES ('${tenantId}', 'T7A Tenant', 't7a-${runKey}-${tenantId.slice(0, 6)}');
    INSERT INTO app.tenant_memberships (tenant_id, user_id, role)
    VALUES ('${tenantId}', '${userId}', 'owner');
    INSERT INTO app.personal_profiles (id, tenant_id, name)
    VALUES ('${profileId}', '${tenantId}', 'Personal');
  `);
  return { tenantId, profileId, userId };
}

const noopStarter: TemporalWorkflowStarter = {
  start: () => {
    throw new Error("this test dispatches via a recording fake, not the real Temporal server");
  },
  close: async () => undefined,
};

describe.skipIf(!integrationEnabled)("Task 7 Stage A dispatch routing fence", () => {
  beforeAll(async () => {
    const config = JSON.parse(
      execFileSync(composeScript, ["config", "--format", "json"], {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as ComposeConfig;
    postgresContainerId = execFileSync(composeScript, ["ps", "-q", "postgres"], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    }).trim();
    runtimePassword = config.services.postgres?.environment?.APP_RUNTIME_DB_PASSWORD ?? "";
    migratorPassword = config.services.postgres?.environment?.APP_MIGRATOR_DB_PASSWORD ?? "";
    if (!postgresContainerId || !runtimePassword || !migratorPassword) {
      throw new Error("Task 7 Stage A PostgreSQL prerequisites are missing");
    }
    runtimeDatabase = createAppDatabase(
      `postgresql://expense_app_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5433/expense_tax_db`,
    );
    migratorDatabase = createAppDatabase(
      `postgresql://expense_app_migrator:${encodeURIComponent(migratorPassword)}@127.0.0.1:5433/expense_tax_db`,
    );
    resetRoutingToGenerationOne();
  });

  afterAll(async () => {
    if (postgresContainerId && runtimePassword) {
      // Delete this run's audit trail before its users: app_audit_events.actor_user_id
      // is ON DELETE SET NULL, and a row whose only actor was actor_user_id
      // (no actor_service_principal -- true for every enrichment-job audit
      // event here) would otherwise violate app_audit_events_actor_check
      // during the user DELETE's own cascade. Pre-existing schema
      // interaction (migration 002), not a Task 7 Stage A concern -- just
      // needs this cleanup ordered around it.
      executeSql(`DELETE FROM app.app_audit_events WHERE request_id LIKE 't7a-${runKey}-%';`);
      executeSql(`DELETE FROM app.tenants WHERE slug LIKE 't7a-${runKey}-%';`);
      executeSql(`DELETE FROM app.users WHERE primary_email LIKE 't7a-${runKey}-%';`);
    }
    if (postgresContainerId && migratorPassword) {
      resetRoutingToGenerationOne();
    }
    await runtimeDatabase?.destroy();
    await migratorDatabase?.destroy();
  });

  // ---- migration: singleton + runtime grant ----------------------------

  it("enforces exactly one routing row (singleton boolean PK + CHECK)", () => {
    const result = runAs(
      "expense_app_migrator",
      migratorPassword,
      `INSERT INTO app.temporal_dispatch_routing (singleton, generation, temporal_namespace, task_queue)
       VALUES (false, 1, 'default', 'expense-tax-ai-worker');`,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/temporal_dispatch_routing_singleton_check|violates check constraint/);
  });

  it("grants the runtime role SELECT only on the routing table", () => {
    expect(() =>
      executeSql(`SELECT generation FROM app.temporal_dispatch_routing;`),
    ).not.toThrow();

    const update = runAs(
      "expense_app_runtime",
      runtimePassword,
      `UPDATE app.temporal_dispatch_routing SET generation = generation;`,
    );
    expect(update.status).not.toBe(0);
    expect(update.stderr).toMatch(/permission denied/);

    const insert = runAs(
      "expense_app_runtime",
      runtimePassword,
      `INSERT INTO app.temporal_dispatch_routing (singleton, generation, temporal_namespace, task_queue)
       VALUES (false, 1, 'default', 'expense-tax-ai-worker');`,
    );
    expect(insert.status).not.toBe(0);
    expect(insert.stderr).toMatch(/permission denied/);
  });

  // ---- enqueue fence: every job-creation path stamps from the row ------

  it("createJobInTransaction (echo/OCR path) stamps generation/namespace/queue from the routing row", async () => {
    const { tenantId, profileId } = seedTenantWithPersonalProfile();
    const job = await runtimeDatabase.transaction().execute((transaction) =>
      createJobInTransaction(transaction, {
        tenantId,
        scope: { personalProfileId: profileId },
        workflowType: "FoundationEchoWorkflow",
        allowedResultSchemaVersion: "foundation-echo-v1",
        actorServicePrincipal: "platform-admin",
        requestId: `t7a-${runKey}-echo-create`,
      }),
    );
    const row = executeSql(
      `SELECT dispatch_generation, dispatch_namespace, task_queue FROM app.processing_jobs WHERE id = '${job.id}';`,
    );
    expect(row).toBe("1|default|expense-tax-ai-worker");
  });

  it("createEnrichmentJobInTransaction stamps generation/namespace/queue from the routing row", async () => {
    const { tenantId, profileId, userId } = seedTenantWithPersonalProfile();
    // Enrichment binds to an existing expense; this test only proves the
    // dispatch-fence stamp, so a row satisfying the FK is enough -- it
    // never needs to resolve to a real, readable expense.
    const expenseId = randomUUID();
    executeSql(`
      INSERT INTO app.expenses
        (id, tenant_id, created_by_user_id, personal_profile_id, merchant, amount, currency, incurred_on, source, status, version, created_at, updated_at)
      VALUES
        ('${expenseId}', '${tenantId}', '${userId}', '${profileId}', 'T7A Merchant', 10.00, 'USD', '2026-09-12', 'manual', 'ready', 1, now(), now());
    `);
    const job = await runtimeDatabase.transaction().execute((transaction) =>
      createEnrichmentJobInTransaction(transaction, {
        tenantId,
        scope: { personalProfileId: profileId },
        expenseId,
        expectedExpenseVersion: 1,
        requestedByUserId: userId,
        requestId: `t7a-${runKey}-enrichment-create`,
      }),
    );
    const row = executeSql(
      `SELECT dispatch_generation, dispatch_namespace, task_queue FROM app.processing_jobs WHERE id = '${job.id}';`,
    );
    expect(row).toBe("1|default|expense-tax-ai-worker");
  });

  // ---- the fence itself: FOR SHARE blocks advance's FOR UPDATE ----------

  it("an open enqueue transaction holding FOR SHARE blocks advance until it commits; pre/post-advance jobs get different generations", async () => {
    const before = seedTenantWithPersonalProfile();
    const jobBefore = await runtimeDatabase.transaction().execute((transaction) =>
      createJobInTransaction(transaction, {
        tenantId: before.tenantId,
        scope: { personalProfileId: before.profileId },
        workflowType: "FoundationEchoWorkflow",
        allowedResultSchemaVersion: "foundation-echo-v1",
        actorServicePrincipal: "platform-admin",
        requestId: `t7a-${runKey}-fence-before`,
      }),
    );

    let releaseHeld: (() => void) | undefined;
    const heldReleased = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    const holding = seedTenantWithPersonalProfile();
    const holdingTransaction = runtimeDatabase.transaction().execute(async (transaction) => {
      await createJobInTransaction(transaction, {
        tenantId: holding.tenantId,
        scope: { personalProfileId: holding.profileId },
        workflowType: "FoundationEchoWorkflow",
        allowedResultSchemaVersion: "foundation-echo-v1",
        actorServicePrincipal: "platform-admin",
        requestId: `t7a-${runKey}-fence-holding`,
      });
      // The FOR SHARE read inside createJobInTransaction already happened;
      // hold this transaction open (uncommitted) to prove advance's FOR
      // UPDATE has to wait for it.
      await heldReleased;
    });

    // Give the holding transaction time to acquire its FOR SHARE lock.
    await new Promise((resolve) => setTimeout(resolve, 300));

    let advanceSettled = false;
    const advancePromise = advanceDispatchRouting(migratorDatabase, {
      fromGeneration: 1,
    }).then((result) => {
      advanceSettled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(advanceSettled).toBe(false);

    releaseHeld!();
    await holdingTransaction;
    const advanceResult = await advancePromise;
    expect(advanceSettled).toBe(true);
    expect(advanceResult).toEqual({
      generation: 2,
      namespace: "expense-tax",
      taskQueue: "expense-tax-processing",
    });

    const after = seedTenantWithPersonalProfile();
    const jobAfter = await runtimeDatabase.transaction().execute((transaction) =>
      createJobInTransaction(transaction, {
        tenantId: after.tenantId,
        scope: { personalProfileId: after.profileId },
        workflowType: "FoundationEchoWorkflow",
        allowedResultSchemaVersion: "foundation-echo-v1",
        actorServicePrincipal: "platform-admin",
        requestId: `t7a-${runKey}-fence-after`,
      }),
    );

    expect(
      executeSql(
        `SELECT dispatch_generation, dispatch_namespace, task_queue FROM app.processing_jobs WHERE id = '${jobBefore.id}';`,
      ),
    ).toBe("1|default|expense-tax-ai-worker");
    expect(
      executeSql(
        `SELECT dispatch_generation, dispatch_namespace, task_queue FROM app.processing_jobs WHERE id = '${jobAfter.id}';`,
      ),
    ).toBe("2|expense-tax|expense-tax-processing");

    resetRoutingToGenerationOne();
  }, 15_000);

  // ---- dispatcher: starts each row's namespace+queue; old gen keeps draining ----

  it("dispatcher starts each outbox row's workflow with its own stamped namespace and queue (old generation keeps draining after cutover)", async () => {
    const gen1 = seedTenantWithPersonalProfile();
    const jobGen1 = await runtimeDatabase.transaction().execute((transaction) =>
      createJobInTransaction(transaction, {
        tenantId: gen1.tenantId,
        scope: { personalProfileId: gen1.profileId },
        workflowType: "FoundationEchoWorkflow",
        allowedResultSchemaVersion: "foundation-echo-v1",
        actorServicePrincipal: "platform-admin",
        requestId: `t7a-${runKey}-dispatcher-gen1`,
      }),
    );

    await advanceDispatchRouting(migratorDatabase, { fromGeneration: 1 });

    const gen2 = seedTenantWithPersonalProfile();
    const jobGen2 = await runtimeDatabase.transaction().execute((transaction) =>
      createJobInTransaction(transaction, {
        tenantId: gen2.tenantId,
        scope: { personalProfileId: gen2.profileId },
        workflowType: "FoundationEchoWorkflow",
        allowedResultSchemaVersion: "foundation-echo-v1",
        actorServicePrincipal: "platform-admin",
        requestId: `t7a-${runKey}-dispatcher-gen2`,
      }),
    );

    const calls: StartWorkflowInput[] = [];
    const recordingStarter: TemporalWorkflowStarter = {
      start: async (input) => {
        calls.push(input);
        return { runId: `fake-run-${calls.length}` };
      },
      close: async () => undefined,
    };
    const domain = createProcessingJobsDomain(runtimeDatabase, recordingStarter);
    await domain.dispatchPendingJobs({ limit: 200 });

    expect(calls).toContainEqual(
      expect.objectContaining({
        workflowId: jobGen1.workflowId,
        taskQueue: "expense-tax-ai-worker",
        namespace: "default",
      }),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        workflowId: jobGen2.workflowId,
        taskQueue: "expense-tax-processing",
        namespace: "expense-tax",
      }),
    );

    resetRoutingToGenerationOne();
  }, 15_000);

  // ---- outbox target immutability: no path can re-enqueue an existing --
  // ---- job under a different generation after a cutover ----------------

  it("the dispatch outbox allows at most one row per job (DB-enforced), so no path can re-target a job to a new generation", () => {
    const seed = seedTenantWithPersonalProfile();
    // Reuse the same job id for both outbox inserts -- the unique
    // constraint is on processing_job_dispatch_outbox.processing_job_id,
    // not the outbox row's own id, so a duplicate is rejected regardless of
    // how the second row's id is generated.
    const jobId = randomUUID();
    executeSql(`
      INSERT INTO app.processing_jobs
        (id, tenant_id, personal_profile_id, workflow_type, workflow_id, task_queue,
         dispatch_generation, dispatch_namespace, status, allowed_result_schema_version,
         input_params, version, created_at, updated_at, dispatched_at, completed_at)
      VALUES
        ('${jobId}', '${seed.tenantId}', '${seed.profileId}', 'FoundationEchoWorkflow',
         'job-${jobId}', 'expense-tax-ai-worker', 1, 'default', 'PENDING', 'foundation-echo-v1',
         '{}'::jsonb, 1, now(), now(), NULL, NULL);
      INSERT INTO app.processing_job_dispatch_outbox
        (id, processing_job_id, job_reference, status, attempts, created_at, dispatched_at)
      VALUES
        ('${randomUUID()}', '${jobId}', '{}'::jsonb, 'PENDING', 0, now(), NULL);
    `);
    const secondInsert = runAs(
      "expense_app_runtime",
      runtimePassword,
      `INSERT INTO app.processing_job_dispatch_outbox
         (id, processing_job_id, job_reference, status, attempts, created_at, dispatched_at)
       VALUES
         ('${randomUUID()}', '${jobId}', '{}'::jsonb, 'PENDING', 0, now(), NULL);`,
    );
    expect(secondInsert.status).not.toBe(0);
    expect(secondInsert.stderr).toMatch(/processing_job_dispatch_outbox_job_unique|duplicate key/);
  });

  it("a crash-retry redispatch after a later generation advance still targets the job's original stamped namespace and queue", async () => {
    const seed = seedTenantWithPersonalProfile();
    const job = await runtimeDatabase.transaction().execute((transaction) =>
      createJobInTransaction(transaction, {
        tenantId: seed.tenantId,
        scope: { personalProfileId: seed.profileId },
        workflowType: "FoundationEchoWorkflow",
        allowedResultSchemaVersion: "foundation-echo-v1",
        actorServicePrincipal: "platform-admin",
        requestId: `t7a-${runKey}-retry-create`,
      }),
    );

    const calls: StartWorkflowInput[] = [];
    const recordingStarter: TemporalWorkflowStarter = {
      start: async (input) => {
        calls.push(input);
        return { runId: `fake-retry-run-${calls.length}` };
      },
      close: async () => undefined,
    };
    const domain = createProcessingJobsDomain(runtimeDatabase, recordingStarter);

    // First dispatch (generation 1 is still current).
    await domain.dispatchPendingJobs({ limit: 200 });
    expect(calls).toContainEqual(
      expect.objectContaining({
        workflowId: job.workflowId,
        taskQueue: "expense-tax-ai-worker",
        namespace: "default",
      }),
    );

    // Cut over to generation 2 *after* this job was already dispatched.
    await advanceDispatchRouting(migratorDatabase, { fromGeneration: 1 });

    // Simulate a dispatcher crash-then-retry (same scenario the existing
    // real-Temporal redispatch test exercises): the outbox+job rows are
    // reset to PENDING as if the start() call succeeded but the
    // follow-up DB commit never happened. This re-enqueues the SAME
    // job/outbox rows (not new ones -- the unique constraint above makes a
    // new outbox row for this job impossible) after a cutover occurred.
    executeSql(`
      UPDATE app.processing_job_dispatch_outbox
      SET status = 'PENDING', dispatched_at = NULL WHERE processing_job_id = '${job.id}';
      UPDATE app.processing_jobs
      SET status = 'PENDING', dispatched_at = NULL, run_id = NULL WHERE id = '${job.id}';
    `);
    await domain.dispatchPendingJobs({ limit: 200 });

    // The retry must still use generation 1's target -- the job row's own
    // stamped columns -- never the now-current generation 2 routing row.
    const retryCalls = calls.filter((call) => call.workflowId === job.workflowId);
    expect(retryCalls).toHaveLength(2);
    for (const call of retryCalls) {
      expect(call.taskQueue).toBe("expense-tax-ai-worker");
      expect(call.namespace).toBe("default");
    }

    resetRoutingToGenerationOne();
  }, 15_000);

  // ---- operator CLI domain functions ------------------------------------

  it("advance refuses a stale --from-generation", async () => {
    await expect(
      advanceDispatchRouting(migratorDatabase, { fromGeneration: 99 }),
    ).rejects.toThrow(/current generation is 1/);
    const status = await getDispatchRoutingStatus(migratorDatabase);
    expect(status.generation).toBe(1);
  });

  it("status counts non-terminal jobs and pending outbox rows per generation", async () => {
    const seed = seedTenantWithPersonalProfile();
    const job = await runtimeDatabase.transaction().execute((transaction) =>
      createJobInTransaction(transaction, {
        tenantId: seed.tenantId,
        scope: { personalProfileId: seed.profileId },
        workflowType: "FoundationEchoWorkflow",
        allowedResultSchemaVersion: "foundation-echo-v1",
        actorServicePrincipal: "platform-admin",
        requestId: `t7a-${runKey}-status-count`,
      }),
    );
    void job;

    const status = await getDispatchRoutingStatus(migratorDatabase);
    const gen1Jobs = status.nonTerminalJobsByGeneration.find((row) => row.generation === 1);
    const gen1Outbox = status.pendingOutboxRowsByGeneration.find((row) => row.generation === 1);
    expect(gen1Jobs?.count).toBeGreaterThanOrEqual(1);
    expect(gen1Outbox?.count).toBeGreaterThanOrEqual(1);
  });
});
