import type { JobReferenceV1 } from "@expense-tax/contracts";
import { proxyActivities } from "@temporalio/workflow";

import { requireJobReference } from "./job-reference.js";

interface EchoActivities {
  mark_running(input: {
    jobReference: JobReferenceV1;
    expectedJobVersion: number;
  }): Promise<number>;
  submit_echo_result(input: {
    jobReference: JobReferenceV1;
    expectedJobVersion: number;
  }): Promise<number>;
}

const { mark_running, submit_echo_result } = proxyActivities<EchoActivities>({
  startToCloseTimeout: "30 seconds",
});

export async function FoundationEchoWorkflow(jobReference: JobReferenceV1): Promise<void> {
  const reference = requireJobReference(jobReference, "FoundationEchoWorkflow");
  const version = await mark_running({ jobReference: reference, expectedJobVersion: 2 });
  await submit_echo_result({ jobReference: reference, expectedJobVersion: version });
}
