import { type Kysely, sql } from "kysely";

/**
 * Phase 3D-A Task 3 — token_operations: crash-safe durable record for
 * key-rotation's (and refresh-token rotation's) two-phase
 * acquire-lease -> write-vault-row -> advanceTokenGeneration -> disable-
 * prior-generation sequence. Persisted *before* `advanceTokenGeneration`
 * is ever called, so a killed/crashed process can always tell, on
 * restart, whether that call was ever dispatched (`advance_requested_at`)
 * and resolve to exactly one outcome -- never ambiguous, never a second
 * generation minted for the same operation.
 *
 * Partial unique index on `connection_id WHERE status = 'pending'`
 * guarantees at most one in-flight rotation per connection at the vault-
 * database level, independent of the App-side lease's TTL -- a second,
 * concurrently started CLI invocation against the same connection fails
 * this table's insert (unique-violation) and skips the connection.
 */
export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE token_operations (
      operation_id uuid PRIMARY KEY,
      connection_id uuid NOT NULL,
      idempotency_key text NOT NULL,
      lease_id uuid NOT NULL,
      expected_connection_version integer NOT NULL,
      from_generation integer NOT NULL,
      to_generation integer NOT NULL,
      vault_reference text NOT NULL,
      request_id text NOT NULL,
      advance_requested_at timestamptz,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz,
      CONSTRAINT token_operations_status_check
        CHECK (status IN ('pending', 'confirmed', 'rejected')),
      CONSTRAINT token_operations_generation_order_check
        CHECK (to_generation = from_generation + 1),
      CONSTRAINT token_operations_idempotency_key_check
        CHECK (char_length(trim(idempotency_key)) BETWEEN 1 AND 255),
      CONSTRAINT token_operations_request_id_check
        CHECK (char_length(trim(request_id)) BETWEEN 1 AND 255),
      CONSTRAINT token_operations_resolved_state_check
        CHECK (
          (status = 'pending' AND resolved_at IS NULL)
          OR (status <> 'pending' AND resolved_at IS NOT NULL)
        )
    )
  `.execute(database);

  await sql`
    CREATE UNIQUE INDEX token_operations_pending_unique
      ON token_operations (connection_id)
      WHERE status = 'pending'
  `.execute(database);

  await sql`
    CREATE INDEX token_operations_connection_index
      ON token_operations (connection_id, created_at)
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema.dropTable("token_operations").ifExists().execute();
}
