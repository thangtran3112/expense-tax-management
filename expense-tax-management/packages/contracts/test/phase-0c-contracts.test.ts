import { describe, expect, it } from "vitest";

import {
  CreateOcrJobRequestSchema,
  EffectiveRouteResponseSchema,
  ExpenseSourceSchema,
  OcrExtractionResultV1Schema,
  OcrJobInputV1Schema,
  OcrModeKeySchema,
  OCR_EXTRACTION_RESULT_SCHEMA_VERSION,
  OCR_RECEIPT_WORKFLOW_TYPE,
} from "../src/index.js";

const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const FILE_ID = "33333333-3333-4333-8333-333333333333";
const MODEL_ID = "44444444-4444-4444-8444-444444444444";
const MODE_ID = "55555555-5555-4555-8555-555555555555";
const ROUTE_ID = "66666666-6666-4666-8666-666666666666";
const SHA =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("Phase 0C OCR contracts", () => {
  it("pins cross-language workflow/result identifiers", () => {
    expect(OCR_RECEIPT_WORKFLOW_TYPE).toBe("OcrReceiptWorkflow");
    expect(OCR_EXTRACTION_RESULT_SCHEMA_VERSION).toBe("ocr-extraction-v1");
  });

  it("restricts OCR modes to the three curated keys", () => {
    expect(OcrModeKeySchema.options).toEqual([
      "ocr_mode_fast",
      "ocr_mode_balanced",
      "ocr_mode_accurate",
    ]);
    expect(() =>
      CreateOcrJobRequestSchema.parse({ modeKey: "ocr_mode_turbo" }),
    ).toThrow();
  });

  it("parses a full extraction result and rejects unknown fields", () => {
    const extraction = OcrExtractionResultV1Schema.parse({
      schemaVersion: 1,
      merchant: "Corner Deli",
      amount: "12.34",
      currency: "USD",
      incurredOn: "2026-09-09",
      orderNumber: "ORDER-123",
      notes: "lunch",
      confidence: 0.9,
    });
    expect(extraction.amount).toBe("12.34");
    expect(extraction.orderNumber).toBe("ORDER-123");
    expect(() =>
      OcrExtractionResultV1Schema.parse({
        schemaVersion: 1,
        merchant: "Corner Deli",
        amount: "12.34",
        currency: "USD",
        incurredOn: "2026-09-09",
        confidence: 0.9,
        rawOcrText: "leaked provider internals must never appear here",
      }),
    ).toThrow();
  });

  it("requires merchant/amount/currency/date and bounds confidence", () => {
    for (const body of [
      { amount: "12.34", currency: "USD", incurredOn: "2026-09-09", confidence: 1 },
      {
        schemaVersion: 1,
        merchant: "",
        amount: "12.34",
        currency: "USD",
        incurredOn: "2026-09-09",
        confidence: 1,
      },
      {
        schemaVersion: 1,
        merchant: "Deli",
        amount: "12.34",
        currency: "usd",
        incurredOn: "2026-09-09",
        confidence: 1,
      },
      {
        schemaVersion: 1,
        merchant: "Deli",
        amount: "12.34",
        currency: "USD",
        incurredOn: "2026-09-09",
        confidence: 1.5,
      },
    ]) {
      expect(() => OcrExtractionResultV1Schema.parse(body)).toThrow();
    }
  });

  it("parses job-bound OCR input with an optional expected hash", () => {
    const input = OcrJobInputV1Schema.parse({
      schemaVersion: 1,
      fileId: FILE_ID,
      modeKey: "ocr_mode_balanced",
      expectedSha256: SHA,
      tenantId: TENANT_ID,
    });
    expect(input.modeKey).toBe("ocr_mode_balanced");
    expect(
      OcrJobInputV1Schema.parse({ ...input, expectedSha256: null }).expectedSha256,
    ).toBeNull();
    expect(() =>
      OcrJobInputV1Schema.parse({ ...input, expectedSha256: "not-a-hash" }),
    ).toThrow();
  });

  it("carries no secrets in the effective-route response", () => {
    const route = EffectiveRouteResponseSchema.parse({
      aiModeId: MODE_ID,
      routeVersionId: ROUTE_ID,
      routeVersionNumber: 1,
      aiModelId: MODEL_ID,
      providerKind: "fake",
      providerModelId: "fake-ocr-v1",
    });
    expect(route.providerKind).toBe("fake");
    expect("secretReference" in route).toBe(false);
    expect("secretValue" in route).toBe(false);
  });

  it("distinguishes OCR-created expenses from manual ones", () => {
    expect(ExpenseSourceSchema.options).toEqual([
      "manual",
      "ocr",
      "forwarded_email",
      "connected_mailbox",
    ]);
  });
});
