import type { Transaction } from "kysely";

import type { AppDatabase } from "../database/types.js";

export interface DispatchTarget {
  readonly generation: number;
  readonly namespace: string;
  readonly taskQueue: string;
}

/**
 * Reads the singleton app.temporal_dispatch_routing row FOR SHARE inside the
 * caller's transaction and returns the generation/namespace/queue every new
 * processing job (and its dispatch-outbox row) must be stamped with.
 *
 * FOR SHARE blocks a concurrent operator `advance` -- which takes FOR UPDATE
 * on the same row (src/temporal/dispatch-routing.ts) -- until this
 * transaction commits or rolls back. No enqueue can straddle a generation
 * cutover: every job either reads the pre-advance target and commits before
 * advance proceeds, or blocks until advance commits and reads the new one.
 */
export async function readDispatchRoutingForShare(
  transaction: Transaction<AppDatabase>,
): Promise<DispatchTarget> {
  const row = await transaction
    .selectFrom("app.temporal_dispatch_routing")
    .select(["generation", "temporal_namespace", "task_queue"])
    .forShare()
    .executeTakeFirstOrThrow();
  return {
    generation: row.generation,
    namespace: row.temporal_namespace,
    taskQueue: row.task_queue,
  };
}
