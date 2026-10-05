/**
 * Phase 3D-B Task 3 — scan schedule and Temporal dispatch wiring.
 *
 * Two independent concerns:
 *
 * 1. `createMailboxScanDispatch` -- decorates `MailboxScansDomain` so a
 *    "started" manual or scheduled scan also starts `MailboxScanWorkflow`
 *    (opaque `{schemaVersion, scanRunId}` only) directly against
 *    `TARGET_TEMPORAL_NAMESPACE`/`AI_WORKER_TASK_QUEUE` -- bypassing the
 *    Task 7 generation fence by design (controller ruling, ledger.md):
 *    mailbox has no Python `ai-worker` implementation and never will, so
 *    there is nothing to drain to on generation 1. "Skipped" overlap never
 *    starts a workflow (nothing new happened).
 *
 * 2. `createMailboxScheduleClient` -- idempotent per-connection Temporal
 *    Schedule creation (`mailbox-schedule-${connectionId}`, daily 02:00,
 *    `expense-tax` namespace, overlap SKIP). A native Schedule's action
 *    args are fixed at creation time, so it cannot carry a real `scanRunId`
 *    (that's minted by App API's lease/idempotency ledger only when the
 *    schedule actually fires) -- its target is therefore the thin
 *    `MailboxScheduledScanTriggerWorkflow(connectionId)`, which mints the
 *    scan run via an activity and starts `MailboxScanWorkflow` as its
 *    child. Ruling: this function is deliberately never called from
 *    `buildApp`/module import -- an operator/startup reconciliation
 *    command (future work) calls it per connection when
 *    `config.mailboxEnabled` is true, per the controller's explicit
 *    "prefer reconciliation over import-time creation" instruction.
 */
import {
  Client,
  Connection,
  ScheduleAlreadyRunning,
  ScheduleOverlapPolicy,
} from "@temporalio/client";
import {
  AI_WORKER_TASK_QUEUE,
  MAILBOX_SCAN_WORKFLOW_TYPE,
  MAILBOX_SCHEDULED_SCAN_TRIGGER_WORKFLOW_TYPE,
  TARGET_TEMPORAL_NAMESPACE,
} from "@expense-tax/contracts";

import type {
  MailboxScansDomain,
  StartManualScanInput,
  StartScanResult,
  StartScheduledScanInput,
} from "../domain/mailbox-scans.js";
import type { TemporalClientConfig, TemporalWorkflowStarter } from "./client.js";

export function mailboxScanWorkflowId(scanRunId: string): string {
  return `mailbox-scan-${scanRunId}`;
}

export function mailboxScheduleId(connectionId: string): string {
  return `mailbox-schedule-${connectionId}`;
}

export function mailboxScheduleTriggerWorkflowId(connectionId: string): string {
  return `${mailboxScheduleId(connectionId)}-trigger`;
}

async function dispatchIfStarted(
  starter: TemporalWorkflowStarter,
  result: StartScanResult,
): Promise<StartScanResult> {
  if (result.status === "started") {
    await starter.start({
      workflowType: MAILBOX_SCAN_WORKFLOW_TYPE,
      workflowId: mailboxScanWorkflowId(result.scanRun.id),
      taskQueue: AI_WORKER_TASK_QUEUE,
      namespace: TARGET_TEMPORAL_NAMESPACE,
      args: [{ schemaVersion: 1, scanRunId: result.scanRun.id }],
    });
  }
  return result;
}

/**
 * Decorates `domain` so `startManualScan`/`startScheduledScan` also start
 * `MailboxScanWorkflow` once the scan-run row exists -- everything else
 * (listScanRuns/loadScanBinding/recordCandidateMetadata) passes through
 * unchanged.
 */
export function createMailboxScanDispatch(
  domain: MailboxScansDomain,
  starter: TemporalWorkflowStarter,
): MailboxScansDomain {
  return {
    ...domain,
    async startManualScan(input: StartManualScanInput): Promise<StartScanResult> {
      return dispatchIfStarted(starter, await domain.startManualScan(input));
    },
    async startScheduledScan(input: StartScheduledScanInput): Promise<StartScanResult> {
      return dispatchIfStarted(starter, await domain.startScheduledScan(input));
    },
  };
}

export interface EnsureMailboxScheduleInput {
  readonly tenantId: string;
  readonly connectionId: string;
}

export interface MailboxScheduleClient {
  /**
   * Idempotently ensures the daily scan schedule exists for `connectionId`.
   * Returns `"created"` the first time, `"already_exists"` on every
   * subsequent call for the same connection (Temporal itself is the
   * source of truth for "already exists", via `ScheduleAlreadyRunning`).
   * `tenantId` rides along as a fixed Schedule arg (never changes for a
   * connection's lifetime) solely so the trigger workflow's activity can
   * call the worker-facing scheduled-scan route without its own
   * connectionId -> tenantId lookup.
   */
  ensureScan(input: EnsureMailboxScheduleInput): Promise<"created" | "already_exists">;
}

export interface MailboxScheduleClientFactories {
  readonly connect: typeof Connection.connect;
  readonly createClient: (options: {
    readonly connection: Connection;
    readonly namespace: string;
  }) => Pick<Client, "schedule">;
}

const defaultScheduleClientFactories: MailboxScheduleClientFactories = {
  connect: (options) => Connection.connect(options),
  createClient: (options) => new Client(options),
};

export function createMailboxScheduleClient(
  config: TemporalClientConfig,
  factories: MailboxScheduleClientFactories = defaultScheduleClientFactories,
): MailboxScheduleClient {
  let connectionPromise: Promise<Connection> | undefined;

  async function schedule(): Promise<Pick<Client, "schedule">["schedule"]> {
    connectionPromise ??= factories.connect({ address: config.address });
    return factories.createClient({
      connection: await connectionPromise,
      namespace: TARGET_TEMPORAL_NAMESPACE,
    }).schedule;
  }

  return {
    async ensureScan({ tenantId, connectionId }) {
      const scheduleClient = await schedule();
      try {
        await scheduleClient.create({
          scheduleId: mailboxScheduleId(connectionId),
          spec: {
            calendars: [
              {
                hour: [{ start: 2, end: 2, step: 1 }],
                minute: [{ start: 0, end: 0, step: 1 }],
                second: [{ start: 0, end: 0, step: 1 }],
              },
            ],
          },
          action: {
            type: "startWorkflow",
            workflowType: MAILBOX_SCHEDULED_SCAN_TRIGGER_WORKFLOW_TYPE,
            taskQueue: AI_WORKER_TASK_QUEUE,
            workflowId: mailboxScheduleTriggerWorkflowId(connectionId),
            args: [{ tenantId, connectionId }],
          },
          policies: { overlap: ScheduleOverlapPolicy.SKIP },
        });
        return "created";
      } catch (error) {
        if (error instanceof ScheduleAlreadyRunning) return "already_exists";
        throw error;
      }
    },
  };
}
