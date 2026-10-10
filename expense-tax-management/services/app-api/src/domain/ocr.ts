import {
  FORWARDED_RECEIPT_WORKFLOW_TYPE,
  MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE,
  OCR_EXTRACTION_RESULT_SCHEMA_VERSION,
  OCR_RECEIPT_WORKFLOW_TYPE,
  OcrModeKeySchema,
  type OcrExtractionResultV1,
  type OcrJobInputV1,
  type OcrModeKey,
  type ProcessingJob,
} from "@expense-tax/contracts";
import { type Kysely, type Transaction } from "kysely";

import type { AppDatabase } from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import { insertExpenseInTransaction } from "./expenses.js";
import type { FileScope, FilesDomain } from "./files.js";
import {
  executeIdempotentMutation,
  hashNormalizedRequest,
  type MutationResult,
} from "./idempotency.js";
import { recordConnectedMailboxEvidenceInTransaction } from "./mailbox-ingestion.js";
import type { ProcessingJobRow } from "./processing-job-view.js";
import type { PlansDomain } from "./plans.js";
import { createEnrichmentJobInTransaction } from "./enrichment-jobs.js";
import { createJobInTransaction } from "./processing-jobs.js";
import { toProcessingJob } from "./processing-job-view.js";

/**
 * Structural view of a processing_jobs row needed to apply an OCR
 * extraction. Selectable<AppDatabase["app.processing_jobs"]> is
 * assignable to it; defined here so ocr.js needs no runtime import from
 * processing-jobs.js (the edge runs processing-jobs -> ocr, one way).
 */
export interface OcrJobBinding {
  readonly id: string;
  readonly tenant_id: string;
  readonly personal_profile_id: string | null;
  readonly business_id: string | null;
  readonly requested_by_user_id: string | null;
  readonly source_file_id: string | null;
  readonly workflow_type: string;
}

export interface CreateOcrJobCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly scope: FileScope;
  readonly fileId: string;
  readonly modeKey: OcrModeKey;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly workflowType?:
    | typeof OCR_RECEIPT_WORKFLOW_TYPE
    | typeof FORWARDED_RECEIPT_WORKFLOW_TYPE;
  readonly extraInputParams?: Readonly<Record<string, unknown>>;
}

export interface ListOcrJobsCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly scope: FileScope;
  readonly fileId: string;
}

export interface GetOcrInputCommand {
  readonly jobId: string;
  readonly actorServicePrincipal: string;
  readonly requestId: string;
}

export interface OcrJobsDomain {
  createOcrJob(
    input: CreateOcrJobCommand,
  ): Promise<MutationResult<ProcessingJob, 201>>;
  listOcrJobs(
    input: ListOcrJobsCommand,
  ): Promise<{ readonly items: readonly ProcessingJob[] }>;
  getOcrInput(input: GetOcrInputCommand): Promise<OcrJobInputV1>;
}

/**
 * Materializes an OCR extraction as an expense, atomically with the
 * calling submitResult job update (same transaction). The job binding IS
 * the authorization: caller-supplied tenant/scope/user are ignored, all
 * values come from the job row + the validated extraction payload.
 * Returns the created expense id for the job's target backfill.
 */
export async function applyOcrExtraction(
  transaction: Transaction<AppDatabase>,
  input: {
    readonly job: OcrJobBinding;
    readonly extraction: OcrExtractionResultV1;
    readonly requestId: string;
  },
): Promise<string> {
  const { job, extraction } = input;
  if (!job.requested_by_user_id) throw DomainError.validation();
  if (!job.source_file_id) throw DomainError.validation();

  const file = await transaction
    .selectFrom("app.expense_files")
    .selectAll()
    .where("id", "=", job.source_file_id)
    .executeTakeFirst();
  if (!file) throw DomainError.validation();
  if (
    file.tenant_id !== job.tenant_id ||
    file.personal_profile_id !== job.personal_profile_id ||
    file.business_id !== job.business_id
  ) {
    throw DomainError.validation();
  }
  // First-writer wins: a bound file means another job already applied.
  // Creating a second expense for one file is never correct (dedup is
  // 3B scope; until then, fail closed).
  if (file.expense_id !== null) throw DomainError.conflict();

  const scope: FileScope =
    job.personal_profile_id !== null
      ? { kind: "personal", profileId: job.personal_profile_id }
      : job.business_id !== null
        ? { kind: "business", businessId: job.business_id }
        : (() => {
            throw DomainError.validation();
          })();

  const expense = await insertExpenseInTransaction(transaction, {
    actorUserId: job.requested_by_user_id,
    tenantId: job.tenant_id,
    request: {
      ...(scope.kind === "personal"
        ? { personalProfileId: scope.profileId }
        : { businessId: scope.businessId }),
      merchant: extraction.merchant,
      description: extraction.notes ?? null,
      amount: extraction.amount,
      currency: extraction.currency,
      incurredOn: extraction.incurredOn,
    },
    requestId: input.requestId,
    scope:
      scope.kind === "personal"
        ? { kind: "personal", profileId: scope.profileId }
        : { kind: "business", businessId: scope.businessId },
    source:
      job.workflow_type === FORWARDED_RECEIPT_WORKFLOW_TYPE
        ? "forwarded_email"
        : "ocr",
    // ocr-deferred: applyOcrExtraction explicitly calls createEnrichmentJobInTransaction
    // after file binding. insertExpenseInTransaction skips inline creation for this mode.
    mode: "ocr-deferred",
  });

  await transaction
    .updateTable("app.expense_files")
    .set({ expense_id: expense.id })
    .where("id", "=", file.id)
    .where("expense_id", "is", null)
    .execute();

  // Enqueue enrichment job for OCR/forwarded materialization in the same
  // transaction. Enrichment failure never rolls back or changes the ready
  // expense, OCR job, or dedup state.
  await createEnrichmentJobInTransaction(transaction, {
    tenantId: job.tenant_id,
    scope:
      job.personal_profile_id !== null
        ? { personalProfileId: job.personal_profile_id }
        : { businessId: job.business_id! },
    expenseId: expense.id,
    expectedExpenseVersion: expense.version,
    requestedByUserId: job.requested_by_user_id ?? undefined,
    requestId: input.requestId,
  });

  return expense.id;
}

/**
 * Phase 3D-C Task 3 -- the MailboxOcrReceiptWorkflow counterpart of
 * applyOcrExtraction above. Deliberately a separate function, not a
 * branch inside applyOcrExtraction: that function hard-requires
 * job.requested_by_user_id (MailboxOcrJobActorV1's service-owned variant
 * has none) and creates no connected provenance/dedup -- reusing it would
 * mean bolting mailbox-specific branching onto the generic OCR path
 * instead of keeping the two materialization strategies separate (same
 * "do not use ForwardedReceiptWorkflow/OcrReceiptWorkflow" boundary the
 * brief names, mirrored here on the App side). Delegates the actual
 * expense/provenance/dedup/candidate-update work to
 * domain/mailbox-ingestion.ts's recordConnectedMailboxEvidenceInTransaction,
 * which submitStructuredReceipt (the structured-HTML path) also calls, so
 * both mailbox materialization paths share one implementation.
 */
export async function applyMailboxOcrExtraction(
  transaction: Transaction<AppDatabase>,
  input: {
    readonly job: ProcessingJobRow;
    readonly extraction: OcrExtractionResultV1;
    readonly requestId: string;
  },
): Promise<string> {
  const { job, extraction } = input;
  const candidateId = (job.input_params as Record<string, unknown> | null)?.mailboxCandidateId;
  if (typeof candidateId !== "string") throw DomainError.validation();

  const candidate = await transaction
    .selectFrom("app.mailbox_candidates")
    .selectAll()
    .where("id", "=", candidateId)
    .where("tenant_id", "=", job.tenant_id)
    .forUpdate()
    .executeTakeFirst();
  if (!candidate) throw DomainError.validation();
  // Fix round 2 (review Important #4): a candidate may now have one
  // mailbox OCR job PER ATTACHMENT (not a single candidate-wide job), so
  // `candidate.processing_job_id` no longer identifies "the" job -- the
  // only invariant left to check is first-writer-wins materialization:
  // once a DIFFERENT job has already materialized this candidate
  // (status flipped away from 'queued'), every other job's own
  // extraction is rejected here, never double-materializing.
  if (candidate.status !== "queued") throw DomainError.conflict();

  const connection = await transaction
    .selectFrom("app.mailbox_connections")
    .selectAll()
    .where("id", "=", candidate.connection_id)
    .executeTakeFirstOrThrow();
  const requestedByUserId = job.requested_by_user_id;

  const materialized = await recordConnectedMailboxEvidenceInTransaction(transaction, {
    candidate,
    connection,
    merchant: extraction.merchant,
    amount: extraction.amount,
    currency: extraction.currency,
    incurredOn: extraction.incurredOn,
    orderNumber: extraction.orderNumber ?? null,
    notes: extraction.notes ?? null,
    processingJobId: job.id,
    requestedByUserId,
    requestId: input.requestId,
    evidence: [],
  });

  return materialized.expenseId;
}

export function createOcrJobsDomain(
  database: Kysely<AppDatabase>,
  deps: {
    readonly plansDomain: PlansDomain;
    readonly filesDomain: FilesDomain;
  },
): OcrJobsDomain {
  return {
    async createOcrJob(input) {
      const file = await deps.filesDomain.getFile({
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        scope: input.scope,
        fileId: input.fileId,
      });
      if (file.status !== "READY") throw DomainError.conflict();
      if (file.expenseId !== null) throw DomainError.conflict();

      const entitlements = await deps.plansDomain.resolveEffectiveEntitlements({
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
      });
      const modeEntitlement = entitlements.find(
        (entitlement) => entitlement.featureKey === input.modeKey,
      );
      if (!modeEntitlement?.isEnabled) throw DomainError.forbidden();

      return executeIdempotentMutation(database, {
        actorKey: `user:${input.actorUserId}`,
        operationKey: "ocr-job.create",
        idempotencyKey: input.idempotencyKey,
        requestHash: hashNormalizedRequest({
          tenantId: input.tenantId,
          scope: input.scope,
          fileId: input.fileId,
          modeKey: input.modeKey,
        }),
        statusCode: 201,
        parseBody: (value) => value as ProcessingJob,
        execute: async (transaction) =>
          createJobInTransaction(transaction, {
            tenantId: input.tenantId,
            scope:
              input.scope.kind === "personal"
                ? { personalProfileId: input.scope.profileId }
                : { businessId: input.scope.businessId },
            workflowType: input.workflowType ?? OCR_RECEIPT_WORKFLOW_TYPE,
            allowedResultSchemaVersion: OCR_EXTRACTION_RESULT_SCHEMA_VERSION,
            targetAggregateType: "expense",
            requestedByUserId: input.actorUserId,
            sourceFileId: input.fileId,
            inputParams: { modeKey: input.modeKey, ...input.extraInputParams },
            actorUserId: input.actorUserId,
            requestId: input.requestId,
          }),
      });
    },

    async listOcrJobs(input) {
      // Membership read-check first: job existence must not leak across
      // scopes (same oracle discipline as getFile).
      await deps.filesDomain.getFile({
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        scope: input.scope,
        fileId: input.fileId,
      });
      let query = database
        .selectFrom("app.processing_jobs")
        .selectAll()
        .where("source_file_id", "=", input.fileId)
        .where("tenant_id", "=", input.tenantId);
      query =
        input.scope.kind === "personal"
          ? query.where("personal_profile_id", "=", input.scope.profileId)
          : query.where("business_id", "=", input.scope.businessId);
      const rows = await query
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .execute();
      return { items: rows.map(toProcessingJob) };
    },

    async getOcrInput(input) {
      return database.transaction().execute(async (transaction) => {
        const job = await transaction
          .selectFrom("app.processing_jobs")
          .selectAll()
          .where("id", "=", input.jobId)
          .executeTakeFirst();
        if (
          !job ||
          ![
            OCR_RECEIPT_WORKFLOW_TYPE,
            FORWARDED_RECEIPT_WORKFLOW_TYPE,
            MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE,
          ].includes(job.workflow_type)
        ) {
          throw DomainError.notFound();
        }
        if (
          job.status === "PENDING" ||
          job.status === "SUCCEEDED" ||
          job.status === "FAILED"
        ) {
          throw DomainError.conflict();
        }
        if (!job.source_file_id) throw DomainError.validation();
        const modeKey = OcrModeKeySchema.safeParse(
          (job.input_params as Record<string, unknown> | null)?.modeKey,
        );
        if (!modeKey.success) throw DomainError.validation();
        const file = await transaction
          .selectFrom("app.expense_files")
          .selectAll()
          .where("id", "=", job.source_file_id)
          .executeTakeFirst();
        if (!file) throw DomainError.validation();
        await recordAuditEvent(transaction, {
          tenantId: job.tenant_id,
          actorServicePrincipal: input.actorServicePrincipal,
          action: "processing_job.ocr_input_read",
          outcome: "success",
          resourceType: "processing_job",
          resourceId: job.id,
          requestId: input.requestId,
        });
        return {
          schemaVersion: 1 as const,
          fileId: file.id,
          modeKey: modeKey.data,
          expectedSha256: file.sha256_hex,
          tenantId: job.tenant_id,
        };
      });
    },
  };
}
