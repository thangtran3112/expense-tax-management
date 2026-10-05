import { describe, expect, expectTypeOf, it } from "vitest";

import {
  // Scope
  ScopeSchema,
  type Scope,
  // Tag
  TagKeySchema,
  TagStatusSchema,
  TagOriginSchema,
  TagSchema,
  TagUpdateRequestSchema,
  TagArchiveRequestSchema,
  TagUnarchiveRequestSchema,
  TagMergeRequestSchema,
  TagListSchema,
  type Tag,
  // ExpenseTag
  ExpenseTagSourceSchema,
  ExpenseTagStatusSchema,
  ExpenseTagSchema,
  ExpenseTagAssociateRequestSchema,
  ExpenseTagRemoveRequestSchema,
  ExpenseTagListSchema,
  // Decision
  DecisionSourceSchema,
  ExpenseSpendingCategoryDecisionSchema,
  ExpenseSpendingCategoryDecisionListSchema,
  // Suggestion
  EnrichmentSuggestionKindSchema,
  EnrichmentSuggestionStatusSchema,
  EnrichmentSuggestionSourceSchema,
  EnrichmentSuggestionSchema,
  EnrichmentSuggestionListSchema,
  EnrichmentEvidenceSchema,
  // Suggestion actions
  SuggestionResolveRequestSchema,
  SuggestionResolveResponseSchema,
  SuggestionRerunRequestSchema,
} from "../src/enrichment.js";

const ids = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  profileId: "00000000-0000-4000-8000-000000000002",
  businessId: "00000000-0000-4000-8000-000000000003",
  tagId: "00000000-0000-4000-8000-000000000004",
  expenseId: "00000000-0000-4000-8000-000000000005",
  jobId: "00000000-0000-4000-8000-000000000006",
  suggestionId: "00000000-0000-4000-8000-000000000007",
  categoryId: "00000000-0000-4000-8000-000000000008",
  taxCategoryId: "00000000-0000-4000-8000-000000000009",
  taxProfileId: "00000000-0000-4000-8000-00000000000a",
  taxonomyVersionId: "00000000-0000-4000-8000-00000000000b",
  userId: "00000000-0000-4000-8000-00000000000c",
  targetTagId: "00000000-0000-4000-8000-00000000000d",
};

// ============================================================
// ScopeSchema
// ============================================================
describe("ScopeSchema", () => {
  it("accepts personal scope", () => {
    expect(ScopeSchema.safeParse({ kind: "personal", profileId: ids.profileId }).success).toBe(true);
  });

  it("accepts business scope", () => {
    expect(ScopeSchema.safeParse({ kind: "business", businessId: ids.businessId }).success).toBe(true);
  });

  it("rejects unknown kind", () => {
    expect(ScopeSchema.safeParse({ kind: "unknown", profileId: ids.profileId }).success).toBe(false);
  });

  it("rejects personal scope with extra businessId field", () => {
    expect(
      ScopeSchema.safeParse({ kind: "personal", profileId: ids.profileId, businessId: ids.businessId }).success,
    ).toBe(false);
  });

  it("rejects business scope with extra profileId field", () => {
    expect(
      ScopeSchema.safeParse({ kind: "business", businessId: ids.businessId, profileId: ids.profileId }).success,
    ).toBe(false);
  });

  it("infers correct Scope type", () => {
    expectTypeOf<Scope>().toMatchTypeOf<
      { kind: "personal"; profileId: string } | { kind: "business"; businessId: string }
    >();
  });
});

// ============================================================
// Tag schemas
// ============================================================
describe("Tag schemas – spec alignment", () => {
  const baseTag: Tag = {
    id: ids.tagId,
    tenantId: ids.tenantId,
    key: "merchant:starbucks",
    name: "Starbucks",
    color: null,
    origin: "rule",
    status: "active",
    version: 1,
    createdByUserId: null,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  };

  it("accepts a valid tenant-level tag with nullable color and nullable createdByUserId", () => {
    expect(TagSchema.parse(baseTag)).toEqual(baseTag);
  });

  it("accepts a tag with color set", () => {
    expect(TagSchema.safeParse({ ...baseTag, color: "#FF5733" }).success).toBe(true);
  });

  it("rejects tag with invalid color format when non-null", () => {
    expect(TagSchema.safeParse({ ...baseTag, color: "red" }).success).toBe(false);
    expect(TagSchema.safeParse({ ...baseTag, color: "FFAABB" }).success).toBe(false);
  });

  it("rejects extra fields (strictObject)", () => {
    expect(TagSchema.safeParse({ ...baseTag, extra: true }).success).toBe(false);
  });

  it("rejects invalid status", () => {
    expect(TagSchema.safeParse({ ...baseTag, status: "deleted" }).success).toBe(false);
  });

  it("origin enum is custom | rule (not ai | manual_baseline)", () => {
    expect(TagOriginSchema.parse("custom")).toBe("custom");
    expect(TagOriginSchema.parse("rule")).toBe("rule");
    expect(TagOriginSchema.safeParse("ai").success).toBe(false);
    expect(TagOriginSchema.safeParse("manual_baseline").success).toBe(false);
  });

  it("status enum is active | archived", () => {
    expect(TagStatusSchema.parse("active")).toBe("active");
    expect(TagStatusSchema.parse("archived")).toBe("archived");
    expect(TagStatusSchema.safeParse("removed").success).toBe(false);
  });

  it("accepts namespaced tag keys with colons", () => {
    const keys = [
      "merchant:starbucks",
      "timing:weekend",
      "category:office-supplies",
      `custom:${ids.tagId}`,
    ];
    for (const key of keys) {
      expect(TagKeySchema.safeParse(key).success, `key '${key}' should be valid`).toBe(true);
      // TagSchema.key uses TagKeySchema — verify passthrough
      expect(TagSchema.safeParse({ ...baseTag, key }).success, `TagSchema key '${key}' should be valid`).toBe(true);
    }
  });

  it("rejects key with uppercase letters", () => {
    expect(TagKeySchema.safeParse("Merchant:Test").success).toBe(false);
  });

  it("rejects key with spaces", () => {
    expect(TagKeySchema.safeParse("my tag").success).toBe(false);
  });

  it("accepts TagUpdateRequestSchema with at least one change", () => {
    expect(TagUpdateRequestSchema.safeParse({ expectedVersion: 1, name: "New Name" }).success).toBe(true);
    expect(TagUpdateRequestSchema.safeParse({ expectedVersion: 1, color: "#AABBCC" }).success).toBe(true);
  });

  it("rejects TagUpdateRequestSchema with no change fields", () => {
    expect(TagUpdateRequestSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
  });

  it("accepts TagArchiveRequestSchema", () => {
    expect(TagArchiveRequestSchema.safeParse({ expectedVersion: 2 }).success).toBe(true);
  });

  it("accepts TagUnarchiveRequestSchema", () => {
    expect(TagUnarchiveRequestSchema.safeParse({ expectedVersion: 2 }).success).toBe(true);
  });

  it("accepts TagMergeRequestSchema with source and target tag IDs plus expected versions", () => {
    expect(
      TagMergeRequestSchema.safeParse({
        sourceTagId: ids.tagId,
        targetTagId: ids.targetTagId,
        expectedSourceVersion: 1,
        expectedTargetVersion: 2,
      }).success,
    ).toBe(true);
  });

  it("rejects TagMergeRequestSchema with source == target", () => {
    expect(
      TagMergeRequestSchema.safeParse({
        sourceTagId: ids.tagId,
        targetTagId: ids.tagId,
        expectedSourceVersion: 1,
        expectedTargetVersion: 2,
      }).success,
    ).toBe(false);
  });

  it("accepts TagListSchema with pagination cursor", () => {
    expect(TagListSchema.parse({ items: [baseTag], nextCursor: null })).toEqual({
      items: [baseTag],
      nextCursor: null,
    });
  });
});

// ============================================================
// ExpenseTag schemas
// ============================================================
describe("ExpenseTag schemas – spec alignment", () => {
  const baseExpenseTag = {
    id: ids.suggestionId,
    expenseId: ids.expenseId,
    tagId: ids.tagId,
    tenantId: ids.tenantId,
    personalProfileId: ids.profileId,
    businessId: null,
    source: "rule" as const,
    confidence: 1.0,
    ruleVersion: 1,
    suggestionId: null,
    status: "active" as const,
    version: 1,
    appliedByUserId: null,
    removedByUserId: null,
    appliedAt: null,
    removedAt: null,
    createdAt: "2026-09-12T00:00:00.000Z",
  };

  it("accepts a valid rule-applied expense tag", () => {
    expect(ExpenseTagSchema.safeParse(baseExpenseTag).success).toBe(true);
  });

  it("accepts a business-scoped expense tag", () => {
    expect(
      ExpenseTagSchema.safeParse({
        ...baseExpenseTag,
        personalProfileId: null,
        businessId: ids.businessId,
      }).success,
    ).toBe(true);
  });

  it("rejects dual-scoped expense tag", () => {
    expect(
      ExpenseTagSchema.safeParse({
        ...baseExpenseTag,
        businessId: ids.businessId,
      }).success,
    ).toBe(false);
  });

  it("rejects null-scoped expense tag", () => {
    expect(
      ExpenseTagSchema.safeParse({
        ...baseExpenseTag,
        personalProfileId: null,
      }).success,
    ).toBe(false);
  });

  it("source enum is manual | rule | historical | ai", () => {
    for (const source of ["manual", "rule", "historical", "ai"] as const) {
      expect(ExpenseTagSourceSchema.safeParse(source).success, `source '${source}' valid`).toBe(true);
    }
    expect(ExpenseTagSourceSchema.safeParse("manual_baseline").success).toBe(false);
  });

  it("status enum is active | removed (not active | archived)", () => {
    expect(ExpenseTagStatusSchema.parse("active")).toBe("active");
    expect(ExpenseTagStatusSchema.parse("removed")).toBe("removed");
    expect(ExpenseTagStatusSchema.safeParse("archived").success).toBe(false);
  });

  it("ruleVersion is nullable and must be positive when present", () => {
    expect(ExpenseTagSchema.safeParse({ ...baseExpenseTag, ruleVersion: null }).success).toBe(true);
    expect(ExpenseTagSchema.safeParse({ ...baseExpenseTag, ruleVersion: 0 }).success).toBe(false);
  });

  it("suggestionId is nullable UUID", () => {
    expect(ExpenseTagSchema.safeParse({ ...baseExpenseTag, suggestionId: ids.suggestionId }).success).toBe(true);
    expect(ExpenseTagSchema.safeParse({ ...baseExpenseTag, suggestionId: null }).success).toBe(true);
  });

  it("accepts a removed expense tag with removedByUserId and removedAt", () => {
    expect(
      ExpenseTagSchema.safeParse({
        ...baseExpenseTag,
        status: "removed",
        removedByUserId: ids.userId,
        removedAt: "2026-09-13T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("rejects extra fields", () => {
    expect(ExpenseTagSchema.safeParse({ ...baseExpenseTag, extra: true }).success).toBe(false);
  });

  it("accepts ExpenseTagAssociateRequestSchema", () => {
    expect(
      ExpenseTagAssociateRequestSchema.safeParse({ tagId: ids.tagId }).success,
    ).toBe(true);
  });

  it("accepts ExpenseTagRemoveRequestSchema", () => {
    // tagId travels in route param, not request body
    expect(
      ExpenseTagRemoveRequestSchema.safeParse({ expectedVersion: 1 }).success,
    ).toBe(true);
  });

  it("accepts ExpenseTagListSchema", () => {
    expect(
      ExpenseTagListSchema.safeParse({ items: [baseExpenseTag], nextCursor: null }).success,
    ).toBe(true);
  });
});

// ============================================================
// ExpenseSpendingCategoryDecision schemas
// ============================================================
describe("ExpenseSpendingCategoryDecision schemas – spec alignment", () => {
  const baseDecision = {
    id: ids.suggestionId,
    expenseId: ids.expenseId,
    tenantId: ids.tenantId,
    personalProfileId: ids.profileId,
    businessId: null,
    priorSpendingCategoryId: null,
    newSpendingCategoryId: ids.categoryId,
    source: "manual_baseline" as const,
    actorUserId: ids.userId,
    expenseVersion: 1,
    suggestionId: null,
    createdAt: "2026-09-12T00:00:00.000Z",
  };

  it("accepts valid decision with prior/new category IDs", () => {
    expect(ExpenseSpendingCategoryDecisionSchema.parse(baseDecision)).toEqual(baseDecision);
  });

  it("accepts decision with both prior and new category set (category change)", () => {
    expect(
      ExpenseSpendingCategoryDecisionSchema.safeParse({
        ...baseDecision,
        priorSpendingCategoryId: ids.categoryId,
        newSpendingCategoryId: ids.targetTagId,
      }).success,
    ).toBe(true);
  });

  it("rejects dual-scoped decision", () => {
    expect(
      ExpenseSpendingCategoryDecisionSchema.safeParse({ ...baseDecision, businessId: ids.businessId }).success,
    ).toBe(false);
  });

  it("source enum is manual | manual_baseline | historical | ai (not manual_user)", () => {
    for (const source of ["manual", "manual_baseline", "historical", "ai"] as const) {
      expect(DecisionSourceSchema.safeParse(source).success, `source '${source}' valid`).toBe(true);
    }
    expect(DecisionSourceSchema.safeParse("manual_user").success).toBe(false);
  });

  it("suggestionId is nullable UUID", () => {
    expect(
      ExpenseSpendingCategoryDecisionSchema.safeParse({ ...baseDecision, suggestionId: ids.suggestionId }).success,
    ).toBe(true);
  });

  it("accepts list schema", () => {
    expect(
      ExpenseSpendingCategoryDecisionListSchema.safeParse({ items: [baseDecision], nextCursor: null }).success,
    ).toBe(true);
  });
});

// ============================================================
// EnrichmentSuggestion schemas
// ============================================================
describe("EnrichmentSuggestion schemas – spec alignment", () => {
  const baseTagSuggestion = {
    id: ids.suggestionId,
    tenantId: ids.tenantId,
    personalProfileId: ids.profileId,
    businessId: null,
    expenseId: ids.expenseId,
    jobId: ids.jobId,
    kind: "tag" as const,
    tagId: ids.tagId,
    spendingCategoryId: null,
    taxCategoryDefinitionId: null,
    businessTaxProfileId: null,
    businessTaxProfileVersion: null,
    taxonomyVersionId: null,
    taxYear: null,
    source: "historical" as const,
    confidence: 0.85,
    evidence: { matchedCount: 4, totalCount: 5 },
    evidenceHash: "a".repeat(64),
    status: "pending" as const,
    version: 1,
    expenseVersion: 1,
    idempotencyKey: "enrich-job-123-tag-abc",
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: "2026-09-12T00:00:00.000Z",
  };

  it("accepts a valid pending tag suggestion", () => {
    expect(EnrichmentSuggestionSchema.safeParse(baseTagSuggestion).success).toBe(true);
  });

  it("accepts a business-scoped suggestion", () => {
    expect(
      EnrichmentSuggestionSchema.safeParse({
        ...baseTagSuggestion,
        personalProfileId: null,
        businessId: ids.businessId,
      }).success,
    ).toBe(true);
  });

  it("rejects dual-scoped suggestion", () => {
    expect(
      EnrichmentSuggestionSchema.safeParse({ ...baseTagSuggestion, businessId: ids.businessId }).success,
    ).toBe(false);
  });

  it("source enum is historical | ai (not manual_baseline or rule)", () => {
    expect(EnrichmentSuggestionSourceSchema.parse("historical")).toBe("historical");
    expect(EnrichmentSuggestionSourceSchema.parse("ai")).toBe("ai");
    expect(EnrichmentSuggestionSourceSchema.safeParse("manual_baseline").success).toBe(false);
    expect(EnrichmentSuggestionSourceSchema.safeParse("rule").success).toBe(false);
  });

  it("rejects confidence out of [0,1]", () => {
    expect(EnrichmentSuggestionSchema.safeParse({ ...baseTagSuggestion, confidence: -0.01 }).success).toBe(false);
    expect(EnrichmentSuggestionSchema.safeParse({ ...baseTagSuggestion, confidence: 1.01 }).success).toBe(false);
  });

  it("rejects invalid evidence_hash format", () => {
    expect(
      EnrichmentSuggestionSchema.safeParse({ ...baseTagSuggestion, evidenceHash: "not-a-hash" }).success,
    ).toBe(false);
    expect(
      EnrichmentSuggestionSchema.safeParse({ ...baseTagSuggestion, evidenceHash: "A".repeat(64) }).success,
    ).toBe(false);
  });

  it("has version (positive integer)", () => {
    expect(EnrichmentSuggestionSchema.safeParse({ ...baseTagSuggestion, version: 0 }).success).toBe(false);
    expect(EnrichmentSuggestionSchema.safeParse({ ...baseTagSuggestion, version: 2 }).success).toBe(true);
  });

  it("has idempotency_key", () => {
    expect(EnrichmentSuggestionSchema.safeParse({ ...baseTagSuggestion, idempotencyKey: "" }).success).toBe(false);
  });

  it("accepted/rejected require both resolvedByUserId (human) and resolvedAt", () => {
    const humanResolved = {
      resolvedByUserId: ids.userId,
      resolvedAt: "2026-09-13T00:00:00.000Z",
    };
    for (const status of ["accepted", "rejected"] as const) {
      expect(
        EnrichmentSuggestionSchema.safeParse({ ...baseTagSuggestion, status, ...humanResolved }).success,
        `status '${status}' with human resolver should be valid`,
      ).toBe(true);
      // missing resolvedByUserId => fail
      expect(
        EnrichmentSuggestionSchema.safeParse({
          ...baseTagSuggestion,
          status,
          resolvedByUserId: null,
          resolvedAt: humanResolved.resolvedAt,
        }).success,
        `status '${status}' without resolver should fail`,
      ).toBe(false);
    }
  });

  it("superseded requires resolvedAt but resolvedByUserId may be null (system supersession)", () => {
    // System supersession: resolver null, time present
    expect(
      EnrichmentSuggestionSchema.safeParse({
        ...baseTagSuggestion,
        status: "superseded",
        resolvedByUserId: null,
        resolvedAt: "2026-09-13T00:00:00.000Z",
      }).success,
    ).toBe(true);

    // User-driven supersession: both present
    expect(
      EnrichmentSuggestionSchema.safeParse({
        ...baseTagSuggestion,
        status: "superseded",
        resolvedByUserId: ids.userId,
        resolvedAt: "2026-09-13T00:00:00.000Z",
      }).success,
    ).toBe(true);

    // Missing resolvedAt => fail even for superseded
    expect(
      EnrichmentSuggestionSchema.safeParse({
        ...baseTagSuggestion,
        status: "superseded",
        resolvedByUserId: null,
        resolvedAt: null,
      }).success,
    ).toBe(false);
  });

  it("pending must have null resolvedByUserId and resolvedAt", () => {
    expect(
      EnrichmentSuggestionSchema.safeParse({
        ...baseTagSuggestion,
        resolvedByUserId: ids.userId,
      }).success,
    ).toBe(false);
    expect(
      EnrichmentSuggestionSchema.safeParse({
        ...baseTagSuggestion,
        resolvedAt: "2026-09-13T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("candidate XOR: tag suggestion needs tagId non-null, others null", () => {
    // spending_category suggestion
    const spendingSuggestion = {
      ...baseTagSuggestion,
      kind: "spending_category" as const,
      tagId: null,
      spendingCategoryId: ids.categoryId,
    };
    expect(EnrichmentSuggestionSchema.safeParse(spendingSuggestion).success).toBe(true);
    // wrong: tag kind with spendingCategoryId set
    expect(
      EnrichmentSuggestionSchema.safeParse({ ...baseTagSuggestion, spendingCategoryId: ids.categoryId }).success,
    ).toBe(false);
  });

  it("tax_category suggestion requires business scope and full snapshot including businessTaxProfileVersion", () => {
    const taxSuggestion = {
      ...baseTagSuggestion,
      personalProfileId: null,
      businessId: ids.businessId,
      kind: "tax_category" as const,
      tagId: null,
      spendingCategoryId: null,
      taxCategoryDefinitionId: ids.taxCategoryId,
      businessTaxProfileId: ids.taxProfileId,
      businessTaxProfileVersion: 3,
      taxonomyVersionId: ids.taxonomyVersionId,
      taxYear: 2025,
    };
    expect(EnrichmentSuggestionSchema.safeParse(taxSuggestion).success).toBe(true);
    // missing taxYear => fail
    expect(
      EnrichmentSuggestionSchema.safeParse({ ...taxSuggestion, taxYear: null }).success,
    ).toBe(false);
    // missing businessTaxProfileId => fail
    expect(
      EnrichmentSuggestionSchema.safeParse({ ...taxSuggestion, businessTaxProfileId: null }).success,
    ).toBe(false);
    // missing businessTaxProfileVersion => fail
    expect(
      EnrichmentSuggestionSchema.safeParse({ ...taxSuggestion, businessTaxProfileVersion: null }).success,
    ).toBe(false);
    // version 0 => fail
    expect(
      EnrichmentSuggestionSchema.safeParse({ ...taxSuggestion, businessTaxProfileVersion: 0 }).success,
    ).toBe(false);
  });

  it("non-tax suggestion must have null tax snapshot fields", () => {
    expect(
      EnrichmentSuggestionSchema.safeParse({
        ...baseTagSuggestion,
        businessTaxProfileId: ids.taxProfileId,
      }).success,
    ).toBe(false);
    expect(
      EnrichmentSuggestionSchema.safeParse({
        ...baseTagSuggestion,
        businessTaxProfileVersion: 1,
      }).success,
    ).toBe(false);
  });

  it("kind enum: tag | spending_category | tax_category", () => {
    expect(EnrichmentSuggestionKindSchema.parse("tag")).toBe("tag");
    expect(EnrichmentSuggestionKindSchema.parse("spending_category")).toBe("spending_category");
    expect(EnrichmentSuggestionKindSchema.parse("tax_category")).toBe("tax_category");
    expect(EnrichmentSuggestionKindSchema.safeParse("other").success).toBe(false);
  });

  it("status enum: pending | accepted | rejected | superseded", () => {
    for (const status of ["pending", "accepted", "rejected", "superseded"] as const) {
      expect(EnrichmentSuggestionStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(EnrichmentSuggestionStatusSchema.safeParse("deleted").success).toBe(false);
  });

  it("accepts EnrichmentSuggestionListSchema", () => {
    expect(
      EnrichmentSuggestionListSchema.safeParse({ items: [baseTagSuggestion], nextCursor: null }).success,
    ).toBe(true);
  });

  it("rejects extra fields (strictObject)", () => {
    expect(EnrichmentSuggestionSchema.safeParse({ ...baseTagSuggestion, extra: true }).success).toBe(false);
  });
});

// ============================================================
// EnrichmentEvidence bounded structure
// ============================================================
describe("EnrichmentEvidenceSchema – bounded aggregate facts", () => {
  it("accepts valid bounded evidence with string/number/boolean values", () => {
    expect(
      EnrichmentEvidenceSchema.safeParse({
        matchedCount: 4,
        totalCount: 5,
        leadingMerchant: "Starbucks",
        isWeekend: false,
      }).success,
    ).toBe(true);
  });

  it("accepts array values bounded to 50 elements", () => {
    expect(
      EnrichmentEvidenceSchema.safeParse({
        categoryIds: Array.from({ length: 50 }, (_, i) => `id-${i}`),
      }).success,
    ).toBe(true);
  });

  it("rejects array values exceeding 50 elements", () => {
    expect(
      EnrichmentEvidenceSchema.safeParse({
        categoryIds: Array.from({ length: 51 }, (_, i) => `id-${i}`),
      }).success,
    ).toBe(false);
  });

  it("rejects string values exceeding 500 characters", () => {
    expect(
      EnrichmentEvidenceSchema.safeParse({
        longValue: "x".repeat(501),
      }).success,
    ).toBe(false);
  });

  it("rejects serialized evidence exceeding 8192 bytes", () => {
    // Build a payload that exceeds 8KB when JSON-serialized
    const bigEvidence: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      bigEvidence[`key${i}`] = "x".repeat(450);
    }
    expect(EnrichmentEvidenceSchema.safeParse(bigEvidence).success).toBe(false);
  });

  it("accepts null values in evidence", () => {
    expect(EnrichmentEvidenceSchema.safeParse({ merchant: null }).success).toBe(true);
  });
});

// ============================================================
// Suggestion action schemas
// ============================================================
describe("Suggestion action schemas", () => {
  it("SuggestionResolveRequestSchema requires expectedSuggestionVersion, expectedExpenseVersion, idempotencyKey", () => {
    expect(
      SuggestionResolveRequestSchema.safeParse({
        action: "accepted",
        expectedSuggestionVersion: 1,
        expectedExpenseVersion: 2,
        idempotencyKey: "resolve-001",
      }).success,
    ).toBe(true);
    // missing expectedExpenseVersion => fail
    expect(
      SuggestionResolveRequestSchema.safeParse({
        action: "accepted",
        expectedSuggestionVersion: 1,
        idempotencyKey: "resolve-001",
      }).success,
    ).toBe(false);
    // missing idempotencyKey => fail
    expect(
      SuggestionResolveRequestSchema.safeParse({
        action: "accepted",
        expectedSuggestionVersion: 1,
        expectedExpenseVersion: 2,
      }).success,
    ).toBe(false);
  });

  it("SuggestionResolveRequestSchema rejects pending as action", () => {
    expect(
      SuggestionResolveRequestSchema.safeParse({
        action: "pending",
        expectedSuggestionVersion: 1,
        expectedExpenseVersion: 1,
        idempotencyKey: "resolve-001",
      }).success,
    ).toBe(false);
  });

  it("tax_category resolve accepts optional taxAcceptance fields", () => {
    expect(
      SuggestionResolveRequestSchema.safeParse({
        action: "accepted",
        expectedSuggestionVersion: 1,
        expectedExpenseVersion: 2,
        idempotencyKey: "resolve-001",
        taxAcceptance: {
          businessTaxProfileId: ids.taxProfileId,
          deductiblePercent: "75.00",
        },
      }).success,
    ).toBe(true);
  });

  it("SuggestionResolveResponseSchema", () => {
    expect(
      SuggestionResolveResponseSchema.safeParse({
        suggestionId: ids.suggestionId,
        status: "accepted",
        version: 2,
      }).success,
    ).toBe(true);
  });

  it("SuggestionRerunRequestSchema requires expenseId and kinds (non-empty)", () => {
    expect(
      SuggestionRerunRequestSchema.safeParse({
        expenseId: ids.expenseId,
        kinds: ["tag", "spending_category"],
      }).success,
    ).toBe(true);
    // empty kinds => fail
    expect(
      SuggestionRerunRequestSchema.safeParse({
        expenseId: ids.expenseId,
        kinds: [],
      }).success,
    ).toBe(false);
  });
});
