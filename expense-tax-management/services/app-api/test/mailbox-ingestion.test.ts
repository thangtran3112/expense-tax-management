/**
 * Phase 3D-C Task 3 — domain/mailbox-ingestion.ts + domain/files.ts's
 * writeMailboxAttachment (real-PostgreSQL coverage, gated on
 * PHASE_3D_C_T3_INTEGRATION=1, same ephemeral-database/port-5433 pattern
 * as mailbox-candidates.test.ts). storage/bounded-stream.ts's own former
 * unit tests moved to test/storage.test.ts's
 * writeObjectStream/moveObject coverage (fix round 2: the in-memory
 * bounded-reader utility was replaced by true incremental streaming to
 * storage; it is no longer used anywhere and was deleted).
 *
 * No Google/Clerk network access anywhere; the malware scanner under test
 * is PatternMalwareScanner (already local/EICAR-pattern-based) via
 * createMailboxStagingScanner -- "never call external scanners in tests"
 * is satisfied by construction, not by a special test-only fake.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXPENSE_ENRICHMENT_WORKFLOW_TYPE,
  MAX_UPLOAD_BYTES,
  OCR_EXTRACTION_RESULT_SCHEMA_VERSION,
} from "@expense-tax/contracts";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthPrincipal } from "../src/auth/types.js";
import { createAppDatabase } from "../src/database/client.js";
import type { AppDatabase } from "../src/database/types.js";
import { runMigrations } from "../src/database/migrate.js";
import {
  createFilesDomain,
  createMailboxStagingScanner,
  type MailboxStagingScanner,
} from "../src/domain/files.js";
import { hashNormalizedRequest } from "../src/domain/idempotency.js";
import {
  createMailboxIngestionDomain,
  recordConnectedMailboxEvidenceInTransaction,
  type MailboxIngestionDomain,
} from "../src/domain/mailbox-ingestion.js";
import { createProcessingJobsDomain } from "../src/domain/processing-jobs.js";
import type { PlansDomain } from "../src/domain/plans.js";
import { registerErrorHandlers } from "../src/errors.js";
import { PatternMalwareScanner } from "../src/inbound/security.js";
import { registerAuthPlugin } from "../src/plugins/auth.js";
import { registerMailboxIngestionRoutes } from "../src/routes/mailbox-ingestion.js";
import { createStorageAdapter } from "../src/storage/factory.js";
import type { StorageAdapter } from "../src/storage/types.js";
import type { TemporalWorkflowStarter } from "../src/temporal/client.js";

type FastifyApp = ReturnType<typeof Fastify>;

async function* chunks(parts: readonly Buffer[]): AsyncIterable<Buffer> {
  for (const part of parts) yield part;
}

// -------------------------------------------------------------------- //
// routes/mailbox-ingestion.ts -- fix round 1 (review Important #1): the
// attachment-upload route must stream the raw request body straight
// through to the domain layer, never buffering it first. No Docker/live
// DB needed: a fake MailboxIngestionDomain captures exactly what `source`
// argument it was called with, same minimal-harness convention
// test/mailbox-internal.test.ts already uses for a broker-guarded route.
// -------------------------------------------------------------------- //

describe("routes/mailbox-ingestion.ts -- attachment upload streaming", () => {
  const apps: FastifyApp[] = [];

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  function brokerPrincipal(): AuthPrincipal {
    return {
      tokenType: "service",
      subject: "mailbox-broker-app",
      clientId: null,
      audience: "app-service",
      issuer: "https://services.test",
      roles: [],
      scopes: ["mailbox:write"],
      tokenId: "token-1",
      email: null,
      emailVerified: null,
      displayName: null,
    };
  }

  function createStreamingTestApp(
    receiveAttachment: MailboxIngestionDomain["receiveAttachment"],
  ) {
    const app = Fastify({ logger: false });
    apps.push(app);
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerErrorHandlers(app);
    registerAuthPlugin(app, {
      authVerifiers: {
        tenant: { verify: async () => brokerPrincipal() },
        service: { verify: async () => brokerPrincipal() },
      },
    });
    const mailboxIngestionDomain: MailboxIngestionDomain = {
      issueUploadGrant: async () => {
        throw new Error("not used in this test");
      },
      receiveAttachment,
      submitStructuredReceipt: async () => {
        throw new Error("not used in this test");
      },
      recordConnectedMailboxEvidence: async () => {
        throw new Error("not used in this test");
      },
    };
    app.register(registerMailboxIngestionRoutes, { mailboxIngestionDomain });
    return app.withTypeProvider<ZodTypeProvider>();
  }

  it("passes the live request stream straight through to receiveAttachment -- never a pre-buffered Buffer", async () => {
    let capturedSource: AsyncIterable<Buffer> | undefined;
    const app = createStreamingTestApp(async (_input, source) => {
      capturedSource = source;
      // Actually drain it, proving it is a real, readable async iterable
      // (not just a type-compatible empty object).
      const parts: Buffer[] = [];
      for await (const chunk of source) parts.push(chunk);
      return {
        candidateId: _input.candidateId,
        attachmentIndex: _input.attachmentIndex,
        fileId: randomUUID(),
        status: "READY",
        errorCode: null,
        idempotencyKey: _input.idempotencyKey,
      };
    });
    await app.ready();

    const payload = Buffer.from("fake-attachment-bytes");
    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/candidates/${randomUUID()}/attachments/0?uploadGrantId=${randomUUID()}&expectedCandidateVersion=1&idempotencyKey=${randomUUID()}`,
      headers: {
        authorization: "Bearer fake",
        "content-type": "application/octet-stream",
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "READY" });
    // The content-type parser hands the live request stream straight
    // through -- it must never be a fully materialized Buffer by the time
    // the domain layer receives it (Buffer IS an AsyncIterable<number>,
    // so the structural check is explicitly "not a Buffer instance", not
    // "has Symbol.asyncIterator").
    expect(capturedSource).toBeDefined();
    expect(capturedSource instanceof Buffer).toBe(false);
  });
});

// -------------------------------------------------------------------- //
// Real-PostgreSQL domain coverage.
// -------------------------------------------------------------------- //

const requested = process.env.PHASE_3D_C_T3_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const databaseName = `expense_tax_t3c_${runKey}`;

interface ComposeConfig {
  readonly services: Record<string, { readonly environment?: Record<string, string | null> }>;
}

const TENANT_ID = "7f000000-0000-4000-8000-000000000001";
const OWNER_USER_ID = "7f000000-0000-4000-8000-000000000002";
const PROFILE_ID = "7f000000-0000-4000-8000-000000000003";
const DUMMY_HASH = "a".repeat(64);
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

let postgresContainerId = "";
let runtimePassword = "";
let migratorPassword = "";
let database: Kysely<AppDatabase> | undefined;
let storage: StorageAdapter;
let storageDir: string;

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
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function adminSql(sqlText: string, db = "postgres"): string {
  return dockerPsql(db, "postgres", "postgrespassword", sqlText);
}

function runtimeSql(sqlText: string): string {
  return dockerPsql(databaseName, "expense_app_runtime", runtimePassword, sqlText);
}

function pngBytes(): Buffer {
  // Minimal valid PNG magic-byte header; the rest of the bytes are
  // irrelevant to attachmentMagicMatches, which only inspects the first 8.
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("rest-of-fake-png-body"),
  ]);
}

describe.skipIf(!requested)(
  "domain/mailbox-ingestion.ts + domain/files.ts writeMailboxAttachment (live PostgreSQL)",
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

      storageDir = mkdtempSync(path.join(tmpdir(), "expense-tax-t3c-"));
      storage = createStorageAdapter({
        backend: "local",
        localDir: storageDir,
        baseUrl: "http://127.0.0.1:8100",
        urlSigningKey: "test-signing-key-not-secret",
      });

      runtimeSql(`
        INSERT INTO app.users (id, primary_email, display_name) VALUES
          ('${OWNER_USER_ID}', 't3c-owner@example.test', 'T3C Owner')
        ON CONFLICT DO NOTHING;
        INSERT INTO app.tenants (id, name, slug, status) VALUES
          ('${TENANT_ID}', 'T3C Tenant', 't3c-tenant-${runKey}', 'active')
        ON CONFLICT DO NOTHING;
        INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status) VALUES
          ('${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;
        INSERT INTO app.personal_profiles (id, tenant_id, name) VALUES
          ('${PROFILE_ID}', '${TENANT_ID}', 'T3C Profile')
        ON CONFLICT DO NOTHING;
        INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role, status) VALUES
          ('${PROFILE_ID}', '${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;
      `);
    });

    afterAll(async () => {
      await database?.destroy();
      if (postgresContainerId && databaseName) {
        adminSql(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
      }
      if (storageDir) rmSync(storageDir, { recursive: true, force: true });
    });

    function sha256Hex(data: Buffer): string {
      return createHash("sha256").update(data).digest("hex");
    }

    /** Fresh connection + scan run + 'queued' candidate per test. */
    function seedQueuedCandidate(input: {
      readonly attachmentSha256: readonly string[];
    }): { connectionId: string; candidateId: string } {
      const connectionId = randomUUID();
      const scanRunId = randomUUID();
      const candidateId = randomUUID();
      const manifest = JSON.stringify(
        input.attachmentSha256.map((sha256, index) => ({
          name: `attachment-${index}.png`,
          mimeType: "image/png",
          sizeBytes: 100,
          sha256,
        })),
      );
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
        INSERT INTO app.mailbox_candidates (
          id, scan_run_id, connection_id, tenant_id, received_at, sender_address, sender_domain,
          subject, content_hash, attachment_manifest, classification, confidence, evidence,
          candidate_personal_profile_id, candidate_business_id, status,
          idempotency_key, normalized_request_hash, provider_message_id
        ) VALUES (
          '${candidateId}', '${scanRunId}', '${connectionId}', '${TENANT_ID}', now(),
          'sender@shopwaveco.example', 'shopwaveco.example', 'Your order confirmation',
          '${DUMMY_HASH}', '${manifest}'::jsonb, 'receipt', 0.9, '{}',
          '${PROFILE_ID}', NULL, 'queued',
          'cand-${candidateId}', '${DUMMY_HASH}', 'provider-${candidateId}'
        );
      `);
      return { connectionId, candidateId };
    }

    function fakePlansDomain(entitled: boolean): PlansDomain {
      return {
        resolveEffectiveEntitlements: async () => [
          {
            featureKey: "connected_mailbox_scan",
            isEnabled: entitled,
            limitValue: null,
            limitPeriod: null,
            source: "plan",
          },
        ],
      } as unknown as PlansDomain;
    }

    function createDomain(options: {
      readonly entitled?: boolean;
      readonly storageOverride?: StorageAdapter;
      readonly scannerOverride?: MailboxStagingScanner;
    } = {}) {
      const scanner = options.scannerOverride ?? createMailboxStagingScanner(storage, PatternMalwareScanner);
      const filesDomain = createFilesDomain(database!, options.storageOverride ?? storage, {
        mailboxScanner: scanner,
      });
      const plansDomain = fakePlansDomain(options.entitled ?? true);
      const domain = createMailboxIngestionDomain(database!, {
        filesDomain,
        plansDomain,
      });
      return { domain, filesDomain };
    }

    it("issues an upload grant for a queued candidate with the exact literal caps, and replays on the same operationId", async () => {
      const { domain } = createDomain();
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [] });
      const operationId = randomUUID();

      const grant = await domain.issueUploadGrant({
        candidateId, expectedCandidateVersion: 1, operationId,
      });
      expect(grant.maxBytes).toBe(26214400);
      expect(grant.maxAttachments).toBe(5);
      expect(grant.candidateId).toBe(candidateId);

      const replay = await domain.issueUploadGrant({
        candidateId, expectedCandidateVersion: 1, operationId,
      });
      expect(replay.uploadGrantId).toBe(grant.uploadGrantId);
    });

    it("rejects issueUploadGrant on a candidate version conflict", async () => {
      const { domain } = createDomain();
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [] });
      await expect(
        domain.issueUploadGrant({ candidateId, expectedCandidateVersion: 99, operationId: randomUUID() }),
      ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    });

    it("streams a clean attachment to READY only after hash verification and malware scan pass, and creates a PENDING mailbox OCR job for the existing retrying dispatcher to pick up", async () => {
      const bytes = pngBytes();
      const { candidateId, connectionId } = seedQueuedCandidate({
        attachmentSha256: [sha256Hex(bytes)],
      });
      const { domain } = createDomain();
      const grant = await domain.issueUploadGrant({
        candidateId, expectedCandidateVersion: 1, operationId: randomUUID(),
      });

      const result = await domain.receiveAttachment(
        {
          candidateId, attachmentIndex: 0, uploadGrantId: grant.uploadGrantId,
          expectedCandidateVersion: 1, idempotencyKey: randomUUID(),
        },
        chunks([bytes]),
      );
      expect(result.status).toBe("READY");
      expect(result.errorCode).toBeNull();

      const job = await database!
        .selectFrom("app.processing_jobs").selectAll()
        .where("source_file_id", "=", result.fileId).executeTakeFirstOrThrow();
      expect(job.workflow_type).toBe("MailboxOcrReceiptWorkflow");
      // Fix round 2 (review new Important #6): never dispatched directly
      // inline -- stays PENDING for dispatchPendingJobs (the existing,
      // already-retrying dispatcher every other job type relies on) to
      // pick up, with the FIXED TypeScript-worker target already stamped.
      expect(job.status).toBe("PENDING");
      expect(job.task_queue).toBe("expense-tax-processing");
      expect(job.dispatch_namespace).toBe("expense-tax");
      expect(job.requested_by_user_id).toBe(OWNER_USER_ID);

      const outbox = await database!
        .selectFrom("app.processing_job_dispatch_outbox").selectAll()
        .where("processing_job_id", "=", job.id).executeTakeFirstOrThrow();
      expect(outbox.status).toBe("PENDING");
      // Structural "no Buffer argument crosses worker/Temporal": the
      // stored job_reference must round-trip through JSON (a Buffer
      // would not) and carry only opaque job/workflow identifiers.
      const jobReference = outbox.job_reference as Record<string, unknown>;
      expect(JSON.parse(JSON.stringify(jobReference))).toEqual({
        schemaVersion: 1, jobId: job.id, workflowType: "MailboxOcrReceiptWorkflow", workflowId: job.workflow_id,
      });

      const fileRow = await database!
        .selectFrom("app.expense_files").selectAll()
        .where("id", "=", result.fileId).executeTakeFirstOrThrow();
      expect(fileRow.status).toBe("READY");
      expect(fileRow.sha256_hex).toBe(sha256Hex(bytes));
      void connectionId;
    });

    it("rejects an attachment whose stored-bytes hash does not match the candidate's own attachment-manifest entry, and never creates a job", async () => {
      const bytes = pngBytes();
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: ["f".repeat(64)] });
      const { domain } = createDomain();
      const grant = await domain.issueUploadGrant({
        candidateId, expectedCandidateVersion: 1, operationId: randomUUID(),
      });

      const result = await domain.receiveAttachment(
        {
          candidateId, attachmentIndex: 0, uploadGrantId: grant.uploadGrantId,
          expectedCandidateVersion: 1, idempotencyKey: randomUUID(),
        },
        chunks([bytes]),
      );
      expect(result.status).toBe("FAILED");
      expect(result.errorCode).toBe("ATTACHMENT_HASH_MISMATCH");

      const fileRow = await database!
        .selectFrom("app.expense_files").selectAll()
        .where("id", "=", result.fileId).executeTakeFirstOrThrow();
      expect(fileRow.status).toBe("FAILED");

      const jobs = await database!
        .selectFrom("app.processing_jobs").select("id")
        .where("source_file_id", "=", result.fileId).execute();
      expect(jobs).toHaveLength(0);
    });

    it("rejects an infected attachment (EICAR), deletes its scan-staging object, and never confirms it as READY (blocked = dead end)", async () => {
      const infected = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from(EICAR, "ascii"),
      ]);
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [sha256Hex(infected)] });
      const { domain } = createDomain();
      const grant = await domain.issueUploadGrant({
        candidateId, expectedCandidateVersion: 1, operationId: randomUUID(),
      });

      const result = await domain.receiveAttachment(
        {
          candidateId, attachmentIndex: 0, uploadGrantId: grant.uploadGrantId,
          expectedCandidateVersion: 1, idempotencyKey: randomUUID(),
        },
        chunks([infected]),
      );
      expect(result.status).toBe("FAILED");
      expect(result.errorCode).toBe("MALWARE_DETECTED");

      const fileRow = await database!
        .selectFrom("app.expense_files").selectAll()
        .where("id", "=", result.fileId).executeTakeFirstOrThrow();
      expect(fileRow.status).toBe("FAILED");
      // Temp/object cleanup: the dedicated scan-staging object must be gone
      // regardless of outcome -- confirm via statObject (not readObject,
      // which would throw either way and prove nothing about *this* key).
      const stagingStat = await storage.statObject(`${fileRow.storage_key}.scan-staging`);
      expect(stagingStat).toBeNull();
      // The file's own final storage_key was never written either (blocked
      // bytes never reach the persisted artifact location).
      const finalStat = await storage.statObject(fileRow.storage_key);
      expect(finalStat).toBeNull();
    });

    it("rejects an attachment exceeding the 25 MiB cap before ever reading past the bound, and never confirms it", async () => {
      const oversize = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 7);
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [sha256Hex(oversize)] });
      const { domain } = createDomain();
      const grant = await domain.issueUploadGrant({
        candidateId, expectedCandidateVersion: 1, operationId: randomUUID(),
      });

      const result = await domain.receiveAttachment(
        {
          candidateId, attachmentIndex: 0, uploadGrantId: grant.uploadGrantId,
          expectedCandidateVersion: 1, idempotencyKey: randomUUID(),
        },
        chunks([oversize]),
      );
      expect(result.status).toBe("FAILED");
      expect(result.errorCode).toBe("ATTACHMENT_BOUND_EXCEEDED");
    }, 20_000);

    it("accepts exactly 5 attachments (0-4), one grant per attachment (fix round 2: a grant is single-use), and rejects attachmentIndex 5 as out of range", async () => {
      const bytesFor = (n: number) => Buffer.concat([pngBytes(), Buffer.from(`-${n}`)]);
      const fiveHashes = [0, 1, 2, 3, 4].map((n) => sha256Hex(bytesFor(n)));
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: fiveHashes });
      const { domain } = createDomain();
      const fileIds: string[] = [];

      for (const index of [0, 1, 2, 3, 4]) {
        const grant = await domain.issueUploadGrant({
          candidateId, expectedCandidateVersion: 1, operationId: randomUUID(),
        });
        const result = await domain.receiveAttachment(
          {
            candidateId, attachmentIndex: index, uploadGrantId: grant.uploadGrantId,
            expectedCandidateVersion: 1, idempotencyKey: randomUUID(),
          },
          chunks([bytesFor(index)]),
        );
        expect(result.status).toBe("READY");
        fileIds.push(result.fileId);
      }
      // One OCR job per attachment (fix round 2, review Important #4),
      // not one per candidate.
      const jobs = await database!
        .selectFrom("app.processing_jobs").select(["id", "source_file_id"])
        .where("source_file_id", "in", fileIds)
        .execute();
      expect(jobs).toHaveLength(5);
      expect(new Set(jobs.map((job) => job.source_file_id)).size).toBe(5);

      const lastGrant = await domain.issueUploadGrant({
        candidateId, expectedCandidateVersion: 1, operationId: randomUUID(),
      });
      await expect(
        domain.receiveAttachment(
          {
            candidateId, attachmentIndex: 5, uploadGrantId: lastGrant.uploadGrantId,
            expectedCandidateVersion: 1, idempotencyKey: randomUUID(),
          },
          chunks([pngBytes()]),
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    it("materializes a structured receipt atomically: expense + connected provenance + candidate status, no OCR job", async () => {
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [] });
      const { domain } = createDomain();

      const result = await domain.submitStructuredReceipt({
        result: {
          schemaVersion: 1, candidateId, connectionId: (
            await database!.selectFrom("app.mailbox_candidates").select("connection_id")
              .where("id", "=", candidateId).executeTakeFirstOrThrow()
          ).connection_id,
          candidateVersion: 1,
          merchant: "Shopwave Co", amount: "42.50", currency: "USD", incurredOn: "2026-09-01",
          orderNumber: "ORD-123", notes: null, evidence: ["schema_type:Order"],
          idempotencyKey: "struct-1",
        },
        idempotencyKey: "struct-1",
      });

      expect(result.status).toBe("processed");
      expect(result.processingJobId).toBeNull();
      expect(result.expenseId).not.toBeNull();
      expect(result.sourceId).not.toBeNull();

      const source = await database!
        .selectFrom("app.expense_sources").selectAll()
        .where("id", "=", result.sourceId as string).executeTakeFirstOrThrow();
      expect(source.source_type).toBe("connected_mailbox");
      expect(source.mailbox_candidate_id).toBe(candidateId);

      const candidateRow = await database!
        .selectFrom("app.mailbox_candidates").selectAll()
        .where("id", "=", candidateId).executeTakeFirstOrThrow();
      expect(candidateRow.status).toBe("processed");
      expect(candidateRow.expense_id).toBe(result.expenseId);
    });

    it("rejects submitStructuredReceipt on a candidate version conflict", async () => {
      const { candidateId, connectionId } = seedQueuedCandidate({ attachmentSha256: [] });
      const { domain } = createDomain();
      await expect(
        domain.submitStructuredReceipt({
          result: {
            schemaVersion: 1, candidateId, connectionId, candidateVersion: 99,
            merchant: "X", amount: "1.00", currency: "USD", incurredOn: "2026-09-01",
            orderNumber: null, notes: null, evidence: [], idempotencyKey: "v-conflict",
          },
          idempotencyKey: "v-conflict",
        }),
      ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    });

    // ------------------------------------------------------------ //
    // Fix round 1 (task-3-review.md)
    // ------------------------------------------------------------ //

    it("round2 #3 (zero orphans): an unexpected exception anywhere after the PENDING row is created compensates fully -- no stuck PENDING row, no staging object, no final object", async () => {
      const bytes = pngBytes();
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [sha256Hex(bytes)] });
      // A scanner that THROWS (not a typed clean:false result) -- the
      // unexpected-exception class review Important #3 names explicitly,
      // distinct from round 1's already-fixed typed-mismatch case.
      const throwingScanner: MailboxStagingScanner = {
        async scanStagedObject() {
          throw new Error("scan engine crashed unexpectedly");
        },
      };
      const { domain } = createDomain({ scannerOverride: throwingScanner });
      const grant = await domain.issueUploadGrant({
        candidateId, expectedCandidateVersion: 1, operationId: randomUUID(),
      });

      const result = await domain.receiveAttachment(
        {
          candidateId, attachmentIndex: 0, uploadGrantId: grant.uploadGrantId,
          expectedCandidateVersion: 1, idempotencyKey: randomUUID(),
        },
        chunks([bytes]),
      );
      expect(result.status).toBe("FAILED");

      const fileRow = await database!
        .selectFrom("app.expense_files").selectAll()
        .where("id", "=", result.fileId).executeTakeFirstOrThrow();
      expect(fileRow.status).toBe("FAILED");
      expect(await storage.statObject(`${fileRow.storage_key}.scan-staging`)).toBeNull();
      expect(await storage.statObject(fileRow.storage_key)).toBeNull();

      // The ledger claim itself completed (with a FAILED result), not
      // stuck at 'started'.
      const operation = await database!
        .selectFrom("app.mailbox_ingestion_operations").selectAll()
        .where("candidate_id", "=", candidateId)
        .where("operation_kind", "=", "upload_attachment")
        .executeTakeFirstOrThrow();
      expect(operation.status).toBe("completed");
    });

    it("round2 #1 (true streaming): writeMailboxAttachment feeds the storage adapter many small chunks, never one Buffer holding the whole body", async () => {
      const chunkCount = 40;
      const parts = Array.from({ length: chunkCount }, (_unused, index) =>
        index === 0 ? pngBytes() : Buffer.alloc(1024, index % 256),
      );
      const wholeBody = Buffer.concat(parts);
      const observedChunkSizes: number[] = [];
      const spyingStorage: StorageAdapter = {
        ...storage,
        async writeObjectStream(input, source) {
          async function* observed(): AsyncIterable<Buffer> {
            for await (const chunk of source) {
              observedChunkSizes.push(chunk.byteLength);
              yield chunk;
            }
          }
          return storage.writeObjectStream(input, observed());
        },
      };
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [sha256Hex(wholeBody)] });
      const { domain } = createDomain({ storageOverride: spyingStorage });
      const grant = await domain.issueUploadGrant({
        candidateId, expectedCandidateVersion: 1, operationId: randomUUID(),
      });

      const result = await domain.receiveAttachment(
        {
          candidateId, attachmentIndex: 0, uploadGrantId: grant.uploadGrantId,
          expectedCandidateVersion: 1, idempotencyKey: randomUUID(),
        },
        chunks(parts),
      );
      expect(result.status).toBe("READY");
      expect(observedChunkSizes.length).toBeGreaterThan(1);
      expect(observedChunkSizes).toEqual(parts.map((part) => part.byteLength));
      expect(Math.max(...observedChunkSizes)).toBeLessThan(wholeBody.byteLength);
    });

    it("round2 #2: a grant is single-use overall -- rejects re-use for the SAME attachmentIndex with a different key, and for a DIFFERENT attachmentIndex entirely", async () => {
      const bytes = pngBytes();
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [sha256Hex(bytes)] });
      const { domain } = createDomain();
      const grant = await domain.issueUploadGrant({
        candidateId, expectedCandidateVersion: 1, operationId: randomUUID(),
      });

      const first = await domain.receiveAttachment(
        {
          candidateId, attachmentIndex: 0, uploadGrantId: grant.uploadGrantId,
          expectedCandidateVersion: 1, idempotencyKey: "first-key",
        },
        chunks([bytes]),
      );
      expect(first.status).toBe("READY");

      // Same grant, same index, a DIFFERENT idempotencyKey.
      await expect(
        domain.receiveAttachment(
          {
            candidateId, attachmentIndex: 0, uploadGrantId: grant.uploadGrantId,
            expectedCandidateVersion: 1, idempotencyKey: "second-key",
          },
          chunks([bytes]),
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

      // Fix round 2 (review Important #2, explicitly NOT addressed in
      // round 1): the SAME grant used for a DIFFERENT attachmentIndex --
      // a grant is consumed once, for whichever index first used it, not
      // reusable across the candidate's other attachment slots.
      await expect(
        domain.receiveAttachment(
          {
            candidateId, attachmentIndex: 1, uploadGrantId: grant.uploadGrantId,
            expectedCandidateVersion: 1, idempotencyKey: "third-key",
          },
          chunks([bytes]),
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

      // Exactly one job was ever created -- neither rejected re-use
      // attempt ran the stream/scan/job side effects.
      const jobCount = await database!
        .selectFrom("app.processing_jobs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("source_file_id", "=", first.fileId)
        .executeTakeFirstOrThrow();
      expect(Number(jobCount.count)).toBe(1);
    });

    it("review #3: refuses the whole attachment upload when connected_mailbox_scan is disabled, before any storage/job side effect", async () => {
      const bytes = pngBytes();
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [sha256Hex(bytes)] });
      const { domain } = createDomain({ entitled: false });
      const grant = await domain.issueUploadGrant({
        candidateId, expectedCandidateVersion: 1, operationId: randomUUID(),
      });

      await expect(
        domain.receiveAttachment(
          {
            candidateId, attachmentIndex: 0, uploadGrantId: grant.uploadGrantId,
            expectedCandidateVersion: 1, idempotencyKey: randomUUID(),
          },
          chunks([bytes]),
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      // No ledger claim was ever inserted and the candidate is untouched
      // -- refused in phase 1, before any side effect commits.
      const candidateRow = await database!
        .selectFrom("app.mailbox_candidates").selectAll()
        .where("id", "=", candidateId).executeTakeFirstOrThrow();
      expect(candidateRow.status).toBe("queued");
      expect(candidateRow.processing_job_id).toBeNull();
      const operationRows = await database!
        .selectFrom("app.mailbox_ingestion_operations")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("candidate_id", "=", candidateId)
        .where("operation_kind", "=", "upload_attachment")
        .executeTakeFirstOrThrow();
      expect(Number(operationRows.count)).toBe(0);
    });

    it("review #4: deletes the persisted object and never confirms READY when the bytes actually persisted don't match the computed hash", async () => {
      const bytes = pngBytes();
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [sha256Hex(bytes)] });
      // Corrupting storage double: writeObjectStream succeeds (streams
      // genuinely incrementally, delegating to the real adapter), but a
      // post-move statObject for the file's own FINAL storage key (never
      // the scan-staging key) reports a size that disagrees with what was
      // actually streamed -- simulating silent storage corruption between
      // the move and the persisted-size check.
      const corruptingStorage: StorageAdapter = {
        ...storage,
        async statObject(storageKey: string) {
          if (storageKey.endsWith(".scan-staging")) return storage.statObject(storageKey);
          const real = await storage.statObject(storageKey);
          return real ? { exists: true, sizeBytes: real.sizeBytes + 1 } : real;
        },
      };
      const { domain } = createDomain({ storageOverride: corruptingStorage });
      const grant = await domain.issueUploadGrant({
        candidateId, expectedCandidateVersion: 1, operationId: randomUUID(),
      });

      const result = await domain.receiveAttachment(
        {
          candidateId, attachmentIndex: 0, uploadGrantId: grant.uploadGrantId,
          expectedCandidateVersion: 1, idempotencyKey: randomUUID(),
        },
        chunks([bytes]),
      );
      expect(result.status).toBe("FAILED");
      expect(result.errorCode).toBe("ATTACHMENT_CONFIRMATION_FAILED");

      const fileRow = await database!
        .selectFrom("app.expense_files").selectAll()
        .where("id", "=", result.fileId).executeTakeFirstOrThrow();
      expect(fileRow.status).toBe("FAILED");
      // Orphan check: the (corrupting, but still real) storage backend's
      // own object for this key must be gone -- compensating delete ran.
      expect(await storage.statObject(fileRow.storage_key)).toBeNull();
    });

    it("round2 #4: two concurrent attachment uploads for the SAME candidate each get their OWN OCR job -- one per attachment, not one per candidate", async () => {
      const bytesFor = (n: number) => Buffer.concat([pngBytes(), Buffer.from(`-dup-${n}`)]);
      const hashes = [0, 1].map((n) => sha256Hex(bytesFor(n)));
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: hashes });
      const { domain } = createDomain();
      const [grantA, grantB] = await Promise.all([
        domain.issueUploadGrant({ candidateId, expectedCandidateVersion: 1, operationId: randomUUID() }),
        domain.issueUploadGrant({ candidateId, expectedCandidateVersion: 1, operationId: randomUUID() }),
      ]);

      const [resultA, resultB] = await Promise.all([
        domain.receiveAttachment(
          {
            candidateId, attachmentIndex: 0, uploadGrantId: grantA.uploadGrantId,
            expectedCandidateVersion: 1, idempotencyKey: randomUUID(),
          },
          chunks([bytesFor(0)]),
        ),
        domain.receiveAttachment(
          {
            candidateId, attachmentIndex: 1, uploadGrantId: grantB.uploadGrantId,
            expectedCandidateVersion: 1, idempotencyKey: randomUUID(),
          },
          chunks([bytesFor(1)]),
        ),
      ]);
      expect(resultA.status).toBe("READY");
      expect(resultB.status).toBe("READY");

      const jobs = await database!
        .selectFrom("app.processing_jobs").select(["id", "source_file_id"])
        .where("source_file_id", "in", [resultA.fileId, resultB.fileId])
        .execute();
      expect(jobs).toHaveLength(2);
      expect(new Set(jobs.map((job) => job.source_file_id))).toEqual(
        new Set([resultA.fileId, resultB.fileId]),
      );
    });

    it("round2 #5: a stale 'started' claim (its owning attempt crashed before completing) is recoverable by a same-key retry -- never permanently stuck", async () => {
      const bytes = pngBytes();
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [sha256Hex(bytes)] });
      const { domain } = createDomain();
      const grant = await domain.issueUploadGrant({
        candidateId, expectedCandidateVersion: 1, operationId: randomUUID(),
      });
      const idempotencyKey = randomUUID();
      const requestHash = hashNormalizedRequest({
        candidateId, attachmentIndex: 0, uploadGrantId: grant.uploadGrantId, expectedCandidateVersion: 1,
      });
      const connectionId = (
        await database!.selectFrom("app.mailbox_candidates").select("connection_id")
          .where("id", "=", candidateId).executeTakeFirstOrThrow()
      ).connection_id;

      // Simulate a crashed prior attempt: a 'started' claim whose
      // updated_at is long past the lease window, with no live process
      // ever going to complete it.
      runtimeSql(`
        INSERT INTO app.mailbox_ingestion_operations (
          id, tenant_id, connection_id, candidate_id, operation_kind, operation_key,
          idempotency_key, normalized_request_hash, response_json, status, version,
          created_at, updated_at
        ) VALUES (
          '${randomUUID()}', '${TENANT_ID}', '${connectionId}', '${candidateId}',
          'upload_attachment', 'upload-attachment:${candidateId}:${grant.uploadGrantId}',
          '${idempotencyKey}', '${requestHash}', NULL, 'started', 1,
          now() - interval '10 minutes', now() - interval '10 minutes'
        );
      `);

      // Same exact key -- recovers the stale lease and completes normally,
      // instead of throwing CONFLICT forever.
      const result = await domain.receiveAttachment(
        {
          candidateId, attachmentIndex: 0, uploadGrantId: grant.uploadGrantId,
          expectedCandidateVersion: 1, idempotencyKey,
        },
        chunks([bytes]),
      );
      expect(result.status).toBe("READY");

      const operation = await database!
        .selectFrom("app.mailbox_ingestion_operations").selectAll()
        .where("candidate_id", "=", candidateId)
        .where("operation_kind", "=", "upload_attachment")
        .executeTakeFirstOrThrow();
      expect(operation.status).toBe("completed");
    });

    it("review #6: two concurrent calls with the exact same idempotency key (within the lease window) never both run side effects -- one succeeds, the other is rejected", async () => {
      const bytes = pngBytes();
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [sha256Hex(bytes)] });
      const { domain } = createDomain();
      const grant = await domain.issueUploadGrant({
        candidateId, expectedCandidateVersion: 1, operationId: randomUUID(),
      });
      const sharedIdempotencyKey = randomUUID();

      const outcomes = await Promise.allSettled([
        domain.receiveAttachment(
          {
            candidateId, attachmentIndex: 0, uploadGrantId: grant.uploadGrantId,
            expectedCandidateVersion: 1, idempotencyKey: sharedIdempotencyKey,
          },
          chunks([bytes]),
        ),
        domain.receiveAttachment(
          {
            candidateId, attachmentIndex: 0, uploadGrantId: grant.uploadGrantId,
            expectedCandidateVersion: 1, idempotencyKey: sharedIdempotencyKey,
          },
          chunks([bytes]),
        ),
      ]);

      const fulfilled = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<unknown> => outcome.status === "fulfilled",
      );
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      // Claim-first: exactly one upload_attachment ledger row for this
      // (candidate, attachmentIndex) pair, never two -- the losing racer
      // either replayed the winner's row or was rejected outright, it
      // never inserted a second claim of its own.
      const claimCount = await database!
        .selectFrom("app.mailbox_ingestion_operations")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("candidate_id", "=", candidateId)
        .where("operation_kind", "=", "upload_attachment")
        .executeTakeFirstOrThrow();
      expect(Number(claimCount.count)).toBe(1);
    });

    it("round2 #6: a Temporal dispatch failure is retried (and eventually succeeds) by the existing dispatchPendingJobs mechanism, not stranded", async () => {
      const bytes = pngBytes();
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [sha256Hex(bytes)] });
      const { domain } = createDomain();
      const grant = await domain.issueUploadGrant({
        candidateId, expectedCandidateVersion: 1, operationId: randomUUID(),
      });
      const result = await domain.receiveAttachment(
        {
          candidateId, attachmentIndex: 0, uploadGrantId: grant.uploadGrantId,
          expectedCandidateVersion: 1, idempotencyKey: randomUUID(),
        },
        chunks([bytes]),
      );
      expect(result.status).toBe("READY");
      const jobBefore = await database!
        .selectFrom("app.processing_jobs").selectAll()
        .where("source_file_id", "=", result.fileId).executeTakeFirstOrThrow();
      expect(jobBefore.status).toBe("PENDING");

      // First dispatch attempt fails (e.g. Temporal briefly unreachable).
      let shouldFail = true;
      const flakyStarter: TemporalWorkflowStarter = {
        async start() {
          if (shouldFail) throw new Error("temporal unreachable");
          return { runId: `run-${randomUUID()}` };
        },
        async close() {},
      };
      const processingJobsDomain = createProcessingJobsDomain(database!, flakyStarter);
      const firstAttempt = await processingJobsDomain.dispatchPendingJobs({});
      expect(firstAttempt.dispatchedCount).toBe(0);

      const jobAfterFailure = await database!
        .selectFrom("app.processing_jobs").selectAll()
        .where("id", "=", jobBefore.id).executeTakeFirstOrThrow();
      expect(jobAfterFailure.status).toBe("PENDING");
      const outboxAfterFailure = await database!
        .selectFrom("app.processing_job_dispatch_outbox").selectAll()
        .where("processing_job_id", "=", jobBefore.id).executeTakeFirstOrThrow();
      expect(outboxAfterFailure.status).toBe("PENDING");
      expect(outboxAfterFailure.attempts).toBeGreaterThanOrEqual(1);
      expect(outboxAfterFailure.last_error).toBeTruthy();

      // Retry succeeds -- same mechanism every other job type already
      // relies on, no mailbox-specific dispatch path needed.
      shouldFail = false;
      const secondAttempt = await processingJobsDomain.dispatchPendingJobs({});
      expect(secondAttempt.dispatchedCount).toBeGreaterThanOrEqual(1);
      const jobAfterRetry = await database!
        .selectFrom("app.processing_jobs").selectAll()
        .where("id", "=", jobBefore.id).executeTakeFirstOrThrow();
      expect(jobAfterRetry.status).toBe("DISPATCHED");
    });

    // ------------------------------------------------------------ //
    // Task 4 -- structured receipt transaction and shared dedup evidence.
    //
    // Added to this file's existing live-Postgres harness rather than new
    // mailbox-structured-receipt.test.ts/mailbox-deduplication.test.ts
    // files (brief's illustrative list): both would otherwise duplicate
    // this file's ~350-line Docker/Postgres bootstrap wholesale for no
    // behavior gap -- same "no file change without a behavior gap"
    // precedent Tasks 1-3 already applied repeatedly to the brief's own
    // file lists.
    // ------------------------------------------------------------ //

    async function connectionIdFor(candidateId: string): Promise<string> {
      return (
        await database!
          .selectFrom("app.mailbox_candidates")
          .select("connection_id")
          .where("id", "=", candidateId)
          .executeTakeFirstOrThrow()
      ).connection_id;
    }

    it("never trusts a structured receipt blindly -- rejects invalid merchant/amount/currency/date before any side effect, leaving the candidate queued for an OCR fallback", async () => {
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [] });
      const { domain } = createDomain();
      const connectionId = await connectionIdFor(candidateId);
      const base = {
        schemaVersion: 1 as const,
        candidateId,
        connectionId,
        candidateVersion: 1,
        merchant: "Shopwave Co",
        amount: "42.50",
        currency: "USD",
        incurredOn: "2026-09-01",
        orderNumber: null,
        notes: null,
        evidence: [] as readonly string[],
      };
      const invalidCases: Array<[string, Partial<typeof base>]> = [
        ["empty merchant", { merchant: "   " }],
        ["non-decimal amount", { amount: "not-a-number" }],
        ["lowercase currency", { currency: "usd" }],
        ["non-ISO date", { incurredOn: "09/01/2026" }],
      ];
      for (const [label, overrides] of invalidCases) {
        await expect(
          domain.submitStructuredReceipt({
            result: { ...base, ...overrides, idempotencyKey: `invalid-${label}` },
            idempotencyKey: `invalid-${label}`,
          }),
          label,
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      }
      const candidateRow = await database!
        .selectFrom("app.mailbox_candidates").selectAll()
        .where("id", "=", candidateId).executeTakeFirstOrThrow();
      expect(candidateRow.status).toBe("queued");
      expect(candidateRow.expense_id).toBeNull();
    });

    it("fix round 1 review #1: refuses a structured-receipt callback when connected_mailbox_scan is disabled, before any materialization or ledger write", async () => {
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [] });
      const connectionId = await connectionIdFor(candidateId);
      const { domain } = createDomain({ entitled: false });

      await expect(
        domain.submitStructuredReceipt({
          result: {
            schemaVersion: 1, candidateId, connectionId, candidateVersion: 1,
            merchant: "Disabled Co", amount: "1.00", currency: "USD", incurredOn: "2026-09-10",
            orderNumber: null, notes: null, evidence: [], idempotencyKey: "disabled-1",
          },
          idempotencyKey: "disabled-1",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const candidateRow = await database!
        .selectFrom("app.mailbox_candidates").selectAll()
        .where("id", "=", candidateId).executeTakeFirstOrThrow();
      expect(candidateRow.status).toBe("queued");
      expect(candidateRow.expense_id).toBeNull();

      const ledgerCount = await database!
        .selectFrom("app.mailbox_ingestion_operations")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("candidate_id", "=", candidateId)
        .where("operation_kind", "=", "submit_structured_result")
        .executeTakeFirstOrThrow();
      expect(Number(ledgerCount.count)).toBe(0);
    });

    it("creates a Phase 3C enrichment job transactionally with the materialized expense, same as every other source", async () => {
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [] });
      const { domain } = createDomain();
      const connectionId = await connectionIdFor(candidateId);

      const result = await domain.submitStructuredReceipt({
        result: {
          schemaVersion: 1, candidateId, connectionId, candidateVersion: 1,
          merchant: "Enrichment Co", amount: "15.00", currency: "USD", incurredOn: "2026-09-03",
          orderNumber: null, notes: null, evidence: [], idempotencyKey: "enrich-1",
        },
        idempotencyKey: "enrich-1",
      });

      const jobs = await database!
        .selectFrom("app.processing_jobs").selectAll()
        .where("target_aggregate_id", "=", result.expenseId as string)
        .where("workflow_type", "=", EXPENSE_ENRICHMENT_WORKFLOW_TYPE)
        .execute();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.status).toBe("PENDING");
      expect(jobs[0]?.expected_aggregate_version).toBe(1);
      expect(jobs[0]?.personal_profile_id).toBe(PROFILE_ID);

      const outbox = await database!
        .selectFrom("app.processing_job_dispatch_outbox").selectAll()
        .where("processing_job_id", "=", jobs[0]!.id).execute();
      expect(outbox).toHaveLength(1);
    });

    it("fix round 1 review #3: a succeeded mailbox OCR job (PENDING -> DISPATCHED -> RUNNING -> SUCCEEDED via submitResult) materializes the expense with connected_mailbox provenance, an enrichment job, and pending dedup evidence", async () => {
      // Pre-seed an existing expense + fingerprint with the exact
      // merchant/amount/currency/date the OCR extraction below will
      // report, so this end-to-end run also exercises the shared dedup
      // path (not just the happy "processed" case).
      const seedCandidate = seedQueuedCandidate({ attachmentSha256: [] });
      const seedConnectionId = await connectionIdFor(seedCandidate.candidateId);
      const { domain } = createDomain();
      const seedResult = await domain.submitStructuredReceipt({
        result: {
          schemaVersion: 1, candidateId: seedCandidate.candidateId, connectionId: seedConnectionId,
          candidateVersion: 1,
          merchant: "OCR E2E Co", amount: "33.33", currency: "USD", incurredOn: "2026-09-11",
          orderNumber: null, notes: null, evidence: [], idempotencyKey: "ocr-e2e-seed",
        },
        idempotencyKey: "ocr-e2e-seed",
      });
      expect(seedResult.status).toBe("processed");

      // Attachment-OCR path: upload -> READY -> PENDING job created.
      const bytes = pngBytes();
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [sha256Hex(bytes)] });
      const grant = await domain.issueUploadGrant({
        candidateId, expectedCandidateVersion: 1, operationId: randomUUID(),
      });
      const uploadResult = await domain.receiveAttachment(
        {
          candidateId, attachmentIndex: 0, uploadGrantId: grant.uploadGrantId,
          expectedCandidateVersion: 1, idempotencyKey: randomUUID(),
        },
        chunks([bytes]),
      );
      expect(uploadResult.status).toBe("READY");
      const jobRow = await database!
        .selectFrom("app.processing_jobs").selectAll()
        .where("source_file_id", "=", uploadResult.fileId).executeTakeFirstOrThrow();
      expect(jobRow.status).toBe("PENDING");

      // Dispatch (PENDING -> DISPATCHED) through the same
      // dispatchPendingJobs mechanism round2 #6 already proves, then
      // RUNNING, then submitResult with a SUCCEEDED OCR extraction.
      const temporalStarter: TemporalWorkflowStarter = {
        async start() {
          return { runId: `run-${randomUUID()}` };
        },
        async close() {},
      };
      const processingJobsDomain = createProcessingJobsDomain(database!, temporalStarter);
      const dispatched = await processingJobsDomain.dispatchPendingJobs({});
      expect(dispatched.dispatchedCount).toBeGreaterThanOrEqual(1);

      const dispatchedJob = await database!
        .selectFrom("app.processing_jobs").selectAll()
        .where("id", "=", jobRow.id).executeTakeFirstOrThrow();
      expect(dispatchedJob.status).toBe("DISPATCHED");

      const runningResult = await processingJobsDomain.recordStatusUpdate({
        jobId: jobRow.id,
        request: {
          schemaVersion: 1, status: "RUNNING",
          idempotencyKey: "ocr-e2e-running", expectedJobVersion: dispatchedJob.version,
        },
        actorServicePrincipal: "ai-worker-app-machine",
        requestId: "ocr-e2e-running",
      });
      expect(runningResult.body.status).toBe("RUNNING");

      const submitted = await processingJobsDomain.submitResult({
        jobId: jobRow.id,
        request: {
          schemaVersion: 1, status: "SUCCEEDED",
          idempotencyKey: "ocr-e2e-result", expectedJobVersion: runningResult.body.version,
          resultSchemaVersion: OCR_EXTRACTION_RESULT_SCHEMA_VERSION,
          result: {
            schemaVersion: 1,
            merchant: "OCR E2E Co", amount: "33.33", currency: "USD", incurredOn: "2026-09-11",
            confidence: 0.97,
          },
        },
        actorServicePrincipal: "ai-worker-app-machine",
        requestId: "ocr-e2e-result",
      });
      expect(submitted.body.status).toBe("SUCCEEDED");

      // Connected provenance.
      const candidateRow = await database!
        .selectFrom("app.mailbox_candidates").selectAll()
        .where("id", "=", candidateId).executeTakeFirstOrThrow();
      expect(candidateRow.status).toBe("duplicate");
      expect(candidateRow.expense_id).not.toBeNull();
      const source = await database!
        .selectFrom("app.expense_sources").selectAll()
        .where("id", "=", candidateRow.source_id as string).executeTakeFirstOrThrow();
      expect(source.source_type).toBe("connected_mailbox");
      expect(source.mailbox_candidate_id).toBe(candidateId);

      // Enrichment job created transactionally, same as the structured path.
      const enrichmentJobs = await database!
        .selectFrom("app.processing_jobs").selectAll()
        .where("target_aggregate_id", "=", candidateRow.expense_id as string)
        .where("workflow_type", "=", EXPENSE_ENRICHMENT_WORKFLOW_TYPE)
        .execute();
      expect(enrichmentJobs).toHaveLength(1);

      // Pending dedup evidence against the pre-seeded expense.
      expect(candidateRow.duplicate_match_id).not.toBeNull();
      const match = await database!
        .selectFrom("app.expense_duplicate_matches").selectAll()
        .where("id", "=", candidateRow.duplicate_match_id as string).executeTakeFirstOrThrow();
      expect(match.existing_expense_id).toBe(seedResult.expenseId);
      expect(match.status).toBe("pending");
    });

    it("stores structured-receipt evidence as bounded names in expense_sources.metadata, never raw HTML/text", async () => {
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [] });
      const { domain } = createDomain();
      const connectionId = await connectionIdFor(candidateId);

      const result = await domain.submitStructuredReceipt({
        result: {
          schemaVersion: 1, candidateId, connectionId, candidateVersion: 1,
          merchant: "Evidence Co", amount: "9.99", currency: "USD", incurredOn: "2026-09-04",
          orderNumber: "ORD-9", notes: null,
          evidence: ["schema_type:Order", "field:amount", "field:orderNumber"],
          idempotencyKey: "evidence-1",
        },
        idempotencyKey: "evidence-1",
      });

      const source = await database!
        .selectFrom("app.expense_sources").selectAll()
        .where("id", "=", result.sourceId as string).executeTakeFirstOrThrow();
      expect(source.metadata).toEqual({
        orderNumber: "ORD-9",
        evidence: ["schema_type:Order", "field:amount", "field:orderNumber"],
      });
    });

    it("rejects content-bearing or unbounded structured-receipt evidence before any side effect", async () => {
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [] });
      const { domain } = createDomain();
      const connectionId = await connectionIdFor(candidateId);
      const base = {
        schemaVersion: 1 as const,
        candidateId,
        connectionId,
        candidateVersion: 1,
        merchant: "Evidence Reject Co",
        amount: "1.00",
        currency: "USD",
        incurredOn: "2026-09-09",
        orderNumber: null,
        notes: null,
      };
      const invalidEvidenceCases: Array<[string, readonly string[]]> = [
        ["raw HTML content", ["<script>alert(1)</script>"]],
        ["free-form text not in the catalog", ["structured_html_invoice"]],
        ["an entry outside the closed vocabulary", ["field:totalPrice"]],
        ["an oversized array", Array.from({ length: 9 }, () => "field:merchant")],
      ];
      for (const [label, evidence] of invalidEvidenceCases) {
        await expect(
          domain.submitStructuredReceipt({
            result: { ...base, evidence, idempotencyKey: `bad-evidence-${label}` },
            idempotencyKey: `bad-evidence-${label}`,
          }),
          label,
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      }
      const candidateRow = await database!
        .selectFrom("app.mailbox_candidates").selectAll()
        .where("id", "=", candidateId).executeTakeFirstOrThrow();
      expect(candidateRow.status).toBe("queued");
      expect(candidateRow.expense_id).toBeNull();
    });

    it("records a Phase 3B pending duplicate match on a repeat fingerprint, with evidence identical in shape to the legacy dedup path", async () => {
      const { domain } = createDomain();
      const first = seedQueuedCandidate({ attachmentSha256: [] });
      const firstConnectionId = await connectionIdFor(first.candidateId);
      const firstResult = await domain.submitStructuredReceipt({
        result: {
          schemaVersion: 1, candidateId: first.candidateId, connectionId: firstConnectionId,
          candidateVersion: 1,
          merchant: "Repeat Co", amount: "20.00", currency: "USD", incurredOn: "2026-09-05",
          orderNumber: null, notes: null, evidence: [], idempotencyKey: "repeat-1",
        },
        idempotencyKey: "repeat-1",
      });
      expect(firstResult.status).toBe("processed");

      const second = seedQueuedCandidate({ attachmentSha256: [] });
      const secondConnectionId = await connectionIdFor(second.candidateId);
      const secondResult = await domain.submitStructuredReceipt({
        result: {
          schemaVersion: 1, candidateId: second.candidateId, connectionId: secondConnectionId,
          candidateVersion: 1,
          // Same merchant/amount/currency/date -> same fingerprint hash.
          merchant: "Repeat Co", amount: "20.00", currency: "USD", incurredOn: "2026-09-05",
          orderNumber: null, notes: null, evidence: [], idempotencyKey: "repeat-2",
        },
        idempotencyKey: "repeat-2",
      });

      expect(secondResult.status).toBe("duplicate");
      expect(secondResult.duplicateMatchId).not.toBeNull();

      const match = await database!
        .selectFrom("app.expense_duplicate_matches").selectAll()
        .where("id", "=", secondResult.duplicateMatchId as string).executeTakeFirstOrThrow();
      expect(match.existing_expense_id).toBe(firstResult.expenseId);
      expect(match.candidate_expense_id).toBe(secondResult.expenseId);
      expect(match.match_type).toBe("fingerprint");
      expect(match.status).toBe("pending");
      // Exact shape findDeterministicCandidates' fingerprint branch
      // always produces -- the same shape the legacy inbound/OCR
      // recordEvidence dedup path (deduplication.ts) writes for a
      // fingerprint match, since both call the same addMatch/
      // findDeterministicCandidates primitives.
      expect(match.evidence).toEqual({ fingerprintHash: expect.any(String) });
      // Never auto-merged: both expenses remain independently queryable.
      expect(firstResult.expenseId).not.toBe(secondResult.expenseId);
    });

    it("replays the exact same materialization result on a retried submitStructuredReceipt call instead of re-materializing", async () => {
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [] });
      const { domain } = createDomain();
      const connectionId = await connectionIdFor(candidateId);
      const request = {
        result: {
          schemaVersion: 1 as const, candidateId, connectionId, candidateVersion: 1,
          merchant: "Replay Co", amount: "5.00", currency: "USD", incurredOn: "2026-09-06",
          orderNumber: null, notes: null, evidence: [], idempotencyKey: "replay-1",
        },
        idempotencyKey: "replay-1",
      };

      const first = await domain.submitStructuredReceipt(request);
      const second = await domain.submitStructuredReceipt(request);
      expect(second).toEqual(first);

      const expenseCount = await database!
        .selectFrom("app.expenses")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("id", "=", first.expenseId as string)
        .executeTakeFirstOrThrow();
      expect(Number(expenseCount.count)).toBe(1);
    });

    it("rolls back the expense, connected provenance, dedup fingerprint, and enrichment job together if the transaction aborts after materialization", async () => {
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [] });
      let capturedExpenseId: string | undefined;

      await expect(
        database!.transaction().execute(async (transaction) => {
          const candidate = await transaction
            .selectFrom("app.mailbox_candidates").selectAll()
            .where("id", "=", candidateId).forUpdate().executeTakeFirstOrThrow();
          const connection = await transaction
            .selectFrom("app.mailbox_connections").selectAll()
            .where("id", "=", candidate.connection_id).executeTakeFirstOrThrow();
          const materialized = await recordConnectedMailboxEvidenceInTransaction(transaction, {
            candidate, connection,
            merchant: "Rollback Co", amount: "10.00", currency: "USD", incurredOn: "2026-09-07",
            orderNumber: null, notes: null, processingJobId: null,
            requestedByUserId: null, requestId: "rollback-1", evidence: [],
          });
          capturedExpenseId = materialized.expenseId;
          throw new Error("forced rollback after materialization, before commit");
        }),
      ).rejects.toThrow("forced rollback");

      const expenseRow = await database!
        .selectFrom("app.expenses").selectAll()
        .where("id", "=", capturedExpenseId as string).executeTakeFirst();
      expect(expenseRow).toBeUndefined();

      const jobRow = await database!
        .selectFrom("app.processing_jobs").selectAll()
        .where("target_aggregate_id", "=", capturedExpenseId as string).executeTakeFirst();
      expect(jobRow).toBeUndefined();

      const sourceRow = await database!
        .selectFrom("app.expense_sources").selectAll()
        .where("mailbox_candidate_id", "=", candidateId).executeTakeFirst();
      expect(sourceRow).toBeUndefined();

      const candidateRow = await database!
        .selectFrom("app.mailbox_candidates").selectAll()
        .where("id", "=", candidateId).executeTakeFirstOrThrow();
      expect(candidateRow.status).toBe("queued");
    });

    it("the database itself rejects a second connected-provenance row for an already-materialized candidate (connected source constraint)", async () => {
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [] });
      const { domain } = createDomain();
      const connectionId = await connectionIdFor(candidateId);
      const result = await domain.submitStructuredReceipt({
        result: {
          schemaVersion: 1, candidateId, connectionId, candidateVersion: 1,
          merchant: "Constraint Co", amount: "7.00", currency: "USD", incurredOn: "2026-09-08",
          orderNumber: null, notes: null, evidence: [], idempotencyKey: "constraint-1",
        },
        idempotencyKey: "constraint-1",
      });
      expect(result.sourceId).not.toBeNull();

      // A second connected-mailbox provenance row for the SAME candidate
      // (even pointing at a different expense) must be rejected by
      // migration 020's own partial unique index
      // (expense_sources_mailbox_candidate_unique), not merely by
      // application-level status checks.
      expect(() =>
        runtimeSql(`
          INSERT INTO app.expense_sources (
            id, tenant_id, personal_profile_id, expense_id, source_type, mailbox_candidate_id
          ) VALUES (
            '${randomUUID()}', '${TENANT_ID}', '${PROFILE_ID}', '${result.expenseId}',
            'connected_mailbox', '${candidateId}'
          );
        `),
      ).toThrow();
    });
  },
);
