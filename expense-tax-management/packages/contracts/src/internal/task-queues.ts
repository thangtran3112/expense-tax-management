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

export const WorkflowTypeSchema = z.enum([
  FOUNDATION_ECHO_WORKFLOW_TYPE,
  OCR_RECEIPT_WORKFLOW_TYPE,
  FORWARDED_RECEIPT_WORKFLOW_TYPE,
  EXPENSE_ENRICHMENT_WORKFLOW_TYPE,
]);
export type WorkflowType = z.infer<typeof WorkflowTypeSchema>;

// Existing workflows complete through App API callbacks and return no value
// through Temporal history.
export const WorkflowResultSchema = z.void();
export type WorkflowResult = z.infer<typeof WorkflowResultSchema>;
