import { expect, it } from "vitest";

import { extractFakeReceipt } from "../src/providers/fake-ocr.js";

it("matches the Python fake OCR result and rejects empty bytes", () => {
  expect(extractFakeReceipt(new Uint8Array([1]))).toEqual({
    schemaVersion: 1,
    merchant: "Fake OCR Merchant",
    amount: "12.34",
    currency: "USD",
    incurredOn: "2026-09-09",
    confidence: 1,
  });
  expect(() => extractFakeReceipt(new Uint8Array())).toThrow();
});
