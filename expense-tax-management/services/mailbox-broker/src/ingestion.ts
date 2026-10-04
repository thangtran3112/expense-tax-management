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
  type FileContentType,
  type AttachmentManifestV1,
  type MailboxErrorCodeV1,
} from "@expense-tax/contracts";

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
