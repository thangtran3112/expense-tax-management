/**
 * Phase 3D-B Task 3 — opaque mailbox-scan activities.
 *
 * Both activities are thin wrappers over `MailboxAppApiClient`'s two
 * named convenience methods (`discoverPage`/`startScheduledScan`):
 * `MailboxClientError` codes map to retryable/non-retryable
 * `ApplicationFailure`s using the same transient-vs-permanent split
 * `activities/index.ts`'s `permanentClientFailure` already uses for the
 * OCR/enrichment activities.
 */
import { ApplicationFailure } from "@temporalio/activity";
import type { DiscoveryPageV1 } from "@expense-tax/contracts";

import { MailboxClientError, type MailboxAppApiClient } from "../clients/mailbox-client.js";

const TRANSIENT_CLIENT_ERROR_CODES = new Set([
  "timeout",
  "unavailable",
  "rate_limited",
]);

function throwApplicationFailure(
  error: unknown,
  retryableType: string,
  nonRetryableType: string,
): never {
  if (error instanceof MailboxClientError) {
    const message = `mailbox client request failed: ${error.code}`;
    throw TRANSIENT_CLIENT_ERROR_CODES.has(error.code)
      ? ApplicationFailure.retryable(message, retryableType)
      : ApplicationFailure.nonRetryable(message, nonRetryableType);
  }
  throw error;
}

export interface MailboxActivityDependencies {
  readonly mailboxClient: MailboxAppApiClient;
}

export function createMailboxActivities({ mailboxClient }: MailboxActivityDependencies) {
  return {
    async mailbox_discover_page(input: { scanRunId: string }): Promise<DiscoveryPageV1> {
      try {
        return await mailboxClient.discoverPage(input.scanRunId);
      } catch (error) {
        throwApplicationFailure(error, "MailboxDiscoverTransient", "MailboxDiscoverNonRetryable");
      }
    },
    async mailbox_start_scheduled_scan(input: {
      tenantId: string;
      connectionId: string;
      requestId: string;
    }): Promise<{ status: "started" | "skipped_overlap"; scanRunId: string }> {
      try {
        return await mailboxClient.startScheduledScan(input);
      } catch (error) {
        throwApplicationFailure(
          error,
          "MailboxScheduledScanTransient",
          "MailboxScheduledScanNonRetryable",
        );
      }
    },
  };
}
