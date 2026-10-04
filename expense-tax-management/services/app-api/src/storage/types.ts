export type SignedContentMethod = "PUT" | "GET";

export interface IssueUploadTargetInput {
  readonly fileId: string;
  readonly storageKey: string;
  readonly contentType: string;
  readonly expiresAt: Date;
}

export interface UploadTarget {
  readonly url: string;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

export interface IssueReadUrlInput {
  readonly fileId: string;
  readonly storageKey: string;
  readonly expiresAt: Date;
}

export interface ObjectStat {
  readonly exists: true;
  readonly sizeBytes: number;
}

export interface WriteObjectInput {
  readonly storageKey: string;
  readonly data: Buffer;
  readonly contentType: string;
}

/**
 * Phase 3D-C Task 3 fix round 2 (review: "Stream request bytes to the
 * storage adapter incrementally... hashing and counting bytes as they
 * flow, aborting at the limit"). Thrown by writeObjectStream the instant
 * the cumulative byte count exceeds maxBytes -- the implementation must
 * stop reading the source and delete whatever partial object it had
 * started writing before this rejects.
 */
export class StorageWriteSizeExceededError extends Error {
  constructor(readonly maxBytes: number) {
    super(`stream exceeded ${maxBytes} bytes`);
    this.name = "StorageWriteSizeExceededError";
  }
}

export interface WriteObjectStreamInput {
  readonly storageKey: string;
  readonly contentType: string;
  readonly maxBytes: number;
}

export interface WriteObjectStreamResult {
  readonly sizeBytes: number;
  readonly sha256Hex: string;
  /** First up to 16 bytes actually written -- enough for magic-byte
   * content-type sniffing without reading the object back. */
  readonly headerBytes: Buffer;
}

/**
 * Storage adapter boundary. Shaped like GCS semantics (signed URLs with
 * expiry, stat/head, delete) so a future GCS implementation slots in
 * without changing the domain. URL issuance takes both fileId and
 * storageKey: GCS-style backends sign the storageKey directly and ignore
 * fileId; the local backend serves bytes through App API's own
 * bearer-free content routes, which address objects by fileId (never a
 * raw storage key in the URL path, so clients can't traverse the bucket).
 */
export interface StorageAdapter {
  issueUploadTarget(input: IssueUploadTargetInput): Promise<UploadTarget>;
  issueReadUrl(input: IssueReadUrlInput): Promise<{ readonly url: string }>;
  statObject(storageKey: string): Promise<ObjectStat | null>;
  readObject(storageKey: string): Promise<Buffer>;
  writeObject(input: WriteObjectInput): Promise<void>;
  /**
   * Writes `source` incrementally -- hashing and counting bytes as each
   * chunk arrives, never materializing the whole body as one in-memory
   * Buffer -- aborting (and deleting whatever partial object it had
   * started) the instant `maxBytes` is exceeded.
   */
  writeObjectStream(
    input: WriteObjectStreamInput,
    source: AsyncIterable<Buffer>,
  ): Promise<WriteObjectStreamResult>;
  /** Promotes an object already written (e.g. via writeObjectStream) to a
   * new key without re-reading its bytes into memory. */
  moveObject(fromStorageKey: string, toStorageKey: string): Promise<void>;
  deleteObject(storageKey: string): Promise<void>;
}
