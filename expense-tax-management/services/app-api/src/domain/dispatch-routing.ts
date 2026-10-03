import { sql, type Transaction } from "kysely";

import type { AppDatabase } from "../database/types.js";

export interface DispatchTarget {
  readonly generation: number;
  readonly namespace: string;
  readonly taskQueue: string;
}

/**
 * Fences enqueue (shared) against operator `advance` (exclusive) via a
 * session/transaction advisory lock, auto-released at commit or rollback
 * (the `_xact_` variants).
 *
 * PostgreSQL requires UPDATE privilege -- not just SELECT -- to take a
 * row-level `FOR SHARE`/`FOR UPDATE` lock on a table (confirmed against a
 * real Postgres 17 server: `SELECT ... FOR SHARE` as a SELECT-only role
 * fails with "permission denied", independent of row visibility). Granting
 * the runtime role UPDATE just to satisfy that would directly contradict
 * "Runtime role: SELECT only on the routing table." `pg_advisory_xact_lock`
 * and its `_shared` counterpart need no table privilege at all -- any role
 * may call them -- while still giving real shared-vs-exclusive mutual
 * exclusion scoped to one well-known key. Same key-derivation pattern
 * `memberships.ts` already uses for its own advisory lock
 * (`hashtextextended(scope, 0)`).
 */
async function acquireDispatchRoutingLock(
  transaction: Transaction<AppDatabase>,
  mode: "shared" | "exclusive",
): Promise<void> {
  if (mode === "shared") {
    await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('app.temporal_dispatch_routing', 0))`.execute(
      transaction,
    );
  } else {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('app.temporal_dispatch_routing', 0))`.execute(
      transaction,
    );
  }
}

/**
 * Reads the singleton app.temporal_dispatch_routing row inside the caller's
 * transaction and returns the generation/namespace/queue every new
 * processing job (and its dispatch-outbox row) must be stamped with.
 *
 * Takes the fence's shared advisory lock first: this blocks a concurrent
 * operator `advance` -- which takes the exclusive form of the same lock via
 * acquireDispatchRoutingExclusiveLock (src/temporal/dispatch-routing.ts) --
 * until this transaction commits or rolls back. No enqueue can straddle a
 * generation cutover: every job either reads the pre-advance target and
 * commits before advance proceeds, or blocks until advance commits and
 * reads the new one.
 */
export async function readDispatchRoutingForShare(
  transaction: Transaction<AppDatabase>,
): Promise<DispatchTarget> {
  await acquireDispatchRoutingLock(transaction, "shared");
  const row = await transaction
    .selectFrom("app.temporal_dispatch_routing")
    .select(["generation", "temporal_namespace", "task_queue"])
    .executeTakeFirstOrThrow();
  return {
    generation: row.generation,
    namespace: row.temporal_namespace,
    taskQueue: row.task_queue,
  };
}

/**
 * Exclusive counterpart of readDispatchRoutingForShare's lock, used by the
 * `advance` operator command so both sides fence against the identical key.
 */
export async function acquireDispatchRoutingExclusiveLock(
  transaction: Transaction<AppDatabase>,
): Promise<void> {
  await acquireDispatchRoutingLock(transaction, "exclusive");
}
