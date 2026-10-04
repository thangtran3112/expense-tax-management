/**
 * Phase 3D-B Task 3 — workflows/mailbox-scan.ts, run through a real
 * Temporal test environment (same pattern as test/workflows.test.ts).
 *
 * Inspects serialized workflow inputs/activity inputs/history for the
 * absence of history/cursor/pre-fence/provider-message fields -- only
 * scanRunId/tenantId/connectionId/requestId/counts/page-sequence ever
 * cross into Temporal.
 *
 * Fix round 1 (Important finding 1): proves `mailbox_finalize_scan` is
 * called exactly once on every path -- clean success, the page-limit
 * failure, and cancellation -- always with a bare opaque
 * `{scanRunId, outcome}`, never fence/content fields.
 */
import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { expect, it } from "vitest";

const TASK_QUEUE = "expense-tax-processing";
const workflowsPath = fileURLToPath(new URL("../src/workflows/index.ts", import.meta.url));

/** Banned per the plan's global constraint: no history ID, cursor, pre-fence
 * token, message ID, thread ID, sender, subject, or attachment metadata may
 * ever cross into Temporal history. */
const FORBIDDEN_FIELD_PATTERN =
  /historyId|cursorDigest|preFenceToken|providerMessageId|providerThreadId|senderAddress|senderDomain|"subject"|attachmentManifest/i;

async function forbiddenFieldsInHistory(
  env: TestWorkflowEnvironment,
  workflowId: string,
): Promise<boolean> {
  const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
  return FORBIDDEN_FIELD_PATTERN.test(JSON.stringify(history));
}

it("MailboxScanWorkflow calls discover with only scanRunId until a page is exhausted, then finalizes succeeded", async () => {
  const calls: unknown[] = [];
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const workflowId = "mailbox-scan-exhausts";
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: TASK_QUEUE,
      workflowsPath,
      activities: {
        async mailbox_discover_page(input: unknown) {
          calls.push(["discover", input]);
          const pageSequence = calls.length;
          return pageSequence < 3
            ? { scanRunId: "scan-1", pageSequence, candidateCount: 2, retryCount: 0 }
            : { scanRunId: "scan-1", pageSequence, candidateCount: 0, retryCount: 0 };
        },
        async mailbox_finalize_scan(input: unknown) {
          calls.push(["finalize", input]);
        },
      },
    });
    await worker.runUntil(() =>
      env.client.workflow.execute("MailboxScanWorkflow", {
        workflowId,
        taskQueue: TASK_QUEUE,
        args: [{ schemaVersion: 1, scanRunId: "scan-1" }],
      }),
    );
    expect(calls).toEqual([
      ["discover", { scanRunId: "scan-1" }],
      ["discover", { scanRunId: "scan-1" }],
      ["discover", { scanRunId: "scan-1" }],
      ["finalize", { scanRunId: "scan-1", outcome: "succeeded" }],
    ]);
    expect(await forbiddenFieldsInHistory(env, workflowId)).toBe(false);
  } finally {
    await env.teardown();
  }
}, 60_000);

it("MailboxScanWorkflow finalizes failed and rethrows after the maximum page count", async () => {
  const calls: unknown[] = [];
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const workflowId = "mailbox-scan-page-limit";
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: TASK_QUEUE,
      workflowsPath,
      activities: {
        async mailbox_discover_page() {
          return { scanRunId: "scan-2", pageSequence: 1, candidateCount: 5, retryCount: 0 };
        },
        async mailbox_finalize_scan(input: unknown) {
          calls.push(["finalize", input]);
        },
      },
    });
    await expect(
      worker.runUntil(() =>
        env.client.workflow.execute("MailboxScanWorkflow", {
          workflowId,
          taskQueue: TASK_QUEUE,
          args: [{ schemaVersion: 1, scanRunId: "scan-2" }],
        }),
      ),
    ).rejects.toThrow();
    expect(calls).toEqual([["finalize", { scanRunId: "scan-2", outcome: "failed" }]]);
  } finally {
    await env.teardown();
  }
}, 60_000);

it("MailboxScanWorkflow finalizes failed on cancellation, from a non-cancellable scope", async () => {
  // Same gate/resume cancellation-proof pattern as test/workflows.test.ts's
  // "cancellation stops current work..." -- the workflow's await on the
  // in-flight activity rejects with CancelledFailure as soon as
  // handle.cancel() is processed (server-side), independent of when the
  // local activity function itself resolves; resume() just lets that
  // dangling local promise finish so nothing is left hanging.
  let resume!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const startedDiscovering = new Promise<void>((resolve) => {
    started = resolve;
  });
  const calls: unknown[] = [];
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const workflowId = "mailbox-scan-cancelled";
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: TASK_QUEUE,
      workflowsPath,
      activities: {
        async mailbox_discover_page() {
          calls.push(["discover"]);
          started();
          await gate;
          // Matches test/workflows.test.ts's proven cancellation pattern:
          // the activity reports failure once resumed, after
          // handle.cancel() has already been requested, so the
          // workflow's await rejects and the catch/finalize path runs.
          throw new Error("activity cancelled");
        },
        async mailbox_finalize_scan(input: unknown) {
          calls.push(["finalize", input]);
        },
      },
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("MailboxScanWorkflow", {
        workflowId,
        taskQueue: TASK_QUEUE,
        args: [{ schemaVersion: 1, scanRunId: "scan-5" }],
      });
      await startedDiscovering;
      await handle.cancel();
      resume();
      await expect(handle.result()).rejects.toThrow();
    });
    expect(calls).toEqual([["discover"], ["finalize", { scanRunId: "scan-5", outcome: "failed" }]]);
  } finally {
    resume();
    await env.teardown();
  }
}, 60_000);

it("MailboxScheduledScanTriggerWorkflow starts MailboxScanWorkflow as a child when a scan starts", async () => {
  const calls: unknown[] = [];
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const workflowId = "mailbox-schedule-trigger-started";
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: TASK_QUEUE,
      workflowsPath,
      activities: {
        async mailbox_start_scheduled_scan(input: unknown) {
          calls.push(["start", input]);
          return { status: "started", scanRunId: "scan-3" };
        },
        async mailbox_discover_page(input: unknown) {
          calls.push(["discover", input]);
          return { scanRunId: "scan-3", pageSequence: 1, candidateCount: 0, retryCount: 0 };
        },
        async mailbox_finalize_scan(input: unknown) {
          calls.push(["finalize", input]);
        },
      },
    });
    await worker.runUntil(() =>
      env.client.workflow.execute("MailboxScheduledScanTriggerWorkflow", {
        workflowId,
        taskQueue: TASK_QUEUE,
        args: [{ tenantId: "tenant-1", connectionId: "connection-1" }],
      }),
    );
    expect(calls[0]).toEqual([
      "start",
      { tenantId: "tenant-1", connectionId: "connection-1", requestId: expect.any(String) },
    ]);
    expect(calls[1]).toEqual(["discover", { scanRunId: "scan-3" }]);
    expect(calls[2]).toEqual(["finalize", { scanRunId: "scan-3", outcome: "succeeded" }]);

    const childHandle = env.client.workflow.getHandle(`mailbox-scan-scan-3`);
    await expect(childHandle.result()).resolves.toBeUndefined();
    expect(await forbiddenFieldsInHistory(env, workflowId)).toBe(false);
  } finally {
    await env.teardown();
  }
}, 60_000);

it("MailboxScheduledScanTriggerWorkflow does nothing on skipped_overlap", async () => {
  const calls: unknown[] = [];
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const workflowId = "mailbox-schedule-trigger-overlap";
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: TASK_QUEUE,
      workflowsPath,
      activities: {
        async mailbox_start_scheduled_scan(input: unknown) {
          calls.push(["start", input]);
          return { status: "skipped_overlap", scanRunId: "scan-4" };
        },
        async mailbox_discover_page(input: unknown) {
          calls.push(["discover", input]);
          return { scanRunId: "scan-4", pageSequence: 1, candidateCount: 0, retryCount: 0 };
        },
        async mailbox_finalize_scan(input: unknown) {
          calls.push(["finalize", input]);
        },
      },
    });
    await worker.runUntil(() =>
      env.client.workflow.execute("MailboxScheduledScanTriggerWorkflow", {
        workflowId,
        taskQueue: TASK_QUEUE,
        args: [{ tenantId: "tenant-1", connectionId: "connection-1" }],
      }),
    );
    expect(calls.map(([name]) => name)).toEqual(["start"]);
  } finally {
    await env.teardown();
  }
}, 60_000);

/**
 * Phase 3D-C Task 5 — MailboxOcrReceiptWorkflow. Proves mark_running then
 * the single combined mailbox_ocr_receipt activity, with ocr_mark_failed
 * as the best-effort terminal callback on failure -- and that no OCR
 * extraction field or byte ever appears in Temporal history (only the
 * opaque jobId/version/message cross the boundary).
 */
const FORBIDDEN_EXTRACTION_FIELD_PATTERN = /merchant|incurredOn|"amount"|"currency"|receipt bytes/i;

it("MailboxOcrReceiptWorkflow marks running, runs the combined OCR activity, and returns", async () => {
  const calls: unknown[] = [];
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const workflowId = "mailbox-ocr-success";
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: TASK_QUEUE,
      workflowsPath,
      activities: {
        async mark_running(input: unknown) {
          calls.push(["mark_running", input]);
          return 2;
        },
        async mailbox_ocr_receipt(input: unknown) {
          calls.push(["mailbox_ocr_receipt", input]);
          return 3;
        },
        async ocr_mark_failed(input: unknown) {
          calls.push(["ocr_mark_failed", input]);
          return 4;
        },
      },
    });
    const jobReference = {
      schemaVersion: 1,
      jobId: "11111111-1111-4111-8111-111111111111",
      workflowType: "MailboxOcrReceiptWorkflow",
      workflowId,
    };
    await worker.runUntil(() =>
      env.client.workflow.execute("MailboxOcrReceiptWorkflow", {
        workflowId,
        taskQueue: TASK_QUEUE,
        args: [jobReference],
      }),
    );
    expect(calls).toEqual([
      ["mark_running", { jobReference, expectedJobVersion: 2 }],
      ["mailbox_ocr_receipt", { jobReference, expectedJobVersion: 2 }],
    ]);
    expect(await forbiddenFieldsInHistory(env, workflowId)).toBe(false);
    expect(FORBIDDEN_EXTRACTION_FIELD_PATTERN.test(JSON.stringify(calls))).toBe(false);
  } finally {
    await env.teardown();
  }
}, 60_000);

it("MailboxOcrReceiptWorkflow marks the job failed (best-effort) when the combined activity fails permanently", async () => {
  const calls: unknown[] = [];
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const workflowId = "mailbox-ocr-failure";
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: TASK_QUEUE,
      workflowsPath,
      activities: {
        async mark_running() {
          return 2;
        },
        async mailbox_ocr_receipt() {
          const { ApplicationFailure } = await import("@temporalio/activity");
          throw ApplicationFailure.nonRetryable("extraction failed", "MailboxOcrExtractionFailed");
        },
        async ocr_mark_failed(input: unknown) {
          calls.push(["ocr_mark_failed", input]);
          return 5;
        },
      },
    });
    const jobReference = {
      schemaVersion: 1,
      jobId: "22222222-2222-4222-8222-222222222222",
      workflowType: "MailboxOcrReceiptWorkflow",
      workflowId,
    };
    await worker.runUntil(() =>
      env.client.workflow.execute("MailboxOcrReceiptWorkflow", {
        workflowId,
        taskQueue: TASK_QUEUE,
        args: [jobReference],
      }),
    );
    expect(calls).toEqual([
      [
        "ocr_mark_failed",
        {
          jobReference,
          expectedJobVersion: 2,
          message: "MAILBOX_OCR_FAILED: extraction or submission error",
        },
      ],
    ]);
  } finally {
    await env.teardown();
  }
}, 60_000);

it("MailboxOcrReceiptWorkflow rejects a job reference for a different workflow type", async () => {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const workflowId = "mailbox-ocr-wrong-type";
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: TASK_QUEUE,
      workflowsPath,
      activities: {
        async mark_running() {
          throw new Error("must not be called");
        },
        async mailbox_ocr_receipt() {
          throw new Error("must not be called");
        },
        async ocr_mark_failed() {
          throw new Error("must not be called");
        },
      },
    });
    await expect(
      worker.runUntil(() =>
        env.client.workflow.execute("MailboxOcrReceiptWorkflow", {
          workflowId,
          taskQueue: TASK_QUEUE,
          args: [{ schemaVersion: 1, jobId: "33333333-3333-4333-8333-333333333333", workflowType: "OcrReceiptWorkflow", workflowId }],
        }),
      ),
    ).rejects.toThrow();
  } finally {
    await env.teardown();
  }
}, 60_000);

/**
 * Phase 3D-C Task 5 — MailboxMaterializeWorkflow. Receives only
 * MailboxWorkerMaterializationInputV1 ({scanRunId, candidateId}) and
 * invokes exactly one opaque broker operation by candidateId.
 */
it("MailboxMaterializeWorkflow invokes mailbox_materialize_candidate with candidateId and an opaque operationId", async () => {
  const calls: unknown[] = [];
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const workflowId = "mailbox-materialize-candidate-1";
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: TASK_QUEUE,
      workflowsPath,
      activities: {
        async mailbox_materialize_candidate(input: unknown) {
          calls.push(["materialize", input]);
          return {
            schemaVersion: 1,
            candidateId: "candidate-1",
            status: "queued",
            processingJobId: null,
            expenseId: null,
            sourceId: null,
            duplicateMatchId: null,
            idempotencyKey: "idem-1",
          };
        },
      },
    });
    const result = await worker.runUntil(() =>
      env.client.workflow.execute("MailboxMaterializeWorkflow", {
        workflowId,
        taskQueue: TASK_QUEUE,
        args: [{ scanRunId: "scan-1", candidateId: "candidate-1" }],
      }),
    );
    expect(result).toMatchObject({ candidateId: "candidate-1", status: "queued" });
    expect(calls).toEqual([
      ["materialize", { candidateId: "candidate-1", operationId: expect.any(String) }],
    ]);
    expect(await forbiddenFieldsInHistory(env, workflowId)).toBe(false);
  } finally {
    await env.teardown();
  }
}, 60_000);
