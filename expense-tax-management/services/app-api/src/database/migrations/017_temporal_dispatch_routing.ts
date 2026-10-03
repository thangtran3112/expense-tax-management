import { type Kysely, sql } from "kysely";

/**
 * Task 7 Stage A: transactional Temporal dispatch routing fence.
 *
 * Production App API runs namespace `default` against the Python worker's
 * queue `expense-tax-ai-worker`; `dev` has hardcoded the TypeScript worker's
 * queue `expense-tax-processing` since Phase 0L. This migration makes
 * dispatch routing data-driven so `dev` can release without stranding jobs:
 * generation 1 seeds the CURRENT production target (legacy Python routing),
 * so this migration changes no production behavior by itself. An operator
 * runs `advance` (src/temporal/dispatch-routing.ts, Stage B) to cut new jobs
 * over to the TypeScript worker once it is deployed and smoke-tested.
 *
 * Singleton enforcement: `singleton boolean PRIMARY KEY` allows at most one
 * TRUE row and one FALSE row; `CHECK (singleton)` forbids the FALSE row,
 * leaving exactly one row ever possible.
 */
export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE app.temporal_dispatch_routing (
      singleton boolean PRIMARY KEY DEFAULT true,
      generation integer NOT NULL,
      temporal_namespace text NOT NULL,
      task_queue text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT temporal_dispatch_routing_singleton_check CHECK (singleton),
      CONSTRAINT temporal_dispatch_routing_generation_check CHECK (generation >= 1),
      CONSTRAINT temporal_dispatch_routing_namespace_check
        CHECK (char_length(trim(temporal_namespace)) BETWEEN 1 AND 200),
      CONSTRAINT temporal_dispatch_routing_task_queue_check
        CHECK (char_length(trim(task_queue)) BETWEEN 1 AND 200)
    )
  `.execute(database);

  /* Seed generation 1 = current production routing (legacy Python worker). */
  await sql`
    INSERT INTO app.temporal_dispatch_routing
      (singleton, generation, temporal_namespace, task_queue)
    VALUES (true, 1, 'default', 'expense-tax-ai-worker')
  `.execute(database);

  /* Persist the dispatch target that created each job, so draining
     old-generation jobs after an operator `advance` keeps targeting the
     namespace/queue they were actually stamped with -- not whatever the
     routing row says *now*. DEFAULT 1 / 'default' backfills every existing
     row to generation 1 (this migration's own seed value) in the same
     ALTER TABLE statement; the job's existing task_queue column already
     holds its queue and needs no backfill. */
  await sql`
    ALTER TABLE app.processing_jobs
      ADD COLUMN dispatch_generation integer NOT NULL DEFAULT 1,
      ADD COLUMN dispatch_namespace text NOT NULL DEFAULT 'default'
  `.execute(database);
  await sql`
    ALTER TABLE app.processing_jobs
      ADD CONSTRAINT processing_jobs_dispatch_generation_check
        CHECK (dispatch_generation >= 1)
  `.execute(database);

  /* Runtime role may read the routing row to stamp new jobs (FOR SHARE) and
     for the `status` operator command, but only the migrator/owner role may
     UPDATE it (via the `advance` operator command, run with migration
     credentials). The schema-wide default privilege grant
     (zz-20-expense-tax-roles.sh) gives expense_app_runtime full CRUD on
     every app-schema table as it is created; this REVOKE narrows that back
     down for this one table immediately after creation. */
  await sql`
    REVOKE INSERT, UPDATE, DELETE ON app.temporal_dispatch_routing FROM expense_app_runtime
  `.execute(database);
  await sql`
    GRANT SELECT ON app.temporal_dispatch_routing TO expense_app_runtime
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE app.processing_jobs
      DROP CONSTRAINT IF EXISTS processing_jobs_dispatch_generation_check
  `.execute(database);
  await sql`
    ALTER TABLE app.processing_jobs
      DROP COLUMN IF EXISTS dispatch_generation,
      DROP COLUMN IF EXISTS dispatch_namespace
  `.execute(database);
  await database.schema.dropTable("app.temporal_dispatch_routing").ifExists().execute();
}
