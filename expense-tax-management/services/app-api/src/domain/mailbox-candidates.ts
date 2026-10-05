/**
 * Phase 3D-B Task 5 — App-owned candidate review domain: authorized list/
 * detail reads and the review-action resolve transaction.
 *
 * App API owns candidate status/scope-assignment transitions (same split
 * as every other mailbox domain file here: the broker classifies and
 * stages via domain/mailbox-scans.ts's `recordCandidateMetadata`; this
 * module owns what happens to an already-staged candidate afterward).
 *
 * Authorization (spec "Scope and Review Behavior"): every list/detail/
 * mutation revalidates current tenant membership, connection status, and
 * owner-or-non-revoked-reviewer-grant access -- `authorizeCandidateAccess`
 * below. Assigning/reassigning an `ingest` action additionally
 * revalidates *current* membership in the target scope (spec:
 * "Assigning/reassigning requires current membership to target scope"),
 * checked at the moment of the action, not cached from an earlier read.
 *
 * Review actions (spec):
 * - ingest: assign authorized scope and queue processing (3D-C owns the
 *   actual attachment/OCR/structured-HTML ingestion step; this task only
 *   assigns scope and moves status to "queued").
 * - skip / not_receipt: both terminal, no expense. Migration 019's
 *   `mailbox_candidates_status_check` has no distinct `not_receipt`
 *   status value (that enum slot is the *candidate's classification*,
 *   already recorded); both actions set status `skipped` and are told
 *   apart in the audit trail only, via a distinct `recordAuditEvent`
 *   action string (own ruling -- migration 019 predates this task and is
 *   Task-1-owned/already-reviewed-clean, so this reconciles the mockup's
 *   two-button requirement without touching that migration).
 * - retry: allowed only when the candidate is `failed` AND its errorCode
 *   is one of the typed *transient* Gmail codes (spec: "retry: allowed
 *   for typed transient failure only"). 3D-B's own `recordCandidateMetadata`
 *   never produces a `failed` candidate yet (Task 4's own Concerns note:
 *   `failed` stays 0) -- this is a forward-looking guard for 3D-C's
 *   ingestion failures, proven here against directly-seeded fixture rows.
 *
 * A candidate already in a terminal status (`processed`/`duplicate`/
 * `skipped`/`failed`) is rejected by this domain's own guard *before* any
 * UPDATE is attempted -- migration 019's terminal-immutability trigger
 * would reject the same UPDATE at the database level, but a clean typed
 * `DomainError.conflict()` here is friendlier than a raw trigger
 * exception, and covers a `duplicate`-status candidate (set by some other
 * process, e.g. a future Phase 3B cross-channel dedup pass) the same way.
 */
import { randomUUID } from "node:crypto";

import {
  AI_WORKER_TASK_QUEUE,
  MAILBOX_MATERIALIZE_RESULT_SCHEMA_VERSION,
  MAILBOX_MATERIALIZE_WORKFLOW_TYPE,
  MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE,
  TARGET_TEMPORAL_NAMESPACE,
  type JobReferenceV1,
  type MailboxCandidateClassification,
  type MailboxCandidateStatus,
  type MailboxCandidateV1,
  type MailboxErrorCodeV1,
  type MailboxIngestionBucketV1,
  type MailboxIngestionProgressV1,
  type MailboxScope,
  type ProcessingJobStatus,
} from "@expense-tax/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";

import type { AppDatabase } from "../database/types.js";
import { readDispatchRoutingForShare } from "./dispatch-routing.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import { requireScopeRole } from "./files.js";
import { hashNormalizedRequest, toJsonValue } from "./idempotency.js";

type ConnectionRow = Selectable<AppDatabase["app.mailbox_connections"]>;
type CandidateRow = Selectable<AppDatabase["app.mailbox_candidates"]>;

/** Phase 3D-C Task 5 gap closure (controller ruling, progress.md): a
 * processing_jobs row is "in flight" for the one-non-terminal-job-per-
 * candidate guard below until it reaches either terminal status. */
const TERMINAL_JOB_STATUSES = new Set<ProcessingJobStatus>(["SUCCEEDED", "FAILED"]);
/** Same target-aggregate convention as every other job type here (e.g.
 * applyOcrExtraction's "expense"); this job's target is the candidate
 * itself, not an expense -- it never materializes one directly. */
const MATERIALIZE_TARGET_AGGREGATE_TYPE = "mailbox_candidate";

/**
 * Controller ruling (progress.md): resolving a candidate as `ingest`
 * creates, in the SAME transaction, a processing job for
 * MailboxMaterializeWorkflow -- stamped with the fixed TypeScript target
 * (TARGET_TEMPORAL_NAMESPACE/AI_WORKER_TASK_QUEUE) while recording the
 * current dispatch_generation, exactly mirroring Task 3's own
 * createMailboxOcrJobInTransaction (domain/mailbox-ingestion.ts) -- plus
 * its dispatch outbox row, so the existing dispatchPendingJobs path starts
 * and retries it. Not reusing processing-jobs.ts's createJobInTransaction:
 * that helper always stamps the LIVE app.temporal_dispatch_routing
 * namespace/queue, never a caller-fixed override, which this workflow type
 * requires (no Python implementation, ever).
 *
 * Idempotent: looks up the most recent MailboxMaterializeWorkflow job
 * targeting this candidate; if one exists and is NOT yet terminal
 * (PENDING/DISPATCHED/RUNNING), reuses it instead of enqueueing a
 * duplicate -- "at most one non-terminal materialize job per candidate".
 * A terminal-FAILED prior job is superseded by a fresh one (this is what
 * lets a later `ingest` call -- after a `retry` review action clears a
 * materialize failure back to `review` -- re-enqueue).
 */
async function ensureMaterializeJobInTransaction(
  transaction: Transaction<AppDatabase>,
  candidate: CandidateRow,
): Promise<string> {
  const existing = await transaction
    .selectFrom("app.processing_jobs")
    .select(["id", "status"])
    .where("target_aggregate_type", "=", MATERIALIZE_TARGET_AGGREGATE_TYPE)
    .where("target_aggregate_id", "=", candidate.id)
    .where("workflow_type", "=", MAILBOX_MATERIALIZE_WORKFLOW_TYPE)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  if (existing && !TERMINAL_JOB_STATUSES.has(existing.status)) {
    return existing.id;
  }

  const jobId = randomUUID();
  const workflowId = `job-${jobId}`;
  const now = new Date();
  // Fence (Task 7 Stage A): still reads the live routing row FOR SHARE so
  // a concurrent operator `advance` is blocked until this transaction
  // commits, and so dispatch_generation is a valid, current value for the
  // NOT NULL/CHECK-constrained column -- but the stamped task_queue/
  // dispatch_namespace are the FIXED TypeScript-worker target, never the
  // live row's own values (same ruling as Task 3's own mailbox OCR job).
  const dispatchTarget = await readDispatchRoutingForShare(transaction);
  await transaction
    .insertInto("app.processing_jobs")
    .values({
      id: jobId,
      tenant_id: candidate.tenant_id,
      personal_profile_id: candidate.candidate_personal_profile_id,
      business_id: candidate.candidate_business_id,
      workflow_type: MAILBOX_MATERIALIZE_WORKFLOW_TYPE,
      workflow_id: workflowId,
      task_queue: AI_WORKER_TASK_QUEUE,
      dispatch_generation: dispatchTarget.generation,
      dispatch_namespace: TARGET_TEMPORAL_NAMESPACE,
      run_id: null,
      status: "PENDING",
      target_aggregate_type: MATERIALIZE_TARGET_AGGREGATE_TYPE,
      target_aggregate_id: candidate.id,
      expected_aggregate_version: null,
      requested_by_user_id: null,
      source_file_id: null,
      input_params: toJsonValue({
        mailboxCandidateId: candidate.id,
        mailboxConnectionId: candidate.connection_id,
      }),
      allowed_result_schema_version: MAILBOX_MATERIALIZE_RESULT_SCHEMA_VERSION,
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
        workflowType: MAILBOX_MATERIALIZE_WORKFLOW_TYPE,
        workflowId,
      } satisfies JobReferenceV1),
      status: "PENDING",
      attempts: 0,
      last_error: null,
      created_at: now,
      dispatched_at: null,
    })
    .execute();
  return jobId;
}

/**
 * Fully terminal for every review action, including `retry`. `failed` is
 * deliberately excluded here -- migration 019's trigger allows exactly
 * one narrow exception (`failed` -> `review`, the `retry` action), so
 * `failed` is instead gated action-specifically below: rejected for
 * `ingest`/`skip`/`not_receipt`, accepted for `retry` only when the
 * candidate's errorCode is a typed transient code.
 */
const TERMINAL_CANDIDATE_STATUSES = new Set<MailboxCandidateStatus>([
  "processed",
  "duplicate",
  "skipped",
]);

/** Spec: "Gmail 429/5xx: bounded retries" -- the only two typed codes a
 * `retry` review action may ever clear. Every other code (reauth,
 * permission, validation, conflict) is permanent from the reviewer's
 * point of view -- re-running the exact same request would fail again. */
const TRANSIENT_MAILBOX_ERROR_CODES = new Set<MailboxErrorCodeV1>([
  "GOOGLE_RATE_LIMITED",
  "GOOGLE_UNAVAILABLE",
]);

/**
 * Phase 3D-C Task 5 gap closure 2 -- the two codes
 * maybeFailMailboxCandidateInTransaction (processing-jobs.ts) ever
 * stamps on a candidate it fails. Unlike the Gmail-transient codes above
 * (which need re-discovery, hence retry -> 'review'), the staged
 * candidate data behind these was never bad -- only the processing
 * attempt failed -- so retry re-enqueues a fresh materialize job and
 * goes straight back to 'queued', same scope, no reviewer input needed.
 */
const PROCESSING_TRANSIENT_MAILBOX_ERROR_CODES = new Set<MailboxErrorCodeV1>([
  "OCR_EXTRACTION_FAILED",
  "MAILBOX_MATERIALIZE_FAILED",
]);

function toMailboxScopeOrNull(
  row: Pick<CandidateRow, "candidate_personal_profile_id" | "candidate_business_id">,
): MailboxScope | null {
  if (row.candidate_personal_profile_id !== null) {
    return { kind: "personal", profileId: row.candidate_personal_profile_id };
  }
  if (row.candidate_business_id !== null) {
    return { kind: "business", businessId: row.candidate_business_id };
  }
  return null;
}

function toMailboxCandidateV1(
  row: CandidateRow,
  ingestionProgress: MailboxIngestionProgressV1 | null = null,
): MailboxCandidateV1 {
  return {
    schemaVersion: 1,
    id: row.id,
    scanRunId: row.scan_run_id,
    connectionId: row.connection_id,
    tenantId: row.tenant_id,
    receivedAt: row.received_at.toISOString(),
    senderAddress: row.sender_address,
    senderDomain: row.sender_domain,
    subject: row.subject,
    contentHash: row.content_hash,
    attachmentManifest: row.attachment_manifest as unknown as MailboxCandidateV1["attachmentManifest"],
    classification: row.classification,
    confidence: Number(row.confidence),
    evidence: [...row.evidence],
    scope: toMailboxScopeOrNull(row),
    status: row.status,
    processingJobId: row.processing_job_id,
    expenseId: row.expense_id,
    sourceId: row.source_id,
    duplicateMatchId: row.duplicate_match_id,
    ingestionProgress,
    version: row.version,
    idempotencyKey: row.idempotency_key,
    errorCode: row.error_code as MailboxErrorCodeV1 | null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Phase 3D-C Task 6 fix round 1 (review finding #4) -- the Office
 * ingestion-status board's three sections, each its own status set (plus
 * the implicit "approved for ingestion at least once" scope-assigned
 * filter every bucket shares -- see isMailboxIngestionCandidate's own
 * frontend mirror, lib/mailbox.ts). Indexed by the existing
 * mailbox_candidates_review_queue_index (tenant_id, connection_id,
 * status) -- no new index needed.
 */
const INGESTION_BUCKET_STATUSES: Record<MailboxIngestionBucketV1, readonly MailboxCandidateStatus[]> = {
  in_progress: ["queued"],
  needs_attention: ["duplicate", "review", "failed"],
  completed: ["processed"],
};

/**
 * Phase 3D-C Task 6 fix round 1 (review finding #1) -- batch-loads every
 * MailboxMaterializeWorkflow/MailboxOcrReceiptWorkflow processing_jobs
 * row for the given (queued) candidate IDs in two bounded queries (never
 * N+1), and reduces them to the read-only phase/count summary described
 * on MailboxIngestionProgressV1Schema. Returns null for a candidate with
 * no materialize job yet, or whose materialize job hasn't reached RUNNING
 * (still plain "Queued", nothing richer to report) or has already gone
 * terminal with nothing pending (about to leave 'queued' -- a narrow
 * race, not worth a distinct label).
 */
async function loadIngestionProgress(
  database: Kysely<AppDatabase> | Transaction<AppDatabase>,
  candidates: readonly Pick<CandidateRow, "id" | "attachment_manifest">[],
): Promise<Map<string, MailboxIngestionProgressV1>> {
  const result = new Map<string, MailboxIngestionProgressV1>();
  if (candidates.length === 0) return result;
  const candidateIds = candidates.map((candidate) => candidate.id);

  const materializeRows = await database
    .selectFrom("app.processing_jobs")
    .select(["target_aggregate_id", "status", "created_at"])
    .where("workflow_type", "=", MAILBOX_MATERIALIZE_WORKFLOW_TYPE)
    .where("target_aggregate_type", "=", "mailbox_candidate")
    .where("target_aggregate_id", "in", candidateIds)
    .orderBy("created_at", "desc")
    .execute();
  const latestMaterializeStatus = new Map<string, ProcessingJobStatus>();
  for (const row of materializeRows) {
    const candidateId = row.target_aggregate_id;
    if (candidateId && !latestMaterializeStatus.has(candidateId)) {
      latestMaterializeStatus.set(candidateId, row.status);
    }
  }

  const ocrRows = await database
    .selectFrom("app.processing_jobs")
    .select([sql<string>`input_params ->> 'mailboxCandidateId'`.as("candidate_id"), "status"])
    .where("workflow_type", "=", MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE)
    .where(sql<string>`input_params ->> 'mailboxCandidateId'`, "in", candidateIds)
    .execute();
  const ocrStatusesByCandidate = new Map<string, ProcessingJobStatus[]>();
  for (const row of ocrRows) {
    if (!row.candidate_id) continue;
    const list = ocrStatusesByCandidate.get(row.candidate_id) ?? [];
    list.push(row.status);
    ocrStatusesByCandidate.set(row.candidate_id, list);
  }

  const PENDING_JOB_STATUSES = new Set<ProcessingJobStatus>(["PENDING", "DISPATCHED", "RUNNING"]);
  for (const candidate of candidates) {
    const materializeStatus = latestMaterializeStatus.get(candidate.id) ?? null;
    const ocrStatuses = ocrStatusesByCandidate.get(candidate.id) ?? [];
    const pending = ocrStatuses.filter((status) => PENDING_JOB_STATUSES.has(status)).length;

    let phase: MailboxIngestionProgressV1["phase"] | null = null;
    if (materializeStatus === "RUNNING") phase = "materializing";
    else if (materializeStatus === "SUCCEEDED" && pending > 0) phase = "processing_attachments";
    if (!phase) continue;

    const manifest = candidate.attachment_manifest as unknown as readonly unknown[];
    result.set(candidate.id, {
      phase,
      attachments: {
        total: manifest.length,
        succeeded: ocrStatuses.filter((status) => status === "SUCCEEDED").length,
        failed: ocrStatuses.filter((status) => status === "FAILED").length,
        pending,
      },
    });
  }
  return result;
}

function encodeCandidateCursor(receivedAt: Date, id: string): string {
  return Buffer.from(`${receivedAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

function decodeCandidateCursor(cursor: string): { receivedAt: Date; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf("|");
  const receivedAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (separator < 0 || Number.isNaN(receivedAt.getTime()) || !id) throw DomainError.validation();
  return { receivedAt, id };
}

/**
 * Spec: "Every connection/candidate list, detail, and mutation
 * revalidates current tenant membership, connection status/version,
 * owner or non-revoked reviewer grant, and grant version... No
 * tenant-admin shortcut grants access to Personal/business candidate
 * data... Revoked connection/grant immediately removes read and mutation
 * access." Fix round 1 (review Important #2): ordinary Personal/business
 * scope membership (`requireScopeRole`) is deliberately NOT an access
 * path here -- only the connection's owner or an exact, currently
 * non-revoked `mailbox_reviewer_grants` row may read/mutate its
 * candidates. Generic scope membership stays scoped to `ingest`'s own
 * *target*-scope check below, which the spec names as a separate,
 * additional requirement ("Review assignment additionally revalidates
 * target-scope membership"), not a substitute for connection-level
 * authorization.
 *
 * A connection's own current `status` is revalidated fresh on every call
 * (this function always re-reads the row; nothing is cached from an
 * earlier request): only a fully `revoked` connection blocks read/
 * mutation access -- `reauth_required` does not (mockup owner decision:
 * "Reauthorization blocks scanning only; already-staged candidates stay
 * fully reviewable").
 */
async function requireActiveTenantMembership(
  database: Kysely<AppDatabase>,
  actorUserId: string,
  tenantId: string,
): Promise<void> {
  const membership = await database
    .selectFrom("app.tenant_memberships")
    .select(["user_id"])
    .where("tenant_id", "=", tenantId)
    .where("user_id", "=", actorUserId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!membership) throw DomainError.forbidden();
}

async function authorizeCandidateAccess(
  database: Kysely<AppDatabase>,
  input: { readonly actorUserId: string; readonly tenantId: string; readonly connectionId: string },
): Promise<ConnectionRow> {
  const connection = await database
    .selectFrom("app.mailbox_connections")
    .selectAll()
    .where("id", "=", input.connectionId)
    .where("tenant_id", "=", input.tenantId)
    .executeTakeFirst();
  if (!connection) throw DomainError.notFound();

  await requireActiveTenantMembership(database, input.actorUserId, input.tenantId);
  if (connection.status === "revoked") throw DomainError.forbidden();

  if (connection.owner_user_id === input.actorUserId) return connection;

  const grant = await database
    .selectFrom("app.mailbox_reviewer_grants")
    .select(["id"])
    .where("connection_id", "=", input.connectionId)
    .where("user_id", "=", input.actorUserId)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  if (grant) return connection;

  throw DomainError.forbidden();
}

export type MailboxCandidateReviewAction = "ingest" | "skip" | "not_receipt" | "retry";

export interface ListCandidatesInput {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly classification?: MailboxCandidateClassification;
  /** Fix round 1 (review finding #4) -- Office ingestion-status board
   * section; mutually independent of `classification` (candidate review
   * uses one, ingestion status uses the other). */
  readonly bucket?: MailboxIngestionBucketV1;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListCandidatesResult {
  readonly items: readonly MailboxCandidateV1[];
  readonly nextCursor: string | null;
  /** Present only when `bucket` was given -- total matching rows for this
   * bucket within the connection (ignores cursor/limit), for the
   * approved gate's "Showing N of M" footer. */
  readonly totalCount?: number;
}

export interface ResolveCandidateInput {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly candidateId: string;
  readonly action: MailboxCandidateReviewAction;
  /** Required for `action: "ingest"`; ignored otherwise. */
  readonly scope?: MailboxScope;
  readonly expectedCandidateVersion: number;
  readonly requestId: string;
}

export interface MailboxCandidatesDomain {
  listCandidates(input: ListCandidatesInput): Promise<ListCandidatesResult>;
  resolveCandidate(input: ResolveCandidateInput): Promise<MailboxCandidateV1>;
}

export function createMailboxCandidatesDomain(
  database: Kysely<AppDatabase>,
  deps: { readonly mailboxEnabled: boolean },
): MailboxCandidatesDomain {
  return {
    async listCandidates(input) {
      await authorizeCandidateAccess(database, input);
      const limit = input.limit ?? 50;
      const cursor = input.cursor ? decodeCandidateCursor(input.cursor) : null;
      const bucketStatuses = input.bucket ? INGESTION_BUCKET_STATUSES[input.bucket] : null;

      let query = database
        .selectFrom("app.mailbox_candidates")
        .selectAll()
        .where("tenant_id", "=", input.tenantId)
        .where("connection_id", "=", input.connectionId);
      if (input.classification) query = query.where("classification", "=", input.classification);
      if (bucketStatuses) {
        query = query
          .where("status", "in", bucketStatuses)
          .where((eb) =>
            eb.or([
              eb("candidate_personal_profile_id", "is not", null),
              eb("candidate_business_id", "is not", null),
            ]),
          );
      }

      // Fix round 1 (review finding #4) -- total count for this bucket
      // (ignoring cursor/limit), for the approved gate's "Showing N of M"
      // footer. Same WHERE as the list query above (indexed by the
      // existing mailbox_candidates_review_queue_index); only computed
      // when a bucket was requested -- the candidate review panel's own
      // classification-filtered calls never pay for this extra query.
      let totalCount: number | undefined;
      if (bucketStatuses) {
        const countRow = await database
          .selectFrom("app.mailbox_candidates")
          .select((eb) => eb.fn.countAll().as("count"))
          .where("tenant_id", "=", input.tenantId)
          .where("connection_id", "=", input.connectionId)
          .where("status", "in", bucketStatuses)
          .where((eb) =>
            eb.or([
              eb("candidate_personal_profile_id", "is not", null),
              eb("candidate_business_id", "is not", null),
            ]),
          )
          .executeTakeFirst();
        totalCount = Number(countRow?.count ?? 0);
      }

      if (cursor) {
        query = query.where((eb) =>
          eb.or([
            eb("received_at", "<", cursor.receivedAt),
            eb.and([eb("received_at", "=", cursor.receivedAt), eb("id", "<", cursor.id)]),
          ]),
        );
      }

      const rows = await query
        .orderBy("received_at", "desc")
        .orderBy("id", "desc")
        .limit(limit + 1)
        .execute();
      const items = rows.slice(0, limit);
      const last = items.at(-1);

      // Fix round 1 (review finding #1) -- batch-computed, never N+1.
      const progressByCandidateId = await loadIngestionProgress(
        database,
        items.filter((row) => row.status === "queued"),
      );

      return {
        items: items.map((row) => toMailboxCandidateV1(row, progressByCandidateId.get(row.id) ?? null)),
        nextCursor: rows.length > limit && last ? encodeCandidateCursor(last.received_at, last.id) : null,
        ...(totalCount !== undefined ? { totalCount } : {}),
      };
    },

    async resolveCandidate(input) {
      await authorizeCandidateAccess(database, input);

      if (input.action === "ingest") {
        // Controller ruling (progress.md): ingest creates a
        // MailboxMaterializeWorkflow job below -- refuse the whole action
        // before any side effect when the mailbox feature is off, same
        // "feature off, not misconfigured" convention as app.ts's own
        // route-level FEATURE_DISABLED gates.
        if (!deps.mailboxEnabled) throw DomainError.featureDisabled();
        if (!input.scope) throw DomainError.validation();
        // Spec: "Assigning/reassigning requires current membership to
        // target scope" -- checked fresh at action time, independent of
        // whatever authorized `authorizeCandidateAccess` above (the
        // connection's own owning scope may differ from the target scope
        // a reviewer is assigning this candidate into).
        await requireScopeRole(database, {
          actorUserId: input.actorUserId,
          tenantId: input.tenantId,
          scope: input.scope,
        });
      }

      const operationKey = `resolve-candidate:${input.candidateId}`;
      const payloadHash = hashNormalizedRequest({
        action: input.action,
        scope: input.scope ?? null,
        expectedCandidateVersion: input.expectedCandidateVersion,
      });

      return database.transaction().execute(async (transaction) => {
        const candidate = await transaction
          .selectFrom("app.mailbox_candidates")
          .selectAll()
          .where("id", "=", input.candidateId)
          .where("tenant_id", "=", input.tenantId)
          .where("connection_id", "=", input.connectionId)
          .forUpdate()
          .executeTakeFirst();
        if (!candidate) throw DomainError.notFound();

        const existingKey = await transaction
          .selectFrom("app.mailbox_operation_keys")
          .select(["normalized_request_hash", "response_json"])
          .where("tenant_id", "=", input.tenantId)
          .where("operation_key", "=", operationKey)
          .where("idempotency_key", "=", input.requestId)
          .executeTakeFirst();
        if (existingKey) {
          if (existingKey.normalized_request_hash !== payloadHash) {
            throw DomainError.idempotencyConflict();
          }
          return existingKey.response_json as unknown as MailboxCandidateV1;
        }

        // A terminal candidate (processed/duplicate/skipped, including
        // one made `duplicate` by some other process) can never be
        // resolved again -- migration 019's own trigger would reject the
        // UPDATE below anyway; this typed check is the friendlier,
        // intentional first line.
        if (TERMINAL_CANDIDATE_STATUSES.has(candidate.status)) {
          throw DomainError.conflict();
        }
        // `failed` is terminal for every action except `retry` (migration
        // 019's trigger allows only the `failed` -> `review` transition).
        if (candidate.status === "failed" && input.action !== "retry") {
          throw DomainError.conflict();
        }
        if (candidate.version !== input.expectedCandidateVersion) {
          throw DomainError.versionConflict();
        }

        const now = new Date();
        let nextStatus: MailboxCandidateStatus;
        let scopeUpdate: { personal: string | null; business: string | null } = {
          personal: candidate.candidate_personal_profile_id,
          business: candidate.candidate_business_id,
        };
        let errorCodeUpdate: MailboxErrorCodeV1 | null = candidate.error_code as MailboxErrorCodeV1 | null;
        let materializeJobId: string | null = candidate.processing_job_id;

        if (input.action === "ingest") {
          const scope = input.scope as MailboxScope;
          nextStatus = "queued";
          scopeUpdate =
            scope.kind === "personal"
              ? { personal: scope.profileId, business: null }
              : { personal: null, business: scope.businessId };
          // Controller ruling: at most one non-terminal materialize job
          // per candidate; a terminal-FAILED prior job is superseded.
          materializeJobId = await ensureMaterializeJobInTransaction(transaction, {
            ...candidate,
            candidate_personal_profile_id: scopeUpdate.personal,
            candidate_business_id: scopeUpdate.business,
          });
        } else if (input.action === "skip" || input.action === "not_receipt") {
          nextStatus = "skipped";
        } else {
          // retry
          if (candidate.status !== "failed") throw DomainError.conflict();
          const currentErrorCode = candidate.error_code as MailboxErrorCodeV1 | null;
          // Gap closure 2: migration 019's own terminal-immutability
          // trigger allows exactly one transition out of 'failed' --
          // 'failed' -> 'review', nothing else (not directly to
          // 'queued', however tempting that shortcut looks) -- so a
          // processing-caused failure (OCR_EXTRACTION_FAILED/
          // MAILBOX_MATERIALIZE_FAILED) retries the exact same way a
          // Gmail-transient one already does: clear to 'review', no job
          // created here. The candidate data itself was never bad for
          // either category, so the reviewer's very next action is
          // simply `ingest` again (same scope) -- which already
          // re-enqueues a fresh materialize job, per
          // ensureMaterializeJobInTransaction's own terminal-FAILED
          // supersede rule above.
          const isRetryableErrorCode =
            currentErrorCode !== null &&
            (TRANSIENT_MAILBOX_ERROR_CODES.has(currentErrorCode) ||
              PROCESSING_TRANSIENT_MAILBOX_ERROR_CODES.has(currentErrorCode));
          if (!isRetryableErrorCode) throw DomainError.conflict();
          nextStatus = "review";
          errorCodeUpdate = null;
        }

        const updated = await transaction
          .updateTable("app.mailbox_candidates")
          .set({
            status: nextStatus,
            candidate_personal_profile_id: scopeUpdate.personal,
            candidate_business_id: scopeUpdate.business,
            error_code: errorCodeUpdate,
            processing_job_id: materializeJobId,
            version: candidate.version + 1,
            updated_at: now,
          })
          .where("id", "=", candidate.id)
          .where("version", "=", candidate.version)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw DomainError.versionConflict();

        const result = toMailboxCandidateV1(updated);

        await recordAuditEvent(transaction, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: `mailbox_candidate.${input.action}`,
          outcome: "success",
          resourceType: "mailbox_candidate",
          resourceId: candidate.id,
          requestId: input.requestId,
        });

        await transaction
          .insertInto("app.mailbox_operation_keys")
          .values({
            id: randomUUID(),
            tenant_id: input.tenantId,
            connection_id: input.connectionId,
            operation_key: operationKey,
            idempotency_key: input.requestId,
            normalized_request_hash: payloadHash,
            response_json: toJsonValue(result),
            created_at: now,
          })
          .execute();

        return result;
      });
    },
  };
}
