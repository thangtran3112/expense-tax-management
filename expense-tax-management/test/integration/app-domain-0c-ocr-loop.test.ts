import { randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LEGACY_AI_WORKER_TASK_QUEUE } from "../../packages/contracts/src/index.js";
import { buildApp as buildAppApi } from "../../services/app-api/src/app.js";
import { createAppConfig } from "../../services/app-api/src/config.js";
import { createAppDatabase } from "../../services/app-api/src/database/client.js";
import type { AppDatabase } from "../../services/app-api/src/database/types.js";
import { createFilesDomain } from "../../services/app-api/src/domain/files.js";
import { createOcrJobsDomain } from "../../services/app-api/src/domain/ocr.js";
import { createPlansDomain } from "../../services/app-api/src/domain/plans.js";
import { createProcessingJobsDomain } from "../../services/app-api/src/domain/processing-jobs.js";
import { createTemporalWorkflowStarter } from "../../services/app-api/src/temporal/client.js";
import type { AuthPrincipal as AppAuthPrincipal, TokenVerifier as AppTokenVerifier } from "../../services/app-api/src/auth/types.js";
import { createLocalStorageAdapter } from "../../services/app-api/src/storage/local.js";
import { buildApp as buildFoundry } from "../../services/foundry-service/src/app.js";
import { createFoundryConfig } from "../../services/foundry-service/src/config.js";
import { createFoundryDatabase } from "../../services/foundry-service/src/database/client.js";
import type { FoundryDatabase } from "../../services/foundry-service/src/database/types.js";
import { createQuotasDomain } from "../../services/foundry-service/src/domain/quotas.js";
import type { AuthPrincipal as FoundryAuthPrincipal, TokenVerifier as FoundryTokenVerifier } from "../../services/foundry-service/src/auth/types.js";
import type { Kysely } from "kysely";

// The design-doc section 22 gate, scoped to the fake provider: a real
// tenant file becomes a real expense through a real quota reservation,
// real Temporal orchestration, and a real Python worker subprocess -- the
// only stubbed component is the provider's "eyes" (canned extraction).
// Heaviest test in the repo (two live Fastify services + worker process +
// Temporal + Postgres + storage); gated behind its own flag.
const integrationEnabled = process.env.PHASE_0C_OCR_LOOP === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const aiWorkerPython = path.join(repoRoot, "services/ai-worker/.venv/bin/python");
const runKey = randomUUID().slice(0, 8);
// Task 7 Stage A: new jobs dispatch wherever app.temporal_dispatch_routing
// says (createJobInTransaction reads it FOR SHARE), not a bare queue
// constant. Generation 1 (this migration's seed, and today's production
// default) targets the legacy Python queue, so this test's worker -- a
// stand-in for that same production Python worker -- must poll
// LEGACY_AI_WORKER_TASK_QUEUE, the queue OCR actually dispatches to by
// default. This is still the real shared queue (not a per-run random
// one like the 0L loop test uses), so the stale dev compose worker (old
// code, no OcrReceiptWorkflow) must be stopped first or it races for our
// tasks and poison-fails them as unknown type. beforeAll stops it;
// afterAll restarts it.
const TASK_QUEUE = LEGACY_AI_WORKER_TASK_QUEUE;
const WORKER_TOKEN = `test-ocr-worker-token-${runKey}`;
const SIGNING_KEY = `0c-loop-signing-${runKey}`;

let postgresContainerId = "";
let appRuntimePassword = "";
let foundryRuntimePassword = "";
let appDatabase: Kysely<AppDatabase>;
let foundryDatabase: Kysely<FoundryDatabase>;
let workerProcess: ChildProcess | undefined;
let appPort = 0;
let foundryPort = 0;
let storageRoot = "";
let app: Awaited<ReturnType<typeof buildAppApi>> | undefined;
let foundry: Awaited<ReturnType<typeof buildFoundry>> | undefined;
const foundryTenantIds: string[] = [];
const appTenantIds: string[] = [];

interface ComposeConfig {
  readonly services: Record<
    string,
    { readonly environment?: Record<string, string | null> }
  >;
}

function appSql(sql: string): string {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-e",
      `PGPASSWORD=${appRuntimePassword}`,
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

function foundrySql(sql: string): string {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-e",
      `PGPASSWORD=${foundryRuntimePassword}`,
      postgresContainerId,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "--host",
      "127.0.0.1",
      "--username",
      "expense_foundry_runtime",
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

function appServicePrincipal(clientId: string, scopes: readonly string[]): AppAuthPrincipal {
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

function foundryServicePrincipal(clientId: string, scopes: readonly string[]): FoundryAuthPrincipal {
  return {
    tokenType: "service",
    subject: clientId,
    clientId,
    audience: "expense-foundry-internal",
    issuer: "https://services.test",
    roles: [],
    scopes,
    tokenId: `${clientId}-token-id`,
  };
}

const TINY_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF",
  "utf8",
);

async function waitFor(
  label: string,
  poll: () => string,
  want: readonly string[],
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = poll();
    if (want.includes(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label} (last: ${last || "<empty>"})`);
}

describe.skipIf(!integrationEnabled)("Phase 0C real OCR loop", () => {
  beforeAll(async () => {
    execFileSync(composeScript, ["stop", "ai-worker"], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "ignore", "ignore"],
    });
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
    appRuntimePassword =
      config.services.postgres?.environment?.APP_RUNTIME_DB_PASSWORD ?? "";
    foundryRuntimePassword =
      config.services.postgres?.environment?.FOUNDRY_RUNTIME_DB_PASSWORD ?? "";
    if (!postgresContainerId || !appRuntimePassword || !foundryRuntimePassword) {
      throw new Error("Phase 0C PostgreSQL prerequisites are missing");
    }
    appDatabase = createAppDatabase(
      `postgresql://expense_app_runtime:${encodeURIComponent(appRuntimePassword)}@127.0.0.1:5433/expense_tax_db`,
    );
    foundryDatabase = createFoundryDatabase(
      `postgresql://expense_foundry_runtime:${encodeURIComponent(foundryRuntimePassword)}@127.0.0.1:5433/expense_tax_db`,
    );
    storageRoot = await mkdtemp(path.join(tmpdir(), `expense-tax-0c-loop-${runKey}-`));

    const appServiceVerifier: AppTokenVerifier = {
      verify: async (token) => {
        // Production token issuance must grant the worker BOTH scopes (job
        // writes from 0L, file reads from 0D); the fake verifier mirrors
        // that union.
        if (token === WORKER_TOKEN) {
          return appServicePrincipal("ai-worker", ["jobs:write", "files:read"]);
        }
        throw new Error("wrong token");
      },
    };
    // Thunk: the ephemeral listen port isn't known until after buildApp,
    // but the adapter is constructed before it. Resolved per URL issuance.
    const storage = createLocalStorageAdapter({
      rootDir: storageRoot,
      baseUrl: () => `http://127.0.0.1:${appPort}`,
      signingKey: SIGNING_KEY,
    });
    app = buildAppApi({
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
          LOCAL_STORAGE_DIR: storageRoot,
          STORAGE_LOCAL_BASE_URL: "http://127.0.0.1:8100",
          STORAGE_URL_SIGNING_KEY: SIGNING_KEY,
          INBOUND_EMAIL_BASE_ADDRESS: "receipts@inbound.test",
          INBOUND_WEBHOOK_SIGNING_KEY: "unused-webhook-key",
          INBOUND_ROUTING_TOKEN_SECRET: "unused-routing-key",
          INBOUND_CHALLENGE_DIR: "/tmp/expense-tax-0c-challenges",
        },
        version: "test",
      }),
      logger: false,
      database: appDatabase,
      storageAdapter: storage,
      authVerifiers: {
        tenant: { verify: async () => { throw new Error("no tenant tokens in this test"); } },
        service: appServiceVerifier,
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const appAddress = app.server.address();
    if (!appAddress || typeof appAddress === "string") throw new Error("App API did not bind");
    appPort = appAddress.port;

    const foundryServiceVerifier: FoundryTokenVerifier = {
      verify: async (token) => {
        if (token === WORKER_TOKEN) {
          return foundryServicePrincipal("ai-worker", ["reservations:write", "routes:read"]);
        }
        throw new Error("wrong token");
      },
    };
    foundry = buildFoundry({
      config: createFoundryConfig({
        env: {
          AUTH_PROVIDER: "legacy",
          FOUNDRY_PLATFORM_TOKEN_ISSUER: "https://identity.test",
          FOUNDRY_PLATFORM_TOKEN_AUDIENCE: "expense-foundry-platform",
          FOUNDRY_PLATFORM_JWKS_URL: "https://identity.test/.well-known/jwks.json",
          FOUNDRY_SERVICE_TOKEN_ISSUER: "https://services.test",
          FOUNDRY_SERVICE_TOKEN_AUDIENCE: "expense-foundry-internal",
          FOUNDRY_SERVICE_JWKS_URL: "https://services.test/.well-known/jwks.json",
          FOUNDRY_DATABASE_URL: "postgresql://unused.test/foundry",
        },
        version: "test",
      }),
      logger: false,
      database: foundryDatabase,
      authVerifiers: {
        platform: { verify: async () => { throw new Error("unused"); } },
        service: foundryServiceVerifier,
      },
    });
    await foundry.listen({ port: 0, host: "127.0.0.1" });
    const foundryAddress = foundry.server.address();
    if (!foundryAddress || typeof foundryAddress === "string") {
      throw new Error("Foundry did not bind");
    }
    foundryPort = foundryAddress.port;

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
          FOUNDRY_BASE_URL: `http://127.0.0.1:${foundryPort}`,
          FOUNDRY_SERVICE_TOKEN: WORKER_TOKEN,
          CLERK_ISSUER_URL: "https://clerk.test",
          CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
          CLERK_TENANT_AUDIENCE: "tenant-audience",
          CLERK_PLATFORM_AUDIENCE: "platform-audience",
          CLERK_APP_SERVICE_AUDIENCE: "app-service-audience",
          CLERK_FOUNDRY_SERVICE_AUDIENCE: "foundry-service-audience",
          CLERK_APP_SERVICE_SUBJECT: "ai-worker",
          CLERK_FOUNDRY_SERVICE_SUBJECT: "ai-worker",
          CLERK_APP_MACHINE_SECRET_KEY: "test-inert-app-machine-secret",
          CLERK_FOUNDRY_MACHINE_SECRET_KEY: "test-inert-foundry-machine-secret",
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
      throw new Error(`ai-worker did not report ready in time:\n${workerReady}`);
    }
  }, 60_000);

  afterAll(async () => {
    workerProcess?.kill("SIGTERM");
    await app?.close();
    await foundry?.close();
    execFileSync(composeScript, ["up", "-d", "ai-worker"], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (postgresContainerId && appRuntimePassword) {
      // Audit rows reference users with ON DELETE SET NULL, but the audit
      // CHECK requires an actor -- remove ours first. Worker-driven writes
      // carry Fastify request IDs (req-N), not runKey tags, so scope by
      // tenant, not request_id.
      for (const tenantId of appTenantIds) {
        appSql(`DELETE FROM app.app_audit_events WHERE tenant_id = '${tenantId}';`);
      }
      appSql(`DELETE FROM app.tenants WHERE slug LIKE '0c-loop-${runKey}-%';`);
      appSql(`DELETE FROM app.users WHERE primary_email LIKE '0c-loop-${runKey}-%';`);
    }
    if (postgresContainerId && foundryRuntimePassword) {
      for (const tenantId of foundryTenantIds) {
        foundrySql(
          `DELETE FROM foundry.provider_call_logs WHERE reservation_id IN (SELECT id FROM foundry.ai_quota_reservations WHERE tenant_id = '${tenantId}');`,
        );
        foundrySql(
          `DELETE FROM foundry.ai_quota_reservations WHERE tenant_id = '${tenantId}';`,
        );
        foundrySql(
          `DELETE FROM foundry.tenant_ai_quotas WHERE tenant_id = '${tenantId}';`,
        );
      }
    }
    await appDatabase?.destroy();
    await foundryDatabase?.destroy();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  function seedTenant(): { userId: string; tenantId: string; profileId: string } {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const profileId = randomUUID();
    appSql(`
      INSERT INTO app.users (id, primary_email, display_name)
      VALUES ('${userId}', '0c-loop-${runKey}-${userId.slice(0, 6)}@example.test', '0C Loop');
      INSERT INTO app.tenants (id, name, slug)
      VALUES ('${tenantId}', '0C Loop Tenant', '0c-loop-${runKey}-${tenantId.slice(0, 6)}');
      INSERT INTO app.tenant_memberships (tenant_id, user_id, role)
      VALUES ('${tenantId}', '${userId}', 'owner');
      INSERT INTO app.personal_profiles (id, tenant_id, name)
      VALUES ('${profileId}', '${tenantId}', 'Personal');
      INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role)
      VALUES ('${profileId}', '${tenantId}', '${userId}', 'owner');
    `);
    foundryTenantIds.push(tenantId);
    appTenantIds.push(tenantId);
    return { userId, tenantId, profileId };
  }

  function appDomains() {
    const storage = createLocalStorageAdapter({
      rootDir: storageRoot,
      baseUrl: `http://127.0.0.1:${appPort}`,
      signingKey: SIGNING_KEY,
    });
    const filesDomain = createFilesDomain(appDatabase, storage);
    return {
      storage,
      filesDomain,
      ocrJobsDomain: createOcrJobsDomain(appDatabase, {
        plansDomain: createPlansDomain(appDatabase),
        filesDomain,
      }),
      jobsDomain: createProcessingJobsDomain(
        appDatabase,
        createTemporalWorkflowStarter({ address: "127.0.0.1:7233", namespace: "default" }),
      ),
    };
  }

  async function createConfirmedFile(tenant: { userId: string; tenantId: string; profileId: string }, tag: string) {
    const { storage, filesDomain } = appDomains();
    const created = await filesDomain.createUploadSession({
      actorUserId: tenant.userId,
      tenantId: tenant.tenantId,
      scope: { kind: "personal", profileId: tenant.profileId },
      request: { originalFilename: `${tag}.pdf`, contentType: "application/pdf" },
      idempotencyKey: `0c-loop-${runKey}-${tag}`,
      requestId: `0c-loop-${runKey}-${tag}`,
    });
    const row = await appDatabase
      .selectFrom("app.expense_files")
      .selectAll()
      .where("id", "=", created.body.file.id)
      .executeTakeFirstOrThrow();
    await storage.writeObject({
      storageKey: row.storage_key,
      data: TINY_PDF,
      contentType: "application/pdf",
    });
    return filesDomain.confirmUploadSession({
      actorUserId: tenant.userId,
      tenantId: tenant.tenantId,
      scope: { kind: "personal", profileId: tenant.profileId },
      sessionId: created.body.uploadSession.id,
      requestId: `0c-loop-${runKey}-${tag}-confirm`,
    });
  }

  it("turns a confirmed file into a reviewed expense through the full fake-provider pipeline", async () => {
    const tenant = seedTenant();
    const { ocrJobsDomain, jobsDomain } = appDomains();
    const file = await createConfirmedFile(tenant, "happy");

    const created = await ocrJobsDomain.createOcrJob({
      actorUserId: tenant.userId,
      tenantId: tenant.tenantId,
      scope: { kind: "personal", profileId: tenant.profileId },
      fileId: file.id,
      modeKey: "ocr_mode_balanced",
      idempotencyKey: `0c-loop-${runKey}-happy`,
      requestId: `0c-loop-${runKey}-happy`,
    });
    const dispatch = await jobsDomain.dispatchPendingJobs({});
    expect(dispatch.dispatchedCount).toBe(1);

    // Poll until bound (non-empty) or terminal failure.
    const deadline = Date.now() + 45_000;
    let boundExpenseId = "";
    let jobStatus = "";
    while (Date.now() < deadline) {
      boundExpenseId = appSql(`SELECT expense_id FROM app.expense_files WHERE id = '${file.id}';`);
      jobStatus = appSql(
        `SELECT status FROM app.processing_jobs WHERE id = '${created.body.id}';`,
      );
      if (boundExpenseId || jobStatus === "FAILED") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(jobStatus).toBe("SUCCEEDED");
    expect(boundExpenseId).not.toBe("");

    const expense = await appDatabase
      .selectFrom("app.expenses")
      .selectAll()
      .where("id", "=", boundExpenseId)
      .executeTakeFirstOrThrow();
    expect(expense.merchant).toBe("Fake OCR Merchant");
    expect(expense.amount).toBe("12.34");
    expect(expense.currency).toBe("USD");
    expect(expense.source).toBe("ocr");
    expect(expense.status).toBe("ready");

    // Trace chain, section 18: expense -> job -> reservation (CONSUMED).
    const jobTarget = appSql(
      `SELECT target_aggregate_id FROM app.processing_jobs WHERE id = '${created.body.id}';`,
    );
    expect(jobTarget).toBe(boundExpenseId);
    const reservationStatus = foundrySql(
      `SELECT status FROM foundry.ai_quota_reservations WHERE idempotency_key = '${created.body.id}:ocr:reserve:v1';`,
    );
    expect(reservationStatus).toBe("CONSUMED");
  }, 60_000);

  it("marks the job FAILED with QUOTA_BLOCKED and creates no expense when capped", async () => {
    const tenant = seedTenant();
    const quotasDomain = createQuotasDomain(foundryDatabase);
    await quotasDomain.createTenantAiQuota({
      request: {
        tenantId: tenant.tenantId,
        operation: "RECEIPT_OCR",
        aiModelId: null,
        periodType: "monthly",
        maxJobs: 0,
      },
      actorPlatformSubject: "test",
      requestId: `0c-loop-${runKey}-cap`,
    });

    const { ocrJobsDomain, jobsDomain } = appDomains();
    const file = await createConfirmedFile(tenant, "capped");
    const created = await ocrJobsDomain.createOcrJob({
      actorUserId: tenant.userId,
      tenantId: tenant.tenantId,
      scope: { kind: "personal", profileId: tenant.profileId },
      fileId: file.id,
      modeKey: "ocr_mode_fast",
      idempotencyKey: `0c-loop-${runKey}-capped`,
      requestId: `0c-loop-${runKey}-capped`,
    });
    await jobsDomain.dispatchPendingJobs({});

    const finalStatus = await waitFor(
      "job terminal status",
      () =>
        appSql(
          `SELECT status FROM app.processing_jobs WHERE id = '${created.body.id}';`,
        ),
      ["SUCCEEDED", "FAILED"],
      45_000,
    );
    expect(finalStatus).toBe("FAILED");
    // Typed marker lives in result.error (machine-readable); error_message
    // stays for human free-text (the FAILED submit carries none).
    const resultJson = appSql(
      `SELECT result::text FROM app.processing_jobs WHERE id = '${created.body.id}';`,
    );
    expect(JSON.parse(resultJson)).toEqual({ error: "QUOTA_BLOCKED" });
    expect(
      appSql(`SELECT expense_id FROM app.expense_files WHERE id = '${file.id}';`),
    ).toBe("");
    expect(
      appSql(
        `SELECT count(*) FROM app.expenses WHERE tenant_id = '${tenant.tenantId}';`,
      ),
    ).toBe("0");

    // The tenant can see the failure (and its marker) via the file's jobs.
    const listed = await ocrJobsDomain.listOcrJobs({
      actorUserId: tenant.userId,
      tenantId: tenant.tenantId,
      scope: { kind: "personal", profileId: tenant.profileId },
      fileId: file.id,
    });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.status).toBe("FAILED");
  }, 60_000);
});
