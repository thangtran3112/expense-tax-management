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
  proxyActivities,
  workflowInfo,
} from "@temporalio/workflow";
import {
  AI_WORKER_TASK_QUEUE,
  MAILBOX_SCAN_WORKFLOW_TYPE,
  type DiscoveryPageV1,
  type MailboxScanExecutionInputV1,
} from "@expense-tax/contracts";

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
