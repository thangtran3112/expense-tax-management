/**
 * Phase 3D-C Task 7 — a single, composed proof that
 * `materializeCandidate` (the broker's own top-level orchestration of
 * Task 2's streaming/parsing primitives, exercised separately and
 * exhaustively by ingestion.test.ts/structured-receipt.test.ts) never
 * forwards raw content to App across EITHER of its two paths: every
 * payload it sends is captured by a fake `MailboxIngestionAppClient` and
 * swept for secret markers planted in the fake Gmail client's own
 * provider message/thread IDs, attachment bytes/filename/mimeType, and
 * the structured-HTML body's surrounding markup.
 *
 * Fully local: no HTTP, no Docker, no real Gmail -- same convention as
 * every other mailbox-broker test in this repo.
 */
import { describe, expect, it } from "vitest";

import {
  materializeCandidate,
  type MaterializeCandidateDependencies,
  type MaterializeGmailClient,
} from "../src/ingestion.js";

const CANDIDATE_ID = "33333333-3333-4333-8333-333333333333";
const CONNECTION_ID = "44444444-4444-4444-8444-444444444444";

/** Secret-shaped markers this test proves never reach any JSON payload
 * (only the opaque byte stream, for the attachment bytes themselves). */
const SECRET_PROVIDER_MESSAGE_ID = "gmail-msg-SECRET-cursor-91a7";
const SECRET_PROVIDER_THREAD_ID = "gmail-thread-SECRET-7f21";
const SECRET_ATTACHMENT_FILENAME = "invoice-SECRET-sender@example.test.pdf";
const SECRET_ATTACHMENT_MIME = "application/pdf; charset=SECRET-marker";
const SECRET_ATTACHMENT_BYTES = Buffer.from("%PDF-1.4\nSECRET-ATTACHMENT-BYTES-MARKER\n", "ascii");
const SECRET_HTML_SURROUNDING = "<!-- SECRET-RAW-HTML-SURROUNDING-MARKER sender@example.test -->";

interface CapturedCall {
  readonly method: string;
  readonly json: unknown;
}

function fakeAppClient(): { readonly client: MailboxIngestionAppClientLike; readonly calls: CapturedCall[]; readonly streamedBytes: Buffer[] } {
  const calls: CapturedCall[] = [];
  const streamedBytes: Buffer[] = [];
  const notImplemented = async (): Promise<never> => {
    throw new Error("not used by materializeCandidate in this test");
  };
  const client: MailboxIngestionAppClientLike = {
    loadScanBinding: notImplemented,
    stageCandidateMetadata: notImplemented,
    async loadCandidateBinding(candidateId: string) {
      calls.push({ method: "loadCandidateBinding", json: { candidateId } });
      return {
        candidateId,
        connectionId: CONNECTION_ID,
        expectedCandidateVersion: 1,
        providerMessageId: SECRET_PROVIDER_MESSAGE_ID,
        providerThreadId: SECRET_PROVIDER_THREAD_ID,
      };
    },
    async issueUploadGrant(input) {
      calls.push({ method: "issueUploadGrant", json: input });
      return {
        candidateId: input.candidateId,
        connectionId: CONNECTION_ID,
        uploadGrantId: "55555555-5555-4555-8555-555555555555",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxBytes: 26_214_400 as const,
        maxAttachments: 5 as const,
      };
    },
    async uploadAttachment(input, source) {
      calls.push({ method: "uploadAttachment", json: input });
      for await (const chunk of source) streamedBytes.push(chunk);
      return {
        candidateId: input.candidateId,
        attachmentIndex: input.attachmentIndex,
        fileId: "66666666-6666-4666-8666-666666666666",
        status: "READY" as const,
        errorCode: null,
        idempotencyKey: input.idempotencyKey,
      };
    },
    async submitStructuredResult(input) {
      calls.push({ method: "submitStructuredResult", json: input });
      return {
        schemaVersion: 1 as const,
        candidateId: input.result.candidateId,
        status: "processed" as const,
        processingJobId: null,
        expenseId: "77777777-7777-4777-8777-777777777777",
        sourceId: "88888888-8888-4888-8888-888888888888",
        duplicateMatchId: null,
        idempotencyKey: input.idempotencyKey,
      };
    },
  };
  return { client, calls, streamedBytes };
}

/** `MailboxIngestionAppClient` carries a 5th method (`discover`-family)
 * this test never exercises; narrowed to exactly what `materializeCandidate`
 * calls, same "only type what's used" precedent as this package's other
 * fakes. */
type MailboxIngestionAppClientLike = MaterializeCandidateDependencies["appClient"];

function fakeGmailClient(options: { readonly htmlBody: string | null }): MaterializeGmailClient {
  return {
    async getMessageHtmlBody() {
      return options.htmlBody === null ? null : (async function* () {
        yield Buffer.from(options.htmlBody!, "utf8");
      })();
    },
    async getMessage() {
      return {
        attachments: [
          {
            attachmentId: "att-0",
            filename: SECRET_ATTACHMENT_FILENAME,
            mimeType: SECRET_ATTACHMENT_MIME,
            sizeBytes: SECRET_ATTACHMENT_BYTES.byteLength,
          },
        ],
      };
    },
    async getAttachment() {
      return SECRET_ATTACHMENT_BYTES;
    },
  };
}

function serializedCalls(calls: readonly CapturedCall[]): string {
  return JSON.stringify(calls.map((c) => c.json));
}

const FORBIDDEN_MARKERS = [
  SECRET_PROVIDER_MESSAGE_ID,
  SECRET_PROVIDER_THREAD_ID,
  SECRET_ATTACHMENT_FILENAME,
  SECRET_ATTACHMENT_MIME,
  SECRET_HTML_SURROUNDING,
  "SECRET-ATTACHMENT-BYTES-MARKER",
];

describe("materializeCandidate — no sensitive data reaches App (attachment path)", () => {
  it("never forwards the provider message/thread ID, attachment filename/mimeType, or raw bytes in any JSON payload; attachment bytes travel only through the opaque stream", async () => {
    const { client, calls, streamedBytes } = fakeAppClient();
    const gmail = fakeGmailClient({ htmlBody: null });
    const deps: MaterializeCandidateDependencies = {
      appClient: client,
      getGmailClient: async () => gmail,
    };

    const result = await materializeCandidate(deps, {
      connectionId: CONNECTION_ID,
      candidateId: CANDIDATE_ID,
      operationId: "op-1",
    });

    expect(result.status).toBe("queued");

    const serialized = JSON.stringify(result) + serializedCalls(calls);
    for (const marker of FORBIDDEN_MARKERS) {
      expect(serialized).not.toContain(marker);
    }

    // The attachment bytes DID travel -- just only through the stream
    // argument, never alongside the JSON metadata above.
    expect(Buffer.concat(streamedBytes).equals(SECRET_ATTACHMENT_BYTES)).toBe(true);

    // uploadAttachment's own JSON metadata is exactly the opaque wire
    // shape -- no filename/mimeType/bytes field exists on it to leak.
    const uploadCall = calls.find((c) => c.method === "uploadAttachment");
    expect(Object.keys(uploadCall!.json as object).sort()).toEqual(
      ["attachmentIndex", "candidateId", "expectedCandidateVersion", "idempotencyKey", "uploadGrantId"].sort(),
    );
  });
});

describe("materializeCandidate — no sensitive data reaches App (structured-HTML path)", () => {
  it("never forwards the raw HTML body or provider IDs; only normalized fields/evidence codes are submitted", async () => {
    const order = {
      "@context": "https://schema.org",
      "@type": "Order",
      merchant: { "@type": "Organization", name: "Example Corp" },
      orderNumber: "ORD-1",
      orderDate: "2026-01-05",
      priceCurrency: "USD",
      totalPrice: 42,
    };
    const html = `<html><body>${SECRET_HTML_SURROUNDING}<script type="application/ld+json">${JSON.stringify(order)}</script></body></html>`;

    const { client, calls } = fakeAppClient();
    const gmail = fakeGmailClient({ htmlBody: html });
    const deps: MaterializeCandidateDependencies = {
      appClient: client,
      getGmailClient: async () => gmail,
    };

    const result = await materializeCandidate(deps, {
      connectionId: CONNECTION_ID,
      candidateId: CANDIDATE_ID,
      operationId: "op-2",
    });

    expect(result.status).toBe("processed");
    // No attachment upload was ever issued for a complete structured match.
    expect(calls.some((c) => c.method === "issueUploadGrant" || c.method === "uploadAttachment")).toBe(false);

    const serialized = JSON.stringify(result) + serializedCalls(calls);
    for (const marker of FORBIDDEN_MARKERS) {
      expect(serialized).not.toContain(marker);
    }
    // The raw HTML tag itself never survives parsing into the submitted
    // payload (only normalized merchant/amount/currency/date/evidence).
    expect(serialized).not.toContain("<html>");
    expect(serialized).not.toContain("<script");

    const submitted = calls.find((c) => c.method === "submitStructuredResult")!.json as {
      result: Record<string, unknown>;
    };
    expect(submitted.result.merchant).toBe("Example Corp");
    expect(submitted.result.evidence).toContain("schema_type:Order");
  });
});
