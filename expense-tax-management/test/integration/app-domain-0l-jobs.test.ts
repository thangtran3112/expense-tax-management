import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAppDatabase } from "../../services/app-api/src/database/client.js";
import type { AppDatabase } from "../../services/app-api/src/database/types.js";
import { createProcessingJobsDomain } from "../../services/app-api/src/domain/processing-jobs.js";
import { createTemporalWorkflowStarter } from "../../services/app-api/src/temporal/client.js";
import type { TemporalWorkflowStarter } from "../../services/app-api/src/temporal/client.js";
import { DomainError } from "../../services/app-api/src/errors.js";
import type { Kysely } from "kysely";
import { Client, Connection } from "@temporalio/client";
import { FOUNDATION_ECHO_WORKFLOW_TYPE } from "../../packages/contracts/src/index.js";

const integrationEnabled = process.env.PHASE_0L_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().slice(0, 8);
const TASK_QUEUE = `test-0l-${runKey}`;
const WORKFLOW_TYPE = FOUNDATION_ECHO_WORKFLOW_TYPE;

let postgresContainerId = "";
let runtimePassword = "";
let migratorPassword = "";
let database: Kysely<AppDatabase>;
let temporalClient: Client;

interface ComposeConfig {
  readonly services: Record<
    string,
    { readonly environment?: Record<string, string | null> }
  >;
}

function runSql(sql: string) {
  return spawnSync(
    "docker",
    [
      "exec",
      "-e",
      `PGPASSWORD=${runtimePassword}`,
      postgresContainerId,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "--host",
      "127.0.0.1",
      "--username",
      "expense_app_runtime",
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
  const result = runSql(sql);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/**
 * Task 7 Stage A: app.temporal_dispatch_routing grants the runtime role
 * SELECT only -- this test must use migrator credentials to point the
 * singleton row's queue at this run's isolated TASK_QUEUE (namespace stays
 * the seeded 'default', matching generation 1), so createJob's enqueue
 * fence stamps TASK_QUEUE instead of colliding with other suites on the
 * real shared queue 'expense-tax-ai-worker'.
 */
function executeMigratorSql(sql: string): string {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-e",
      `PGPASSWORD=${migratorPassword}`,
      postgresContainerId,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "--host",
      "127.0.0.1",
      "--username",
      "expense_app_migrator",
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
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function seedTenantWithPersonalProfile(): { tenantId: string; profileId: string } {
  const userId = randomUUID();
  const tenantId = randomUUID();
  const profileId = randomUUID();
  executeSql(`
    INSERT INTO app.users (id, primary_email, display_name)
    VALUES ('${userId}', '0l-${runKey}-${userId.slice(0, 6)}@example.test', '0L User');
    INSERT INTO app.tenants (id, name, slug)
    VALUES ('${tenantId}', '0L Tenant', '0l-${runKey}-${tenantId.slice(0, 6)}');
    INSERT INTO app.tenant_memberships (tenant_id, user_id, role)
    VALUES ('${tenantId}', '${userId}', 'owner');
    INSERT INTO app.personal_profiles (id, tenant_id, name)
    VALUES ('${profileId}', '${tenantId}', 'Personal');
  `);
  return { tenantId, profileId };
}

const throwingTemporalStarter: TemporalWorkflowStarter = {
  start: () => {
    throw new Error("this test seeds outbox rows directly and never dispatches for real");
  },
  close: async () => undefined,
};

describe.skipIf(!integrationEnabled)("Phase 0L processing jobs", () => {
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
    runtimePassword =
      config.services.postgres?.environment?.APP_RUNTIME_DB_PASSWORD ?? "";
    migratorPassword =
      config.services.postgres?.environment?.APP_MIGRATOR_DB_PASSWORD ?? "";
    if (!postgresContainerId || !runtimePassword || !migratorPassword) {
      throw new Error("Phase 0L PostgreSQL prerequisites are missing");
    }
    database = createAppDatabase(
      `postgresql://expense_app_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5433/expense_tax_db`,
    );
    const connection = await Connection.connect({ address: "127.0.0.1:7233" });
    temporalClient = new Client({ connection, namespace: "default" });
    executeMigratorSql(
      `UPDATE app.temporal_dispatch_routing SET task_queue = '${TASK_QUEUE}';`,
    );
  });

  afterAll(async () => {
    if (!postgresContainerId || !runtimePassword) return;
    runSql(`DELETE FROM app.tenants WHERE slug LIKE '0l-${runKey}-%';`);
    runSql(`DELETE FROM app.users WHERE primary_email LIKE '0l-${runKey}-%';`);
    executeMigratorSql(
      `UPDATE app.temporal_dispatch_routing SET task_queue = 'expense-tax-ai-worker';`,
    );
    await database.destroy();
  });

  it("creates a job and its dispatch outbox row in one transaction, scoped to exactly one Personal/business", async () => {
    const { tenantId, profileId } = seedTenantWithPersonalProfile();
    const domain = createProcessingJobsDomain(database, throwingTemporalStarter);

    const job = await domain.createJob({
      tenantId,
      scope: { personalProfileId: profileId },
      workflowType: WORKFLOW_TYPE,
      allowedResultSchemaVersion: "test-v1",
      actorServicePrincipal: "platform-admin",
      requestId: `0l-${runKey}-create`,
    });

    expect(job.status).toBe("PENDING");
    expect(job.workflowId).toBe(`job-${job.id}`);
    expect(
      executeSql(
        `SELECT status FROM app.processing_job_dispatch_outbox WHERE processing_job_id = '${job.id}';`,
      ),
    ).toBe("PENDING");
    expect(
      executeSql(`SELECT count(*) FROM app.app_audit_events WHERE resource_id = '${job.id}';`),
    ).toBe("1");

    // This test only asserts the outbox row's *existence*, not dispatch --
    // remove it so it doesn't leave a stray PENDING row for the global
    // (by-design, unscoped) dispatchPendingJobs sweep in a later test to
    // pick up and pollute its dispatchedCount assertion.
    executeSql(
      `DELETE FROM app.processing_job_dispatch_outbox WHERE processing_job_id = '${job.id}';`,
    );
  });

  it("rejects a job scoped to both Personal and business, or neither, before it ever reaches the database", async () => {
    const { tenantId } = seedTenantWithPersonalProfile();
    const domain = createProcessingJobsDomain(database, throwingTemporalStarter);

    // TypeScript's discriminated union already forbids this shape at compile
    // time; casting through `as never` to prove the DB-level CHECK
    // constraint independently backstops it (defense in depth, matching
    // this codebase's expenses_scope_check precedent).
    await expect(
      domain.createJob({
        tenantId,
        scope: {} as never,
        workflowType: WORKFLOW_TYPE,
        allowedResultSchemaVersion: "test-v1",
        actorServicePrincipal: "platform-admin",
        requestId: `0l-${runKey}-neither-scope`,
      }),
    ).rejects.toThrow();
  });

  it("dispatches a pending job to a real Temporal server with a deterministic, redispatch-safe workflow ID", async () => {
    const { tenantId, profileId } = seedTenantWithPersonalProfile();
    const realStarter = createTemporalWorkflowStarter({
      address: "127.0.0.1:7233",
      namespace: "default",
    });
    const domain = createProcessingJobsDomain(database, realStarter);

    const job = await domain.createJob({
      tenantId,
      scope: { personalProfileId: profileId },
      workflowType: WORKFLOW_TYPE,
      allowedResultSchemaVersion: "test-v1",
      actorServicePrincipal: "platform-admin",
      requestId: `0l-${runKey}-dispatch`,
    });

    const firstDispatch = await domain.dispatchPendingJobs({});
    expect(firstDispatch.dispatchedCount).toBe(1);

    const afterFirst = await domain.getJob(job.id);
    expect(afterFirst.status).toBe("DISPATCHED");
    expect(afterFirst.runId).not.toBeNull();
    expect(afterFirst.version).toBe(2);

    const description = await temporalClient.workflow
      .getHandle(job.workflowId)
      .describe();
    expect(description.status.name).toBe("RUNNING");

    // Redispatch safety: nothing left PENDING, so a second sweep is a no-op
    // even though the workflow is still running on the real server.
    const secondDispatch = await domain.dispatchPendingJobs({});
    expect(secondDispatch.dispatchedCount).toBe(0);

    // Simulate a dispatcher crash-then-retry: Temporal accepted the
    // start() call for real (proven above), but the follow-up DB
    // transaction that marks both rows DISPATCHED never committed (e.g. a
    // dropped connection right after). Both rows are consistently reset to
    // PENDING -- exactly the state a half-failed dispatch transaction would
    // actually leave behind, since the outbox+job update happens in one
    // transaction and can only ever fully commit or fully roll back
    // together. Redispatch must reach the same already-running workflow via
    // workflowIdConflictPolicy: "USE_EXISTING" rather than erroring or
    // double-starting.
    executeSql(`
      UPDATE app.processing_job_dispatch_outbox
      SET status = 'PENDING', dispatched_at = NULL WHERE processing_job_id = '${job.id}';
      UPDATE app.processing_jobs
      SET status = 'PENDING', dispatched_at = NULL, run_id = NULL WHERE id = '${job.id}';
    `);
    const redispatch = await domain.dispatchPendingJobs({});
    expect(redispatch.dispatchedCount).toBe(1);
    const afterRedispatch = await domain.getJob(job.id);
    expect(afterRedispatch.runId).toBe(afterFirst.runId);

    await temporalClient.workflow.getHandle(job.workflowId).terminate("test cleanup");
    await realStarter.close();
  });

  it("runs the DISPATCHED -> RUNNING -> SUCCEEDED lifecycle with idempotent replay and optimistic concurrency", async () => {
    const { tenantId, profileId } = seedTenantWithPersonalProfile();
    const domain = createProcessingJobsDomain(database, throwingTemporalStarter);
    const job = await domain.createJob({
      tenantId,
      scope: { personalProfileId: profileId },
      workflowType: WORKFLOW_TYPE,
      allowedResultSchemaVersion: "test-v1",
      actorServicePrincipal: "platform-admin",
      requestId: `0l-${runKey}-lifecycle-create`,
    });
    // Simulate a successful dispatch without touching the real Temporal
    // server -- this test is about the callback lifecycle, already proven
    // to reach Temporal for real in the previous test.
    executeSql(`
      UPDATE app.processing_jobs
      SET status = 'DISPATCHED', run_id = 'fake-run', dispatched_at = now(), version = 2
      WHERE id = '${job.id}';
    `);

    const running = await domain.recordStatusUpdate({
      jobId: job.id,
      request: {
        schemaVersion: 1,
        status: "RUNNING",
        idempotencyKey: `${job.id}:status:running`,
        expectedJobVersion: 2,
      },
      actorServicePrincipal: "ai-worker",
      requestId: `0l-${runKey}-status-running`,
    });
    expect(running.replayed).toBe(false);
    expect(running.body.status).toBe("RUNNING");
    expect(running.body.version).toBe(3);

    // True idempotent replay: same idempotency key, same body -> cached
    // response, no re-application, no version bump.
    const replay = await domain.recordStatusUpdate({
      jobId: job.id,
      request: {
        schemaVersion: 1,
        status: "RUNNING",
        idempotencyKey: `${job.id}:status:running`,
        expectedJobVersion: 2,
      },
      actorServicePrincipal: "ai-worker",
      requestId: `0l-${runKey}-status-running-replay`,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.body.version).toBe(3);

    // Stale expectedJobVersion on a genuinely new attempt is rejected.
    await expect(
      domain.recordStatusUpdate({
        jobId: job.id,
        request: {
          schemaVersion: 1,
          status: "RUNNING",
          idempotencyKey: `${job.id}:status:running:stale`,
          expectedJobVersion: 2,
        },
        actorServicePrincipal: "ai-worker",
        requestId: `0l-${runKey}-status-stale`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "PRECONDITION_FAILED" });

    const succeeded = await domain.submitResult({
      jobId: job.id,
      request: {
        schemaVersion: 1,
        status: "SUCCEEDED",
        idempotencyKey: `${job.id}:result:succeeded`,
        expectedJobVersion: 3,
        resultSchemaVersion: "test-v1",
        result: { echo: job.id },
      },
      actorServicePrincipal: "ai-worker",
      requestId: `0l-${runKey}-result`,
    });
    expect(succeeded.body.status).toBe("SUCCEEDED");
    expect(succeeded.body.result).toEqual({ echo: job.id });
    expect(succeeded.body.completedAt).not.toBeNull();

    // Terminal states never accept another transition.
    await expect(
      domain.recordStatusUpdate({
        jobId: job.id,
        request: {
          schemaVersion: 1,
          status: "FAILED",
          idempotencyKey: `${job.id}:status:failed-after-terminal`,
          expectedJobVersion: 4,
        },
        actorServicePrincipal: "ai-worker",
        requestId: `0l-${runKey}-status-after-terminal`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "CONFLICT" });

    // A resultSchemaVersion mismatch is a validation error, not a conflict.
    const otherJob = await domain.createJob({
      tenantId,
      scope: { personalProfileId: profileId },
      workflowType: WORKFLOW_TYPE,
      allowedResultSchemaVersion: "test-v1",
      actorServicePrincipal: "platform-admin",
      requestId: `0l-${runKey}-schema-mismatch-create`,
    });
    executeSql(`
      UPDATE app.processing_jobs
      SET status = 'DISPATCHED', run_id = 'fake-run', dispatched_at = now(), version = 2
      WHERE id = '${otherJob.id}';
    `);
    await expect(
      domain.submitResult({
        jobId: otherJob.id,
        request: {
          schemaVersion: 1,
          status: "SUCCEEDED",
          idempotencyKey: `${otherJob.id}:result:wrong-schema`,
          expectedJobVersion: 2,
          resultSchemaVersion: "wrong-v1",
          result: {},
        },
        actorServicePrincipal: "ai-worker",
        requestId: `0l-${runKey}-schema-mismatch`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "VALIDATION_ERROR" });
  });
});
