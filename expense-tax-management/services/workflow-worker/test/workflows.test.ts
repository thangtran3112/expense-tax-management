import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { ApplicationFailure } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { expect, it, vi } from "vitest";

import { createActivities } from "../src/activities/index.js";
import { AppApiClientError, type AppApiClient } from "../src/clients/app-api.js";
import type { FoundryClient } from "../src/clients/foundry.js";
import { extractFakeReceipt } from "../src/providers/fake-ocr.js";

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const TASK_QUEUE = "expense-tax-processing";
const workflowsPath = fileURLToPath(new URL("../src/workflows/index.ts", import.meta.url));

it("marks an echo job running before submitting its version-chained result", async () => {
  const calls: unknown[][] = [];
  const env = await TestWorkflowEnvironment.createTimeSkipping();

  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: TASK_QUEUE,
      workflowsPath,
      activities: {
        async mark_running(input: unknown) {
          calls.push(["mark_running", input]);
          return 3;
        },
        async submit_echo_result(input: unknown) {
          calls.push(["submit_echo_result", input]);
          return 4;
        },
      },
    });

    await worker.runUntil(() =>
      env.client.workflow.execute("FoundationEchoWorkflow", {
        workflowId: `echo-${JOB_ID}`,
        taskQueue: TASK_QUEUE,
        args: [{ schemaVersion: 1, jobId: JOB_ID, workflowType: "FoundationEchoWorkflow", workflowId: `echo-${JOB_ID}` }],
      }),
    );

    expect(calls).toEqual([
      ["mark_running", { jobReference: { schemaVersion: 1, jobId: JOB_ID, workflowType: "FoundationEchoWorkflow", workflowId: `echo-${JOB_ID}` }, expectedJobVersion: 2 }],
      ["submit_echo_result", { jobReference: { schemaVersion: 1, jobId: JOB_ID, workflowType: "FoundationEchoWorkflow", workflowId: `echo-${JOB_ID}` }, expectedJobVersion: 3 }],
    ]);
  } finally {
    await env.teardown();
  }
}, 60_000);

it("rejects an invalid job reference before running any activity", async () => {
  const calls: string[] = [];
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection, namespace: env.namespace,
      taskQueue: TASK_QUEUE, workflowsPath,
      activities: {
        async mark_running() { calls.push("running"); return 3; },
        async submit_echo_result() { calls.push("result"); return 4; },
      },
    });
    const workflowId = `invalid-${JOB_ID}`;
    await expect(worker.runUntil(() => env.client.workflow.execute("FoundationEchoWorkflow", {
      workflowId, taskQueue: TASK_QUEUE,
      args: [{ schemaVersion: 1, jobId: "not-a-uuid", workflowType: "FoundationEchoWorkflow", workflowId }],
    }))).rejects.toThrow();
    expect(calls).toEqual([]);
  } finally {
    await env.teardown();
  }
}, 60_000);

it("delegates forwarded receipts to the OCR pipeline without a child workflow", async () => {
  const workflows = await import("../src/workflows/index.js");
  expect(workflows.ForwardedReceiptWorkflow).toBeTypeOf("function");
  const calls: string[] = [];
  const jobReference = {
    schemaVersion: 1,
    jobId: JOB_ID,
    workflowType: "ForwardedReceiptWorkflow",
    workflowId: `forwarded-${JOB_ID}`,
  };
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: TASK_QUEUE,
      workflowsPath,
      activities: {
        async mark_running() { calls.push("mark_running"); return 3; },
        async ocr_get_input() {
          calls.push("ocr_get_input");
          throw ApplicationFailure.nonRetryable("unavailable");
        },
        async ocr_mark_failed() { calls.push("ocr_mark_failed"); return 4; },
      },
    });
    await worker.runUntil(() => env.client.workflow.execute("ForwardedReceiptWorkflow", {
      workflowId: jobReference.workflowId, taskQueue: TASK_QUEUE, args: [jobReference],
    }));
    expect(calls).toEqual(["mark_running", "ocr_get_input", "ocr_mark_failed"]);
  } finally {
    await env.teardown();
  }
}, 60_000);

it("enrichment chains dispatched and running versions using only primitive activity arguments", async () => {
  const workflows = await import("../src/workflows/index.js");
  expect(workflows.ExpenseEnrichmentWorkflow).toBeTypeOf("function");
  const calls: unknown[][] = [];
  const jobReference = {
    schemaVersion: 1,
    jobId: JOB_ID,
    workflowType: "ExpenseEnrichmentWorkflow",
    workflowId: `enrichment-${JOB_ID}`,
  };
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection, namespace: env.namespace,
      taskQueue: TASK_QUEUE, workflowsPath,
      activities: {
        async enrichment_mark_running(...args: unknown[]) { calls.push(["running", ...args]); return 3; },
        async enrichment_process(...args: unknown[]) { calls.push(["process", ...args]); return "applied"; },
        async enrichment_mark_failed() { throw Error("unexpected failure callback"); },
      },
    });
    await worker.runUntil(() => env.client.workflow.execute("ExpenseEnrichmentWorkflow", {
      workflowId: jobReference.workflowId, taskQueue: TASK_QUEUE, args: [jobReference],
    }));
    expect(calls).toEqual([["running", JOB_ID, 2], ["process", JOB_ID, 3]]);
  } finally {
    await env.teardown();
  }
}, 60_000);

it.each([
  { label: "transient", attempts: 5, failure: () => ApplicationFailure.retryable("temporary", "EnrichmentResultTransient") },
  { label: "permanent", attempts: 1, failure: () => ApplicationFailure.nonRetryable("invalid", "EnrichmentInputMalformed") },
])("fails enrichment after $label process errors and calls back once", async ({ attempts, failure }) => {
  const calls: string[] = [];
  const jobReference = {
    schemaVersion: 1,
    jobId: JOB_ID,
    workflowType: "ExpenseEnrichmentWorkflow",
    workflowId: `enrichment-${attempts}-${JOB_ID}`,
  };
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection, namespace: env.namespace,
      taskQueue: TASK_QUEUE, workflowsPath,
      activities: {
        async enrichment_mark_running() { calls.push("running"); return 3; },
        async enrichment_process() { calls.push("process"); throw failure(); },
        async enrichment_mark_failed() { calls.push("failed"); return 4; },
      },
    });
    await expect(worker.runUntil(() => env.client.workflow.execute("ExpenseEnrichmentWorkflow", {
      workflowId: jobReference.workflowId, taskQueue: TASK_QUEUE, args: [jobReference],
    }))).rejects.toThrow();
    expect(calls).toEqual(["running", ...Array<string>(attempts).fill("process"), "failed"]);
  } finally {
    await env.teardown();
  }
}, 60_000);

it("rejects duplicate workflow starts while an enrichment job is in flight", async () => {
  let resume!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const startedActivity = new Promise<void>((resolve) => { started = resolve; });
  let processCount = 0;
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const args = [{ schemaVersion: 1, jobId: JOB_ID, workflowType: "ExpenseEnrichmentWorkflow", workflowId: `duplicate-${JOB_ID}` }];
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection, namespace: env.namespace,
      taskQueue: TASK_QUEUE, workflowsPath,
      activities: {
        async enrichment_mark_running() { return 3; },
        async enrichment_process() { processCount++; started(); await gate; return "stale"; },
      },
    });
    await worker.runUntil(async () => {
      const options = { workflowId: `duplicate-${JOB_ID}`, taskQueue: TASK_QUEUE, args };
      const handle = await env.client.workflow.start("ExpenseEnrichmentWorkflow", options);
      await startedActivity;
      await expect(env.client.workflow.start("ExpenseEnrichmentWorkflow", options)).rejects.toThrow();
      resume();
      await handle.result();
    });
    expect(processCount).toBe(1);
  } finally {
    resume();
    await env.teardown();
  }
}, 60_000);

it("cancellation stops current work without scheduling later callbacks", async () => {
  let resume!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const startedActivity = new Promise<void>((resolve) => { started = resolve; });
  const calls: string[] = [];
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection, namespace: env.namespace,
      taskQueue: TASK_QUEUE, workflowsPath,
      activities: {
        async enrichment_mark_running() { calls.push("running"); started(); await gate; return 3; },
        async enrichment_process() { calls.push("process"); return "applied"; },
        async enrichment_mark_failed() { calls.push("failed"); return 4; },
      },
    });
    await worker.runUntil(async () => {
      const workflowId = `cancelled-${JOB_ID}`;
      const handle = await env.client.workflow.start("ExpenseEnrichmentWorkflow", {
        workflowId, taskQueue: TASK_QUEUE,
        args: [{ schemaVersion: 1, jobId: JOB_ID, workflowType: "ExpenseEnrichmentWorkflow", workflowId }],
      });
      await startedActivity;
      await handle.cancel();
      resume();
      await expect(handle.result()).rejects.toThrow();
    });
    expect(calls).toEqual(["running"]);
  } finally {
    resume();
    await env.teardown();
  }
}, 60_000);

it("OCR cancellation propagates without scheduling a failed callback", async () => {
  let resume!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const startedActivity = new Promise<void>((resolve) => { started = resolve; });
  const calls: string[] = [];
  const workflowId = `cancelled-ocr-${JOB_ID}`;
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection, namespace: env.namespace,
      taskQueue: TASK_QUEUE, workflowsPath,
      activities: {
        async mark_running() { return 3; },
        async ocr_get_input() { calls.push("input"); started(); await gate; throw ApplicationFailure.nonRetryable("cancelled"); },
        async ocr_mark_failed() { calls.push("failed callback"); return 4; },
      },
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("OcrReceiptWorkflow", {
        workflowId, taskQueue: TASK_QUEUE,
        args: [{ schemaVersion: 1, jobId: JOB_ID, workflowType: "OcrReceiptWorkflow", workflowId }],
      });
      await startedActivity;
      await handle.cancel();
      resume();
      await expect(handle.result()).rejects.toThrow();
    });
    expect(calls).toEqual(["input"]);
  } finally {
    resume();
    await env.teardown();
  }
}, 60_000);

it("re-reads enrichment input after a transient result callback failure", async () => {
  const getEnrichmentInput = vi.fn().mockResolvedValue({ outcome: "stale" });
  const submitEnrichmentResult = vi.fn()
    .mockRejectedValueOnce(new AppApiClientError("unavailable", 503))
    .mockResolvedValue({ version: 4 });
  const updateStatus = vi.fn().mockResolvedValue({ version: 3 });
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection, namespace: env.namespace,
      taskQueue: TASK_QUEUE, workflowsPath,
      activities: createActivities({
        appApi: { getEnrichmentInput, submitEnrichmentResult, updateStatus } as unknown as AppApiClient,
        foundry: {} as FoundryClient, extractReceipt: extractFakeReceipt,
      }),
    });
    const workflowId = `enrichment-retry-${JOB_ID}`;
    await worker.runUntil(() => env.client.workflow.execute("ExpenseEnrichmentWorkflow", {
      workflowId, taskQueue: TASK_QUEUE,
      args: [{ schemaVersion: 1, jobId: JOB_ID, workflowType: "ExpenseEnrichmentWorkflow", workflowId }],
    }));
    expect(getEnrichmentInput).toHaveBeenCalledTimes(2);
    expect(submitEnrichmentResult).toHaveBeenCalledTimes(2);
    expect(submitEnrichmentResult.mock.calls[0]?.[1]).toEqual(submitEnrichmentResult.mock.calls[1]?.[1]);
    expect(updateStatus).toHaveBeenCalledOnce();
  } finally {
    await env.teardown();
  }
}, 60_000);

it("finishes OCR before recording deduplication with the returned job version", async () => {
  const calls: Array<[string, unknown]> = [];
  const jobReference = {
    schemaVersion: 1,
    jobId: JOB_ID,
    workflowType: "OcrReceiptWorkflow",
    workflowId: `ocr-${JOB_ID}`,
  };
  const extraction = {
    schemaVersion: 1,
    merchant: "Fake OCR Merchant",
    amount: "12.34",
    currency: "USD",
    incurredOn: "2026-09-09",
    confidence: 1,
  };
  const activities = Object.fromEntries([
    ["mark_running", 3],
    ["ocr_get_input", { fileId: "44444444-4444-4444-8444-444444444444", expectedSha256: null, modeKey: "ocr_mode_balanced", tenantId: "22222222-2222-4222-8222-222222222222", schemaVersion: 1 }],
    ["ocr_download_receipt", new Uint8Array([1])],
    ["ocr_resolve_route", { aiModelId: "55555555-5555-4555-8555-555555555555" }],
    ["ocr_reserve", { blocked: false, reservationId: "66666666-6666-4666-8666-666666666666" }],
    ["ocr_mark_call_started", 1],
    ["ocr_run_extraction", extraction],
    ["ocr_record_accepted", undefined],
    ["ocr_submit_extraction", 4],
    ["ocr_record_deduplication", { decision: "no_match", matchIds: [] }],
  ].map(([name, result]) => [name, async (input: unknown) => { calls.push([name as string, input]); return result; }]));
  const env = await TestWorkflowEnvironment.createTimeSkipping();

  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: TASK_QUEUE,
      workflowsPath,
      activities,
    });
    await worker.runUntil(() =>
      env.client.workflow.execute("OcrReceiptWorkflow", {
        workflowId: jobReference.workflowId,
        taskQueue: TASK_QUEUE,
        args: [jobReference],
      }),
    );

    expect(calls.map(([name]) => name)).toEqual([
      "mark_running", "ocr_get_input", "ocr_download_receipt", "ocr_resolve_route",
      "ocr_reserve", "ocr_mark_call_started", "ocr_run_extraction", "ocr_record_accepted",
      "ocr_submit_extraction", "ocr_record_deduplication",
    ]);
    expect(calls[0]?.[1]).toEqual({ jobReference, expectedJobVersion: 2 });
    expect(calls[8]?.[1]).toMatchObject({ expectedJobVersion: 3, extraction });
    expect(calls[9]?.[1]).toMatchObject({ expectedJobVersion: 4 });
  } finally {
    await env.teardown();
  }
}, 60_000);

it("runs real OCR activities with versioned callbacks through Temporal", async () => {
  const fileId = "44444444-4444-4444-8444-444444444444";
  const reservationId = "66666666-6666-4666-8666-666666666666";
  const data = new Uint8Array([1, 2, 3]);
  const calls: string[] = [];
  const appApi = {
    async updateStatus() { calls.push("running"); return { version: 3 }; },
    async getOcrInput() { calls.push("input"); return { schemaVersion: 1, fileId, modeKey: "ocr_mode_balanced", tenantId: JOB_ID, expectedSha256: createHash("sha256").update(data).digest("hex") }; },
    async downloadFile() { calls.push("download"); return data; },
    async submitResult() { calls.push("result"); return { version: 4 }; },
    async recordDeduplicationEvidence() { calls.push("dedup"); return { decision: "no_match", matchIds: [] }; },
  } as unknown as AppApiClient;
  const foundry = {
    async getEffectiveRoute() { calls.push("route"); return { aiModelId: "55555555-5555-4555-8555-555555555555" }; },
    async reserve() { calls.push("reserve"); return { id: reservationId }; },
    async markCallStarted() { calls.push("started"); return { id: reservationId }; },
    async recordOutcome() { calls.push("accepted"); return { id: reservationId }; },
  } as unknown as FoundryClient;
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const workflowId = `ocr-real-${JOB_ID}`;
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection, namespace: env.namespace,
      taskQueue: TASK_QUEUE, workflowsPath,
      activities: createActivities({ appApi, foundry, extractReceipt: extractFakeReceipt }),
    });
    await worker.runUntil(() => env.client.workflow.execute("OcrReceiptWorkflow", {
      workflowId, taskQueue: TASK_QUEUE,
      args: [{ schemaVersion: 1, jobId: JOB_ID, workflowType: "OcrReceiptWorkflow", workflowId }],
    }));
    expect(calls).toEqual(["running", "input", "download", "route", "reserve", "started", "accepted", "result", "dedup"]);
  } finally {
    await env.teardown();
  }
}, 60_000);

it("ends an OCR quota conflict with a typed failed result", async () => {
  const calls: Array<[string, unknown]> = [];
  const workflowId = `quota-${JOB_ID}`;
  const jobReference = { schemaVersion: 1, jobId: JOB_ID, workflowType: "OcrReceiptWorkflow", workflowId };
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection, namespace: env.namespace,
      taskQueue: TASK_QUEUE, workflowsPath,
      activities: {
        async mark_running() { return 3; },
        async ocr_get_input() { return { fileId: JOB_ID, modeKey: "ocr_mode_balanced", expectedSha256: null, tenantId: JOB_ID }; },
        async ocr_download_receipt() { return new Uint8Array([1]); },
        async ocr_resolve_route() { return { aiModelId: JOB_ID }; },
        async ocr_reserve() { return { blocked: true, reservationId: null }; },
        async ocr_submit_failed(input: unknown) { calls.push(["failed", input]); return 4; },
      },
    });
    await worker.runUntil(() => env.client.workflow.execute("OcrReceiptWorkflow", {
      workflowId, taskQueue: TASK_QUEUE, args: [jobReference],
    }));
    expect(calls).toEqual([["failed", expect.objectContaining({
      expectedJobVersion: 3, error: "QUOTA_BLOCKED",
    })]]);
  } finally {
    await env.teardown();
  }
}, 60_000);

it("reports a missing reservation ID as an OCR failure", async () => {
  const calls: string[] = [];
  const workflowId = `missing-reservation-${JOB_ID}`;
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection, namespace: env.namespace,
      taskQueue: TASK_QUEUE, workflowsPath,
      activities: {
        async mark_running() { return 3; },
        async ocr_get_input() { return { fileId: JOB_ID, modeKey: "ocr_mode_balanced", expectedSha256: null, tenantId: JOB_ID }; },
        async ocr_download_receipt() { return new Uint8Array([1]); },
        async ocr_resolve_route() { return { aiModelId: JOB_ID }; },
        async ocr_reserve() { return { blocked: false, reservationId: null }; },
        async ocr_mark_failed() { calls.push("failed"); return 4; },
      },
    });
    await worker.runUntil(() => env.client.workflow.execute("OcrReceiptWorkflow", {
      workflowId, taskQueue: TASK_QUEUE,
      args: [{ schemaVersion: 1, jobId: JOB_ID, workflowType: "OcrReceiptWorkflow", workflowId }],
    }));
    expect(calls).toEqual(["failed"]);
  } finally {
    await env.teardown();
  }
}, 8_000);

it("releases a reservation before reporting an extraction failure", async () => {
  const calls: string[] = [];
  const workflowId = `ocr-failed-${JOB_ID}`;
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection, namespace: env.namespace,
      taskQueue: TASK_QUEUE, workflowsPath,
      activities: {
        async mark_running() { return 3; },
        async ocr_get_input() { return { fileId: JOB_ID, modeKey: "ocr_mode_balanced", expectedSha256: null, tenantId: JOB_ID }; },
        async ocr_download_receipt() { return new Uint8Array([1]); },
        async ocr_resolve_route() { return { aiModelId: JOB_ID }; },
        async ocr_reserve() { return { blocked: false, reservationId: JOB_ID }; },
        async ocr_mark_call_started() { return 1; },
        async ocr_run_extraction() { throw ApplicationFailure.nonRetryable("provider failed"); },
        async ocr_release() { calls.push("release"); },
        async ocr_mark_failed(input: { message: string }) { calls.push(input.message); return 4; },
      },
    });
    await worker.runUntil(() => env.client.workflow.execute("OcrReceiptWorkflow", {
      workflowId, taskQueue: TASK_QUEUE,
      args: [{ schemaVersion: 1, jobId: JOB_ID, workflowType: "OcrReceiptWorkflow", workflowId }],
    }));
    expect(calls).toEqual(["release", "OCR_FAILED: extraction pipeline error"]);
    const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
    const release = history.events?.find((event) =>
      event.activityTaskScheduledEventAttributes?.activityType?.name === "ocr_release");
    expect(release).toBeDefined();
    expect(release?.activityTaskScheduledEventAttributes?.startToCloseTimeout?.seconds?.toString()).toBe("30");
    expect(release?.activityTaskScheduledEventAttributes?.retryPolicy?.maximumAttempts).toBe(2);
  } finally {
    await env.teardown();
  }
}, 60_000);

it("never marks a succeeded OCR job failed when deduplication fails", async () => {
  const calls: string[] = [];
  const workflowId = `ocr-dedup-failed-${JOB_ID}`;
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection, namespace: env.namespace,
      taskQueue: TASK_QUEUE, workflowsPath,
      activities: {
        async mark_running() { return 3; },
        async ocr_get_input() { return { fileId: JOB_ID, modeKey: "ocr_mode_balanced", expectedSha256: null, tenantId: JOB_ID }; },
        async ocr_download_receipt() { return new Uint8Array([1]); },
        async ocr_resolve_route() { return { aiModelId: JOB_ID }; },
        async ocr_reserve() { return { blocked: false, reservationId: JOB_ID }; },
        async ocr_mark_call_started() { return 1; },
        async ocr_run_extraction() { return { schemaVersion: 1, merchant: "Fake OCR Merchant", amount: "12.34", currency: "USD", incurredOn: "2026-09-09", confidence: 1 }; },
        async ocr_record_accepted() { calls.push("accepted"); },
        async ocr_submit_extraction() { calls.push("succeeded"); return 4; },
        async ocr_record_deduplication() { calls.push("dedup"); throw ApplicationFailure.nonRetryable("invalid callback"); },
        async ocr_mark_failed() { calls.push("illegal failure callback"); return 5; },
      },
    });
    await expect(worker.runUntil(() => env.client.workflow.execute("OcrReceiptWorkflow", {
      workflowId, taskQueue: TASK_QUEUE,
      args: [{ schemaVersion: 1, jobId: JOB_ID, workflowType: "OcrReceiptWorkflow", workflowId }],
    }))).rejects.toThrow();
    expect(calls).toEqual(["accepted", "succeeded", "dedup"]);
  } finally {
    await env.teardown();
  }
}, 60_000);
