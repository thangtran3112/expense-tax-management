import { z } from "zod";

import { WorkflowTypeSchema } from "./task-queues.js";

export const JobReferenceV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: z.uuid(),
  workflowType: WorkflowTypeSchema,
  workflowId: z.string().min(1),
});

export type JobReferenceV1 = z.infer<typeof JobReferenceV1Schema>;
