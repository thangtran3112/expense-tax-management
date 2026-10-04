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
import { MailboxClientError, type MailboxAppApiClient } from "../src/clients/mailbox-client.js";
import {
  createMailboxMaterializeActivities,
  createMailboxOcrActivities,
} from "../src/activities/mailbox-ingestion.js";

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const jobReference = {
  schemaVersion: 1,
  jobId: JOB_ID,
  workflowType: "MailboxOcrReceiptWorkflow",
  workflowId: `mailbox-ocr-${JOB_ID}`,
} as const;

const EXTRACTION = {
  schemaVersion: 1 as const,
  merchant: "Acme Hardware",
  amount: "42.50",
  currency: "USD",
  incurredOn: "2026-09-01",
  confidence: 0.95,
};

describe("mailbox_ocr_receipt", () => {
  it("downloads, verifies hash, extracts, and submits in one call, returning only the new version", async () => {
    const data = Buffer.from("fake receipt bytes");
    const getOcrInput = vi.fn().mockResolvedValue({
      fileId: "file-1",
      expectedSha256: createHash("sha256").update(data).digest("hex"),
      modeKey: "ocr_mode_fast",
    });
    const downloadFile = vi.fn().mockResolvedValue(data);
    const submitResult = vi.fn().mockResolvedValue({ version: 5 });
    const extractReceipt = vi.fn().mockResolvedValue(EXTRACTION);

    const activities = createMailboxOcrActivities({
      appApi: { getOcrInput, downloadFile, submitResult } as unknown as AppApiClient,
      extractReceipt,
    });

    const result = await activities.mailbox_ocr_receipt({ jobReference, expectedJobVersion: 2 });

    expect(result).toBe(5);
    expect(extractReceipt).toHaveBeenCalledWith(data);
    expect(submitResult).toHaveBeenCalledWith(JOB_ID, {
      schemaVersion: 1,
      status: "SUCCEEDED",
      idempotencyKey: `${JOB_ID}:ocr:result:succeeded`,
      expectedJobVersion: 2,
      resultSchemaVersion: "ocr-extraction-v1",
      result: EXTRACTION,
    });
  });

  it("throws a non-retryable ApplicationFailure on a hash mismatch, without calling extractReceipt or submitResult", async () => {
    const getOcrInput = vi.fn().mockResolvedValue({
      fileId: "file-1",
      expectedSha256: "0".repeat(64),
      modeKey: "ocr_mode_fast",
    });
    const downloadFile = vi.fn().mockResolvedValue(Buffer.from("wrong bytes"));
    const submitResult = vi.fn();
    const extractReceipt = vi.fn();

    const activities = createMailboxOcrActivities({
      appApi: { getOcrInput, downloadFile, submitResult } as unknown as AppApiClient,
      extractReceipt,
    });

    await expect(
      activities.mailbox_ocr_receipt({ jobReference, expectedJobVersion: 2 }),
    ).rejects.toMatchObject({ nonRetryable: true, type: "MailboxOcrHashMismatch" });
    expect(extractReceipt).not.toHaveBeenCalled();
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

    const activities = createMailboxOcrActivities({
      appApi: { getOcrInput, downloadFile, submitResult } as unknown as AppApiClient,
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

    const activities = createMailboxOcrActivities({
      appApi: { getOcrInput, downloadFile, submitResult } as unknown as AppApiClient,
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

    const activities = createMailboxOcrActivities({
      appApi: { getOcrInput, downloadFile, submitResult } as unknown as AppApiClient,
      extractReceipt,
    });

    const error = await activities
      .mailbox_ocr_receipt({ jobReference, expectedJobVersion: 2 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(false);
  });
});

describe("mailbox_materialize_job", () => {
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

  it("resolves candidateId, calls the broker by opaque jobId-as-operationId, and submits the opaque result", async () => {
    const getMaterializeInput = vi.fn().mockResolvedValue({ candidateId: CANDIDATE_ID });
    const submitResult = vi.fn().mockResolvedValue({ version: 3 });
    const materializeCandidate = vi.fn().mockResolvedValue(MATERIALIZATION_RESULT);
    const activities = createMailboxMaterializeActivities({
      appApi: { getMaterializeInput, submitResult } as unknown as AppApiClient,
      mailboxClient: { materializeCandidate } as unknown as MailboxAppApiClient,
    });

    const result = await activities.mailbox_materialize_job({
      jobReference: JOB_REFERENCE,
      expectedJobVersion: 2,
    });

    expect(result).toBe(3);
    expect(getMaterializeInput).toHaveBeenCalledWith(JOB_REFERENCE.jobId);
    expect(materializeCandidate).toHaveBeenCalledWith({
      candidateId: CANDIDATE_ID,
      operationId: JOB_REFERENCE.jobId,
    });
    expect(submitResult).toHaveBeenCalledWith(JOB_REFERENCE.jobId, {
      schemaVersion: 1,
      status: "SUCCEEDED",
      idempotencyKey: `${JOB_REFERENCE.jobId}:materialize:result:succeeded`,
      expectedJobVersion: 2,
      resultSchemaVersion: "mailbox-materialize-v1",
      result: MATERIALIZATION_RESULT,
    });
  });

  it("maps a transient MailboxClientError from the broker call to a retryable ApplicationFailure, never calling submitResult", async () => {
    const getMaterializeInput = vi.fn().mockResolvedValue({ candidateId: CANDIDATE_ID });
    const submitResult = vi.fn();
    const materializeCandidate = vi.fn().mockRejectedValue(new MailboxClientError("unavailable"));
    const activities = createMailboxMaterializeActivities({
      appApi: { getMaterializeInput, submitResult } as unknown as AppApiClient,
      mailboxClient: { materializeCandidate } as unknown as MailboxAppApiClient,
    });

    const error = await activities
      .mailbox_materialize_job({ jobReference: JOB_REFERENCE, expectedJobVersion: 2 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(false);
    expect(submitResult).not.toHaveBeenCalled();
  });

  it("maps a permanent MailboxClientError from the broker call to a non-retryable ApplicationFailure", async () => {
    const getMaterializeInput = vi.fn().mockResolvedValue({ candidateId: CANDIDATE_ID });
    const materializeCandidate = vi.fn().mockRejectedValue(new MailboxClientError("authorization_failed"));
    const activities = createMailboxMaterializeActivities({
      appApi: { getMaterializeInput, submitResult: vi.fn() } as unknown as AppApiClient,
      mailboxClient: { materializeCandidate } as unknown as MailboxAppApiClient,
    });

    const error = await activities
      .mailbox_materialize_job({ jobReference: JOB_REFERENCE, expectedJobVersion: 2 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
  });
});
