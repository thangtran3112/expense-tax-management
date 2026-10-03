import {
  AI_WORKER_TASK_QUEUE,
  TARGET_TEMPORAL_NAMESPACE,
} from "@expense-tax/contracts";
import type { Kysely } from "kysely";
import { pathToFileURL } from "node:url";

import { createAppDatabase } from "../database/client.js";
import { requiredMigrationDatabaseUrl } from "../database/migrate.js";
import type { AppDatabase } from "../database/types.js";
import { acquireDispatchRoutingExclusiveLock } from "../domain/dispatch-routing.js";

/**
 * Task 7 Stage A operator commands for app.temporal_dispatch_routing.
 * Run with migration credentials (APP_MIGRATION_DATABASE_URL) -- the
 * runtime role only has SELECT on this table. Compiled into the app-api
 * image; invoke as `node dist/temporal/dispatch-routing.js <command>`.
 */

const NON_TERMINAL_JOB_STATUSES = ["PENDING", "DISPATCHED", "RUNNING"] as const;

export interface GenerationCount {
  readonly generation: number;
  readonly count: number;
}

export interface DispatchRoutingStatus {
  readonly generation: number;
  readonly namespace: string;
  readonly taskQueue: string;
  readonly updatedAt: Date;
  readonly nonTerminalJobsByGeneration: readonly GenerationCount[];
  readonly pendingOutboxRowsByGeneration: readonly GenerationCount[];
}

/** Read-only: current routing + non-terminal/pending counts per generation. */
export async function getDispatchRoutingStatus(
  database: Kysely<AppDatabase>,
): Promise<DispatchRoutingStatus> {
  const routing = await database
    .selectFrom("app.temporal_dispatch_routing")
    .selectAll()
    .executeTakeFirstOrThrow();

  const jobCounts = await database
    .selectFrom("app.processing_jobs")
    .select("dispatch_generation as generation")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("status", "in", NON_TERMINAL_JOB_STATUSES)
    .groupBy("dispatch_generation")
    .orderBy("dispatch_generation")
    .execute();

  const outboxCounts = await database
    .selectFrom("app.processing_job_dispatch_outbox as outbox")
    .innerJoin("app.processing_jobs as job", "job.id", "outbox.processing_job_id")
    .select("job.dispatch_generation as generation")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("outbox.status", "=", "PENDING")
    .groupBy("job.dispatch_generation")
    .orderBy("job.dispatch_generation")
    .execute();

  return {
    generation: routing.generation,
    namespace: routing.temporal_namespace,
    taskQueue: routing.task_queue,
    updatedAt: routing.updated_at,
    nonTerminalJobsByGeneration: jobCounts.map((row) => ({
      generation: row.generation,
      count: Number(row.count),
    })),
    pendingOutboxRowsByGeneration: outboxCounts.map((row) => ({
      generation: row.generation,
      count: Number(row.count),
    })),
  };
}

export interface AdvanceDispatchRoutingInput {
  readonly fromGeneration: number;
}

export interface AdvanceDispatchRoutingResult {
  readonly generation: number;
  readonly namespace: string;
  readonly taskQueue: string;
}

/**
 * Advances the singleton routing row by exactly one generation, to the
 * canonical TypeScript-worker target (TARGET_TEMPORAL_NAMESPACE /
 * AI_WORKER_TASK_QUEUE -- never caller-supplied). Takes the dispatch-routing
 * fence's exclusive advisory lock inside one transaction -- the counterpart
 * of readDispatchRoutingForShare's shared lock -- blocking any concurrent
 * enqueue until this commits, so no job can be stamped with a target that
 * straddles the cutover. Refuses unless the current generation equals
 * fromGeneration (stale-write guard).
 */
export async function advanceDispatchRouting(
  database: Kysely<AppDatabase>,
  input: AdvanceDispatchRoutingInput,
): Promise<AdvanceDispatchRoutingResult> {
  return database.transaction().execute(async (transaction) => {
    await acquireDispatchRoutingExclusiveLock(transaction);
    const current = await transaction
      .selectFrom("app.temporal_dispatch_routing")
      .select("generation")
      .executeTakeFirstOrThrow();
    if (current.generation !== input.fromGeneration) {
      throw new Error(
        `Refusing to advance: current generation is ${current.generation}, ` +
          `but --from-generation ${input.fromGeneration} was given.`,
      );
    }
    const updated = await transaction
      .updateTable("app.temporal_dispatch_routing")
      .set({
        generation: current.generation + 1,
        temporal_namespace: TARGET_TEMPORAL_NAMESPACE,
        task_queue: AI_WORKER_TASK_QUEUE,
        updated_at: new Date(),
      })
      .where("singleton", "=", true)
      .returningAll()
      .executeTakeFirstOrThrow();
    return {
      generation: updated.generation,
      namespace: updated.temporal_namespace,
      taskQueue: updated.task_queue,
    };
  });
}

/** Parses `--from-generation <n>`. Pure/argv-only: no database access. */
export function parseFromGenerationFlag(args: readonly string[]): number {
  const flagIndex = args.indexOf("--from-generation");
  const rawValue = flagIndex === -1 ? undefined : args[flagIndex + 1];
  if (rawValue === undefined) {
    throw new Error("Usage: dispatch-routing advance --from-generation <n>");
  }
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("--from-generation must be a positive integer");
  }
  return value;
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const database = createAppDatabase(
    requiredMigrationDatabaseUrl(process.env.APP_MIGRATION_DATABASE_URL),
  );
  try {
    if (command === "status") {
      console.log(JSON.stringify(await getDispatchRoutingStatus(database), null, 2));
      return;
    }
    if (command === "advance") {
      const fromGeneration = parseFromGenerationFlag(rest);
      console.log(
        JSON.stringify(
          await advanceDispatchRouting(database, { fromGeneration }),
          null,
          2,
        ),
      );
      return;
    }
    throw new Error(
      "Usage: dispatch-routing <status|advance --from-generation <n>>",
    );
  } finally {
    await database.destroy();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(
      "dispatch-routing command failed:",
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  });
}
