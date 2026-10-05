import type { JobReferenceV1 } from "@expense-tax/contracts";

import { runOcr } from "./ocr-receipt.js";
import { requireJobReference } from "./job-reference.js";

export async function ForwardedReceiptWorkflow(jobReference: JobReferenceV1): Promise<void> {
  await runOcr(requireJobReference(jobReference, "ForwardedReceiptWorkflow"));
}
