/**
 * Phase 3D-C Task 2 — bounded, deterministic structured-receipt parser.
 *
 * Fully local: every input is a hand-written AsyncIterable<Buffer>
 * fixture. No HTTP, no DOM, no Docker. Hostile-input fixtures prove the
 * parser is safe against oversize/deep/slow input without ever executing
 * script content, fetching externally, or polluting a prototype.
 */
import { describe, expect, it } from "vitest";

import { parseStructuredReceipt } from "../src/structured-receipt.js";

const METADATA = {
  candidateId: "11111111-1111-4111-8111-111111111111",
  connectionId: "22222222-2222-4222-8222-222222222222",
  candidateVersion: 3,
};

async function* iterableOf(...chunks: string[]): AsyncIterable<Buffer> {
  for (const chunk of chunks) yield Buffer.from(chunk, "utf8");
}

function orderHtml(orderJson: unknown): string {
  return `<html><body><p>Thanks for your order</p><script type="application/ld+json">${JSON.stringify(orderJson)}</script></body></html>`;
}

const VALID_ORDER = {
  "@context": "https://schema.org",
  "@type": "Order",
  merchant: { "@type": "Organization", name: "Acme Hardware" },
  orderNumber: "A-1001",
  orderDate: "2026-09-01",
  priceCurrency: "USD",
  totalPrice: 42.5,
};

describe("parseStructuredReceipt — happy path", () => {
  it("extracts merchant/amount/currency/incurredOn/orderNumber from a valid Order JSON-LD block", async () => {
    const result = await parseStructuredReceipt(iterableOf(orderHtml(VALID_ORDER)), METADATA);

    expect(result).toMatchObject({
      schemaVersion: 1,
      candidateId: METADATA.candidateId,
      connectionId: METADATA.connectionId,
      candidateVersion: METADATA.candidateVersion,
      merchant: "Acme Hardware",
      amount: "42.5",
      currency: "USD",
      incurredOn: "2026-09-01",
      orderNumber: "A-1001",
      notes: null,
    });
    expect("evidence" in result && result.evidence).toContain("schema_type:Order");
    expect("idempotencyKey" in result && typeof result.idempotencyKey).toBe("string");
  });

  it("splits the HTML across multiple stream chunks and still parses it", async () => {
    const html = orderHtml(VALID_ORDER);
    const mid = Math.floor(html.length / 2);
    async function* chunked(): AsyncIterable<Buffer> {
      yield Buffer.from(html.slice(0, mid), "utf8");
      yield Buffer.from(html.slice(mid), "utf8");
    }
    const result = await parseStructuredReceipt(chunked(), METADATA);
    expect("merchant" in result && result.merchant).toBe("Acme Hardware");
  });

  it("finds a receipt node nested inside an @graph array", async () => {
    const graphDoc = { "@context": "https://schema.org", "@graph": [{ "@type": "Thing" }, VALID_ORDER] };
    const result = await parseStructuredReceipt(iterableOf(orderHtml(graphDoc)), METADATA);
    expect("merchant" in result && result.merchant).toBe("Acme Hardware");
  });
});

describe("parseStructuredReceipt — review/skipped outcomes", () => {
  it("returns skipped/STRUCTURED_RECEIPT_NOT_FOUND when no JSON-LD block exists", async () => {
    const result = await parseStructuredReceipt(iterableOf("<html><body>no structured data here</body></html>"), METADATA);
    expect(result).toEqual({ status: "skipped", errorCode: "STRUCTURED_RECEIPT_NOT_FOUND" });
  });

  it("returns review/STRUCTURED_RECEIPT_INCOMPLETE when a receipt-typed node is missing a required field", async () => {
    const incomplete = { "@type": "Order", merchant: { name: "Acme" } }; // no amount/currency/date
    const result = await parseStructuredReceipt(iterableOf(orderHtml(incomplete)), METADATA);
    expect(result).toEqual({ status: "review", errorCode: "STRUCTURED_RECEIPT_INCOMPLETE" });
  });

  it("returns skipped/STRUCTURED_RECEIPT_NOT_FOUND when JSON-LD exists but has no receipt-like @type", async () => {
    const result = await parseStructuredReceipt(
      iterableOf(orderHtml({ "@type": "WebSite", name: "Acme" })),
      METADATA,
    );
    expect(result).toEqual({ status: "skipped", errorCode: "STRUCTURED_RECEIPT_NOT_FOUND" });
  });

  it("skips malformed JSON-LD in one block but still finds a valid receipt in a later block", async () => {
    const html = `<html><body>
      <script type="application/ld+json">{ not valid json </script>
      <script type="application/ld+json">${JSON.stringify(VALID_ORDER)}</script>
    </body></html>`;
    const result = await parseStructuredReceipt(iterableOf(html), METADATA);
    expect("merchant" in result && result.merchant).toBe("Acme Hardware");
  });
});

describe("parseStructuredReceipt — hostile input / bound safety", () => {
  it("refuses input above the 1 MiB decoded budget before ever decoding it (pre-allocation refusal)", async () => {
    const ONE_MIB = 1024 * 1024;
    async function* hugeSource(): AsyncIterable<Buffer> {
      const chunk = Buffer.alloc(64 * 1024, 0x61); // 64 KiB of 'a'
      let sent = 0;
      while (sent <= ONE_MIB) {
        yield chunk;
        sent += chunk.length;
      }
    }
    const result = await parseStructuredReceipt(hugeSource(), METADATA);
    expect(result).toEqual({ status: "skipped", errorCode: "STRUCTURED_RECEIPT_BOUND_EXCEEDED" });
  });

  it("rejects JSON-LD nested beyond depth 64 without ever completing the parse", async () => {
    let nested: unknown = { "@type": "Order" };
    for (let i = 0; i < 100; i += 1) {
      nested = { wrapper: nested };
    }
    const result = await parseStructuredReceipt(iterableOf(orderHtml(nested)), METADATA);
    expect(result).toEqual({ status: "skipped", errorCode: "STRUCTURED_RECEIPT_BOUND_EXCEEDED" });
  });

  it("rejects a JSON-LD array with more than 20,000 nodes", async () => {
    const hugeArray = Array.from({ length: 21_000 }, (_, i) => i);
    const doc = { "@type": "Order", items: hugeArray };
    const result = await parseStructuredReceipt(iterableOf(orderHtml(doc)), METADATA);
    expect(result).toEqual({ status: "skipped", errorCode: "STRUCTURED_RECEIPT_BOUND_EXCEEDED" });
  });

  it("completes well within the 2-second deadline for ordinary input", async () => {
    const start = Date.now();
    await parseStructuredReceipt(iterableOf(orderHtml(VALID_ORDER)), METADATA);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("never pollutes Object.prototype via a __proto__ key in the JSON-LD payload", async () => {
    const hostileJson = `{"@type":"Order","merchant":{"name":"Acme"},"orderDate":"2026-09-01","priceCurrency":"USD","totalPrice":1,"__proto__":{"polluted":true}}`;
    const html = `<html><body><script type="application/ld+json">${hostileJson}</script></body></html>`;
    const result = await parseStructuredReceipt(iterableOf(html), METADATA);
    expect("merchant" in result && result.merchant).toBe("Acme");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("never executes a <script> that is not application/ld+json (no script execution)", async () => {
    const html = `<html><body><script>globalThis.__pwned = true;</script><script type="application/ld+json">${JSON.stringify(VALID_ORDER)}</script></body></html>`;
    const result = await parseStructuredReceipt(iterableOf(html), METADATA);
    expect("merchant" in result && result.merchant).toBe("Acme Hardware");
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it("performs no network access: a javascript-looking external reference is never fetched", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    // @ts-expect-error -- test spy
    globalThis.fetch = async (...args: unknown[]) => {
      fetchCalled = true;
      return originalFetch(...(args as Parameters<typeof fetch>));
    };
    try {
      const html = `<html><body><img src="https://evil.example/track.png"><script type="application/ld+json">${JSON.stringify(VALID_ORDER)}</script></body></html>`;
      await parseStructuredReceipt(iterableOf(html), METADATA);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles a pathological regex-style repeating pattern without hanging (ReDoS safety)", async () => {
    const hostileSubject = "a".repeat(50_000) + "!";
    const html = `<html><body>${hostileSubject}<script type="application/ld+json">${JSON.stringify(VALID_ORDER)}</script></body></html>`;
    const start = Date.now();
    const result = await parseStructuredReceipt(iterableOf(html), METADATA);
    expect(Date.now() - start).toBeLessThan(500);
    expect("merchant" in result && result.merchant).toBe("Acme Hardware");
  });
});
