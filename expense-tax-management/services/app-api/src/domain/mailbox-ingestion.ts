/**
 * Phase 3D-C Task 3 -- App-side streaming-to-storage, malware scan, and OCR
 * handoff for mailbox attachments, plus the atomic transaction-level
 * expense/provenance/dedup path for both the attachment-OCR and
 * structured-HTML-receipt materialization routes.
 *
 * Three broker-facing operations (routes/mailbox-ingestion.ts calls these
 * directly, matching MailboxIngestionAppClient's issueUploadGrant/
 * uploadAttachment/submitStructuredResult):
 * - issueUploadGrant: mints a short-lived upload grant for a `queued`
 *   candidate.
 * - receiveAttachment: validates the grant, delegates the actual bounded
 *   stream/scan/hash work to FilesDomain.writeMailboxAttachment, and --
 *   only once READY -- creates the mailbox OCR job (MailboxOcrReceiptWorkflow)
 *   and dispatches it directly (bypassing the generation-fenced dispatch
 *   pipeline entirely: Task 1 ruling, packages/contracts/src/internal/
 *   task-queues.ts).
 * - submitStructuredReceipt: the structured-HTML path never creates a
 *   file/OCR job at all -- it materializes the expense, connected
 *   provenance, and Phase 3B dedup atomically in one transaction, via
 *   recordConnectedMailboxEvidenceInTransaction (also reused by ocr.ts's
 *   applyMailboxOcrExtraction for the attachment-OCR path, so both paths
 *   share one materialization implementation).
 *
 * Idempotency: every operation here keys off
 * app.mailbox_ingestion_operations (migration 020), the same
 * "look the row up by the triple, compare the stored hash" pattern
 * domain/mailbox-candidates.ts's resolveCandidate already uses against its
 * own app.mailbox_operation_keys table. Unlike that table's pure
 * append-only cache, this ledger is capable of pending -> started ->
 * completed|failed staging (for the long-running materialize_candidate
 * reconcile a later task owns) -- the three operations here are each a
 * single atomic transaction, so they go straight to 'completed' in one
 * INSERT; there is no crash window between "side effects committed" and
 * "ledger row written" to stage for.
 */
import { randomUUID } from "node:crypto";

import {
  AI_WORKER_TASK_QUEUE,
  MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE,
  OCR_EXTRACTION_RESULT_SCHEMA_VERSION,
  TARGET_TEMPORAL_NAMESPACE,
  type JobReferenceV1,
  type MailboxAttachmentUploadResultV1,
  type MailboxBrokerAttachmentUploadV1,
  type MailboxBrokerUploadGrantRequestV1,
  type MailboxBrokerUploadGrantV1,
  type MailboxMaterializationResultV1,
  type MailboxOcrJobActorV1,
  type MailboxStructuredReceiptCallbackV1,
} from "@expense-tax/contracts";
import { type Kysely, type Selectable, type Transaction } from "kysely";

import type { AppDatabase } from "../database/types.js";
import type { TemporalWorkflowStarter } from "../temporal/client.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import {
  addMatch,
  buildDeduplicationFingerprint,
  buildMatchIdempotencyKey,
  findDeterministicCandidates,
} from "./deduplication.js";
// Not processing-jobs.ts's createJobInTransaction: importing it here would
// create a 3-node ESM cycle (processing-jobs -> ocr -> mailbox-ingestion ->
// processing-jobs) on top of the existing 2-node processing-jobs <-> ocr
// cycle -- same risk enrichment-jobs.ts's own doc comment already flags
// and avoids by inlining instead of reusing createJobInTransaction.
import { readDispatchRoutingForShare } from "./dispatch-routing.js";
import { insertExpenseInTransaction } from "./expenses.js";
import type { FileScope, FilesDomain } from "./files.js";
import { hashNormalizedRequest, toJsonValue } from "./idempotency.js";

type CandidateRow = Selectable<AppDatabase["app.mailbox_candidates"]>;
type ConnectionRow = Selectable<AppDatabase["app.mailbox_connections"]>;

const UPLOAD_GRANT_TTL_MS = 15 * 60 * 1_000;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505"
  );
}

function candidateFileScope(candidate: CandidateRow): FileScope {
  if (candidate.candidate_personal_profile_id) {
    return { kind: "personal", profileId: candidate.candidate_personal_profile_id };
  }
  if (candidate.candidate_business_id) {
    return { kind: "business", businessId: candidate.candidate_business_id };
  }
  throw DomainError.validation();
}

/**
 * "connection_default" when the candidate's assigned (target) scope
 * equals the connection's own owning scope -- the ordinary case, an
 * ingest of the connection owner's own mail. "review_assignment" when a
 * reviewer assigned the candidate to a *different* scope than the
 * connection's own (spec: Review assignment); the connection owner
 * didn't request that scope's ingestion, so the job is attributed to the
 * service principal instead of (mis)attributing it to the owner or the
 * reviewing user.
 */
function resolveMailboxOcrActor(
  candidate: CandidateRow,
  connection: ConnectionRow,
): MailboxOcrJobActorV1 {
  const isConnectionDefaultScope =
    candidate.candidate_personal_profile_id === connection.personal_profile_id &&
    candidate.candidate_business_id === connection.business_id;
  return isConnectionDefaultScope
    ? { kind: "user", requestedByUserId: connection.owner_user_id }
    : { kind: "service", actorServicePrincipal: "mailbox-broker-app" };
}

/**
 * Atomically materializes a connected-mailbox candidate's extracted
 * fields: expense + connected app.expense_sources provenance
 * (source_type='connected_mailbox', mailbox_candidate_id) + Phase 3B
 * pending dedup (fingerprint + deterministic duplicate-match check,
 * reusing deduplication.ts's own exported primitives) + the candidate's
 * own status/expense_id/source_id/duplicate_match_id update -- all in the
 * caller's transaction. Shared by submitStructuredReceipt (structured-HTML
 * path, no OCR job) and ocr.ts's applyMailboxOcrExtraction (attachment-OCR
 * path, called from processing-jobs.ts's submitResult). FAILED results
 * never call this: no expense/provenance is ever created for them.
 *
 * `candidate` must already be locked FOR UPDATE by the caller in this same
 * transaction, and its status already verified 'queued' -- this function
 * does not re-check either (same "caller owns the lock" precedent as
 * applyOcrExtraction).
 */
export async function recordConnectedMailboxEvidenceInTransaction(
  transaction: Transaction<AppDatabase>,
  input: {
    readonly candidate: CandidateRow;
    readonly connection: ConnectionRow;
    readonly merchant: string;
    readonly amount: string;
    readonly currency: string;
    readonly incurredOn: string;
    readonly orderNumber: string | null;
    readonly notes: string | null;
    readonly processingJobId: string | null;
    readonly requestedByUserId: string | null;
    readonly requestId: string;
  },
): Promise<{
  readonly status: "processed" | "duplicate";
  readonly expenseId: string;
  readonly sourceId: string;
  readonly duplicateMatchId: string | null;
}> {
  const { candidate } = input;
  const scope = candidateFileScope(candidate);
  const actorUserId = input.requestedByUserId ?? input.connection.owner_user_id;

  const expense = await insertExpenseInTransaction(transaction, {
    actorUserId,
    tenantId: input.candidate.tenant_id,
    request: {
      ...(scope.kind === "personal"
        ? { personalProfileId: scope.profileId }
        : { businessId: scope.businessId }),
      merchant: input.merchant,
      description: input.notes,
      amount: input.amount,
      currency: input.currency,
      incurredOn: input.incurredOn,
    },
    requestId: input.requestId,
    scope,
    source: "connected_mailbox",
    // Phase 3C enrichment is created explicitly below (once), same
    // "ocr-deferred" convention applyOcrExtraction already uses to avoid
    // a duplicate enrichment job.
    mode: "ocr-deferred",
  });

  const sourceId = randomUUID();
  await transaction
    .insertInto("app.expense_sources")
    .values({
      id: sourceId,
      tenant_id: candidate.tenant_id,
      personal_profile_id: scope.kind === "personal" ? scope.profileId : null,
      business_id: scope.kind === "business" ? scope.businessId : null,
      expense_id: expense.id,
      source_type: "connected_mailbox",
      source_file_id: null,
      inbound_email_id: null,
      mailbox_candidate_id: candidate.id,
      metadata: toJsonValue(input.orderNumber ? { orderNumber: input.orderNumber } : {}),
    })
    .execute();

  const fingerprint = buildDeduplicationFingerprint({
    merchant: input.merchant,
    amount: input.amount,
    currency: input.currency,
    incurredOn: input.incurredOn,
  });

  let duplicateMatchId: string | null = null;
  if (fingerprint) {
    await transaction
      .insertInto("app.expense_dedup_fingerprints")
      .values({
        id: randomUUID(),
        tenant_id: candidate.tenant_id,
        personal_profile_id: scope.kind === "personal" ? scope.profileId : null,
        business_id: scope.kind === "business" ? scope.businessId : null,
        expense_id: expense.id,
        fingerprint_version: fingerprint.version,
        normalized_merchant: fingerprint.normalizedMerchant,
        amount_minor_units: fingerprint.amountMinorUnits,
        currency: fingerprint.currency,
        incurred_on: new Date(`${fingerprint.incurredOn}T00:00:00.000Z`),
        fingerprint_hash: fingerprint.hash,
      })
      .onConflict((oc) => oc.columns(["expense_id", "fingerprint_version"]).doNothing())
      .execute();

    let fingerprintQuery = transaction
      .selectFrom("app.expense_dedup_fingerprints as fingerprint")
      .innerJoin("app.expenses as existing_expense", (join) =>
        join
          .onRef("existing_expense.id", "=", "fingerprint.expense_id")
          .onRef("existing_expense.tenant_id", "=", "fingerprint.tenant_id")
          .on("existing_expense.status", "<>", "archived"),
      )
      .selectAll("fingerprint")
      .where("fingerprint.tenant_id", "=", candidate.tenant_id)
      .where("fingerprint.normalized_merchant", "=", fingerprint.normalizedMerchant);
    fingerprintQuery =
      scope.kind === "personal"
        ? fingerprintQuery
            .where("fingerprint.personal_profile_id", "=", scope.profileId)
            .where("fingerprint.business_id", "is", null)
        : fingerprintQuery
            .where("fingerprint.business_id", "=", scope.businessId)
            .where("fingerprint.personal_profile_id", "is", null);
    const existingFingerprints = await fingerprintQuery.execute();

    const candidates = findDeterministicCandidates({
      scope,
      candidateExpenseId: expense.id,
      file: { expenseId: null, sha256Hex: null, personalProfileId: null, businessId: null },
      fingerprint,
      files: [],
      fingerprints: existingFingerprints.map((row) => ({
        expenseId: row.expense_id,
        fingerprintHash: row.fingerprint_hash,
        normalizedMerchant: row.normalized_merchant,
        amountMinorUnits: Number(row.amount_minor_units),
        currency: row.currency,
        incurredOn: row.incurred_on,
        personalProfileId: row.personal_profile_id,
        businessId: row.business_id,
      })),
    });
    const firstMatch = candidates[0];
    if (firstMatch) {
      duplicateMatchId = await addMatch(transaction, {
        tenantId: candidate.tenant_id,
        scope,
        candidateExpenseId: expense.id,
        existingExpenseId: firstMatch.existingExpenseId,
        matchType: firstMatch.matchType,
        confidence: firstMatch.confidence,
        evidence: firstMatch.evidence,
        idempotencyKey: buildMatchIdempotencyKey(
          input.requestId,
          firstMatch.matchType,
          firstMatch.existingExpenseId,
        ),
      });
    }
  }

  const status = duplicateMatchId ? ("duplicate" as const) : ("processed" as const);
  await transaction
    .updateTable("app.mailbox_candidates")
    .set({
      status,
      expense_id: expense.id,
      source_id: sourceId,
      duplicate_match_id: duplicateMatchId,
      processing_job_id: input.processingJobId,
      version: candidate.version + 1,
      updated_at: new Date(),
    })
    .where("id", "=", candidate.id)
    .execute();

  await recordAuditEvent(transaction, {
    tenantId: candidate.tenant_id,
    actorUserId: input.requestedByUserId,
    actorServicePrincipal: input.requestedByUserId ? null : "mailbox-broker-app",
    action: "mailbox_candidate.materialized",
    outcome: "success",
    resourceType: "mailbox_candidate",
    resourceId: candidate.id,
    requestId: input.requestId,
  });

  return { status, expenseId: expense.id, sourceId, duplicateMatchId };
}

export interface MailboxIngestionDomain {
  issueUploadGrant(
    input: MailboxBrokerUploadGrantRequestV1,
  ): Promise<MailboxBrokerUploadGrantV1>;
  receiveAttachment(
    input: MailboxBrokerAttachmentUploadV1,
    source: AsyncIterable<Buffer>,
  ): Promise<MailboxAttachmentUploadResultV1>;
  submitStructuredReceipt(
    input: MailboxStructuredReceiptCallbackV1,
  ): Promise<MailboxMaterializationResultV1>;
  /**
   * Convenience wrapper over recordConnectedMailboxEvidenceInTransaction
   * (own transaction). Not wired into any HTTP route -- the brief names
   * it as one of this domain's four exposed methods, but neither
   * MailboxIngestionAppClient nor routes/mailbox-ingestion.ts names a
   * corresponding wire call; submitStructuredReceipt and ocr.ts's
   * applyMailboxOcrExtraction both call the transaction-threaded function
   * directly instead (same "caller owns the transaction boundary"
   * precedent as createEnrichmentJobInTransaction/applyOcrExtraction).
   * Kept for interface-literal fidelity and standalone testability.
   */
  recordConnectedMailboxEvidence(input: {
    readonly candidateId: string;
    readonly merchant: string;
    readonly amount: string;
    readonly currency: string;
    readonly incurredOn: string;
    readonly orderNumber: string | null;
    readonly notes: string | null;
    readonly requestId: string;
  }): Promise<MailboxMaterializationResultV1>;
}

export function createMailboxIngestionDomain(
  database: Kysely<AppDatabase>,
  deps: {
    readonly filesDomain: FilesDomain;
    readonly temporalStarter: TemporalWorkflowStarter;
  },
): MailboxIngestionDomain {
  async function requireCandidate(candidateId: string): Promise<CandidateRow> {
    const candidate = await database
      .selectFrom("app.mailbox_candidates")
      .selectAll()
      .where("id", "=", candidateId)
      .executeTakeFirst();
    if (!candidate) throw DomainError.notFound();
    return candidate;
  }

  /**
   * Inlined job-row + dispatch-outbox insert (not processing-jobs.ts's
   * createJobInTransaction -- see the import comment above for why), same
   * shape as enrichment-jobs.ts's own createEnrichmentJobInTransaction.
   * Unlike that function, the stamped task_queue/dispatch_namespace are
   * the FIXED TypeScript-worker target (TARGET_TEMPORAL_NAMESPACE /
   * AI_WORKER_TASK_QUEUE), not whatever app.temporal_dispatch_routing
   * currently says -- this workflow type has no Python implementation and
   * never will (Task 1 ruling), so it is dispatched directly below
   * regardless of the generation-routing table's current state.
   * readDispatchRoutingForShare is still called (fence + a valid >=1
   * generation number for the NOT NULL/CHECK-constrained column), its
   * namespace/task_queue return values are simply not used.
   */
  async function dispatchMailboxOcrJobIfAbsent(
    locked: CandidateRow,
    fileId: string,
    requestId: string,
  ): Promise<void> {
    if (locked.processing_job_id !== null) return;
    const connection = await database
      .selectFrom("app.mailbox_connections")
      .selectAll()
      .where("id", "=", locked.connection_id)
      .executeTakeFirstOrThrow();
    const actor = resolveMailboxOcrActor(locked, connection);
    const scope = candidateFileScope(locked);

    const jobId = randomUUID();
    const workflowId = `job-${jobId}`;
    const now = new Date();
    await database.transaction().execute(async (transaction) => {
      const dispatchTarget = await readDispatchRoutingForShare(transaction);
      await transaction
        .insertInto("app.processing_jobs")
        .values({
          id: jobId,
          tenant_id: locked.tenant_id,
          personal_profile_id: scope.kind === "personal" ? scope.profileId : null,
          business_id: scope.kind === "business" ? scope.businessId : null,
          workflow_type: MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE,
          workflow_id: workflowId,
          task_queue: AI_WORKER_TASK_QUEUE,
          dispatch_generation: dispatchTarget.generation,
          dispatch_namespace: TARGET_TEMPORAL_NAMESPACE,
          run_id: null,
          status: "PENDING",
          target_aggregate_type: "expense",
          target_aggregate_id: null,
          expected_aggregate_version: null,
          requested_by_user_id: actor.kind === "user" ? actor.requestedByUserId : null,
          source_file_id: fileId,
          input_params: toJsonValue({
            modeKey: "ocr_mode_fast",
            mailboxCandidateId: locked.id,
            mailboxConnectionId: locked.connection_id,
          }),
          allowed_result_schema_version: OCR_EXTRACTION_RESULT_SCHEMA_VERSION,
          result: null,
          error_message: null,
          version: 1,
          created_at: now,
          updated_at: now,
          dispatched_at: null,
          completed_at: null,
        })
        .execute();
      await transaction
        .insertInto("app.processing_job_dispatch_outbox")
        .values({
          id: randomUUID(),
          processing_job_id: jobId,
          job_reference: toJsonValue({
            schemaVersion: 1,
            jobId,
            workflowType: MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE,
            workflowId,
          }),
          status: "PENDING",
          attempts: 0,
          last_error: null,
          created_at: now,
          dispatched_at: null,
        })
        .execute();
      await recordAuditEvent(transaction, {
        tenantId: locked.tenant_id,
        actorServicePrincipal:
          actor.kind === "service" ? actor.actorServicePrincipal : null,
        actorUserId: actor.kind === "user" ? actor.requestedByUserId : null,
        action: "processing_job.created",
        outcome: "success",
        resourceType: "processing_job",
        resourceId: jobId,
        requestId,
      });
      await transaction
        .updateTable("app.mailbox_candidates")
        .set({ processing_job_id: jobId, updated_at: now })
        .where("id", "=", locked.id)
        .where("processing_job_id", "is", null)
        .execute();
    });

    // Mailbox workflow types bypass the generation-fenced dispatch
    // pipeline entirely (Task 1 ruling) -- dispatch directly against the
    // fixed TypeScript worker namespace/queue rather than waiting for
    // dispatchPendingJobs' generation-routed outbox poll. Same
    // "create row, then start workflow directly, then mark DISPATCHED"
    // shape as temporal/mailbox-schedules.ts's dispatchIfStarted.
    const jobReference: JobReferenceV1 = {
      schemaVersion: 1,
      jobId,
      workflowType: MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE,
      workflowId,
    };
    const started = await deps.temporalStarter.start({
      workflowType: MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE,
      workflowId,
      taskQueue: AI_WORKER_TASK_QUEUE,
      namespace: TARGET_TEMPORAL_NAMESPACE,
      args: [jobReference],
    });
    const dispatchedAt = new Date();
    await database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("app.processing_job_dispatch_outbox")
        .set({ status: "DISPATCHED", dispatched_at: dispatchedAt })
        .where("processing_job_id", "=", jobId)
        .where("status", "=", "PENDING")
        .execute();
      await transaction
        .updateTable("app.processing_jobs")
        .set((eb) => ({
          status: "DISPATCHED",
          run_id: started.runId,
          dispatched_at: dispatchedAt,
          updated_at: dispatchedAt,
          version: eb("version", "+", 1),
        }))
        .where("id", "=", jobId)
        .where("status", "=", "PENDING")
        .execute();
    });
  }

  return {
    async issueUploadGrant(input) {
      const candidate = await requireCandidate(input.candidateId);
      const operationKey = `issue-upload-grant:${input.candidateId}`;
      const requestHash = hashNormalizedRequest({
        candidateId: input.candidateId,
        expectedCandidateVersion: input.expectedCandidateVersion,
      });

      const existing = await database
        .selectFrom("app.mailbox_ingestion_operations")
        .select(["normalized_request_hash", "response_json"])
        .where("tenant_id", "=", candidate.tenant_id)
        .where("operation_key", "=", operationKey)
        .where("idempotency_key", "=", input.operationId)
        .executeTakeFirst();
      if (existing) {
        if (existing.normalized_request_hash !== requestHash) {
          throw DomainError.idempotencyConflict();
        }
        return existing.response_json as unknown as MailboxBrokerUploadGrantV1;
      }

      if (candidate.status !== "queued") throw DomainError.conflict();
      if (candidate.version !== input.expectedCandidateVersion) {
        throw DomainError.versionConflict();
      }

      const grant: MailboxBrokerUploadGrantV1 = {
        candidateId: input.candidateId,
        connectionId: candidate.connection_id,
        uploadGrantId: randomUUID(),
        expiresAt: new Date(Date.now() + UPLOAD_GRANT_TTL_MS).toISOString(),
        maxBytes: 26214400,
        maxAttachments: 5,
      };

      try {
        await database
          .insertInto("app.mailbox_ingestion_operations")
          .values({
            id: randomUUID(),
            tenant_id: candidate.tenant_id,
            connection_id: candidate.connection_id,
            candidate_id: input.candidateId,
            operation_kind: "issue_upload_grant",
            operation_key: operationKey,
            idempotency_key: input.operationId,
            normalized_request_hash: requestHash,
            response_json: toJsonValue(grant),
            status: "completed",
            version: 1,
            error_code: null,
            created_at: new Date(),
            updated_at: new Date(),
          })
          .execute();
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const replay = await database
          .selectFrom("app.mailbox_ingestion_operations")
          .select(["normalized_request_hash", "response_json"])
          .where("tenant_id", "=", candidate.tenant_id)
          .where("operation_key", "=", operationKey)
          .where("idempotency_key", "=", input.operationId)
          .executeTakeFirstOrThrow();
        if (replay.normalized_request_hash !== requestHash) {
          throw DomainError.idempotencyConflict();
        }
        return replay.response_json as unknown as MailboxBrokerUploadGrantV1;
      }
      return grant;
    },

    async receiveAttachment(input, source) {
      const candidate = await requireCandidate(input.candidateId);
      const operationKey = `upload-attachment:${input.candidateId}:${input.attachmentIndex}`;
      const requestHash = hashNormalizedRequest({
        candidateId: input.candidateId,
        attachmentIndex: input.attachmentIndex,
        uploadGrantId: input.uploadGrantId,
        expectedCandidateVersion: input.expectedCandidateVersion,
      });

      const existing = await database
        .selectFrom("app.mailbox_ingestion_operations")
        .select(["normalized_request_hash", "response_json"])
        .where("tenant_id", "=", candidate.tenant_id)
        .where("operation_key", "=", operationKey)
        .where("idempotency_key", "=", input.idempotencyKey)
        .executeTakeFirst();
      if (existing) {
        if (existing.normalized_request_hash !== requestHash) {
          throw DomainError.idempotencyConflict();
        }
        return existing.response_json as unknown as MailboxAttachmentUploadResultV1;
      }

      const grantRows = await database
        .selectFrom("app.mailbox_ingestion_operations")
        .select(["response_json"])
        .where("tenant_id", "=", candidate.tenant_id)
        .where("candidate_id", "=", input.candidateId)
        .where("operation_kind", "=", "issue_upload_grant")
        .where("status", "=", "completed")
        .orderBy("created_at", "desc")
        .execute();
      const grant = grantRows
        .map((row) => row.response_json as unknown as MailboxBrokerUploadGrantV1)
        .find((candidateGrant) => candidateGrant.uploadGrantId === input.uploadGrantId);
      if (!grant) throw DomainError.notFound();
      if (new Date(grant.expiresAt).getTime() < Date.now()) throw DomainError.gone();

      const result = await deps.filesDomain.writeMailboxAttachment(
        {
          candidateId: input.candidateId,
          attachmentIndex: input.attachmentIndex,
          uploadGrantId: input.uploadGrantId,
          expectedCandidateVersion: input.expectedCandidateVersion,
          actorServicePrincipal: "mailbox-broker-app",
          requestId: input.idempotencyKey,
        },
        source,
      );

      if (result.status === "READY") {
        const locked = await requireCandidate(input.candidateId);
        await dispatchMailboxOcrJobIfAbsent(locked, result.fileId, input.idempotencyKey);
      }

      try {
        await database
          .insertInto("app.mailbox_ingestion_operations")
          .values({
            id: randomUUID(),
            tenant_id: candidate.tenant_id,
            connection_id: candidate.connection_id,
            candidate_id: input.candidateId,
            operation_kind: "upload_attachment",
            operation_key: operationKey,
            idempotency_key: input.idempotencyKey,
            normalized_request_hash: requestHash,
            response_json: toJsonValue(result),
            status: "completed",
            version: 1,
            error_code: result.errorCode,
            created_at: new Date(),
            updated_at: new Date(),
          })
          .execute();
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }

      return result;
    },

    async submitStructuredReceipt(input) {
      const candidate = await requireCandidate(input.result.candidateId);
      const operationKey = `submit-structured-result:${input.result.candidateId}`;
      const requestHash = hashNormalizedRequest(input.result);

      const existing = await database
        .selectFrom("app.mailbox_ingestion_operations")
        .select(["normalized_request_hash", "response_json"])
        .where("tenant_id", "=", candidate.tenant_id)
        .where("operation_key", "=", operationKey)
        .where("idempotency_key", "=", input.idempotencyKey)
        .executeTakeFirst();
      if (existing) {
        if (existing.normalized_request_hash !== requestHash) {
          throw DomainError.idempotencyConflict();
        }
        return existing.response_json as unknown as MailboxMaterializationResultV1;
      }

      return database.transaction().execute(async (transaction) => {
        const locked = await transaction
          .selectFrom("app.mailbox_candidates")
          .selectAll()
          .where("id", "=", input.result.candidateId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (locked.status !== "queued") throw DomainError.conflict();
        if (locked.version !== input.result.candidateVersion) {
          throw DomainError.versionConflict();
        }
        if (locked.connection_id !== input.result.connectionId) {
          throw DomainError.validation();
        }

        const connection = await transaction
          .selectFrom("app.mailbox_connections")
          .selectAll()
          .where("id", "=", locked.connection_id)
          .executeTakeFirstOrThrow();
        const actor = resolveMailboxOcrActor(locked, connection);

        const materialized = await recordConnectedMailboxEvidenceInTransaction(transaction, {
          candidate: locked,
          connection,
          merchant: input.result.merchant,
          amount: input.result.amount,
          currency: input.result.currency,
          incurredOn: input.result.incurredOn,
          orderNumber: input.result.orderNumber,
          notes: input.result.notes,
          processingJobId: null,
          requestedByUserId: actor.kind === "user" ? actor.requestedByUserId : null,
          requestId: input.idempotencyKey,
        });

        const result: MailboxMaterializationResultV1 = {
          schemaVersion: 1,
          candidateId: locked.id,
          status: materialized.status,
          processingJobId: null,
          expenseId: materialized.expenseId,
          sourceId: materialized.sourceId,
          duplicateMatchId: materialized.duplicateMatchId,
          idempotencyKey: input.idempotencyKey,
        };

        await transaction
          .insertInto("app.mailbox_ingestion_operations")
          .values({
            id: randomUUID(),
            tenant_id: locked.tenant_id,
            connection_id: locked.connection_id,
            candidate_id: locked.id,
            operation_kind: "submit_structured_result",
            operation_key: operationKey,
            idempotency_key: input.idempotencyKey,
            normalized_request_hash: requestHash,
            response_json: toJsonValue(result),
            status: "completed",
            version: 1,
            error_code: null,
            created_at: new Date(),
            updated_at: new Date(),
          })
          .execute();

        return result;
      });
    },

    async recordConnectedMailboxEvidence(input) {
      return database.transaction().execute(async (transaction) => {
        const locked = await transaction
          .selectFrom("app.mailbox_candidates")
          .selectAll()
          .where("id", "=", input.candidateId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (locked.status !== "queued") throw DomainError.conflict();
        const connection = await transaction
          .selectFrom("app.mailbox_connections")
          .selectAll()
          .where("id", "=", locked.connection_id)
          .executeTakeFirstOrThrow();
        const actor = resolveMailboxOcrActor(locked, connection);
        const materialized = await recordConnectedMailboxEvidenceInTransaction(transaction, {
          candidate: locked,
          connection,
          merchant: input.merchant,
          amount: input.amount,
          currency: input.currency,
          incurredOn: input.incurredOn,
          orderNumber: input.orderNumber,
          notes: input.notes,
          processingJobId: locked.processing_job_id,
          requestedByUserId: actor.kind === "user" ? actor.requestedByUserId : null,
          requestId: input.requestId,
        });
        return {
          schemaVersion: 1 as const,
          candidateId: locked.id,
          status: materialized.status,
          processingJobId: locked.processing_job_id,
          expenseId: materialized.expenseId,
          sourceId: materialized.sourceId,
          duplicateMatchId: materialized.duplicateMatchId,
          idempotencyKey: input.requestId,
        };
      });
    },
  };
}
