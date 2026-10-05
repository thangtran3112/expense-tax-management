import { createHash } from "node:crypto";

import { expect, it, vi } from "vitest";

import { AppApiClientError, type AppApiClient } from "../src/clients/app-api.js";
import { FoundryClientError, type FoundryClient } from "../src/clients/foundry.js";
import { createActivities } from "../src/activities/index.js";

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const jobReference = {
  schemaVersion: 1,
  jobId: JOB_ID,
  workflowType: "FoundationEchoWorkflow",
  workflowId: `echo-${JOB_ID}`,
} as const;

it("writes the echo status and result with stable keys and chained versions", async () => {
  const updateStatus = vi.fn().mockResolvedValue({ version: 3 });
  const submitResult = vi.fn().mockResolvedValue({ version: 4 });
  const activities = createActivities({
    appApi: { updateStatus, submitResult } as unknown as AppApiClient,
    foundry: {} as FoundryClient,
    extractReceipt: vi.fn(),
  });

  await expect(activities.mark_running({ jobReference, expectedJobVersion: 2 })).resolves.toBe(3);
  await expect(activities.submit_echo_result({ jobReference, expectedJobVersion: 3 })).resolves.toBe(4);
  expect(updateStatus).toHaveBeenCalledWith(JOB_ID, {
    schemaVersion: 1,
    status: "RUNNING",
    idempotencyKey: `${JOB_ID}:status:running`,
    expectedJobVersion: 2,
  });
  expect(submitResult).toHaveBeenCalledWith(JOB_ID, {
    schemaVersion: 1,
    status: "SUCCEEDED",
    idempotencyKey: `${JOB_ID}:result:succeeded`,
    expectedJobVersion: 3,
    resultSchemaVersion: "foundation-echo-v1",
    result: { echo: JOB_ID },
  });
});

it("verifies OCR bytes and sends versioned extraction and deduplication callbacks", async () => {
  const data = new Uint8Array([1, 2, 3]);
  const sha = createHash("sha256").update(data).digest("hex");
  const getOcrInput = vi.fn().mockResolvedValue({ fileId: JOB_ID });
  const downloadFile = vi.fn().mockResolvedValue(data);
  const submitResult = vi.fn().mockResolvedValue({ version: 4 });
  const recordDeduplicationEvidence = vi.fn().mockResolvedValue({ decision: "no_match", matchIds: [] });
  const reserve = vi.fn().mockResolvedValue({ id: JOB_ID });
  const recordOutcome = vi.fn().mockResolvedValue({ id: JOB_ID });
  const extraction = {
    schemaVersion: 1 as const, merchant: "Fake OCR Merchant", amount: "12.34",
    currency: "USD", incurredOn: "2026-09-09", confidence: 1,
  };
  const activities = createActivities({
    appApi: { getOcrInput, downloadFile, submitResult, recordDeduplicationEvidence } as unknown as AppApiClient,
    foundry: { reserve, recordOutcome } as unknown as FoundryClient,
    extractReceipt: () => extraction,
  });
  const ocrJob = { ...jobReference, workflowType: "OcrReceiptWorkflow" as const };

  await expect(activities.ocr_get_input({ jobReference: ocrJob })).resolves.toEqual({ fileId: JOB_ID });
  await expect(activities.ocr_download_receipt({ fileId: JOB_ID, expectedSha256: sha })).resolves.toEqual(data);
  await expect(activities.ocr_download_receipt({ fileId: JOB_ID, expectedSha256: "0".repeat(64) })).rejects.toThrow();
  await expect(activities.ocr_reserve({ jobReference: ocrJob, tenantId: JOB_ID, aiModelId: JOB_ID })).resolves.toEqual({ blocked: false, reservationId: JOB_ID });
  await expect(activities.ocr_run_extraction({ data })).resolves.toEqual(extraction);
  await activities.ocr_record_accepted({ reservationId: JOB_ID });
  await expect(activities.ocr_submit_extraction({ jobReference: ocrJob, expectedJobVersion: 3, extraction })).resolves.toBe(4);
  await activities.ocr_record_deduplication({ jobReference: ocrJob, sourceFileId: JOB_ID, expectedJobVersion: 4, extraction });

  expect(reserve).toHaveBeenCalledWith({ tenantId: JOB_ID, operation: "RECEIPT_OCR", aiModelId: JOB_ID, idempotencyKey: `${JOB_ID}:ocr:reserve:v1` });
  expect(recordOutcome).toHaveBeenCalledWith(JOB_ID, 1, { outcome: "accepted" });
  expect(submitResult).toHaveBeenCalledWith(JOB_ID, expect.objectContaining({
    status: "SUCCEEDED", expectedJobVersion: 3, idempotencyKey: `${JOB_ID}:ocr:result:succeeded`,
    resultSchemaVersion: "ocr-extraction-v1", result: extraction,
  }));
  expect(recordDeduplicationEvidence).toHaveBeenCalledWith(JOB_ID, expect.objectContaining({
    expectedJobVersion: 4, sourceFileId: JOB_ID, idempotencyKey: `${JOB_ID}:ocr:dedup:v1`,
  }));
});

it("maps a quota conflict to blocked instead of retrying a reservation", async () => {
  const reserve = vi.fn().mockRejectedValue(new FoundryClientError("conflict", 409));
  const activities = createActivities({
    appApi: {} as AppApiClient,
    foundry: { reserve } as unknown as FoundryClient,
    extractReceipt: vi.fn(),
  });

  await expect(activities.ocr_reserve({ jobReference, tenantId: JOB_ID, aiModelId: JOB_ID })).resolves.toEqual({ blocked: true, reservationId: null });
  expect(reserve).toHaveBeenCalledOnce();
});

it("redacts provider extraction failures without losing retryability", async () => {
  const activities = createActivities({
    appApi: {} as AppApiClient,
    foundry: {} as FoundryClient,
    extractReceipt: () => { throw new Error("raw-provider-secret"); },
  });
  const failure = await activities.ocr_run_extraction({ data: new Uint8Array([1]) }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ type: "OcrExtractionTransient", nonRetryable: false });
  expect(String(failure)).not.toContain("raw-provider-secret");
  expect(failure.cause).toBeUndefined();
});

it("rejects malformed provider extraction permanently without leaking its fields", async () => {
  const activities = createActivities({
    appApi: {} as AppApiClient,
    foundry: {} as FoundryClient,
    extractReceipt: () => ({ schemaVersion: 1, merchant: "raw-provider-secret", amount: "invalid" }) as never,
  });
  const failure = await activities.ocr_run_extraction({ data: new Uint8Array([1]) }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ type: "OcrExtractionMalformed", nonRetryable: true });
  expect(String(failure)).not.toContain("raw-provider-secret");
});

it("keeps enrichment input and result inside one activity with a fixed result key", async () => {
  const getEnrichmentInput = vi.fn().mockResolvedValue({ outcome: "stale" });
  const submitEnrichmentResult = vi.fn().mockResolvedValue({ version: 4 });
  const activities = createActivities({
    appApi: { getEnrichmentInput, submitEnrichmentResult } as unknown as AppApiClient,
    foundry: {} as FoundryClient,
    extractReceipt: vi.fn(),
  });

  await expect(activities.enrichment_process(JOB_ID, 3)).resolves.toBe("stale");
  expect(getEnrichmentInput).toHaveBeenCalledWith(JOB_ID);
  expect(submitEnrichmentResult).toHaveBeenCalledWith(JOB_ID, {
    schemaVersion: 1,
    expectedJobVersion: 3,
    idempotencyKey: `${JOB_ID}:enrichment:result:v1`,
    result: { schemaVersion: 1, rulesVersion: 1, outcome: "stale", ruleTagKeys: [], suggestions: [] },
  });
});

it("classifies permanent enrichment result failures without exposing provider data", async () => {
  const activities = createActivities({
    appApi: {
      getEnrichmentInput: vi.fn().mockResolvedValue({ outcome: "skipped" }),
      submitEnrichmentResult: vi.fn().mockRejectedValue(new AppApiClientError("invalid_request", 422)),
    } as unknown as AppApiClient,
    foundry: {} as FoundryClient,
    extractReceipt: vi.fn(),
  });

  const failure = await activities.enrichment_process(JOB_ID, 3).catch((error: unknown) => error);
  expect(failure).toMatchObject({ type: "EnrichmentResultNonRetryable", nonRetryable: true });
  expect(String(failure)).not.toContain(JOB_ID);
});
