/**
 * Phase 3D-B Task 3 — workflows/mailbox-scan.ts, run through a real
 * Temporal test environment (same pattern as test/workflows.test.ts).
 *
 * Inspects serialized workflow inputs/activity inputs/history for the
 * absence of history/cursor/pre-fence/provider-message fields -- only
 * scanRunId/tenantId/connectionId/requestId/counts/page-sequence ever
 * cross into Temporal.
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

it("MailboxScanWorkflow calls discover with only scanRunId until a page is exhausted", async () => {
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
          calls.push(input);
          const pageSequence = calls.length;
          return pageSequence < 3
            ? { scanRunId: "scan-1", pageSequence, candidateCount: 2, retryCount: 0 }
            : { scanRunId: "scan-1", pageSequence, candidateCount: 0, retryCount: 0 };
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
      { scanRunId: "scan-1" },
      { scanRunId: "scan-1" },
      { scanRunId: "scan-1" },
    ]);
    expect(await forbiddenFieldsInHistory(env, workflowId)).toBe(false);
  } finally {
    await env.teardown();
  }
}, 60_000);

it("MailboxScanWorkflow fails non-retryably after the maximum page count", async () => {
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
  } finally {
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
