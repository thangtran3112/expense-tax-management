/**
 * Phase 3D-C Task 3 — storage/bounded-stream.ts (always-run, no Docker) and
 * domain/mailbox-ingestion.ts + domain/files.ts's writeMailboxAttachment
 * (real-PostgreSQL coverage, gated on PHASE_3D_C_T3_INTEGRATION=1, same
 * ephemeral-database/port-5433 pattern as mailbox-candidates.test.ts).
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

import { MAX_UPLOAD_BYTES } from "@expense-tax/contracts";
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
} from "../src/domain/files.js";
import {
  createMailboxIngestionDomain,
  type MailboxIngestionDomain,
} from "../src/domain/mailbox-ingestion.js";
import type { PlansDomain } from "../src/domain/plans.js";
import { registerErrorHandlers } from "../src/errors.js";
import { PatternMalwareScanner } from "../src/inbound/security.js";
import { registerAuthPlugin } from "../src/plugins/auth.js";
import { registerMailboxIngestionRoutes } from "../src/routes/mailbox-ingestion.js";
import {
  BoundedStreamSizeExceededError,
  readBoundedStream,
} from "../src/storage/bounded-stream.js";
import { createStorageAdapter } from "../src/storage/factory.js";
import type { StorageAdapter } from "../src/storage/types.js";
import type { TemporalWorkflowStarter } from "../src/temporal/client.js";

type FastifyApp = ReturnType<typeof Fastify>;

// -------------------------------------------------------------------- //
// storage/bounded-stream.ts -- pure function, always runs.
// -------------------------------------------------------------------- //

async function* chunks(parts: readonly Buffer[]): AsyncIterable<Buffer> {
  for (const part of parts) yield part;
}

describe("storage/bounded-stream.ts", () => {
  it("hashes and sizes an in-bound stream across multiple chunks", async () => {
    const parts = [Buffer.from("hello "), Buffer.from("mailbox "), Buffer.from("world")];
    const result = await readBoundedStream(chunks(parts), 1_000);
    const expected = Buffer.concat(parts);
    expect(result.data.equals(expected)).toBe(true);
    expect(result.sizeBytes).toBe(expected.byteLength);
    expect(result.sha256Hex).toMatch(/^[a-f0-9]{64}$/);
  });

  it("passes at exactly the byte cap", async () => {
    const exact = Buffer.alloc(10, 1);
    const result = await readBoundedStream(chunks([exact]), 10);
    expect(result.sizeBytes).toBe(10);
  });

  it("throws BoundedStreamSizeExceededError the instant the cap is exceeded, without draining the rest of the source", async () => {
    let secondChunkRead = false;
    async function* source(): AsyncIterable<Buffer> {
      yield Buffer.alloc(11, 1);
      secondChunkRead = true;
      yield Buffer.alloc(11, 2);
    }
    await expect(readBoundedStream(source(), 10)).rejects.toBeInstanceOf(
      BoundedStreamSizeExceededError,
    );
    expect(secondChunkRead).toBe(false);
  });
});

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

function fakeTemporalStarter(): TemporalWorkflowStarter & {
  readonly calls: { workflowType: string; workflowId: string; taskQueue: string; namespace?: string; args: unknown }[];
} {
  const calls: { workflowType: string; workflowId: string; taskQueue: string; namespace?: string; args: unknown }[] = [];
  return {
    calls,
    async start(input) {
      calls.push({ ...input });
      return { runId: `run-${randomUUID()}` };
    },
    async close() {},
  };
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

    function createDomain(options: { readonly entitled?: boolean } = {}) {
      const scanner = createMailboxStagingScanner(storage, PatternMalwareScanner);
      const filesDomain = createFilesDomain(database!, storage, { mailboxScanner: scanner });
      const temporalStarter = fakeTemporalStarter();
      const plansDomain = fakePlansDomain(options.entitled ?? true);
      const domain = createMailboxIngestionDomain(database!, {
        filesDomain,
        temporalStarter,
        plansDomain,
      });
      return { domain, temporalStarter, filesDomain };
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

    it("streams a clean attachment to READY only after hash verification and malware scan pass, creates and directly dispatches the mailbox OCR job, and never puts raw bytes in the Temporal args", async () => {
      const bytes = pngBytes();
      const { candidateId, connectionId } = seedQueuedCandidate({
        attachmentSha256: [sha256Hex(bytes)],
      });
      const { domain, temporalStarter } = createDomain();
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

      const candidateRow = await database!
        .selectFrom("app.mailbox_candidates").selectAll()
        .where("id", "=", candidateId).executeTakeFirstOrThrow();
      expect(candidateRow.processing_job_id).not.toBeNull();
      expect(candidateRow.status).toBe("queued");

      const job = await database!
        .selectFrom("app.processing_jobs").selectAll()
        .where("id", "=", candidateRow.processing_job_id as string).executeTakeFirstOrThrow();
      expect(job.workflow_type).toBe("MailboxOcrReceiptWorkflow");
      expect(job.status).toBe("DISPATCHED");
      expect(job.source_file_id).toBe(result.fileId);
      expect(job.requested_by_user_id).toBe(OWNER_USER_ID);

      expect(temporalStarter.calls).toHaveLength(1);
      const call = temporalStarter.calls[0]!;
      expect(call.workflowType).toBe("MailboxOcrReceiptWorkflow");
      expect(call.namespace).toBe("expense-tax");
      expect(call.taskQueue).toBe("expense-tax-processing");
      // Structural "no Buffer argument crosses worker/Temporal": the whole
      // args payload must round-trip through JSON (a Buffer would not)
      // and carry only opaque job/workflow identifiers.
      const serialized = JSON.parse(JSON.stringify(call.args));
      expect(serialized).toEqual([
        { schemaVersion: 1, jobId: job.id, workflowType: "MailboxOcrReceiptWorkflow", workflowId: job.workflow_id },
      ]);

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
      const { domain, temporalStarter } = createDomain();
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
      expect(temporalStarter.calls).toHaveLength(0);

      const fileRow = await database!
        .selectFrom("app.expense_files").selectAll()
        .where("id", "=", result.fileId).executeTakeFirstOrThrow();
      expect(fileRow.status).toBe("FAILED");

      const candidateRow = await database!
        .selectFrom("app.mailbox_candidates").selectAll()
        .where("id", "=", candidateId).executeTakeFirstOrThrow();
      expect(candidateRow.processing_job_id).toBeNull();
    });

    it("rejects an infected attachment (EICAR), deletes its scan-staging object, and never confirms it as READY (blocked = dead end)", async () => {
      const infected = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from(EICAR, "ascii"),
      ]);
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: [sha256Hex(infected)] });
      const { domain, temporalStarter } = createDomain();
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
      expect(temporalStarter.calls).toHaveLength(0);

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
      const { domain, temporalStarter } = createDomain();
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
      expect(temporalStarter.calls).toHaveLength(0);
    }, 20_000);

    it("accepts exactly 5 attachments (0-4) and rejects attachmentIndex 5 as out of range", async () => {
      const bytesFor = (n: number) => Buffer.concat([pngBytes(), Buffer.from(`-${n}`)]);
      const fiveHashes = [0, 1, 2, 3, 4].map((n) => sha256Hex(bytesFor(n)));
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: fiveHashes });
      const { domain } = createDomain();
      const grant = await domain.issueUploadGrant({
        candidateId, expectedCandidateVersion: 1, operationId: randomUUID(),
      });

      for (const index of [0, 1, 2, 3, 4]) {
        const result = await domain.receiveAttachment(
          {
            candidateId, attachmentIndex: index, uploadGrantId: grant.uploadGrantId,
            expectedCandidateVersion: 1, idempotencyKey: randomUUID(),
          },
          chunks([bytesFor(index)]),
        );
        expect(result.status).toBe("READY");
      }

      await expect(
        domain.receiveAttachment(
          {
            candidateId, attachmentIndex: 5, uploadGrantId: grant.uploadGrantId,
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
          orderNumber: "ORD-123", notes: null, evidence: ["structured_html_invoice"],
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

    it("review #2: rejects re-use of the same upload grant/attachment slot with a different idempotency key -- the slot is single-use, not a replay", async () => {
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

      // Same grant, same candidate, same attachmentIndex, a DIFFERENT
      // idempotencyKey -- this must be rejected outright, not replayed,
      // and must not re-run the stream/scan/job side effects.
      await expect(
        domain.receiveAttachment(
          {
            candidateId, attachmentIndex: 0, uploadGrantId: grant.uploadGrantId,
            expectedCandidateVersion: 1, idempotencyKey: "second-key",
          },
          chunks([bytes]),
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

      // Exactly one expense_files row for this attachment slot -- no
      // second file/job was created by the rejected re-use attempt.
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
      const scanner = createMailboxStagingScanner(storage, PatternMalwareScanner);
      // Corrupting storage double: every write succeeds, but readObject
      // for the file's own FINAL storage key (never the scan-staging key)
      // returns different bytes than were written -- simulating silent
      // storage corruption between write and read-back.
      const corruptingStorage: StorageAdapter = {
        ...storage,
        async readObject(storageKey: string) {
          if (storageKey.endsWith(".scan-staging")) return storage.readObject(storageKey);
          return Buffer.from("corrupted-on-persist");
        },
      };
      const filesDomain = createFilesDomain(database!, corruptingStorage, {
        mailboxScanner: scanner,
      });
      const temporalStarter = fakeTemporalStarter();
      const domain = createMailboxIngestionDomain(database!, {
        filesDomain, temporalStarter, plansDomain: fakePlansDomain(true),
      });
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
      const finalStat = await storage.statObject(fileRow.storage_key);
      expect(finalStat).toBeNull();
      expect(temporalStarter.calls).toHaveLength(0);
    });

    it("review #5: two concurrent attachment completions for the same candidate never create two processing_jobs rows", async () => {
      const bytesFor = (n: number) => Buffer.concat([pngBytes(), Buffer.from(`-dup-${n}`)]);
      const hashes = [0, 1].map((n) => sha256Hex(bytesFor(n)));
      const { candidateId } = seedQueuedCandidate({ attachmentSha256: hashes });
      const { domain } = createDomain();
      const grant = await domain.issueUploadGrant({
        candidateId, expectedCandidateVersion: 1, operationId: randomUUID(),
      });

      const [resultA, resultB] = await Promise.all([
        domain.receiveAttachment(
          {
            candidateId, attachmentIndex: 0, uploadGrantId: grant.uploadGrantId,
            expectedCandidateVersion: 1, idempotencyKey: randomUUID(),
          },
          chunks([bytesFor(0)]),
        ),
        domain.receiveAttachment(
          {
            candidateId, attachmentIndex: 1, uploadGrantId: grant.uploadGrantId,
            expectedCandidateVersion: 1, idempotencyKey: randomUUID(),
          },
          chunks([bytesFor(1)]),
        ),
      ]);
      expect(resultA.status).toBe("READY");
      expect(resultB.status).toBe("READY");

      const jobCount = await database!
        .selectFrom("app.processing_jobs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("source_file_id", "in", [resultA.fileId, resultB.fileId])
        .executeTakeFirstOrThrow();
      expect(Number(jobCount.count)).toBe(1);

      const candidateRow = await database!
        .selectFrom("app.mailbox_candidates").selectAll()
        .where("id", "=", candidateId).executeTakeFirstOrThrow();
      expect(candidateRow.processing_job_id).not.toBeNull();
    });

    it("review #6: two concurrent calls with the exact same idempotency key never both run side effects -- one succeeds, the other is rejected or replays the same result", async () => {
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
  },
);
