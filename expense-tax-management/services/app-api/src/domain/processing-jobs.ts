import { randomUUID } from "node:crypto";

import {
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
import { type Kysely, type Transaction } from "kysely";

import type { AppDatabase } from "../database/types.js";
import type { TemporalWorkflowStarter } from "../temporal/client.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import { readDispatchRoutingForShare } from "./dispatch-routing.js";
import { applyOcrExtraction } from "./ocr.js";
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
              appliedExpenseId = await applyOcrExtraction(transaction, {
                job,
                extraction: extraction.data,
                requestId: input.requestId,
              });
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
