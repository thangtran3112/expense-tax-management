import { JobReferenceV1Schema, type JobReferenceV1, type WorkflowType } from "@expense-tax/contracts";
import { ApplicationFailure } from "@temporalio/workflow";

export function requireJobReference(value: unknown, workflowType: WorkflowType): JobReferenceV1 {
  const parsed = JobReferenceV1Schema.safeParse(value);
  if (!parsed.success || parsed.data.workflowType !== workflowType) {
    throw ApplicationFailure.nonRetryable("Invalid job reference", "InvalidJobReference");
  }
  return parsed.data;
}
