/**
 * Phase 3D-B Task 3 fix round 1 (Important finding 2) -- the daily-
 * schedule reconciliation operator command. `ensureScan` (mailbox-
 * schedules.ts) had no production caller; this is the "operator/startup
 * reconciliation" the controller's own ruling asked for, following the
 * exact pattern Task 7 Stage A's dispatch-routing CLI established
 * (services/app-api/src/temporal/dispatch-routing.ts): compiled into the
 * app-api image, run with migration credentials via
 * `node dist/temporal/mailbox-schedule-reconcile.js reconcile`.
 *
 * Enabled-only (controller ruling: schedules exist only when
 * MAILBOX_FEATURE_ENABLED=true) and idempotent (`ensureScan` itself
 * already treats an existing schedule as success), so running this any
 * number of times, for any set of active connections, is always safe.
 *
 * `MailboxScheduleConnectionsReader` is a narrow seam (not the full
 * Kysely `Database`) specifically so `reconcileMailboxSchedules` itself
 * is unit-testable with a fake reader -- no live Postgres needed to prove
 * "refuses when disabled" or "idempotent across repeated calls".
 */
import { pathToFileURL } from "node:url";

import type { Kysely } from "kysely";

import { createAppDatabase } from "../database/client.js";
import { requiredMigrationDatabaseUrl } from "../database/migrate.js";
import type { AppDatabase } from "../database/types.js";
import {
  createMailboxScheduleClient,
  type MailboxScheduleClient,
} from "./mailbox-schedules.js";

export interface MailboxScheduleConnectionEntry {
  readonly tenantId: string;
  readonly connectionId: string;
}

export interface MailboxScheduleConnectionsReader {
  listActiveScanEnabledConnections(): Promise<readonly MailboxScheduleConnectionEntry[]>;
}

export function createMailboxScheduleConnectionsReader(
  database: Kysely<AppDatabase>,
): MailboxScheduleConnectionsReader {
  return {
    async listActiveScanEnabledConnections() {
      const rows = await database
        .selectFrom("app.mailbox_connections")
        .select(["id", "tenant_id"])
        .where("status", "=", "active")
        .where("scan_enabled", "=", true)
        .execute();
      return rows.map((row) => ({ connectionId: row.id, tenantId: row.tenant_id }));
    },
  };
}

export interface ReconcileMailboxSchedulesInput {
  readonly mailboxEnabled: boolean;
}

export interface ReconcileMailboxSchedulesResult {
  readonly connectionsProcessed: number;
  readonly created: number;
  readonly alreadyExists: number;
}

export async function reconcileMailboxSchedules(
  reader: MailboxScheduleConnectionsReader,
  scheduleClient: MailboxScheduleClient,
  input: ReconcileMailboxSchedulesInput,
): Promise<ReconcileMailboxSchedulesResult> {
  if (!input.mailboxEnabled) {
    throw new Error(
      "Mailbox schedule reconciliation refused: MAILBOX_FEATURE_ENABLED is not true",
    );
  }

  const connections = await reader.listActiveScanEnabledConnections();
  let created = 0;
  let alreadyExists = 0;
  for (const connection of connections) {
    const outcome = await scheduleClient.ensureScan(connection);
    if (outcome === "created") created += 1;
    else alreadyExists += 1;
  }
  return { connectionsProcessed: connections.length, created, alreadyExists };
}

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

async function main(): Promise<void> {
  const [, , command] = process.argv;
  if (command !== "reconcile") {
    throw new Error("Usage: mailbox-schedule-reconcile reconcile");
  }
  const mailboxEnabled = process.env.MAILBOX_FEATURE_ENABLED?.trim().toLowerCase() === "true";
  const database = createAppDatabase(
    requiredMigrationDatabaseUrl(process.env.APP_MIGRATION_DATABASE_URL),
  );
  try {
    const reader = createMailboxScheduleConnectionsReader(database);
    const scheduleClient = createMailboxScheduleClient({
      address: requiredEnv("TEMPORAL_HOST"),
      namespace: requiredEnv("TEMPORAL_NAMESPACE"),
    });
    const result = await reconcileMailboxSchedules(reader, scheduleClient, { mailboxEnabled });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await database.destroy();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(
      "mailbox-schedule-reconcile command failed:",
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  });
}
