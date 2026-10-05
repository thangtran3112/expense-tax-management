/**
 * Task 3: Canonical Worker Input and Result Contracts
 *
 * Strict security/serialization tests per brief:
 * - Reject unknown fields, raw receipt text/bytes, tenant/profile/business selectors
 * - Reject missing job/version/rules version/outcome
 * - Reject outcome outside applied|stale|skipped
 * - Reject confidence outside [0,1]
 * - Reject unbounded evidence
 * - Reject invalid candidate kind
 * - Reject tax suggestions outside the Business-required tuple
 * - Verify EXPENSE_ENRICHMENT_WORKFLOW_TYPE and EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION constants
 * - Verify ExpenseEnrichmentInputResponseV1Schema (evaluate/stale/skipped discriminated union)
 */
import { describe, expect, it } from "vitest";

import {
  EXPENSE_ENRICHMENT_WORKFLOW_TYPE,
  EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION,
} from "../src/internal/task-queues.js";
import {
  ExpenseEnrichmentInputV1Schema,
  ExpenseEnrichmentInputResponseV1Schema,
  type ExpenseEnrichmentInputV1,
} from "../src/internal/expense-enrichment-input-v1.js";
import {
  ExpenseEnrichmentResultV1Schema,
  type ExpenseEnrichmentResultV1,
} from "../src/internal/expense-enrichment-result-v1.js";

// ------------------------------------------------------------------ //
// Shared fixture IDs
// ------------------------------------------------------------------ //
const ids = {
  jobId: "00000000-0000-4000-8000-000000000001",
  expenseId: "00000000-0000-4000-8000-000000000002",
  tagId: "00000000-0000-4000-8000-000000000003",
  tagId2: "00000000-0000-4000-8000-000000000004",
  categoryId: "00000000-0000-4000-8000-000000000005",
  taxCategoryId: "00000000-0000-4000-8000-000000000006",
  taxProfileId: "00000000-0000-4000-8000-000000000007",
  taxonomyVersionId: "00000000-0000-4000-8000-000000000008",
};

// Minimal valid personal input (no business tax snapshot)
const validPersonalInput: ExpenseEnrichmentInputV1 = {
  schemaVersion: 1,
  jobId: ids.jobId,
  expenseId: ids.expenseId,
  expenseVersion: 1,
  normalizedMerchant: "starbucks",
  incurredOn: "2026-09-12",
  spendingCategoryId: null,
  rulesVersion: 1,
  eligibleTagKeys: ["merchant:starbucks", "timing:weekend"],
  eligibleSpendingCategoryIds: [ids.categoryId],
  eligibleTaxSnapshot: null,
  history: {
    exampleCount: 5,
    candidateTagKeys: [
      { key: "merchant:starbucks", count: 4 },
    ],
    candidateSpendingCategoryIds: [
      { id: ids.categoryId, count: 5 },
    ],
    candidateTaxCategoryIds: [],
  },
};

// Minimal valid business input (with tax snapshot)
const validBusinessInput: ExpenseEnrichmentInputV1 = {
  schemaVersion: 1,
  jobId: ids.jobId,
  expenseId: ids.expenseId,
  expenseVersion: 1,
  normalizedMerchant: "starbucks",
  incurredOn: "2026-09-12",
  spendingCategoryId: ids.categoryId,
  rulesVersion: 1,
  eligibleTagKeys: ["merchant:starbucks"],
  eligibleSpendingCategoryIds: [ids.categoryId],
  eligibleTaxSnapshot: {
    businessTaxProfileId: ids.taxProfileId,
    businessTaxProfileVersion: 2,
    taxonomyVersionId: ids.taxonomyVersionId,
    taxYear: 2025,
    activeTaxCategoryIds: [ids.taxCategoryId],
  },
  history: {
    exampleCount: 3,
    candidateTagKeys: [],
    candidateSpendingCategoryIds: [],
    candidateTaxCategoryIds: [
      { id: ids.taxCategoryId, count: 3 },
    ],
  },
};

// ------------------------------------------------------------------ //
// Constants
// ------------------------------------------------------------------ //
describe("Task-queue constants (exact literal)", () => {
  it("EXPENSE_ENRICHMENT_WORKFLOW_TYPE is exact literal string", () => {
    expect(EXPENSE_ENRICHMENT_WORKFLOW_TYPE).toBe("ExpenseEnrichmentWorkflow");
  });

  it("EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION is exact literal string", () => {
    expect(EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION).toBe("expense-enrichment-v1");
  });
});

// ------------------------------------------------------------------ //
// ExpenseEnrichmentInputV1Schema
// ------------------------------------------------------------------ //
describe("ExpenseEnrichmentInputV1Schema – valid inputs", () => {
  it("accepts valid personal input (null eligibleTaxSnapshot)", () => {
    expect(ExpenseEnrichmentInputV1Schema.safeParse(validPersonalInput).success).toBe(true);
  });

  it("accepts valid business input (with full tax snapshot)", () => {
    expect(ExpenseEnrichmentInputV1Schema.safeParse(validBusinessInput).success).toBe(true);
  });

  it("accepts null spendingCategoryId and null normalizedMerchant", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        normalizedMerchant: null,
        spendingCategoryId: null,
      }).success,
    ).toBe(true);
  });

  it("accepts empty history (no candidates)", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        history: {
          exampleCount: 0,
          candidateTagKeys: [],
          candidateSpendingCategoryIds: [],
          candidateTaxCategoryIds: [],
        },
      }).success,
    ).toBe(true);
  });
});

describe("ExpenseEnrichmentInputV1Schema – security rejections", () => {
  it("rejects extra fields (strictObject / no tenant/profile/business selectors)", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        tenantId: "00000000-0000-4000-8000-000000000099",
      }).success,
    ).toBe(false);
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        personalProfileId: "00000000-0000-4000-8000-000000000099",
      }).success,
    ).toBe(false);
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        businessId: "00000000-0000-4000-8000-000000000099",
      }).success,
    ).toBe(false);
  });

  it("rejects receipt text / raw content fields", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        receiptText: "raw text from ocr",
      }).success,
    ).toBe(false);
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        receiptBytes: "base64data",
      }).success,
    ).toBe(false);
  });

  it("rejects missing jobId", () => {
    const { jobId, ...rest } = validPersonalInput;
    void jobId;
    expect(ExpenseEnrichmentInputV1Schema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing expenseVersion", () => {
    const { expenseVersion, ...rest } = validPersonalInput;
    void expenseVersion;
    expect(ExpenseEnrichmentInputV1Schema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing rulesVersion", () => {
    const { rulesVersion, ...rest } = validPersonalInput;
    void rulesVersion;
    expect(ExpenseEnrichmentInputV1Schema.safeParse(rest).success).toBe(false);
  });

  it("rejects schemaVersion other than 1", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({ ...validPersonalInput, schemaVersion: 2 }).success,
    ).toBe(false);
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({ ...validPersonalInput, schemaVersion: 0 }).success,
    ).toBe(false);
  });

  it("rejects expenseVersion < 1", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({ ...validPersonalInput, expenseVersion: 0 }).success,
    ).toBe(false);
  });

  it("rejects rulesVersion < 1", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({ ...validPersonalInput, rulesVersion: 0 }).success,
    ).toBe(false);
  });

  it("rejects invalid incurredOn date format", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        incurredOn: "not-a-date",
      }).success,
    ).toBe(false);
  });

  it("rejects normalizedMerchant exceeding 100 characters", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        normalizedMerchant: "a".repeat(101),
      }).success,
    ).toBe(false);
  });

  it("rejects history with more than 50 examples (exampleCount > 50)", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        history: {
          exampleCount: 51,
          candidateTagKeys: [],
          candidateSpendingCategoryIds: [],
          candidateTaxCategoryIds: [],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects candidateTagKeys array exceeding 20 elements", () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      key: `merchant:tag${i}`,
      count: 1,
    }));
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        history: {
          exampleCount: 21,
          candidateTagKeys: tooMany,
          candidateSpendingCategoryIds: [],
          candidateTaxCategoryIds: [],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects candidateSpendingCategoryIds array exceeding 10 elements", () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => ({
      id: `00000000-0000-4000-8000-00000000${String(i).padStart(4, "0")}`,
      count: 1,
    }));
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        history: {
          exampleCount: 11,
          candidateTagKeys: [],
          candidateSpendingCategoryIds: tooMany,
          candidateTaxCategoryIds: [],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects candidateTaxCategoryIds array exceeding 10 elements", () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => ({
      id: `00000000-0000-4000-8000-00000000${String(i).padStart(4, "0")}`,
      count: 1,
    }));
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        history: {
          exampleCount: 11,
          candidateTagKeys: [],
          candidateSpendingCategoryIds: [],
          candidateTaxCategoryIds: tooMany,
        },
      }).success,
    ).toBe(false);
  });

  it("rejects eligibleTaxSnapshot with missing required fields (incomplete tuple)", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        eligibleTaxSnapshot: {
          businessTaxProfileId: ids.taxProfileId,
          businessTaxProfileVersion: 2,
          // missing taxonomyVersionId, taxYear, activeTaxCategoryIds
        },
      }).success,
    ).toBe(false);
  });

  it("rejects eligibleTaxSnapshot without businessTaxProfileVersion", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        eligibleTaxSnapshot: {
          businessTaxProfileId: ids.taxProfileId,
          // missing businessTaxProfileVersion
          taxonomyVersionId: ids.taxonomyVersionId,
          taxYear: 2025,
          activeTaxCategoryIds: [ids.taxCategoryId],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects extra fields in eligibleTaxSnapshot", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        eligibleTaxSnapshot: {
          businessTaxProfileId: ids.taxProfileId,
          businessTaxProfileVersion: 2,
          taxonomyVersionId: ids.taxonomyVersionId,
          taxYear: 2025,
          activeTaxCategoryIds: [ids.taxCategoryId],
          extra: "leaked",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects extra fields in history", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        history: {
          ...validPersonalInput.history,
          rawExpenses: ["leaked data"],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects extra fields in candidateTagKeys items", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        history: {
          exampleCount: 1,
          candidateTagKeys: [{ key: "merchant:test", count: 1, extra: "leaked" }],
          candidateSpendingCategoryIds: [],
          candidateTaxCategoryIds: [],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects candidateTagKeys with count < 1", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        history: {
          exampleCount: 1,
          candidateTagKeys: [{ key: "merchant:test", count: 0 }],
          candidateSpendingCategoryIds: [],
          candidateTaxCategoryIds: [],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects amount/tax description/percentage fields (not part of input contract)", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        amount: "123.45",
      }).success,
    ).toBe(false);
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        deductiblePercent: "75.00",
      }).success,
    ).toBe(false);
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        taxDescription: "Business meals",
      }).success,
    ).toBe(false);
  });
});

// ------------------------------------------------------------------ //
// ExpenseEnrichmentInputResponseV1Schema
// ------------------------------------------------------------------ //
describe("ExpenseEnrichmentInputResponseV1Schema – discriminated union", () => {
  it("accepts evaluate outcome with full input", () => {
    expect(
      ExpenseEnrichmentInputResponseV1Schema.safeParse({
        outcome: "evaluate",
        input: validPersonalInput,
      }).success,
    ).toBe(true);
  });

  it("accepts stale outcome (no input)", () => {
    expect(
      ExpenseEnrichmentInputResponseV1Schema.safeParse({ outcome: "stale" }).success,
    ).toBe(true);
  });

  it("accepts skipped outcome (no input)", () => {
    expect(
      ExpenseEnrichmentInputResponseV1Schema.safeParse({ outcome: "skipped" }).success,
    ).toBe(true);
  });

  it("rejects evaluate outcome without input", () => {
    expect(
      ExpenseEnrichmentInputResponseV1Schema.safeParse({ outcome: "evaluate" }).success,
    ).toBe(false);
  });

  it("rejects stale outcome with extra input field", () => {
    expect(
      ExpenseEnrichmentInputResponseV1Schema.safeParse({
        outcome: "stale",
        input: validPersonalInput,
      }).success,
    ).toBe(false);
  });

  it("rejects skipped outcome with extra input field", () => {
    expect(
      ExpenseEnrichmentInputResponseV1Schema.safeParse({
        outcome: "skipped",
        input: validPersonalInput,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown outcome", () => {
    expect(
      ExpenseEnrichmentInputResponseV1Schema.safeParse({ outcome: "applied" }).success,
    ).toBe(false);
  });
});

// ------------------------------------------------------------------ //
// ExpenseEnrichmentResultV1Schema
// ------------------------------------------------------------------ //

// Minimal valid result (applied with only rule tag keys, no suggestions)
const validAppliedResult: ExpenseEnrichmentResultV1 = {
  schemaVersion: 1,
  rulesVersion: 1,
  outcome: "applied",
  ruleTagKeys: ["merchant:starbucks"],
  suggestions: [],
};

// Valid result with all suggestion kinds
const validResultWithSuggestions: ExpenseEnrichmentResultV1 = {
  schemaVersion: 1,
  rulesVersion: 1,
  outcome: "applied",
  ruleTagKeys: [],
  suggestions: [
    {
      kind: "tag",
      source: "historical",
      tagKey: "merchant:starbucks",
      confidence: 0.9,
      evidenceHash: "a".repeat(64),
      aggregateCounts: { exampleCount: 5, matchCount: 4 },
    },
    {
      kind: "spending_category",
      source: "historical",
      spendingCategoryId: ids.categoryId,
      confidence: 0.85,
      evidenceHash: "b".repeat(64),
      aggregateCounts: { exampleCount: 5, matchCount: 5 },
    },
    {
      kind: "tax_category",
      source: "historical",
      taxCategoryDefinitionId: ids.taxCategoryId,
      businessTaxProfileId: ids.taxProfileId,
      businessTaxProfileVersion: 2,
      taxonomyVersionId: ids.taxonomyVersionId,
      taxYear: 2025,
      expenseVersion: 1,
      confidence: 0.9,
      evidenceHash: "c".repeat(64),
      aggregateCounts: { exampleCount: 3, matchCount: 3 },
    },
  ],
};

describe("ExpenseEnrichmentResultV1Schema – valid results", () => {
  it("accepts applied result with rule tag keys", () => {
    expect(ExpenseEnrichmentResultV1Schema.safeParse(validAppliedResult).success).toBe(true);
  });

  it("accepts applied result with all suggestion kinds", () => {
    expect(ExpenseEnrichmentResultV1Schema.safeParse(validResultWithSuggestions).success).toBe(true);
  });

  it("accepts stale outcome (no tags or suggestions required)", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "stale",
        ruleTagKeys: [],
        suggestions: [],
      }).success,
    ).toBe(true);
  });

  it("accepts skipped outcome", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "skipped",
        ruleTagKeys: [],
        suggestions: [],
      }).success,
    ).toBe(true);
  });
});

describe("ExpenseEnrichmentResultV1Schema – security rejections", () => {
  it("rejects unknown outcome values", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        outcome: "pending",
      }).success,
    ).toBe(false);
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        outcome: "failed",
      }).success,
    ).toBe(false);
  });

  it("rejects extra top-level fields (no tenant/scope/expense selectors)", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        tenantId: "00000000-0000-4000-8000-000000000099",
      }).success,
    ).toBe(false);
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        personalProfileId: "00000000-0000-4000-8000-000000000099",
      }).success,
    ).toBe(false);
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        expenseId: ids.expenseId,
      }).success,
    ).toBe(false);
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        businessId: "00000000-0000-4000-8000-000000000099",
      }).success,
    ).toBe(false);
  });

  it("rejects missing schemaVersion", () => {
    const { schemaVersion, ...rest } = validAppliedResult;
    void schemaVersion;
    expect(ExpenseEnrichmentResultV1Schema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing rulesVersion", () => {
    const { rulesVersion, ...rest } = validAppliedResult;
    void rulesVersion;
    expect(ExpenseEnrichmentResultV1Schema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing outcome", () => {
    const { outcome, ...rest } = validAppliedResult;
    void outcome;
    expect(ExpenseEnrichmentResultV1Schema.safeParse(rest).success).toBe(false);
  });

  it("rejects schemaVersion != 1", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({ ...validAppliedResult, schemaVersion: 2 }).success,
    ).toBe(false);
  });

  it("rejects rulesVersion < 1", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({ ...validAppliedResult, rulesVersion: 0 }).success,
    ).toBe(false);
  });

  it("rejects confidence outside [0,1] on tag suggestion", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "tag",
            tagKey: "merchant:test",
            confidence: 1.01,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 5, matchCount: 4 },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "tag",
            tagKey: "merchant:test",
            confidence: -0.01,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 5, matchCount: 4 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects invalid evidenceHash (not 64-char lowercase hex)", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "tag",
            tagKey: "merchant:test",
            confidence: 0.9,
            evidenceHash: "not-a-hash",
            aggregateCounts: { exampleCount: 5, matchCount: 4 },
          },
        ],
      }).success,
    ).toBe(false);
    // Uppercase hash should fail
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "tag",
            tagKey: "merchant:test",
            confidence: 0.9,
            evidenceHash: "A".repeat(64),
            aggregateCounts: { exampleCount: 5, matchCount: 4 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects invalid candidate kind in suggestions", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "unknown_kind",
            tagKey: "merchant:test",
            confidence: 0.9,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 5, matchCount: 4 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects tax suggestion missing required Business profile tuple", () => {
    // Missing businessTaxProfileId
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "tax_category",
            taxCategoryDefinitionId: ids.taxCategoryId,
            // missing businessTaxProfileId
            businessTaxProfileVersion: 2,
            taxonomyVersionId: ids.taxonomyVersionId,
            taxYear: 2025,
            expenseVersion: 1,
            confidence: 0.9,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 3, matchCount: 3 },
          },
        ],
      }).success,
    ).toBe(false);

    // Missing businessTaxProfileVersion
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "tax_category",
            taxCategoryDefinitionId: ids.taxCategoryId,
            businessTaxProfileId: ids.taxProfileId,
            // missing businessTaxProfileVersion
            taxonomyVersionId: ids.taxonomyVersionId,
            taxYear: 2025,
            expenseVersion: 1,
            confidence: 0.9,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 3, matchCount: 3 },
          },
        ],
      }).success,
    ).toBe(false);

    // Missing taxYear
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "tax_category",
            taxCategoryDefinitionId: ids.taxCategoryId,
            businessTaxProfileId: ids.taxProfileId,
            businessTaxProfileVersion: 2,
            taxonomyVersionId: ids.taxonomyVersionId,
            // missing taxYear
            expenseVersion: 1,
            confidence: 0.9,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 3, matchCount: 3 },
          },
        ],
      }).success,
    ).toBe(false);

    // Missing expenseVersion
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "tax_category",
            taxCategoryDefinitionId: ids.taxCategoryId,
            businessTaxProfileId: ids.taxProfileId,
            businessTaxProfileVersion: 2,
            taxonomyVersionId: ids.taxonomyVersionId,
            taxYear: 2025,
            // missing expenseVersion
            confidence: 0.9,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 3, matchCount: 3 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects tax suggestion with businessTaxProfileVersion < 1", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "tax_category",
            taxCategoryDefinitionId: ids.taxCategoryId,
            businessTaxProfileId: ids.taxProfileId,
            businessTaxProfileVersion: 0,
            taxonomyVersionId: ids.taxonomyVersionId,
            taxYear: 2025,
            expenseVersion: 1,
            confidence: 0.9,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 3, matchCount: 3 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects extra fields in suggestion items", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "tag",
            tagKey: "merchant:test",
            confidence: 0.9,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 5, matchCount: 4 },
            receiptText: "leaked receipt content",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects unbounded suggestions array (> 50)", () => {
    const tooMany = Array.from({ length: 51 }, () => ({
      kind: "tag" as const,
      tagKey: "merchant:test",
      confidence: 0.9,
      evidenceHash: "a".repeat(64),
      aggregateCounts: { exampleCount: 5, matchCount: 4 },
    }));
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: tooMany,
      }).success,
    ).toBe(false);
  });

  it("rejects ruleTagKeys exceeding 50 elements", () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `merchant:tag${i}`);
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        ruleTagKeys: tooMany,
      }).success,
    ).toBe(false);
  });

  it("rejects extra fields in aggregateCounts", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "tag",
            tagKey: "merchant:test",
            confidence: 0.9,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 5, matchCount: 4, rawText: "leaked" },
          },
        ],
      }).success,
    ).toBe(false);
  });
});

// ================================================================== //
// Task 3 correctness addendum: uniqueness + no-mutation invariants
// ================================================================== //

// ------------------------------------------------------------------ //
// Input: unique eligibleTagKeys
// ------------------------------------------------------------------ //
describe("ExpenseEnrichmentInputV1Schema – unique eligibleTagKeys", () => {
  it("accepts eligibleTagKeys with all distinct values", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        eligibleTagKeys: ["merchant:starbucks", "timing:weekend"],
      }).success,
    ).toBe(true);
  });

  it("rejects eligibleTagKeys with duplicate entries", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        eligibleTagKeys: ["merchant:starbucks", "merchant:starbucks"],
      }).success,
    ).toBe(false);
  });
});

// ------------------------------------------------------------------ //
// Input: unique eligibleSpendingCategoryIds
// ------------------------------------------------------------------ //
describe("ExpenseEnrichmentInputV1Schema – unique eligibleSpendingCategoryIds", () => {
  it("accepts eligibleSpendingCategoryIds with all distinct UUIDs", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        eligibleSpendingCategoryIds: [ids.categoryId, ids.taxCategoryId],
      }).success,
    ).toBe(true);
  });

  it("rejects eligibleSpendingCategoryIds with duplicate UUIDs", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        eligibleSpendingCategoryIds: [ids.categoryId, ids.categoryId],
      }).success,
    ).toBe(false);
  });
});

// ------------------------------------------------------------------ //
// Input: unique activeTaxCategoryIds within eligibleTaxSnapshot
// ------------------------------------------------------------------ //
describe("EligibleTaxSnapshot – unique activeTaxCategoryIds", () => {
  it("accepts activeTaxCategoryIds with all distinct UUIDs", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        eligibleTaxSnapshot: {
          businessTaxProfileId: ids.taxProfileId,
          businessTaxProfileVersion: 2,
          taxonomyVersionId: ids.taxonomyVersionId,
          taxYear: 2025,
          activeTaxCategoryIds: [ids.taxCategoryId, ids.categoryId],
        },
      }).success,
    ).toBe(true);
  });

  it("rejects activeTaxCategoryIds with duplicate UUIDs", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        eligibleTaxSnapshot: {
          businessTaxProfileId: ids.taxProfileId,
          businessTaxProfileVersion: 2,
          taxonomyVersionId: ids.taxonomyVersionId,
          taxYear: 2025,
          activeTaxCategoryIds: [ids.taxCategoryId, ids.taxCategoryId],
        },
      }).success,
    ).toBe(false);
  });
});

// ------------------------------------------------------------------ //
// Input: unique history candidate keys/IDs
// ------------------------------------------------------------------ //
describe("EnrichmentHistorySchema – unique candidate keys/IDs", () => {
  it("accepts candidateTagKeys with all distinct keys", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        history: {
          exampleCount: 5,
          candidateTagKeys: [
            { key: "merchant:starbucks", count: 3 },
            { key: "timing:weekend", count: 2 },
          ],
          candidateSpendingCategoryIds: [],
          candidateTaxCategoryIds: [],
        },
      }).success,
    ).toBe(true);
  });

  it("rejects candidateTagKeys with duplicate keys", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        history: {
          exampleCount: 5,
          candidateTagKeys: [
            { key: "merchant:starbucks", count: 3 },
            { key: "merchant:starbucks", count: 2 },
          ],
          candidateSpendingCategoryIds: [],
          candidateTaxCategoryIds: [],
        },
      }).success,
    ).toBe(false);
  });

  it("accepts candidateSpendingCategoryIds with all distinct IDs", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        history: {
          exampleCount: 5,
          candidateTagKeys: [],
          candidateSpendingCategoryIds: [
            { id: ids.categoryId, count: 5 },
            { id: ids.taxCategoryId, count: 3 },
          ],
          candidateTaxCategoryIds: [],
        },
      }).success,
    ).toBe(true);
  });

  it("rejects candidateSpendingCategoryIds with duplicate IDs", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        history: {
          exampleCount: 5,
          candidateTagKeys: [],
          candidateSpendingCategoryIds: [
            { id: ids.categoryId, count: 5 },
            { id: ids.categoryId, count: 3 },
          ],
          candidateTaxCategoryIds: [],
        },
      }).success,
    ).toBe(false);
  });

  it("accepts candidateTaxCategoryIds with all distinct IDs", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        history: {
          exampleCount: 5,
          candidateTagKeys: [],
          candidateSpendingCategoryIds: [],
          candidateTaxCategoryIds: [
            { id: ids.taxCategoryId, count: 4 },
            { id: ids.categoryId, count: 2 },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it("rejects candidateTaxCategoryIds with duplicate IDs", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        history: {
          exampleCount: 5,
          candidateTagKeys: [],
          candidateSpendingCategoryIds: [],
          candidateTaxCategoryIds: [
            { id: ids.taxCategoryId, count: 4 },
            { id: ids.taxCategoryId, count: 2 },
          ],
        },
      }).success,
    ).toBe(false);
  });
});

// ------------------------------------------------------------------ //
// Input: aggregate evidence counts bounded to 50 and matchCount <= exampleCount
// ------------------------------------------------------------------ //
describe("EnrichmentHistorySchema – aggregate evidence count bounds", () => {
  it("accepts exampleCount=50 (boundary)", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        history: {
          exampleCount: 50,
          candidateTagKeys: [{ key: "merchant:starbucks", count: 40 }],
          candidateSpendingCategoryIds: [],
          candidateTaxCategoryIds: [],
        },
      }).success,
    ).toBe(true);
  });

  it("rejects candidate count exceeding exampleCount", () => {
    // candidateTagKey count 6 > exampleCount 5
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        history: {
          exampleCount: 5,
          candidateTagKeys: [{ key: "merchant:starbucks", count: 6 }],
          candidateSpendingCategoryIds: [],
          candidateTaxCategoryIds: [],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects spendingCategory candidate count exceeding exampleCount", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        history: {
          exampleCount: 3,
          candidateTagKeys: [],
          candidateSpendingCategoryIds: [{ id: ids.categoryId, count: 4 }],
          candidateTaxCategoryIds: [],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects taxCategory candidate count exceeding exampleCount", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        history: {
          exampleCount: 2,
          candidateTagKeys: [],
          candidateSpendingCategoryIds: [],
          candidateTaxCategoryIds: [{ id: ids.taxCategoryId, count: 3 }],
        },
      }).success,
    ).toBe(false);
  });

  it("accepts candidate count equal to exampleCount (100% match)", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        history: {
          exampleCount: 5,
          candidateTagKeys: [{ key: "merchant:starbucks", count: 5 }],
          candidateSpendingCategoryIds: [],
          candidateTaxCategoryIds: [],
        },
      }).success,
    ).toBe(true);
  });
});

// ------------------------------------------------------------------ //
// Result: unique ruleTagKeys
// ------------------------------------------------------------------ //
describe("ExpenseEnrichmentResultV1Schema – unique ruleTagKeys", () => {
  it("accepts ruleTagKeys with all distinct values", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        ruleTagKeys: ["merchant:starbucks", "timing:weekend"],
      }).success,
    ).toBe(true);
  });

  it("rejects ruleTagKeys with duplicate entries", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        ruleTagKeys: ["merchant:starbucks", "merchant:starbucks"],
      }).success,
    ).toBe(false);
  });
});

// ------------------------------------------------------------------ //
// Result: unique suggestions by kind+candidate identity
// ------------------------------------------------------------------ //
describe("ExpenseEnrichmentResultV1Schema – unique suggestions by kind+candidate", () => {
  it("accepts suggestions with distinct kind+candidate combinations", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "tag",
            source: "historical",
            tagKey: "merchant:starbucks",
            confidence: 0.9,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 5, matchCount: 4 },
          },
          {
            kind: "tag",
            source: "historical",
            tagKey: "timing:weekend",
            confidence: 0.8,
            evidenceHash: "b".repeat(64),
            aggregateCounts: { exampleCount: 5, matchCount: 3 },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects duplicate tag suggestions (same kind+tagKey)", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "tag",
            tagKey: "merchant:starbucks",
            confidence: 0.9,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 5, matchCount: 4 },
          },
          {
            kind: "tag",
            tagKey: "merchant:starbucks",
            confidence: 0.7,
            evidenceHash: "b".repeat(64),
            aggregateCounts: { exampleCount: 5, matchCount: 3 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate spending_category suggestions (same kind+spendingCategoryId)", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "spending_category",
            spendingCategoryId: ids.categoryId,
            confidence: 0.9,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 5, matchCount: 5 },
          },
          {
            kind: "spending_category",
            spendingCategoryId: ids.categoryId,
            confidence: 0.8,
            evidenceHash: "b".repeat(64),
            aggregateCounts: { exampleCount: 5, matchCount: 4 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate tax_category suggestions (same kind+taxCategoryDefinitionId)", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "tax_category",
            taxCategoryDefinitionId: ids.taxCategoryId,
            businessTaxProfileId: ids.taxProfileId,
            businessTaxProfileVersion: 2,
            taxonomyVersionId: ids.taxonomyVersionId,
            taxYear: 2025,
            expenseVersion: 1,
            confidence: 0.9,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 3, matchCount: 3 },
          },
          {
            kind: "tax_category",
            taxCategoryDefinitionId: ids.taxCategoryId,
            businessTaxProfileId: ids.taxProfileId,
            businessTaxProfileVersion: 2,
            taxonomyVersionId: ids.taxonomyVersionId,
            taxYear: 2025,
            expenseVersion: 1,
            confidence: 0.8,
            evidenceHash: "b".repeat(64),
            aggregateCounts: { exampleCount: 3, matchCount: 2 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts tag and spending_category with same underlying ID string (different kinds)", () => {
    // tag.tagKey and spending_category are different kinds; no identity conflict
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "tag",
            source: "historical",
            tagKey: "merchant:starbucks",
            confidence: 0.9,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 5, matchCount: 4 },
          },
          {
            kind: "spending_category",
            source: "historical",
            spendingCategoryId: ids.categoryId,
            confidence: 0.85,
            evidenceHash: "b".repeat(64),
            aggregateCounts: { exampleCount: 5, matchCount: 5 },
          },
        ],
      }).success,
    ).toBe(true);
  });
});

// ------------------------------------------------------------------ //
// Result: aggregateCounts – matchCount <= exampleCount
// ------------------------------------------------------------------ //
describe("ExpenseEnrichmentResultV1Schema – aggregateCounts matchCount <= exampleCount", () => {
  it("accepts matchCount equal to exampleCount (100% match)", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "tag",
            source: "historical",
            tagKey: "merchant:starbucks",
            confidence: 1.0,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 5, matchCount: 5 },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("accepts matchCount=0 with exampleCount=0 (empty history)", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "tag",
            source: "historical",
            tagKey: "merchant:starbucks",
            confidence: 0.5,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 0, matchCount: 0 },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects matchCount exceeding exampleCount in tag suggestion", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "tag",
            tagKey: "merchant:starbucks",
            confidence: 0.9,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 4, matchCount: 5 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects matchCount exceeding exampleCount in spending_category suggestion", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "spending_category",
            spendingCategoryId: ids.categoryId,
            confidence: 0.9,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 3, matchCount: 4 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects matchCount exceeding exampleCount in tax_category suggestion", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "tax_category",
            taxCategoryDefinitionId: ids.taxCategoryId,
            businessTaxProfileId: ids.taxProfileId,
            businessTaxProfileVersion: 2,
            taxonomyVersionId: ids.taxonomyVersionId,
            taxYear: 2025,
            expenseVersion: 1,
            confidence: 0.9,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 2, matchCount: 3 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects aggregateCounts exampleCount exceeding 50", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        ...validAppliedResult,
        suggestions: [
          {
            kind: "tag",
            tagKey: "merchant:starbucks",
            confidence: 0.9,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 51, matchCount: 40 },
          },
        ],
      }).success,
    ).toBe(false);
  });
});

// ------------------------------------------------------------------ //
// Result: no-mutation semantics — stale|skipped must have empty arrays
// ------------------------------------------------------------------ //
describe("ExpenseEnrichmentResultV1Schema – no-mutation semantics for stale and skipped", () => {
  it("accepts stale with empty ruleTagKeys and suggestions", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "stale",
        ruleTagKeys: [],
        suggestions: [],
      }).success,
    ).toBe(true);
  });

  it("accepts skipped with empty ruleTagKeys and suggestions", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "skipped",
        ruleTagKeys: [],
        suggestions: [],
      }).success,
    ).toBe(true);
  });

  it("rejects stale with non-empty ruleTagKeys", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "stale",
        ruleTagKeys: ["merchant:starbucks"],
        suggestions: [],
      }).success,
    ).toBe(false);
  });

  it("rejects stale with non-empty suggestions", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "stale",
        ruleTagKeys: [],
        suggestions: [
          {
            kind: "tag",
            tagKey: "merchant:starbucks",
            confidence: 0.9,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 5, matchCount: 4 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects skipped with non-empty ruleTagKeys", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "skipped",
        ruleTagKeys: ["timing:weekend"],
        suggestions: [],
      }).success,
    ).toBe(false);
  });

  it("rejects skipped with non-empty suggestions", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "skipped",
        ruleTagKeys: [],
        suggestions: [
          {
            kind: "spending_category",
            spendingCategoryId: ids.categoryId,
            confidence: 0.85,
            evidenceHash: "b".repeat(64),
            aggregateCounts: { exampleCount: 5, matchCount: 5 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("applied outcome may have non-empty ruleTagKeys and suggestions", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "applied",
        ruleTagKeys: ["merchant:starbucks"],
        suggestions: [
          {
            kind: "tag",
            tagKey: "timing:weekend",
            source: "historical",
            confidence: 0.9,
            evidenceHash: "a".repeat(64),
            aggregateCounts: { exampleCount: 5, matchCount: 4 },
          },
        ],
      }).success,
    ).toBe(true);
  });
});

// ================================================================== //
// Fix round 1/5: source literal, VersionSchema rulesVersion,
//                empty eligible-tag-key negative test
// ================================================================== //

// ------------------------------------------------------------------ //
// Result: source:"historical" required on every suggestion variant
// ------------------------------------------------------------------ //
describe("ExpenseEnrichmentResultV1Schema – source:historical binding on suggestions", () => {
  const hashA = "a".repeat(64);

  it("accepts tag suggestion with source:historical", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "applied",
        ruleTagKeys: [],
        suggestions: [
          {
            kind: "tag",
            source: "historical",
            tagKey: "merchant:starbucks",
            confidence: 0.9,
            evidenceHash: hashA,
            aggregateCounts: { exampleCount: 5, matchCount: 4 },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects tag suggestion missing source field", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "applied",
        ruleTagKeys: [],
        suggestions: [
          {
            kind: "tag",
            tagKey: "merchant:starbucks",
            confidence: 0.9,
            evidenceHash: hashA,
            aggregateCounts: { exampleCount: 5, matchCount: 4 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects tag suggestion with source:ai (reserved, not emitted by Phase 3C v1)", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "applied",
        ruleTagKeys: [],
        suggestions: [
          {
            kind: "tag",
            source: "ai",
            tagKey: "merchant:starbucks",
            confidence: 0.9,
            evidenceHash: hashA,
            aggregateCounts: { exampleCount: 5, matchCount: 4 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects tag suggestion with unknown source value", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "applied",
        ruleTagKeys: [],
        suggestions: [
          {
            kind: "tag",
            source: "rule",
            tagKey: "merchant:starbucks",
            confidence: 0.9,
            evidenceHash: hashA,
            aggregateCounts: { exampleCount: 5, matchCount: 4 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("still rejects extra unknown fields on tag suggestion with valid source", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "applied",
        ruleTagKeys: [],
        suggestions: [
          {
            kind: "tag",
            source: "historical",
            tagKey: "merchant:starbucks",
            confidence: 0.9,
            evidenceHash: hashA,
            aggregateCounts: { exampleCount: 5, matchCount: 4 },
            extraField: "leaked",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts spending_category suggestion with source:historical", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "applied",
        ruleTagKeys: [],
        suggestions: [
          {
            kind: "spending_category",
            source: "historical",
            spendingCategoryId: ids.categoryId,
            confidence: 0.85,
            evidenceHash: hashA,
            aggregateCounts: { exampleCount: 5, matchCount: 5 },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects spending_category suggestion missing source field", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "applied",
        ruleTagKeys: [],
        suggestions: [
          {
            kind: "spending_category",
            spendingCategoryId: ids.categoryId,
            confidence: 0.85,
            evidenceHash: hashA,
            aggregateCounts: { exampleCount: 5, matchCount: 5 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects spending_category suggestion with source:ai", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "applied",
        ruleTagKeys: [],
        suggestions: [
          {
            kind: "spending_category",
            source: "ai",
            spendingCategoryId: ids.categoryId,
            confidence: 0.85,
            evidenceHash: hashA,
            aggregateCounts: { exampleCount: 5, matchCount: 5 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts tax_category suggestion with source:historical", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "applied",
        ruleTagKeys: [],
        suggestions: [
          {
            kind: "tax_category",
            source: "historical",
            taxCategoryDefinitionId: ids.taxCategoryId,
            businessTaxProfileId: ids.taxProfileId,
            businessTaxProfileVersion: 2,
            taxonomyVersionId: ids.taxonomyVersionId,
            taxYear: 2025,
            expenseVersion: 1,
            confidence: 0.9,
            evidenceHash: hashA,
            aggregateCounts: { exampleCount: 3, matchCount: 3 },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects tax_category suggestion missing source field", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "applied",
        ruleTagKeys: [],
        suggestions: [
          {
            kind: "tax_category",
            taxCategoryDefinitionId: ids.taxCategoryId,
            businessTaxProfileId: ids.taxProfileId,
            businessTaxProfileVersion: 2,
            taxonomyVersionId: ids.taxonomyVersionId,
            taxYear: 2025,
            expenseVersion: 1,
            confidence: 0.9,
            evidenceHash: hashA,
            aggregateCounts: { exampleCount: 3, matchCount: 3 },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects tax_category suggestion with source:ai", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "applied",
        ruleTagKeys: [],
        suggestions: [
          {
            kind: "tax_category",
            source: "ai",
            taxCategoryDefinitionId: ids.taxCategoryId,
            businessTaxProfileId: ids.taxProfileId,
            businessTaxProfileVersion: 2,
            taxonomyVersionId: ids.taxonomyVersionId,
            taxYear: 2025,
            expenseVersion: 1,
            confidence: 0.9,
            evidenceHash: hashA,
            aggregateCounts: { exampleCount: 3, matchCount: 3 },
          },
        ],
      }).success,
    ).toBe(false);
  });
});

// ------------------------------------------------------------------ //
// Result: rulesVersion uses VersionSchema (positive integer, not float)
// ------------------------------------------------------------------ //
describe("ExpenseEnrichmentResultV1Schema – rulesVersion uses VersionSchema", () => {
  it("accepts rulesVersion=1 (minimum positive integer)", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1,
        outcome: "applied",
        ruleTagKeys: [],
        suggestions: [],
      }).success,
    ).toBe(true);
  });

  it("rejects rulesVersion=0", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 0,
        outcome: "applied",
        ruleTagKeys: [],
        suggestions: [],
      }).success,
    ).toBe(false);
  });

  it("rejects rulesVersion negative", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: -1,
        outcome: "applied",
        ruleTagKeys: [],
        suggestions: [],
      }).success,
    ).toBe(false);
  });

  it("rejects non-integer rulesVersion (float)", () => {
    expect(
      ExpenseEnrichmentResultV1Schema.safeParse({
        schemaVersion: 1,
        rulesVersion: 1.5,
        outcome: "applied",
        ruleTagKeys: [],
        suggestions: [],
      }).success,
    ).toBe(false);
  });
});

// ------------------------------------------------------------------ //
// Input: empty string rejected in eligibleTagKeys
// ------------------------------------------------------------------ //
describe("ExpenseEnrichmentInputV1Schema – empty string rejected in eligibleTagKeys", () => {
  it("rejects eligibleTagKeys containing an empty string", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        eligibleTagKeys: ["merchant:starbucks", ""],
      }).success,
    ).toBe(false);
  });

  it("accepts eligibleTagKeys with all non-empty strings", () => {
    expect(
      ExpenseEnrichmentInputV1Schema.safeParse({
        ...validPersonalInput,
        eligibleTagKeys: ["merchant:starbucks", "timing:weekend"],
      }).success,
    ).toBe(true);
  });
});
