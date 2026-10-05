import type { OcrExtractionResultV1 } from "@expense-tax/contracts";

export function extractFakeReceipt(data: Uint8Array): OcrExtractionResultV1 {
  if (data.length === 0) throw new Error("refusing to extract from empty input");
  return {
    schemaVersion: 1,
    merchant: "Fake OCR Merchant",
    amount: "12.34",
    currency: "USD",
    incurredOn: "2026-09-09",
    confidence: 1,
  };
}
