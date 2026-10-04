import { randomUUID } from "node:crypto";

import {
  MAILBOX_MATERIALIZE_WORKFLOW_TYPE,
  MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE,
  OCR_EXTRACTION_RESULT_SCHEMA_VERSION,
  JobReferenceV1Schema,
  OcrExtractionResultV1Schema,
  type JobReferenceV1,
  type JobResultSubmitRequestV1,
  type JobStatusUpdateRequestV1,
  type ProcessingJob,
  type ProcessingJobStatus,
  type WorkflowType,
} from "@expense-tax/contracts";
import { sql, type Kysely, type Transaction } from "kysely";

import type { AppDatabase } from "../database/types.js";
import type { TemporalWorkflowStarter } from "../temporal/client.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import { readDispatchRoutingForShare } from "./dispatch-routing.js";
import { applyMailboxOcrExtraction, applyOcrExtraction } from "./ocr.js";
import {
  executeIdempotentMutation,
  hashNormalizedRequest,
  toJsonValue,
  type MutationResult,
} from "./idempotency.js";

import {
  toProcessingJob,
  type ProcessingJobRow,
} from "./processing-job-view.js";

export interface CreateProcessingJobInput {
  readonly tenantId: string;
  readonly scope:
    | { readonly personalProfileId: string; readonly businessId?: undefined }
    | { readonly businessId: string; readonly personalProfileId?: undefined };
  readonly workflowType: WorkflowType;
  readonly allowedResultSchemaVersion: string;
  readonly targetAggregateType?: string;
  readonly targetAggregateId?: string;
  readonly expectedAggregateVersion?: number;
  readonly requestedByUserId?: string;
  readonly sourceFileId?: string;
  readonly inputParams?: Readonly<Record<string, unknown>>;
  readonly actorServicePrincipal?: string;
  readonly actorUserId?: string;
  readonly requestId: string;
}

/**
 * Transaction-scoped job creation (job + dispatch outbox + audit
 * atomically). Exported so idempotent orchestrators (e.g. OCR job
 * creation) can run it inside THEIR idempotency-guarded transaction
 * instead of a nested one — calling createJob (own transaction) from
 * inside another transaction's execute() would commit side effects the
 * outer idempotency wrapper can no longer roll back on replay conflict.
 */
export async function createJobInTransaction(
  transaction: Transaction<AppDatabase>,
  input: CreateProcessingJobInput,
): Promise<ProcessingJob> {
  const jobId = randomUUID();
  const workflowId = `job-${jobId}`;
  const now = new Date();
  // Enqueue fence (Task 7 Stage A): every new job is stamped with the
  // dispatch target this transaction actually observed. FOR SHARE here
  // blocks a concurrent operator `advance` until this transaction commits.
  const dispatchTarget = await readDispatchRoutingForShare(transaction);
  const created = await transaction
    .insertInto("app.processing_jobs")
    .values({
      id: jobId,
      tenant_id: input.tenantId,
      personal_profile_id: input.scope.personalProfileId ?? null,
      business_id: input.scope.businessId ?? null,
      workflow_type: input.workflowType,
      workflow_id: workflowId,
      task_queue: dispatchTarget.taskQueue,
      dispatch_generation: dispatchTarget.generation,
      dispatch_namespace: dispatchTarget.namespace,
      run_id: null,
      status: "PENDING",
      target_aggregate_type: input.targetAggregateType ?? null,
      target_aggregate_id: input.targetAggregateId ?? null,
      expected_aggregate_version: input.expectedAggregateVersion ?? null,
      requested_by_user_id: input.requestedByUserId ?? null,
      source_file_id: input.sourceFileId ?? null,
      input_params: toJsonValue(input.inputParams ?? {}),
      allowed_result_schema_version: input.allowedResultSchemaVersion,
      result: null,
      error_message: null,
      version: 1,
      created_at: now,
      updated_at: now,
      dispatched_at: null,
      completed_at: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const jobReference: JobReferenceV1 = {
    schemaVersion: 1,
    jobId,
    workflowType: input.workflowType,
    workflowId,
  };
  await transaction
    .insertInto("app.processing_job_dispatch_outbox")
    .values({
      id: randomUUID(),
      processing_job_id: jobId,
      job_reference: toJsonValue(jobReference),
      status: "PENDING",
      attempts: 0,
      last_error: null,
      created_at: now,
      dispatched_at: null,
    })
    .execute();

  await recordAuditEvent(transaction, {
    tenantId: input.tenantId,
    actorServicePrincipal: input.actorServicePrincipal ?? null,
    actorUserId: input.actorUserId ?? null,
    action: "processing_job.created",
    outcome: "success",
    resourceType: "processing_job",
    resourceId: jobId,
    requestId: input.requestId,
  });

  return toProcessingJob(created);
}

export interface DispatchPendingJobsInput {
  readonly limit?: number;
}

export interface RecordStatusUpdateInput {
  readonly jobId: string;
  readonly request: JobStatusUpdateRequestV1;
  readonly actorServicePrincipal: string;
  readonly requestId: string;
}

export interface SubmitResultInput {
  readonly jobId: string;
  readonly request: JobResultSubmitRequestV1;
  readonly actorServicePrincipal: string;
  readonly requestId: string;
}

export interface ProcessingJobsDomain {
  createJob(input: CreateProcessingJobInput): Promise<ProcessingJob>;
  dispatchPendingJobs(
    input: DispatchPendingJobsInput,
  ): Promise<{ readonly dispatchedCount: number }>;
  recordStatusUpdate(
    input: RecordStatusUpdateInput,
  ): Promise<MutationResult<ProcessingJob, 200>>;
  submitResult(
    input: SubmitResultInput,
  ): Promise<MutationResult<ProcessingJob, 200>>;
  getJob(jobId: string): Promise<ProcessingJob>;
}

const STATUS_UPDATE_LEGAL_FROM: Record<
  JobStatusUpdateRequestV1["status"],
  readonly ProcessingJobStatus[]
> = {
  RUNNING: ["DISPATCHED", "RUNNING"],
  FAILED: ["DISPATCHED", "RUNNING"],
};

const RESULT_SUBMIT_LEGAL_FROM: readonly ProcessingJobStatus[] = [
  "DISPATCHED",
  "RUNNING",
];

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505"
  );
}

async function requireJobForUpdate(
  transaction: Transaction<AppDatabase>,
  jobId: string,
): Promise<ProcessingJobRow> {
  const row = await transaction
    .selectFrom("app.processing_jobs")
    .selectAll()
    .where("id", "=", jobId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw DomainError.notFound();
  return row;
}

/** Phase 3D-C Task 5 gap closure 2 -- the two mailbox job types whose
 * terminal failure can surface onto the candidate they target. */
const MAILBOX_CANDIDATE_JOB_WORKFLOW_TYPES = new Set<string>([
  MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE,
  MAILBOX_MATERIALIZE_WORKFLOW_TYPE,
]);

/**
 * Phase 3D-C Task 5 gap closure 2 (controller ruling) -- called from BOTH
 * submitResult's and recordStatusUpdate's own FAILED branches (the two
 * routes a mailbox job can reach terminal FAILED through: submitResult
 * via the legacy "status:FAILED result" shape, recordStatusUpdate via the
 * new combined activities' plain status-only ocr_mark_failed callback).
 *
 * Ruling (multi-attachment rule, spec-consistent): a candidate fails only
 * once EVERY mailbox job targeting it (the one MailboxMaterializeWorkflow
 * job, plus zero or more per-attachment MailboxOcrReceiptWorkflow jobs)
 * has reached a terminal state with none of them having succeeded.
 * - If the candidate's own status is no longer 'queued', a sibling
 *   already materialized it (recordConnectedMailboxEvidenceInTransaction's
 *   success path flips status away from 'queued' as its own first step)
 *   -- a later sibling's failure must never overwrite that "processed"
 *   result. This is "partial success records processed [...]": the
 *   candidate's own processing_jobs rows (queryable by
 *   input_params->>'mailboxCandidateId') are the per-attempt record of
 *   which attachment succeeded/failed; no separate counts column is
 *   added (smallest correct diff -- the jobs table already is that
 *   record).
 * - If the candidate is still 'queued' and every OTHER mailbox job for it
 *   (materialize or per-attachment OCR) has ALSO already reached
 *   SUCCEEDED/FAILED, the candidate fails now -- this is both "the
 *   materialize job itself failed" (no sibling OCR jobs were ever
 *   created) and "every attachment OCR job failed" (materialize
 *   succeeded, created N sibling jobs, this is the last one to fail).
 * - Otherwise (queued, but a sibling is still in flight) -- wait; the
 *   next sibling to reach a terminal state re-runs this same check.
 *
 * Forward-only/idempotent: only ever moves 'queued' -> 'failed' (a legal
 * forward move in the application-level status ordering every other
 * review-action transition already respects -- no database trigger
 * restricts app.mailbox_candidates.status transitions directly), gated
 * on the exact current status in the UPDATE's own WHERE clause so a
 * concurrent resolver can never race it into double-applying.
 */
async function maybeFailMailboxCandidateInTransaction(
  transaction: Transaction<AppDatabase>,
  job: Pick<ProcessingJobRow, "id" | "workflow_type" | "input_params">,
): Promise<void> {
  if (!MAILBOX_CANDIDATE_JOB_WORKFLOW_TYPES.has(job.workflow_type)) return;
  const candidateId = (job.input_params as Record<string, unknown> | null)?.mailboxCandidateId;
  if (typeof candidateId !== "string") return;

  const candidate = await transaction
    .selectFrom("app.mailbox_candidates")
    .select(["status"])
    .where("id", "=", candidateId)
    .forUpdate()
    .executeTakeFirst();
  if (!candidate || candidate.status !== "queued") return;

  const outstanding = await transaction
    .selectFrom("app.processing_jobs")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where("id", "!=", job.id)
    .where("status", "not in", ["SUCCEEDED", "FAILED"])
    .where(sql<string>`input_params ->> 'mailboxCandidateId'`, "=", candidateId)
    .executeTakeFirstOrThrow();
  if (Number(outstanding.count) > 0) return;

  const errorCode = job.workflow_type === MAILBOX_MATERIALIZE_WORKFLOW_TYPE
    ? "MAILBOX_MATERIALIZE_FAILED"
    : "OCR_EXTRACTION_FAILED";
  await transaction
    .updateTable("app.mailbox_candidates")
    .set({ status: "failed", error_code: errorCode, updated_at: new Date() })
    .where("id", "=", candidateId)
    .where("status", "=", "queued")
    .execute();
}

export function createProcessingJobsDomain(
  database: Kysely<AppDatabase>,
  temporalStarter: TemporalWorkflowStarter,
): ProcessingJobsDomain {
  return {
    async createJob(input) {
      return database.transaction().execute((transaction) =>
        createJobInTransaction(transaction, input),
      );
    },

    async dispatchPendingJobs(input) {
      const limit = input.limit ?? 25;
      const pending = await database
        .selectFrom("app.processing_job_dispatch_outbox as outbox")
        .innerJoin(
          "app.processing_jobs as job",
          "job.id",
          "outbox.processing_job_id",
        )
        .select([
          "outbox.id as outboxId",
          "job.id as jobId",
          "job.workflow_type as workflowType",
          "job.workflow_id as workflowId",
          "job.task_queue as taskQueue",
          "job.dispatch_namespace as dispatchNamespace",
        ])
        .where("outbox.status", "=", "PENDING")
        .orderBy("outbox.created_at", "asc")
        .limit(limit)
        .execute();

      let dispatchedCount = 0;
      for (const row of pending) {
        try {
          const jobReference = JobReferenceV1Schema.parse({
            schemaVersion: 1,
            jobId: row.jobId,
            workflowType: row.workflowType,
            workflowId: row.workflowId,
          });
          const result = await temporalStarter.start({
            workflowType: jobReference.workflowType,
            workflowId: row.workflowId,
            taskQueue: row.taskQueue,
            namespace: row.dispatchNamespace,
            args: [jobReference],
          });
          const now = new Date();
          await database.transaction().execute(async (transaction) => {
            await transaction
              .updateTable("app.processing_job_dispatch_outbox")
              .set({ status: "DISPATCHED", dispatched_at: now })
              .where("id", "=", row.outboxId)
              .execute();
            await transaction
              .updateTable("app.processing_jobs")
              .set((eb) => ({
                status: "DISPATCHED",
                run_id: result.runId,
                dispatched_at: now,
                updated_at: now,
                version: eb("version", "+", 1),
              }))
              .where("id", "=", row.jobId)
              .where("status", "=", "PENDING")
              .execute();
          });
          dispatchedCount += 1;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          await database
            .updateTable("app.processing_job_dispatch_outbox")
            .set((eb) => ({
              attempts: eb("attempts", "+", 1),
              last_error: message.slice(0, 2000),
            }))
            .where("id", "=", row.outboxId)
            .execute();
        }
      }
      return { dispatchedCount };
    },

    async recordStatusUpdate(input) {
      try {
        return await executeIdempotentMutation(database, {
          actorKey: `service:${input.actorServicePrincipal}`,
          operationKey: "processing-job.status-update",
          idempotencyKey: input.request.idempotencyKey,
          requestHash: hashNormalizedRequest(input.request),
          statusCode: 200,
          parseBody: (value) => value as ProcessingJob,
          execute: async (transaction) => {
            const job = await requireJobForUpdate(transaction, input.jobId);
            if (job.version !== input.request.expectedJobVersion) {
              throw DomainError.preconditionFailed();
            }
            const legalFrom = STATUS_UPDATE_LEGAL_FROM[input.request.status];
            if (!legalFrom.includes(job.status)) {
              throw DomainError.conflict();
            }
            const now = new Date();
            const updated = await transaction
              .updateTable("app.processing_jobs")
              .set({
                status: input.request.status,
                error_message: input.request.message ?? job.error_message,
                updated_at: now,
                version: job.version + 1,
                ...(input.request.status === "FAILED"
                  ? { completed_at: now }
                  : {}),
              })
              .where("id", "=", input.jobId)
              .returningAll()
              .executeTakeFirstOrThrow();
            if (input.request.status === "FAILED") {
              await maybeFailMailboxCandidateInTransaction(transaction, job);
            }
            await recordAuditEvent(transaction, {
              tenantId: job.tenant_id,
              actorServicePrincipal: input.actorServicePrincipal,
              action: "processing_job.status_updated",
              outcome: "success",
              resourceType: "processing_job",
              resourceId: input.jobId,
              requestId: input.requestId,
              metadata: { status: input.request.status },
            });
            return toProcessingJob(updated);
          },
        });
      } catch (error: unknown) {
        if (isUniqueViolation(error)) throw DomainError.conflict();
        throw error;
      }
    },

    async submitResult(input) {
      try {
        return await executeIdempotentMutation(database, {
          actorKey: `service:${input.actorServicePrincipal}`,
          operationKey: "processing-job.result-submit",
          idempotencyKey: input.request.idempotencyKey,
          requestHash: hashNormalizedRequest(input.request),
          statusCode: 200,
          parseBody: (value) => value as ProcessingJob,
          execute: async (transaction) => {
            const job = await requireJobForUpdate(transaction, input.jobId);
            if (job.version !== input.request.expectedJobVersion) {
              throw DomainError.preconditionFailed();
            }
            if (!RESULT_SUBMIT_LEGAL_FROM.includes(job.status)) {
              throw DomainError.conflict();
            }
            if (
              input.request.resultSchemaVersion !==
              job.allowed_result_schema_version
            ) {
              throw DomainError.validation();
            }
            // OCR extraction results materialize the expense atomically
            // with the job update: no placeholder drafts, no window where
            // the job is SUCCEEDED but the expense is missing. FAILED
            // results are stored only (never applied).
            let appliedExpenseId: string | null = null;
            if (
              input.request.status === "SUCCEEDED" &&
              input.request.resultSchemaVersion ===
                OCR_EXTRACTION_RESULT_SCHEMA_VERSION &&
              job.target_aggregate_type === "expense"
            ) {
              const extraction = OcrExtractionResultV1Schema.safeParse(
                input.request.result,
              );
              if (!extraction.success) throw DomainError.validation();
              appliedExpenseId =
                job.workflow_type === MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE
                  ? await applyMailboxOcrExtraction(transaction, {
                      job,
                      extraction: extraction.data,
                      requestId: input.requestId,
                    })
                  : await applyOcrExtraction(transaction, {
                      job,
                      extraction: extraction.data,
                      requestId: input.requestId,
                    });
            }
            // Mailbox job failure (materialize or per-attachment OCR): the
            // candidate never advances past 'queued' on its own otherwise.
            // No expense/provenance is created (same as the legacy path);
            // maybeFailMailboxCandidateInTransaction only surfaces the
            // failure onto the candidate once every sibling mailbox job
            // has also reached a terminal state with none succeeding (see
            // its own doc comment for the full multi-attachment rule).
            if (input.request.status === "FAILED") {
              await maybeFailMailboxCandidateInTransaction(transaction, job);
            }
            const now = new Date();
            const updated = await transaction
              .updateTable("app.processing_jobs")
              .set({
                status: input.request.status,
                result: toJsonValue(input.request.result),
                error_message: input.request.message ?? job.error_message,
                updated_at: now,
                completed_at: now,
                version: job.version + 1,
                ...(appliedExpenseId === null
                  ? {}
                  : { target_aggregate_id: appliedExpenseId }),
              })
              .where("id", "=", input.jobId)
              .returningAll()
              .executeTakeFirstOrThrow();
            await recordAuditEvent(transaction, {
              tenantId: job.tenant_id,
              actorServicePrincipal: input.actorServicePrincipal,
              action: "processing_job.result_submitted",
              outcome: "success",
              resourceType: "processing_job",
              resourceId: input.jobId,
              requestId: input.requestId,
              metadata: { status: input.request.status },
            });
            return toProcessingJob(updated);
          },
        });
      } catch (error: unknown) {
        if (isUniqueViolation(error)) throw DomainError.conflict();
        throw error;
      }
    },

    async getJob(jobId) {
      const row = await database
        .selectFrom("app.processing_jobs")
        .selectAll()
        .where("id", "=", jobId)
        .executeTakeFirst();
      if (!row) throw DomainError.notFound();
      return toProcessingJob(row);
    },
  };
}
