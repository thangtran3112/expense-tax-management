import { type Kysely, sql } from "kysely";

/**
 * Phase 3D-C Task 1: mailbox ingestion schema prerequisite, with connected
 * provenance on app.expense_sources.
 *
 * Runs after Phase 3C migration 016, runtime migration Task 7 Stage A
 * migration 017, Phase 3D-A migration 018, and Phase 3D-B migration 019
 * (app.mailbox_candidates already exists, with status 'queued' already a
 * legal value -- no candidate-status enum change needed here).
 *
 * Two independent schema changes:
 *
 * 1. app.expense_sources gains a third source_type, 'connected_mailbox',
 *    alongside the existing 'manual_upload'/'forwarded_email' (Phase 3B,
 *    migration 015 -- not modified in place; evolved here via DROP/ADD
 *    CONSTRAINT and CREATE OR REPLACE FUNCTION, the same additive-evolution
 *    pattern Phase 3D-B's migration 019 used for brand-new objects).
 *    Connected rows carry mailbox_candidate_id and remain pending-review
 *    through Phase 3B dedup (spec: "no automatic merge").
 *
 * 2. app.mailbox_ingestion_operations -- Phase 3D-C's own permanent
 *    operation-key/idempotency ledger (same triple-only pattern as
 *    migration 018's app.mailbox_operation_keys), extended with status/
 *    version so the same row also serves as the durable materialization-
 *    request record the plan's trigger ruling needs (see Ruling below):
 *    one row per (issueUploadGrant | uploadAttachment | submitStructuredResult
 *    | materialize_candidate) call, keyed by operation_key/idempotency_key,
 *    forward-only through pending -> started -> completed|failed.
 *
 * Ruling (Phase 3D-C Task 1): app.mailbox_ingestion_operations doubles as
 * the controller ruling's "mailbox-owned durable record" that an App-side
 * reconcile uses to start materialization for a candidate that just became
 * `queued`, and to retry idempotently if a prior start attempt crashed
 * before committing a terminal status -- one table instead of two. A
 * `materialize_candidate` row's candidate_id is the trigger target;
 * scanRunId for MailboxWorkerMaterializationInputV1 is read back from
 * app.mailbox_candidates.scan_run_id via that candidate_id, not duplicated
 * here. Cost if wrong: an additive column (e.g. a dedicated scan_run_id) or
 * an additive table later, if a future task's reconcile query shape needs
 * one this table doesn't provide.
 *
 * Ruling (Phase 3D-C Task 1): no migration 020 change to app.processing_jobs
 * for MailboxOcrJobActorV1's `{ kind: "service"; actorServicePrincipal }`
 * variant -- app.processing_jobs.requested_by_user_id (migration 010) has
 * no service-principal counterpart column yet. Deferred to whichever later
 * task first creates a service-actor processing job (Task 3 per the plan),
 * which must extend this migration in place (020 is unreleased in this
 * branch, same precedent as 3D-B Task 1/4/5's in-place edits) rather than
 * add a new migration 021 for it.
 */
export async function up(database: Kysely<unknown>): Promise<void> {
  // ------------------------------------------------------------------ //
  // app.mailbox_candidates needs a composite (id, tenant_id) unique index
  // before it can be the target of a composite FK -- same requirement
  // migration 015 solved for app.expense_files/app.inbound_emails via
  // expense_files_id_tenant_unique/inbound_emails_id_tenant_unique. The
  // bare PRIMARY KEY on id alone does not satisfy a 2-column FK's
  // uniqueness requirement.
  // ------------------------------------------------------------------ //
  await sql`
    CREATE UNIQUE INDEX mailbox_candidates_id_tenant_unique
      ON app.mailbox_candidates (id, tenant_id)
  `.execute(database);

  // ------------------------------------------------------------------ //
  // app.expense_sources connected provenance.
  //
  // mailbox_candidate_id is nullable (NULL for manual_upload/forwarded_email
  // rows) and NOT NULL for connected_mailbox rows -- the type_check
  // constraint below is dropped and recreated (named constraint; migration
  // 015 itself is never edited) to add the third branch and to require
  // mailbox_candidate_id IS NULL on the two pre-existing branches, keeping
  // exactly one source-identifying column populated per row.
  // ------------------------------------------------------------------ //
  await sql`
    ALTER TABLE app.expense_sources
      ADD COLUMN mailbox_candidate_id uuid
  `.execute(database);
  await sql`
    ALTER TABLE app.expense_sources
      ADD CONSTRAINT expense_sources_mailbox_candidate_tenant_fk
        FOREIGN KEY (mailbox_candidate_id, tenant_id)
        REFERENCES app.mailbox_candidates(id, tenant_id)
  `.execute(database);
  await sql`
    ALTER TABLE app.expense_sources
      DROP CONSTRAINT expense_sources_type_check
  `.execute(database);
  await sql`
    ALTER TABLE app.expense_sources
      ADD CONSTRAINT expense_sources_type_check
        CHECK (
          (source_type = 'manual_upload' AND source_file_id IS NOT NULL
            AND inbound_email_id IS NULL AND mailbox_candidate_id IS NULL)
          OR (source_type = 'forwarded_email' AND inbound_email_id IS NOT NULL
            AND mailbox_candidate_id IS NULL)
          OR (source_type = 'connected_mailbox' AND mailbox_candidate_id IS NOT NULL
            AND inbound_email_id IS NULL)
        )
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX expense_sources_mailbox_candidate_unique
      ON app.expense_sources (tenant_id, mailbox_candidate_id)
      WHERE mailbox_candidate_id IS NOT NULL
  `.execute(database);

  /* Exact tenant/scope match for the new connected branch, added to the
     existing migration-015 trigger function by CREATE OR REPLACE (the
     function, not migration 015's file, is what changes -- same evolution
     already used by every later migration that touches a shared trigger
     function). Mirrors the existing source_file_id/inbound_email_id
     branches exactly: tenant_id and both scope columns must match the
     referenced row's. */
  await sql`
    CREATE OR REPLACE FUNCTION app.validate_expense_dedup_scope()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      referenced_tenant_id uuid;
      referenced_personal_profile_id uuid;
      referenced_business_id uuid;
    BEGIN
      IF TG_TABLE_NAME = 'expense_sources' THEN
        SELECT tenant_id, personal_profile_id, business_id
          INTO referenced_tenant_id, referenced_personal_profile_id, referenced_business_id
          FROM app.expenses
          WHERE id = NEW.expense_id
          FOR UPDATE;
        IF NOT FOUND OR referenced_tenant_id IS DISTINCT FROM NEW.tenant_id
          OR referenced_personal_profile_id IS DISTINCT FROM NEW.personal_profile_id
          OR referenced_business_id IS DISTINCT FROM NEW.business_id THEN
          RAISE EXCEPTION 'expense source expense scope mismatch';
        END IF;

        IF NEW.source_file_id IS NOT NULL THEN
          SELECT tenant_id, personal_profile_id, business_id
            INTO referenced_tenant_id, referenced_personal_profile_id, referenced_business_id
            FROM app.expense_files
           WHERE id = NEW.source_file_id
           FOR UPDATE;
          IF NOT FOUND OR referenced_tenant_id IS DISTINCT FROM NEW.tenant_id
            OR referenced_personal_profile_id IS DISTINCT FROM NEW.personal_profile_id
            OR referenced_business_id IS DISTINCT FROM NEW.business_id THEN
            RAISE EXCEPTION 'expense source file scope mismatch';
          END IF;
        END IF;

        IF NEW.inbound_email_id IS NOT NULL THEN
          SELECT tenant_id, personal_profile_id, business_id
            INTO referenced_tenant_id, referenced_personal_profile_id, referenced_business_id
            FROM app.inbound_emails
           WHERE id = NEW.inbound_email_id
           FOR UPDATE;
          IF NOT FOUND OR referenced_tenant_id IS DISTINCT FROM NEW.tenant_id
            OR referenced_personal_profile_id IS DISTINCT FROM NEW.personal_profile_id
            OR referenced_business_id IS DISTINCT FROM NEW.business_id THEN
            RAISE EXCEPTION 'expense source inbound email scope mismatch';
          END IF;
        END IF;

        IF NEW.mailbox_candidate_id IS NOT NULL THEN
          SELECT tenant_id, candidate_personal_profile_id, candidate_business_id
            INTO referenced_tenant_id, referenced_personal_profile_id, referenced_business_id
            FROM app.mailbox_candidates
           WHERE id = NEW.mailbox_candidate_id
           FOR UPDATE;
          IF NOT FOUND OR referenced_tenant_id IS DISTINCT FROM NEW.tenant_id
            OR referenced_personal_profile_id IS DISTINCT FROM NEW.personal_profile_id
            OR referenced_business_id IS DISTINCT FROM NEW.business_id THEN
            RAISE EXCEPTION 'expense source mailbox candidate scope mismatch';
          END IF;
        END IF;
      ELSIF TG_TABLE_NAME = 'expense_dedup_fingerprints' THEN
        SELECT tenant_id, personal_profile_id, business_id
          INTO referenced_tenant_id, referenced_personal_profile_id, referenced_business_id
          FROM app.expenses
          WHERE id = NEW.expense_id
          FOR UPDATE;
        IF NOT FOUND OR referenced_tenant_id IS DISTINCT FROM NEW.tenant_id
          OR referenced_personal_profile_id IS DISTINCT FROM NEW.personal_profile_id
          OR referenced_business_id IS DISTINCT FROM NEW.business_id THEN
          RAISE EXCEPTION 'dedup fingerprint expense scope mismatch';
        END IF;
      ELSIF TG_TABLE_NAME = 'expense_duplicate_matches' THEN
        SELECT tenant_id, personal_profile_id, business_id
          INTO referenced_tenant_id, referenced_personal_profile_id, referenced_business_id
          FROM app.expenses
          WHERE id = NEW.existing_expense_id
          FOR UPDATE;
        IF NOT FOUND OR referenced_tenant_id IS DISTINCT FROM NEW.tenant_id
          OR referenced_personal_profile_id IS DISTINCT FROM NEW.personal_profile_id
          OR referenced_business_id IS DISTINCT FROM NEW.business_id THEN
          RAISE EXCEPTION 'duplicate existing expense scope mismatch';
        END IF;

        SELECT tenant_id, personal_profile_id, business_id
          INTO referenced_tenant_id, referenced_personal_profile_id, referenced_business_id
           FROM app.expenses
          WHERE id = NEW.candidate_expense_id
          FOR UPDATE;
        IF NOT FOUND OR referenced_tenant_id IS DISTINCT FROM NEW.tenant_id
          OR referenced_personal_profile_id IS DISTINCT FROM NEW.personal_profile_id
          OR referenced_business_id IS DISTINCT FROM NEW.business_id THEN
          RAISE EXCEPTION 'duplicate candidate expense scope mismatch';
        END IF;

        IF NEW.resolved_by IS NOT NULL AND NOT EXISTS (
          SELECT 1
            FROM app.tenant_memberships
           WHERE tenant_id = NEW.tenant_id
             AND user_id = NEW.resolved_by
             AND status = 'active'
        ) THEN
          RAISE EXCEPTION 'duplicate match resolver is not an active tenant member';
        END IF;
      END IF;

      RETURN NEW;
    END;
    $function$;
  `.execute(database);

  // ------------------------------------------------------------------ //
  // app.mailbox_ingestion_operations
  //
  // Permanent replay over the triple (tenant_id, operation_key,
  // idempotency_key) only -- normalized_request_hash is stored but
  // deliberately excluded from the constraint, same reasoning as
  // migration 018's app.mailbox_operation_keys and migration 019's
  // app.mailbox_scan_runs/app.mailbox_candidates: the application looks the
  // row up by the triple and compares the stored hash itself (same hash
  // replays response_json; a different hash is a typed
  // IDEMPOTENCY_CONFLICT).
  //
  // Unlike app.mailbox_operation_keys (pure append-only replay cache, no
  // UPDATE grant), this table's rows progress pending -> started ->
  // completed|failed (see Ruling above), so UPDATE is not revoked from the
  // runtime role; a terminal-immutability trigger instead guards against
  // any further change once completed/failed, same forward-only shape as
  // migration 019's app.mailbox_candidates terminal guard.
  // ------------------------------------------------------------------ //
  await sql`
    CREATE TABLE app.mailbox_ingestion_operations (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      connection_id uuid NOT NULL,
      candidate_id uuid NOT NULL,
      operation_kind text NOT NULL,
      operation_key text NOT NULL,
      idempotency_key text NOT NULL,
      normalized_request_hash text NOT NULL,
      response_json jsonb,
      status text NOT NULL DEFAULT 'pending',
      version integer NOT NULL DEFAULT 1,
      error_code text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT mailbox_ingestion_operations_connection_tenant_fk
        FOREIGN KEY (connection_id, tenant_id)
        REFERENCES app.mailbox_connections(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT mailbox_ingestion_operations_candidate_tenant_fk
        FOREIGN KEY (candidate_id, tenant_id)
        REFERENCES app.mailbox_candidates(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT mailbox_ingestion_operations_kind_check
        CHECK (operation_kind IN (
          'issue_upload_grant', 'upload_attachment', 'submit_structured_result',
          'materialize_candidate'
        )),
      CONSTRAINT mailbox_ingestion_operations_operation_key_check
        CHECK (char_length(trim(operation_key)) BETWEEN 1 AND 255),
      CONSTRAINT mailbox_ingestion_operations_idempotency_key_check
        CHECK (char_length(trim(idempotency_key)) BETWEEN 1 AND 500),
      CONSTRAINT mailbox_ingestion_operations_normalized_request_hash_check
        CHECK (normalized_request_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT mailbox_ingestion_operations_status_check
        CHECK (status IN ('pending', 'started', 'completed', 'failed')),
      CONSTRAINT mailbox_ingestion_operations_version_check
        CHECK (version > 0),
      CONSTRAINT mailbox_ingestion_operations_permanent_unique
        UNIQUE (tenant_id, operation_key, idempotency_key)
    )
  `.execute(database);
  await sql`
    CREATE INDEX mailbox_ingestion_operations_candidate_lookup_index
      ON app.mailbox_ingestion_operations (tenant_id, candidate_id, operation_kind, status)
  `.execute(database);
  /* Reconcile sweep target: materialize_candidate rows stuck in
     pending/started are exactly what an idempotent reconcile (the next
     scan/status call, or the operator CLI) retries. */
  await sql`
    CREATE INDEX mailbox_ingestion_operations_materialize_pending_index
      ON app.mailbox_ingestion_operations (tenant_id, status)
      WHERE operation_kind = 'materialize_candidate' AND status IN ('pending', 'started')
  `.execute(database);

  await sql`
    CREATE OR REPLACE FUNCTION app.prevent_mailbox_ingestion_operation_terminal_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF OLD.status IN ('completed', 'failed') AND OLD IS DISTINCT FROM NEW THEN
        RAISE EXCEPTION 'terminal mailbox ingestion operation is immutable: %', OLD.status;
      END IF;
      RETURN NEW;
    END;
    $function$;
  `.execute(database);
  await sql`
    CREATE TRIGGER mailbox_ingestion_operations_terminal_guard_trigger
      BEFORE UPDATE ON app.mailbox_ingestion_operations
      FOR EACH ROW EXECUTE FUNCTION app.prevent_mailbox_ingestion_operation_terminal_update()
  `.execute(database);
}

/**
 * Forward-only: this migration is never rolled back, same binding
 * constraint as migration 019 (no `.down(` call anywhere outside migration
 * files; database/migrate.ts's runMigrations() only ever calls
 * migrateToLatest()). A destructive down() would drop
 * app.mailbox_ingestion_operations and permanently destroy connected-source
 * provenance (app.expense_sources.mailbox_candidate_id and its constraints)
 * the moment any operator or tool invoked it.
 */
export async function down(): Promise<void> {
  throw new Error(
    "Migration 020 is forward-only: rollback is not supported, as it would " +
      "destroy persisted mailbox ingestion operation state and connected " +
      "expense-source provenance. Write a new forward migration instead.",
  );
}
