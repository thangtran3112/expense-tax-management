import { randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../services/app-api/src/app.js";
import { createAppConfig } from "../../services/app-api/src/config.js";
import { createAppDatabase } from "../../services/app-api/src/database/client.js";
import type { AppDatabase } from "../../services/app-api/src/database/types.js";
import { createProcessingJobsDomain } from "../../services/app-api/src/domain/processing-jobs.js";
import { createTemporalWorkflowStarter } from "../../services/app-api/src/temporal/client.js";
import type { AuthPrincipal, TokenVerifier } from "../../services/app-api/src/auth/types.js";
import type { Kysely } from "kysely";

// The heaviest test in this repo: a real Fastify HTTP listener, a real
// spawned Python OS process, and the real docker-composed Temporal server,
// all talking to each other. Every other integration test in this repo
// only exercises the domain layer directly against real Postgres -- this
// is the first genuine cross-language/cross-process proof, and it exists
// specifically because task-queue name mismatches, payload
// (de)serialization, and auth header shape are exactly the class of bug
// that per-language unit tests cannot catch.
const integrationEnabled = process.env.PHASE_0L_WORKER_LOOP === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const aiWorkerPython = path.join(repoRoot, "services/ai-worker/.venv/bin/python");
const runKey = randomUUID().slice(0, 8);
const TASK_QUEUE = `test-0l-worker-loop-${runKey}`;
const WORKER_TOKEN = `test-ai-worker-token-${runKey}`;

let postgresContainerId = "";
let runtimePassword = "";
let migratorPassword = "";
let database: Kysely<AppDatabase>;
let workerProcess: ChildProcess | undefined;
let appPort = 0;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

interface ComposeConfig {
  readonly services: Record<
    string,
    { readonly environment?: Record<string, string | null> }
  >;
}

function executeSql(sql: string): string {
  const result = spawnSync(
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
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/**
 * Task 7 Stage A: app.temporal_dispatch_routing grants the runtime role
 * SELECT only -- migrator credentials point the singleton row's queue at
 * this run's isolated TASK_QUEUE (namespace stays the seeded 'default',
 * matching generation 1) so the enqueue fence doesn't collide with other
 * suites on the real shared queue 'expense-tax-ai-worker'.
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

function servicePrincipal(clientId: string, scopes: readonly string[]): AuthPrincipal {
  return {
    tokenType: "service",
    subject: clientId,
    clientId,
    audience: "expense-app-internal",
    issuer: "https://services.test",
    roles: [],
    scopes,
    tokenId: `${clientId}-token-id`,
    email: null,
    emailVerified: null,
    displayName: null,
  };
}

async function waitForSucceeded(jobId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = executeSql(
      `SELECT status FROM app.processing_jobs WHERE id = '${jobId}';`,
    );
    if (status === "SUCCEEDED" || status === "FAILED") return status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for job ${jobId} to reach a terminal status`);
}

describe.skipIf(!integrationEnabled)("Phase 0L real worker loop", () => {
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
    executeMigratorSql(
      `UPDATE app.temporal_dispatch_routing SET task_queue = '${TASK_QUEUE}';`,
    );

    const serviceVerifier: TokenVerifier = {
      verify: async (token) => {
        if (token === WORKER_TOKEN) return servicePrincipal("ai-worker", ["jobs:write"]);
        throw new Error("wrong token");
      },
    };
    const temporalStarter = createTemporalWorkflowStarter({
      address: "127.0.0.1:7233",
      namespace: "default",
    });
    app = buildApp({
      config: createAppConfig({
        env: {
          AUTH_PROVIDER: "legacy",
          APP_TENANT_TOKEN_ISSUER: "https://identity.test",
          APP_TENANT_TOKEN_AUDIENCE: "expense-app",
          APP_TENANT_JWKS_URL: "https://identity.test/.well-known/jwks.json",
          APP_SERVICE_TOKEN_ISSUER: "https://services.test",
          APP_SERVICE_TOKEN_AUDIENCE: "expense-app-internal",
          APP_SERVICE_JWKS_URL: "https://services.test/.well-known/jwks.json",
          APP_DATABASE_URL: "postgresql://unused.test/app",
          TEMPORAL_HOST: "127.0.0.1:7233",
          TEMPORAL_NAMESPACE: "default",
          STORAGE_BACKEND: "local",
          LOCAL_STORAGE_DIR: "/tmp/expense-tax-0l-loop-storage",
          STORAGE_LOCAL_BASE_URL: "http://127.0.0.1:8100",
          STORAGE_URL_SIGNING_KEY: "test-0l-loop-signing-key",
          INBOUND_EMAIL_BASE_ADDRESS: "receipts@inbound.test",
          INBOUND_WEBHOOK_SIGNING_KEY: "unused-webhook-key",
          INBOUND_ROUTING_TOKEN_SECRET: "unused-routing-key",
          INBOUND_CHALLENGE_DIR: "/tmp/expense-tax-0l-challenges",
        },
        version: "test",
      }),
      logger: false,
      database,
      authVerifiers: {
        tenant: { verify: async () => { throw new Error("no tenant tokens in this test"); } },
        service: serviceVerifier,
      },
      temporalStarter,
      processingJobsDomain: createProcessingJobsDomain(database, temporalStarter),
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Fastify did not bind a port");
    appPort = address.port;

    workerProcess = spawn(
      aiWorkerPython,
      ["-m", "ai_worker.run_worker"],
      {
        cwd: path.join(repoRoot, "services/ai-worker"),
        env: {
          ...process.env,
          TEMPORAL_HOST: "127.0.0.1:7233",
          TEMPORAL_NAMESPACE: "default",
          AI_WORKER_TASK_QUEUE: TASK_QUEUE,
          APP_API_BASE_URL: `http://127.0.0.1:${appPort}`,
          APP_API_SERVICE_TOKEN: WORKER_TOKEN,
          // Legacy fake service tokens keep this test local; Clerk values only
          // satisfy worker startup validation and are never contacted.
          CLERK_ISSUER_URL: "https://clerk.test",
          CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
          CLERK_TENANT_AUDIENCE: "phase-0l-test-tenant",
          CLERK_PLATFORM_AUDIENCE: "phase-0l-test-platform",
          CLERK_APP_SERVICE_AUDIENCE: "phase-0l-test-app-service",
          CLERK_FOUNDRY_SERVICE_AUDIENCE: "phase-0l-test-foundry-service",
          CLERK_APP_MACHINE_SECRET_KEY: "phase-0l-test-app-machine-secret",
          CLERK_FOUNDRY_MACHINE_SECRET_KEY: "phase-0l-test-foundry-machine-secret",
          CLERK_APP_SERVICE_SUBJECT: "phase-0l-test-app-subject",
          CLERK_FOUNDRY_SERVICE_SUBJECT: "phase-0l-test-foundry-subject",
          // Echo jobs never touch Foundry, but run_worker constructs all
          // clients at startup -- dummies satisfy construction only.
          FOUNDRY_BASE_URL: "http://127.0.0.1:9",
          FOUNDRY_SERVICE_TOKEN: "unused",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let workerReady = "";
    workerProcess.stdout?.on("data", (chunk: Buffer) => {
      workerReady += chunk.toString();
      process.stderr.write(`[ai-worker stdout] ${chunk.toString()}`);
    });
    workerProcess.stderr?.on("data", (chunk: Buffer) => {
      workerReady += chunk.toString();
      process.stderr.write(`[ai-worker stderr] ${chunk.toString()}`);
    });
    const readyDeadline = Date.now() + 15_000;
    while (!workerReady.includes("polling task queue") && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!workerReady.includes("polling task queue")) {
      throw new Error(`ai-worker did not report ready in time. Output so far:\n${workerReady}`);
    }
  }, 30_000);

  afterAll(async () => {
    workerProcess?.kill("SIGTERM");
    await app?.close();
    if (postgresContainerId && runtimePassword) {
      executeSql(`DELETE FROM app.tenants WHERE slug LIKE '0l-loop-${runKey}-%';`);
      executeSql(`DELETE FROM app.users WHERE primary_email LIKE '0l-loop-${runKey}-%';`);
    }
    if (postgresContainerId && migratorPassword) {
      executeMigratorSql(
        `UPDATE app.temporal_dispatch_routing SET task_queue = 'expense-tax-ai-worker';`,
      );
    }
    await database?.destroy();
  });

  it("dispatches a real job to a real Python worker process and reaches SUCCEEDED end to end", async () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const profileId = randomUUID();
    executeSql(`
      INSERT INTO app.users (id, primary_email, display_name)
      VALUES ('${userId}', '0l-loop-${runKey}-${userId.slice(0, 6)}@example.test', '0L Loop User');
      INSERT INTO app.tenants (id, name, slug)
      VALUES ('${tenantId}', '0L Loop Tenant', '0l-loop-${runKey}-${tenantId.slice(0, 6)}');
      INSERT INTO app.tenant_memberships (tenant_id, user_id, role)
      VALUES ('${tenantId}', '${userId}', 'owner');
      INSERT INTO app.personal_profiles (id, tenant_id, name)
      VALUES ('${profileId}', '${tenantId}', 'Personal');
    `);

    const domain = createProcessingJobsDomain(
      database,
      createTemporalWorkflowStarter({ address: "127.0.0.1:7233", namespace: "default" }),
    );
    const job = await domain.createJob({
      tenantId,
      scope: { personalProfileId: profileId },
      workflowType: "FoundationEchoWorkflow",
      allowedResultSchemaVersion: "foundation-echo-v1",
      actorServicePrincipal: "platform-admin",
      requestId: `0l-loop-${runKey}-create`,
    });

    const dispatch = await domain.dispatchPendingJobs({});
    expect(dispatch.dispatchedCount).toBe(1);

    const finalStatus = await waitForSucceeded(job.id, 20_000);
    expect(finalStatus).toBe("SUCCEEDED");

    const resultJson = executeSql(
      `SELECT result::text FROM app.processing_jobs WHERE id = '${job.id}';`,
    );
    expect(JSON.parse(resultJson)).toEqual({ echo: job.id });
  }, 30_000);
});
