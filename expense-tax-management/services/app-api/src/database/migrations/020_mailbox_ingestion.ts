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
  /* Fix round 1 (review Important #2) -- a second composite unique index,
     additionally covering connection_id, so app.mailbox_ingestion_operations
     below can FK against (candidate_id, connection_id, tenant_id) and have
     PostgreSQL itself reject a row whose connection_id does not match the
     referenced candidate's own connection_id (a same-tenant cross-mailbox
     mismatch), not just a row whose candidate/tenant don't match. */
  await sql`
    CREATE UNIQUE INDEX mailbox_candidates_id_connection_tenant_unique
      ON app.mailbox_candidates (id, connection_id, tenant_id)
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
      -- Fix round 1 (review Important #2): three-column FK, not two --
      -- requires the candidate's OWN connection_id to equal this row's
      -- connection_id, so a same-tenant operation can never be inserted
      -- against a candidate that belongs to a different mailbox
      -- connection. Backed by mailbox_candidates_id_connection_tenant_unique
      -- above.
      CONSTRAINT mailbox_ingestion_operations_candidate_connection_tenant_fk
        FOREIGN KEY (candidate_id, connection_id, tenant_id)
        REFERENCES app.mailbox_candidates(id, connection_id, tenant_id) ON DELETE CASCADE,
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

  /* Fix round 1 (review Important #1): the original guard only checked
     terminal immutability, which still permitted any non-terminal
     transition at all -- pending -> completed (skipping started), a
     same-status pending -> pending with different columns, or even
     started -> pending (backward). Replaced with a real forward-only
     state machine, same technique as migration 018's
     prevent_mailbox_oauth_attempt_invalid_transition: terminal check
     first (so it is never short-circuited by the same-status
     allowance), then an explicit allow-list of the only two legal edges
     documented in this migration's own header
     (pending -> started -> completed|failed). */
  await sql`
    CREATE OR REPLACE FUNCTION app.prevent_mailbox_ingestion_operation_invalid_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF OLD.status IN ('completed', 'failed') THEN
        RAISE EXCEPTION 'terminal mailbox ingestion operation is immutable: %', OLD.status;
      END IF;

      IF OLD.status = NEW.status THEN
        RETURN NEW;
      END IF;

      IF NOT (
        (OLD.status = 'pending' AND NEW.status = 'started')
        OR (OLD.status = 'started' AND NEW.status IN ('completed', 'failed'))
      ) THEN
        RAISE EXCEPTION 'invalid mailbox ingestion operation status transition: % -> %', OLD.status, NEW.status;
      END IF;

      RETURN NEW;
    END;
    $function$;
  `.execute(database);
  await sql`
    CREATE TRIGGER mailbox_ingestion_operations_transition_guard_trigger
      BEFORE UPDATE ON app.mailbox_ingestion_operations
      FOR EACH ROW EXECUTE FUNCTION app.prevent_mailbox_ingestion_operation_invalid_transition()
  `.execute(database);

  /* Fix round 1 (review Important #4) + fix round 2 (re-review: an
     allow-listed key with a bare scalar-type check still let raw body/
     HTML ride inside a string value under e.g. errorCode). response_json,
     if present, must be a JSON object; every key must belong to the
     EXACT set the row's own operation_kind returns (not the union of all
     four response shapes -- a 'status' value legal for upload_attachment
     is not legal for materialize_candidate's own status set, so the key
     set AND certain formats are now conditioned on operation_kind); and
     every present value must match a field-specific strict format, not
     just "some scalar":
       - candidateId/connectionId/processingJobId/expenseId/sourceId/
         duplicateMatchId: lowercase UUID (these are always real
         app.*.id values).
       - uploadGrantId/fileId/idempotencyKey: a bounded (<=500 char),
         whitespace-free, printable-ASCII token -- same OpaqueTokenSchema
         format as packages/contracts/src/mailbox-ingestion.ts, so a
         multi-line HTML/MIME body (which always contains whitespace)
         can never satisfy it.
       - errorCode: the canonical error-code TOKEN PATTERN (a short
         uppercase/underscore identifier, e.g. 'ATTACHMENT_BOUND_EXCEEDED')
         -- a pattern, not the hardcoded literal enum, so this trigger
         never needs editing when packages/contracts/src/mailbox.ts's
         MailboxErrorCodeV1 catalog grows; the contracts-side
         MailboxErrorCodeV1Schema enforces exact membership on write.
       - status: the exact enum for this row's operation_kind (upload_attachment:
         READY/REVIEW/FAILED; submit_structured_result/materialize_candidate:
         queued/processed/duplicate/review/failed).
       - expiresAt: an ISO-8601 timestamp.
       - schemaVersion/maxBytes/maxAttachments/attachmentIndex: the exact
         literal/bounded-integer values the real contracts require.
     Per the review: "Enforce in the DB (CHECK/trigger with explicit
     per-kind key sets and regex formats) AND in domain code via a strict
     Zod contract on write" -- packages/contracts/src/mailbox-ingestion.ts
     now exports MailboxBrokerUploadGrantV1Schema/
     MailboxAttachmentUploadResultV1Schema/MailboxMaterializationResultV1Schema
     (Zod, not plain interfaces) as that write-side contract, with formats
     mirroring this trigger's regexes exactly; wiring them into an actual
     write path is Task 3/4's job (no domain write code exists yet --
     Task 1 owns only contracts and migration 020).
     Fix round 3 (re-review): the key-allow-list above only ever rejected
     an EXTRA key -- "{}" and "{ candidateId: null }" both persisted as a
     "valid" response for every operation_kind. Every key in allowed_keys
     is now also required (a FOREACH presence check below), and JSON null
     is only accepted for the fields the real contracts type as nullable
     (errorCode, processingJobId/expenseId/sourceId/duplicateMatchId) --
     every other key rejects null outright, same as the real Zod schemas
     (packages/contracts/src/mailbox-ingestion.ts), which need no change:
     z.strictObject with no optional() fields already requires every key
     present, and only .nullable()-marked fields accept a null value. */
  await sql`
    CREATE OR REPLACE FUNCTION app.validate_mailbox_ingestion_operation_response()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      response_key text;
      response_value jsonb;
      response_text text;
      allowed_keys text[];
      required_key text;
    BEGIN
      IF NEW.response_json IS NULL THEN
        RETURN NEW;
      END IF;

      IF jsonb_typeof(NEW.response_json) <> 'object' THEN
        RAISE EXCEPTION 'mailbox ingestion operation response_json must be a JSON object';
      END IF;

      IF octet_length(NEW.response_json::text) > 4096 THEN
        RAISE EXCEPTION 'mailbox ingestion operation response_json exceeds the 4096-byte bound';
      END IF;

      allowed_keys := CASE NEW.operation_kind
        WHEN 'issue_upload_grant' THEN
          ARRAY['candidateId', 'connectionId', 'uploadGrantId', 'expiresAt', 'maxBytes', 'maxAttachments']
        WHEN 'upload_attachment' THEN
          ARRAY['candidateId', 'attachmentIndex', 'fileId', 'status', 'errorCode', 'idempotencyKey']
        WHEN 'submit_structured_result' THEN
          ARRAY['schemaVersion', 'candidateId', 'status', 'processingJobId', 'expenseId', 'sourceId', 'duplicateMatchId', 'idempotencyKey']
        WHEN 'materialize_candidate' THEN
          ARRAY['schemaVersion', 'candidateId', 'status', 'processingJobId', 'expenseId', 'sourceId', 'duplicateMatchId', 'idempotencyKey']
        ELSE ARRAY[]::text[]
      END;

      /* Fix round 3 (re-review: "{}" and "{ candidateId: null }" both
         persisted as a valid response -- allowed_keys only ever rejected
         EXTRA keys, never caught a MISSING one, matching the real
         contracts (packages/contracts/src/mailbox-ingestion.ts), which are
         z.strictObject with no optional() field -- every key in
         allowed_keys is required to be present, nullable or not. */
      FOREACH required_key IN ARRAY allowed_keys LOOP
        IF NOT (NEW.response_json ? required_key) THEN
          RAISE EXCEPTION 'mailbox ingestion operation response_json is missing required field % for operation_kind %', required_key, NEW.operation_kind;
        END IF;
      END LOOP;

      FOR response_key, response_value IN SELECT key, value FROM jsonb_each(NEW.response_json) LOOP
        IF NOT (response_key = ANY (allowed_keys)) THEN
          RAISE EXCEPTION 'mailbox ingestion operation response_json carries a field not valid for operation_kind %: %', NEW.operation_kind, response_key;
        END IF;

        IF response_value = 'null'::jsonb THEN
          /* Fix round 3 (re-review): JSON null was previously accepted for
             EVERY key, including required non-nullable ones like
             candidateId/status/schemaVersion. Only the fields the real
             contracts type as nullable() (errorCode,
             processingJobId/expenseId/sourceId/duplicateMatchId) may
             actually be null. */
          IF response_key = ANY (ARRAY['errorCode', 'processingJobId', 'expenseId', 'sourceId', 'duplicateMatchId']) THEN
            CONTINUE;
          ELSE
            RAISE EXCEPTION 'mailbox ingestion operation response_json field % must not be null', response_key;
          END IF;
        END IF;

        CASE response_key
          WHEN 'candidateId', 'connectionId', 'processingJobId', 'expenseId', 'sourceId', 'duplicateMatchId' THEN
            IF jsonb_typeof(response_value) <> 'string'
              OR (response_value #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
              RAISE EXCEPTION 'mailbox ingestion operation response_json field % must be a UUID', response_key;
            END IF;
          WHEN 'uploadGrantId', 'fileId', 'idempotencyKey' THEN
            -- Length and charset are checked separately: PostgreSQL's
            -- regex engine caps repetition counts at 255 (RE_DUP_MAX), so
            -- a single pattern with {1,500} throws "invalid repetition
            -- count(s)" -- char_length() carries the 500-char bound, the
            -- unbounded-repetition regex carries the whitespace-free
            -- printable-ASCII charset.
            IF jsonb_typeof(response_value) <> 'string'
              OR char_length(response_value #>> '{}') < 1
              OR char_length(response_value #>> '{}') > 500
              OR (response_value #>> '{}') !~ '^[\x21-\x7e]+$' THEN
              RAISE EXCEPTION 'mailbox ingestion operation response_json field % must be a bounded, whitespace-free token', response_key;
            END IF;
          WHEN 'errorCode' THEN
            IF jsonb_typeof(response_value) <> 'string'
              OR (response_value #>> '{}') !~ '^[A-Z][A-Z0-9_]{1,63}$' THEN
              RAISE EXCEPTION 'mailbox ingestion operation response_json field errorCode must match the canonical error-code token pattern';
            END IF;
          WHEN 'expiresAt' THEN
            -- Task 3 fix (found while implementing, not a 020 business-logic
            -- change): the backslash-d/backslash-dot escapes this regex
            -- previously used never reached PostgreSQL -- a JS template
            -- literal's cooked string (what the sql tagged template
            -- receives, not the raw strings array) treats an unrecognized
            -- escape like backslash-d as a dropped backslash plus a
            -- literal "d" (confirmed live via psql's \sf: the deployed
            -- function body literally read 'd{4}-d{2}-d{2}...', which can
            -- never match a real ISO timestamp -- every issue_upload_grant
            -- write would fail validation in production, not just tests).
            -- Rewritten with bracket character classes ([0-9], [.]),
            -- matching this same function's own UUID/token/errorCode
            -- regexes just above, which never hit this pitfall because
            -- they already avoid backslash escapes entirely.
            IF jsonb_typeof(response_value) <> 'string'
              OR (response_value #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
              RAISE EXCEPTION 'mailbox ingestion operation response_json field expiresAt must be an ISO-8601 timestamp';
            END IF;
          WHEN 'status' THEN
            IF jsonb_typeof(response_value) <> 'string' THEN
              RAISE EXCEPTION 'mailbox ingestion operation response_json field status must be a string';
            END IF;
            response_text := response_value #>> '{}';
            IF NEW.operation_kind = 'upload_attachment' THEN
              IF NOT (response_text = ANY (ARRAY['READY', 'REVIEW', 'FAILED'])) THEN
                RAISE EXCEPTION 'mailbox ingestion operation response_json field status is not a valid upload_attachment status: %', response_text;
              END IF;
            ELSE
              IF NOT (response_text = ANY (ARRAY['queued', 'processed', 'duplicate', 'review', 'failed'])) THEN
                RAISE EXCEPTION 'mailbox ingestion operation response_json field status is not a valid materialization status: %', response_text;
              END IF;
            END IF;
          WHEN 'schemaVersion' THEN
            IF jsonb_typeof(response_value) <> 'number' OR (response_value #>> '{}') <> '1' THEN
              RAISE EXCEPTION 'mailbox ingestion operation response_json field schemaVersion must be the literal 1';
            END IF;
          WHEN 'maxBytes' THEN
            IF jsonb_typeof(response_value) <> 'number' OR (response_value #>> '{}') <> '26214400' THEN
              RAISE EXCEPTION 'mailbox ingestion operation response_json field maxBytes must be the literal 26214400';
            END IF;
          WHEN 'maxAttachments' THEN
            IF jsonb_typeof(response_value) <> 'number' OR (response_value #>> '{}') <> '5' THEN
              RAISE EXCEPTION 'mailbox ingestion operation response_json field maxAttachments must be the literal 5';
            END IF;
          WHEN 'attachmentIndex' THEN
            IF jsonb_typeof(response_value) <> 'number'
              OR (response_value #>> '{}') !~ '^[0-9]+$'
              OR (response_value #>> '{}')::int NOT BETWEEN 0 AND 4 THEN
              RAISE EXCEPTION 'mailbox ingestion operation response_json field attachmentIndex must be an integer between 0 and 4';
            END IF;
          ELSE
            RAISE EXCEPTION 'mailbox ingestion operation response_json field % has no validator', response_key;
        END CASE;
      END LOOP;

      RETURN NEW;
    END;
    $function$;
  `.execute(database);
  await sql`
    CREATE TRIGGER mailbox_ingestion_operations_response_shape_guard_trigger
      BEFORE INSERT OR UPDATE ON app.mailbox_ingestion_operations
      FOR EACH ROW EXECUTE FUNCTION app.validate_mailbox_ingestion_operation_response()
  `.execute(database);

  /* Fix round 1 (review Important #3): once a mailbox_candidates row is
     referenced by an app.expense_sources row (connected provenance), its
     scope and owning connection must never change underneath that
     reference -- same "referenced row's identifying columns are
     immutable" precedent as migration 015's
     prevent_expense_dedup_parent_scope_update, applied here to the
     columns that actually identify a candidate's scope/connection
     (candidate_personal_profile_id / candidate_business_id /
     connection_id), not migration 015's generic personal_profile_id/
     business_id names. A column-list trigger (BEFORE UPDATE OF ...) so it
     only runs when one of these columns is part of the UPDATE's SET
     list, same technique as migration 015's trigger. */
  await sql`
    CREATE OR REPLACE FUNCTION app.prevent_mailbox_candidate_referenced_scope_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF OLD.tenant_id IS NOT DISTINCT FROM NEW.tenant_id
        AND OLD.connection_id IS NOT DISTINCT FROM NEW.connection_id
        AND OLD.candidate_personal_profile_id IS NOT DISTINCT FROM NEW.candidate_personal_profile_id
        AND OLD.candidate_business_id IS NOT DISTINCT FROM NEW.candidate_business_id THEN
        RETURN NEW;
      END IF;

      IF EXISTS (SELECT 1 FROM app.expense_sources WHERE mailbox_candidate_id = OLD.id) THEN
        RAISE EXCEPTION 'referenced mailbox candidate scope/connection is immutable';
      END IF;

      RETURN NEW;
    END;
    $function$;
  `.execute(database);
  await sql`
    CREATE TRIGGER mailbox_candidates_referenced_scope_guard_trigger
      BEFORE UPDATE OF tenant_id, connection_id, candidate_personal_profile_id, candidate_business_id
      ON app.mailbox_candidates
      FOR EACH ROW EXECUTE FUNCTION app.prevent_mailbox_candidate_referenced_scope_update()
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
