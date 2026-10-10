import { describe, expect, it, vi } from "vitest";
import { createReceiptExtractor } from "../src/providers/receipt-extractor.js";

const result = { schemaVersion: 1 as const, merchant: "M", amount: "1.00", currency: "USD", incurredOn: "2026-01-01", confidence: 1 };
const data = Uint8Array.from([1, 2, 3]);

describe("createReceiptExtractor", () => {
  it("dispatches openai routes to the OpenAI extractor with the route", async () => {
    const openai = vi.fn(async () => result);
    const fake = vi.fn(() => result);
    const route = { providerKind: "openai", providerModelId: "gpt-5.4" };
    await createReceiptExtractor({ openai, fake })(data, route);
    expect(openai).toHaveBeenCalledWith(data, route);
    expect(fake).not.toHaveBeenCalled();
  });
  it("uses the fake only for fake routes and warns", async () => {
    const warn = vi.fn();
    const fake = vi.fn(() => result);
    await createReceiptExtractor({ openai: vi.fn(), fake, warn })(data, { providerKind: "fake", providerModelId: "fake-ocr-v1" });
    expect(fake).toHaveBeenCalledWith(data);
    expect(warn).toHaveBeenCalledOnce();
  });
  it("rejects other providers non-retryably", () => {
    expect(() => createReceiptExtractor({ openai: vi.fn(), fake: vi.fn() })(data, { providerKind: "anthropic", providerModelId: "x" }))
      .toThrowError(expect.objectContaining({ nonRetryable: true, type: "OcrUnsupportedProvider" }));
  });
  it("never falls back to the fake when the OpenAI extractor fails", async () => {
    const fake = vi.fn(() => result);
    const openai = vi.fn(async () => { throw new Error("all keys failed"); });
    await expect(createReceiptExtractor({ openai, fake })(data, { providerKind: "openai", providerModelId: "m" })).rejects.toThrow("all keys failed");
    expect(fake).not.toHaveBeenCalled();
  });
});
