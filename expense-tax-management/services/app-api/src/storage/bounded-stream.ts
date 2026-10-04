import { createHash } from "node:crypto";

/**
 * Phase 3D-C Task 3 -- bounded, hashing consumer for broker-streamed
 * mailbox attachment bytes. The broker streams directly to this process
 * over HTTP (never through Temporal: no 25 MiB Buffer/bytes argument ever
 * crosses a Temporal workflow/activity boundary for mailbox ingestion);
 * this is where App turns that HTTP body stream into a size-capped,
 * hashed in-memory buffer before it ever reaches storage.
 */
export class BoundedStreamSizeExceededError extends Error {
  constructor(readonly maxBytes: number) {
    super(`stream exceeded ${maxBytes} bytes`);
    this.name = "BoundedStreamSizeExceededError";
  }
}

export interface BoundedStreamResult {
  readonly data: Buffer;
  readonly sizeBytes: number;
  readonly sha256Hex: string;
}

/**
 * Consumes `source` chunk by chunk, hashing incrementally and enforcing
 * `maxBytes` as a hard cap: the instant cumulative bytes exceed the cap,
 * reading stops immediately -- the source is never drained further and no
 * byte beyond the bound is ever retained -- and
 * BoundedStreamSizeExceededError is thrown.
 *
 * ponytail: accumulates into an in-memory Buffer (bounded by maxBytes --
 * 25 MiB today, MAX_UPLOAD_BYTES) rather than a literal temp file on disk.
 * Correct and simplest at this bound: 25 MiB x 5 attachments is well
 * within safe per-request memory. Swap for a disk-backed temp file only if
 * maxBytes/concurrency ever grows past a size that's unsafe to hold in
 * process memory per concurrent upload.
 */
export async function readBoundedStream(
  source: AsyncIterable<Buffer>,
  maxBytes: number,
): Promise<BoundedStreamResult> {
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  for await (const chunk of source) {
    sizeBytes += chunk.byteLength;
    if (sizeBytes > maxBytes) {
      throw new BoundedStreamSizeExceededError(maxBytes);
    }
    hash.update(chunk);
    chunks.push(chunk);
  }
  return {
    data: Buffer.concat(chunks),
    sizeBytes,
    sha256Hex: hash.digest("hex"),
  };
}
