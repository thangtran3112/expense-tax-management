import { describe, expect, it } from "vitest";

import {
  AI_WORKER_TASK_QUEUE,
  EXPENSE_ENRICHMENT_WORKFLOW_TYPE,
  FORWARDED_RECEIPT_WORKFLOW_TYPE,
  FOUNDATION_ECHO_WORKFLOW_TYPE,
  JobReferenceV1Schema,
  LEGACY_AI_WORKER_TASK_QUEUE,
  LEGACY_TEMPORAL_NAMESPACE,
  MAILBOX_SCAN_WORKFLOW_TYPE,
  OCR_RECEIPT_WORKFLOW_TYPE,
  TARGET_TEMPORAL_NAMESPACE,
  WorkflowResultSchema,
  WorkflowTypeSchema,
} from "../src/index.js";

const workflowTypes = [
  FOUNDATION_ECHO_WORKFLOW_TYPE,
  OCR_RECEIPT_WORKFLOW_TYPE,
  FORWARDED_RECEIPT_WORKFLOW_TYPE,
  EXPENSE_ENRICHMENT_WORKFLOW_TYPE,
  MAILBOX_SCAN_WORKFLOW_TYPE,
] as const;

describe("Temporal workflow compatibility", () => {
  it("freezes workflow names and the TypeScript worker queue", () => {
    expect(workflowTypes).toEqual([
      "FoundationEchoWorkflow",
      "OcrReceiptWorkflow",
      "ForwardedReceiptWorkflow",
      "ExpenseEnrichmentWorkflow",
      "MailboxScanWorkflow",
    ]);
    expect(AI_WORKER_TASK_QUEUE).toBe("expense-tax-processing");
  });

  it("freezes legacy and target dispatch routing identifiers (Task 7 Stage A)", () => {
    expect(LEGACY_AI_WORKER_TASK_QUEUE).toBe("expense-tax-ai-worker");
    expect(LEGACY_TEMPORAL_NAMESPACE).toBe("default");
    expect(TARGET_TEMPORAL_NAMESPACE).toBe("expense-tax");
    // The target queue constant must keep its existing name/value.
    expect(AI_WORKER_TASK_QUEUE).toBe("expense-tax-processing");
  });

  it("freezes the mailbox scan workflow type and its dispatch target (Phase 3D-B: TypeScript-only, no legacy Python implementation, so later tasks start it directly against TARGET_TEMPORAL_NAMESPACE/AI_WORKER_TASK_QUEUE instead of the generation-fenced routing path)", () => {
    expect(MAILBOX_SCAN_WORKFLOW_TYPE).toBe("MailboxScanWorkflow");
    expect(TARGET_TEMPORAL_NAMESPACE).toBe("expense-tax");
    expect(AI_WORKER_TASK_QUEUE).toBe("expense-tax-processing");
  });

  it("validates every workflow input and the shared void result", () => {
    expect(WorkflowTypeSchema.options).toEqual(workflowTypes);

    for (const workflowType of workflowTypes) {
      expect(JobReferenceV1Schema.parse({
        schemaVersion: 1,
        jobId: "11111111-1111-4111-8111-111111111111",
        workflowType,
        workflowId: "job-11111111-1111-4111-8111-111111111111",
      }).workflowType).toBe(workflowType);
    }

    expect(JobReferenceV1Schema.safeParse({
      schemaVersion: 1,
      jobId: "11111111-1111-4111-8111-111111111111",
      workflowType: "UnknownWorkflow",
      workflowId: "job-11111111-1111-4111-8111-111111111111",
    }).success).toBe(false);
    expect(WorkflowResultSchema.safeParse(undefined).success).toBe(true);
    expect(WorkflowResultSchema.safeParse({ result: "leaked" }).success).toBe(false);
  });
});
