import { type Kysely, sql } from "kysely";

/**
 * Phase 3D-B Task 1: mailbox scan/candidate discovery schema prerequisite.
 *
 * Runs after Phase 3C migration 016, runtime migration Task 7 Stage A
 * migration 017, and Phase 3D-A migration 018 (mailbox connection ownership
 * ledger). App API owns scan-run/candidate rows, cursor fences, and
 * single-flight lease CAS; the broker reads Gmail and calls App staging
 * directly. Temporal/the workflow worker see only opaque run/candidate IDs,
 * counts, page sequence, and typed errors -- never a Gmail cursor/history ID
 * or provider message metadata.
 *
 * Adds:
 * - Cursor fence columns on app.mailbox_connections (ALTER TABLE; the
 *   columns did not exist before 3D-B, since 3D-A deferred scan-run
 *   internals entirely to 3D-B/3D-C per its own migration 018 header).
 * - app.mailbox_scan_runs -- one row per scan attempt.
 * - app.mailbox_candidates -- one row per discovered message; provider
 *   message ID is stored only here, never surfaced to Temporal.
 * - app.mailbox_scan_page_outcomes -- durable per-page outcome/retry ledger
 *   (DiscoveryPageV1: pageSequence, candidateCount, retryCount), so a failed
 *   message fetch has durable retry state before the cursor advances.
 */
export async function up(database: Kysely<unknown>): Promise<void> {
  // ------------------------------------------------------------------ //
  // Cursor fence columns on app.mailbox_connections (extends migration 018).
  // Opaque to App beyond CAS/ordering: current_history_id/current_cursor_
  // digest/pre_fence_token are broker-minted opaque values; App only
  // compares them for fencing and never interprets Gmail semantics.
  // ------------------------------------------------------------------ //
  await sql`
    ALTER TABLE app.mailbox_connections
      ADD COLUMN current_history_id text,
      ADD COLUMN current_cursor_digest text,
      ADD COLUMN pre_fence_token text,
      ADD COLUMN next_page_sequence integer NOT NULL DEFAULT 1
  `.execute(database);
  await sql`
    ALTER TABLE app.mailbox_connections
      ADD CONSTRAINT mailbox_connections_next_page_sequence_check
        CHECK (next_page_sequence > 0)
  `.execute(database);

  // ------------------------------------------------------------------ //
  // app.mailbox_scan_runs
  //
  // initiated_by is a user UUID (string form) or the literal 'schedule'.
  // Permanent replay: UNIQUE (connection_id, idempotency_key); same key
  // with a different normalized_request_hash is a typed IDEMPOTENCY_CONFLICT
  // decided by the application (hash stored, not part of the constraint --
  // same triple-only pattern as migration 018's mailbox_operation_keys
  // after its Fix Round 1).
  // ------------------------------------------------------------------ //
  await sql`
    CREATE TABLE app.mailbox_scan_runs (
      id uuid PRIMARY KEY,
      connection_id uuid NOT NULL,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      initiated_by text NOT NULL,
      entitlement_version integer NOT NULL,
      connection_version integer NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      discovered_count integer NOT NULL DEFAULT 0,
      staged_count integer NOT NULL DEFAULT 0,
      review_count integer NOT NULL DEFAULT 0,
      duplicate_count integer NOT NULL DEFAULT 0,
      skipped_count integer NOT NULL DEFAULT 0,
      failed_count integer NOT NULL DEFAULT 0,
      error_code text,
      idempotency_key text NOT NULL,
      normalized_request_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      completed_at timestamptz,
      CONSTRAINT mailbox_scan_runs_connection_tenant_fk
        FOREIGN KEY (connection_id, tenant_id)
        REFERENCES app.mailbox_connections(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT mailbox_scan_runs_initiated_by_check
        CHECK (char_length(trim(initiated_by)) BETWEEN 1 AND 255),
      CONSTRAINT mailbox_scan_runs_entitlement_version_check
        CHECK (entitlement_version > 0),
      CONSTRAINT mailbox_scan_runs_connection_version_check
        CHECK (connection_version > 0),
      CONSTRAINT mailbox_scan_runs_status_check
        CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed', 'skipped')),
      CONSTRAINT mailbox_scan_runs_discovered_count_check
        CHECK (discovered_count >= 0),
      CONSTRAINT mailbox_scan_runs_staged_count_check
        CHECK (staged_count >= 0),
      CONSTRAINT mailbox_scan_runs_review_count_check
        CHECK (review_count >= 0),
      CONSTRAINT mailbox_scan_runs_duplicate_count_check
        CHECK (duplicate_count >= 0),
      CONSTRAINT mailbox_scan_runs_skipped_count_check
        CHECK (skipped_count >= 0),
      CONSTRAINT mailbox_scan_runs_failed_count_check
        CHECK (failed_count >= 0),
      CONSTRAINT mailbox_scan_runs_idempotency_key_check
        CHECK (char_length(trim(idempotency_key)) BETWEEN 1 AND 500),
      CONSTRAINT mailbox_scan_runs_normalized_request_hash_check
        CHECK (normalized_request_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT mailbox_scan_runs_started_completed_check
        CHECK (
          (status = 'pending' AND started_at IS NULL AND completed_at IS NULL)
          OR (status = 'running' AND started_at IS NOT NULL AND completed_at IS NULL)
          -- Terminal statuses require completed_at; started_at may be NULL
          -- for a run that never started (e.g. skipped for a lease/
          -- entitlement reason before discovery began).
          OR (status IN ('completed', 'partial', 'failed', 'skipped') AND completed_at IS NOT NULL)
        ),
      CONSTRAINT mailbox_scan_runs_permanent_unique
        UNIQUE (connection_id, idempotency_key)
    )
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX mailbox_scan_runs_id_tenant_unique
      ON app.mailbox_scan_runs (id, tenant_id)
  `.execute(database);
  await sql`
    CREATE INDEX mailbox_scan_runs_connection_history_index
      ON app.mailbox_scan_runs (tenant_id, connection_id, created_at DESC)
  `.execute(database);

  // ------------------------------------------------------------------ //
  // app.mailbox_candidates
  //
  // Scope: candidate_personal_profile_id/candidate_business_id -- either
  // both NULL (unassigned/review state) or exactly one set (assigned),
  // same XOR-or-neither shape as the spec's "exactly one assigned
  // Personal/business scope or unassigned review state."
  //
  // attachment_manifest is bounded JSONB (name/mimeType/sizeBytes/sha256
  // only, <= 5 entries -- contract-level AttachmentManifestV1Schema already
  // enforces field shape/MAX_UPLOAD_BYTES; the DB check only bounds count
  // and array-ness as a defense-in-depth backstop).
  //
  // Unique (connection_id, provider_message_id): one candidate row per
  // discovered message. Unique (connection_id, idempotency_key): permanent
  // replay (hash compared in application code, same triple-only pattern as
  // mailbox_scan_runs above and migration 018's operation-key ledger).
  //
  // Terminal-immutability: processed/duplicate/skipped/failed rows cannot
  // be updated at all (same pattern as migration 016's
  // prevent_enrichment_suggestion_terminal_update).
  // ------------------------------------------------------------------ //
  await sql`
    CREATE TABLE app.mailbox_candidates (
      id uuid PRIMARY KEY,
      scan_run_id uuid NOT NULL,
      connection_id uuid NOT NULL,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      received_at timestamptz NOT NULL,
      sender_address text NOT NULL,
      sender_domain text NOT NULL,
      subject text NOT NULL DEFAULT '',
      content_hash text NOT NULL,
      attachment_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
      classification text NOT NULL,
      confidence numeric(5, 4) NOT NULL,
      evidence text[] NOT NULL DEFAULT '{}',
      candidate_personal_profile_id uuid,
      candidate_business_id uuid,
      status text NOT NULL DEFAULT 'staged',
      processing_job_id uuid,
      expense_id uuid,
      source_id uuid,
      duplicate_match_id uuid,
      version integer NOT NULL DEFAULT 1,
      idempotency_key text NOT NULL,
      normalized_request_hash text NOT NULL,
      error_code text,
      provider_message_id text NOT NULL,
      provider_thread_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT mailbox_candidates_scan_run_tenant_fk
        FOREIGN KEY (scan_run_id, tenant_id)
        REFERENCES app.mailbox_scan_runs(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT mailbox_candidates_connection_tenant_fk
        FOREIGN KEY (connection_id, tenant_id)
        REFERENCES app.mailbox_connections(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT mailbox_candidates_profile_tenant_fk
        FOREIGN KEY (candidate_personal_profile_id, tenant_id)
        REFERENCES app.personal_profiles(id, tenant_id),
      CONSTRAINT mailbox_candidates_business_tenant_fk
        FOREIGN KEY (candidate_business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id),
      CONSTRAINT mailbox_candidates_scope_check
        CHECK (
          (candidate_personal_profile_id IS NULL AND candidate_business_id IS NULL)
          OR (candidate_personal_profile_id IS NULL) <> (candidate_business_id IS NULL)
        ),
      CONSTRAINT mailbox_candidates_sender_address_check
        CHECK (char_length(trim(sender_address)) BETWEEN 1 AND 320),
      CONSTRAINT mailbox_candidates_sender_domain_check
        CHECK (char_length(trim(sender_domain)) BETWEEN 1 AND 255),
      CONSTRAINT mailbox_candidates_subject_check
        CHECK (char_length(subject) <= 998),
      CONSTRAINT mailbox_candidates_content_hash_check
        CHECK (content_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT mailbox_candidates_attachment_manifest_check
        CHECK (
          jsonb_typeof(attachment_manifest) = 'array'
          AND jsonb_array_length(attachment_manifest) <= 5
        ),
      CONSTRAINT mailbox_candidates_classification_check
        CHECK (classification IN ('receipt', 'ambiguous', 'not_receipt')),
      CONSTRAINT mailbox_candidates_confidence_check
        CHECK (confidence BETWEEN 0 AND 1),
      CONSTRAINT mailbox_candidates_status_check
        CHECK (status IN ('staged', 'review', 'queued', 'processed', 'duplicate', 'skipped', 'failed')),
      CONSTRAINT mailbox_candidates_version_check
        CHECK (version > 0),
      CONSTRAINT mailbox_candidates_idempotency_key_check
        CHECK (char_length(trim(idempotency_key)) BETWEEN 1 AND 500),
      CONSTRAINT mailbox_candidates_normalized_request_hash_check
        CHECK (normalized_request_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT mailbox_candidates_provider_message_id_check
        CHECK (char_length(trim(provider_message_id)) BETWEEN 1 AND 255),
      CONSTRAINT mailbox_candidates_message_unique
        UNIQUE (connection_id, provider_message_id),
      CONSTRAINT mailbox_candidates_permanent_unique
        UNIQUE (connection_id, idempotency_key)
    )
  `.execute(database);
  await sql`
    CREATE INDEX mailbox_candidates_review_queue_index
      ON app.mailbox_candidates (tenant_id, connection_id, status)
  `.execute(database);
  await sql`
    CREATE INDEX mailbox_candidates_scan_run_index
      ON app.mailbox_candidates (scan_run_id)
  `.execute(database);
  /* Scope-targeted review queue lookup: one partial index per nullable
     scope column (same split-by-scope reasoning as migration 018's
     mailbox_connections_active_personal_unique/_active_business_unique --
     a single composite index spanning both nullable columns would not
     let Postgres use an index-only scan for "candidates in review for
     this Personal profile" without also matching every row whose
     business_id happens to be NULL). Non-unique: candidates have no
     per-scope uniqueness requirement, only a query-shape one. */
  await sql`
    CREATE INDEX mailbox_candidates_personal_scope_index
      ON app.mailbox_candidates (tenant_id, candidate_personal_profile_id, status)
      WHERE candidate_personal_profile_id IS NOT NULL
  `.execute(database);
  await sql`
    CREATE INDEX mailbox_candidates_business_scope_index
      ON app.mailbox_candidates (tenant_id, candidate_business_id, status)
      WHERE candidate_business_id IS NOT NULL
  `.execute(database);

  /* Terminal-immutability trigger: processed/duplicate/skipped/failed rows
     are fully immutable (no further transition, not even a same-status
     touch) -- same pattern as migration 016's
     prevent_enrichment_suggestion_terminal_update. */
  await sql`
    CREATE OR REPLACE FUNCTION app.prevent_mailbox_candidate_terminal_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF OLD.status IN ('processed', 'duplicate', 'skipped', 'failed') AND OLD IS DISTINCT FROM NEW THEN
        RAISE EXCEPTION 'terminal mailbox candidate is immutable: %', OLD.status;
      END IF;
      RETURN NEW;
    END;
    $function$;
  `.execute(database);
  await sql`
    CREATE TRIGGER mailbox_candidates_terminal_guard_trigger
      BEFORE UPDATE ON app.mailbox_candidates
      FOR EACH ROW EXECUTE FUNCTION app.prevent_mailbox_candidate_terminal_update()
  `.execute(database);

  // ------------------------------------------------------------------ //
  // app.mailbox_scan_page_outcomes (durable page outcomes/retries)
  //
  // One durable row per (scan_run_id, page_sequence) -- DiscoveryPageV1's
  // persisted counterpart. A failed message fetch records retry_count/
  // status here before the connection's cursor advances, so recovery does
  // not depend on Gmail retaining old history (spec: "A failed message
  // fetch creates durable retry state before cursor advances").
  // ------------------------------------------------------------------ //
  await sql`
    CREATE TABLE app.mailbox_scan_page_outcomes (
      id uuid PRIMARY KEY,
      scan_run_id uuid NOT NULL,
      connection_id uuid NOT NULL,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      page_sequence integer NOT NULL,
      candidate_count integer NOT NULL DEFAULT 0,
      retry_count integer NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'pending',
      last_error_code text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT mailbox_scan_page_outcomes_scan_run_tenant_fk
        FOREIGN KEY (scan_run_id, tenant_id)
        REFERENCES app.mailbox_scan_runs(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT mailbox_scan_page_outcomes_connection_tenant_fk
        FOREIGN KEY (connection_id, tenant_id)
        REFERENCES app.mailbox_connections(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT mailbox_scan_page_outcomes_page_sequence_check
        CHECK (page_sequence > 0),
      CONSTRAINT mailbox_scan_page_outcomes_candidate_count_check
        CHECK (candidate_count >= 0),
      CONSTRAINT mailbox_scan_page_outcomes_retry_count_check
        CHECK (retry_count >= 0),
      CONSTRAINT mailbox_scan_page_outcomes_status_check
        CHECK (status IN ('pending', 'completed', 'failed')),
      CONSTRAINT mailbox_scan_page_outcomes_permanent_unique
        UNIQUE (scan_run_id, page_sequence)
    )
  `.execute(database);
  await sql`
    CREATE INDEX mailbox_scan_page_outcomes_retry_sweep_index
      ON app.mailbox_scan_page_outcomes (connection_id, status)
      WHERE status = 'failed'
  `.execute(database);
}

/**
 * Forward-only: this migration is never rolled back. A destructive down()
 * would drop app.mailbox_scan_runs/mailbox_candidates/
 * mailbox_scan_page_outcomes and the cursor-fence columns added to
 * app.mailbox_connections -- i.e. permanently destroy persisted scan
 * history, candidate review state, and in-flight cursor fences the moment
 * any operator or tool invoked it. runMigrations() (database/migrate.ts)
 * only ever calls migrateToLatest(); nothing in this repository invokes a
 * migration's down() at runtime or in a test (confirmed: no
 * `.down(` call anywhere outside this file). Roll forward with a new
 * migration instead of rolling back.
 */
export async function down(): Promise<void> {
  throw new Error(
    "Migration 019 is forward-only: rollback is not supported, as it would " +
      "destroy persisted mailbox scan/candidate data and cursor-fence state. " +
      "Write a new forward migration instead.",
  );
}
