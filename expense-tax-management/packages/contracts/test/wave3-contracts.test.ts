import { describe, expect, it } from "vitest";

import {
  BusinessTaxProfileCreateRequestSchema,
  ExpenseCreateRequestSchema,
  ExpenseSchema,
  ExpenseTaxTreatmentCreateRequestSchema,
  LedgerCursorSchema,
  LedgerQuerySchema,
  TaxCategoryDefinitionSchema,
  TaxonomyVersionSchema,
} from "../src/index.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const BUSINESS_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const EXPENSE_ID = "44444444-4444-4444-8444-444444444444";
const TAXONOMY_ID = "55555555-5555-4555-8555-555555555555";
const DEFINITION_ID = "66666666-6666-4666-8666-666666666666";
const TAX_PROFILE_ID = "77777777-7777-4777-8777-777777777777";
const CATEGORY_ID = "88888888-8888-4888-8888-888888888888";
const TIMESTAMP = "2026-09-08T00:00:00.000Z";

describe("Phase 0J Wave 3 contracts", () => {
  it("requires exactly one Personal or business expense scope", () => {
    expect(
      ExpenseCreateRequestSchema.parse({
        personalProfileId: PROFILE_ID,
        merchant: "Market",
        amount: "12.50",
        currency: "USD",
        incurredOn: "2025-03-01",
      }).personalProfileId,
    ).toBe(PROFILE_ID);
    expect(
      ExpenseCreateRequestSchema.parse({
        businessId: BUSINESS_ID,
        projectId: CATEGORY_ID,
        merchant: "Supplier",
        amount: "12.50",
        currency: "USD",
        incurredOn: "2025-03-01",
      }).businessId,
    ).toBe(BUSINESS_ID);
    expect(
      ExpenseCreateRequestSchema.safeParse({
        merchant: "Unscoped",
        amount: "12.50",
        currency: "USD",
        incurredOn: "2025-03-01",
      }).success,
    ).toBe(false);
    expect(
      ExpenseCreateRequestSchema.safeParse({
        personalProfileId: PROFILE_ID,
        businessId: BUSINESS_ID,
        merchant: "Ambiguous",
        amount: "12.50",
        currency: "USD",
        incurredOn: "2025-03-01",
      }).success,
    ).toBe(false);
    expect(
      ExpenseCreateRequestSchema.safeParse({
        personalProfileId: PROFILE_ID,
        projectId: CATEGORY_ID,
        merchant: "Personal Project",
        amount: "12.50",
        currency: "USD",
        incurredOn: "2025-03-01",
      }).success,
    ).toBe(false);
  });

  it("validates expense money, dates, and tax-year response", () => {
    expect(
      ExpenseSchema.parse({
        id: EXPENSE_ID,
        tenantId: TENANT_ID,
        createdByUserId: PROFILE_ID,
        personalProfileId: null,
        businessId: BUSINESS_ID,
        projectId: CATEGORY_ID,
        spendingCategoryId: CATEGORY_ID,
        merchant: "Supplier",
        description: null,
        amount: "12.50",
        currency: "USD",
        incurredOn: "2025-03-01",
        taxYear: 2025,
        source: "manual",
        mailboxProvenance: null,
        status: "ready",
        version: 1,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      }).taxYear,
    ).toBe(2025);
    expect(
      ExpenseCreateRequestSchema.safeParse({
        businessId: BUSINESS_ID,
        merchant: "Supplier",
        amount: "0.00",
        currency: "usd",
        incurredOn: "2025-03-01",
      }).success,
    ).toBe(false);
  });

  it("accepts immutable taxonomy metadata and Schedule C profile input", () => {
    expect(
      TaxonomyVersionSchema.parse({
        id: TAXONOMY_ID,
        jurisdictionCode: "US-FEDERAL",
        taxYear: 2025,
        code: "schedule-c-2025",
        name: "2025 Schedule C",
        status: "active",
        sourceUrl: "https://www.irs.gov/forms-pubs/about-schedule-c-form-1040",
        sourceRevision: "2025-final",
        sourceChecksum: "a".repeat(64),
        createdAt: TIMESTAMP,
      }).code,
    ).toBe("schedule-c-2025");
    expect(
      TaxCategoryDefinitionSchema.parse({
        id: DEFINITION_ID,
        taxonomyVersionId: TAXONOMY_ID,
        code: "advertising",
        name: "Advertising",
        description: null,
        officialForm: "Schedule C",
        officialLine: "8",
        status: "active",
        sortOrder: 1,
      }).officialLine,
    ).toBe("8");
    expect(
      BusinessTaxProfileCreateRequestSchema.parse({
        taxYear: 2025,
        accountingMethod: "cash",
      }),
    ).toEqual({ taxYear: 2025, accountingMethod: "cash" });
  });

  it("validates treatment percentages and business-only treatment fields", () => {
    expect(
      ExpenseTaxTreatmentCreateRequestSchema.parse({
        businessTaxProfileId: TAX_PROFILE_ID,
        taxonomyVersionId: TAXONOMY_ID,
        taxCategoryDefinitionId: DEFINITION_ID,
        deductiblePercent: "75.00",
        reviewStatus: "reviewed",
        note: null,
      }).deductiblePercent,
    ).toBe("75.00");
    expect(
      ExpenseTaxTreatmentCreateRequestSchema.safeParse({
        businessTaxProfileId: TAX_PROFILE_ID,
        taxonomyVersionId: TAXONOMY_ID,
        taxCategoryDefinitionId: DEFINITION_ID,
        deductiblePercent: "100.01",
        reviewStatus: "reviewed",
      }).success,
    ).toBe(false);
  });

  it("validates exact ledger filters and opaque cursors", () => {
    expect(
      LedgerQuerySchema.parse({
        incurredFrom: "2025-01-01",
        incurredTo: "2025-12-31",
        amountMin: "1.00",
        amountMax: "100.00",
        status: "ready",
        sort: "amount",
        direction: "desc",
        limit: "25",
        cursor: "eyJ2IjoxfQ",
      }).limit,
    ).toBe(25);
    expect(LedgerCursorSchema.safeParse("").success).toBe(false);
    expect(
      LedgerQuerySchema.safeParse({ limit: "101", keyword: "market" }).success,
    ).toBe(false);
    expect(
      LedgerQuerySchema.safeParse({ incurredFrom: "2025-12-31", incurredTo: "2025-01-01" }).success,
    ).toBe(false);
  });
});
