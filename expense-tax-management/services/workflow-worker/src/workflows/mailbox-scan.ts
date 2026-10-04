/**
 * Phase 3D-B Task 3 — opaque mailbox-scan orchestration.
 *
 * Two workflows:
 *
 * - `MailboxScanWorkflow(input)` -- the actual scan. Receives only
 *   `{schemaVersion, scanRunId}` (MailboxScanExecutionInputV1) and
 *   repeatedly calls the `mailbox_discover_page` activity with nothing
 *   but that same `scanRunId` until a page reports no more candidates and
 *   no outstanding retries (the broker resolves connectionId/cursor/fence
 *   state itself via App API's `loadScanBinding`; none of it ever
 *   reaches this workflow or Temporal history). A page-count safety cap
 *   mirrors the spec's 100-message hard maximum per scan. Fix round 1:
 *   always calls the opaque `mailbox_finalize_scan` terminal callback
 *   exactly once -- succeeded on a clean finish, failed on the page-limit
 *   error and on cancellation (run in a non-cancellable scope, the
 *   Temporal TS SDK's documented cleanup-during-cancellation pattern, so
 *   the callback itself can't be aborted by the same cancellation it's
 *   reacting to).
 *
 * - `MailboxScheduledScanTriggerWorkflow(input)` -- the daily Temporal
 *   Schedule's target. A Schedule's action args are fixed at creation
 *   time, so it cannot carry a real `scanRunId` (that's minted by App
 *   API's lease/idempotency ledger only when the schedule fires). This
 *   thin workflow takes the two values a Schedule CAN carry unchanged
 *   forever (`tenantId`/`connectionId`), mints the scan run via the
 *   `mailbox_start_scheduled_scan` activity, and -- only if that returns
 *   "started", never on "skipped_overlap" -- starts `MailboxScanWorkflow`
 *   as its child with the resulting opaque `scanRunId`.
 */
import {
  ApplicationFailure,
  CancellationScope,
  executeChild,
  isCancellation,
  proxyActivities,
  workflowInfo,
} from "@temporalio/workflow";
import {
  AI_WORKER_TASK_QUEUE,
  MAILBOX_MATERIALIZE_WORKFLOW_TYPE,
  MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE,
  MAILBOX_SCAN_WORKFLOW_TYPE,
  type DiscoveryPageV1,
  type JobReferenceV1,
  type MailboxScanExecutionInputV1,
} from "@expense-tax/contracts";

import { requireJobReference } from "./job-reference.js";

/**
 * Inline activity interfaces, same convention as every other workflow
 * file here (e.g. workflows/ocr-receipt.ts's `OcrActivities`) rather than
 * importing activities/mailbox.ts's implementation module into workflow
 * code.
 */
interface MailboxDiscoveryActivities {
  mailbox_discover_page(input: { scanRunId: string }): Promise<DiscoveryPageV1>;
}

interface MailboxScheduleActivities {
  mailbox_start_scheduled_scan(input: {
    tenantId: string;
    connectionId: string;
    requestId: string;
  }): Promise<{ status: "started" | "skipped_overlap"; scanRunId: string }>;
}

interface MailboxFinalizeActivities {
  mailbox_finalize_scan(input: {
    scanRunId: string;
    outcome: "succeeded" | "failed";
  }): Promise<void>;
}

const { mailbox_discover_page } = proxyActivities<MailboxDiscoveryActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 5 },
});

const { mailbox_start_scheduled_scan } = proxyActivities<MailboxScheduleActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});

const { mailbox_finalize_scan } = proxyActivities<MailboxFinalizeActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 5 },
});

/** Spec: initial sync caps at 100 messages; one page call is one unit of
 * (opaque) discovery progress, so this bounds total pages the same way. */
const MAX_DISCOVERY_PAGES = 100;

export function mailboxScanWorkflowId(scanRunId: string): string {
  return `mailbox-scan-${scanRunId}`;
}

async function finalizeScan(scanRunId: string, outcome: "succeeded" | "failed"): Promise<void> {
  // Non-cancellable: this callback must still run (and can't itself be
  // aborted) when it's being called BECAUSE the workflow was cancelled.
  await CancellationScope.nonCancellable(() => mailbox_finalize_scan({ scanRunId, outcome }));
}

export async function MailboxScanWorkflow(input: MailboxScanExecutionInputV1): Promise<void> {
  try {
    for (let page = 0; page < MAX_DISCOVERY_PAGES; page += 1) {
      const result = await mailbox_discover_page({ scanRunId: input.scanRunId });
      if (result.candidateCount === 0 && result.retryCount === 0) {
        await finalizeScan(input.scanRunId, "succeeded");
        return;
      }
    }
  } catch (error) {
    // Covers both a discover-page activity failure and cancellation --
    // either way this run never reached a clean finish, so it finalizes
    // failed and rethrows the original error (cancellation included)
    // unchanged.
    await finalizeScan(input.scanRunId, "failed");
    throw error;
  }

  await finalizeScan(input.scanRunId, "failed");
  throw ApplicationFailure.nonRetryable(
    "mailbox scan exceeded the maximum discovery page count",
    "MailboxScanPageLimitExceeded",
  );
}

export interface MailboxScheduledScanTriggerInputV1 {
  readonly tenantId: string;
  readonly connectionId: string;
}

export async function MailboxScheduledScanTriggerWorkflow(
  input: MailboxScheduledScanTriggerInputV1,
): Promise<void> {
  const requestId = workflowInfo().firstExecutionRunId;
  const result = await mailbox_start_scheduled_scan({
    tenantId: input.tenantId,
    connectionId: input.connectionId,
    requestId,
  });
  if (result.status !== "started") return;

  await executeChild(MAILBOX_SCAN_WORKFLOW_TYPE, {
    workflowId: mailboxScanWorkflowId(result.scanRunId),
    taskQueue: AI_WORKER_TASK_QUEUE,
    args: [{ schemaVersion: 1, scanRunId: result.scanRunId }],
  });
}

/**
 * Phase 3D-C Task 5 — opaque mailbox-OCR materialization. Receives only a
 * `JobReferenceV1` (same shape every job-dispatched workflow receives);
 * one combined activity does get-input/download/extract/submit so bytes
 * and extraction fields never become a separate Temporal history event
 * (see activities/mailbox-ingestion.ts's own header comment). Dispatched
 * through the existing processing_job_dispatch_outbox/dispatchPendingJobs
 * path (App API domain/mailbox-ingestion.ts), same as every other job
 * type -- no bespoke one-shot start call.
 */
interface MailboxOcrActivities {
  mark_running(input: { jobReference: JobReferenceV1; expectedJobVersion: number }): Promise<number>;
  mailbox_ocr_receipt(input: { jobReference: JobReferenceV1; expectedJobVersion: number }): Promise<number>;
  ocr_mark_failed(input: {
    jobReference: JobReferenceV1;
    expectedJobVersion: number;
    message: string;
  }): Promise<number>;
}

const mailboxOcr = proxyActivities<MailboxOcrActivities>({
  startToCloseTimeout: "90 seconds",
  retry: { maximumAttempts: 3 },
});

export async function MailboxOcrReceiptWorkflow(jobReference: JobReferenceV1): Promise<void> {
  const ref = requireJobReference(jobReference, MAILBOX_OCR_RECEIPT_WORKFLOW_TYPE);
  const version = await mailboxOcr.mark_running({ jobReference: ref, expectedJobVersion: 2 });
  try {
    await mailboxOcr.mailbox_ocr_receipt({ jobReference: ref, expectedJobVersion: version });
  } catch (error) {
    if (isCancellation(error)) throw error;
    try {
      await mailboxOcr.ocr_mark_failed({
        jobReference: ref,
        expectedJobVersion: version,
        message: "MAILBOX_OCR_FAILED: extraction or submission error",
      });
    } catch (failError) {
      if (isCancellation(failError)) throw failError;
      // Best-effort terminal callback, same precedent as ocr-receipt.ts's fail().
    }
  }
}

/**
 * Phase 3D-C Task 5 gap closure — opaque materialize trigger, now
 * dispatched exactly like MailboxOcrReceiptWorkflow above: created and
 * dispatched by domain/mailbox-candidates.ts's resolveCandidate through
 * the ordinary processing_jobs/dispatch-outbox/dispatchPendingJobs
 * mechanism, so it receives only a `JobReferenceV1` -- never the
 * candidateId directly (that's resolved by the activity itself,
 * read-only, via App's new materialize-input route). One combined
 * activity does candidateId-resolution/broker-call/result-submit so no
 * intermediate value becomes its own Temporal history event; only this
 * workflow's own mark_running/ocr_mark_failed callbacks (reused from
 * MailboxOcrReceiptWorkflow's own proxy group, fully generic) and the
 * final opaque MailboxMaterializationResultV1 ever cross the boundary.
 */
interface MailboxMaterializeActivities {
  mailbox_mark_running(input: { jobReference: JobReferenceV1; expectedJobVersion: number }): Promise<number>;
  mailbox_materialize_job(input: { jobReference: JobReferenceV1; expectedJobVersion: number }): Promise<number>;
  mailbox_mark_failed(input: {
    jobReference: JobReferenceV1;
    expectedJobVersion: number;
    message: string;
  }): Promise<number>;
}

const mailboxMaterialize = proxyActivities<MailboxMaterializeActivities>({
  startToCloseTimeout: "60 seconds",
  retry: { maximumAttempts: 3 },
});

export async function MailboxMaterializeWorkflow(jobReference: JobReferenceV1): Promise<void> {
  const ref = requireJobReference(jobReference, MAILBOX_MATERIALIZE_WORKFLOW_TYPE);
  // Fix round 1 (review Important #1): every App callback below goes
  // through mailboxMaterialize's own mailbox-scoped identity activities
  // -- never mailboxOcr's generic ones (reserved for
  // MailboxOcrReceiptWorkflow only).
  const version = await mailboxMaterialize.mailbox_mark_running({ jobReference: ref, expectedJobVersion: 2 });
  try {
    await mailboxMaterialize.mailbox_materialize_job({ jobReference: ref, expectedJobVersion: version });
  } catch (error) {
    if (isCancellation(error)) throw error;
    try {
      await mailboxMaterialize.mailbox_mark_failed({
        jobReference: ref,
        expectedJobVersion: version,
        message: "MAILBOX_MATERIALIZE_FAILED: broker materialize call or result submission error",
      });
    } catch (failError) {
      if (isCancellation(failError)) throw failError;
    }
  }
}
