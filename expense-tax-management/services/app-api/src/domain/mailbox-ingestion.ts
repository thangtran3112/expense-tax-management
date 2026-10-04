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
  CurrencySchema,
  DateOnlySchema,
  DecimalMoneySchema,
  MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE,
  MailboxStructuredReceiptEvidenceSchema,
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
import { z } from "zod";

import type { AppDatabase } from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import {
  addMatch,
  buildDeduplicationFingerprint,
  buildMatchIdempotencyKey,
  findDeterministicCandidates,
} from "./deduplication.js";
import { createEnrichmentJobInTransaction } from "./enrichment-jobs.js";
// Not processing-jobs.ts's createJobInTransaction: importing it here would
// create a 3-node ESM cycle (processing-jobs -> ocr -> mailbox-ingestion ->
// processing-jobs) on top of the existing 2-node processing-jobs <-> ocr
// cycle -- same risk enrichment-jobs.ts's own doc comment already flags
// and avoids by inlining instead of reusing createJobInTransaction.
import { readDispatchRoutingForShare } from "./dispatch-routing.js";
import { insertExpenseInTransaction } from "./expenses.js";
import type { FileScope, FilesDomain } from "./files.js";
import { hashNormalizedRequest, toJsonValue } from "./idempotency.js";
import type { PlansDomain } from "./plans.js";

/**
 * Task 4 -- the structured-HTML path is attacker-influenced (a crafted
 * schema.org receipt in an email the mailbox owner did not write) and
 * must never be trusted blindly: re-validates merchant/amount/currency/
 * date with the exact canonical schemas OcrExtractionResultV1Schema
 * already enforces for the attachment-OCR path (processing-jobs.ts's
 * submitResult), so both materialization paths share one trust bar. A
 * failure here throws before any side effect -- the candidate stays
 * `queued` so a separate attachment-OCR upload for the same candidate
 * (if any) can still materialize it; this function creates no "failed"
 * ledger row because the failure is deterministic (a retry with
 * identical input would fail the same way).
 */
const StructuredReceiptFieldsSchema = z.strictObject({
  merchant: z.string().trim().min(1).max(200),
  amount: DecimalMoneySchema,
  currency: CurrencySchema,
  incurredOn: DateOnlySchema,
  orderNumber: z.string().trim().min(1).max(200).nullable(),
  // Fix round 1 (review Important #2) -- re-validated here too, not just
  // at the route: a direct domain caller (this file's own
  // recordConnectedMailboxEvidence wrapper is exempt by always passing
  // []; but any future caller of submitStructuredReceipt that bypasses
  // the HTTP route must not be able to smuggle raw HTML/text through
  // evidence any more than it can through merchant/amount/currency/date.
  evidence: MailboxStructuredReceiptEvidenceSchema,
});

function validateStructuredReceiptFields(result: MailboxStructuredReceiptCallbackV1["result"]): {
  readonly merchant: string;
  readonly amount: string;
  readonly currency: string;
  readonly incurredOn: string;
  readonly orderNumber: string | null;
  readonly evidence: readonly string[];
} {
  const parsed = StructuredReceiptFieldsSchema.safeParse({
    merchant: result.merchant,
    amount: result.amount,
    currency: result.currency,
    incurredOn: result.incurredOn,
    orderNumber: result.orderNumber,
    evidence: result.evidence,
  });
  if (!parsed.success) throw DomainError.validation();
  return parsed.data;
}

type CandidateRow = Selectable<AppDatabase["app.mailbox_candidates"]>;
type ConnectionRow = Selectable<AppDatabase["app.mailbox_connections"]>;
type IngestionOperationRow = Selectable<AppDatabase["app.mailbox_ingestion_operations"]>;

const UPLOAD_GRANT_TTL_MS = 15 * 60 * 1_000;

/**
 * Fix round 2 (review Important #5) -- how long a 'started' ledger claim
 * is trusted to still be genuinely in flight before a same-key retry is
 * allowed to re-claim it. Generous relative to a 25 MiB upload over any
 * reasonable network: long enough that a live, still-uploading attempt is
 * never preempted; short enough that a crashed attempt's claim recovers
 * within one operator-visible interval rather than being stuck forever.
 */
const CLAIM_LEASE_MS = 2 * 60 * 1_000;

/**
 * Fix round 1 (review Important #3) -- the fixed modeKey ("ocr_mode_fast")
 * was never gated on the tenant's own connected_mailbox_scan entitlement
 * before this round, unlike every other mailbox-scan/review entry point
 * (domain/mailbox-scans.ts's own resolveEntitlementVersion checks the same
 * featureKey). Reused verbatim, not reinvented.
 */
async function requireConnectedMailboxEntitlement(
  plansDomain: PlansDomain,
  tenantId: string,
  actorUserId: string,
): Promise<void> {
  const entitlements = await plansDomain.resolveEffectiveEntitlements({
    tenantId,
    actorUserId,
  });
  const entitlement = entitlements.find(
    (candidate) => candidate.featureKey === "connected_mailbox_scan",
  );
  if (!entitlement?.isEnabled) throw DomainError.forbidden();
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
    /**
     * Structured-HTML parser evidence (e.g. "schema_type:Order",
     * "field:totalPrice") -- this parser's own vocabulary (Task 2's
     * report), always short names, never raw HTML/text. The
     * attachment-OCR path (ocr.ts's applyMailboxOcrExtraction) has no
     * such evidence and passes an empty array.
     */
    readonly evidence: readonly string[];
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
      metadata: toJsonValue({
        ...(input.orderNumber ? { orderNumber: input.orderNumber } : {}),
        ...(input.evidence.length > 0 ? { evidence: input.evidence } : {}),
      }),
    })
    .execute();

  // Phase 3C enrichment, created transactionally like every other
  // source (applyOcrExtraction's own unconditional post-insert call) --
  // regardless of the dedup outcome below: enrichment and dedup are
  // independent concerns, same precedent as the legacy OCR path (where
  // enrichment runs in this same transaction while dedup evidence is
  // recorded separately by the ai-worker after the job succeeds).
  await createEnrichmentJobInTransaction(transaction, {
    tenantId: candidate.tenant_id,
    scope:
      scope.kind === "personal"
        ? { personalProfileId: scope.profileId }
        : { businessId: scope.businessId },
    expenseId: expense.id,
    expectedExpenseVersion: expense.version,
    requestedByUserId: actorUserId,
    requestId: input.requestId,
  });

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
    readonly plansDomain: PlansDomain;
  },
): MailboxIngestionDomain {
  /**
   * Fix round 2 (review Important #4 + new Important #6).
   *
   * One job PER ATTACHMENT, not one per candidate: keyed by
   * source_file_id (each attachment's own fileId is unique, minted once
   * by files.ts's writeMailboxAttachment), not by
   * mailbox_candidates.processing_job_id -- that single nullable column
   * can no longer express "which of several jobs". It is still written,
   * but only later, by recordConnectedMailboxEvidenceInTransaction, as
   * "the job that actually materialized this candidate" (descriptive,
   * first-writer-wins), never as a creation-time uniqueness gate.
   * Idempotent on retry: looks up an existing job for this exact fileId
   * first and returns it unchanged rather than inserting a second one.
   *
   * Dispatch (review new Important #6): this only ever inserts PENDING
   * job + PENDING outbox rows -- exactly createEnrichmentJobInTransaction's
   * own shape -- and never calls the Temporal client directly. The
   * stamped task_queue/dispatch_namespace are the FIXED TypeScript-worker
   * target (TARGET_TEMPORAL_NAMESPACE/AI_WORKER_TASK_QUEUE), not whatever
   * app.temporal_dispatch_routing currently says (this workflow type has
   * no Python implementation and never will: Task 1 ruling) -- but
   * dispatchPendingJobs (processing-jobs.ts), which every other job type
   * already relies on and which already retries on failure (attempts/
   * last_error), reads task_queue/dispatch_namespace from the ROW, not
   * from the live routing table, so reusing it here requires no special
   * casing and gets retry-on-dispatch-failure for free instead of the
   * one-shot post-commit call round 1 had. readDispatchRoutingForShare is
   * still called (fence + a valid >=1 generation number for the NOT
   * NULL/CHECK-constrained column), its own namespace/task_queue return
   * values are simply not used for the stamped columns.
   *
   * Returns null when the tenant's connected_mailbox_scan entitlement is
   * disabled (skip job creation; the finalize transaction still commits
   * the ledger completion) -- never throws for this case, since throwing
   * would roll back the finalize transaction and strand the ledger claim.
   */
  async function createMailboxOcrJobInTransaction(
    transaction: Transaction<AppDatabase>,
    candidateId: string,
    fileId: string,
    requestId: string,
  ): Promise<{ readonly jobId: string; readonly workflowId: string } | null> {
    const existingJob = await transaction
      .selectFrom("app.processing_jobs")
      .select(["id", "workflow_id"])
      .where("source_file_id", "=", fileId)
      .where("workflow_type", "=", MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE)
      .executeTakeFirst();
    if (existingJob) return { jobId: existingJob.id, workflowId: existingJob.workflow_id };

    const locked = await transaction
      .selectFrom("app.mailbox_candidates")
      .selectAll()
      .where("id", "=", candidateId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const connection = await transaction
      .selectFrom("app.mailbox_connections")
      .selectAll()
      .where("id", "=", locked.connection_id)
      .executeTakeFirstOrThrow();
    // Fix round 1 (review Important #3): receiveAttachment's phase 1
    // already refuses the whole upload up front when the entitlement is
    // disabled (before any side effect, so no ledger claim is ever left
    // stuck). This is a defense-in-depth re-check for the narrow window
    // between that claim and this finalize step.
    const entitlements = await deps.plansDomain.resolveEffectiveEntitlements({
      tenantId: locked.tenant_id,
      actorUserId: connection.owner_user_id,
    });
    const entitled = entitlements.find(
      (entitlement) => entitlement.featureKey === "connected_mailbox_scan",
    )?.isEnabled;
    if (!entitled) return null;
    const actor = resolveMailboxOcrActor(locked, connection);
    const scope = candidateFileScope(locked);

    const jobId = randomUUID();
    const workflowId = `job-${jobId}`;
    const now = new Date();
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
        } satisfies JobReferenceV1),
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

    return { jobId, workflowId };
  }

  return {
    async issueUploadGrant(input) {
      const operationKey = `issue-upload-grant:${input.candidateId}`;
      const requestHash = hashNormalizedRequest({
        candidateId: input.candidateId,
        expectedCandidateVersion: input.expectedCandidateVersion,
      });

      // Claim-first (review Important #6): the replay check, the
      // candidate's status/version check, and the eventual ledger insert
      // all happen under this one candidate FOR UPDATE lock, so two
      // concurrent callers with the same operationId serialize on the
      // lock instead of racing a bare unique-constraint-catch fallback.
      return database.transaction().execute(async (transaction) => {
        const candidate = await transaction
          .selectFrom("app.mailbox_candidates")
          .selectAll()
          .where("id", "=", input.candidateId)
          .forUpdate()
          .executeTakeFirst();
        if (!candidate) throw DomainError.notFound();

        const existing = await transaction
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

        await transaction
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
        return grant;
      });
    },

    async receiveAttachment(input, source) {
      // Fix round 2 (review Important #2): keyed by the uploadGrantId
      // itself, not (candidateId, attachmentIndex) -- a grant is consumed
      // exactly once, by whichever attachmentIndex first uses it
      // successfully; a second call referencing the SAME grant for the
      // SAME or a DIFFERENT attachmentIndex finds the identical
      // operationKey and is rejected below as a re-use (its
      // normalized_request_hash -- which embeds attachmentIndex -- will
      // never match a prior claim's for a different index, and the
      // idempotency_key already differs for a different index in
      // practice). The grant is still looked up/validated by
      // uploadGrantId further down, scoped to this operationKey's own
      // candidate.
      const operationKey = `upload-attachment:${input.candidateId}:${input.uploadGrantId}`;
      const requestHash = hashNormalizedRequest({
        candidateId: input.candidateId,
        attachmentIndex: input.attachmentIndex,
        uploadGrantId: input.uploadGrantId,
        expectedCandidateVersion: input.expectedCandidateVersion,
      });

      // Phase 1 ("claim"): one transaction, candidate FOR UPDATE. Claims
      // the ledger slot (status 'started') before any side effect runs
      // (review Important #6).
      const claim:
        | { readonly kind: "replay"; readonly result: MailboxAttachmentUploadResultV1 }
        | { readonly kind: "claimed"; readonly tenantId: string } =
        await database.transaction().execute(async (transaction) => {
          const candidate = await transaction
            .selectFrom("app.mailbox_candidates")
            .selectAll()
            .where("id", "=", input.candidateId)
            .forUpdate()
            .executeTakeFirst();
          if (!candidate) throw DomainError.notFound();

          const existingOperation: IngestionOperationRow | undefined = await transaction
            .selectFrom("app.mailbox_ingestion_operations")
            .selectAll()
            .where("tenant_id", "=", candidate.tenant_id)
            .where("operation_key", "=", operationKey)
            .executeTakeFirst();
          if (existingOperation) {
            if (
              existingOperation.idempotency_key !== input.idempotencyKey ||
              existingOperation.normalized_request_hash !== requestHash
            ) {
              // Same upload grant re-used (for the same or a different
              // attachmentIndex) with a different idempotency key or
              // payload -- reject. Grants are single-use: this is not a
              // replay.
              throw DomainError.idempotencyConflict();
            }
            if (existingOperation.status === "completed") {
              return {
                kind: "replay" as const,
                result: existingOperation.response_json as unknown as MailboxAttachmentUploadResultV1,
              };
            }
            // Fix round 2 (review Important #5): a 'started' claim with
            // the exact same key is either genuinely in flight (reject,
            // caller retries shortly) or stale -- its owning attempt
            // crashed/died before ever reaching phase 3's completion
            // UPDATE, and nothing will ever complete it otherwise. A
            // claim older than CLAIM_LEASE_MS is treated as stale: its
            // lease is re-claimed (bump updated_at; the forward-only
            // transition trigger explicitly allows a same-status
            // started -> started UPDATE) and this call proceeds through
            // phases 2/3 itself, same as a fresh claim.
            const staleForMs = Date.now() - existingOperation.updated_at.getTime();
            if (staleForMs < CLAIM_LEASE_MS) {
              throw DomainError.conflict();
            }
            await transaction
              .updateTable("app.mailbox_ingestion_operations")
              .set({ updated_at: new Date() })
              .where("id", "=", existingOperation.id)
              .execute();
            return { kind: "claimed" as const, tenantId: candidate.tenant_id };
          }

          if (candidate.version !== input.expectedCandidateVersion) {
            throw DomainError.versionConflict();
          }

          // Fix round 1 (review Important #3): refuse the whole upload
          // before any side effect (grant consumption, storage write, job
          // creation) when the tenant's connected_mailbox_scan entitlement
          // is disabled -- checked here, not only at job-creation time, so
          // a disabled tenant never leaves a stuck 'started' ledger claim
          // behind (this phase hasn't inserted one yet).
          const connection = await transaction
            .selectFrom("app.mailbox_connections")
            .select("owner_user_id")
            .where("id", "=", candidate.connection_id)
            .executeTakeFirstOrThrow();
          await requireConnectedMailboxEntitlement(
            deps.plansDomain,
            candidate.tenant_id,
            connection.owner_user_id,
          );

          const grantRows = await transaction
            .selectFrom("app.mailbox_ingestion_operations")
            .select(["response_json"])
            .where("tenant_id", "=", candidate.tenant_id)
            .where("candidate_id", "=", input.candidateId)
            .where("operation_kind", "=", "issue_upload_grant")
            .where("status", "=", "completed")
            .execute();
          const grant = grantRows
            .map((row) => row.response_json as unknown as MailboxBrokerUploadGrantV1)
            .find((candidateGrant) => candidateGrant.uploadGrantId === input.uploadGrantId);
          if (!grant) throw DomainError.notFound();
          if (new Date(grant.expiresAt).getTime() < Date.now()) throw DomainError.gone();

          await transaction
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
              response_json: null,
              status: "started",
              version: 1,
              error_code: null,
              created_at: new Date(),
              updated_at: new Date(),
            })
            .execute();

          return { kind: "claimed" as const, tenantId: candidate.tenant_id };
        });

      if (claim.kind === "replay") return claim.result;

      // Phase 2: the slow stream/bound/hash/scan/storage work, outside any
      // row lock (review Important #1: routes/mailbox-ingestion.ts streams
      // the raw request body straight into `source`, and files.ts streams
      // it straight into storage -- never buffering the full body in
      // memory anywhere in this path).
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

      // Phase 3 ("finalize"): completes the ledger claim and, only if
      // READY, creates the mailbox OCR job (PENDING job + PENDING outbox
      // row -- dispatchPendingJobs, the existing retrying dispatcher
      // every other job type already relies on, picks it up; review new
      // Important #6). Both happen in the same transaction: a dispatch
      // failure later is the generic dispatcher's own, already-solved
      // problem, not a reason to ever roll back the ledger completion.
      await database.transaction().execute(async (transaction) => {
        const updated = await transaction
          .updateTable("app.mailbox_ingestion_operations")
          .set({
            response_json: toJsonValue(result),
            status: "completed",
            error_code: result.errorCode,
            updated_at: new Date(),
          })
          .where("tenant_id", "=", claim.tenantId)
          .where("operation_key", "=", operationKey)
          .where("idempotency_key", "=", input.idempotencyKey)
          .where("status", "=", "started")
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) return;

        if (result.status === "READY") {
          await createMailboxOcrJobInTransaction(
            transaction,
            input.candidateId,
            result.fileId,
            input.idempotencyKey,
          );
        }
      });

      return result;
    },

    async submitStructuredReceipt(input) {
      const operationKey = `submit-structured-result:${input.result.candidateId}`;
      const requestHash = hashNormalizedRequest(input.result);

      return database.transaction().execute(async (transaction) => {
        const locked = await transaction
          .selectFrom("app.mailbox_candidates")
          .selectAll()
          .where("id", "=", input.result.candidateId)
          .forUpdate()
          .executeTakeFirst();
        if (!locked) throw DomainError.notFound();

        // Claim-first (review Important #6): the replay check happens
        // under this same candidate lock so a concurrent same-key racer
        // either sees the completed row (true replay) or blocks on the
        // lock until this call's own insert commits -- never duplicates
        // the expense/provenance/dedup side effects below.
        const existing = await transaction
          .selectFrom("app.mailbox_ingestion_operations")
          .select(["normalized_request_hash", "response_json"])
          .where("tenant_id", "=", locked.tenant_id)
          .where("operation_key", "=", operationKey)
          .where("idempotency_key", "=", input.idempotencyKey)
          .executeTakeFirst();
        if (existing) {
          if (existing.normalized_request_hash !== requestHash) {
            throw DomainError.idempotencyConflict();
          }
          return existing.response_json as unknown as MailboxMaterializationResultV1;
        }

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

        // Fix round 1 (review Important #1) -- the structured-HTML
        // callback never checked connected_mailbox_scan before, unlike
        // receiveAttachment's own claim phase: a disabled tenant could
        // still have a broker callback materialize an expense. Reuses the
        // exact same helper, gated before any materialization or ledger
        // write (the final insertInto below).
        await requireConnectedMailboxEntitlement(
          deps.plansDomain,
          locked.tenant_id,
          connection.owner_user_id,
        );

        // Never trust structured data blindly: the broker's parser already
        // validates these fields (Task 2), but this is the actual App-side
        // trust boundary -- a crafted/buggy payload must not reach
        // insertExpenseInTransaction. Throws before any side effect; the
        // candidate stays `queued` so an attachment-OCR upload for the same
        // candidate can still materialize it independently.
        const fields = validateStructuredReceiptFields(input.result);

        const actor = resolveMailboxOcrActor(locked, connection);

        const materialized = await recordConnectedMailboxEvidenceInTransaction(transaction, {
          candidate: locked,
          connection,
          merchant: fields.merchant,
          amount: fields.amount,
          currency: fields.currency,
          incurredOn: fields.incurredOn,
          orderNumber: fields.orderNumber,
          notes: input.result.notes,
          processingJobId: null,
          requestedByUserId: actor.kind === "user" ? actor.requestedByUserId : null,
          requestId: input.idempotencyKey,
          evidence: fields.evidence,
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
          evidence: [],
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
