import { type Kysely, sql } from "kysely";

/**
 * Phase 3D-C Task 3: widens app.expenses.source to accept
 * 'connected_mailbox', the same additive-evolution pattern migrations 010
 * and 012 already used to grow expenses_source_check ('manual' only ->
 * +'ocr' -> +'forwarded_email'). Deliberately a brand-new forward migration
 * rather than an in-place edit of migration 020: 020 is unreleased and
 * under a concurrent fix round (response_json shape), and this change has
 * zero file/constraint overlap with it -- touches only app.expenses, never
 * app.mailbox_ingestion_operations or app.expense_sources.
 *
 * This is the generic expense.source categorization only (coarse: how was
 * the merchant/amount/date obtained). The authoritative connected-mailbox
 * provenance marker remains app.expense_sources.source_type=
 * 'connected_mailbox' + mailbox_candidate_id (migration 020), unchanged
 * here.
 */
export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE app.expenses
      DROP CONSTRAINT expenses_source_check,
      ADD CONSTRAINT expenses_source_check
        CHECK (source IN ('manual', 'ocr', 'forwarded_email', 'connected_mailbox'))
  `.execute(database);
}

/**
 * Forward-only, same convention as every migration since 019: no operator
 * tool ever calls down(); a destructive rollback would reject any
 * already-persisted connected_mailbox expense row.
 */
export async function down(): Promise<void> {
  throw new Error(
    "Migration 021 is forward-only: rollback is not supported, as it would " +
      "reject persisted connected_mailbox expense rows. Write a new forward " +
      "migration instead.",
  );
}
