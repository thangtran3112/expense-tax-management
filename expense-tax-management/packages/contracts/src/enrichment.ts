/**
 * Phase 3C enrichment public contracts.
 *
 * - ScopeSchema is canonical here; do not create another public scope schema elsewhere.
 * - No internal worker input/result schemas; Task 3 owns those.
 * - Spec authority: 2026-09-12-phase-3c-auto-tagging-design.md
 */
import { z } from "zod";

import { TimestampSchema, TaxYearSchema, VersionSchema } from "./expenses.js";
import { DeductiblePercentSchema } from "./tax-treatments.js";

// ------------------------------------------------------------------ //
// Canonical scope discriminated union
// ------------------------------------------------------------------ //

export const ScopeSchema = z.union([
  z.strictObject({ kind: z.literal("personal"), profileId: z.uuid() }),
  z.strictObject({ kind: z.literal("business"), businessId: z.uuid() }),
]);
export type Scope = z.infer<typeof ScopeSchema>;

// ------------------------------------------------------------------ //
// Shared helpers
// ------------------------------------------------------------------ //

const ColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Color must be a 6-digit hex string like #RRGGBB");

/**
 * Tag key: lowercase, trimmed, 1–100 chars.
 * Allows namespace syntax: merchant:<slug>, timing:weekend, category:<key>, custom:<uuid>
 * Characters: a-z 0-9 _ : . -
 */
export const TagKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_:.-]+$/, "Tag key must be lowercase and may contain letters, digits, underscores, colons, dots, or hyphens");

// Scope XOR refine (personal XOR business)
const scopeXorRefine = (value: { personalProfileId: string | null; businessId: string | null }) =>
  (value.personalProfileId !== null) !== (value.businessId !== null);

// ------------------------------------------------------------------ //
// Tag
// ------------------------------------------------------------------ //

export const TagStatusSchema = z.enum(["active", "archived"]);
export type TagStatus = z.infer<typeof TagStatusSchema>;

export const TagOriginSchema = z.enum(["custom", "rule"]);
export type TagOrigin = z.infer<typeof TagOriginSchema>;

export const TagSchema = z
  .strictObject({
    id: z.uuid(),
    tenantId: z.uuid(),
    key: TagKeySchema,
    name: z.string().min(1).max(100),
    color: ColorSchema.nullable(),
    origin: TagOriginSchema,
    status: TagStatusSchema,
    version: VersionSchema,
    createdByUserId: z.uuid().nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  });
export type Tag = z.infer<typeof TagSchema>;

/**
 * Custom tag create request — key is generated server-side as `custom:<uuid>`.
 * Clients do not choose the key namespace; only name and optional color are supplied.
 */
export const TagCreateRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  color: ColorSchema.nullable().optional(),
});
export type TagCreateRequest = z.infer<typeof TagCreateRequestSchema>;

export const TagUpdateRequestSchema = z
  .strictObject({
    expectedVersion: VersionSchema,
    name: z.string().trim().min(1).max(100).optional(),
    color: ColorSchema.nullable().optional(),
  })
  .refine(
    (value) => value.name !== undefined || value.color !== undefined,
    { message: "At least one tag change is required" },
  );
export type TagUpdateRequest = z.infer<typeof TagUpdateRequestSchema>;

export const TagArchiveRequestSchema = z.strictObject({
  expectedVersion: VersionSchema,
});
export type TagArchiveRequest = z.infer<typeof TagArchiveRequestSchema>;

export const TagUnarchiveRequestSchema = z.strictObject({
  expectedVersion: VersionSchema,
});
export type TagUnarchiveRequest = z.infer<typeof TagUnarchiveRequestSchema>;

export const TagMergeRequestSchema = z
  .strictObject({
    sourceTagId: z.uuid(),
    targetTagId: z.uuid(),
    expectedSourceVersion: VersionSchema,
    expectedTargetVersion: VersionSchema,
  })
  .refine((value) => value.sourceTagId !== value.targetTagId, {
    message: "Source and target tags must be different",
  });
export type TagMergeRequest = z.infer<typeof TagMergeRequestSchema>;

export const TagListSchema = z.strictObject({
  items: z.array(TagSchema),
  nextCursor: z.string().nullable(),
});
export type TagList = z.infer<typeof TagListSchema>;

// ------------------------------------------------------------------ //
// ExpenseTag  (one row per expense/tag decision)
// ------------------------------------------------------------------ //

export const ExpenseTagSourceSchema = z.enum(["manual", "rule", "historical", "ai"]);
export type ExpenseTagSource = z.infer<typeof ExpenseTagSourceSchema>;

export const ExpenseTagStatusSchema = z.enum(["active", "removed"]);
export type ExpenseTagStatus = z.infer<typeof ExpenseTagStatusSchema>;

export const ExpenseTagSchema = z
  .strictObject({
    id: z.uuid(),
    tenantId: z.uuid(),
    personalProfileId: z.uuid().nullable(),
    businessId: z.uuid().nullable(),
    expenseId: z.uuid(),
    tagId: z.uuid(),
    source: ExpenseTagSourceSchema,
    confidence: z.number().min(0).max(1),
    ruleVersion: z.number().int().positive().nullable(),
    suggestionId: z.uuid().nullable(),
    status: ExpenseTagStatusSchema,
    version: VersionSchema,
    appliedByUserId: z.uuid().nullable(),
    removedByUserId: z.uuid().nullable(),
    appliedAt: TimestampSchema.nullable(),
    removedAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
  })
  .refine(scopeXorRefine, { message: "Exactly one personal profile or business scope is required" });
export type ExpenseTag = z.infer<typeof ExpenseTagSchema>;

export const ExpenseTagAssociateRequestSchema = z.strictObject({
  tagId: z.uuid(),
});
export type ExpenseTagAssociateRequest = z.infer<typeof ExpenseTagAssociateRequestSchema>;

/**
 * Tag remove body — tagId comes from route param, not body.
 */
export const ExpenseTagRemoveRequestSchema = z.strictObject({
  expectedVersion: VersionSchema,
});
export type ExpenseTagRemoveRequest = z.infer<typeof ExpenseTagRemoveRequestSchema>;

export const ExpenseTagListSchema = z.strictObject({
  items: z.array(ExpenseTagSchema),
  nextCursor: z.string().nullable(),
});
export type ExpenseTagList = z.infer<typeof ExpenseTagListSchema>;

// ------------------------------------------------------------------ //
// ExpenseSpendingCategoryDecision  (append-only history)
// ------------------------------------------------------------------ //

export const DecisionSourceSchema = z.enum(["manual", "manual_baseline", "historical", "ai"]);
export type DecisionSource = z.infer<typeof DecisionSourceSchema>;

export const ExpenseSpendingCategoryDecisionSchema = z
  .strictObject({
    id: z.uuid(),
    tenantId: z.uuid(),
    personalProfileId: z.uuid().nullable(),
    businessId: z.uuid().nullable(),
    expenseId: z.uuid(),
    priorSpendingCategoryId: z.uuid().nullable(),
    newSpendingCategoryId: z.uuid().nullable(),
    source: DecisionSourceSchema,
    actorUserId: z.uuid().nullable(),
    expenseVersion: VersionSchema,
    suggestionId: z.uuid().nullable(),
    createdAt: TimestampSchema,
  })
  .refine(scopeXorRefine, { message: "Exactly one personal profile or business scope is required" });
export type ExpenseSpendingCategoryDecision = z.infer<typeof ExpenseSpendingCategoryDecisionSchema>;

export const ExpenseSpendingCategoryDecisionListSchema = z.strictObject({
  items: z.array(ExpenseSpendingCategoryDecisionSchema),
  nextCursor: z.string().nullable(),
});
export type ExpenseSpendingCategoryDecisionList = z.infer<
  typeof ExpenseSpendingCategoryDecisionListSchema
>;

// ------------------------------------------------------------------ //
// EnrichmentSuggestion
// ------------------------------------------------------------------ //

export const EnrichmentSuggestionKindSchema = z.enum(["tag", "spending_category", "tax_category"]);
export type EnrichmentSuggestionKind = z.infer<typeof EnrichmentSuggestionKindSchema>;

export const EnrichmentSuggestionStatusSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
  "superseded",
]);
export type EnrichmentSuggestionStatus = z.infer<typeof EnrichmentSuggestionStatusSchema>;

export const EnrichmentSuggestionSourceSchema = z.enum(["historical", "ai"]);
export type EnrichmentSuggestionSource = z.infer<typeof EnrichmentSuggestionSourceSchema>;

const EvidenceHashSchema = z.string().regex(/^[a-f0-9]{64}$/, "Evidence hash must be a 64-char lowercase hex SHA-256");

/**
 * Bounded evidence: aggregate facts only, no raw receipt text.
 * All string values are bounded to prevent unbounded payloads.
 * Total JSON size is bounded at 8 KB by the database trigger.
 */
export const EnrichmentEvidenceSchema = z
  .record(
    z.string().max(100),
    z.union([
      z.string().max(500),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).max(50),
    ]),
  )
  .refine(
    (value) => JSON.stringify(value).length <= 8192,
    { message: "Evidence must not exceed 8192 bytes when serialized" },
  );
export type EnrichmentEvidence = z.infer<typeof EnrichmentEvidenceSchema>;

// Base fields shared by all kinds
const BaseSuggestionFields = {
  id: z.uuid(),
  tenantId: z.uuid(),
  personalProfileId: z.uuid().nullable(),
  businessId: z.uuid().nullable(),
  expenseId: z.uuid(),
  jobId: z.uuid(),
  kind: EnrichmentSuggestionKindSchema,
  source: EnrichmentSuggestionSourceSchema,
  confidence: z.number().min(0).max(1),
  evidence: EnrichmentEvidenceSchema,
  evidenceHash: EvidenceHashSchema,
  status: EnrichmentSuggestionStatusSchema,
  version: VersionSchema,
  expenseVersion: VersionSchema,
  idempotencyKey: z.string().trim().min(1).max(255),
  resolvedByUserId: z.uuid().nullable(),
  resolvedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
};

// Tax snapshot fields — present for tax_category, null for others.
// businessTaxProfileVersion is required for stale detection on acceptance.
const TaxSnapshotPresentFields = {
  businessTaxProfileId: z.uuid(),
  businessTaxProfileVersion: VersionSchema,
  taxonomyVersionId: z.uuid(),
  taxYear: TaxYearSchema,
};

const TaxSnapshotNullFields = {
  businessTaxProfileId: z.null(),
  businessTaxProfileVersion: z.null(),
  taxonomyVersionId: z.null(),
  taxYear: z.null(),
};

// Resolution state refine
// pending:            resolver=null, time=null
// accepted/rejected:  resolver IS NOT NULL (human action required), time IS NOT NULL
// superseded:         time IS NOT NULL, resolver may be null (system invalidation)
const resolutionStateRefine = (value: {
  status: string;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
}) =>
  (value.status === "pending" &&
    value.resolvedByUserId === null &&
    value.resolvedAt === null) ||
  (value.status === "superseded" &&
    value.resolvedAt !== null) ||
  ((value.status === "accepted" || value.status === "rejected") &&
    value.resolvedByUserId !== null &&
    value.resolvedAt !== null);

export const EnrichmentSuggestionSchema = z
  .discriminatedUnion("kind", [
    // tag suggestion
    z
      .strictObject({
        ...BaseSuggestionFields,
        kind: z.literal("tag"),
        tagId: z.uuid(),
        spendingCategoryId: z.null(),
        taxCategoryDefinitionId: z.null(),
        ...TaxSnapshotNullFields,
      })
      .refine(scopeXorRefine, { message: "Exactly one scope required" })
      .refine(resolutionStateRefine, { message: "Resolution state must match status" }),
    // spending_category suggestion
    z
      .strictObject({
        ...BaseSuggestionFields,
        kind: z.literal("spending_category"),
        tagId: z.null(),
        spendingCategoryId: z.uuid(),
        taxCategoryDefinitionId: z.null(),
        ...TaxSnapshotNullFields,
      })
      .refine(scopeXorRefine, { message: "Exactly one scope required" })
      .refine(resolutionStateRefine, { message: "Resolution state must match status" }),
    // tax_category suggestion — requires business scope and full tax snapshot.
    // businessTaxProfileVersion is required for stale-detection on acceptance.
    z
      .strictObject({
        ...BaseSuggestionFields,
        kind: z.literal("tax_category"),
        tagId: z.null(),
        spendingCategoryId: z.null(),
        taxCategoryDefinitionId: z.uuid(),
        ...TaxSnapshotPresentFields,
      })
      .refine(scopeXorRefine, { message: "Exactly one scope required" })
      .refine(
        (value) => value.businessId !== null,
        { message: "Tax category suggestions require business scope" },
      )
      .refine(resolutionStateRefine, { message: "Resolution state must match status" }),
  ]);
export type EnrichmentSuggestion = z.infer<typeof EnrichmentSuggestionSchema>;

export const EnrichmentSuggestionListSchema = z.strictObject({
  items: z.array(EnrichmentSuggestionSchema),
  nextCursor: z.string().nullable(),
});
export type EnrichmentSuggestionList = z.infer<typeof EnrichmentSuggestionListSchema>;

// ------------------------------------------------------------------ //
// Suggestion action schemas
// ------------------------------------------------------------------ //

// Public user actions: accepted/rejected only. Superseded is a system-only side effect.
const TerminalActionSchema = z.enum(["accepted", "rejected"]);

/**
 * For tax_category acceptance, the human must supply tax profile and
 * deductible percentage; automation provides only the candidate category.
 */
const TaxAcceptanceSchema = z.strictObject({
  businessTaxProfileId: z.uuid(),
  deductiblePercent: DeductiblePercentSchema,
});

export const SuggestionResolveRequestSchema = z.strictObject({
  action: TerminalActionSchema,
  expectedSuggestionVersion: VersionSchema,
  expectedExpenseVersion: VersionSchema,
  idempotencyKey: z.string().trim().min(1).max(255),
  taxAcceptance: TaxAcceptanceSchema.optional(),
});
export type SuggestionResolveRequest = z.infer<typeof SuggestionResolveRequestSchema>;

export const SuggestionResolveResponseSchema = z.strictObject({
  suggestionId: z.uuid(),
  status: EnrichmentSuggestionStatusSchema,
  version: VersionSchema,
});
export type SuggestionResolveResponse = z.infer<typeof SuggestionResolveResponseSchema>;

export const SuggestionRerunRequestSchema = z.strictObject({
  expenseId: z.uuid(),
  kinds: z.array(EnrichmentSuggestionKindSchema).min(1),
});
export type SuggestionRerunRequest = z.infer<typeof SuggestionRerunRequestSchema>;
