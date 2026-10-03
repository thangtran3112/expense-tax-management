/**
 * Phase 3D-B Task 3 — temporal/client.ts's widened StartWorkflowInput.args,
 * temporal/mailbox-schedules.ts's dispatch decorator, and its idempotent
 * Temporal Schedule client.
 */
import { randomUUID } from "node:crypto";

import { ScheduleAlreadyRunning } from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";

import type { MailboxScanRunV1 } from "@expense-tax/contracts";
import type { TemporalWorkflowStarter } from "../src/temporal/client.js";
import type { MailboxScansDomain, StartScanResult } from "../src/domain/mailbox-scans.js";
import {
  createMailboxScanDispatch,
  createMailboxScheduleClient,
  mailboxScanWorkflowId,
  mailboxScheduleId,
  mailboxScheduleTriggerWorkflowId,
  type MailboxScheduleClientFactories,
} from "../src/temporal/mailbox-schedules.js";

const TENANT_ID = randomUUID();
const CONNECTION_ID = randomUUID();
const SCAN_RUN_ID = randomUUID();

function scanRun(overrides: Partial<MailboxScanRunV1> = {}): MailboxScanRunV1 {
  return {
    schemaVersion: 1,
    id: SCAN_RUN_ID,
    connectionId: CONNECTION_ID,
    tenantId: TENANT_ID,
    initiatedBy: "schedule",
    entitlementVersion: 1,
    connectionVersion: 1,
    status: "pending",
    discoveredCount: 0,
    stagedCount: 0,
    reviewCount: 0,
    duplicateCount: 0,
    skippedCount: 0,
    failedCount: 0,
    errorCode: null,
    idempotencyKey: "request-1",
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function fakeStarter(): TemporalWorkflowStarter & { readonly start: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn().mockResolvedValue({ runId: "run-1" }),
    close: vi.fn(),
  };
}

function fakeDomain(overrides: Partial<MailboxScansDomain> = {}): MailboxScansDomain {
  return {
    startManualScan: vi.fn(),
    startScheduledScan: vi.fn(),
    listScanRuns: vi.fn(),
    loadScanBinding: vi.fn(),
    recordCandidateMetadata: vi.fn(),
    ...overrides,
  };
}

describe("temporal/mailbox-schedules.ts createMailboxScanDispatch", () => {
  it("starts MailboxScanWorkflow with only the opaque scanRunId when a manual scan starts", async () => {
    const result: StartScanResult = { scanRun: scanRun(), status: "started" };
    const starter = fakeStarter();
    const domain = createMailboxScanDispatch(
      fakeDomain({ startManualScan: vi.fn().mockResolvedValue(result) }),
      starter,
    );

    const returned = await domain.startManualScan({
      actorUserId: randomUUID(),
      tenantId: TENANT_ID,
      connectionId: CONNECTION_ID,
      requestId: "request-1",
    });

    expect(returned).toBe(result);
    expect(starter.start).toHaveBeenCalledWith({
      workflowType: "MailboxScanWorkflow",
      workflowId: mailboxScanWorkflowId(SCAN_RUN_ID),
      taskQueue: "expense-tax-processing",
      namespace: "expense-tax",
      args: [{ schemaVersion: 1, scanRunId: SCAN_RUN_ID }],
    });
    const serializedArgs = JSON.stringify(starter.start.mock.calls[0]?.[0]?.args);
    expect(serializedArgs).not.toMatch(/historyId|cursorDigest|preFenceToken|senderAddress|subject/i);
  });

  it("does not start a workflow when a manual scan is skipped as an overlap", async () => {
    const result: StartScanResult = { scanRun: scanRun(), status: "skipped_overlap" };
    const starter = fakeStarter();
    const domain = createMailboxScanDispatch(
      fakeDomain({ startManualScan: vi.fn().mockResolvedValue(result) }),
      starter,
    );

    const returned = await domain.startManualScan({
      actorUserId: randomUUID(),
      tenantId: TENANT_ID,
      connectionId: CONNECTION_ID,
      requestId: "request-1",
    });

    expect(returned).toBe(result);
    expect(starter.start).not.toHaveBeenCalled();
  });

  it("starts MailboxScanWorkflow for a started scheduled scan the same way as manual", async () => {
    const result: StartScanResult = { scanRun: scanRun(), status: "started" };
    const starter = fakeStarter();
    const domain = createMailboxScanDispatch(
      fakeDomain({ startScheduledScan: vi.fn().mockResolvedValue(result) }),
      starter,
    );

    await domain.startScheduledScan({ tenantId: TENANT_ID, connectionId: CONNECTION_ID, requestId: "request-1" });

    expect(starter.start).toHaveBeenCalledWith(
      expect.objectContaining({ args: [{ schemaVersion: 1, scanRunId: SCAN_RUN_ID }] }),
    );
  });

  it("passes listScanRuns/loadScanBinding/recordCandidateMetadata through unchanged", async () => {
    const listScanRuns = vi.fn().mockResolvedValue({ items: [] });
    const loadScanBinding = vi.fn();
    const recordCandidateMetadata = vi.fn();
    const domain = createMailboxScanDispatch(
      fakeDomain({ listScanRuns, loadScanBinding, recordCandidateMetadata }),
      fakeStarter(),
    );

    await domain.listScanRuns({ actorUserId: randomUUID(), tenantId: TENANT_ID, connectionId: CONNECTION_ID });
    expect(listScanRuns).toHaveBeenCalledOnce();
    expect(domain.loadScanBinding).toBe(loadScanBinding);
    expect(domain.recordCandidateMetadata).toBe(recordCandidateMetadata);
  });
});

function fakeScheduleFactories(
  create: ReturnType<typeof vi.fn>,
): MailboxScheduleClientFactories {
  return {
    connect: vi.fn().mockResolvedValue({ close: vi.fn() }) as unknown as MailboxScheduleClientFactories["connect"],
    createClient: vi.fn().mockReturnValue({ schedule: { create } }),
  };
}

describe("temporal/mailbox-schedules.ts createMailboxScheduleClient", () => {
  it("creates a daily schedule with the stable per-connection ID and opaque trigger args", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const client = createMailboxScheduleClient(
      { address: "temporal:7233", namespace: "expense-tax" },
      fakeScheduleFactories(create),
    );

    const outcome = await client.ensureScan({ tenantId: TENANT_ID, connectionId: CONNECTION_ID });

    expect(outcome).toBe("created");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: mailboxScheduleId(CONNECTION_ID),
        action: expect.objectContaining({
          type: "startWorkflow",
          workflowType: "MailboxScheduledScanTriggerWorkflow",
          taskQueue: "expense-tax-processing",
          workflowId: mailboxScheduleTriggerWorkflowId(CONNECTION_ID),
          args: [{ tenantId: TENANT_ID, connectionId: CONNECTION_ID }],
        }),
      }),
    );
  });

  it("treats an already-existing schedule as success, not an error", async () => {
    const create = vi.fn().mockRejectedValue(new ScheduleAlreadyRunning("already running", "schedule-1"));
    const client = createMailboxScheduleClient(
      { address: "temporal:7233", namespace: "expense-tax" },
      fakeScheduleFactories(create),
    );

    await expect(
      client.ensureScan({ tenantId: TENANT_ID, connectionId: CONNECTION_ID }),
    ).resolves.toBe("already_exists");
  });

  it("rethrows any other schedule-creation error", async () => {
    const create = vi.fn().mockRejectedValue(new Error("boom"));
    const client = createMailboxScheduleClient(
      { address: "temporal:7233", namespace: "expense-tax" },
      fakeScheduleFactories(create),
    );

    await expect(
      client.ensureScan({ tenantId: TENANT_ID, connectionId: CONNECTION_ID }),
    ).rejects.toThrow("boom");
  });

  it("reuses the same connection across multiple ensureScan calls", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const factories = fakeScheduleFactories(create);
    const client = createMailboxScheduleClient(
      { address: "temporal:7233", namespace: "expense-tax" },
      factories,
    );

    await client.ensureScan({ tenantId: TENANT_ID, connectionId: CONNECTION_ID });
    await client.ensureScan({ tenantId: TENANT_ID, connectionId: randomUUID() });

    expect(factories.connect).toHaveBeenCalledOnce();
  });
});
