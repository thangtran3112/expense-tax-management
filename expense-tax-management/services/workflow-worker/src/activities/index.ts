import { createHash } from "node:crypto";

import { ExpenseEnrichmentInputResponseV1Schema, OcrExtractionResultV1Schema, type JobReferenceV1, type OcrExtractionResultV1 } from "@expense-tax/contracts";
import { ApplicationFailure } from "@temporalio/activity";

import { AppApiClientError, type AppApiClient } from "../clients/app-api.js";
import { FoundryClientError, type FoundryClient } from "../clients/foundry.js";
import { evaluateEnrichment } from "./enrichment.js";

export { createMailboxActivities, type MailboxActivityDependencies } from "./mailbox.js";

function permanentClientFailure(error: unknown): boolean {
  return error instanceof AppApiClientError && error.status !== undefined &&
    error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
}

async function downloadAndVerifyReceipt(
  appApi: AppApiClient,
  input: { fileId: string; expectedSha256: string | null },
): Promise<Uint8Array> {
  const data = await appApi.downloadFile(input.fileId);
  if (input.expectedSha256 !== null &&
    createHash("sha256").update(data).digest("hex") !== input.expectedSha256) {
    throw new Error("downloaded bytes do not match the confirmed file hash");
  }
  return data;
}

async function runExtraction(
  extractReceipt: ActivityDependencies["extractReceipt"],
  data: Uint8Array,
): Promise<OcrExtractionResultV1> {
  let extracted: OcrExtractionResultV1;
  try {
    extracted = await extractReceipt(data);
  } catch {
    throw ApplicationFailure.retryable("OCR extraction failed", "OcrExtractionTransient");
  }
  try {
    return OcrExtractionResultV1Schema.parse(extracted);
  } catch {
    throw ApplicationFailure.nonRetryable("OCR extraction result invalid", "OcrExtractionMalformed");
  }
}

export interface ActivityDependencies {
  readonly appApi: AppApiClient;
  readonly foundry: FoundryClient;
  readonly extractReceipt: (
    data: Uint8Array,
  ) => OcrExtractionResultV1 | Promise<OcrExtractionResultV1>;
}

export function createActivities({ appApi, foundry, extractReceipt }: ActivityDependencies) {
  return {
    async mark_running(input: {
      jobReference: JobReferenceV1;
      expectedJobVersion: number;
    }): Promise<number> {
      const jobId = input.jobReference.jobId;
      const job = await appApi.updateStatus(jobId, {
        schemaVersion: 1,
        status: "RUNNING",
        idempotencyKey: `${jobId}:status:running`,
        expectedJobVersion: input.expectedJobVersion,
      });
      return job.version;
    },
    async submit_echo_result(input: {
      jobReference: JobReferenceV1;
      expectedJobVersion: number;
    }): Promise<number> {
      const jobId = input.jobReference.jobId;
      const job = await appApi.submitResult(jobId, {
        schemaVersion: 1,
        status: "SUCCEEDED",
        idempotencyKey: `${jobId}:result:succeeded`,
        expectedJobVersion: input.expectedJobVersion,
        resultSchemaVersion: "foundation-echo-v1",
        result: { echo: jobId },
      });
      return job.version;
    },
    async ocr_get_input(input: { jobReference: JobReferenceV1 }) {
      return appApi.getOcrInput(input.jobReference.jobId);
    },
    async ocr_download_receipt(input: { fileId: string; expectedSha256: string | null }) {
      return downloadAndVerifyReceipt(appApi, input);
    },
    // Bug fix (2026-10-07): verify-only counterpart to ocr_download_receipt
    // used by the "ocr-receipt-bytes-in-activity" workflow path -- the
    // bytes never leave this activity, so Temporal history only records
    // the input (fileId/hash) and the void result.
    async ocr_verify_receipt(input: { fileId: string; expectedSha256: string | null }): Promise<void> {
      await downloadAndVerifyReceipt(appApi, input);
    },
    async ocr_resolve_route(input: { modeKey: "ocr_mode_fast" | "ocr_mode_balanced" | "ocr_mode_accurate" }) {
      return foundry.getEffectiveRoute({ operation: "RECEIPT_OCR", modeKey: input.modeKey });
    },
    async ocr_reserve(input: { jobReference: JobReferenceV1; tenantId: string; aiModelId: string }) {
      try {
        const reservation = await foundry.reserve({
          tenantId: input.tenantId,
          operation: "RECEIPT_OCR",
          aiModelId: input.aiModelId,
          idempotencyKey: `${input.jobReference.jobId}:ocr:reserve:v1`,
        });
        return { blocked: false, reservationId: reservation.id };
      } catch (error) {
        if (error instanceof FoundryClientError && error.code === "conflict") {
          return { blocked: true, reservationId: null };
        }
        throw error;
      }
    },
    async ocr_mark_call_started(input: { reservationId: string }) {
      await foundry.markCallStarted(input.reservationId);
      return 1;
    },
    async ocr_run_extraction(input: { data: Uint8Array }) {
      return runExtraction(extractReceipt, input.data);
    },
    // Bug fix (2026-10-07): downloads and extracts in one activity call so
    // the receipt bytes stay in-process instead of round-tripping through
    // the workflow (and its Temporal history) as ocr_run_extraction's
    // input/output used to.
    async ocr_extract_receipt(input: { fileId: string; expectedSha256: string | null }) {
      const data = await downloadAndVerifyReceipt(appApi, input);
      return runExtraction(extractReceipt, data);
    },
    async ocr_record_accepted(input: { reservationId: string }): Promise<void> {
      await foundry.recordOutcome(input.reservationId, 1, { outcome: "accepted" });
    },
    async ocr_release(input: { reservationId: string }): Promise<void> {
      await foundry.release(input.reservationId);
    },
    async ocr_submit_extraction(input: {
      jobReference: JobReferenceV1;
      expectedJobVersion: number;
      extraction: OcrExtractionResultV1;
    }) {
      const jobId = input.jobReference.jobId;
      const job = await appApi.submitResult(jobId, {
        schemaVersion: 1,
        status: "SUCCEEDED",
        idempotencyKey: `${jobId}:ocr:result:succeeded`,
        expectedJobVersion: input.expectedJobVersion,
        resultSchemaVersion: "ocr-extraction-v1",
        result: input.extraction,
      });
      return job.version;
    },
    async ocr_record_deduplication(input: {
      jobReference: JobReferenceV1;
      sourceFileId: string;
      expectedJobVersion: number;
      extraction: OcrExtractionResultV1;
    }) {
      const jobId = input.jobReference.jobId;
      try {
        return await appApi.recordDeduplicationEvidence(jobId, {
          schemaVersion: 1,
          jobId,
          sourceFileId: input.sourceFileId,
          merchant: input.extraction.merchant,
          amount: input.extraction.amount,
          currency: input.extraction.currency,
          incurredOn: input.extraction.incurredOn,
          ...(input.extraction.orderNumber ? { orderNumber: input.extraction.orderNumber } : {}),
          expectedJobVersion: input.expectedJobVersion,
          idempotencyKey: `${jobId}:ocr:dedup:v1`,
        });
      } catch (error) {
        if (error instanceof AppApiClientError && error.status !== undefined &&
            error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
          throw ApplicationFailure.nonRetryable(
            "Deduplication callback rejected",
            "DeduplicationCallbackNonRetryable",
          );
        }
        throw error;
      }
    },
    async ocr_submit_failed(input: { jobReference: JobReferenceV1; expectedJobVersion: number; error: string; message: string }) {
      const jobId = input.jobReference.jobId;
      const job = await appApi.submitResult(jobId, {
        schemaVersion: 1,
        status: "FAILED",
        idempotencyKey: `${jobId}:ocr:result:failed`,
        expectedJobVersion: input.expectedJobVersion,
        resultSchemaVersion: "ocr-extraction-v1",
        result: { error: input.error },
      });
      return job.version;
    },
    async ocr_mark_failed(input: { jobReference: JobReferenceV1; expectedJobVersion: number; message: string }) {
      const jobId = input.jobReference.jobId;
      const job = await appApi.updateStatus(jobId, {
        schemaVersion: 1,
        status: "FAILED",
        idempotencyKey: `${jobId}:ocr:status:failed`,
        expectedJobVersion: input.expectedJobVersion,
        message: input.message,
      });
      return job.version;
    },
    async enrichment_mark_running(jobId: string, dispatchedVersion: number): Promise<number> {
      const job = await appApi.updateStatus(jobId, {
        schemaVersion: 1,
        status: "RUNNING",
        idempotencyKey: `${jobId}:enrichment:status:running`,
        expectedJobVersion: dispatchedVersion,
      });
      return job.version;
    },
    async enrichment_process(jobId: string, runningVersion: number): Promise<string> {
      let raw: Awaited<ReturnType<AppApiClient["getEnrichmentInput"]>>;
      try {
        raw = await appApi.getEnrichmentInput(jobId);
      } catch (error) {
        if (error instanceof AppApiClientError && error.code === "invalid_response") {
          throw ApplicationFailure.nonRetryable("enrichment input rejected: response failed schema validation", "EnrichmentInputMalformed");
        }
        if (permanentClientFailure(error)) {
          throw ApplicationFailure.nonRetryable("enrichment input unavailable: permanent client error", "EnrichmentInputNonRetryable");
        }
        throw ApplicationFailure.retryable("enrichment input unavailable: transient transport error", "EnrichmentInputTransient");
      }

      let response: Awaited<ReturnType<typeof ExpenseEnrichmentInputResponseV1Schema.parse>>;
      try {
        response = ExpenseEnrichmentInputResponseV1Schema.parse(raw);
      } catch {
        throw ApplicationFailure.nonRetryable("enrichment input rejected: response failed schema validation", "EnrichmentInputMalformed");
      }
      let result;
      if (response.outcome === "evaluate") {
        try {
          result = evaluateEnrichment(response.input);
        } catch {
          throw ApplicationFailure.nonRetryable("enrichment evaluation failed: internal evaluator error", "EnrichmentEvaluatorError");
        }
      } else {
        result = { schemaVersion: 1 as const, rulesVersion: 1, outcome: response.outcome, ruleTagKeys: [], suggestions: [] };
      }

      try {
        await appApi.submitEnrichmentResult(jobId, {
          schemaVersion: 1,
          expectedJobVersion: runningVersion,
          idempotencyKey: `${jobId}:enrichment:result:v1`,
          result,
        });
      } catch (error) {
        if (permanentClientFailure(error)) {
          throw ApplicationFailure.nonRetryable("enrichment result rejected: permanent client error", "EnrichmentResultNonRetryable");
        }
        throw ApplicationFailure.retryable("enrichment result failed: transient transport error", "EnrichmentResultTransient");
      }
      return response.outcome;
    },
    async enrichment_mark_failed(jobId: string, runningVersion: number): Promise<number> {
      const job = await appApi.updateStatus(jobId, {
        schemaVersion: 1,
        status: "FAILED",
        idempotencyKey: `${jobId}:enrichment:status:failed`,
        expectedJobVersion: runningVersion,
        message: "ENRICHMENT_FAILED: inference or transport error",
      });
      return job.version;
    },
  };
}
