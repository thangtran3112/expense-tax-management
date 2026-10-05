/**
 * Migration 016 structural tests.
 *
 * An executable import is used so malformed TypeScript (e.g. a bare SQL comment
 * outside a template literal) causes a module-load error rather than silently
 * satisfying text-search assertions. This is supplemented by live PostgreSQL
 * constraint proofs in the Phase 3C integration test.
 */
import * as migration016 from "../src/database/migrations/016_expense_enrichment.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../src/database/migrations/016_expense_enrichment.ts", import.meta.url),
  "utf8",
);

describe("expense enrichment migration 016 – executable import", () => {
  it("exports up and down functions (module is valid TypeScript)", () => {
    expect(typeof migration016.up).toBe("function");
    expect(typeof migration016.down).toBe("function");
  });
});

describe("expense enrichment migration 016 – schema structure", () => {
  it("creates all five enrichment tables", () => {
    expect(migration).toContain("CREATE TABLE app.tags");
    expect(migration).toContain("CREATE TABLE app.expense_tags");
    expect(migration).toContain("CREATE TABLE app.expense_spending_category_decisions");
    expect(migration).toContain("CREATE TABLE app.expense_enrichment_suggestions");
    expect(migration).toContain("CREATE TABLE app.enrichment_operation_keys");
  });

  // ---- app.tags --------------------------------------------------------

  it("creates tags as tenant-level with no personal/business scope columns", () => {
    const tagsTableMatch = migration.match(/CREATE TABLE app\.tags\s*\([^;]+\)/);
    expect(tagsTableMatch).not.toBeNull();
    const tagsTable = tagsTableMatch![0];
    expect(tagsTable).not.toContain("personal_profile_id");
    expect(tagsTable).not.toContain("business_id");
  });

  it("tags use spec origin enum: custom | rule", () => {
    expect(migration).toMatch(/origin\s+IN\s*\(\s*'custom',\s*'rule'\s*\)/);
  });

  it("tags have nullable color column (no NOT NULL on color)", () => {
    expect(migration).not.toMatch(/color\s+text\s+NOT NULL/);
  });

  it("tags have nullable created_by_user_id", () => {
    expect(migration).toContain("created_by_user_id");
    expect(migration).not.toMatch(/created_by_user_id\s+uuid\s+NOT NULL/);
  });

  it("tags enforce unique (tenant_id, key) across active and archived", () => {
    expect(migration).toContain("tags_key_tenant_unique");
    expect(migration).toMatch(/UNIQUE\s*\(\s*tenant_id,\s*key\s*\)/);
  });

  it("tags key allows namespace colons", () => {
    expect(migration).toMatch(/key\s+~\s+'[^']*:[^']*/);
  });

  it("tags enforce status enum: active | archived", () => {
    expect(migration).toMatch(/status\s+IN\s*\(\s*'active',\s*'archived'\s*\)/);
  });

  it("tags enforce positive version", () => {
    expect(migration).toMatch(/version\s+>\s*0/);
  });

  // ---- app.expense_tags -----------------------------------------------

  it("expense_tags has UUID id primary key", () => {
    expect(migration).toMatch(/CREATE TABLE app\.expense_tags[\s\S]*?id\s+uuid\s+PRIMARY KEY/);
  });

  it("expense_tags includes personal/business XOR check", () => {
    expect(migration).toContain("expense_tags_scope_check");
    expect(migration).toMatch(/expense_tags_scope_check[\s\S]*personal_profile_id IS NULL\) <> \(business_id IS NULL\)/);
  });

  it("expense_tags source enum: manual | rule | historical | ai", () => {
    expect(migration).toMatch(/source\s+IN\s*\(\s*'manual',\s*'rule',\s*'historical',\s*'ai'\s*\)/);
  });

  it("expense_tags status enum: active | removed", () => {
    expect(migration).toMatch(/status\s+IN\s*\(\s*'active',\s*'removed'\s*\)/);
  });

  it("expense_tags has confidence, nullable rule_version, nullable suggestion_id", () => {
    expect(migration).toContain("confidence");
    expect(migration).toContain("rule_version");
    expect(migration).toContain("suggestion_id");
    expect(migration).not.toMatch(/rule_version\s+integer\s+NOT NULL/);
  });

  it("expense_tags has removed_state_check constraint (active/removed state machine)", () => {
    expect(migration).toContain("expense_tags_removed_state_check");
    expect(migration).toMatch(/status\s*=\s*'active'[\s\S]*removed_at IS NULL[\s\S]*removed_by_user_id IS NULL/);
    expect(migration).toMatch(/status\s*=\s*'removed'[\s\S]*removed_at IS NOT NULL/);
  });

  it("expense_tags has applied/removed user and timestamp columns", () => {
    expect(migration).toContain("applied_by_user_id");
    expect(migration).toContain("removed_by_user_id");
    expect(migration).toContain("applied_at");
    expect(migration).toContain("removed_at");
  });

  it("expense_tags has unique (tenant_id, expense_id, tag_id)", () => {
    expect(migration).toContain("expense_tags_expense_tag_unique");
    expect(migration).toMatch(/UNIQUE\s*\(\s*tenant_id,\s*expense_id,\s*tag_id\s*\)/);
  });

  it("expense_tags has composite tenant/scope/expense/tag FKs", () => {
    expect(migration).toContain("expense_tags_expense_tenant_fk");
    expect(migration).toContain("expense_tags_tag_tenant_fk");
    expect(migration).toContain("expense_tags_profile_tenant_fk");
    expect(migration).toContain("expense_tags_business_tenant_fk");
  });

  it("expense_tags gets suggestion_id FK via ALTER TABLE after suggestions table", () => {
    expect(migration).toContain("expense_tags_suggestion_id_fk");
    expect(migration).toMatch(/ALTER TABLE app\.expense_tags[\s\S]*expense_tags_suggestion_id_fk/);
  });

  // ---- app.expense_spending_category_decisions ------------------------

  it("decisions has scope fields (personal/business XOR)", () => {
    expect(migration).toContain("expense_spending_category_decisions_scope_check");
    expect(migration).toMatch(/expense_spending_category_decisions_scope_check[\s\S]*personal_profile_id IS NULL\) <> \(business_id IS NULL\)/);
  });

  it("decisions has prior_spending_category_id and new_spending_category_id", () => {
    expect(migration).toContain("prior_spending_category_id");
    expect(migration).toContain("new_spending_category_id");
  });

  it("decisions source enum: manual | manual_baseline | historical | ai", () => {
    expect(migration).toMatch(/source\s+IN\s*\(\s*'manual',\s*'manual_baseline',\s*'historical',\s*'ai'\s*\)/);
  });

  it("decisions has nullable suggestion_id", () => {
    expect(migration).toContain("suggestion_id");
    expect(migration).not.toMatch(/suggestion_id\s+uuid\s+NOT NULL/);
  });

  it("decisions gets suggestion_id FK via ALTER TABLE after suggestions table", () => {
    expect(migration).toContain("expense_spending_category_decisions_suggestion_id_fk");
    expect(migration).toMatch(/ALTER TABLE app\.expense_spending_category_decisions[\s\S]*expense_spending_category_decisions_suggestion_id_fk/);
  });

  it("decisions are append-only (UPDATE/DELETE trigger)", () => {
    expect(migration).toContain("prevent_category_decision_mutation");
    expect(migration).toContain("expense_spending_category_decisions_append_only_trigger");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON app.expense_spending_category_decisions");
  });

  it("backfills existing spending_category_id into decisions as manual_baseline", () => {
    expect(migration).toContain("manual_baseline");
    expect(migration).toMatch(/INSERT INTO app\.expense_spending_category_decisions/);
    expect(migration).toMatch(/spending_category_id IS NOT NULL/);
  });

  // ---- app.expense_enrichment_suggestions -----------------------------

  it("suggestions has exact personal/business XOR scope", () => {
    expect(migration).toContain("expense_enrichment_suggestions_scope_check");
    expect(migration).toMatch(/expense_enrichment_suggestions_scope_check[\s\S]*personal_profile_id IS NULL\) <> \(business_id IS NULL\)/);
  });

  it("suggestions source enum: historical | ai", () => {
    expect(migration).toMatch(/source\s+IN\s*\(\s*'historical',\s*'ai'\s*\)/);
  });

  it("suggestions has positive version", () => {
    expect(migration).toMatch(/expense_enrichment_suggestions_version_check[\s\S]*version\s*>\s*0/);
  });

  it("suggestions has idempotency_key, resolved_by_user_id, resolved_at", () => {
    expect(migration).toContain("idempotency_key");
    expect(migration).toContain("resolved_by_user_id");
    expect(migration).toContain("resolved_at");
  });

  it("suggestions kind enum: tag | spending_category | tax_category", () => {
    expect(migration).toMatch(/kind\s+IN\s*\(\s*'tag',\s*'spending_category',\s*'tax_category'\s*\)/);
  });

  it("suggestions candidate XOR: tag_id XOR spending_category_id XOR tax_category_definition_id", () => {
    expect(migration).toContain("expense_enrichment_suggestions_candidate_xor_check");
    expect(migration).toMatch(/tag_id IS NOT NULL[\s\S]*spending_category_id IS NULL[\s\S]*tax_category_definition_id IS NULL/);
  });

  it("suggestions tax snapshot includes business_tax_profile_id AND business_tax_profile_version", () => {
    expect(migration).toContain("business_tax_profile_id");
    expect(migration).toContain("business_tax_profile_version");
    expect(migration).toContain("expense_enrichment_suggestions_tax_snapshot_check");
    expect(migration).toMatch(/business_tax_profile_id IS NOT NULL[\s\S]*business_tax_profile_version IS NOT NULL/);
  });

  it("suggestions tax snapshot requires taxonomy_version_id, tax_year, expense_version", () => {
    expect(migration).toContain("taxonomy_version_id");
    expect(migration).toContain("tax_year");
    expect(migration).toContain("expense_version");
  });

  it("suggestions tax profile version has positive check", () => {
    expect(migration).toContain("expense_enrichment_suggestions_tax_profile_version_check");
    expect(migration).toMatch(/business_tax_profile_version IS NULL OR business_tax_profile_version > 0/);
  });

  it("suggestions enforce status enum: pending | accepted | rejected | superseded", () => {
    expect(migration).toMatch(/status\s+IN\s*\(\s*'pending',\s*'accepted',\s*'rejected',\s*'superseded'\s*\)/);
  });

  it("suggestions enforce confidence 0–1", () => {
    expect(migration).toMatch(/confidence\s+BETWEEN\s+0\s+AND\s+1/);
  });

  it("suggestions enforce evidence_hash SHA-256 format", () => {
    expect(migration).toContain("evidence_hash ~ '^[a-f0-9]{64}$'");
  });

  it("suggestions enforce terminal immutability trigger", () => {
    expect(migration).toContain("prevent_enrichment_suggestion_terminal_update");
    expect(migration).toContain("enrichment_suggestions_terminal_guard_trigger");
    expect(migration).toMatch(/OLD\.status\s+IN\s*\(\s*'accepted',\s*'rejected',\s*'superseded'\s*\)/);
    expect(migration).toContain("terminal enrichment suggestion is immutable");
  });

  it("suggestions enforce evidence size trigger (8 KB)", () => {
    expect(migration).toContain("check_enrichment_evidence_size");
    expect(migration).toContain("enrichment_suggestions_evidence_size_trigger");
    expect(migration).toContain("octet_length");
    expect(migration).toContain("8192");
  });

  it("suggestions resolution check enforces pending/terminal state", () => {
    expect(migration).toContain("expense_enrichment_suggestions_resolution_check");
    expect(migration).toMatch(/status\s*=\s*'pending'[\s\S]*resolved_by_user_id IS NULL[\s\S]*resolved_at IS NULL/);
    expect(migration).toMatch(/status\s+IN\s*\(\s*'accepted'[\s\S]*resolved_by_user_id IS NOT NULL[\s\S]*resolved_at IS NOT NULL/);
  });

  it("pending suggestion uniqueness includes candidate identity (kind-specific partial indexes)", () => {
    expect(migration).toContain("expense_enrichment_suggestions_pending_tag_unique");
    expect(migration).toContain("expense_enrichment_suggestions_pending_category_unique");
    expect(migration).toContain("expense_enrichment_suggestions_pending_tax_unique");
    expect(migration).toMatch(/kind\s*=\s*'tag'[\s\S]*pending_tag_unique/);
    expect(migration).toMatch(/kind\s*=\s*'spending_category'[\s\S]*pending_category_unique/);
    expect(migration).toMatch(/kind\s*=\s*'tax_category'[\s\S]*pending_tax_unique/);
  });

  // ---- child-scope validation triggers --------------------------------

  it("has validate_enrichment_child_scope trigger function", () => {
    expect(migration).toContain("validate_enrichment_child_scope");
    expect(migration).toContain("expense_tags_scope_validation_trigger");
    expect(migration).toContain("expense_spending_category_decisions_scope_validation_trigger");
    expect(migration).toContain("expense_enrichment_suggestions_scope_validation_trigger");
  });

  it("child scope trigger locks expense row FOR SHARE before comparing scope", () => {
    expect(migration).toContain("FOR SHARE");
  });

  it("child scope validation covers mutable child-row updates", () => {
    expect(migration).toMatch(
      /CREATE TRIGGER expense_tags_scope_validation_trigger\s+BEFORE INSERT OR UPDATE ON app\.expense_tags/,
    );
    expect(migration).toMatch(
      /CREATE TRIGGER expense_enrichment_suggestions_scope_validation_trigger\s+BEFORE INSERT OR UPDATE ON app\.expense_enrichment_suggestions/,
    );
    expect(migration).toMatch(
      /CREATE TRIGGER expense_spending_category_decisions_scope_validation_trigger\s+BEFORE INSERT OR UPDATE ON app\.expense_spending_category_decisions/,
    );
  });

  // ---- parent scope immutability -------------------------------------

  it("has parent scope immutability trigger for enrichment children", () => {
    expect(migration).toContain("prevent_enrichment_parent_scope_update");
    expect(migration).toContain("expenses_enrichment_parent_scope_guard_trigger");
  });

  // ---- app.enrichment_operation_keys ----------------------------------

  it("operation keys have all required columns", () => {
    expect(migration).toContain("job_id");
    expect(migration).toContain("expense_id");
    expect(migration).toContain("candidate_id");
    expect(migration).toContain("evidence_hash");
    expect(migration).toContain("operation_key");
    expect(migration).toContain("payload_hash");
    expect(migration).toContain("response_json");
  });

  it("operation keys enforce unique (tenant_id, operation_key)", () => {
    expect(migration).toContain("enrichment_operation_keys_operation_key_unique");
    expect(migration).toMatch(/UNIQUE\s*\(\s*tenant_id,\s*operation_key\s*\)/);
  });

  it("operation keys enforce UNIQUE NULLS NOT DISTINCT on composite binding", () => {
    expect(migration).toContain("UNIQUE NULLS NOT DISTINCT");
    expect(migration).toMatch(
      /UNIQUE NULLS NOT DISTINCT\s*\(\s*tenant_id,\s*job_id,\s*expense_id,\s*kind,\s*candidate_id,\s*evidence_hash,\s*operation_key\s*\)/,
    );
  });

  it("operation keys have composite FKs for job+tenant and expense+tenant", () => {
    expect(migration).toContain("enrichment_operation_keys_job_tenant_fk");
    expect(migration).toContain("enrichment_operation_keys_expense_tenant_fk");
  });

  // ---- down() ---------------------------------------------------------

  // ---- suggestion_id deep validation triggers ----------------------------

  it("expense_tags has suggestion_id linkage trigger validating expense/scope/kind/tag_id", () => {
    expect(migration).toContain("validate_expense_tag_suggestion_linkage");
    expect(migration).toContain("expense_tags_suggestion_linkage_trigger");
    expect(migration).toMatch(/sug_kind IS DISTINCT FROM 'tag'/);
    expect(migration).toMatch(/sug_tag_id IS DISTINCT FROM NEW\.tag_id/);
    expect(migration).toMatch(/sug_expense_id IS DISTINCT FROM NEW\.expense_id/);
  });

  it("expense_tags suggestion linkage covers mutable linkage updates", () => {
    expect(migration).toMatch(
      /CREATE TRIGGER expense_tags_suggestion_linkage_trigger\s+BEFORE INSERT OR UPDATE ON app\.expense_tags/,
    );
  });

  it("expense_spending_category_decisions has suggestion_id linkage trigger validating expense/scope/kind/spending_category_id", () => {
    expect(migration).toContain("validate_category_decision_suggestion_linkage");
    expect(migration).toContain("expense_spending_category_decisions_suggestion_linkage_trigger");
    expect(migration).toMatch(/sug_kind IS DISTINCT FROM 'spending_category'/);
    expect(migration).toMatch(/sug_spending_category_id IS DISTINCT FROM NEW\.new_spending_category_id/);
    expect(migration).toMatch(/sug_expense_id IS DISTINCT FROM NEW\.expense_id/);
  });

  // ---- resolution state check -------------------------------------------

  it("resolution check allows superseded with null resolver (system supersession)", () => {
    expect(migration).toContain("expense_enrichment_suggestions_resolution_check");
    // superseded only requires resolved_at, not resolved_by_user_id
    expect(migration).toMatch(/status\s*=\s*'superseded'[\s\S]*resolved_at IS NOT NULL/);
    // accepted/rejected require both
    expect(migration).toMatch(/status\s+IN\s*\(\s*'accepted',\s*'rejected'\s*\)[\s\S]*resolved_by_user_id IS NOT NULL[\s\S]*resolved_at IS NOT NULL/);
    // pending requires both null
    expect(migration).toMatch(/status\s*=\s*'pending'[\s\S]*resolved_by_user_id IS NULL[\s\S]*resolved_at IS NULL/);
  });

  // ---- down() -------------------------------------------------------------

  it("down() drops triggers, functions, and tables in correct order", () => {
    expect(migration).toContain("DROP TRIGGER IF EXISTS enrichment_suggestions_terminal_guard_trigger");
    expect(migration).toContain("DROP TRIGGER IF EXISTS expenses_enrichment_parent_scope_guard_trigger");
    expect(migration).toContain("DROP TRIGGER IF EXISTS expense_tags_scope_validation_trigger");
    expect(migration).toContain("DROP TRIGGER IF EXISTS expense_spending_category_decisions_append_only_trigger");
    expect(migration).toContain("DROP TRIGGER IF EXISTS expense_tags_suggestion_linkage_trigger");
    expect(migration).toContain("DROP TRIGGER IF EXISTS expense_spending_category_decisions_suggestion_linkage_trigger");
    expect(migration).toContain("DROP FUNCTION IF EXISTS app.prevent_enrichment_suggestion_terminal_update()");
    expect(migration).toContain("DROP FUNCTION IF EXISTS app.prevent_enrichment_parent_scope_update()");
    expect(migration).toContain("DROP FUNCTION IF EXISTS app.validate_enrichment_child_scope()");
    expect(migration).toContain("DROP FUNCTION IF EXISTS app.prevent_category_decision_mutation()");
    expect(migration).toContain("DROP FUNCTION IF EXISTS app.check_enrichment_evidence_size()");
    expect(migration).toContain("DROP FUNCTION IF EXISTS app.validate_expense_tag_suggestion_linkage()");
    expect(migration).toContain("DROP FUNCTION IF EXISTS app.validate_category_decision_suggestion_linkage()");
    expect(migration).toMatch(/dropTable\("app\.enrichment_operation_keys"\)/);
    expect(migration).toMatch(/dropTable\("app\.expense_enrichment_suggestions"\)/);
    expect(migration).toMatch(/dropTable\("app\.expense_spending_category_decisions"\)/);
    expect(migration).toMatch(/dropTable\("app\.expense_tags"\)/);
    expect(migration).toMatch(/dropTable\("app\.tags"\)/);
  });

  it("down() drops child tables before expense_enrichment_suggestions to satisfy FK constraints", () => {
    // expense_tags and expense_spending_category_decisions hold non-cascading FKs to
    // expense_enrichment_suggestions (suggestion_id). PostgreSQL rejects DROP TABLE on
    // the parent while children still exist. Correct order: children first, parent last.
    const expenseTagsPos = migration.indexOf('dropTable("app.expense_tags")');
    const expenseDecisionsPos = migration.indexOf('dropTable("app.expense_spending_category_decisions")');
    const suggestionsPos = migration.indexOf('dropTable("app.expense_enrichment_suggestions")');
    const tagsPos = migration.indexOf('dropTable("app.tags")');
    const operationKeysPos = migration.indexOf('dropTable("app.enrichment_operation_keys")');

    expect(expenseTagsPos).toBeGreaterThan(-1);
    expect(expenseDecisionsPos).toBeGreaterThan(-1);
    expect(suggestionsPos).toBeGreaterThan(-1);
    expect(tagsPos).toBeGreaterThan(-1);
    expect(operationKeysPos).toBeGreaterThan(-1);

    // Children must appear before the parent they reference
    expect(expenseTagsPos).toBeLessThan(suggestionsPos);
    expect(expenseDecisionsPos).toBeLessThan(suggestionsPos);

    // expenses_id_tenant_unique is a UNIQUE CONSTRAINT from migration 005, not a
    // standalone index created by this migration — must NOT be dropped here.
    expect(migration).not.toMatch(/DROP INDEX.*expenses_id_tenant_unique/);
  });
});
