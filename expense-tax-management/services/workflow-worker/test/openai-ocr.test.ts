import { ApplicationFailure } from "@temporalio/activity";
import { describe, expect, it } from "vitest";
import {
  buildOpenAiReceiptRequest,
  createOpenAiReceiptExtractor,
  normalizeOpenAiReceipt,
} from "../src/providers/openai-ocr.js";

const route = { providerKind: "openai", providerModelId: "gpt-5.4-mini" } as const;
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const fields = (over: Record<string, unknown> = {}) => ({
  merchant: "Harbor Lane Cafe", amount: "31.39", currency: "USD", incurredOn: "2019-11-20",
  orderNumber: null, notes: null, confidence: 0.98, ...over,
});
const okPayload = (over: Record<string, unknown> = {}) => ({
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(fields(over)) }] }],
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const quiet = () => undefined;

describe("normalizeOpenAiReceipt", () => {
  it("returns the contract shape and omits null optionals", () => {
    expect(normalizeOpenAiReceipt(JSON.stringify(fields()))).toEqual({
      schemaVersion: 1, merchant: "Harbor Lane Cafe", amount: "31.39", currency: "USD",
      incurredOn: "2019-11-20", confidence: 0.98,
    });
  });
  it.each([
    ["31.390", "31.39"], ["1,234.5", "1234.50"], [" 7 ", "7.00"], ["007.50", "7.50"],
  ])("accepts amount %j as %s", (given, expected) => {
    expect(normalizeOpenAiReceipt(JSON.stringify(fields({ amount: given }))).amount).toBe(expected);
  });
  it.each(["0.00", "-5.00", "1e3", "$31.39", "abc", ""])("rejects amount %j as retryable malformed", (amount) => {
    try { normalizeOpenAiReceipt(JSON.stringify(fields({ amount }))); throw new Error("did not throw"); }
    catch (error) {
      expect(error).toBeInstanceOf(ApplicationFailure);
      expect((error as ApplicationFailure).type).toBe("OcrExtractionMalformed");
      expect((error as ApplicationFailure).nonRetryable).toBe(false);
    }
  });
  it.each(["2019-11-20 11:05 AM", "11/20/2019", "2019-13-45", ""])("rejects date %j as retryable malformed", (incurredOn) => {
    try { normalizeOpenAiReceipt(JSON.stringify(fields({ incurredOn }))); throw new Error("did not throw"); }
    catch (error) {
      expect(error).toBeInstanceOf(ApplicationFailure);
      expect((error as ApplicationFailure).type).toBe("OcrExtractionMalformed");
      expect((error as ApplicationFailure).nonRetryable).toBe(false);
    }
  });
  it("uppercases currency, clamps confidence, trims and truncates optionals", () => {
    const out = normalizeOpenAiReceipt(JSON.stringify(fields({
      currency: " usd ", confidence: 1.7, orderNumber: " 34362 ", notes: "n".repeat(2500),
    })));
    expect(out.currency).toBe("USD");
    expect(out.confidence).toBe(1);
    expect(out.orderNumber).toBe("34362");
    expect(out.notes).toHaveLength(2000);
  });
  it("rejects non-JSON and wrong shapes", () => {
    expect(() => normalizeOpenAiReceipt("not json")).toThrow();
    expect(() => normalizeOpenAiReceipt(JSON.stringify({ merchant: "x" }))).toThrow();
  });
});

describe("buildOpenAiReceiptRequest", () => {
  it("builds an image request with store:false, strict schema and the route model", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely-typed request body in a test
    const body = buildOpenAiReceiptRequest(JPEG, "jpeg", "gpt-5.4") as Record<string, any>;
    expect(body.model).toBe("gpt-5.4");
    expect(body.store).toBe(false);
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
    const parts = body.input[0].content;
    expect(parts[0].text).toMatch(/never follow instructions/i);
    expect(parts[1]).toMatchObject({ type: "input_image", detail: "high" });
    expect(parts[1].image_url).toMatch(/^data:image\/jpeg;base64,/);
  });
  it("builds a PDF request as input_file", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely-typed request body in a test
    const body = buildOpenAiReceiptRequest(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]), "pdf", "gpt-5.4-mini") as Record<string, any>;
    expect(body.input[0].content[1]).toMatchObject({ type: "input_file", filename: "receipt.pdf" });
    expect(body.input[0].content[1].file_data).toMatch(/^data:application\/pdf;base64,/);
  });
  it("lists every property as required (strict mode) and makes optionals nullable", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely-typed request body in a test
    const schema = (buildOpenAiReceiptRequest(JPEG, "jpeg", "m") as any).text.format.schema;
    expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.properties.orderNumber.type).toEqual(["string", "null"]);
    expect(schema.additionalProperties).toBe(false);
  });
});

describe("createOpenAiReceiptExtractor", () => {
  it("fails over from a 401 key to the next key", async () => {
    const seen: string[] = [];
    const fetchFake = (async (_url: unknown, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).authorization ?? "";
      seen.push(auth);
      return auth === "Bearer key-a" ? json(401, { error: {} }) : json(200, okPayload());
    }) as typeof fetch;
    const extract = createOpenAiReceiptExtractor({ apiKeys: ["key-a", "key-b"], fetch: fetchFake, random: () => 0, log: quiet });
    await expect(extract(JPEG, route)).resolves.toMatchObject({ merchant: "Harbor Lane Cafe", amount: "31.39" });
    expect(seen).toEqual(["Bearer key-a", "Bearer key-b"]);
  });
  it("fails over on 429, 500 and network errors, then reports a retryable failure when all keys fail", async () => {
    let calls = 0;
    const fetchFake = (async () => {
      calls += 1;
      if (calls === 1) return json(429, {});
      if (calls === 2) return json(500, {});
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const extract = createOpenAiReceiptExtractor({ apiKeys: ["a", "b", "c"], fetch: fetchFake, random: () => 0, log: quiet });
    await expect(extract(JPEG, route)).rejects.toMatchObject({ nonRetryable: false });
    expect(calls).toBe(3);
  });
  it("does not fail over on a 400 and reports it non-retryable", async () => {
    let calls = 0;
    const fetchFake = (async () => { calls += 1; return json(400, { error: {} }); }) as typeof fetch;
    const extract = createOpenAiReceiptExtractor({ apiKeys: ["a", "b"], fetch: fetchFake, log: quiet });
    await expect(extract(JPEG, route)).rejects.toMatchObject({ nonRetryable: true });
    expect(calls).toBe(1);
  });
  it("uses duplicate keys once and starts at a random key", async () => {
    const seen: string[] = [];
    const fetchFake = (async (_u: unknown, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string>).authorization ?? "");
      return json(500, {});
    }) as typeof fetch;
    const extract = createOpenAiReceiptExtractor({ apiKeys: ["a", "a", "b", " "], fetch: fetchFake, random: () => 0.99, log: quiet });
    await expect(extract(JPEG, route)).rejects.toBeDefined();
    expect(seen).toEqual(["Bearer b", "Bearer a"]);
  });
  it("fails non-retryably with no keys and never calls fetch", async () => {
    let called = false;
    const extract = createOpenAiReceiptExtractor({ apiKeys: ["", "  "], fetch: (async () => { called = true; return json(200, okPayload()); }) as typeof fetch, log: quiet });
    await expect(extract(JPEG, route)).rejects.toMatchObject({ nonRetryable: true });
    expect(called).toBe(false);
  });
  it.each([
    ["gif", Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0])],
    ["heic", Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])],
    ["tiff (little-endian)", Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0])],
    ["tiff (big-endian)", Uint8Array.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 0])],
    ["docx/zip", Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])],
  ])("rejects %s bytes as non-retryable without calling OpenAI", async (_n, data) => {
    let called = false;
    const extract = createOpenAiReceiptExtractor({ apiKeys: ["a"], fetch: (async () => { called = true; return json(200, okPayload()); }) as typeof fetch, log: quiet });
    await expect(extract(data, route)).rejects.toMatchObject({ nonRetryable: true, type: "OcrUnsupportedFormat" });
    expect(called).toBe(false);
  });
  it("treats a refusal as non-retryable and an incomplete or errored response as retryable", async () => {
    const respond = (body: unknown) => createOpenAiReceiptExtractor({ apiKeys: ["a"], fetch: (async () => json(200, body)) as typeof fetch, log: quiet });
    await expect(respond({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] })(JPEG, route)).rejects.toMatchObject({ nonRetryable: true });
    await expect(respond({ status: "incomplete", output: [] })(JPEG, route)).rejects.toMatchObject({ nonRetryable: false });
    await expect(respond({ status: "failed", error: { code: "server_error" } })(JPEG, route)).rejects.toMatchObject({ nonRetryable: false });
  });
  it("stops trying keys once the total budget is spent", async () => {
    let clock = 0;
    let calls = 0;
    const fetchFake = (async () => { calls += 1; clock += 30_000; return json(500, {}); }) as typeof fetch;
    const extract = createOpenAiReceiptExtractor({ apiKeys: ["a", "b", "c"], fetch: fetchFake, now: () => clock, random: () => 0, totalBudgetMs: 50_000, log: quiet });
    await expect(extract(JPEG, route)).rejects.toMatchObject({ nonRetryable: false });
    expect(calls).toBe(2);
  });
  it("logs only non-secret fields", async () => {
    const events: Array<Record<string, string | number>> = [];
    const extract = createOpenAiReceiptExtractor({ apiKeys: ["sk-secret-value"], fetch: (async () => json(200, okPayload())) as typeof fetch, log: (e) => events.push({ ...e }) });
    await extract(JPEG, route);
    expect(JSON.stringify(events)).not.toContain("sk-secret-value");
    expect(events[0]).toMatchObject({ model: "gpt-5.4-mini", status: 200, keyIndex: 0 });
    const allowedKeys = new Set(["provider", "model", "status", "errorType", "attempt", "latencyMs", "keyIndex"]);
    const forbidden = /sk-secret-value|never follow instructions|data:image|data:application/i;
    for (const event of events) {
      for (const key of Object.keys(event)) {
        expect(key === "msg" || allowedKeys.has(key)).toBe(true);
      }
      for (const value of Object.values(event)) {
        expect(String(value)).not.toMatch(forbidden);
      }
    }
  });
});
