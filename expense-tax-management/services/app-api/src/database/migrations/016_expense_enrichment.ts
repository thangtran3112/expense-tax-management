import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  // ------------------------------------------------------------------ //
  // Supporting unique indexes on parent tables needed for composite FKs.
  // Created before any child table that references them.
  // ------------------------------------------------------------------ //
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS expenses_id_tenant_unique
      ON app.expenses (id, tenant_id)
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS processing_jobs_id_tenant_unique
      ON app.processing_jobs (id, tenant_id)
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS business_tax_profiles_id_tenant_unique
      ON app.business_tax_profiles (id, tenant_id)
  `.execute(database);

  // ------------------------------------------------------------------ //
  // app.tags
  //
  // Tenant-level tag definitions (NO personal/business scope columns).
  // origin: 'custom' (user-created) | 'rule' (system-created).
  // UNIQUE (tenant_id, key) across ALL statuses -- archived key reuse
  // requires explicit unarchive; rules never silently reactivate a key.
  // color is nullable; created_by_user_id is nullable for rule tags.
  // ------------------------------------------------------------------ //
  await sql`
    CREATE TABLE app.tags (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      key text NOT NULL,
      name text NOT NULL,
      color text,
      origin text NOT NULL DEFAULT 'custom',
      status text NOT NULL DEFAULT 'active',
      version integer NOT NULL DEFAULT 1,
      created_by_user_id uuid REFERENCES app.users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tags_key_check
        CHECK (key = lower(trim(key)) AND char_length(key) BETWEEN 1 AND 100
          AND key ~ '^[a-z0-9_:.-]+$'),
      CONSTRAINT tags_name_check
        CHECK (char_length(trim(name)) BETWEEN 1 AND 100),
      CONSTRAINT tags_color_check
        CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),
      CONSTRAINT tags_status_check
        CHECK (status IN ('active', 'archived')),
      CONSTRAINT tags_origin_check
        CHECK (origin IN ('custom', 'rule')),
      CONSTRAINT tags_version_check
        CHECK (version > 0),
      CONSTRAINT tags_key_tenant_unique
        UNIQUE (tenant_id, key)
    )
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX tags_id_tenant_unique
      ON app.tags (id, tenant_id)
  `.execute(database);
  await sql`
    CREATE INDEX tags_scope_lookup_index
      ON app.tags (tenant_id, status)
  `.execute(database);

  // ------------------------------------------------------------------ //
  // app.expense_tags
  //
  // One active-or-removed row per (tenant, expense, tag) pair.
  // Exactly one personal_profile_id XOR business_id per row.
  // source: 'manual' | 'rule' | 'historical' | 'ai'
  // status: 'active' | 'removed'
  //
  // State constraints:
  //   active:  removed_by_user_id IS NULL, removed_at IS NULL
  //   removed: removed_by_user_id may be NULL for system removal (rules);
  //            removed_at IS NOT NULL
  // Scope of tag row must equal scope of referenced expense (validated by
  // trigger validate_enrichment_child_scope).
  // ------------------------------------------------------------------ //
  await sql`
    CREATE TABLE app.expense_tags (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      personal_profile_id uuid,
      business_id uuid,
      expense_id uuid NOT NULL,
      tag_id uuid NOT NULL,
      source text NOT NULL,
      confidence numeric(5, 4) NOT NULL,
      rule_version integer,
      suggestion_id uuid,
      status text NOT NULL DEFAULT 'active',
      version integer NOT NULL DEFAULT 1,
      applied_by_user_id uuid REFERENCES app.users(id),
      removed_by_user_id uuid REFERENCES app.users(id),
      applied_at timestamptz,
      removed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT expense_tags_profile_tenant_fk
        FOREIGN KEY (personal_profile_id, tenant_id)
        REFERENCES app.personal_profiles(id, tenant_id),
      CONSTRAINT expense_tags_business_tenant_fk
        FOREIGN KEY (business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id),
      CONSTRAINT expense_tags_expense_tenant_fk
        FOREIGN KEY (expense_id, tenant_id)
        REFERENCES app.expenses(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT expense_tags_tag_tenant_fk
        FOREIGN KEY (tag_id, tenant_id)
        REFERENCES app.tags(id, tenant_id),
      CONSTRAINT expense_tags_scope_check
        CHECK ((personal_profile_id IS NULL) <> (business_id IS NULL)),
      CONSTRAINT expense_tags_source_check
        CHECK (source IN ('manual', 'rule', 'historical', 'ai')),
      CONSTRAINT expense_tags_status_check
        CHECK (status IN ('active', 'removed')),
      CONSTRAINT expense_tags_confidence_check
        CHECK (confidence BETWEEN 0 AND 1),
      CONSTRAINT expense_tags_rule_version_check
        CHECK (rule_version IS NULL OR rule_version > 0),
      CONSTRAINT expense_tags_version_check
        CHECK (version > 0),
      CONSTRAINT expense_tags_removed_state_check
        CHECK (
          (status = 'active' AND removed_at IS NULL AND removed_by_user_id IS NULL)
          OR (status = 'removed' AND removed_at IS NOT NULL)
        ),
      CONSTRAINT expense_tags_expense_tag_unique
        UNIQUE (tenant_id, expense_id, tag_id)
    )
  `.execute(database);
  await sql`
    CREATE INDEX expense_tags_expense_lookup_index
      ON app.expense_tags (tenant_id, expense_id, status)
  `.execute(database);
  await sql`
    CREATE INDEX expense_tags_tag_lookup_index
      ON app.expense_tags (tenant_id, tag_id)
  `.execute(database);

  // ------------------------------------------------------------------ //
  // app.expense_spending_category_decisions  (append-only)
  //
  // Every category change writes a new row. No updates or deletes.
  // Exactly one personal_profile_id XOR business_id per row.
  // source: 'manual' | 'manual_baseline' | 'historical' | 'ai'
  //
  // Scope of decision row must equal scope of referenced expense (validated
  // by trigger validate_enrichment_child_scope).
  //
  // Backfill: existing non-null expenses.spending_category_id becomes a
  // manual_baseline row with prior=NULL, new=current, creator, version.
  // ------------------------------------------------------------------ //
  await sql`
    CREATE TABLE app.expense_spending_category_decisions (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      personal_profile_id uuid,
      business_id uuid,
      expense_id uuid NOT NULL,
      prior_spending_category_id uuid,
      new_spending_category_id uuid,
      source text NOT NULL,
      actor_user_id uuid REFERENCES app.users(id),
      expense_version integer NOT NULL,
      suggestion_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT expense_spending_category_decisions_profile_tenant_fk
        FOREIGN KEY (personal_profile_id, tenant_id)
        REFERENCES app.personal_profiles(id, tenant_id),
      CONSTRAINT expense_spending_category_decisions_business_tenant_fk
        FOREIGN KEY (business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id),
      CONSTRAINT expense_spending_category_decisions_expense_tenant_fk
        FOREIGN KEY (expense_id, tenant_id)
        REFERENCES app.expenses(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT expense_spending_category_decisions_scope_check
        CHECK ((personal_profile_id IS NULL) <> (business_id IS NULL)),
      CONSTRAINT expense_spending_category_decisions_source_check
        CHECK (source IN ('manual', 'manual_baseline', 'historical', 'ai')),
      CONSTRAINT expense_spending_category_decisions_expense_version_check
        CHECK (expense_version > 0)
    )
  `.execute(database);
  await sql`
    CREATE INDEX expense_spending_category_decisions_expense_index
      ON app.expense_spending_category_decisions (tenant_id, expense_id, created_at DESC)
  `.execute(database);

  /* Append-only guard: reject direct mutation but preserve declared FK cascades */
  await sql`
    CREATE OR REPLACE FUNCTION app.prevent_category_decision_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'expense_spending_category_decisions rows are append-only and cannot be updated';
      ELSIF TG_OP = 'DELETE' AND pg_trigger_depth() = 1 THEN
        RAISE EXCEPTION 'expense_spending_category_decisions rows are append-only and cannot be deleted';
      END IF;
      RETURN OLD;
    END;
    $function$;
  `.execute(database);
  await sql`
    CREATE TRIGGER expense_spending_category_decisions_append_only_trigger
      BEFORE UPDATE OR DELETE ON app.expense_spending_category_decisions
      FOR EACH ROW EXECUTE FUNCTION app.prevent_category_decision_mutation()
  `.execute(database);

  /* Backfill */
  await sql`
    INSERT INTO app.expense_spending_category_decisions
      (id, tenant_id, personal_profile_id, business_id, expense_id,
       prior_spending_category_id, new_spending_category_id,
       source, actor_user_id, expense_version, created_at)
    SELECT
      gen_random_uuid(),
      e.tenant_id,
      e.personal_profile_id,
      e.business_id,
      e.id,
      NULL,
      e.spending_category_id,
      'manual_baseline',
      e.created_by_user_id,
      e.version,
      e.created_at
    FROM app.expenses e
    WHERE e.spending_category_id IS NOT NULL
  `.execute(database);

  // ------------------------------------------------------------------ //
  // app.expense_enrichment_suggestions
  //
  // One row per suggestion (pending or resolved). Exactly one scope column.
  // Tax suggestions bind profile ID + version, taxonomy, year, category.
  // source: 'historical' | 'ai'
  // status: 'pending' | 'accepted' | 'rejected' | 'superseded'
  //
  // evidence is bounded JSONB (aggregate facts only, no raw receipt text);
  // octet_length checked via trigger (8 KB limit).
  //
  // Pending uniqueness: per (tenant, expense, kind, candidate, evidence_hash)
  //   using UNIQUE NULLS NOT DISTINCT so same evidence for two different
  //   candidates can coexist while exact duplicate candidate+evidence cannot.
  // ------------------------------------------------------------------ //
  await sql`
    CREATE TABLE app.expense_enrichment_suggestions (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      personal_profile_id uuid,
      business_id uuid,
      expense_id uuid NOT NULL,
      job_id uuid NOT NULL,
      kind text NOT NULL,
      tag_id uuid,
      spending_category_id uuid,
      tax_category_definition_id uuid,
      business_tax_profile_id uuid,
      business_tax_profile_version integer,
      taxonomy_version_id uuid,
      tax_year integer,
      source text NOT NULL,
      confidence numeric(5, 4) NOT NULL,
      evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
      evidence_hash text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      version integer NOT NULL DEFAULT 1,
      expense_version integer NOT NULL,
      idempotency_key text NOT NULL,
      resolved_by_user_id uuid REFERENCES app.users(id),
      resolved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT expense_enrichment_suggestions_profile_tenant_fk
        FOREIGN KEY (personal_profile_id, tenant_id)
        REFERENCES app.personal_profiles(id, tenant_id),
      CONSTRAINT expense_enrichment_suggestions_business_tenant_fk
        FOREIGN KEY (business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id),
      CONSTRAINT expense_enrichment_suggestions_expense_tenant_fk
        FOREIGN KEY (expense_id, tenant_id)
        REFERENCES app.expenses(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT expense_enrichment_suggestions_job_tenant_fk
        FOREIGN KEY (job_id, tenant_id)
        REFERENCES app.processing_jobs(id, tenant_id),
      CONSTRAINT expense_enrichment_suggestions_tax_profile_tenant_fk
        FOREIGN KEY (business_tax_profile_id, tenant_id)
        REFERENCES app.business_tax_profiles(id, tenant_id),
      CONSTRAINT expense_enrichment_suggestions_taxonomy_fk
        FOREIGN KEY (taxonomy_version_id)
        REFERENCES app.taxonomy_versions(id),
      CONSTRAINT expense_enrichment_suggestions_tax_category_fk
        FOREIGN KEY (tax_category_definition_id)
        REFERENCES app.tax_category_definitions(id),
      CONSTRAINT expense_enrichment_suggestions_scope_check
        CHECK ((personal_profile_id IS NULL) <> (business_id IS NULL)),
      CONSTRAINT expense_enrichment_suggestions_kind_check
        CHECK (kind IN ('tag', 'spending_category', 'tax_category')),
      CONSTRAINT expense_enrichment_suggestions_source_check
        CHECK (source IN ('historical', 'ai')),
      CONSTRAINT expense_enrichment_suggestions_status_check
        CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
      CONSTRAINT expense_enrichment_suggestions_confidence_check
        CHECK (confidence BETWEEN 0 AND 1),
      CONSTRAINT expense_enrichment_suggestions_version_check
        CHECK (version > 0),
      CONSTRAINT expense_enrichment_suggestions_expense_version_check
        CHECK (expense_version > 0),
      CONSTRAINT expense_enrichment_suggestions_evidence_hash_check
        CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT expense_enrichment_suggestions_idempotency_key_check
        CHECK (char_length(trim(idempotency_key)) BETWEEN 1 AND 255),
      CONSTRAINT expense_enrichment_suggestions_candidate_xor_check
        CHECK (
          (kind = 'tag' AND tag_id IS NOT NULL AND spending_category_id IS NULL AND tax_category_definition_id IS NULL)
          OR (kind = 'spending_category' AND spending_category_id IS NOT NULL AND tag_id IS NULL AND tax_category_definition_id IS NULL)
          OR (kind = 'tax_category' AND tax_category_definition_id IS NOT NULL AND tag_id IS NULL AND spending_category_id IS NULL)
        ),
      CONSTRAINT expense_enrichment_suggestions_tax_snapshot_check
        CHECK (
          (kind = 'tax_category' AND business_id IS NOT NULL
            AND business_tax_profile_id IS NOT NULL AND business_tax_profile_version IS NOT NULL
            AND taxonomy_version_id IS NOT NULL AND tax_year IS NOT NULL)
          OR (kind <> 'tax_category'
            AND business_tax_profile_id IS NULL AND business_tax_profile_version IS NULL
            AND taxonomy_version_id IS NULL AND tax_year IS NULL)
        ),
      CONSTRAINT expense_enrichment_suggestions_tax_year_check
        CHECK (tax_year IS NULL OR (tax_year >= 1900 AND tax_year <= 9999)),
      CONSTRAINT expense_enrichment_suggestions_tax_profile_version_check
        CHECK (business_tax_profile_version IS NULL OR business_tax_profile_version > 0),
      CONSTRAINT expense_enrichment_suggestions_resolution_check
        CHECK (
          (status = 'pending' AND resolved_by_user_id IS NULL AND resolved_at IS NULL)
          OR (status IN ('accepted', 'rejected') AND resolved_by_user_id IS NOT NULL AND resolved_at IS NOT NULL)
          OR (status = 'superseded' AND resolved_at IS NOT NULL)
        )
    )
  `.execute(database);

  /* Pending suggestion uniqueness includes candidate identity.
     PostgreSQL 17 UNIQUE NULLS NOT DISTINCT: within each kind, the nullable
     candidate column (tag_id / spending_category_id / tax_category_definition_id)
     is treated as equal when NULL, preventing exact duplicate candidate+evidence
     while allowing same evidence_hash for two distinct candidates. */
  await sql`
    CREATE UNIQUE INDEX expense_enrichment_suggestions_pending_tag_unique
      ON app.expense_enrichment_suggestions (tenant_id, expense_id, kind, tag_id, evidence_hash)
      WHERE status = 'pending' AND kind = 'tag'
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX expense_enrichment_suggestions_pending_category_unique
      ON app.expense_enrichment_suggestions (tenant_id, expense_id, kind, spending_category_id, evidence_hash)
      WHERE status = 'pending' AND kind = 'spending_category'
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX expense_enrichment_suggestions_pending_tax_unique
      ON app.expense_enrichment_suggestions (tenant_id, expense_id, kind, tax_category_definition_id, evidence_hash)
      WHERE status = 'pending' AND kind = 'tax_category'
  `.execute(database);
  await sql`
    CREATE INDEX expense_enrichment_suggestions_pending_lookup_index
      ON app.expense_enrichment_suggestions (tenant_id, expense_id, kind, status)
  `.execute(database);

  /* Terminal-immutability trigger */
  await sql`
    CREATE OR REPLACE FUNCTION app.prevent_enrichment_suggestion_terminal_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF OLD.status IN ('accepted', 'rejected', 'superseded') AND OLD IS DISTINCT FROM NEW THEN
        RAISE EXCEPTION 'terminal enrichment suggestion is immutable';
      END IF;
      RETURN NEW;
    END;
    $function$;
  `.execute(database);
  await sql`
    CREATE TRIGGER enrichment_suggestions_terminal_guard_trigger
      BEFORE UPDATE ON app.expense_enrichment_suggestions
      FOR EACH ROW EXECUTE FUNCTION app.prevent_enrichment_suggestion_terminal_update()
  `.execute(database);

  /* Evidence size check: reject evidence JSONB > 8192 bytes */
  await sql`
    CREATE OR REPLACE FUNCTION app.check_enrichment_evidence_size()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF octet_length(NEW.evidence::text) > 8192 THEN
        RAISE EXCEPTION 'enrichment suggestion evidence exceeds 8192 byte limit';
      END IF;
      RETURN NEW;
    END;
    $function$;
  `.execute(database);
  await sql`
    CREATE TRIGGER enrichment_suggestions_evidence_size_trigger
      BEFORE INSERT OR UPDATE ON app.expense_enrichment_suggestions
      FOR EACH ROW EXECUTE FUNCTION app.check_enrichment_evidence_size()
  `.execute(database);

  // ------------------------------------------------------------------ //
  // Covering index needed before deferred suggestion_id FKs can reference
  // expense_enrichment_suggestions(id, tenant_id).
  // ------------------------------------------------------------------ //
  await sql`
    CREATE UNIQUE INDEX expense_enrichment_suggestions_id_tenant_unique
      ON app.expense_enrichment_suggestions (id, tenant_id)
  `.execute(database);

  // ------------------------------------------------------------------ //
  // Deferred suggestion_id FK: add nullable FK from expense_tags and
  // expense_spending_category_decisions to expense_enrichment_suggestions
  // now that the suggestions table and its covering index exist.
  // ------------------------------------------------------------------ //
  await sql`
    ALTER TABLE app.expense_tags
      ADD CONSTRAINT expense_tags_suggestion_id_fk
        FOREIGN KEY (suggestion_id, tenant_id)
        REFERENCES app.expense_enrichment_suggestions(id, tenant_id)
  `.execute(database);
  await sql`
    ALTER TABLE app.expense_spending_category_decisions
      ADD CONSTRAINT expense_spending_category_decisions_suggestion_id_fk
        FOREIGN KEY (suggestion_id, tenant_id)
        REFERENCES app.expense_enrichment_suggestions(id, tenant_id)
  `.execute(database);

  // ------------------------------------------------------------------ //
  // suggestion_id deep-validation trigger
  //
  // The FK from expense_tags/expense_spending_category_decisions to
  // expense_enrichment_suggestions validates only (suggestion_id, tenant_id).
  // This trigger enforces that when suggestion_id IS NOT NULL:
  //
  //   expense_tags: linked suggestion must match the row's expense_id,
  //     exact personal/business scope, kind='tag', and tag_id.
  //
  //   expense_spending_category_decisions: linked suggestion must match the
  //     row's expense_id, exact scope, kind='spending_category', and the
  //     suggestion's spending_category_id must equal new_spending_category_id
  //     (NULL=NULL counts as match for explicit clear-category decisions).
  // ------------------------------------------------------------------ //
  await sql`
    CREATE OR REPLACE FUNCTION app.validate_expense_tag_suggestion_linkage()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      sug_expense_id uuid;
      sug_personal_profile_id uuid;
      sug_business_id uuid;
      sug_kind text;
      sug_tag_id uuid;
    BEGIN
      IF NEW.suggestion_id IS NULL THEN
        RETURN NEW;
      END IF;

      SELECT expense_id, personal_profile_id, business_id, kind, tag_id
        INTO sug_expense_id, sug_personal_profile_id, sug_business_id, sug_kind, sug_tag_id
        FROM app.expense_enrichment_suggestions
        WHERE id = NEW.suggestion_id AND tenant_id = NEW.tenant_id
        FOR SHARE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'expense_tag suggestion_id % not found for tenant %',
          NEW.suggestion_id, NEW.tenant_id;
      END IF;

      IF sug_expense_id IS DISTINCT FROM NEW.expense_id
        OR sug_personal_profile_id IS DISTINCT FROM NEW.personal_profile_id
        OR sug_business_id IS DISTINCT FROM NEW.business_id THEN
        RAISE EXCEPTION
          'expense_tag suggestion scope/expense does not match row: suggestion expense=%, scope=(%, %), row expense=%, scope=(%, %)',
          sug_expense_id, sug_personal_profile_id, sug_business_id,
          NEW.expense_id, NEW.personal_profile_id, NEW.business_id;
      END IF;

      IF sug_kind IS DISTINCT FROM 'tag' THEN
        RAISE EXCEPTION
          'expense_tag suggestion_id % has kind %, must be tag',
          NEW.suggestion_id, sug_kind;
      END IF;

      IF sug_tag_id IS DISTINCT FROM NEW.tag_id THEN
        RAISE EXCEPTION
          'expense_tag suggestion_id % candidate tag_id % does not match row tag_id %',
          NEW.suggestion_id, sug_tag_id, NEW.tag_id;
      END IF;

      RETURN NEW;
    END;
    $function$;
  `.execute(database);
  await sql`
    CREATE TRIGGER expense_tags_suggestion_linkage_trigger
      BEFORE INSERT OR UPDATE ON app.expense_tags
      FOR EACH ROW EXECUTE FUNCTION app.validate_expense_tag_suggestion_linkage()
  `.execute(database);

  await sql`
    CREATE OR REPLACE FUNCTION app.validate_category_decision_suggestion_linkage()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      sug_expense_id uuid;
      sug_personal_profile_id uuid;
      sug_business_id uuid;
      sug_kind text;
      sug_spending_category_id uuid;
    BEGIN
      IF NEW.suggestion_id IS NULL THEN
        RETURN NEW;
      END IF;

      SELECT expense_id, personal_profile_id, business_id, kind, spending_category_id
        INTO sug_expense_id, sug_personal_profile_id, sug_business_id, sug_kind, sug_spending_category_id
        FROM app.expense_enrichment_suggestions
        WHERE id = NEW.suggestion_id AND tenant_id = NEW.tenant_id
        FOR SHARE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'category decision suggestion_id % not found for tenant %',
          NEW.suggestion_id, NEW.tenant_id;
      END IF;

      IF sug_expense_id IS DISTINCT FROM NEW.expense_id
        OR sug_personal_profile_id IS DISTINCT FROM NEW.personal_profile_id
        OR sug_business_id IS DISTINCT FROM NEW.business_id THEN
        RAISE EXCEPTION
          'category decision suggestion scope/expense mismatch: suggestion expense=%, scope=(%, %), row expense=%, scope=(%, %)',
          sug_expense_id, sug_personal_profile_id, sug_business_id,
          NEW.expense_id, NEW.personal_profile_id, NEW.business_id;
      END IF;

      IF sug_kind IS DISTINCT FROM 'spending_category' THEN
        RAISE EXCEPTION
          'category decision suggestion_id % has kind %, must be spending_category',
          NEW.suggestion_id, sug_kind;
      END IF;

      IF sug_spending_category_id IS DISTINCT FROM NEW.new_spending_category_id THEN
        RAISE EXCEPTION
          'category decision suggestion_id % candidate spending_category_id % does not match new_spending_category_id %',
          NEW.suggestion_id, sug_spending_category_id, NEW.new_spending_category_id;
      END IF;

      RETURN NEW;
    END;
    $function$;
  `.execute(database);
  await sql`
    CREATE TRIGGER expense_spending_category_decisions_suggestion_linkage_trigger
      BEFORE INSERT ON app.expense_spending_category_decisions
      FOR EACH ROW EXECUTE FUNCTION app.validate_category_decision_suggestion_linkage()
  `.execute(database);

  // ------------------------------------------------------------------ //
  // Child-row scope validation trigger
  //
  // Ensures every expense_tag, category decision, and suggestion row has
  // the same (tenant_id, personal_profile_id, business_id) as the expense
  // it references. Parent-immutability alone is insufficient because it
  // only guards post-hoc scope changes; this guards initial inserts.
  // ------------------------------------------------------------------ //
  await sql`
    CREATE OR REPLACE FUNCTION app.validate_enrichment_child_scope()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      exp_tenant_id uuid;
      exp_personal_profile_id uuid;
      exp_business_id uuid;
    BEGIN
      SELECT tenant_id, personal_profile_id, business_id
        INTO exp_tenant_id, exp_personal_profile_id, exp_business_id
        FROM app.expenses
        WHERE id = NEW.expense_id
        FOR SHARE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'enrichment child row references non-existent expense %', NEW.expense_id;
      END IF;

      IF exp_tenant_id IS DISTINCT FROM NEW.tenant_id
        OR exp_personal_profile_id IS DISTINCT FROM NEW.personal_profile_id
        OR exp_business_id IS DISTINCT FROM NEW.business_id THEN
        RAISE EXCEPTION
          'enrichment child row scope (%, %, %) does not match expense scope (%, %, %)',
          NEW.tenant_id, NEW.personal_profile_id, NEW.business_id,
          exp_tenant_id, exp_personal_profile_id, exp_business_id;
      END IF;

      RETURN NEW;
    END;
    $function$;
  `.execute(database);
  await sql`
    CREATE TRIGGER expense_tags_scope_validation_trigger
      BEFORE INSERT OR UPDATE ON app.expense_tags
      FOR EACH ROW EXECUTE FUNCTION app.validate_enrichment_child_scope()
  `.execute(database);
  await sql`
    CREATE TRIGGER expense_spending_category_decisions_scope_validation_trigger
      BEFORE INSERT OR UPDATE ON app.expense_spending_category_decisions
      FOR EACH ROW EXECUTE FUNCTION app.validate_enrichment_child_scope()
  `.execute(database);
  await sql`
    CREATE TRIGGER expense_enrichment_suggestions_scope_validation_trigger
      BEFORE INSERT OR UPDATE ON app.expense_enrichment_suggestions
      FOR EACH ROW EXECUTE FUNCTION app.validate_enrichment_child_scope()
  `.execute(database);

  /* Parent scope immutability: prevent scope changes on expenses once enrichment data exists */
  await sql`
    CREATE OR REPLACE FUNCTION app.prevent_enrichment_parent_scope_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF OLD.tenant_id IS NOT DISTINCT FROM NEW.tenant_id
        AND OLD.personal_profile_id IS NOT DISTINCT FROM NEW.personal_profile_id
        AND OLD.business_id IS NOT DISTINCT FROM NEW.business_id THEN
        RETURN NEW;
      END IF;

      IF EXISTS (SELECT 1 FROM app.expense_enrichment_suggestions WHERE expense_id = OLD.id)
        OR EXISTS (SELECT 1 FROM app.expense_spending_category_decisions WHERE expense_id = OLD.id)
        OR EXISTS (SELECT 1 FROM app.expense_tags WHERE expense_id = OLD.id) THEN
        RAISE EXCEPTION 'referenced expense scope is immutable once enrichment data exists';
      END IF;

      RETURN NEW;
    END;
    $function$;
  `.execute(database);
  await sql`
    CREATE TRIGGER expenses_enrichment_parent_scope_guard_trigger
      BEFORE UPDATE OF tenant_id, personal_profile_id, business_id ON app.expenses
      FOR EACH ROW EXECUTE FUNCTION app.prevent_enrichment_parent_scope_update()
  `.execute(database);

  // ------------------------------------------------------------------ //
  // app.enrichment_operation_keys  (permanent replay / conflict dedup)
  //
  // UNIQUE (tenant_id, operation_key): simple uniqueness per operation key.
  // UNIQUE NULLS NOT DISTINCT composite: two rows with null candidate_id
  // and otherwise identical binding are treated as equal (duplicate replay).
  // Standard UNIQUE would treat NULL != NULL and allow phantom duplicates.
  // ------------------------------------------------------------------ //
  await sql`
    CREATE TABLE app.enrichment_operation_keys (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      job_id uuid NOT NULL,
      expense_id uuid NOT NULL,
      kind text NOT NULL,
      candidate_id uuid,
      evidence_hash text NOT NULL,
      operation_key text NOT NULL,
      payload_hash text NOT NULL,
      response_json jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT enrichment_operation_keys_job_tenant_fk
        FOREIGN KEY (job_id, tenant_id)
        REFERENCES app.processing_jobs(id, tenant_id),
      CONSTRAINT enrichment_operation_keys_expense_tenant_fk
        FOREIGN KEY (expense_id, tenant_id)
        REFERENCES app.expenses(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT enrichment_operation_keys_kind_check
        CHECK (kind IN ('tag', 'spending_category', 'tax_category', 'result')),
      CONSTRAINT enrichment_operation_keys_evidence_hash_check
        CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT enrichment_operation_keys_payload_hash_check
        CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT enrichment_operation_keys_operation_key_unique
        UNIQUE (tenant_id, operation_key),
      CONSTRAINT enrichment_operation_keys_composite_binding_unique
        UNIQUE NULLS NOT DISTINCT (tenant_id, job_id, expense_id, kind, candidate_id, evidence_hash, operation_key)
    )
  `.execute(database);
  await sql`
    CREATE INDEX enrichment_operation_keys_lookup_index
      ON app.enrichment_operation_keys (tenant_id, job_id, expense_id, kind)
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS expenses_enrichment_parent_scope_guard_trigger ON app.expenses`.execute(database);
  await sql`DROP TRIGGER IF EXISTS expense_enrichment_suggestions_scope_validation_trigger ON app.expense_enrichment_suggestions`.execute(database);
  await sql`DROP TRIGGER IF EXISTS expense_spending_category_decisions_scope_validation_trigger ON app.expense_spending_category_decisions`.execute(database);
  await sql`DROP TRIGGER IF EXISTS expense_tags_scope_validation_trigger ON app.expense_tags`.execute(database);
  await sql`DROP TRIGGER IF EXISTS enrichment_suggestions_terminal_guard_trigger ON app.expense_enrichment_suggestions`.execute(database);
  await sql`DROP TRIGGER IF EXISTS enrichment_suggestions_evidence_size_trigger ON app.expense_enrichment_suggestions`.execute(database);
  await sql`DROP TRIGGER IF EXISTS expense_spending_category_decisions_append_only_trigger ON app.expense_spending_category_decisions`.execute(database);
  await sql`DROP TRIGGER IF EXISTS expense_tags_suggestion_linkage_trigger ON app.expense_tags`.execute(database);
  await sql`DROP TRIGGER IF EXISTS expense_spending_category_decisions_suggestion_linkage_trigger ON app.expense_spending_category_decisions`.execute(database);
  await sql`DROP FUNCTION IF EXISTS app.prevent_enrichment_parent_scope_update()`.execute(database);
  await sql`DROP FUNCTION IF EXISTS app.validate_enrichment_child_scope()`.execute(database);
  await sql`DROP FUNCTION IF EXISTS app.prevent_enrichment_suggestion_terminal_update()`.execute(database);
  await sql`DROP FUNCTION IF EXISTS app.check_enrichment_evidence_size()`.execute(database);
  await sql`DROP FUNCTION IF EXISTS app.prevent_category_decision_mutation()`.execute(database);
  await sql`DROP FUNCTION IF EXISTS app.validate_expense_tag_suggestion_linkage()`.execute(database);
  await sql`DROP FUNCTION IF EXISTS app.validate_category_decision_suggestion_linkage()`.execute(database);
  // Drop child tables before their parents to satisfy FK constraints:
  //   expense_tags → expense_enrichment_suggestions (expense_tags_suggestion_id_fk)
  //   expense_spending_category_decisions → expense_enrichment_suggestions
  //     (expense_spending_category_decisions_suggestion_id_fk)
  // enrichment_operation_keys has no FK to other 016 tables; it goes before
  // expense_enrichment_suggestions to keep all 016 tables together in order.
  // tags is created first in up() and holds no FK to 016 tables, so it drops last.
  await database.schema.dropTable("app.expense_tags").ifExists().execute();
  await database.schema.dropTable("app.expense_spending_category_decisions").ifExists().execute();
  await database.schema.dropTable("app.enrichment_operation_keys").ifExists().execute();
  await database.schema.dropTable("app.expense_enrichment_suggestions").ifExists().execute();
  await database.schema.dropTable("app.tags").ifExists().execute();
  await sql`DROP INDEX IF EXISTS app.business_tax_profiles_id_tenant_unique`.execute(database);
  await sql`DROP INDEX IF EXISTS app.processing_jobs_id_tenant_unique`.execute(database);
  // expenses_id_tenant_unique is a UNIQUE CONSTRAINT created inline by migration 005,
  // not a standalone index created by this migration. DO NOT DROP here — the constraint
  // belongs to migration 005 and must survive this migration's rollback.
}
