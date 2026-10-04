/**
 * Phase 3D-B Task 3 — activities/mailbox.ts: thin wrappers over
 * MailboxAppApiClient's discoverPage/startScheduledScan, with
 * MailboxClientError mapped to retryable/non-retryable ApplicationFailure.
 */
import { ApplicationFailure } from "@temporalio/activity";
import { describe, expect, it, vi } from "vitest";

import { createMailboxActivities } from "../src/activities/mailbox.js";
import { MailboxClientError, type MailboxAppApiClient } from "../src/clients/mailbox-client.js";

const SCAN_RUN_ID = "22222222-2222-4222-8222-222222222222";
const CONNECTION_ID = "33333333-3333-4333-8333-333333333333";
const TENANT_ID = "44444444-4444-4444-8444-444444444444";

function fakeClient(overrides: Partial<MailboxAppApiClient> = {}): MailboxAppApiClient {
  return {
    mintAppToken: vi.fn(),
    mintBrokerToken: vi.fn(),
    requestAppApi: vi.fn(),
    requestBroker: vi.fn(),
    discoverPage: vi.fn(),
    startScheduledScan: vi.fn(),
    finalizeScan: vi.fn(),
    ...overrides,
  };
}

describe("activities/mailbox.ts mailbox_discover_page", () => {
  it("forwards scanRunId and returns the opaque discovery page", async () => {
    const discoverPage = vi.fn().mockResolvedValue({
      scanRunId: SCAN_RUN_ID,
      pageSequence: 1,
      candidateCount: 3,
      retryCount: 0,
    });
    const activities = createMailboxActivities({ mailboxClient: fakeClient({ discoverPage }) });

    await expect(activities.mailbox_discover_page({ scanRunId: SCAN_RUN_ID })).resolves.toEqual({
      scanRunId: SCAN_RUN_ID,
      pageSequence: 1,
      candidateCount: 3,
      retryCount: 0,
    });
    expect(discoverPage).toHaveBeenCalledWith(SCAN_RUN_ID);
  });

  it.each([
    ["timeout" as const],
    ["unavailable" as const],
    ["rate_limited" as const],
  ])("maps a transient MailboxClientError (%s) to a retryable ApplicationFailure", async (code) => {
    const discoverPage = vi.fn().mockRejectedValue(new MailboxClientError(code));
    const activities = createMailboxActivities({ mailboxClient: fakeClient({ discoverPage }) });

    const error = await activities
      .mailbox_discover_page({ scanRunId: SCAN_RUN_ID })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(false);
    expect((error as ApplicationFailure).type).toBe("MailboxDiscoverTransient");
  });

  it("maps a permanent MailboxClientError to a non-retryable ApplicationFailure", async () => {
    const discoverPage = vi.fn().mockRejectedValue(new MailboxClientError("authorization_failed", 403));
    const activities = createMailboxActivities({ mailboxClient: fakeClient({ discoverPage }) });

    const error = await activities
      .mailbox_discover_page({ scanRunId: SCAN_RUN_ID })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
    expect((error as ApplicationFailure).type).toBe("MailboxDiscoverNonRetryable");
  });

  it("rethrows a non-MailboxClientError unchanged", async () => {
    const discoverPage = vi.fn().mockRejectedValue(new Error("boom"));
    const activities = createMailboxActivities({ mailboxClient: fakeClient({ discoverPage }) });

    await expect(activities.mailbox_discover_page({ scanRunId: SCAN_RUN_ID })).rejects.toThrow("boom");
  });
});

describe("activities/mailbox.ts mailbox_start_scheduled_scan", () => {
  it("forwards tenantId/connectionId/requestId and returns the opaque result", async () => {
    const startScheduledScan = vi.fn().mockResolvedValue({ status: "started", scanRunId: SCAN_RUN_ID });
    const activities = createMailboxActivities({ mailboxClient: fakeClient({ startScheduledScan }) });

    await expect(
      activities.mailbox_start_scheduled_scan({
        tenantId: TENANT_ID,
        connectionId: CONNECTION_ID,
        requestId: "run-1",
      }),
    ).resolves.toEqual({ status: "started", scanRunId: SCAN_RUN_ID });
    expect(startScheduledScan).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      connectionId: CONNECTION_ID,
      requestId: "run-1",
    });
  });

  it("maps a transient MailboxClientError to a retryable ApplicationFailure", async () => {
    const startScheduledScan = vi.fn().mockRejectedValue(new MailboxClientError("unavailable"));
    const activities = createMailboxActivities({ mailboxClient: fakeClient({ startScheduledScan }) });

    const error = await activities
      .mailbox_start_scheduled_scan({ tenantId: TENANT_ID, connectionId: CONNECTION_ID, requestId: "run-1" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(false);
    expect((error as ApplicationFailure).type).toBe("MailboxScheduledScanTransient");
  });

  it("maps a permanent MailboxClientError to a non-retryable ApplicationFailure", async () => {
    const startScheduledScan = vi.fn().mockRejectedValue(new MailboxClientError("not_found", 404));
    const activities = createMailboxActivities({ mailboxClient: fakeClient({ startScheduledScan }) });

    const error = await activities
      .mailbox_start_scheduled_scan({ tenantId: TENANT_ID, connectionId: CONNECTION_ID, requestId: "run-1" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
    expect((error as ApplicationFailure).type).toBe("MailboxScheduledScanNonRetryable");
  });
});

describe("activities/mailbox.ts mailbox_finalize_scan", () => {
  it("forwards scanRunId/outcome and returns nothing", async () => {
    const finalizeScan = vi.fn().mockResolvedValue({
      scanRunId: SCAN_RUN_ID,
      status: "completed",
      leaseReleased: true,
    });
    const activities = createMailboxActivities({ mailboxClient: fakeClient({ finalizeScan }) });

    await expect(
      activities.mailbox_finalize_scan({ scanRunId: SCAN_RUN_ID, outcome: "succeeded" }),
    ).resolves.toBeUndefined();
    expect(finalizeScan).toHaveBeenCalledWith({ scanRunId: SCAN_RUN_ID, outcome: "succeeded" });
  });

  it("maps a transient MailboxClientError to a retryable ApplicationFailure", async () => {
    const finalizeScan = vi.fn().mockRejectedValue(new MailboxClientError("timeout"));
    const activities = createMailboxActivities({ mailboxClient: fakeClient({ finalizeScan }) });

    const error = await activities
      .mailbox_finalize_scan({ scanRunId: SCAN_RUN_ID, outcome: "failed" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(false);
    expect((error as ApplicationFailure).type).toBe("MailboxFinalizeTransient");
  });

  it("maps a permanent MailboxClientError to a non-retryable ApplicationFailure", async () => {
    const finalizeScan = vi.fn().mockRejectedValue(new MailboxClientError("not_found", 404));
    const activities = createMailboxActivities({ mailboxClient: fakeClient({ finalizeScan }) });

    const error = await activities
      .mailbox_finalize_scan({ scanRunId: SCAN_RUN_ID, outcome: "failed" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
    expect((error as ApplicationFailure).type).toBe("MailboxFinalizeNonRetryable");
  });
});
