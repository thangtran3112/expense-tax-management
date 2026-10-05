/**
 * Canonical worker input contract for ExpenseEnrichmentWorkflow (Task 3).
 *
 * Security properties:
 * - No tenantId, personalProfileId, businessId, selectors, receipt/OCR text,
 *   receipt bytes, amount, tax descriptions, percentages, or filing/review state.
 * - All arrays and string fields are explicitly bounded.
 * - strictObject / no extra fields at every level.
 * - Eligible Business tax snapshot exact tuple per cross-task contract.
 * - Uniqueness enforced on all eligible ID/key arrays and candidate arrays.
 * - All candidate counts bounded to exampleCount (matchCount <= exampleCount).
 *
 * Spec authority: 2026-09-12-phase-3c-auto-tagging-design.md
 */
import { z } from "zod";

import { DateOnlySchema, TaxYearSchema, VersionSchema } from "../expenses.js";

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
// Eligible tax snapshot (Business only; null for Personal)
// Exact tuple: businessTaxProfileId, businessTaxProfileVersion,
//              taxonomyVersionId, taxYear, activeTaxCategoryIds
// ------------------------------------------------------------------ //
export const EligibleTaxSnapshotSchema = z
  .strictObject({
    businessTaxProfileId: z.uuid(),
    businessTaxProfileVersion: VersionSchema,
    taxonomyVersionId: z.uuid(),
    taxYear: TaxYearSchema,
    activeTaxCategoryIds: z.array(z.uuid()).max(100),
  })
  .refine(
    (v) => allUnique(v.activeTaxCategoryIds, (id) => id),
    { message: "activeTaxCategoryIds must not contain duplicate UUIDs" },
  );
export type EligibleTaxSnapshot = z.infer<typeof EligibleTaxSnapshotSchema>;

// ------------------------------------------------------------------ //
// History bounded aggregate candidate facts
// - max 50 examples (spec: "at most the 50 most recent")
// - bounded candidate arrays, no arbitrary/raw content
// - all candidate keys/IDs unique within their array
// - all candidate counts <= exampleCount
// ------------------------------------------------------------------ //

const CandidateTagKeySchema = z.strictObject({
  key: z.string().min(1).max(100),
  count: z.number().int().positive(),
});

const CandidateCategoryIdSchema = z.strictObject({
  id: z.uuid(),
  count: z.number().int().positive(),
});

export const EnrichmentHistorySchema = z
  .strictObject({
    /** Total qualifying examples seen (0-50). */
    exampleCount: z.number().int().min(0).max(50),
    /** Tag key candidates with occurrence count. Max 20. */
    candidateTagKeys: z.array(CandidateTagKeySchema).max(20),
    /** Spending category ID candidates with occurrence count. Max 10. */
    candidateSpendingCategoryIds: z.array(CandidateCategoryIdSchema).max(10),
    /** Tax category definition ID candidates with occurrence count. Max 10. */
    candidateTaxCategoryIds: z.array(CandidateCategoryIdSchema).max(10),
  })
  .refine(
    (v) => allUnique(v.candidateTagKeys, (c) => c.key),
    { message: "candidateTagKeys must not contain duplicate keys" },
  )
  .refine(
    (v) => allUnique(v.candidateSpendingCategoryIds, (c) => c.id),
    { message: "candidateSpendingCategoryIds must not contain duplicate IDs" },
  )
  .refine(
    (v) => allUnique(v.candidateTaxCategoryIds, (c) => c.id),
    { message: "candidateTaxCategoryIds must not contain duplicate IDs" },
  )
  .refine(
    (v) => v.candidateTagKeys.every((c) => c.count <= v.exampleCount),
    { message: "candidateTagKey count must not exceed exampleCount" },
  )
  .refine(
    (v) => v.candidateSpendingCategoryIds.every((c) => c.count <= v.exampleCount),
    { message: "candidateSpendingCategoryId count must not exceed exampleCount" },
  )
  .refine(
    (v) => v.candidateTaxCategoryIds.every((c) => c.count <= v.exampleCount),
    { message: "candidateTaxCategoryId count must not exceed exampleCount" },
  );
export type EnrichmentHistory = z.infer<typeof EnrichmentHistorySchema>;

// ------------------------------------------------------------------ //
// Worker input — no tenant/scope/expense selectors, no raw content
// ------------------------------------------------------------------ //
export const ExpenseEnrichmentInputV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    jobId: z.uuid(),
    expenseId: z.uuid(),
    expenseVersion: VersionSchema,
    /** Normalized merchant slug, null when blank/unknown. Max 100 chars. */
    normalizedMerchant: z.string().trim().min(1).max(100).nullable(),
    /** ISO date the expense was incurred. */
    incurredOn: DateOnlySchema,
    /** Currently selected spending category, null if none. */
    spendingCategoryId: z.uuid().nullable(),
    /** Monotone versioned rules registry version. */
    rulesVersion: z.number().int().positive(),
    /** Tag keys the worker may assert in results. Max 100 entries, all unique. */
    eligibleTagKeys: z.array(z.string().min(1).max(100)).max(100),
    /** Spending category IDs the worker may suggest. Max 100 entries, all unique. */
    eligibleSpendingCategoryIds: z.array(z.uuid()).max(100),
    /** Full Business tax snapshot for eligibility; null for Personal scope. */
    eligibleTaxSnapshot: EligibleTaxSnapshotSchema.nullable(),
    /** Bounded history summary computed server-side; worker reads only. */
    history: EnrichmentHistorySchema,
  })
  .refine(
    (v) => allUnique(v.eligibleTagKeys, (k) => k),
    { message: "eligibleTagKeys must not contain duplicate keys" },
  )
  .refine(
    (v) => allUnique(v.eligibleSpendingCategoryIds, (id) => id),
    { message: "eligibleSpendingCategoryIds must not contain duplicate UUIDs" },
  );
export type ExpenseEnrichmentInputV1 = z.infer<typeof ExpenseEnrichmentInputV1Schema>;

// ------------------------------------------------------------------ //
// App API response discriminated union (consumed by Task 4 / 7)
// - evaluate: provides input for the worker to act on
// - stale:    expense version changed; worker should mark job stale
// - skipped:  expense archived/ineligible; worker should mark job skipped
// ------------------------------------------------------------------ //
export const ExpenseEnrichmentInputResponseV1Schema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("evaluate"),
    input: ExpenseEnrichmentInputV1Schema,
  }),
  z.strictObject({
    outcome: z.literal("stale"),
  }),
  z.strictObject({
    outcome: z.literal("skipped"),
  }),
]);
export type ExpenseEnrichmentInputResponseV1 = z.infer<typeof ExpenseEnrichmentInputResponseV1Schema>;
