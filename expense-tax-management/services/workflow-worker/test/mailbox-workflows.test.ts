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
