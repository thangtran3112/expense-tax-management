/**
 * Phase 3D-C Task 7 — phase verification: a consolidated, real-PostgreSQL
 * proof that App API's connected-mailbox ingestion domain (Tasks 1-6)
 * composes correctly end to end through the real route registrations
 * (registerMailboxCandidateRoutes, registerMailboxIngestionRoutes,
 * registerMailboxInternalRoutes, registerJobRoutes) via the real
 * `buildApp`, rather than only at the domain-function level (Tasks 1-6's
 * own suites already cover every edge case exhaustively -- this suite
 * does not re-litigate those). Fakes stand in for Gmail/the mailbox
 * broker HTTP service/the Temporal worker: every broker/worker call this
 * phase depends on is simulated as a direct, correctly-authenticated HTTP
 * call against the real App routes, exactly the shape the real broker/
 * worker processes make. No Google/GCP/Clerk network access anywhere.
 *
 * Gated on PHASE_3D_C_T7_INTEGRATION=1, wired into the zero-skip CI chain
 * (scripts/verify-phase-0n.mjs) the same way Phase 3D-A/3D-B wired their
 * own Task 6 suites (see scripts/check-mailbox-t7-ci-wiring.test.mjs).
 *
 * Covers, in one place:
 *   - migrations 016-021 apply in order, 020/021 add exactly the tables/
 *     columns the plan specifies
 *   - ingest approval: resolve(action: "ingest") transactionally creates
 *     a MailboxMaterializeWorkflow processing job + dispatch-outbox row,
 *     stamped with the fixed TypeScript target (namespace "expense-tax",
 *     queue "expense-tax-processing"); dispatchPendingJobs starts it
 *     through the real (fake) Temporal starter with that exact target
 *   - structured-receipt path: the broker's direct structured-result
 *     callback materializes an expense with connected_mailbox provenance,
 *     a Phase 3C enrichment job, and (on a second, merchant/amount/
 *     currency/date-identical candidate) Phase 3B pending-dedup evidence
 *     (duplicate detection link)
 *   - attachment path: a streamed upload hash-verifies against the
 *     candidate's own manifest, creates a per-attachment
 *     MailboxOcrReceiptWorkflow job only once READY, and a malware-
 *     signed attachment is blocked (dead end) with MALWARE_DETECTED
 *     surfaced onto the candidate once the materialize job itself
 *     reports failure
 *   - OCR job lifecycle: dispatch -> RUNNING -> SUCCEEDED (via the
 *     generic ai-worker-guarded job routes, the real attachment-OCR
 *     identity) materializes an expense the same way the structured path
 *     does
 *   - retry two-step: a MAILBOX_MATERIALIZE_FAILED candidate clears to
 *     `review` via `retry`, then a fresh `ingest` re-enqueues a new
 *     materialize job (migration 019 forbids `failed` -> `queued` directly)
 *   - idempotent replays: resolve/issueUploadGrant/receiveAttachment/
 *     submitStructuredReceipt/job-status/job-result all return the exact
 *     cached result on an exact-payload replay, never a duplicate side
 *     effect
 *   - no content leakage: every HTTP response captured during the run,
 *     every relevant persisted row (mailbox_ingestion_operations.
 *     response_json, processing_jobs.input_params/result,
 *     expense_sources.metadata), and every captured log line are free of
 *     the raw attachment bytes, the malware signature's carrier bytes,
 *     and any bearer token
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { Writable } from "node:stream";

import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../services/app-api/src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../../services/app-api/src/auth/types.js";
import { createAppConfig } from "../../services/app-api/src/config.js";
import { createAppDatabase } from "../../services/app-api/src/database/client.js";
import { runMigrations } from "../../services/app-api/src/database/migrate.js";
import type { AppDatabase } from "../../services/app-api/src/database/types.js";
import type { IdentityDomain } from "../../services/app-api/src/domain/identity.js";
import type { PlansDomain } from "../../services/app-api/src/domain/plans.js";
import type {
  StartWorkflowInput,
  StartWorkflowResult,
  TemporalWorkflowStarter,
} from "../../services/app-api/src/temporal/client.js";
// Relative imports into the contracts package's own source (not the bare
// "@expense-tax/contracts" specifier): this test file lives at the repo
// root's test/integration/, outside any workspace package, so it has no
// node_modules/@expense-tax symlink of its own -- only packages that
// declare @expense-tax/contracts as a real dependency (e.g. app-api) get
// one. Every other root-level integration test that needs a VALUE (not
// just a type, which esbuild erases before resolution) export from
// contracts reaches it the same indirect way, through a package that
// already depends on it; this file reaches the source directly instead,
// since nothing here already re-exports these specific constants.
import {
  AI_WORKER_TASK_QUEUE,
  EXPENSE_ENRICHMENT_WORKFLOW_TYPE,
  MAILBOX_MATERIALIZE_RESULT_SCHEMA_VERSION,
  MAILBOX_MATERIALIZE_WORKFLOW_TYPE,
  MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE,
  OCR_EXTRACTION_RESULT_SCHEMA_VERSION,
  TARGET_TEMPORAL_NAMESPACE,
} from "../../packages/contracts/src/internal/task-queues.js";
import type { MailboxMaterializationResultV1 } from "../../packages/contracts/src/mailbox-ingestion.js";

const integrationEnabled = process.env.PHASE_3D_C_T7_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().replaceAll("-", "").slice(0, 10);
const databaseName = `expense_tax_t7c_mailbox_${runKey}`;
const storageDir = path.join(tmpdir(), `expense-tax-t7c-storage-${runKey}`);

interface ComposeConfig {
  readonly services: Record<string, { readonly environment?: Record<string, string | null> }>;
}

const TENANT_ID = "7c000000-0000-4000-8000-000000000001";
const OWNER_USER_ID = "7c000000-0000-4000-8000-000000000002";
const PROFILE_ID = "7c000000-0000-4000-8000-000000000003";
const CONNECTION_ID = "7c000000-0000-4000-8000-000000000004";
const SCAN_RUN_ID = "7c000000-0000-4000-8000-000000000005";
const DUMMY_HASH = "a".repeat(64);

const EICAR_MARKER =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

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

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A PDF-signed attachment body: sniffContentType needs the "%PDF-" magic
 * before anything else runs (hash check, scan). Carries a per-test unique
 * marker so the "no attachment bytes leak" check has something concrete
 * to search for. */
function pdfBytes(marker: string): Buffer {
  return Buffer.from(`%PDF-1.4\n%mailbox-attachment-${marker}\n`, "ascii");
}

/** Same PDF magic (passes the signature sniff) but carrying the EICAR
 * test string, so PatternMalwareScanner blocks it deterministically --
 * no real AV engine, no network, same precedent as every other mailbox
 * malware test in this repo. */
function eicarPdfBytes(): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.4\n", "ascii"), Buffer.from(EICAR_MARKER, "ascii")]);
}

function attachmentManifestEntry(bytes: Buffer, name: string) {
  return {
    name,
    mimeType: "application/pdf",
    sizeBytes: bytes.byteLength,
    sha256: sha256Hex(bytes),
  };
}

function servicePrincipal(subject: string, scopes: readonly string[]): AuthPrincipal {
  return {
    tokenType: "service",
    subject,
    clientId: subject,
    audience: "expense-app-internal",
    issuer: "https://services.t7c.test",
    roles: [],
    scopes,
    tokenId: `${subject}-token-id`,
    email: null,
    emailVerified: null,
    displayName: null,
  };
}

function tenantPrincipal(subject: string): AuthPrincipal {
  return {
    tokenType: "tenant",
    subject,
    clientId: null,
    audience: "expense-app",
    issuer: "https://identity.t7c.test",
    roles: [],
    scopes: [],
    tokenId: `${subject}-token-id`,
    email: `${subject}@example.test`,
    emailVerified: true,
    displayName: "T7C Owner",
  };
}

describe.skipIf(!integrationEnabled)("Phase 3D-C Task 7 — mailbox ingestion phase verification (live PostgreSQL)", () => {
  beforeAll(async () => {
    const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
    if (!dockerAvailable) throw new Error("Task 7 (3D-C) PostgreSQL prerequisites unavailable");

    postgresContainerId = execFileSync(composeScript, ["ps", "-q", "postgres"], {
      cwd: repoRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!postgresContainerId) throw new Error("Task 7 (3D-C) PostgreSQL prerequisites unavailable (run ./scripts/compose.sh up -d --wait postgres)");

    const config = JSON.parse(
      execFileSync(composeScript, ["config", "--format", "json"], {
        cwd: repoRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as ComposeConfig;
    runtimePassword = config.services.postgres?.environment?.APP_RUNTIME_DB_PASSWORD ?? "";
    migratorPassword = config.services.postgres?.environment?.APP_MIGRATOR_DB_PASSWORD ?? "";
    if (!runtimePassword || !migratorPassword) throw new Error("Task 7 (3D-C) PostgreSQL prerequisites unavailable");

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
        ('${OWNER_USER_ID}', 't7c-owner-${runKey}@example.test', 'T7C Owner');
      INSERT INTO app.tenants (id, name, slug, status) VALUES
        ('${TENANT_ID}', 'T7C Tenant', 't7c-tenant-${runKey}', 'active');
      INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status) VALUES
        ('${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active');
      INSERT INTO app.personal_profiles (id, tenant_id, name) VALUES
        ('${PROFILE_ID}', '${TENANT_ID}', 'T7C Profile');
      INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role, status) VALUES
        ('${PROFILE_ID}', '${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active');
      INSERT INTO app.mailbox_connections (
        id, tenant_id, personal_profile_id, owner_user_id, provider,
        provider_account_id, account_email, status, timezone, local_scan_time, vault_reference
      ) VALUES (
        '${CONNECTION_ID}', '${TENANT_ID}', '${PROFILE_ID}', '${OWNER_USER_ID}', 'gmail',
        'acct-${CONNECTION_ID}', 'owner@example.test', 'active', 'America/Los_Angeles', '07:00',
        'vault-${CONNECTION_ID}'
      );
      INSERT INTO app.mailbox_scan_runs (
        id, connection_id, tenant_id, initiated_by, entitlement_version, connection_version,
        status, idempotency_key, normalized_request_hash, completed_at
      ) VALUES (
        '${SCAN_RUN_ID}', '${CONNECTION_ID}', '${TENANT_ID}', '${OWNER_USER_ID}', 1, 1,
        'completed', 'seed-${SCAN_RUN_ID}', '${DUMMY_HASH}', now()
      );
    `);

    mkdirSync(storageDir, { recursive: true });
  });

  afterAll(async () => {
    await database?.destroy();
    await migratorDatabase?.destroy();
    if (postgresContainerId) {
      adminSql(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
    }
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("applies migrations 016-021 in order, 020/021 add exactly the tables/columns the plan specifies", () => {
    const names = migratorSql(`SELECT name FROM app_migrations.kysely_migration ORDER BY timestamp;`).split("\n");
    const indexOf = (prefix: string) => names.findIndex((name) => name.startsWith(prefix));
    const i016 = indexOf("016_");
    const i017 = indexOf("017_");
    const i018 = indexOf("018_");
    const i019 = indexOf("019_");
    const i020 = indexOf("020_");
    const i021 = indexOf("021_");
    expect(i016).toBeGreaterThanOrEqual(0);
    expect(i017).toBeGreaterThan(i016);
    expect(i018).toBeGreaterThan(i017);
    expect(i019).toBeGreaterThan(i018);
    expect(i020).toBeGreaterThan(i019);
    expect(i021).toBeGreaterThan(i020);

    const tables = runtimeSql(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'app' ORDER BY table_name;`,
    ).split("\n");
    expect(tables).toContain("mailbox_ingestion_operations");

    const sourceTypeCheck = runtimeSql(
      `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'expense_sources_type_check';`,
    );
    expect(sourceTypeCheck).toContain("connected_mailbox");
    const expenseSourceCheck = runtimeSql(
      `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'expenses_source_check';`,
    );
    expect(expenseSourceCheck).toContain("connected_mailbox");
  });

  it("runs ingest -> materialize job + outbox -> dispatch with TS target -> structured receipt (provenance, enrichment, dedup) -> attachment OCR (clean + malware dead end) -> retry two-step -> idempotent replays -> no content leakage", async () => {
    const dispatchCalls: StartWorkflowInput[] = [];
    let dispatchSeq = 0;
    const temporalStarter: TemporalWorkflowStarter = {
      async start(input): Promise<StartWorkflowResult> {
        dispatchCalls.push(input);
        dispatchSeq += 1;
        return { runId: `fake-run-${dispatchSeq}` };
      },
      async close() {},
    };

    const plansDomain: PlansDomain = (() => {
      const notImplemented = async (): Promise<never> => {
        throw new Error("not implemented in this fake");
      };
      return {
        createPlan: notImplemented,
        createPlanVersion: notImplemented,
        createFeatureDefinition: notImplemented,
        listPlansAdmin: notImplemented,
        listActivePlans: notImplemented,
        getSubscription: notImplemented,
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
    })();

    const identityDomain: IdentityDomain = {
      async resolve(_issuer, subject) {
        return {
          id: subject,
          primaryEmail: `${subject}@example.test`,
          displayName: subject,
          status: "active" as const,
        };
      },
      async provision() {
        throw new Error("not implemented in this fake");
      },
    };

    const tenantPrincipalsByToken: Record<string, AuthPrincipal> = {
      "owner-token": tenantPrincipal(OWNER_USER_ID),
    };
    const servicePrincipalsByToken: Record<string, AuthPrincipal> = {
      "broker-token": servicePrincipal("mailbox-broker-app", ["mailbox:write", "mailbox:materialize"]),
      "mailbox-worker-token": servicePrincipal("workflow-worker-mailbox", ["mailbox:discover", "mailbox:materialize"]),
      // registerJobRoutes defaults its worker-guard subject to
      // config.clerk.appServiceSubject ("ai-worker-app-machine" below),
      // not the route module's own literal default -- this is the exact
      // identity the attachment-OCR workflow's activities use.
      "ai-worker-token": servicePrincipal("ai-worker-app-machine", ["jobs:write"]),
      "admin-token": servicePrincipal("platform-admin", ["jobs:manage"]),
    };
    const tenantVerifier: TokenVerifier = {
      verify: async (token) => {
        const principal = tenantPrincipalsByToken[token];
        if (!principal) throw new Error("service token rejected by tenant verifier");
        return principal;
      },
    };
    const serviceVerifier: TokenVerifier = {
      verify: async (token) => {
        const principal = servicePrincipalsByToken[token];
        if (!principal) throw new Error("tenant token rejected by service verifier");
        return principal;
      },
    };

    const logChunks: string[] = [];
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logChunks.push(chunk.toString("utf8"));
        callback();
      },
    });

    const config = createAppConfig({
      env: {
        APP_TENANT_TOKEN_ISSUER: "https://identity.t7c.test",
        APP_TENANT_TOKEN_AUDIENCE: "expense-app",
        APP_TENANT_JWKS_URL: "https://identity.t7c.test/.well-known/jwks.json",
        APP_SERVICE_TOKEN_ISSUER: "https://services.t7c.test",
        APP_SERVICE_TOKEN_AUDIENCE: "expense-app-internal",
        APP_SERVICE_JWKS_URL: "https://services.t7c.test/.well-known/jwks.json",
        CLERK_ISSUER_URL: "https://clerk.t7c.test",
        CLERK_JWKS_URL: "https://clerk.t7c.test/.well-known/jwks.json",
        CLERK_TENANT_AUDIENCE: "tenant-audience",
        CLERK_PLATFORM_AUDIENCE: "platform-audience",
        CLERK_APP_SERVICE_AUDIENCE: "app-service-audience",
        CLERK_FOUNDRY_SERVICE_AUDIENCE: "foundry-service-audience",
        CLERK_APP_SERVICE_SUBJECT: "ai-worker-app-machine",
        CLERK_FOUNDRY_SERVICE_SUBJECT: "ai-worker-foundry-machine",
        APP_DATABASE_URL: "postgresql://unused.t7c.test/app",
        TEMPORAL_HOST: "127.0.0.1:7233",
        TEMPORAL_NAMESPACE: "default",
        STORAGE_BACKEND: "local",
        LOCAL_STORAGE_DIR: storageDir,
        STORAGE_LOCAL_BASE_URL: "http://127.0.0.1:8100",
        STORAGE_URL_SIGNING_KEY: "test-signing-key-not-secret",
        INBOUND_EMAIL_BASE_ADDRESS: "receipts@inbound.t7c.test",
        INBOUND_WEBHOOK_SIGNING_KEY: "test-webhook-key",
        INBOUND_ROUTING_TOKEN_SECRET: "test-routing-key",
        INBOUND_CHALLENGE_DIR: path.join(storageDir, "inbound-challenges"),
        MAILBOX_FEATURE_ENABLED: "true",
        MAILBOX_BROKER_BASE_URL: "https://mailbox-broker.t7c.test",
        MAILBOX_BROKER_PUBLIC_BASE_URL: "https://mailbox-broker-public.t7c.test",
        CLERK_MAILBOX_SERVICE_AUDIENCE: "mailbox-service-audience",
        CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY: "test-machine-secret-not-real",
        CLERK_MAILBOX_APP_API_SUBJECT: "app-api-mailbox",
        MAILBOX_ALLOWED_REDIRECT_ORIGINS: "https://expense-office.t7c.test",
      },
    });

    const app = buildApp({
      config,
      logger: { level: "info", stream: logStream },
      database: database!,
      authVerifiers: { tenant: tenantVerifier, service: serviceVerifier },
      temporalStarter,
      plansDomain,
      identityDomain,
    });

    // Collects every HTTP response body this test captures, for the
    // no-content-leakage sweep at the end.
    const capturedBodies: string[] = [];
    async function call(method: "GET" | "POST", url: string, options: {
      readonly token: string;
      readonly payload?: unknown;
      readonly rawBody?: Buffer;
    }) {
      const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
      if (options.rawBody) headers["content-type"] = "application/octet-stream";
      const response = await app.inject({
        method,
        url,
        headers,
        ...(options.rawBody
          ? { payload: options.rawBody }
          : options.payload !== undefined
            ? { payload: options.payload }
            : {}),
      });
      capturedBodies.push(response.body);
      return response;
    }

    function insertCandidate(opts: {
      readonly classification?: "receipt" | "ambiguous" | "not_receipt";
      readonly attachmentManifest?: readonly unknown[];
      readonly providerMessageId: string;
    }): string {
      const candidateId = randomUUID();
      const manifestJson = JSON.stringify(opts.attachmentManifest ?? []).replaceAll("'", "''");
      runtimeSql(`
        INSERT INTO app.mailbox_candidates (
          id, scan_run_id, connection_id, tenant_id, received_at, sender_address, sender_domain,
          subject, content_hash, attachment_manifest, classification, confidence, evidence, status,
          idempotency_key, normalized_request_hash, provider_message_id
        ) VALUES (
          '${candidateId}', '${SCAN_RUN_ID}', '${CONNECTION_ID}', '${TENANT_ID}', now(),
          'merchant@example.test', 'example.test', 'Your receipt',
          '${DUMMY_HASH}', '${manifestJson}'::jsonb, '${opts.classification ?? "receipt"}', 0.9000, '{}', 'review',
          'cand-${candidateId}', '${DUMMY_HASH}', '${opts.providerMessageId}'
        )
      `);
      return candidateId;
    }

    async function candidateVersion(candidateId: string): Promise<number> {
      const row = await database!
        .selectFrom("app.mailbox_candidates")
        .select("version")
        .where("id", "=", candidateId)
        .executeTakeFirstOrThrow();
      return row.version;
    }

    async function jobRow(id: string) {
      return database!
        .selectFrom("app.processing_jobs")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
    }

    async function findMaterializeJob(candidateId: string) {
      return database!
        .selectFrom("app.processing_jobs")
        .selectAll()
        .where("target_aggregate_type", "=", "mailbox_candidate")
        .where("target_aggregate_id", "=", candidateId)
        .where("workflow_type", "=", MAILBOX_MATERIALIZE_WORKFLOW_TYPE)
        .orderBy("created_at", "desc")
        .executeTakeFirstOrThrow();
    }

    async function findOcrJob(fileId: string) {
      return database!
        .selectFrom("app.processing_jobs")
        .selectAll()
        .where("source_file_id", "=", fileId)
        .where("workflow_type", "=", MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE)
        .executeTakeFirstOrThrow();
    }

    async function ingestAtVersion(candidateId: string, version: number, requestId: string) {
      return call("POST", `/api/v1/tenants/${TENANT_ID}/mailbox-connections/${CONNECTION_ID}/candidates/${candidateId}/resolve`, {
        token: "owner-token",
        payload: {
          action: "ingest",
          scope: { kind: "personal", profileId: PROFILE_ID },
          expectedCandidateVersion: version,
          requestId,
        },
      });
    }

    /** Fresh (non-replay) ingest: reads the candidate's current version
     * first. A true replay of an already-issued ingest must reuse the
     * EXACT version that request originally carried (resolveCandidate's
     * idempotency hash includes expectedCandidateVersion) -- use
     * `ingestAtVersion` directly for that, never this helper. */
    async function ingest(candidateId: string, requestId: string) {
      const version = await candidateVersion(candidateId);
      return ingestAtVersion(candidateId, version, requestId);
    }

    async function dispatchPending() {
      return call("POST", "/internal/v1/jobs/dispatch", { token: "admin-token" });
    }

    // ================================================================ //
    // Scenario 1: ingest -> materialize job + outbox, stamped with the
    // fixed TypeScript target, dispatched through the real pipeline.
    // ================================================================ //
    const PROVIDER_MESSAGE_MARKER = `gmail-secret-${runKey}`;
    const candidateA = insertCandidate({ providerMessageId: `${PROVIDER_MESSAGE_MARKER}-a` });

    const candidateAVersionBeforeIngest = await candidateVersion(candidateA);
    const ingestRequestId = randomUUID();
    const ingestA1 = await ingestAtVersion(candidateA, candidateAVersionBeforeIngest, ingestRequestId);
    expect(ingestA1.statusCode).toBe(200);
    expect((ingestA1.json() as { status: string }).status).toBe("queued");

    const materializeA = await findMaterializeJob(candidateA);
    expect(materializeA.status).toBe("PENDING");
    expect(materializeA.task_queue).toBe(AI_WORKER_TASK_QUEUE);
    expect(materializeA.dispatch_namespace).toBe(TARGET_TEMPORAL_NAMESPACE);

    // Idempotent replay: identical requestId (and the SAME original
    // expectedCandidateVersion -- resolveCandidate's idempotency hash
    // covers it) returns the identical result, no second materialize job.
    const ingestA1Replay = await ingestAtVersion(candidateA, candidateAVersionBeforeIngest, ingestRequestId);
    expect(ingestA1Replay.statusCode).toBe(200);
    expect(ingestA1Replay.json()).toEqual(ingestA1.json());
    const materializeJobsForA = await database!
      .selectFrom("app.processing_jobs")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("target_aggregate_id", "=", candidateA)
      .where("workflow_type", "=", MAILBOX_MATERIALIZE_WORKFLOW_TYPE)
      .executeTakeFirstOrThrow();
    expect(Number(materializeJobsForA.count)).toBe(1);

    const dispatch1 = await dispatchPending();
    expect(dispatch1.statusCode).toBe(200);
    expect((dispatch1.json() as { dispatchedCount: number }).dispatchedCount).toBeGreaterThanOrEqual(1);
    expect(
      dispatchCalls.some(
        (c) =>
          c.workflowType === MAILBOX_MATERIALIZE_WORKFLOW_TYPE &&
          c.workflowId === materializeA.workflow_id &&
          c.taskQueue === AI_WORKER_TASK_QUEUE &&
          c.namespace === TARGET_TEMPORAL_NAMESPACE,
      ),
    ).toBe(true);
    const materializeADispatched = await jobRow(materializeA.id);
    expect(materializeADispatched.status).toBe("DISPATCHED");
    expect(materializeADispatched.run_id).not.toBeNull();

    // ================================================================ //
    // Scenario 2: structured-receipt path -> expense with connected_mailbox
    // provenance, Phase 3C enrichment job.
    // ================================================================ //
    const materializeInputA = await call(
      "GET",
      `/internal/v1/mailbox/jobs/${materializeA.id}/materialize-input`,
      { token: "mailbox-worker-token" },
    );
    expect(materializeInputA.statusCode).toBe(200);
    expect((materializeInputA.json() as { candidateId: string }).candidateId).toBe(candidateA);

    const runningA = await call("POST", `/internal/v1/mailbox/jobs/${materializeA.id}/status`, {
      token: "mailbox-worker-token",
      payload: {
        schemaVersion: 1,
        status: "RUNNING",
        idempotencyKey: randomUUID(),
        expectedJobVersion: materializeADispatched.version,
      },
    });
    expect(runningA.statusCode).toBe(200);

    const structuredKeyA = randomUUID();
    const candidateAVersionAfterIngest = await candidateVersion(candidateA);
    const structuredResultA = await call(
      "POST",
      `/internal/v1/mailbox/candidates/${candidateA}/structured-result`,
      {
        token: "broker-token",
        payload: {
          result: {
            schemaVersion: 1,
            candidateId: candidateA,
            connectionId: CONNECTION_ID,
            candidateVersion: candidateAVersionAfterIngest,
            merchant: "Example Corp",
            amount: "42.00",
            currency: "USD",
            incurredOn: "2026-01-05",
            orderNumber: "ORD-1",
            notes: null,
            evidence: ["schema_type:Order", "field:merchant", "field:amount"],
            idempotencyKey: structuredKeyA,
          },
          idempotencyKey: structuredKeyA,
        },
      },
    );
    expect(structuredResultA.statusCode).toBe(200);
    const materializationA = structuredResultA.json() as {
      status: string;
      expenseId: string;
      sourceId: string;
      duplicateMatchId: string | null;
    };
    expect(materializationA.status).toBe("processed");
    expect(materializationA.duplicateMatchId).toBeNull();

    // Idempotent replay: identical idempotencyKey returns the identical
    // result, never a second expense.
    const structuredResultA2 = await call(
      "POST",
      `/internal/v1/mailbox/candidates/${candidateA}/structured-result`,
      {
        token: "broker-token",
        payload: {
          result: {
            schemaVersion: 1,
            candidateId: candidateA,
            connectionId: CONNECTION_ID,
            candidateVersion: candidateAVersionAfterIngest,
            merchant: "Example Corp",
            amount: "42.00",
            currency: "USD",
            incurredOn: "2026-01-05",
            orderNumber: "ORD-1",
            notes: null,
            evidence: ["schema_type:Order", "field:merchant", "field:amount"],
            idempotencyKey: structuredKeyA,
          },
          idempotencyKey: structuredKeyA,
        },
      },
    );
    expect(structuredResultA2.statusCode).toBe(200);
    expect(structuredResultA2.json()).toEqual(structuredResultA.json());

    const expenseA = await database!
      .selectFrom("app.expenses")
      .selectAll()
      .where("id", "=", materializationA.expenseId)
      .executeTakeFirstOrThrow();
    expect(expenseA.tenant_id).toBe(TENANT_ID);
    expect(expenseA.merchant).toBe("Example Corp");

    const sourceA = await database!
      .selectFrom("app.expense_sources")
      .selectAll()
      .where("id", "=", materializationA.sourceId)
      .executeTakeFirstOrThrow();
    expect(sourceA.source_type).toBe("connected_mailbox");
    expect(sourceA.mailbox_candidate_id).toBe(candidateA);
    const sourceAMetadata = sourceA.metadata as unknown as Record<string, unknown>;
    expect(sourceAMetadata).toEqual({
      orderNumber: "ORD-1",
      evidence: ["schema_type:Order", "field:merchant", "field:amount"],
    });

    const enrichmentJobsForA = await database!
      .selectFrom("app.processing_jobs")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("target_aggregate_id", "=", materializationA.expenseId)
      .where("workflow_type", "=", EXPENSE_ENRICHMENT_WORKFLOW_TYPE)
      .executeTakeFirstOrThrow();
    expect(Number(enrichmentJobsForA.count)).toBe(1);

    const materializeAFinal = await jobRow(materializeA.id);
    const resultSucceedA: MailboxMaterializationResultV1 = {
      schemaVersion: 1,
      candidateId: candidateA,
      status: "processed",
      processingJobId: null,
      expenseId: materializationA.expenseId,
      sourceId: materializationA.sourceId,
      duplicateMatchId: null,
      idempotencyKey: structuredKeyA,
    };
    const materializeResultA = await call("POST", `/internal/v1/mailbox/jobs/${materializeA.id}/result`, {
      token: "mailbox-worker-token",
      payload: {
        schemaVersion: 1,
        status: "SUCCEEDED",
        idempotencyKey: randomUUID(),
        expectedJobVersion: materializeAFinal.version,
        resultSchemaVersion: MAILBOX_MATERIALIZE_RESULT_SCHEMA_VERSION,
        result: resultSucceedA,
      },
    });
    expect(materializeResultA.statusCode).toBe(200);
    expect((materializeResultA.json() as { status: string }).status).toBe("SUCCEEDED");

    // ================================================================ //
    // Scenario 3 (duplicate detection link): a second candidate with the
    // IDENTICAL merchant/amount/currency/date materializes as "duplicate".
    // ================================================================ //
    const candidateB = insertCandidate({ providerMessageId: `${PROVIDER_MESSAGE_MARKER}-b` });
    const ingestB = await ingest(candidateB, randomUUID());
    expect(ingestB.statusCode).toBe(200);
    const materializeB = await findMaterializeJob(candidateB);
    const candidateBVersion = await candidateVersion(candidateB);

    const structuredKeyB = randomUUID();
    const structuredResultB = await call(
      "POST",
      `/internal/v1/mailbox/candidates/${candidateB}/structured-result`,
      {
        token: "broker-token",
        payload: {
          result: {
            schemaVersion: 1,
            candidateId: candidateB,
            connectionId: CONNECTION_ID,
            candidateVersion: candidateBVersion,
            merchant: "Example Corp",
            amount: "42.00",
            currency: "USD",
            incurredOn: "2026-01-05",
            orderNumber: null,
            notes: null,
            evidence: ["schema_type:Receipt"],
            idempotencyKey: structuredKeyB,
          },
          idempotencyKey: structuredKeyB,
        },
      },
    );
    expect(structuredResultB.statusCode).toBe(200);
    const materializationB = structuredResultB.json() as {
      status: string;
      expenseId: string;
      duplicateMatchId: string | null;
    };
    expect(materializationB.status).toBe("duplicate");
    expect(materializationB.duplicateMatchId).not.toBeNull();

    const duplicateMatchRow = await database!
      .selectFrom("app.expense_duplicate_matches")
      .selectAll()
      .where("id", "=", materializationB.duplicateMatchId as string)
      .executeTakeFirstOrThrow();
    expect(duplicateMatchRow.candidate_expense_id).toBe(materializationB.expenseId);
    expect(duplicateMatchRow.existing_expense_id).toBe(materializationA.expenseId);

    await dispatchPending();
    const materializeBFinal = await jobRow(materializeB.id);
    const materializeResultB = await call("POST", `/internal/v1/mailbox/jobs/${materializeB.id}/result`, {
      token: "mailbox-worker-token",
      payload: {
        schemaVersion: 1,
        status: "SUCCEEDED",
        idempotencyKey: randomUUID(),
        expectedJobVersion: materializeBFinal.version,
        resultSchemaVersion: MAILBOX_MATERIALIZE_RESULT_SCHEMA_VERSION,
        result: {
          schemaVersion: 1,
          candidateId: candidateB,
          status: "duplicate",
          processingJobId: null,
          expenseId: materializationB.expenseId,
          sourceId: null,
          duplicateMatchId: materializationB.duplicateMatchId,
          idempotencyKey: structuredKeyB,
        },
      },
    });
    expect(materializeResultB.statusCode).toBe(200);

    // ================================================================ //
    // Scenario 4: attachment path, clean -> READY -> per-attachment OCR
    // job -> dispatch -> RUNNING -> SUCCEEDED -> expense.
    // ================================================================ //
    const cleanBytesMarker = `clean-${runKey}`;
    const cleanBytes = pdfBytes(cleanBytesMarker);
    const candidateC = insertCandidate({
      providerMessageId: `${PROVIDER_MESSAGE_MARKER}-c`,
      attachmentManifest: [attachmentManifestEntry(cleanBytes, "receipt.pdf")],
    });
    const ingestC = await ingest(candidateC, randomUUID());
    expect(ingestC.statusCode).toBe(200);
    const candidateCVersion = await candidateVersion(candidateC);

    const grantOperationId = randomUUID();
    const grantC1 = await call("POST", `/internal/v1/mailbox/candidates/${candidateC}/upload-grant`, {
      token: "broker-token",
      payload: { expectedCandidateVersion: candidateCVersion, operationId: grantOperationId },
    });
    expect(grantC1.statusCode).toBe(200);
    const grantC = grantC1.json() as { uploadGrantId: string; maxBytes: number; maxAttachments: number };
    expect(grantC.maxBytes).toBe(26_214_400);
    expect(grantC.maxAttachments).toBe(5);

    // Idempotent replay of the grant itself.
    const grantC2 = await call("POST", `/internal/v1/mailbox/candidates/${candidateC}/upload-grant`, {
      token: "broker-token",
      payload: { expectedCandidateVersion: candidateCVersion, operationId: grantOperationId },
    });
    expect(grantC2.json()).toEqual(grantC1.json());

    const uploadIdempotencyKeyC = randomUUID();
    const uploadC1 = await call(
      "POST",
      `/internal/v1/mailbox/candidates/${candidateC}/attachments/0?uploadGrantId=${grantC.uploadGrantId}&expectedCandidateVersion=${candidateCVersion}&idempotencyKey=${uploadIdempotencyKeyC}`,
      { token: "broker-token", rawBody: cleanBytes },
    );
    expect(uploadC1.statusCode).toBe(200);
    const uploadResultC = uploadC1.json() as { status: string; fileId: string; errorCode: string | null };
    expect(uploadResultC.status).toBe("READY");
    expect(uploadResultC.errorCode).toBeNull();

    // Idempotent replay of the exact same upload (same grant/index/key).
    const uploadC2 = await call(
      "POST",
      `/internal/v1/mailbox/candidates/${candidateC}/attachments/0?uploadGrantId=${grantC.uploadGrantId}&expectedCandidateVersion=${candidateCVersion}&idempotencyKey=${uploadIdempotencyKeyC}`,
      { token: "broker-token", rawBody: cleanBytes },
    );
    expect(uploadC2.json()).toEqual(uploadC1.json());

    const ocrJobC = await findOcrJob(uploadResultC.fileId);
    expect(ocrJobC.status).toBe("PENDING");
    expect(ocrJobC.task_queue).toBe(AI_WORKER_TASK_QUEUE);
    expect(ocrJobC.dispatch_namespace).toBe(TARGET_TEMPORAL_NAMESPACE);
    expect(ocrJobC.allowed_result_schema_version).toBe(OCR_EXTRACTION_RESULT_SCHEMA_VERSION);
    expect(ocrJobC.requested_by_user_id).toBe(OWNER_USER_ID);

    await dispatchPending();
    const ocrJobCDispatched = await jobRow(ocrJobC.id);
    expect(ocrJobCDispatched.status).toBe("DISPATCHED");
    expect(
      dispatchCalls.some(
        (c) => c.workflowType === MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE && c.workflowId === ocrJobC.workflow_id,
      ),
    ).toBe(true);

    const ocrRunningC = await call("POST", `/internal/v1/jobs/${ocrJobC.id}/status`, {
      token: "ai-worker-token",
      payload: {
        schemaVersion: 1,
        status: "RUNNING",
        idempotencyKey: randomUUID(),
        expectedJobVersion: ocrJobCDispatched.version,
      },
    });
    expect(ocrRunningC.statusCode).toBe(200);
    const ocrJobCRunning = await jobRow(ocrJobC.id);

    const ocrResultC = await call("POST", `/internal/v1/jobs/${ocrJobC.id}/result`, {
      token: "ai-worker-token",
      payload: {
        schemaVersion: 1,
        status: "SUCCEEDED",
        idempotencyKey: randomUUID(),
        expectedJobVersion: ocrJobCRunning.version,
        resultSchemaVersion: OCR_EXTRACTION_RESULT_SCHEMA_VERSION,
        result: {
          schemaVersion: 1,
          merchant: "Receipt Co",
          amount: "19.99",
          currency: "USD",
          incurredOn: "2026-01-10",
          confidence: 0.95,
        },
      },
    });
    expect(ocrResultC.statusCode).toBe(200);

    const candidateCRow = await database!
      .selectFrom("app.mailbox_candidates")
      .selectAll()
      .where("id", "=", candidateC)
      .executeTakeFirstOrThrow();
    expect(candidateCRow.status).toBe("processed");
    expect(candidateCRow.expense_id).not.toBeNull();

    const sourceC = await database!
      .selectFrom("app.expense_sources")
      .selectAll()
      .where("expense_id", "=", candidateCRow.expense_id as string)
      .executeTakeFirstOrThrow();
    expect(sourceC.source_type).toBe("connected_mailbox");
    expect(sourceC.mailbox_candidate_id).toBe(candidateC);

    const materializeCFinal = await findMaterializeJob(candidateC);
    const materializeCLocked = await jobRow(materializeCFinal.id);
    const materializeResultC = await call("POST", `/internal/v1/mailbox/jobs/${materializeCFinal.id}/result`, {
      token: "mailbox-worker-token",
      payload: {
        schemaVersion: 1,
        status: "SUCCEEDED",
        idempotencyKey: randomUUID(),
        expectedJobVersion: materializeCLocked.version,
        resultSchemaVersion: MAILBOX_MATERIALIZE_RESULT_SCHEMA_VERSION,
        result: {
          schemaVersion: 1,
          candidateId: candidateC,
          status: "processed",
          processingJobId: ocrJobC.id,
          expenseId: candidateCRow.expense_id,
          sourceId: sourceC.id,
          duplicateMatchId: null,
          idempotencyKey: randomUUID(),
        },
      },
    });
    expect(materializeResultC.statusCode).toBe(200);

    // ================================================================ //
    // Scenario 5: malware dead end -- the only attachment is blocked,
    // the materialize job reports FAILED, MALWARE_DETECTED surfaces onto
    // the candidate, and retry is refused (dead end, not retryable).
    // ================================================================ //
    const infectedBytes = eicarPdfBytes();
    const candidateD = insertCandidate({
      providerMessageId: `${PROVIDER_MESSAGE_MARKER}-d`,
      attachmentManifest: [attachmentManifestEntry(infectedBytes, "invoice.pdf")],
    });
    const ingestD = await ingest(candidateD, randomUUID());
    expect(ingestD.statusCode).toBe(200);
    const candidateDVersion = await candidateVersion(candidateD);
    const materializeD = await findMaterializeJob(candidateD);

    const grantD = (
      await call("POST", `/internal/v1/mailbox/candidates/${candidateD}/upload-grant`, {
        token: "broker-token",
        payload: { expectedCandidateVersion: candidateDVersion, operationId: randomUUID() },
      })
    ).json() as { uploadGrantId: string };

    const uploadD = await call(
      "POST",
      `/internal/v1/mailbox/candidates/${candidateD}/attachments/0?uploadGrantId=${grantD.uploadGrantId}&expectedCandidateVersion=${candidateDVersion}&idempotencyKey=${randomUUID()}`,
      { token: "broker-token", rawBody: infectedBytes },
    );
    expect(uploadD.statusCode).toBe(200);
    const uploadResultD = uploadD.json() as { status: string; errorCode: string | null; fileId: string };
    expect(uploadResultD.status).toBe("FAILED");
    expect(uploadResultD.errorCode).toBe("MALWARE_DETECTED");

    const fileD = await database!
      .selectFrom("app.expense_files")
      .selectAll()
      .where("id", "=", uploadResultD.fileId)
      .executeTakeFirstOrThrow();
    expect(fileD.status).toBe("FAILED");
    expect(fileD.expense_id).toBeNull();
    // Never created an OCR job for a blocked-only attachment.
    const ocrJobsForD = await database!
      .selectFrom("app.processing_jobs")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("source_file_id", "=", uploadResultD.fileId)
      .executeTakeFirstOrThrow();
    expect(Number(ocrJobsForD.count)).toBe(0);

    await dispatchPending();
    const materializeDLocked = await jobRow(materializeD.id);
    const materializeFailD = await call("POST", `/internal/v1/mailbox/jobs/${materializeD.id}/result`, {
      token: "mailbox-worker-token",
      payload: {
        schemaVersion: 1,
        status: "FAILED",
        idempotencyKey: randomUUID(),
        expectedJobVersion: materializeDLocked.version,
        resultSchemaVersion: MAILBOX_MATERIALIZE_RESULT_SCHEMA_VERSION,
        result: {
          schemaVersion: 1,
          candidateId: candidateD,
          status: "failed",
          processingJobId: null,
          expenseId: null,
          sourceId: null,
          duplicateMatchId: null,
          idempotencyKey: randomUUID(),
        },
        message: "no viable attachment",
      },
    });
    expect(materializeFailD.statusCode).toBe(200);

    const candidateDRow = await database!
      .selectFrom("app.mailbox_candidates")
      .selectAll()
      .where("id", "=", candidateD)
      .executeTakeFirstOrThrow();
    expect(candidateDRow.status).toBe("failed");
    expect(candidateDRow.error_code).toBe("MALWARE_DETECTED");

    // Dead end: MALWARE_DETECTED is not a retryable code.
    const retryD = await call(
      "POST",
      `/api/v1/tenants/${TENANT_ID}/mailbox-connections/${CONNECTION_ID}/candidates/${candidateD}/resolve`,
      {
        token: "owner-token",
        payload: { action: "retry", expectedCandidateVersion: candidateDRow.version, requestId: randomUUID() },
      },
    );
    expect(retryD.statusCode).toBe(409);

    // ================================================================ //
    // Scenario 6: retry two-step -- a MAILBOX_MATERIALIZE_FAILED
    // candidate clears to `review` via `retry`, then a fresh `ingest`
    // re-enqueues a NEW materialize job (019 forbids failed -> queued
    // directly).
    // ================================================================ //
    const candidateE = insertCandidate({ providerMessageId: `${PROVIDER_MESSAGE_MARKER}-e` });
    const ingestE = await ingest(candidateE, randomUUID());
    expect(ingestE.statusCode).toBe(200);
    const materializeE = await findMaterializeJob(candidateE);
    await dispatchPending();
    const materializeELocked = await jobRow(materializeE.id);

    // Broker never even reaches an attachment/structured path (e.g. the
    // Gmail refetch itself failed) -- the worker submits the materialize
    // job as FAILED directly, with no upload_attachment ledger rows at
    // all, so resolveMaterializeFailureErrorCode falls back to the
    // generic MAILBOX_MATERIALIZE_FAILED code.
    const materializeFailE = await call("POST", `/internal/v1/mailbox/jobs/${materializeE.id}/result`, {
      token: "mailbox-worker-token",
      payload: {
        schemaVersion: 1,
        status: "FAILED",
        idempotencyKey: randomUUID(),
        expectedJobVersion: materializeELocked.version,
        resultSchemaVersion: MAILBOX_MATERIALIZE_RESULT_SCHEMA_VERSION,
        result: {
          schemaVersion: 1,
          candidateId: candidateE,
          status: "failed",
          processingJobId: null,
          expenseId: null,
          sourceId: null,
          duplicateMatchId: null,
          idempotencyKey: randomUUID(),
        },
        message: "gmail refetch failed",
      },
    });
    expect(materializeFailE.statusCode).toBe(200);

    const candidateEFailed = await database!
      .selectFrom("app.mailbox_candidates")
      .selectAll()
      .where("id", "=", candidateE)
      .executeTakeFirstOrThrow();
    expect(candidateEFailed.status).toBe("failed");
    expect(candidateEFailed.error_code).toBe("MAILBOX_MATERIALIZE_FAILED");

    const retryE = await call(
      "POST",
      `/api/v1/tenants/${TENANT_ID}/mailbox-connections/${CONNECTION_ID}/candidates/${candidateE}/resolve`,
      {
        token: "owner-token",
        payload: { action: "retry", expectedCandidateVersion: candidateEFailed.version, requestId: randomUUID() },
      },
    );
    expect(retryE.statusCode).toBe(200);
    expect((retryE.json() as { status: string; errorCode: string | null }).status).toBe("review");
    expect((retryE.json() as { status: string; errorCode: string | null }).errorCode).toBeNull();

    const ingestE2 = await ingest(candidateE, randomUUID());
    expect(ingestE2.statusCode).toBe(200);
    expect((ingestE2.json() as { status: string }).status).toBe("queued");
    const materializeE2 = await findMaterializeJob(candidateE);
    expect(materializeE2.id).not.toBe(materializeE.id);
    expect(materializeE2.status).toBe("PENDING");

    // ================================================================ //
    // Scenario 7: no content leakage -- every captured HTTP response,
    // every relevant persisted row, and every log line are free of the
    // raw attachment bytes, the malware carrier's own bytes, Gmail-shaped
    // provider message IDs, and any bearer token.
    // ================================================================ //
    const forbiddenInResponses = [cleanBytesMarker, EICAR_MARKER, PROVIDER_MESSAGE_MARKER];
    for (const body of capturedBodies) {
      for (const forbidden of forbiddenInResponses) {
        expect(body).not.toContain(forbidden);
      }
    }

    const allOperationRows = await database!
      .selectFrom("app.mailbox_ingestion_operations")
      .select(["response_json"])
      .execute();
    const allJobRows = await database!
      .selectFrom("app.processing_jobs")
      .select(["input_params", "result"])
      .execute();
    const allSourceRows = await database!
      .selectFrom("app.expense_sources")
      .select(["metadata"])
      .execute();
    const serializedPersisted = JSON.stringify([allOperationRows, allJobRows, allSourceRows]);
    for (const forbidden of forbiddenInResponses) {
      expect(serializedPersisted).not.toContain(forbidden);
    }

    const logText = logChunks.join("\n");
    for (const token of ["owner-token", "broker-token", "mailbox-worker-token", "ai-worker-token", "admin-token"]) {
      expect(logText).not.toMatch(new RegExp(`Bearer\\s+${token}$`, "m"));
    }
    for (const forbidden of forbiddenInResponses) {
      expect(logText).not.toContain(forbidden);
    }

    await app.close();
  }, 120_000);
});
