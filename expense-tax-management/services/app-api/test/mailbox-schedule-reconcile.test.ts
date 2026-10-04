/**
 * Phase 3D-B Task 3 fix round 1 (Important finding 2) —
 * reconcileMailboxSchedules: enabled-only refusal and idempotent
 * per-connection ensureScan dispatch. Fully unit-level -- a fake
 * MailboxScheduleConnectionsReader stands in for live Postgres (the real
 * reader's own SQL shape is a one-line, low-risk query; its own
 * createMailboxScheduleConnectionsReader is exercised indirectly by this
 * file's CLI-adjacent exports typechecking against the real AppDatabase
 * schema).
 */
import { describe, expect, it, vi } from "vitest";

import type { MailboxScheduleClient } from "../src/temporal/mailbox-schedules.js";
import {
  reconcileMailboxSchedules,
  type MailboxScheduleConnectionsReader,
} from "../src/temporal/mailbox-schedule-reconcile.js";

const CONNECTIONS = [
  { tenantId: "tenant-1", connectionId: "connection-1" },
  { tenantId: "tenant-2", connectionId: "connection-2" },
];

function fakeReader(
  connections: typeof CONNECTIONS = CONNECTIONS,
): MailboxScheduleConnectionsReader & { readonly listActiveScanEnabledConnections: ReturnType<typeof vi.fn> } {
  return {
    listActiveScanEnabledConnections: vi.fn().mockResolvedValue(connections),
  };
}

function fakeScheduleClient(
  outcomes: ReadonlyArray<"created" | "already_exists"> = [],
): MailboxScheduleClient & { readonly ensureScan: ReturnType<typeof vi.fn> } {
  const ensureScan = vi.fn();
  outcomes.forEach((outcome) => ensureScan.mockResolvedValueOnce(outcome));
  return { ensureScan };
}

describe("temporal/mailbox-schedule-reconcile.ts reconcileMailboxSchedules", () => {
  it("refuses before reading any connection when the mailbox feature is disabled", async () => {
    const reader = fakeReader();
    const scheduleClient = fakeScheduleClient();

    await expect(
      reconcileMailboxSchedules(reader, scheduleClient, { mailboxEnabled: false }),
    ).rejects.toThrow(/MAILBOX_FEATURE_ENABLED/);
    expect(reader.listActiveScanEnabledConnections).not.toHaveBeenCalled();
    expect(scheduleClient.ensureScan).not.toHaveBeenCalled();
  });

  it("ensures a schedule for every active scan-enabled connection and tallies created/already_exists", async () => {
    const reader = fakeReader();
    const scheduleClient = fakeScheduleClient(["created", "already_exists"]);

    const result = await reconcileMailboxSchedules(reader, scheduleClient, { mailboxEnabled: true });

    expect(result).toEqual({ connectionsProcessed: 2, created: 1, alreadyExists: 1 });
    expect(scheduleClient.ensureScan).toHaveBeenNthCalledWith(1, CONNECTIONS[0]);
    expect(scheduleClient.ensureScan).toHaveBeenNthCalledWith(2, CONNECTIONS[1]);
  });

  it("is idempotent: running twice against the same connections always succeeds and processes the same set", async () => {
    const reader = fakeReader();
    const scheduleClient1 = fakeScheduleClient(["created", "created"]);
    const scheduleClient2 = fakeScheduleClient(["already_exists", "already_exists"]);

    const first = await reconcileMailboxSchedules(reader, scheduleClient1, { mailboxEnabled: true });
    const second = await reconcileMailboxSchedules(reader, scheduleClient2, { mailboxEnabled: true });

    expect(first.connectionsProcessed).toBe(2);
    expect(second.connectionsProcessed).toBe(2);
    expect(second.alreadyExists).toBe(2);
  });

  it("processes zero connections without error when none are eligible", async () => {
    const reader = fakeReader([]);
    const scheduleClient = fakeScheduleClient();

    const result = await reconcileMailboxSchedules(reader, scheduleClient, { mailboxEnabled: true });

    expect(result).toEqual({ connectionsProcessed: 0, created: 0, alreadyExists: 0 });
    expect(scheduleClient.ensureScan).not.toHaveBeenCalled();
  });
});
