import { type Kysely, sql } from "kysely";

/**
 * Phase 3D-A Task 1: mailbox connection ownership ledger prerequisite.
 *
 * App API owns all connection metadata, OAuth attempt state, reviewer
 * grants, and the permanent operation-key ledger. The broker owns Google
 * OAuth, provider calls, and its own separate PostgreSQL token-vault
 * database; this migration stores only an opaque vault_reference pointer
 * and the active token_generation, never a token/code/verifier value.
 *
 * This migration requires Phase 3C migration 016 (app.personal_profiles /
 * app.businesses composite unique indexes already exist) and runtime
 * migration Task 7 Stage A migration 017 to have already run; it creates
 * connection/reviewer/attempt rows only -- no scan/candidate tables
 * (those belong to 3D-B/3D-C).
 */
export async function up(database: Kysely<unknown>): Promise<void> {
  // ------------------------------------------------------------------ //
  // app.mailbox_connections
  //
  // Internal (App-persisted) connection record. Exactly one
  // personal_profile_id XOR business_id per row (same convention as
  // migrations 002/003/005/008/009). vault_reference is opaque to App --
  // App owns which token_generation is currently active (the CAS
  // pointer), never the token itself.
  // ------------------------------------------------------------------ //
  await sql`
    CREATE TABLE app.mailbox_connections (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      personal_profile_id uuid,
      business_id uuid,
      owner_user_id uuid NOT NULL REFERENCES app.users(id),
      provider text NOT NULL,
      provider_account_id text NOT NULL,
      account_email text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      granted_scopes text[] NOT NULL DEFAULT '{}',
      timezone text NOT NULL,
      local_scan_time text NOT NULL,
      scan_enabled boolean NOT NULL DEFAULT true,
      last_scan_at timestamptz,
      next_schedule_at timestamptz,
      vault_reference text NOT NULL,
      token_generation integer NOT NULL DEFAULT 1,
      connection_version integer NOT NULL DEFAULT 1,
      token_operation_lease_id uuid,
      token_operation_lease_expires_at timestamptz,
      active_scan_run_id uuid,
      active_scan_lease_expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      CONSTRAINT mailbox_connections_profile_tenant_fk
        FOREIGN KEY (personal_profile_id, tenant_id)
        REFERENCES app.personal_profiles(id, tenant_id),
      CONSTRAINT mailbox_connections_business_tenant_fk
        FOREIGN KEY (business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id),
      CONSTRAINT mailbox_connections_scope_check
        CHECK ((personal_profile_id IS NULL) <> (business_id IS NULL)),
      CONSTRAINT mailbox_connections_provider_check
        CHECK (provider IN ('gmail', 'outlook')),
      CONSTRAINT mailbox_connections_provider_account_id_check
        CHECK (char_length(trim(provider_account_id)) BETWEEN 1 AND 255),
      CONSTRAINT mailbox_connections_account_email_check
        CHECK (char_length(trim(account_email)) BETWEEN 1 AND 320),
      CONSTRAINT mailbox_connections_status_check
        CHECK (status IN ('pending', 'active', 'paused', 'reauth_required', 'disconnecting', 'revocation_pending', 'revoked')),
      CONSTRAINT mailbox_connections_timezone_check
        CHECK (char_length(trim(timezone)) BETWEEN 1 AND 100),
      CONSTRAINT mailbox_connections_local_scan_time_check
        CHECK (local_scan_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
      CONSTRAINT mailbox_connections_vault_reference_check
        CHECK (char_length(trim(vault_reference)) BETWEEN 1 AND 500),
      CONSTRAINT mailbox_connections_token_generation_check
        CHECK (token_generation > 0),
      CONSTRAINT mailbox_connections_connection_version_check
        CHECK (connection_version > 0),
      CONSTRAINT mailbox_connections_lease_state_check
        CHECK (
          (token_operation_lease_id IS NULL AND token_operation_lease_expires_at IS NULL)
          OR (token_operation_lease_id IS NOT NULL AND token_operation_lease_expires_at IS NOT NULL)
        ),
      CONSTRAINT mailbox_connections_scan_lease_state_check
        CHECK (
          (active_scan_run_id IS NULL AND active_scan_lease_expires_at IS NULL)
          OR (active_scan_run_id IS NOT NULL AND active_scan_lease_expires_at IS NOT NULL)
        ),
      CONSTRAINT mailbox_connections_revoked_state_check
        CHECK (
          (status = 'revoked' AND revoked_at IS NOT NULL)
          OR (status <> 'revoked' AND revoked_at IS NULL)
        )
    )
  `.execute(database);

  /* Composite covering index needed before mailbox_oauth_attempts and
     mailbox_reviewer_grants can declare composite tenant FKs. */
  await sql`
    CREATE UNIQUE INDEX mailbox_connections_id_tenant_unique
      ON app.mailbox_connections (id, tenant_id)
  `.execute(database);

  /* Active uniqueness: at most one non-revoked connection per
     (tenant, scope, provider, provider_account_id). A revoked mailbox
     may be reconnected, creating a new row -- history is preserved. */
  await sql`
    CREATE UNIQUE INDEX mailbox_connections_active_unique
      ON app.mailbox_connections (tenant_id, personal_profile_id, business_id, provider, provider_account_id)
      WHERE status <> 'revoked'
  `.execute(database);
  await sql`
    CREATE INDEX mailbox_connections_tenant_status_index
      ON app.mailbox_connections (tenant_id, status)
  `.execute(database);

  // ------------------------------------------------------------------ //
  // app.mailbox_oauth_attempts
  //
  // One-time OAuth attempt state consumed exactly once by the broker
  // callback. status: 'pending' | 'consumed' | 'completed' | 'expired' |
  // 'cancelled'. A terminal-immutability trigger (completed/expired/
  // cancelled) prevents a consumed replay from reopening a finished
  // attempt -- the OAUTH_REPLAY error code is the application-level
  // surface for this guard.
  // ------------------------------------------------------------------ //
  await sql`
    CREATE TABLE app.mailbox_oauth_attempts (
      id uuid PRIMARY KEY,
      connection_id uuid NOT NULL,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      actor_user_id uuid NOT NULL REFERENCES app.users(id),
      state_digest text NOT NULL,
      session_nonce_digest text NOT NULL,
      redirect_origin text NOT NULL,
      expires_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      consumed_at timestamptz,
      completed_at timestamptz,
      CONSTRAINT mailbox_oauth_attempts_connection_tenant_fk
        FOREIGN KEY (connection_id, tenant_id)
        REFERENCES app.mailbox_connections(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT mailbox_oauth_attempts_state_digest_check
        CHECK (state_digest ~ '^[a-f0-9]{64}$'),
      CONSTRAINT mailbox_oauth_attempts_session_nonce_digest_check
        CHECK (session_nonce_digest ~ '^[a-f0-9]{64}$'),
      CONSTRAINT mailbox_oauth_attempts_redirect_origin_check
        CHECK (char_length(trim(redirect_origin)) BETWEEN 1 AND 2048),
      CONSTRAINT mailbox_oauth_attempts_status_check
        CHECK (status IN ('pending', 'consumed', 'completed', 'expired', 'cancelled')),
      CONSTRAINT mailbox_oauth_attempts_state_digest_unique
        UNIQUE (tenant_id, state_digest)
    )
  `.execute(database);
  await sql`
    CREATE INDEX mailbox_oauth_attempts_connection_index
      ON app.mailbox_oauth_attempts (tenant_id, connection_id, status)
  `.execute(database);
  await sql`
    CREATE INDEX mailbox_oauth_attempts_pending_expiry_index
      ON app.mailbox_oauth_attempts (expires_at)
      WHERE status = 'pending'
  `.execute(database);

  await sql`
    CREATE OR REPLACE FUNCTION app.prevent_mailbox_oauth_attempt_terminal_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF OLD.status IN ('completed', 'expired', 'cancelled') AND OLD IS DISTINCT FROM NEW THEN
        RAISE EXCEPTION 'terminal mailbox OAuth attempt is immutable';
      END IF;
      RETURN NEW;
    END;
    $function$;
  `.execute(database);
  await sql`
    CREATE TRIGGER mailbox_oauth_attempts_terminal_guard_trigger
      BEFORE UPDATE ON app.mailbox_oauth_attempts
      FOR EACH ROW EXECUTE FUNCTION app.prevent_mailbox_oauth_attempt_terminal_update()
  `.execute(database);

  // ------------------------------------------------------------------ //
  // app.mailbox_reviewer_grants
  //
  // Per-connection reviewer/manager grant. At most one active (non-
  // revoked) grant per (connection, user); a revoked grant may be
  // re-issued, creating a new row so grant history is preserved.
  // ------------------------------------------------------------------ //
  await sql`
    CREATE TABLE app.mailbox_reviewer_grants (
      id uuid PRIMARY KEY,
      connection_id uuid NOT NULL,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES app.users(id),
      role text NOT NULL,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      CONSTRAINT mailbox_reviewer_grants_connection_tenant_fk
        FOREIGN KEY (connection_id, tenant_id)
        REFERENCES app.mailbox_connections(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT mailbox_reviewer_grants_role_check
        CHECK (role IN ('reviewer', 'manager')),
      CONSTRAINT mailbox_reviewer_grants_version_check
        CHECK (version > 0)
    )
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX mailbox_reviewer_grants_active_unique
      ON app.mailbox_reviewer_grants (connection_id, user_id)
      WHERE revoked_at IS NULL
  `.execute(database);

  // ------------------------------------------------------------------ //
  // app.mailbox_operation_keys  (permanent replay / conflict dedup)
  //
  // Permanent uniqueness over (tenant_id, operation_key, idempotency_key,
  // normalized_request_hash): the exact same operation replayed with the
  // exact same request returns response_json unchanged. The narrower
  // lookup index (tenant_id, operation_key, idempotency_key) lets the
  // application find an existing row before insert -- if found with a
  // different normalized_request_hash, it returns a typed
  // IDEMPOTENCY_CONFLICT instead of attempting a second write.
  // ------------------------------------------------------------------ //
  await sql`
    CREATE TABLE app.mailbox_operation_keys (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      connection_id uuid,
      operation_key text NOT NULL,
      idempotency_key text NOT NULL,
      normalized_request_hash text NOT NULL,
      response_json jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT mailbox_operation_keys_connection_tenant_fk
        FOREIGN KEY (connection_id, tenant_id)
        REFERENCES app.mailbox_connections(id, tenant_id),
      CONSTRAINT mailbox_operation_keys_operation_key_check
        CHECK (char_length(trim(operation_key)) BETWEEN 1 AND 255),
      CONSTRAINT mailbox_operation_keys_idempotency_key_check
        CHECK (char_length(trim(idempotency_key)) BETWEEN 1 AND 255),
      CONSTRAINT mailbox_operation_keys_normalized_request_hash_check
        CHECK (normalized_request_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT mailbox_operation_keys_permanent_unique
        UNIQUE (tenant_id, operation_key, idempotency_key, normalized_request_hash)
    )
  `.execute(database);
  await sql`
    CREATE INDEX mailbox_operation_keys_lookup_index
      ON app.mailbox_operation_keys (tenant_id, operation_key, idempotency_key)
  `.execute(database);

  /* Runtime role may read/insert operation-key ledger rows (append-only
     replay cache) but never update/delete them -- a cached response must
     never silently change underneath a future replay. Same pattern as
     migration 017's REVOKE/GRANT narrowing. */
  await sql`
    REVOKE UPDATE, DELETE ON app.mailbox_operation_keys FROM expense_app_runtime
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS mailbox_oauth_attempts_terminal_guard_trigger ON app.mailbox_oauth_attempts`.execute(database);
  await sql`DROP FUNCTION IF EXISTS app.prevent_mailbox_oauth_attempt_terminal_update()`.execute(database);
  await database.schema.dropTable("app.mailbox_operation_keys").ifExists().execute();
  await database.schema.dropTable("app.mailbox_reviewer_grants").ifExists().execute();
  await database.schema.dropTable("app.mailbox_oauth_attempts").ifExists().execute();
  await database.schema.dropTable("app.mailbox_connections").ifExists().execute();
}
