/**
 * Phase 3D-C Task 5 — opaque mailbox-ingestion activities.
 *
 * Two independent activity sets, registered separately in worker.ts
 * because they need different dependencies:
 *
 * - `mailbox_ocr_receipt` (createMailboxOcrActivities): the ENTIRE OCR
 *   pipeline -- get input, download bytes, verify hash, extract, submit --
 *   collapsed into ONE activity call. Bytes and extraction fields never
 *   cross the workflow/activity boundary as their own Temporal history
 *   event; only this call's own success/failure does (the plan's global
 *   constraint: no attachment bytes or structured fields in Temporal).
 *   Uses the generic App API identity (`jobs:write`/`files:read`) -- the
 *   same one `OcrReceiptWorkflow` already uses -- never the mailbox-scoped
 *   `workflow-worker-mailbox` identity: `submitResult`/`getOcrInput`/
 *   `downloadFile` are ordinary job routes, not mailbox-specific ones, and
 *   need no mailbox credentials at all.
 * - `mailbox_mark_running`/`mailbox_materialize_job`/`mailbox_mark_failed`
 *   (createMailboxMaterializeActivities): fix round 1 (review Important
 *   #1) -- every one of MailboxMaterializeWorkflow's App callbacks (job-
 *   status transitions AND the materialize-input read AND the result
 *   submit) goes through `mailboxClient` exclusively, the SAME mailbox-
 *   scoped `workflow-worker-mailbox` identity (scope `mailbox:
 *   materialize`) the broker materialize call already used, hitting App's
 *   mailbox-scoped routes (routes/mailbox-internal.ts) -- never the
 *   generic `appApi`/`jobs:write` identity routes/jobs.ts's routes use.
 *   `mailbox_materialize_job` mutates the job's own status only on its
 *   own success (the result-submit call, last); safe for Temporal to
 *   retry the entire activity on any earlier failure without a stale
 *   expectedJobVersion, same invariant `mailbox_ocr_receipt` relies on.
 */
import { createHash } from "node:crypto";

import {
  OcrExtractionResultV1Schema,
  type JobReferenceV1,
  type MailboxMaterializationResultV1,
  type OcrExtractionResultV1,
} from "@expense-tax/contracts";
import { ApplicationFailure } from "@temporalio/activity";

import { AppApiClientError, type AppApiClient } from "../clients/app-api.js";
import { MailboxClientError, type MailboxAppApiClient } from "../clients/mailbox-client.js";

const TRANSIENT_CLIENT_ERROR_CODES = new Set(["timeout", "unavailable", "rate_limited"]);

function throwAppApiFailure(error: unknown, retryableType: string, nonRetryableType: string): never {
  const message = error instanceof Error ? error.message : "unknown error";
  const permanent =
    error instanceof AppApiClientError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 429].includes(error.status);
  throw permanent
    ? ApplicationFailure.nonRetryable(message, nonRetryableType)
    : ApplicationFailure.retryable(message, retryableType);
}

export interface MailboxOcrActivityDependencies {
  readonly appApi: AppApiClient;
  readonly extractReceipt: (
    data: Uint8Array,
  ) => OcrExtractionResultV1 | Promise<OcrExtractionResultV1>;
}

export function createMailboxOcrActivities({ appApi, extractReceipt }: MailboxOcrActivityDependencies) {
  return {
    async mailbox_ocr_receipt(input: {
      jobReference: JobReferenceV1;
      expectedJobVersion: number;
    }): Promise<number> {
      const jobId = input.jobReference.jobId;

      let jobInput;
      try {
        jobInput = await appApi.getOcrInput(jobId);
      } catch (error) {
        throwAppApiFailure(error, "MailboxOcrInputTransient", "MailboxOcrInputNonRetryable");
      }

      let data: Uint8Array;
      try {
        data = await appApi.downloadFile(jobInput.fileId);
      } catch (error) {
        throwAppApiFailure(error, "MailboxOcrDownloadTransient", "MailboxOcrDownloadNonRetryable");
      }
      if (
        jobInput.expectedSha256 !== null &&
        createHash("sha256").update(data).digest("hex") !== jobInput.expectedSha256
      ) {
        throw ApplicationFailure.nonRetryable(
          "downloaded bytes do not match the confirmed file hash",
          "MailboxOcrHashMismatch",
        );
      }

      let extraction: OcrExtractionResultV1;
      try {
        extraction = OcrExtractionResultV1Schema.parse(await extractReceipt(data));
      } catch {
        throw ApplicationFailure.nonRetryable("mailbox OCR extraction failed", "MailboxOcrExtractionFailed");
      }

      let job;
      try {
        job = await appApi.submitResult(jobId, {
          schemaVersion: 1,
          status: "SUCCEEDED",
          idempotencyKey: `${jobId}:ocr:result:succeeded`,
          expectedJobVersion: input.expectedJobVersion,
          resultSchemaVersion: "ocr-extraction-v1",
          result: extraction,
        });
      } catch (error) {
        throwAppApiFailure(error, "MailboxOcrSubmitTransient", "MailboxOcrSubmitNonRetryable");
      }
      return job.version;
    },
  };
}

function throwMailboxClientFailure(error: unknown, retryableType: string, nonRetryableType: string): never {
  if (error instanceof MailboxClientError) {
    const message = `mailbox client request failed: ${error.code}`;
    throw TRANSIENT_CLIENT_ERROR_CODES.has(error.code)
      ? ApplicationFailure.retryable(message, retryableType)
      : ApplicationFailure.nonRetryable(message, nonRetryableType);
  }
  throw error;
}

export interface MailboxMaterializeActivityDependencies {
  readonly mailboxClient: MailboxAppApiClient;
}

export function createMailboxMaterializeActivities({ mailboxClient }: MailboxMaterializeActivityDependencies) {
  return {
    async mailbox_mark_running(input: {
      jobReference: JobReferenceV1;
      expectedJobVersion: number;
    }): Promise<number> {
      const jobId = input.jobReference.jobId;
      try {
        const job = await mailboxClient.mailboxJobStatus(jobId, {
          schemaVersion: 1,
          status: "RUNNING",
          idempotencyKey: `${jobId}:status:running`,
          expectedJobVersion: input.expectedJobVersion,
        });
        return job.version;
      } catch (error) {
        throwMailboxClientFailure(error, "MailboxMarkRunningTransient", "MailboxMarkRunningNonRetryable");
      }
    },

    /**
     * One call: resolve candidateId (read-only, retry-safe), call the
     * broker's materialize route by opaque candidateId (operationId =
     * jobId, so a Temporal retry of this whole activity replays
     * idempotently on the broker side too), submit the opaque result back
     * to App. Mutates the job's own status only on this call's success --
     * safe for Temporal to retry the entire activity on any earlier
     * failure without a stale expectedJobVersion.
     */
    async mailbox_materialize_job(input: {
      jobReference: JobReferenceV1;
      expectedJobVersion: number;
    }): Promise<number> {
      const jobId = input.jobReference.jobId;

      let candidateId: string;
      try {
        candidateId = (await mailboxClient.mailboxJobMaterializeInput(jobId)).candidateId;
      } catch (error) {
        throwMailboxClientFailure(error, "MailboxMaterializeInputTransient", "MailboxMaterializeInputNonRetryable");
      }

      let result: MailboxMaterializationResultV1;
      try {
        result = await mailboxClient.materializeCandidate({ candidateId, operationId: jobId });
      } catch (error) {
        throwMailboxClientFailure(error, "MailboxMaterializeTransient", "MailboxMaterializeNonRetryable");
      }

      try {
        const job = await mailboxClient.mailboxJobResult(jobId, {
          schemaVersion: 1,
          status: "SUCCEEDED",
          idempotencyKey: `${jobId}:materialize:result:succeeded`,
          expectedJobVersion: input.expectedJobVersion,
          resultSchemaVersion: "mailbox-materialize-v1",
          result,
        });
        return job.version;
      } catch (error) {
        throwMailboxClientFailure(error, "MailboxMaterializeSubmitTransient", "MailboxMaterializeSubmitNonRetryable");
      }
    },

    async mailbox_mark_failed(input: {
      jobReference: JobReferenceV1;
      expectedJobVersion: number;
      message: string;
    }): Promise<number> {
      const jobId = input.jobReference.jobId;
      try {
        const job = await mailboxClient.mailboxJobStatus(jobId, {
          schemaVersion: 1,
          status: "FAILED",
          idempotencyKey: `${jobId}:materialize:status:failed`,
          expectedJobVersion: input.expectedJobVersion,
          message: input.message,
        });
        return job.version;
      } catch (error) {
        throwMailboxClientFailure(error, "MailboxMarkFailedTransient", "MailboxMarkFailedNonRetryable");
      }
    },
  };
}
