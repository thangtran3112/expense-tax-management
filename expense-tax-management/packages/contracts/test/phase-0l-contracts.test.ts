import { describe, expect, it } from "vitest";

import {
  AI_WORKER_TASK_QUEUE,
  FOUNDATION_ECHO_WORKFLOW_TYPE,
  JobReferenceV1Schema,
  JobResultSubmitRequestV1Schema,
  JobStatusUpdateRequestV1Schema,
  ProcessingJobSchema,
} from "../src/index.js";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const TIMESTAMP = "2026-09-08T00:00:00.000Z";

describe("Phase 0L internal message contracts", () => {
  it("keeps the task-queue/workflow-type constants stable", () => {
    expect(AI_WORKER_TASK_QUEUE).toBe("expense-tax-processing");
    expect(FOUNDATION_ECHO_WORKFLOW_TYPE).toBe("FoundationEchoWorkflow");
  });

  it("parses a JobReferenceV1 and rejects unknown fields", () => {
    const reference = JobReferenceV1Schema.parse({
      schemaVersion: 1,
      jobId: JOB_ID,
      workflowType: FOUNDATION_ECHO_WORKFLOW_TYPE,
      workflowId: `job-${JOB_ID}`,
    });
    expect(reference.jobId).toBe(JOB_ID);
    expect(() =>
      JobReferenceV1Schema.parse({
        schemaVersion: 1,
        jobId: JOB_ID,
        workflowType: FOUNDATION_ECHO_WORKFLOW_TYPE,
        workflowId: `job-${JOB_ID}`,
        receiptText: "leaked content must never appear here",
      }),
    ).toThrow();
  });

  it("requires idempotencyKey and expectedJobVersion on a status update", () => {
    const update = JobStatusUpdateRequestV1Schema.parse({
      schemaVersion: 1,
      status: "RUNNING",
      idempotencyKey: "attempt-1",
      expectedJobVersion: 1,
    });
    expect(update.status).toBe("RUNNING");
    expect(() =>
      JobStatusUpdateRequestV1Schema.parse({
        schemaVersion: 1,
        status: "RUNNING",
        expectedJobVersion: 1,
      }),
    ).toThrow();
  });

  it("requires resultSchemaVersion and a result payload on a result submission", () => {
    const submission = JobResultSubmitRequestV1Schema.parse({
      schemaVersion: 1,
      status: "SUCCEEDED",
      idempotencyKey: "attempt-1",
      expectedJobVersion: 2,
      resultSchemaVersion: "foundation-echo-v1",
      result: { echo: JOB_ID },
    });
    expect(submission.result.echo).toBe(JOB_ID);
    expect(() =>
      JobResultSubmitRequestV1Schema.parse({
        schemaVersion: 1,
        status: "SUCCEEDED",
        idempotencyKey: "attempt-1",
        expectedJobVersion: 2,
        result: { echo: JOB_ID },
      }),
    ).toThrow();
  });

  it("requires exactly one Personal or business scope on a ProcessingJob", () => {
    const job = ProcessingJobSchema.parse({
      id: JOB_ID,
      tenantId: TENANT_ID,
      personalProfileId: PROFILE_ID,
      businessId: null,
      workflowType: FOUNDATION_ECHO_WORKFLOW_TYPE,
      workflowId: `job-${JOB_ID}`,
      taskQueue: AI_WORKER_TASK_QUEUE,
      runId: null,
      status: "PENDING",
      targetAggregateType: null,
      targetAggregateId: null,
      expectedAggregateVersion: null,
      inputParams: {},
      allowedResultSchemaVersion: "foundation-echo-v1",
      result: null,
      errorMessage: null,
      version: 1,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      dispatchedAt: null,
      completedAt: null,
    });
    expect(job.personalProfileId).toBe(PROFILE_ID);
    expect(job.businessId).toBeNull();
  });
});
