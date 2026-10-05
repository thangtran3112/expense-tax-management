import { randomUUID } from "node:crypto";

import {
  EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION,
  EXPENSE_ENRICHMENT_WORKFLOW_TYPE,
  type JobReferenceV1,
  type ExpenseEnrichmentInputResponseV1,
  type ExpenseEnrichmentInputV1,
  type ProcessingJob,
} from "@expense-tax/contracts";
import { type Kysely, type Transaction } from "kysely";
import { z } from "zod";

import type { AppDatabase } from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import { readDispatchRoutingForShare } from "./dispatch-routing.js";
import {
  toJsonValue,
  type MutationResult,
} from "./idempotency.js";
import { toProcessingJob } from "./processing-job-view.js";
import {
  buildEnrichmentInput,
  applyEnrichmentResult,
} from "./enrichment.js";

// ------------------------------------------------------------------ //
// createEnrichmentJobInTransaction
// ------------------------------------------------------------------ //

export interface EnrichmentJobBinding {
  readonly tenantId: string;
  readonly scope:
    | { readonly personalProfileId: string; readonly businessId?: undefined }
    | { readonly businessId: string; readonly personalProfileId?: undefined };
  readonly expenseId: string;
  readonly expectedExpenseVersion: number;
  readonly requestedByUserId?: string;
  readonly requestId: string;
}

/**
 * Creates one enrichment processing job (version 1) + one dispatch outbox row
 * atomically inside the caller's transaction. Must be called only when the
 * expense is already inserted and status === "ready".
 *
 * Returns the created ProcessingJob for callers that need to inspect it.
 *
 * Exported so ocr.ts can call it from applyOcrExtraction's transaction.
 * The caller owns the transaction boundary; this function must NOT open a
 * nested transaction.
 *
 * Note: inlined here (not delegating to createJobInTransaction) to avoid the
 * circular import processing-jobs -> ocr -> enrichment-jobs -> processing-jobs.
 */
export async function createEnrichmentJobInTransaction(
  transaction: Transaction<AppDatabase>,
  binding: EnrichmentJobBinding,
): Promise<ProcessingJob> {
  const jobId = randomUUID();
  const workflowId = `job-${jobId}`;
  const now = new Date();
  // Enqueue fence (Task 7 Stage A): see createJobInTransaction in
  // processing-jobs.ts for the same pattern (not reused directly here --
  // see the module docstring on the circular-import constraint).
  const dispatchTarget = await readDispatchRoutingForShare(transaction);

  const created = await transaction
    .insertInto("app.processing_jobs")
    .values({
      id: jobId,
      tenant_id: binding.tenantId,
      personal_profile_id: binding.scope.personalProfileId ?? null,
      business_id: binding.scope.businessId ?? null,
      workflow_type: EXPENSE_ENRICHMENT_WORKFLOW_TYPE,
      workflow_id: workflowId,
      task_queue: dispatchTarget.taskQueue,
      dispatch_generation: dispatchTarget.generation,
      dispatch_namespace: dispatchTarget.namespace,
      run_id: null,
      status: "PENDING",
      target_aggregate_type: "expense",
      target_aggregate_id: binding.expenseId,
      expected_aggregate_version: binding.expectedExpenseVersion,
      requested_by_user_id: binding.requestedByUserId ?? null,
      source_file_id: null,
      input_params: toJsonValue({}),
      allowed_result_schema_version: EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION,
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
    workflowType: EXPENSE_ENRICHMENT_WORKFLOW_TYPE,
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
    tenantId: binding.tenantId,
    actorUserId: binding.requestedByUserId ?? null,
    action: "processing_job.created",
    outcome: "success",
    resourceType: "processing_job",
    resourceId: jobId,
    requestId: binding.requestId,
  });

  return toProcessingJob(created);
}

// ------------------------------------------------------------------ //
// EnrichmentInputProjection — explicit seam (kept for test compatibility)
// ------------------------------------------------------------------ //

/**
 * Task 6 wired the real projection (buildEnrichmentInput from domain/enrichment.ts)
 * into createEnrichmentJobsDomain. This interface and pendingProjection are kept
 * for backward compatibility with existing tests in enrichment-domain.test.ts.
 *
 * The second parameter of createEnrichmentJobsDomain is no longer used in
 * production; the factory ignores it and always uses the real buildEnrichmentInput.
 */
export interface EnrichmentInputProjection {
  buildInput(
    tenantId: string,
    jobId: string,
    expenseId: string,
    expenseVersion: number,
  ): Promise<ExpenseEnrichmentInputV1>;
}

/**
 * Preserved for test compatibility (enrichment-domain.test.ts asserts this throws CONFLICT).
 * Not used in production after Task 6.
 */
export const pendingProjection: EnrichmentInputProjection = {
  async buildInput() {
    throw DomainError.conflict();
  },
};

// ------------------------------------------------------------------ //
// EnrichmentJobsDomain — input and result routes
// ------------------------------------------------------------------ //

export interface GetEnrichmentInputCommand {
  readonly jobId: string;
  readonly actorServicePrincipal: string;
  readonly requestId: string;
}

export interface SubmitEnrichmentResultCommand {
  readonly jobId: string;
  readonly idempotencyKey: string;
  readonly expectedJobVersion: number;
  readonly result: unknown;
  readonly actorServicePrincipal: string;
  readonly requestId: string;
}

export interface EnrichmentJobsDomain {
  getEnrichmentInput(
    input: GetEnrichmentInputCommand,
  ): Promise<ExpenseEnrichmentInputResponseV1>;
  submitEnrichmentResult(
    input: SubmitEnrichmentResultCommand,
  ): Promise<MutationResult<ProcessingJob, 200>>;
}

/**
 * Job status RUNNING is required for both input and result operations.
 * Worker must call the status update route (mark RUNNING) before requesting
 * input. DISPATCHED is rejected to enforce the spec flow order.
 */

export function createEnrichmentJobsDomain(
  database: Kysely<AppDatabase>,
  // projection parameter kept for API compatibility; Task 6 uses buildEnrichmentInput directly.
  _projection: EnrichmentInputProjection = pendingProjection,
): EnrichmentJobsDomain {
  void _projection;
  return {
    async getEnrichmentInput(input) {
      // F13: buildEnrichmentInput writes exactly one audit event inside its
      // transaction using the actor principal and requestId passed here.
      return buildEnrichmentInput(
        database,
        input.jobId,
        input.actorServicePrincipal,
        input.requestId,
      );
    },

    async submitEnrichmentResult(input) {
      // F1/F3: applyEnrichmentResult is a single unified atomic transaction.
      // It checks the permanent result key first (before job-status guard),
      // processes the result, inserts the result op key, and marks the job
      // SUCCEEDED — all in one commit. No sentinel, no post-commit recording.
      return applyEnrichmentResult(database, {
        jobId: input.jobId,
        idempotencyKey: input.idempotencyKey,
        expectedJobVersion: input.expectedJobVersion,
        result: input.result,
        actorServicePrincipal: input.actorServicePrincipal,
        requestId: input.requestId,
      });
    },
  };
}

// ------------------------------------------------------------------ //
// Strict transport schemas for HTTP body/response
// ------------------------------------------------------------------ //

/**
 * Transport-layer result schema for the enrichment result route body.
 *
 * This is a strict typed envelope that validates all required fields of
 * ExpenseEnrichmentResultV1 at HTTP layer WITHOUT the top-level `.refine()`
 * calls that would crash Fastify/ZodTypeProvider route registration.
 *
 * The domain performs a full canonical parse via ExpenseEnrichmentResultV1Schema
 * before acting on the result. Both layers must accept the same wire format;
 * this schema is a structural subset (no cross-field invariants).
 *
 * Registration proof: this schema is registered as a Fastify body schema in
 * registerJobRoutes; if it caused a crash, all job route tests would fail
 * with a startup error.
 *
 * Fastify/ZodTypeProvider limitation: top-level `.refine()` and
 * `.discriminatedUnion()` with cross-field `.refine()` cause
 * `isFluentSchema` undefined crashes during route setup in Fastify v5.
 * Equivalent plain `z.object` with `z.union`/`z.discriminatedUnion` (no
 * top-level refine) registers without issue and provides full field coverage.
 */
/** Exact canonical lowercase SHA-256 regex — 64 hex chars, lowercase only. */
const EvidenceHashTransportSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "evidenceHash must be a 64-char lowercase hex SHA-256");

const AggregateCounts = z.strictObject({
  exampleCount: z.number().int().min(0).max(50),
  matchCount: z.number().int().min(0),
});

const SuggestionTransportSchema = z.union([
  z.strictObject({
    kind: z.literal("tag"),
    source: z.literal("historical"),
    tagKey: z.string().min(1).max(100),
    confidence: z.number().min(0).max(1),
    evidenceHash: EvidenceHashTransportSchema,
    aggregateCounts: AggregateCounts,
  }),
  z.strictObject({
    kind: z.literal("spending_category"),
    source: z.literal("historical"),
    spendingCategoryId: z.string().uuid(),
    confidence: z.number().min(0).max(1),
    evidenceHash: EvidenceHashTransportSchema,
    aggregateCounts: AggregateCounts,
  }),
  z.strictObject({
    kind: z.literal("tax_category"),
    source: z.literal("historical"),
    taxCategoryDefinitionId: z.string().uuid(),
    businessTaxProfileId: z.string().uuid(),
    businessTaxProfileVersion: z.number().int().positive(),
    taxonomyVersionId: z.string().uuid(),
    taxYear: z.number().int().min(2000).max(2100),
    expenseVersion: z.number().int().positive(),
    confidence: z.number().min(0).max(1),
    evidenceHash: EvidenceHashTransportSchema,
    aggregateCounts: AggregateCounts,
  }),
]);

export const EnrichmentResultTransportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  rulesVersion: z.number().int().positive(),
  outcome: z.enum(["applied", "stale", "skipped"]),
  ruleTagKeys: z.array(z.string().min(1).max(100)).max(50),
  suggestions: z.array(SuggestionTransportSchema).max(50),
});

export const EnrichmentResultSubmitRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  idempotencyKey: z.string().trim().min(1).max(255),
  expectedJobVersion: z.number().int().positive(),
  result: EnrichmentResultTransportSchema,
});
export type EnrichmentResultSubmitRequest = z.infer<typeof EnrichmentResultSubmitRequestSchema>;
