/**
 * Phase 3D-C Task 5 — activities/mailbox-ingestion.ts.
 *
 * Fully local with fakes: no real App API, no Google credentials, no
 * Docker. Proves the combined OCR activity never surfaces bytes/
 * extraction fields as anything other than its own single return value,
 * and that the materialize activity maps MailboxClientError codes the
 * same way activities/mailbox.ts already does.
 */
import { createHash } from "node:crypto";

import { ApplicationFailure } from "@temporalio/activity";
import { describe, expect, it, vi } from "vitest";

import { AppApiClientError, type AppApiClient } from "../src/clients/app-api.js";
import type { FoundryClient } from "../src/clients/foundry.js";
import { MailboxClientError, type MailboxAppApiClient } from "../src/clients/mailbox-client.js";
import {
  createMailboxMaterializeActivities,
  createMailboxOcrActivities,
} from "../src/activities/mailbox-ingestion.js";
import { extractFakeReceipt } from "../src/providers/fake-ocr.js";
import { createOpenAiReceiptExtractor } from "../src/providers/openai-ocr.js";
import { createReceiptExtractor } from "../src/providers/receipt-extractor.js";

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const jobReference = {
  schemaVersion: 1,
  jobId: JOB_ID,
  workflowType: "MailboxOcrReceiptWorkflow",
  workflowId: `mailbox-ocr-${JOB_ID}`,
} as const;

const ROUTE = { aiModelId: JOB_ID, providerKind: "openai", providerModelId: "gpt-5.4-mini" } as const;

const EXTRACTION = {
  schemaVersion: 1 as const,
  merchant: "Acme Hardware",
  amount: "42.50",
  currency: "USD",
  incurredOn: "2026-09-01",
  confidence: 0.95,
};

describe("mailbox_ocr_receipt", () => {
  it("resolves the balanced route once, downloads, verifies hash, extracts with the route, and submits in one call, returning only the new version", async () => {
    const data = Buffer.from("fake receipt bytes");
    const getOcrInput = vi.fn().mockResolvedValue({
      fileId: "file-1",
      expectedSha256: createHash("sha256").update(data).digest("hex"),
      modeKey: "ocr_mode_fast",
    });
    const downloadFile = vi.fn().mockResolvedValue(data);
    const submitResult = vi.fn().mockResolvedValue({ version: 5 });
    const extractReceipt = vi.fn().mockResolvedValue(EXTRACTION);
    const getEffectiveRoute = vi.fn().mockResolvedValue(ROUTE);

    const activities = createMailboxOcrActivities({
      appApi: { getOcrInput, downloadFile, submitResult } as unknown as AppApiClient,
      foundry: { getEffectiveRoute } as unknown as FoundryClient,
      extractReceipt,
    });

    const result = await activities.mailbox_ocr_receipt({ jobReference, expectedJobVersion: 2 });

    expect(result).toBe(5);
    expect(getEffectiveRoute).toHaveBeenCalledOnce();
    expect(getEffectiveRoute).toHaveBeenCalledWith({ operation: "RECEIPT_OCR", modeKey: "ocr_mode_balanced" });
    expect(extractReceipt).toHaveBeenCalledWith(data, ROUTE);
    expect(submitResult).toHaveBeenCalledWith(JOB_ID, {
      schemaVersion: 1,
      status: "SUCCEEDED",
      idempotencyKey: `${JOB_ID}:ocr:result:succeeded`,
      expectedJobVersion: 2,
      resultSchemaVersion: "ocr-extraction-v1",
      result: EXTRACTION,
    });
  });

  it("throws a non-retryable ApplicationFailure on a hash mismatch, without resolving a route or calling extractReceipt or submitResult", async () => {
    const getOcrInput = vi.fn().mockResolvedValue({
      fileId: "file-1",
      expectedSha256: "0".repeat(64),
      modeKey: "ocr_mode_fast",
    });
    const downloadFile = vi.fn().mockResolvedValue(Buffer.from("wrong bytes"));
    const submitResult = vi.fn();
    const extractReceipt = vi.fn();
    const getEffectiveRoute = vi.fn().mockResolvedValue(ROUTE);

    const activities = createMailboxOcrActivities({
      appApi: { getOcrInput, downloadFile, submitResult } as unknown as AppApiClient,
      foundry: { getEffectiveRoute } as unknown as FoundryClient,
      extractReceipt,
    });

    await expect(
      activities.mailbox_ocr_receipt({ jobReference, expectedJobVersion: 2 }),
    ).rejects.toMatchObject({ nonRetryable: true, type: "MailboxOcrHashMismatch" });
    expect(getEffectiveRoute).not.toHaveBeenCalled();
    expect(extractReceipt).not.toHaveBeenCalled();
    expect(submitResult).not.toHaveBeenCalled();
  });

  it("maps a failing getEffectiveRoute to a retryable MailboxOcrRouteUnavailable, without calling extractReceipt or submitResult", async () => {
    const data = Buffer.from("fake receipt bytes");
    const getOcrInput = vi.fn().mockResolvedValue({
      fileId: "file-1",
      expectedSha256: createHash("sha256").update(data).digest("hex"),
      modeKey: "ocr_mode_fast",
    });
    const downloadFile = vi.fn().mockResolvedValue(data);
    const submitResult = vi.fn();
    const extractReceipt = vi.fn();
    const getEffectiveRoute = vi.fn().mockRejectedValue(new Error("route lookup failed"));

    const activities = createMailboxOcrActivities({
      appApi: { getOcrInput, downloadFile, submitResult } as unknown as AppApiClient,
      foundry: { getEffectiveRoute } as unknown as FoundryClient,
      extractReceipt,
    });

    const error = await activities
      .mailbox_ocr_receipt({ jobReference, expectedJobVersion: 2 })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ type: "MailboxOcrRouteUnavailable", nonRetryable: false });
    expect(extractReceipt).not.toHaveBeenCalled();
    expect(submitResult).not.toHaveBeenCalled();
  });

  it("surfaces an extractor ApplicationFailure (e.g. OcrUnsupportedFormat) unchanged, non-retryable", async () => {
    const data = Buffer.from("fake receipt bytes");
    const getOcrInput = vi.fn().mockResolvedValue({
      fileId: "file-1",
      expectedSha256: createHash("sha256").update(data).digest("hex"),
      modeKey: "ocr_mode_fast",
    });
    const downloadFile = vi.fn().mockResolvedValue(data);
    const submitResult = vi.fn();
    const extractReceipt = vi.fn().mockRejectedValue(
      ApplicationFailure.nonRetryable("unsupported receipt format", "OcrUnsupportedFormat"),
    );
    const getEffectiveRoute = vi.fn().mockResolvedValue(ROUTE);

    const activities = createMailboxOcrActivities({
      appApi: { getOcrInput, downloadFile, submitResult } as unknown as AppApiClient,
      foundry: { getEffectiveRoute } as unknown as FoundryClient,
      extractReceipt,
    });

    const error = await activities
      .mailbox_ocr_receipt({ jobReference, expectedJobVersion: 2 })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ type: "OcrUnsupportedFormat", nonRetryable: true });
    expect(submitResult).not.toHaveBeenCalled();
  });

  // Fix round 1 (task-3-review.md, Important #2): composed with the REAL
  // Task 2 extractor stack (createReceiptExtractor + createOpenAiReceiptExtractor)
  // and a fake `fetch` -- unsupported attachment bytes, not an injected
  // ApplicationFailure, drive the rejection; sniffReceiptFormat must reject
  // these before any network call.
  it.each([
    ["a GIF", Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00])],
    ["a TIFF", Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00])],
    ["a ZIP/DOCX", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])],
  ])("rejects %s attachment as non-retryable OcrUnsupportedFormat through the real extractor, without calling fetch", async (_label, data) => {
    const getOcrInput = vi.fn().mockResolvedValue({
      fileId: "file-1",
      expectedSha256: createHash("sha256").update(data).digest("hex"),
      modeKey: "ocr_mode_fast",
    });
    const downloadFile = vi.fn().mockResolvedValue(data);
    const submitResult = vi.fn();
    const getEffectiveRoute = vi.fn().mockResolvedValue(ROUTE);
    const fakeFetch = vi.fn();
    const fakeOcrSpy = vi.fn(extractFakeReceipt);
    const extractReceipt = createReceiptExtractor({
      openai: createOpenAiReceiptExtractor({ apiKeys: ["test-key"], fetch: fakeFetch, log: () => undefined }),
      fake: fakeOcrSpy,
    });

    const activities = createMailboxOcrActivities({
      appApi: { getOcrInput, downloadFile, submitResult } as unknown as AppApiClient,
      foundry: { getEffectiveRoute } as unknown as FoundryClient,
      extractReceipt,
    });

    const error = await activities
      .mailbox_ocr_receipt({ jobReference, expectedJobVersion: 2 })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ type: "OcrUnsupportedFormat", nonRetryable: true });
    expect(fakeFetch).not.toHaveBeenCalled();
    expect(fakeOcrSpy).not.toHaveBeenCalled();
    expect(submitResult).not.toHaveBeenCalled();
  });

  it("keeps a retryable extractor ApplicationFailure retryable", async () => {
    const data = Buffer.from("fake receipt bytes");
    const getOcrInput = vi.fn().mockResolvedValue({
      fileId: "file-1",
      expectedSha256: createHash("sha256").update(data).digest("hex"),
      modeKey: "ocr_mode_fast",
    });
    const downloadFile = vi.fn().mockResolvedValue(data);
    const submitResult = vi.fn();
    const extractReceipt = vi.fn().mockRejectedValue(
      ApplicationFailure.retryable("OpenAI request failed", "OpenAiTransient"),
    );
    const getEffectiveRoute = vi.fn().mockResolvedValue(ROUTE);

    const activities = createMailboxOcrActivities({
      appApi: { getOcrInput, downloadFile, submitResult } as unknown as AppApiClient,
      foundry: { getEffectiveRoute } as unknown as FoundryClient,
      extractReceipt,
    });

    const error = await activities
      .mailbox_ocr_receipt({ jobReference, expectedJobVersion: 2 })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ type: "OpenAiTransient", nonRetryable: false });
    expect(submitResult).not.toHaveBeenCalled();
  });

  it("throws a non-retryable MailboxOcrExtractionFailed when the extractor throws an unclassified error (today's behavior)", async () => {
    const data = Buffer.from("fake receipt bytes");
    const getOcrInput = vi.fn().mockResolvedValue({
      fileId: "file-1",
      expectedSha256: createHash("sha256").update(data).digest("hex"),
      modeKey: "ocr_mode_fast",
    });
    const downloadFile = vi.fn().mockResolvedValue(data);
    const submitResult = vi.fn();
    const extractReceipt = vi.fn().mockRejectedValue(new Error("unclassified"));
    const getEffectiveRoute = vi.fn().mockResolvedValue(ROUTE);

    const activities = createMailboxOcrActivities({
      appApi: { getOcrInput, downloadFile, submitResult } as unknown as AppApiClient,
      foundry: { getEffectiveRoute } as unknown as FoundryClient,
      extractReceipt,
    });

    await expect(
      activities.mailbox_ocr_receipt({ jobReference, expectedJobVersion: 2 }),
    ).rejects.toMatchObject({ nonRetryable: true, type: "MailboxOcrExtractionFailed" });
    expect(submitResult).not.toHaveBeenCalled();
  });

  it("throws a non-retryable ApplicationFailure when the extraction result fails schema validation", async () => {
    const data = Buffer.from("fake receipt bytes");
    const getOcrInput = vi.fn().mockResolvedValue({
      fileId: "file-1",
      expectedSha256: createHash("sha256").update(data).digest("hex"),
      modeKey: "ocr_mode_fast",
    });
    const downloadFile = vi.fn().mockResolvedValue(data);
    const submitResult = vi.fn();
    const extractReceipt = vi.fn().mockResolvedValue({ not: "a valid extraction" });
    const getEffectiveRoute = vi.fn().mockResolvedValue(ROUTE);

    const activities = createMailboxOcrActivities({
      appApi: { getOcrInput, downloadFile, submitResult } as unknown as AppApiClient,
      foundry: { getEffectiveRoute } as unknown as FoundryClient,
      extractReceipt,
    });

    await expect(
      activities.mailbox_ocr_receipt({ jobReference, expectedJobVersion: 2 }),
    ).rejects.toMatchObject({ nonRetryable: true, type: "MailboxOcrExtractionFailed" });
    expect(submitResult).not.toHaveBeenCalled();
  });

  it("maps a permanent (4xx) submitResult failure to a non-retryable ApplicationFailure", async () => {
    const data = Buffer.from("fake receipt bytes");
    const getOcrInput = vi.fn().mockResolvedValue({
      fileId: "file-1",
      expectedSha256: null,
      modeKey: "ocr_mode_fast",
    });
    const downloadFile = vi.fn().mockResolvedValue(data);
    const submitResult = vi.fn().mockRejectedValue(new AppApiClientError("conflict", 409));
    const extractReceipt = vi.fn().mockResolvedValue(EXTRACTION);
    const getEffectiveRoute = vi.fn().mockResolvedValue(ROUTE);

    const activities = createMailboxOcrActivities({
      appApi: { getOcrInput, downloadFile, submitResult } as unknown as AppApiClient,
      foundry: { getEffectiveRoute } as unknown as FoundryClient,
      extractReceipt,
    });

    const error = await activities
      .mailbox_ocr_receipt({ jobReference, expectedJobVersion: 2 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
  });

  it("maps a transient (5xx) submitResult failure to a retryable ApplicationFailure", async () => {
    const data = Buffer.from("fake receipt bytes");
    const getOcrInput = vi.fn().mockResolvedValue({
      fileId: "file-1",
      expectedSha256: null,
      modeKey: "ocr_mode_fast",
    });
    const downloadFile = vi.fn().mockResolvedValue(data);
    const submitResult = vi.fn().mockRejectedValue(new AppApiClientError("unavailable", 503));
    const extractReceipt = vi.fn().mockResolvedValue(EXTRACTION);
    const getEffectiveRoute = vi.fn().mockResolvedValue(ROUTE);

    const activities = createMailboxOcrActivities({
      appApi: { getOcrInput, downloadFile, submitResult } as unknown as AppApiClient,
      foundry: { getEffectiveRoute } as unknown as FoundryClient,
      extractReceipt,
    });

    const error = await activities
      .mailbox_ocr_receipt({ jobReference, expectedJobVersion: 2 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(false);
  });
});

describe("createMailboxMaterializeActivities (fix round 1: mailbox-scoped identity only, never appApi)", () => {
  const JOB_REFERENCE = {
    schemaVersion: 1 as const,
    jobId: "11111111-1111-4111-8111-111111111111",
    workflowType: "MailboxMaterializeWorkflow" as const,
    workflowId: "job-11111111-1111-4111-8111-111111111111",
  };
  const CANDIDATE_ID = "22222222-2222-4222-8222-222222222222";
  const MATERIALIZATION_RESULT = {
    schemaVersion: 1,
    candidateId: CANDIDATE_ID,
    status: "queued",
    processingJobId: null,
    expenseId: null,
    sourceId: null,
    duplicateMatchId: null,
    idempotencyKey: "idem-1",
  };

  describe("mailbox_mark_running", () => {
    it("calls mailboxClient.mailboxJobStatus (never appApi) and returns the new version", async () => {
      const mailboxJobStatus = vi.fn().mockResolvedValue({ version: 2 });
      const activities = createMailboxMaterializeActivities({
        mailboxClient: { mailboxJobStatus } as unknown as MailboxAppApiClient,
      });

      const result = await activities.mailbox_mark_running({ jobReference: JOB_REFERENCE, expectedJobVersion: 1 });

      expect(result).toBe(2);
      expect(mailboxJobStatus).toHaveBeenCalledWith(JOB_REFERENCE.jobId, {
        schemaVersion: 1,
        status: "RUNNING",
        idempotencyKey: `${JOB_REFERENCE.jobId}:status:running`,
        expectedJobVersion: 1,
      });
    });

    it("maps a MailboxClientError to an ApplicationFailure", async () => {
      const mailboxJobStatus = vi.fn().mockRejectedValue(new MailboxClientError("unavailable"));
      const activities = createMailboxMaterializeActivities({
        mailboxClient: { mailboxJobStatus } as unknown as MailboxAppApiClient,
      });

      const error = await activities
        .mailbox_mark_running({ jobReference: JOB_REFERENCE, expectedJobVersion: 1 })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApplicationFailure);
      expect((error as ApplicationFailure).nonRetryable).toBe(false);
    });
  });

  describe("mailbox_materialize_job", () => {
    it("resolves candidateId via mailboxJobMaterializeInput, calls the broker, and submits via mailboxJobResult -- never appApi", async () => {
      const mailboxJobMaterializeInput = vi.fn().mockResolvedValue({ candidateId: CANDIDATE_ID });
      const mailboxJobResult = vi.fn().mockResolvedValue({ version: 3 });
      const materializeCandidate = vi.fn().mockResolvedValue(MATERIALIZATION_RESULT);
      const activities = createMailboxMaterializeActivities({
        mailboxClient: {
          mailboxJobMaterializeInput,
          mailboxJobResult,
          materializeCandidate,
        } as unknown as MailboxAppApiClient,
      });

      const result = await activities.mailbox_materialize_job({
        jobReference: JOB_REFERENCE,
        expectedJobVersion: 2,
      });

      expect(result).toBe(3);
      expect(mailboxJobMaterializeInput).toHaveBeenCalledWith(JOB_REFERENCE.jobId);
      expect(materializeCandidate).toHaveBeenCalledWith({
        candidateId: CANDIDATE_ID,
        operationId: JOB_REFERENCE.jobId,
      });
      expect(mailboxJobResult).toHaveBeenCalledWith(JOB_REFERENCE.jobId, {
        schemaVersion: 1,
        status: "SUCCEEDED",
        idempotencyKey: `${JOB_REFERENCE.jobId}:materialize:result:succeeded`,
        expectedJobVersion: 2,
        resultSchemaVersion: "mailbox-materialize-v1",
        result: MATERIALIZATION_RESULT,
      });
    });

    /**
     * Phase 3D-C Task 5 fix round 3 (Critical, task-6-review.md): a
     * broker result with status "failed" (every attachment terminally
     * blocked, no viable path) must submit the JOB as FAILED, never
     * SUCCEEDED -- the only way app-api's
     * maybeFailMailboxCandidateInTransaction ever runs for this job type.
     */
    it("submits the job as FAILED (not SUCCEEDED) when the broker's own result.status is 'failed'", async () => {
      const mailboxJobMaterializeInput = vi.fn().mockResolvedValue({ candidateId: CANDIDATE_ID });
      const mailboxJobResult = vi.fn().mockResolvedValue({ version: 3 });
      const failedResult = { ...MATERIALIZATION_RESULT, status: "failed" as const };
      const materializeCandidate = vi.fn().mockResolvedValue(failedResult);
      const activities = createMailboxMaterializeActivities({
        mailboxClient: {
          mailboxJobMaterializeInput,
          mailboxJobResult,
          materializeCandidate,
        } as unknown as MailboxAppApiClient,
      });

      const result = await activities.mailbox_materialize_job({
        jobReference: JOB_REFERENCE,
        expectedJobVersion: 2,
      });

      expect(result).toBe(3);
      expect(mailboxJobResult).toHaveBeenCalledWith(JOB_REFERENCE.jobId, {
        schemaVersion: 1,
        status: "FAILED",
        idempotencyKey: `${JOB_REFERENCE.jobId}:materialize:result:failed`,
        expectedJobVersion: 2,
        resultSchemaVersion: "mailbox-materialize-v1",
        result: failedResult,
        message: "MAILBOX_MATERIALIZE_FAILED: no viable attachment or structured receipt",
      });
    });

    it("maps a transient MailboxClientError from the materialize-input read to a retryable ApplicationFailure, never calling the broker or mailboxJobResult", async () => {
      const mailboxJobMaterializeInput = vi.fn().mockRejectedValue(new MailboxClientError("unavailable"));
      const materializeCandidate = vi.fn();
      const mailboxJobResult = vi.fn();
      const activities = createMailboxMaterializeActivities({
        mailboxClient: {
          mailboxJobMaterializeInput,
          mailboxJobResult,
          materializeCandidate,
        } as unknown as MailboxAppApiClient,
      });

      const error = await activities
        .mailbox_materialize_job({ jobReference: JOB_REFERENCE, expectedJobVersion: 2 })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApplicationFailure);
      expect((error as ApplicationFailure).nonRetryable).toBe(false);
      expect(materializeCandidate).not.toHaveBeenCalled();
      expect(mailboxJobResult).not.toHaveBeenCalled();
    });

    it("maps a transient MailboxClientError from the broker call to a retryable ApplicationFailure, never calling mailboxJobResult", async () => {
      const mailboxJobMaterializeInput = vi.fn().mockResolvedValue({ candidateId: CANDIDATE_ID });
      const mailboxJobResult = vi.fn();
      const materializeCandidate = vi.fn().mockRejectedValue(new MailboxClientError("unavailable"));
      const activities = createMailboxMaterializeActivities({
        mailboxClient: {
          mailboxJobMaterializeInput,
          mailboxJobResult,
          materializeCandidate,
        } as unknown as MailboxAppApiClient,
      });

      const error = await activities
        .mailbox_materialize_job({ jobReference: JOB_REFERENCE, expectedJobVersion: 2 })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApplicationFailure);
      expect((error as ApplicationFailure).nonRetryable).toBe(false);
      expect(mailboxJobResult).not.toHaveBeenCalled();
    });

    it("maps a permanent MailboxClientError from the broker call to a non-retryable ApplicationFailure", async () => {
      const mailboxJobMaterializeInput = vi.fn().mockResolvedValue({ candidateId: CANDIDATE_ID });
      const materializeCandidate = vi.fn().mockRejectedValue(new MailboxClientError("authorization_failed"));
      const activities = createMailboxMaterializeActivities({
        mailboxClient: {
          mailboxJobMaterializeInput,
          mailboxJobResult: vi.fn(),
          materializeCandidate,
        } as unknown as MailboxAppApiClient,
      });

      const error = await activities
        .mailbox_materialize_job({ jobReference: JOB_REFERENCE, expectedJobVersion: 2 })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApplicationFailure);
      expect((error as ApplicationFailure).nonRetryable).toBe(true);
    });
  });

  describe("mailbox_mark_failed", () => {
    it("calls mailboxClient.mailboxJobStatus with status FAILED and the message, returning the new version", async () => {
      const mailboxJobStatus = vi.fn().mockResolvedValue({ version: 5 });
      const activities = createMailboxMaterializeActivities({
        mailboxClient: { mailboxJobStatus } as unknown as MailboxAppApiClient,
      });

      const result = await activities.mailbox_mark_failed({
        jobReference: JOB_REFERENCE,
        expectedJobVersion: 4,
        message: "MAILBOX_MATERIALIZE_FAILED: broker materialize call or result submission error",
      });

      expect(result).toBe(5);
      expect(mailboxJobStatus).toHaveBeenCalledWith(JOB_REFERENCE.jobId, {
        schemaVersion: 1,
        status: "FAILED",
        idempotencyKey: `${JOB_REFERENCE.jobId}:materialize:status:failed`,
        expectedJobVersion: 4,
        message: "MAILBOX_MATERIALIZE_FAILED: broker materialize call or result submission error",
      });
    });

    it("maps a MailboxClientError to an ApplicationFailure", async () => {
      const mailboxJobStatus = vi.fn().mockRejectedValue(new MailboxClientError("unavailable"));
      const activities = createMailboxMaterializeActivities({
        mailboxClient: { mailboxJobStatus } as unknown as MailboxAppApiClient,
      });

      const error = await activities
        .mailbox_mark_failed({ jobReference: JOB_REFERENCE, expectedJobVersion: 4, message: "boom" })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApplicationFailure);
      expect((error as ApplicationFailure).nonRetryable).toBe(false);
    });
  });
});
