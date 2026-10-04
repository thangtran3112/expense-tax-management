import { z } from "zod";

/**
 * Stable Temporal identifiers consumed by App API and the Expense-owned
 * TypeScript workflow worker. They are environment-independent routing
 * contracts, not deploy-time configuration.
 */
export const AI_WORKER_TASK_QUEUE = "expense-tax-processing";
/**
 * Task 7 Stage A dispatch routing identifiers. Generation 1 of
 * app.temporal_dispatch_routing (App DB) seeds LEGACY_TEMPORAL_NAMESPACE /
 * LEGACY_AI_WORKER_TASK_QUEUE -- the Python worker's current production
 * target -- so Stage A changes no production routing. An operator-run
 * `advance` (src/temporal/dispatch-routing.ts) moves new jobs to
 * TARGET_TEMPORAL_NAMESPACE / AI_WORKER_TASK_QUEUE (Stage B).
 */
export const LEGACY_AI_WORKER_TASK_QUEUE = "expense-tax-ai-worker";
export const LEGACY_TEMPORAL_NAMESPACE = "default";
export const TARGET_TEMPORAL_NAMESPACE = "expense-tax";
export const FOUNDATION_ECHO_WORKFLOW_TYPE = "FoundationEchoWorkflow";
export const OCR_RECEIPT_WORKFLOW_TYPE = "OcrReceiptWorkflow";
export const FORWARDED_RECEIPT_WORKFLOW_TYPE = "ForwardedReceiptWorkflow";
export const OCR_EXTRACTION_RESULT_SCHEMA_VERSION = "ocr-extraction-v1";
export const EXPENSE_ENRICHMENT_WORKFLOW_TYPE = "ExpenseEnrichmentWorkflow";
export const EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION = "expense-enrichment-v1";
/**
 * Phase 3D-B mailbox scan workflow. TypeScript-only: it has no Python
 * `ai-worker` implementation and never will (see 3D-B pre-flight C2/C4), so
 * later tasks start it directly against TARGET_TEMPORAL_NAMESPACE /
 * AI_WORKER_TASK_QUEUE rather than through the generation-fenced
 * app.temporal_dispatch_routing path used by OCR/enrichment/forwarded-
 * receipt during their Task 7 cutover window.
 */
export const MAILBOX_SCAN_WORKFLOW_TYPE = "MailboxScanWorkflow";
/**
 * Phase 3D-B Task 3. The daily-schedule target workflow: Temporal Schedules
 * start a workflow with fixed, schedule-creation-time args, so the real
 * per-connection scan run (minted by App API's lease/idempotency ledger)
 * cannot be known until the Schedule actually fires. This thin trigger
 * workflow takes the one value a Schedule CAN carry unchanged forever
 * (`connectionId`), mints the scan run via an activity, and starts
 * MailboxScanWorkflow as its child with the resulting `scanRunId`.
 * Deliberately NOT part of WorkflowTypeSchema: Temporal's native Schedule
 * API (`client.schedule.create`) takes a plain string workflow type and
 * never flows through TemporalWorkflowStarter/StartWorkflowInput's typed
 * enum, so this constant has no reason to widen that enum.
 */
export const MAILBOX_SCHEDULED_SCAN_TRIGGER_WORKFLOW_TYPE = "MailboxScheduledScanTriggerWorkflow";
/**
 * Phase 3D-C mailbox ingestion workflow. TypeScript-only, same reasoning as
 * MAILBOX_SCAN_WORKFLOW_TYPE above: no Python implementation and never will
 * have one (plan Global Constraints: "This plan's workflows run only on the
 * TypeScript services/workflow-worker"). Ruling (Phase 3D-C controller
 * progress.md): started directly against TARGET_TEMPORAL_NAMESPACE /
 * AI_WORKER_TASK_QUEUE, bypassing the generation-fenced
 * app.temporal_dispatch_routing path entirely (not just until an operator
 * runs `advance`) -- unlike legacy job types (OcrReceiptWorkflow/
 * ForwardedReceiptWorkflow/ExpenseEnrichmentWorkflow), which reuse the
 * generic job pipeline and are safe to generation-route because Stage A is
 * a no-op until `advance`. A later task refuses to dispatch this workflow
 * when MAILBOX_FEATURE_ENABLED is false.
 */
export const MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE = "MailboxOcrReceiptWorkflow";
/**
 * Phase 3D-C Task 5 gap closure -- the materialization-trigger workflow.
 * Unlike MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE's own direct-dispatch path
 * (bypassing the generic job pipeline), this one IS created and dispatched
 * through the ordinary processing_jobs/processing_job_dispatch_outbox/
 * dispatchPendingJobs mechanism every other job type already uses --
 * domain/mailbox-candidates.ts's resolveCandidate stamps it with the fixed
 * TypeScript target (TARGET_TEMPORAL_NAMESPACE/AI_WORKER_TASK_QUEUE) while
 * recording the current dispatch_generation, same pattern as Task 3's own
 * mailbox OCR job. Must be in WorkflowTypeSchema (not bypassed like
 * MAILBOX_SCHEDULED_SCAN_TRIGGER_WORKFLOW_TYPE above): dispatchPendingJobs
 * parses JobReferenceV1 -- including workflowType -- before starting it.
 */
export const MAILBOX_MATERIALIZE_WORKFLOW_TYPE = "MailboxMaterializeWorkflow";
/** Result schema version stamped on a MailboxMaterializeWorkflow job's
 * allowed_result_schema_version / submitted via the generic job-result
 * route -- the opaque MailboxMaterializationResultV1 shape, never OCR
 * extraction fields. */
export const MAILBOX_MATERIALIZE_RESULT_SCHEMA_VERSION = "mailbox-materialize-v1";

export const WorkflowTypeSchema = z.enum([
  FOUNDATION_ECHO_WORKFLOW_TYPE,
  OCR_RECEIPT_WORKFLOW_TYPE,
  FORWARDED_RECEIPT_WORKFLOW_TYPE,
  EXPENSE_ENRICHMENT_WORKFLOW_TYPE,
  MAILBOX_SCAN_WORKFLOW_TYPE,
  MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE,
  MAILBOX_MATERIALIZE_WORKFLOW_TYPE,
]);
export type WorkflowType = z.infer<typeof WorkflowTypeSchema>;

// Existing workflows complete through App API callbacks and return no value
// through Temporal history.
export const WorkflowResultSchema = z.void();
export type WorkflowResult = z.infer<typeof WorkflowResultSchema>;
