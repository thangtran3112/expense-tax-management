import { createHash } from "node:crypto";

import { ApplicationFailure } from "@temporalio/activity";
import { expect, it, vi } from "vitest";

import { AppApiClientError, type AppApiClient } from "../src/clients/app-api.js";
import { FoundryClientError, type FoundryClient } from "../src/clients/foundry.js";
import { createActivities } from "../src/activities/index.js";
import { extractFakeReceipt } from "../src/providers/fake-ocr.js";
import { createOpenAiReceiptExtractor } from "../src/providers/openai-ocr.js";
import { createReceiptExtractor } from "../src/providers/receipt-extractor.js";

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const ROUTE = { providerKind: "fake", providerModelId: "fake-ocr-v1" } as const;
const OPENAI_ROUTE = { providerKind: "openai", providerModelId: "gpt-5.4-mini" } as const;
// Minimal valid JPEG signature -- just enough for sniffReceiptFormat to
// accept it so these composed tests reach the real OpenAI call/parse path.
const VALID_JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);

function openAiMessageResponse(raw: Record<string, unknown>) {
  return {
    status: 200,
    ok: true,
    json: async () => ({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(raw) }] }],
    }),
  } as unknown as Response;
}

function openAiStatusResponse(status: number) {
  return {
    status,
    ok: false,
    body: { cancel: async () => undefined },
  } as unknown as Response;
}
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

it("ocr_extract_receipt passes the downloaded bytes and route to the injected extractor and returns its schema-validated result", async () => {
  const data = new Uint8Array([1, 2, 3]);
  const downloadFile = vi.fn().mockResolvedValue(data);
  const extraction = {
    schemaVersion: 1 as const, merchant: "Acme", amount: "9.99",
    currency: "USD", incurredOn: "2026-09-09", confidence: 0.8,
  };
  const extractReceipt = vi.fn().mockResolvedValue(extraction);
  const activities = createActivities({
    appApi: { downloadFile } as unknown as AppApiClient,
    foundry: {} as FoundryClient,
    extractReceipt,
  });

  await expect(
    activities.ocr_extract_receipt({ fileId: JOB_ID, expectedSha256: null, route: ROUTE }),
  ).resolves.toEqual(extraction);
  expect(extractReceipt).toHaveBeenCalledWith(data, ROUTE);
});

it("rethrows an ApplicationFailure from the extractor unchanged, not rewrapped", async () => {
  const downloadFile = vi.fn().mockResolvedValue(new Uint8Array([1]));
  const extractReceipt = vi.fn().mockRejectedValue(
    ApplicationFailure.nonRetryable("unsupported format", "OcrUnsupportedFormat"),
  );
  const activities = createActivities({
    appApi: { downloadFile } as unknown as AppApiClient,
    foundry: {} as FoundryClient,
    extractReceipt,
  });

  const failure = await activities
    .ocr_extract_receipt({ fileId: JOB_ID, expectedSha256: null, route: ROUTE })
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({ type: "OcrUnsupportedFormat", nonRetryable: true });
});

it("redacts an unclassified extractor error as retryable OcrExtractionTransient", async () => {
  const downloadFile = vi.fn().mockResolvedValue(new Uint8Array([1]));
  const extractReceipt = vi.fn().mockRejectedValue(new Error("raw-provider-secret"));
  const activities = createActivities({
    appApi: { downloadFile } as unknown as AppApiClient,
    foundry: {} as FoundryClient,
    extractReceipt,
  });

  const failure = await activities
    .ocr_extract_receipt({ fileId: JOB_ID, expectedSha256: null, route: ROUTE })
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({ type: "OcrExtractionTransient", nonRetryable: false });
  expect(String(failure)).not.toContain("raw-provider-secret");
  expect((failure as ApplicationFailure).cause).toBeUndefined();
});

it("fails non-retryably with OcrRouteMissing when route is undefined, without downloading or extracting", async () => {
  const downloadFile = vi.fn();
  const extractReceipt = vi.fn();
  const activities = createActivities({
    appApi: { downloadFile } as unknown as AppApiClient,
    foundry: {} as FoundryClient,
    extractReceipt,
  });

  const failure = await activities
    .ocr_extract_receipt({ fileId: JOB_ID, expectedSha256: null })
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({ type: "OcrRouteMissing", nonRetryable: true });
  expect(downloadFile).not.toHaveBeenCalled();
  expect(extractReceipt).not.toHaveBeenCalled();
});

it("rejects a malformed extractor result permanently without leaking its fields", async () => {
  const downloadFile = vi.fn().mockResolvedValue(new Uint8Array([1]));
  const extractReceipt = vi.fn().mockResolvedValue(
    { schemaVersion: 1, merchant: "raw-provider-secret", amount: "invalid" } as never,
  );
  const activities = createActivities({
    appApi: { downloadFile } as unknown as AppApiClient,
    foundry: {} as FoundryClient,
    extractReceipt,
  });

  const failure = await activities
    .ocr_extract_receipt({ fileId: JOB_ID, expectedSha256: null, route: ROUTE })
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({ type: "OcrExtractionMalformed", nonRetryable: true });
  expect(String(failure)).not.toContain("raw-provider-secret");
});

it("legacy ocr_run_extraction still returns the fake result directly, ignoring the injected extractor", async () => {
  const extractReceipt = vi.fn();
  const activities = createActivities({
    appApi: {} as AppApiClient,
    foundry: {} as FoundryClient,
    extractReceipt,
  });

  await expect(activities.ocr_run_extraction({ data: new Uint8Array([1, 2, 3]) })).resolves.toMatchObject({
    merchant: "Fake OCR Merchant",
  });
  expect(extractReceipt).not.toHaveBeenCalled();
});

// Fix round 1 (task-3-review.md, Important #1): composed with the REAL
// Task 2 extractor stack (createReceiptExtractor + createOpenAiReceiptExtractor)
// and a fake `fetch`, not a stubbed extractor -- pins the whole classification
// chain from a fake OpenAI response through ocr_extract_receipt.
it.each([
  ["a zero amount", { merchant: "Acme", amount: "0.00", currency: "USD", incurredOn: "2026-09-09", orderNumber: null, notes: null, confidence: 0.9 }],
  ["a date with a time component", { merchant: "Acme", amount: "9.99", currency: "USD", incurredOn: "2019-11-20 11:05 AM", orderNumber: null, notes: null, confidence: 0.9 }],
])("rejects a malformed real OpenAI result (%s) as retryable OcrExtractionMalformed, unchanged", async (_label, raw) => {
  const downloadFile = vi.fn().mockResolvedValue(VALID_JPEG_BYTES);
  const fakeFetch = vi.fn().mockResolvedValue(openAiMessageResponse(raw));
  const fakeOcrSpy = vi.fn(extractFakeReceipt);
  const extractReceipt = createReceiptExtractor({
    openai: createOpenAiReceiptExtractor({ apiKeys: ["test-key"], fetch: fakeFetch, log: () => undefined }),
    fake: fakeOcrSpy,
  });
  const activities = createActivities({
    appApi: { downloadFile } as unknown as AppApiClient,
    foundry: {} as FoundryClient,
    extractReceipt,
  });

  const failure = await activities
    .ocr_extract_receipt({ fileId: JOB_ID, expectedSha256: null, route: OPENAI_ROUTE })
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ApplicationFailure);
  expect(failure).toMatchObject({ type: "OcrExtractionMalformed", nonRetryable: false });
  expect(fakeOcrSpy).not.toHaveBeenCalled();
});

it("rejects retryably with OpenAiTransient when every key gets an HTTP 500, never falling back to the fake extractor", async () => {
  const downloadFile = vi.fn().mockResolvedValue(VALID_JPEG_BYTES);
  const fakeFetch = vi.fn().mockResolvedValue(openAiStatusResponse(500));
  const fakeOcrSpy = vi.fn(extractFakeReceipt);
  const extractReceipt = createReceiptExtractor({
    openai: createOpenAiReceiptExtractor({ apiKeys: ["test-key"], fetch: fakeFetch, log: () => undefined }),
    fake: fakeOcrSpy,
  });
  const activities = createActivities({
    appApi: { downloadFile } as unknown as AppApiClient,
    foundry: {} as FoundryClient,
    extractReceipt,
  });

  const failure = await activities
    .ocr_extract_receipt({ fileId: JOB_ID, expectedSha256: null, route: OPENAI_ROUTE })
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ApplicationFailure);
  expect(failure).toMatchObject({ type: "OpenAiTransient", nonRetryable: false });
  expect(fakeOcrSpy).not.toHaveBeenCalled();
  expect(JSON.stringify(failure)).not.toContain("Fake OCR Merchant");
});

it("rejects non-retryably when OpenAI answers HTTP 400 for every key", async () => {
  const downloadFile = vi.fn().mockResolvedValue(VALID_JPEG_BYTES);
  const fakeFetch = vi.fn().mockResolvedValue(openAiStatusResponse(400));
  const extractReceipt = createReceiptExtractor({
    openai: createOpenAiReceiptExtractor({ apiKeys: ["test-key"], fetch: fakeFetch, log: () => undefined }),
    fake: extractFakeReceipt,
  });
  const activities = createActivities({
    appApi: { downloadFile } as unknown as AppApiClient,
    foundry: {} as FoundryClient,
    extractReceipt,
  });

  const failure = await activities
    .ocr_extract_receipt({ fileId: JOB_ID, expectedSha256: null, route: OPENAI_ROUTE })
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ApplicationFailure);
  expect(failure).toMatchObject({ nonRetryable: true });
  expect((failure as ApplicationFailure).type).toBe("OpenAiRejectedRequest");
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
