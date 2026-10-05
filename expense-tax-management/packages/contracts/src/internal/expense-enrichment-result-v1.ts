/**
 * Canonical worker result contract for ExpenseEnrichmentWorkflow (Task 3).
 *
 * Security properties:
 * - No tenantId, personalProfileId, businessId, expenseId, or any scope/expense
 *   selectors; App API resolves these from the persisted job row.
 * - No raw receipt text, bytes, or arbitrary content in evidence.
 * - Evidence contains aggregate counts only and a bounded hash.
 * - Tax suggestion carries the complete Business profile version/taxonomy/year/
 *   category/expense-version snapshot required for server revalidation.
 * - All arrays explicitly bounded to prevent unbounded payloads.
 * - strictObject at every level — unknown fields are rejected.
 * - ruleTagKeys unique; suggestions unique by kind+candidate identity.
 * - aggregateCounts.matchCount <= aggregateCounts.exampleCount <= 50.
 * - stale|skipped outcomes carry empty ruleTagKeys and suggestions (no-mutation).
 *
 * Spec authority: 2026-09-12-phase-3c-auto-tagging-design.md
 */
import { z } from "zod";

import { TaxYearSchema, VersionSchema } from "../expenses.js";

// ------------------------------------------------------------------ //
// Helpers
// ------------------------------------------------------------------ //

function allUnique<T>(arr: T[], key: (v: T) => string): boolean {
  const seen = new Set<string>();
  for (const item of arr) {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

// ------------------------------------------------------------------ //
// Evidence hash — 64-char lowercase hex SHA-256
// ------------------------------------------------------------------ //
const EvidenceHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Evidence hash must be a 64-char lowercase hex SHA-256");

// ------------------------------------------------------------------ //
// Aggregate counts only — no raw content
// exampleCount bounded to 50 (mirrors input history max).
// matchCount must not exceed exampleCount.
// ------------------------------------------------------------------ //
const AggregateCounts = z
  .strictObject({
    exampleCount: z.number().int().min(0).max(50),
    matchCount: z.number().int().min(0),
  })
  .refine(
    (v) => v.matchCount <= v.exampleCount,
    { message: "matchCount must not exceed exampleCount" },
  );

// ------------------------------------------------------------------ //
// Suggestion variants — strictly discriminated by kind
// source:"historical" is required on every variant; "ai" is reserved and
// must not be emitted by Phase 3C v1 workers.
// ------------------------------------------------------------------ //

const TagSuggestionSchema = z.strictObject({
  kind: z.literal("tag"),
  /** Phase 3C v1 workers must always emit "historical". "ai" is reserved. */
  source: z.literal("historical"),
  tagKey: z.string().min(1).max(100),
  confidence: z.number().min(0).max(1),
  evidenceHash: EvidenceHashSchema,
  aggregateCounts: AggregateCounts,
});

const SpendingCategorySuggestionSchema = z.strictObject({
  kind: z.literal("spending_category"),
  /** Phase 3C v1 workers must always emit "historical". "ai" is reserved. */
  source: z.literal("historical"),
  spendingCategoryId: z.uuid(),
  confidence: z.number().min(0).max(1),
  evidenceHash: EvidenceHashSchema,
  aggregateCounts: AggregateCounts,
});

/**
 * Tax category suggestion — complete Business profile version/taxonomy/year/
 * category/expense-version snapshot required for server revalidation on accept.
 * Exact tuple per cross-task contract.
 */
const TaxCategorySuggestionSchema = z.strictObject({
  kind: z.literal("tax_category"),
  /** Phase 3C v1 workers must always emit "historical". "ai" is reserved. */
  source: z.literal("historical"),
  taxCategoryDefinitionId: z.uuid(),
  businessTaxProfileId: z.uuid(),
  businessTaxProfileVersion: VersionSchema,
  taxonomyVersionId: z.uuid(),
  taxYear: TaxYearSchema,
  /** Expense version at inference time; required for server stale-detection. */
  expenseVersion: VersionSchema,
  confidence: z.number().min(0).max(1),
  evidenceHash: EvidenceHashSchema,
  aggregateCounts: AggregateCounts,
});

const EnrichmentSuggestionResultSchema = z.discriminatedUnion("kind", [
  TagSuggestionSchema,
  SpendingCategorySuggestionSchema,
  TaxCategorySuggestionSchema,
]);
export type EnrichmentSuggestionResult = z.infer<typeof EnrichmentSuggestionResultSchema>;

// Derive a string identity key for a suggestion (kind + candidate ID/key).
type ParsedSuggestion = z.infer<typeof EnrichmentSuggestionResultSchema>;
function suggestionIdentity(s: ParsedSuggestion): string {
  switch (s.kind) {
    case "tag":
      return `tag:${s.tagKey}`;
    case "spending_category":
      return `spending_category:${s.spendingCategoryId}`;
    case "tax_category":
      return `tax_category:${s.taxCategoryDefinitionId}`;
  }
}

// ------------------------------------------------------------------ //
// Worker result — top-level (no tenant/scope/expense selectors)
// ------------------------------------------------------------------ //
export const ExpenseEnrichmentResultV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    rulesVersion: VersionSchema,
    /**
     * applied: rules ran and result is actionable
     * stale:   expense version changed before worker submitted result
     * skipped: expense was archived/ineligible; nothing to apply
     */
    outcome: z.enum(["applied", "stale", "skipped"]),
    /** Tag keys asserted by deterministic rules. Max 50, all unique. */
    ruleTagKeys: z.array(z.string().min(1).max(100)).max(50),
    /** Historical/future suggestions. Max 50, unique by kind+candidate. */
    suggestions: z.array(EnrichmentSuggestionResultSchema).max(50),
  })
  .refine(
    (v) => allUnique(v.ruleTagKeys, (k) => k),
    { message: "ruleTagKeys must not contain duplicate keys" },
  )
  .refine(
    (v) => allUnique(v.suggestions, suggestionIdentity),
    { message: "suggestions must not contain duplicates by kind+candidate identity" },
  )
  .refine(
    (v) =>
      v.outcome === "applied" ||
      (v.ruleTagKeys.length === 0 && v.suggestions.length === 0),
    {
      message:
        "stale and skipped outcomes must have empty ruleTagKeys and suggestions (no-mutation)",
    },
  );
export type ExpenseEnrichmentResultV1 = z.infer<typeof ExpenseEnrichmentResultV1Schema>;

// Re-export suggestion schema for consumers
export { EnrichmentSuggestionResultSchema };
