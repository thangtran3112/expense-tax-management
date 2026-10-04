/**
 * Phase 3D-C Task 2 — bounded attachment streaming.
 *
 * The broker never buffers a whole attachment in memory: bytes are read
 * from `source` one chunk at a time and written to `target` with
 * backpressure (each `target.write` is awaited before the next chunk is
 * pulled), while a running byte count enforces the 25 MiB cap and a
 * running SHA-256 digest is computed incrementally. `target.abort()` is
 * called on any bound violation so a caller streaming into a real HTTP
 * request body can cancel it immediately. `pumpBoundedAttachment` never
 * returns the bytes themselves -- only size/digest/sniffed-type metadata.
 *
 * Ruling: the brief's illustrative `streamAttachment(input:
 * MailboxBrokerAttachmentUploadV1, target)` signature has no parameter
 * carrying the actual bytes to stream (the canonical
 * `MailboxBrokerAttachmentUploadV1` wire shape is only
 * candidateId/attachmentIndex/uploadGrantId/expectedCandidateVersion/
 * idempotencyKey -- no byte source), so it cannot be implemented
 * verbatim. `pumpBoundedAttachment` is the real primitive (takes an
 * explicit `source: AsyncIterable<Buffer>`); `streamAttachment` wraps it
 * to match the brief's named export and its `Promise<AttachmentManifestV1>`
 * return shape exactly. Same precedent as Task 1's own "Ruling applied"
 * entries and 3D-B Task 4's recorded signature deviations where the
 * plan's illustrative shape under-specifies what the real call site
 * needs. Cost if wrong: trivial -- `streamAttachment` is a thin wrapper,
 * easy to re-point.
 *
 * Ruling: the attachment's MIME type is never trusted from caller input
 * -- it is sniffed from the first accumulated bytes (magic-byte check)
 * against the four allowed `FileContentType`s and rejected
 * (`ATTACHMENT_SIGNATURE_REJECTED`) if it matches none. Gmail's own
 * declared MIME type for a part is attacker-controlled (a hostile sender
 * can label any bytes as `application/pdf`), so re-sniffing the real
 * bytes is the only trustworthy signal at this boundary.
 */
import { createHash } from "node:crypto";

import {
  MAX_UPLOAD_BYTES,
  MAX_CANDIDATE_ATTACHMENTS,
  mailboxIdempotencyKey,
  type FileContentType,
  type AttachmentManifestV1,
  type MailboxErrorCodeV1,
  type MailboxIngestionAppClient,
  type MailboxMaterializationResultV1,
  type MaterializeInput,
} from "@expense-tax/contracts";

import { materializeStructuredReceipt } from "./structured-receipt.js";

export interface StreamTarget {
  write(chunk: Buffer): Promise<void>;
  abort(): Promise<void>;
}

export class AttachmentBoundError extends Error {
  readonly errorCode: MailboxErrorCodeV1;

  constructor(errorCode: MailboxErrorCodeV1, message: string) {
    super(message);
    this.name = "AttachmentBoundError";
    this.errorCode = errorCode;
  }
}

// First N bytes needed to sniff every allowed signature (WEBP's "WEBP"
// marker starts at byte 8 and is 4 bytes long).
const MAGIC_HEADER_BYTES = 12;

function sniffMimeType(header: Buffer): FileContentType | null {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    header.length >= 8 &&
    header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (header.length >= 5 && header.subarray(0, 5).toString("latin1") === "%PDF-") {
    return "application/pdf";
  }
  if (
    header.length >= 12 &&
    header.subarray(0, 4).toString("latin1") === "RIFF" &&
    header.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export interface AttachmentPumpInput {
  readonly attachmentIndex: number;
}

export interface AttachmentPumpResult {
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly mimeType: FileContentType;
}

/**
 * Streams `source` into `target` with backpressure, enforcing the
 * five-attachment-per-candidate cap (via `attachmentIndex`) and the 25
 * MiB per-attachment cap, sniffing the real file type from the first
 * bytes, and computing a running SHA-256 digest. Never returns bytes.
 */
export async function pumpBoundedAttachment(
  input: AttachmentPumpInput,
  source: AsyncIterable<Buffer>,
  target: StreamTarget,
): Promise<AttachmentPumpResult> {
  // Fix round 1 (review Minor) -- a negative or non-integer index is
  // just as out of bounds as a too-large one; reject it the same way,
  // before ever touching `source`.
  if (!Number.isInteger(input.attachmentIndex) || input.attachmentIndex < 0 || input.attachmentIndex >= MAX_CANDIDATE_ATTACHMENTS) {
    await target.abort();
    throw new AttachmentBoundError(
      "ATTACHMENT_BOUND_EXCEEDED",
      `attachment index ${input.attachmentIndex} is not a valid 0-based index below the ${MAX_CANDIDATE_ATTACHMENTS}-attachment cap`,
    );
  }

  const hash = createHash("sha256");
  let totalBytes = 0;
  let header: Buffer = Buffer.alloc(0);
  let mimeType: FileContentType | null = null;

  async function sniffAndFlushHeader(): Promise<void> {
    const sniffed = sniffMimeType(header);
    if (sniffed === null) {
      await target.abort();
      throw new AttachmentBoundError(
        "ATTACHMENT_SIGNATURE_REJECTED",
        "attachment bytes do not match an allowed file signature",
      );
    }
    mimeType = sniffed;
    hash.update(header);
    await target.write(header);
  }

  for await (const chunk of source) {
    if (chunk.length === 0) continue;
    totalBytes += chunk.length;
    if (totalBytes > MAX_UPLOAD_BYTES) {
      await target.abort();
      throw new AttachmentBoundError("ATTACHMENT_BOUND_EXCEEDED", `attachment exceeds ${MAX_UPLOAD_BYTES} bytes`);
    }

    if (mimeType === null) {
      header = Buffer.concat([header, chunk]);
      if (header.length < MAGIC_HEADER_BYTES) continue;
      await sniffAndFlushHeader();
      continue;
    }

    hash.update(chunk);
    await target.write(chunk);
  }

  if (mimeType === null) {
    // Stream ended before MAGIC_HEADER_BYTES accumulated -- sniff
    // whatever we have (too short to be any allowed type unless empty).
    await sniffAndFlushHeader();
  }

  return { sizeBytes: totalBytes, sha256: hash.digest("hex"), mimeType: mimeType! };
}

/** Thin wrapper matching the plan's named export and manifest return shape -- see module ruling above. */
export async function streamAttachment(
  request: { readonly name: string; readonly attachmentIndex: number },
  source: AsyncIterable<Buffer>,
  target: StreamTarget,
): Promise<AttachmentManifestV1> {
  const result = await pumpBoundedAttachment({ attachmentIndex: request.attachmentIndex }, source, target);
  return { name: request.name, mimeType: result.mimeType, sizeBytes: result.sizeBytes, sha256: result.sha256 };
}

/**
 * Phase 3D-C Task 5 — materialize orchestration (the Gmail-refetch +
 * direct-App-callback glue Task 2/3 both flagged as not-yet-implemented).
 *
 * Narrower than `GmailDiscoveryClientLike` (discovery.ts) on purpose: only
 * the three fetch methods this function actually needs, so it stays
 * independently testable with a fake and carries no dependency on
 * discovery.ts's larger (list/history) surface.
 *
 * Gap closure (controller ruling, progress.md): the structured-HTML path
 * is tried FIRST via a bounded `getMessageHtmlBody` fetch (google-
 * mailbox.ts's real Gmail adapter) + the Task 2 parser
 * (structured-receipt.ts's parseStructuredReceipt, run through
 * materializeStructuredReceipt). A complete match submits directly to App
 * and returns immediately -- no attachment upload grant is ever issued.
 * Absent/invalid/oversize body falls through to the attachment/OCR path
 * unchanged. Body bytes never cross into a log line or an App payload:
 * only the parser's own bounded evidence codes and normalized fields
 * (StructuredReceiptResultV1) ever leave this function via
 * submitStructuredResult.
 *
 * Ruling: `MaterializeInput.connectionId` is accepted (canonical contract
 * shape) but unused -- same precedent as the discover route's own
 * documented ruling (routes/connections.ts): the broker resolves the real
 * connectionId itself via `loadCandidateBinding(candidateId)`, never from
 * the caller, since the worker never knows it either (opaque by design).
 */
export interface MaterializeGmailClient {
  getMessage(id: string): Promise<{
    readonly attachments: readonly {
      readonly attachmentId: string;
      readonly filename: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
    }[];
  }>;
  getAttachment(input: { readonly messageId: string; readonly attachmentId: string }): Promise<Buffer>;
  /** Null when the message has no `text/html` part -- falls through to the attachment path. */
  getMessageHtmlBody(id: string): Promise<AsyncIterable<Buffer> | null>;
}

export interface MaterializeCandidateDependencies {
  readonly appClient: MailboxIngestionAppClient;
  readonly getGmailClient: (connectionId: string) => Promise<MaterializeGmailClient>;
}

async function* singleChunk(data: Buffer): AsyncIterable<Buffer> {
  yield data;
}

export async function materializeCandidate(
  deps: MaterializeCandidateDependencies,
  input: MaterializeInput,
): Promise<MailboxMaterializationResultV1> {
  const binding = await deps.appClient.loadCandidateBinding(input.candidateId);
  const gmail = await deps.getGmailClient(binding.connectionId);

  const htmlBody = await gmail.getMessageHtmlBody(binding.providerMessageId);
  if (htmlBody) {
    const structuredResult = await materializeStructuredReceipt(
      { submitStructuredResult: deps.appClient.submitStructuredResult },
      htmlBody,
      {
        candidateId: input.candidateId,
        connectionId: binding.connectionId,
        candidateVersion: binding.expectedCandidateVersion,
      },
      mailboxIdempotencyKey(
        binding.connectionId,
        "submit_structured_result",
        input.candidateId,
        binding.expectedCandidateVersion,
      ),
    );
    // A complete, valid structured match materializes synchronously --
    // no attachment upload grant is ever issued for this candidate.
    if (structuredResult) return structuredResult;
  }

  const message = await gmail.getMessage(binding.providerMessageId);

  if (message.attachments.length === 0) {
    return {
      schemaVersion: 1,
      candidateId: input.candidateId,
      status: "review",
      processingJobId: null,
      expenseId: null,
      sourceId: null,
      duplicateMatchId: null,
      idempotencyKey: mailboxIdempotencyKey(
        binding.connectionId,
        "materialize_candidate_no_attachments",
        input.candidateId,
        binding.expectedCandidateVersion,
      ),
    };
  }

  const grant = await deps.appClient.issueUploadGrant({
    candidateId: input.candidateId,
    expectedCandidateVersion: binding.expectedCandidateVersion,
    operationId: input.operationId,
  });

  const attachmentCount = Math.min(message.attachments.length, MAX_CANDIDATE_ATTACHMENTS);
  // Phase 3D-C Task 5 fix round 3 (Critical, task-6-review.md): "mixed
  // outcomes keep the success" -- the candidate-level materialize result
  // is "failed" only when NO attachment produced a viable (non-FAILED)
  // upload; one good attachment among several malware/unsupported/
  // oversize ones still proceeds through the normal per-attachment OCR
  // path (receiveAttachment already creates one OCR job per READY
  // attachment, independent of its siblings' outcomes). Previously this
  // flipped to "failed" on ANY single attachment failure, which would
  // have blocked an otherwise-viable candidate the first time even one
  // attachment was malware-blocked.
  let anySucceeded = false;
  for (let index = 0; index < attachmentCount; index += 1) {
    const attachment = message.attachments[index]!;
    const bytes = await gmail.getAttachment({
      messageId: binding.providerMessageId,
      attachmentId: attachment.attachmentId,
    });
    const result = await deps.appClient.uploadAttachment(
      {
        candidateId: input.candidateId,
        attachmentIndex: index,
        uploadGrantId: grant.uploadGrantId,
        expectedCandidateVersion: binding.expectedCandidateVersion,
        idempotencyKey: mailboxIdempotencyKey(
          binding.connectionId,
          "upload_attachment",
          `${input.candidateId}:${index}`,
          binding.expectedCandidateVersion,
        ),
      },
      singleChunk(bytes),
    );
    if (result.status !== "FAILED") anySucceeded = true;
  }

  return {
    schemaVersion: 1,
    candidateId: input.candidateId,
    status: anySucceeded ? "queued" : "failed",
    processingJobId: null,
    expenseId: null,
    sourceId: null,
    duplicateMatchId: null,
    idempotencyKey: mailboxIdempotencyKey(
      binding.connectionId,
      "materialize_candidate",
      input.candidateId,
      binding.expectedCandidateVersion,
    ),
  };
}

/**
 * Phase 3D-C Task 5 gap closure 2 -- production wiring seam. Anything
 * that can mint a `MaterializeGmailClient` per connectionId (the real
 * `createGmailMailboxProvider`'s new `getGmailDiscoveryClient`, or a test
 * fake) satisfies this; `buildMaterializeDependencies` is the one place
 * that assembles `MaterializeCandidateDependencies` from it plus the
 * broker's own App client, so server.ts has no inline object literal a
 * reviewer has to trust is wired to the real things.
 */
export interface MaterializeGmailClientProvider {
  getGmailDiscoveryClient(connectionId: string): Promise<MaterializeGmailClient>;
}

export function buildMaterializeDependencies(
  appClient: MailboxIngestionAppClient,
  gmailClientProvider: MaterializeGmailClientProvider,
): MaterializeCandidateDependencies {
  return {
    appClient,
    getGmailClient: (connectionId) => gmailClientProvider.getGmailDiscoveryClient(connectionId),
  };
}
