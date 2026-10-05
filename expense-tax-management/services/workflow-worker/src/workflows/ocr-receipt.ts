import type { JobReferenceV1, OcrExtractionResultV1, OcrJobInputV1 } from "@expense-tax/contracts";
import { isCancellation, proxyActivities } from "@temporalio/workflow";

import { requireJobReference } from "./job-reference.js";

interface OcrActivities {
  mark_running(input: { jobReference: JobReferenceV1; expectedJobVersion: number }): Promise<number>;
  ocr_get_input(input: { jobReference: JobReferenceV1 }): Promise<OcrJobInputV1>;
  ocr_download_receipt(input: { fileId: string; expectedSha256: string | null }): Promise<Uint8Array>;
  ocr_resolve_route(input: { modeKey: OcrJobInputV1["modeKey"] }): Promise<{ aiModelId: string }>;
  ocr_reserve(input: { jobReference: JobReferenceV1; tenantId: string; aiModelId: string }): Promise<{ blocked: boolean; reservationId: string | null }>;
  ocr_submit_failed(input: { jobReference: JobReferenceV1; expectedJobVersion: number; error: string; message: string }): Promise<number>;
  ocr_mark_call_started(input: { reservationId: string }): Promise<number>;
  ocr_run_extraction(input: { data: Uint8Array }): Promise<OcrExtractionResultV1>;
  ocr_record_accepted(input: { reservationId: string }): Promise<void>;
  ocr_submit_extraction(input: { jobReference: JobReferenceV1; expectedJobVersion: number; extraction: OcrExtractionResultV1 }): Promise<number>;
  ocr_record_deduplication(input: { jobReference: JobReferenceV1; sourceFileId: string; expectedJobVersion: number; extraction: OcrExtractionResultV1 }): Promise<unknown>;
  ocr_release(input: { reservationId: string }): Promise<void>;
  ocr_mark_failed(input: { jobReference: JobReferenceV1; expectedJobVersion: number; message: string }): Promise<number>;
}

const http = proxyActivities<OcrActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 5 },
});
const slow = proxyActivities<Pick<OcrActivities, "ocr_download_receipt">>({
  startToCloseTimeout: "60 seconds",
  retry: { maximumAttempts: 5 },
});
const quick = proxyActivities<Pick<OcrActivities, "ocr_run_extraction">>({
  startToCloseTimeout: "60 seconds",
  retry: { maximumAttempts: 2 },
});
const release = proxyActivities<Pick<OcrActivities, "ocr_release">>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 2 },
});

export async function runOcr(jobReference: JobReferenceV1): Promise<void> {
  let version = await http.mark_running({ jobReference, expectedJobVersion: 2 });

  async function fail(message: string): Promise<void> {
    try {
      await http.ocr_mark_failed({ jobReference, expectedJobVersion: version, message });
    } catch (error) {
      if (isCancellation(error)) throw error;
      // Match the legacy best-effort terminal callback.
    }
  }

  let input: OcrJobInputV1;
  try {
    input = await http.ocr_get_input({ jobReference });
  } catch (error) {
    if (isCancellation(error)) throw error;
    await fail("OCR_FAILED: could not load job input");
    return;
  }

  let data: Uint8Array;
  try {
    data = await slow.ocr_download_receipt({ fileId: input.fileId, expectedSha256: input.expectedSha256 });
  } catch (error) {
    if (isCancellation(error)) throw error;
    await fail("OCR_FAILED: could not download receipt bytes");
    return;
  }

  let route: { aiModelId: string };
  try {
    route = await http.ocr_resolve_route({ modeKey: input.modeKey });
  } catch (error) {
    if (isCancellation(error)) throw error;
    await fail("OCR_FAILED: no active route for mode");
    return;
  }

  let reservation: { blocked: boolean; reservationId: string | null };
  try {
    reservation = await http.ocr_reserve({ jobReference, tenantId: input.tenantId, aiModelId: route.aiModelId });
  } catch (error) {
    if (isCancellation(error)) throw error;
    await fail("OCR_FAILED: quota reservation error");
    return;
  }

  if (reservation.blocked) {
    await http.ocr_submit_failed({
      jobReference,
      expectedJobVersion: version,
      error: "QUOTA_BLOCKED",
      message: "QUOTA_BLOCKED: monthly RECEIPT_OCR allowance exhausted for this tenant",
    });
    return;
  }
  if (reservation.reservationId === null) {
    await fail("OCR_FAILED: quota reservation error");
    return;
  }
  const reservationId = reservation.reservationId;

  let extraction: OcrExtractionResultV1;
  let resultVersion: number;
  try {
    await http.ocr_mark_call_started({ reservationId });
    extraction = await quick.ocr_run_extraction({ data });
    await http.ocr_record_accepted({ reservationId });
    resultVersion = await http.ocr_submit_extraction({ jobReference, expectedJobVersion: version, extraction });
    version = resultVersion;
  } catch (error) {
    if (isCancellation(error)) throw error;
    try {
      await release.ocr_release({ reservationId });
    } catch (releaseError) {
      if (isCancellation(releaseError)) throw releaseError;
      // Preserve original failure after the best-effort release.
    }
    await fail("OCR_FAILED: extraction pipeline error");
    return;
  }

  // The App job already succeeded. A failing deduplication callback must not mark it failed.
  await http.ocr_record_deduplication({ jobReference, sourceFileId: input.fileId, expectedJobVersion: resultVersion, extraction });
}

export async function OcrReceiptWorkflow(jobReference: JobReferenceV1): Promise<void> {
  await runOcr(requireJobReference(jobReference, "OcrReceiptWorkflow"));
}
