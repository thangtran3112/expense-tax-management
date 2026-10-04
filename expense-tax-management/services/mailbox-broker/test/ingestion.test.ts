/**
 * Phase 3D-C Task 2 — bounded attachment streaming.
 *
 * Fully local: `source` is a hand-written AsyncIterable<Buffer> fixture,
 * `target` is an in-memory fake recording writes/aborts. No HTTP, no
 * Docker, no Gmail.
 */
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  AttachmentBoundError,
  buildMaterializeDependencies,
  materializeCandidate,
  pumpBoundedAttachment,
  streamAttachment,
  type MaterializeCandidateDependencies,
  type MaterializeGmailClientProvider,
} from "../src/ingestion.js";

const PDF_MAGIC = Buffer.from("%PDF-1.4\nrest of a tiny pdf body", "latin1");
const JPEG_MAGIC = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 1)]);
const PNG_MAGIC = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 2),
]);
const WEBP_MAGIC = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("WEBP", "latin1"),
  Buffer.alloc(8, 3),
]);
const NOT_A_FILE = Buffer.alloc(32, 0x41); // "AAAA..." -- no recognized magic

async function* iterableOf(...chunks: Buffer[]): AsyncIterable<Buffer> {
  for (const chunk of chunks) yield chunk;
}

function createFakeTarget() {
  const writes: Buffer[] = [];
  let aborted = false;
  return {
    writes,
    get aborted() {
      return aborted;
    },
    async write(chunk: Buffer) {
      writes.push(Buffer.from(chunk));
    },
    async abort() {
      aborted = true;
    },
  };
}

describe("pumpBoundedAttachment", () => {
  it("streams a small PDF, sniffing its magic from the first bytes and computing SHA-256", async () => {
    const target = createFakeTarget();
    const result = await pumpBoundedAttachment({ attachmentIndex: 0 }, iterableOf(PDF_MAGIC), target);

    expect(result.mimeType).toBe("application/pdf");
    expect(result.sizeBytes).toBe(PDF_MAGIC.length);
    expect(result.sha256).toBe(createHash("sha256").update(PDF_MAGIC).digest("hex"));
    expect(Buffer.concat(target.writes)).toEqual(PDF_MAGIC);
    expect(target.aborted).toBe(false);
  });

  it("sniffs JPEG, PNG, and WEBP magic bytes", async () => {
    const jpeg = await pumpBoundedAttachment({ attachmentIndex: 0 }, iterableOf(JPEG_MAGIC), createFakeTarget());
    expect(jpeg.mimeType).toBe("image/jpeg");

    const png = await pumpBoundedAttachment({ attachmentIndex: 0 }, iterableOf(PNG_MAGIC), createFakeTarget());
    expect(png.mimeType).toBe("image/png");

    const webp = await pumpBoundedAttachment({ attachmentIndex: 0 }, iterableOf(WEBP_MAGIC), createFakeTarget());
    expect(webp.mimeType).toBe("image/webp");
  });

  it("splits magic bytes across several small chunks and still sniffs correctly (true streaming, not a single read)", async () => {
    const chunks = [PDF_MAGIC.subarray(0, 2), PDF_MAGIC.subarray(2, 4), PDF_MAGIC.subarray(4)];
    const target = createFakeTarget();
    const result = await pumpBoundedAttachment({ attachmentIndex: 0 }, iterableOf(...chunks), target);
    expect(result.mimeType).toBe("application/pdf");
    expect(Buffer.concat(target.writes)).toEqual(PDF_MAGIC);
  });

  it("rejects a first chunk whose bytes match no allowed file signature, never writing to target", async () => {
    const target = createFakeTarget();
    await expect(
      pumpBoundedAttachment({ attachmentIndex: 0 }, iterableOf(NOT_A_FILE), target),
    ).rejects.toSatisfy((error: unknown) => error instanceof AttachmentBoundError && error.errorCode === "ATTACHMENT_SIGNATURE_REJECTED");
    expect(target.writes).toHaveLength(0);
    expect(target.aborted).toBe(true);
  });

  it("aborts once total bytes exceed the 25 MiB cutoff, never buffering the whole attachment", async () => {
    const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
    const target = createFakeTarget();
    async function* oversizeSource(): AsyncIterable<Buffer> {
      yield PDF_MAGIC;
      const chunkSize = 1024 * 1024; // 1 MiB chunks
      let sent = PDF_MAGIC.length;
      while (sent <= MAX_UPLOAD_BYTES) {
        yield Buffer.alloc(chunkSize, 0x42);
        sent += chunkSize;
      }
    }

    await expect(
      pumpBoundedAttachment({ attachmentIndex: 0 }, oversizeSource(), target),
    ).rejects.toSatisfy((error: unknown) => error instanceof AttachmentBoundError && error.errorCode === "ATTACHMENT_BOUND_EXCEEDED");
    expect(target.aborted).toBe(true);
  });

  it("rejects the sixth attachment (index 5) before reading any bytes from the source", async () => {
    const target = createFakeTarget();
    let sourceRead = false;
    async function* source(): AsyncIterable<Buffer> {
      sourceRead = true;
      yield PDF_MAGIC;
    }

    await expect(
      pumpBoundedAttachment({ attachmentIndex: 5 }, source(), target),
    ).rejects.toSatisfy((error: unknown) => error instanceof AttachmentBoundError && error.errorCode === "ATTACHMENT_BOUND_EXCEEDED");
    expect(sourceRead).toBe(false);
    expect(target.aborted).toBe(true);
  });

  it("rejects a negative or non-integer attachment index before reading any bytes from the source", async () => {
    for (const badIndex of [-1, 1.5, Number.NaN]) {
      const target = createFakeTarget();
      let sourceRead = false;
      async function* source(): AsyncIterable<Buffer> {
        sourceRead = true;
        yield PDF_MAGIC;
      }

      await expect(
        pumpBoundedAttachment({ attachmentIndex: badIndex }, source(), target),
      ).rejects.toSatisfy((error: unknown) => error instanceof AttachmentBoundError && error.errorCode === "ATTACHMENT_BOUND_EXCEEDED");
      expect(sourceRead).toBe(false);
      expect(target.aborted).toBe(true);
    }
  });

  it("accepts attachment indices 0 through 4 (the five-attachment cap)", async () => {
    for (const index of [0, 1, 2, 3, 4]) {
      const result = await pumpBoundedAttachment({ attachmentIndex: index }, iterableOf(PDF_MAGIC), createFakeTarget());
      expect(result.mimeType).toBe("application/pdf");
    }
  });

  it("uses backpressure: never reads the next source chunk before target.write resolves", async () => {
    const writeOrder: string[] = [];
    let resolveFirstWrite: (() => void) | undefined;
    const target = {
      async write(chunk: Buffer) {
        writeOrder.push(`write:${chunk.length}`);
        if (writeOrder.length === 1) {
          await new Promise<void>((resolve) => {
            resolveFirstWrite = resolve;
          });
        }
      },
      async abort() {
        writeOrder.push("abort");
      },
    };

    let secondChunkRequested = false;
    async function* source(): AsyncIterable<Buffer> {
      yield PDF_MAGIC;
      secondChunkRequested = true;
      yield Buffer.from("tail", "latin1");
    }

    const pending = pumpBoundedAttachment({ attachmentIndex: 0 }, source(), target);
    // Give the event loop a turn: the pump must be blocked awaiting the
    // first write, so the source's second chunk must not be requested yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondChunkRequested).toBe(false);

    resolveFirstWrite?.();
    await pending;
    expect(secondChunkRequested).toBe(true);
  });

  it("calls target.abort() exactly once on a bound violation and never calls write afterward", async () => {
    const target = createFakeTarget();
    async function* source(): AsyncIterable<Buffer> {
      yield NOT_A_FILE;
      yield PDF_MAGIC; // must never be reached
    }

    await expect(pumpBoundedAttachment({ attachmentIndex: 0 }, source(), target)).rejects.toThrow();
    expect(target.aborted).toBe(true);
    expect(target.writes).toHaveLength(0);
  });
});

describe("streamAttachment", () => {
  it("wraps pumpBoundedAttachment and returns a full AttachmentManifestV1", async () => {
    const target = createFakeTarget();
    const manifest = await streamAttachment(
      { name: "receipt.pdf", attachmentIndex: 0 },
      iterableOf(PDF_MAGIC),
      target,
    );
    expect(manifest).toEqual({
      name: "receipt.pdf",
      mimeType: "application/pdf",
      sizeBytes: PDF_MAGIC.length,
      sha256: createHash("sha256").update(PDF_MAGIC).digest("hex"),
    });
  });
});

describe("materializeCandidate", () => {
  const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
  const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";

  const VALID_ORDER_HTML = `<html><body><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Order",
    merchant: { "@type": "Organization", name: "Acme Hardware" },
    orderNumber: "A-1001",
    orderDate: "2026-09-01",
    priceCurrency: "USD",
    totalPrice: 42.5,
  })}</script></body></html>`;

  async function* htmlChunks(html: string): AsyncIterable<Buffer> {
    yield Buffer.from(html, "utf8");
  }

  function fakeDeps(
    overrides: {
      attachments?: readonly { attachmentId: string; filename: string; mimeType: string; sizeBytes: number }[];
      uploadStatus?: "READY" | "REVIEW" | "FAILED";
      /** null (default): no html part. A string: served as the message's `text/html` body. */
      htmlBody?: string | null;
      submitStructuredResultImpl?: (...args: unknown[]) => unknown;
    } = {},
  ): MaterializeCandidateDependencies & {
    appClient: { [K in keyof MaterializeCandidateDependencies["appClient"]]: ReturnType<typeof vi.fn> };
  } {
    const appClient = {
      loadCandidateBinding: vi.fn(async () => ({
        candidateId: CANDIDATE_ID,
        connectionId: CONNECTION_ID,
        expectedCandidateVersion: 1,
        providerMessageId: "gmail-message-1",
        providerThreadId: null,
      })),
      issueUploadGrant: vi.fn(async () => ({
        candidateId: CANDIDATE_ID,
        connectionId: CONNECTION_ID,
        uploadGrantId: "grant-1",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        maxBytes: 26214400 as const,
        maxAttachments: 5 as const,
      })),
      uploadAttachment: vi.fn(async (input: { attachmentIndex: number }) => ({
        candidateId: CANDIDATE_ID,
        attachmentIndex: input.attachmentIndex,
        fileId: `file-${input.attachmentIndex}`,
        status: overrides.uploadStatus ?? "READY",
        errorCode: null,
        idempotencyKey: `idem-${input.attachmentIndex}`,
      })),
      submitStructuredResult:
        overrides.submitStructuredResultImpl ??
        vi.fn(async () => ({
          schemaVersion: 1,
          candidateId: CANDIDATE_ID,
          status: "processed",
          processingJobId: null,
          expenseId: "33333333-3333-4333-8333-333333333333",
          sourceId: "44444444-4444-4444-8444-444444444444",
          duplicateMatchId: null,
          idempotencyKey: "idem-structured-1",
        })),
      loadScanBinding: vi.fn(),
      stageCandidateMetadata: vi.fn(),
    } as unknown as MaterializeCandidateDependencies["appClient"] & {
      [K in keyof MaterializeCandidateDependencies["appClient"]]: ReturnType<typeof vi.fn>;
    };
    const getGmailClient = vi.fn(async () => ({
      getMessage: vi.fn(async () => ({
        attachments: overrides.attachments ?? [
          { attachmentId: "att-1", filename: "receipt.pdf", mimeType: "application/pdf", sizeBytes: 100 },
        ],
      })),
      getAttachment: vi.fn(async () => Buffer.from("fake-attachment-bytes")),
      getMessageHtmlBody: vi.fn(async () =>
        overrides.htmlBody !== null && overrides.htmlBody !== undefined
          ? htmlChunks(overrides.htmlBody)
          : null,
      ),
    }));
    return { appClient, getGmailClient };
  }

  it("issues one grant and uploads every attachment, returning status queued", async () => {
    const deps = fakeDeps({
      attachments: [
        { attachmentId: "att-1", filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 10 },
        { attachmentId: "att-2", filename: "b.pdf", mimeType: "application/pdf", sizeBytes: 10 },
      ],
    });

    const result = await materializeCandidate(deps, {
      connectionId: "ignored",
      candidateId: CANDIDATE_ID,
      operationId: "op-1",
    });

    expect(deps.appClient.loadCandidateBinding).toHaveBeenCalledWith(CANDIDATE_ID);
    expect(deps.appClient.issueUploadGrant).toHaveBeenCalledTimes(1);
    expect(deps.appClient.uploadAttachment).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      schemaVersion: 1,
      candidateId: CANDIDATE_ID,
      status: "queued",
      processingJobId: null,
      expenseId: null,
      sourceId: null,
      duplicateMatchId: null,
    });
  });

  it("returns review and never issues an upload grant when there are no attachments", async () => {
    const deps = fakeDeps({ attachments: [] });

    const result = await materializeCandidate(deps, {
      connectionId: "ignored",
      candidateId: CANDIDATE_ID,
      operationId: "op-1",
    });

    expect(deps.appClient.issueUploadGrant).not.toHaveBeenCalled();
    expect(result.status).toBe("review");
  });

  it("returns status failed when any attachment upload fails", async () => {
    const deps = fakeDeps({ uploadStatus: "FAILED" });

    const result = await materializeCandidate(deps, {
      connectionId: "ignored",
      candidateId: CANDIDATE_ID,
      operationId: "op-1",
    });

    expect(result.status).toBe("failed");
  });

  it("never uploads more than MAX_CANDIDATE_ATTACHMENTS even if the Gmail message reports more", async () => {
    const deps = fakeDeps({
      attachments: Array.from({ length: 7 }, (_, index) => ({
        attachmentId: `att-${index}`,
        filename: `f${index}.pdf`,
        mimeType: "application/pdf",
        sizeBytes: 10,
      })),
    });

    await materializeCandidate(deps, { connectionId: "ignored", candidateId: CANDIDATE_ID, operationId: "op-1" });

    expect(deps.appClient.uploadAttachment).toHaveBeenCalledTimes(5);
  });

  // ---------------------------------------------------------------- //
  // Phase 3D-C Task 5 gap closure -- structured-HTML path tried first.
  // ---------------------------------------------------------------- //

  it("a valid JSON-LD body submits directly to App and never issues an upload grant", async () => {
    const deps = fakeDeps({ htmlBody: VALID_ORDER_HTML });

    const result = await materializeCandidate(deps, {
      connectionId: "ignored",
      candidateId: CANDIDATE_ID,
      operationId: "op-1",
    });

    expect(deps.appClient.submitStructuredResult).toHaveBeenCalledWith(
      expect.objectContaining({ result: expect.objectContaining({ merchant: "Acme Hardware" }) }),
    );
    expect(deps.appClient.issueUploadGrant).not.toHaveBeenCalled();
    expect(deps.appClient.uploadAttachment).not.toHaveBeenCalled();
    expect(result.status).toBe("processed");
  });

  it("falls back to the attachment path when the html body has no structured receipt", async () => {
    const deps = fakeDeps({ htmlBody: "<html><body>just a newsletter, no receipt here</body></html>" });

    const result = await materializeCandidate(deps, {
      connectionId: "ignored",
      candidateId: CANDIDATE_ID,
      operationId: "op-1",
    });

    expect(deps.appClient.submitStructuredResult).not.toHaveBeenCalled();
    expect(deps.appClient.issueUploadGrant).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("queued");
  });

  it("falls back to the attachment path when the html body exceeds the parser's decode budget", async () => {
    const oversizeHtml = `<html><body>${"a".repeat(2 * 1024 * 1024)}</body></html>`;
    const deps = fakeDeps({ htmlBody: oversizeHtml });

    const result = await materializeCandidate(deps, {
      connectionId: "ignored",
      candidateId: CANDIDATE_ID,
      operationId: "op-1",
    });

    expect(deps.appClient.submitStructuredResult).not.toHaveBeenCalled();
    expect(deps.appClient.issueUploadGrant).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("queued");
  });

  it("falls back to the attachment path when the message has no html part at all", async () => {
    const deps = fakeDeps({ htmlBody: null });

    const result = await materializeCandidate(deps, {
      connectionId: "ignored",
      candidateId: CANDIDATE_ID,
      operationId: "op-1",
    });

    expect(deps.appClient.submitStructuredResult).not.toHaveBeenCalled();
    expect(deps.appClient.issueUploadGrant).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("queued");
  });

  it("never lets html body bytes reach the App payload -- only normalized fields and bounded evidence codes", async () => {
    let captured: unknown;
    const deps = fakeDeps({
      htmlBody: VALID_ORDER_HTML,
      submitStructuredResultImpl: vi.fn(async (input: unknown) => {
        captured = input;
        return {
          schemaVersion: 1,
          candidateId: CANDIDATE_ID,
          status: "processed",
          processingJobId: null,
          expenseId: null,
          sourceId: null,
          duplicateMatchId: null,
          idempotencyKey: "idem-structured-1",
        };
      }),
    });

    await materializeCandidate(deps, { connectionId: "ignored", candidateId: CANDIDATE_ID, operationId: "op-1" });

    expect(JSON.stringify(captured)).not.toContain("<html>");
    expect(JSON.stringify(captured)).not.toContain("<script");
  });
});

describe("buildMaterializeDependencies", () => {
  it("wires the real appClient and delegates getGmailClient to the provider's getGmailDiscoveryClient, unchanged", async () => {
    const appClient = { tag: "the-real-app-client" } as unknown as MaterializeCandidateDependencies["appClient"];
    const gmailClient = { tag: "the-real-gmail-client" };
    const getGmailDiscoveryClient = vi.fn(async () => gmailClient as never);
    const gmailClientProvider: MaterializeGmailClientProvider = { getGmailDiscoveryClient };

    const deps = buildMaterializeDependencies(appClient, gmailClientProvider);

    expect(deps.appClient).toBe(appClient);
    await expect(deps.getGmailClient("connection-1")).resolves.toBe(gmailClient);
    expect(getGmailDiscoveryClient).toHaveBeenCalledWith("connection-1");
  });
});
