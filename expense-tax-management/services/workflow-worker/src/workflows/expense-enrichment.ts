import type { JobReferenceV1 } from "@expense-tax/contracts";
import { proxyActivities } from "@temporalio/workflow";

import { requireJobReference } from "./job-reference.js";

interface EnrichmentActivities {
  enrichment_mark_running(jobId: string, dispatchedVersion: number): Promise<number>;
  enrichment_process(jobId: string, runningVersion: number): Promise<string>;
  enrichment_mark_failed(jobId: string, runningVersion: number): Promise<number>;
}

const http = proxyActivities<EnrichmentActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 5 },
});
const process = proxyActivities<Pick<EnrichmentActivities, "enrichment_process">>({
  startToCloseTimeout: "60 seconds",
  retry: { maximumAttempts: 5 },
});

export async function ExpenseEnrichmentWorkflow(jobReference: JobReferenceV1): Promise<void> {
  const jobId = requireJobReference(jobReference, "ExpenseEnrichmentWorkflow").jobId;
  const runningVersion = await http.enrichment_mark_running(jobId, 2);
  try {
    await process.enrichment_process(jobId, runningVersion);
  } catch (error) {
    try {
      await http.enrichment_mark_failed(jobId, runningVersion);
    } catch {
      // Best effort. Preserve the process failure in Temporal.
    }
    throw error;
  }
}
