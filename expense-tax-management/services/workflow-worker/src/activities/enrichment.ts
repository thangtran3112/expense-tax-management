import { createHash } from "node:crypto";

import {
  ExpenseEnrichmentResultV1Schema,
  type EnrichmentSuggestionResult,
  type ExpenseEnrichmentInputV1,
  type ExpenseEnrichmentResultV1,
} from "@expense-tax/contracts";

function evidenceHash(kind: string, candidate: string, exampleCount: number, matchCount: number): string {
  return createHash("sha256")
    .update(JSON.stringify({ candidate, exampleCount, kind, matchCount }).replace(
      /[\u0080-\uffff]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ))
    .digest("hex");
}

function leading<T>(candidates: readonly { candidate: T; count: number }[], examples: number) {
  if (examples < 3 || candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => b.count - a.count);
  const first = sorted[0];
  if (!first || first.count / examples < 0.8 || sorted[1]?.count === first.count) return null;
  return first;
}

export function evaluateEnrichment(input: ExpenseEnrichmentInputV1): ExpenseEnrichmentResultV1 {
  const eligibleTags = new Set(input.eligibleTagKeys);
  const rules: string[] = [];
  if (input.normalizedMerchant !== null) {
    const merchant = `merchant:${input.normalizedMerchant}`;
    if (eligibleTags.has(merchant)) rules.push(merchant);
  }
  if ([0, 6].includes(new Date(`${input.incurredOn}T00:00:00.000Z`).getUTCDay()) && eligibleTags.has("timing:weekend")) {
    rules.push("timing:weekend");
  }
  if (input.spendingCategoryId !== null) {
    const category = `category:${input.spendingCategoryId}`;
    if (eligibleTags.has(category)) rules.push(category);
  }

  const { history } = input;
  const examples = history.exampleCount;
  const suggestions: EnrichmentSuggestionResult[] = [];
  const tag = leading(
    history.candidateTagKeys.filter((item) => eligibleTags.has(item.key)).map((item) => ({ candidate: item.key, count: item.count })),
    examples,
  );
  if (tag) suggestions.push({
    kind: "tag", source: "historical", tagKey: tag.candidate,
    confidence: tag.count / examples,
    aggregateCounts: { exampleCount: examples, matchCount: tag.count },
    evidenceHash: evidenceHash("tag", tag.candidate, examples, tag.count),
  });

  const eligibleCategories = new Set(input.eligibleSpendingCategoryIds);
  const category = leading(
    history.candidateSpendingCategoryIds.filter((item) => eligibleCategories.has(item.id)).map((item) => ({ candidate: item.id, count: item.count })),
    examples,
  );
  if (category) suggestions.push({
    kind: "spending_category", source: "historical", spendingCategoryId: category.candidate,
    confidence: category.count / examples,
    aggregateCounts: { exampleCount: examples, matchCount: category.count },
    evidenceHash: evidenceHash("spending_category", category.candidate, examples, category.count),
  });

  const snapshot = input.eligibleTaxSnapshot;
  if (snapshot !== null) {
    const eligibleTaxes = new Set(snapshot.activeTaxCategoryIds);
    const tax = leading(
      history.candidateTaxCategoryIds.filter((item) => eligibleTaxes.has(item.id)).map((item) => ({ candidate: item.id, count: item.count })),
      examples,
    );
    if (tax) suggestions.push({
      kind: "tax_category", source: "historical", taxCategoryDefinitionId: tax.candidate,
      businessTaxProfileId: snapshot.businessTaxProfileId,
      businessTaxProfileVersion: snapshot.businessTaxProfileVersion,
      taxonomyVersionId: snapshot.taxonomyVersionId,
      taxYear: snapshot.taxYear,
      expenseVersion: input.expenseVersion,
      confidence: tax.count / examples,
      aggregateCounts: { exampleCount: examples, matchCount: tax.count },
      evidenceHash: evidenceHash("tax_category", tax.candidate, examples, tax.count),
    });
  }

  return ExpenseEnrichmentResultV1Schema.parse({
    schemaVersion: 1,
    rulesVersion: 1,
    outcome: "applied",
    ruleTagKeys: rules,
    suggestions,
  });
}
