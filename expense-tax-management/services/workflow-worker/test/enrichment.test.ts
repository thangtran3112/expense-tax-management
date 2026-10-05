import { ExpenseEnrichmentInputV1Schema } from "@expense-tax/contracts";
import { expect, it } from "vitest";

import { evaluateEnrichment } from "../src/activities/enrichment.js";

const CAT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TAX = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const input = ExpenseEnrichmentInputV1Schema.parse({
  schemaVersion: 1,
  jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  expenseId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  expenseVersion: 3,
  normalizedMerchant: "starbucks",
  incurredOn: "2026-09-19",
  spendingCategoryId: CAT,
  rulesVersion: 1,
  eligibleTagKeys: ["merchant:starbucks", "timing:weekend", `category:${CAT}`, "food:coffee"],
  eligibleSpendingCategoryIds: [CAT],
  eligibleTaxSnapshot: {
    businessTaxProfileId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    businessTaxProfileVersion: 1,
    taxonomyVersionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    taxYear: 2026,
    activeTaxCategoryIds: [TAX],
  },
  history: {
    exampleCount: 4,
    candidateTagKeys: [{ key: "food:coffee", count: 4 }],
    candidateSpendingCategoryIds: [{ id: CAT, count: 4 }],
    candidateTaxCategoryIds: [{ id: TAX, count: 4 }],
  },
});

it("matches the Python enrichment fixture including tag order and evidence hashes", () => {
  expect(evaluateEnrichment(input)).toEqual({
    schemaVersion: 1,
    rulesVersion: 1,
    outcome: "applied",
    ruleTagKeys: ["merchant:starbucks", "timing:weekend", `category:${CAT}`],
    suggestions: [
      { kind: "tag", source: "historical", tagKey: "food:coffee", confidence: 1,
        aggregateCounts: { exampleCount: 4, matchCount: 4 }, evidenceHash: "d162d4c129d50124f42b838fb94612ad09cfd1dc10a753a99b7594a77ace15cc" },
      { kind: "spending_category", source: "historical", spendingCategoryId: CAT, confidence: 1,
        aggregateCounts: { exampleCount: 4, matchCount: 4 }, evidenceHash: "e19a83016b43e4c2d7126f1a25a28080d4db52bb77c4ec82d3688f6498befa15" },
      { kind: "tax_category", source: "historical", taxCategoryDefinitionId: TAX, confidence: 1,
        businessTaxProfileId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", businessTaxProfileVersion: 1,
        taxonomyVersionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", taxYear: 2026, expenseVersion: 3,
        aggregateCounts: { exampleCount: 4, matchCount: 4 }, evidenceHash: "6bd7b2fab03d8634beaf8f1ea1846c9eeefe68bbe55eb7ac74ad6094e7ccd25a" },
    ],
  });
});

it("rejects tied leaders and suppresses tax suggestions for Personal expenses", () => {
  const personal = ExpenseEnrichmentInputV1Schema.parse({
    ...input,
    eligibleTaxSnapshot: null,
    history: {
      ...input.history,
      candidateTagKeys: [{ key: "food:coffee", count: 4 }, { key: "timing:weekend", count: 4 }],
    },
  });
  expect(evaluateEnrichment(personal).suggestions).toEqual([
    expect.objectContaining({ kind: "spending_category" }),
  ]);
});

it.each([
  { examples: 2, matches: 2, suggested: false },
  { examples: 4, matches: 3, suggested: false },
  { examples: 5, matches: 4, suggested: true },
])("uses the Python 3-example minimum and inclusive 80% threshold ($matches/$examples)", ({ examples, matches, suggested }) => {
  const candidate = ExpenseEnrichmentInputV1Schema.parse({
    ...input,
    eligibleTaxSnapshot: null,
    history: {
      exampleCount: examples,
      candidateTagKeys: [{ key: "food:coffee", count: matches }],
      candidateSpendingCategoryIds: [],
      candidateTaxCategoryIds: [],
    },
  });
  expect(evaluateEnrichment(candidate).suggestions.some((item) => item.kind === "tag")).toBe(suggested);
});

it("matches Python evidence hashes for validated non-ASCII tag keys", () => {
  const candidate = ExpenseEnrichmentInputV1Schema.parse({
    ...input,
    eligibleTagKeys: ["café"],
    eligibleSpendingCategoryIds: [],
    eligibleTaxSnapshot: null,
    history: {
      exampleCount: 4,
      candidateTagKeys: [{ key: "café", count: 4 }],
      candidateSpendingCategoryIds: [],
      candidateTaxCategoryIds: [],
    },
  });
  expect(evaluateEnrichment(candidate).suggestions[0]?.evidenceHash).toBe(
    "e7b09a5ba17085375afbd2e21aa646850995b3722d1c5768caa6a581421db1d4",
  );
});
