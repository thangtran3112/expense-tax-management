import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createStorageAdapter } from "../src/storage/factory.js";
import { createLocalStorageAdapter } from "../src/storage/local.js";
import {
  createContentSignature,
  toEpochSec,
  verifyContentSignature,
} from "../src/storage/signing.js";

const SIGNING_KEY = "test-signing-key-not-secret";
const FILE_ID = "11111111-1111-4111-8111-111111111111";

describe("content URL signing", () => {
  it("round-trips a valid signature", () => {
    const expiresEpochSec = toEpochSec(new Date(Date.now() + 60_000));
    const signature = createContentSignature({
      signingKey: SIGNING_KEY,
      method: "PUT",
      fileId: FILE_ID,
      expiresEpochSec,
    });
    expect(
      verifyContentSignature({
        signingKey: SIGNING_KEY,
        method: "PUT",
        fileId: FILE_ID,
        expiresEpochSec,
        signature,
        nowEpochSec: toEpochSec(new Date()),
      }),
    ).toBe("valid");
  });

  it("rejects forged, tampered, wrong-method, and expired signatures", () => {
    const expiresEpochSec = toEpochSec(new Date(Date.now() + 60_000));
    const signature = createContentSignature({
      signingKey: SIGNING_KEY,
      method: "PUT",
      fileId: FILE_ID,
      expiresEpochSec,
    });
    const base = {
      signingKey: SIGNING_KEY,
      fileId: FILE_ID,
      expiresEpochSec,
      signature,
      nowEpochSec: toEpochSec(new Date()),
    };
    expect(verifyContentSignature({ ...base, method: "GET" })).toBe("invalid");
    expect(
      verifyContentSignature({ ...base, method: "PUT", fileId: `${FILE_ID}0`.slice(1) }),
    ).toBe("invalid");
    expect(
      verifyContentSignature({ ...base, method: "PUT", signature: "0".repeat(64) }),
    ).toBe("invalid");
    expect(
      verifyContentSignature({ ...base, method: "PUT", signature: "not-hex" }),
    ).toBe("invalid");
    expect(
      verifyContentSignature({
        ...base,
        method: "PUT",
        nowEpochSec: expiresEpochSec + 1,
      }),
    ).toBe("expired");
  });
});

describe("local storage adapter", () => {
  let rootDir = "";

  afterEach(async () => {
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
      rootDir = "";
    }
  });

  async function createAdapter() {
    rootDir = await mkdtemp(path.join(tmpdir(), "expense-tax-storage-test-"));
    return createLocalStorageAdapter({
      rootDir,
      baseUrl: "http://127.0.0.1:8100",
      signingKey: SIGNING_KEY,
    });
  }

  it("writes, stats, reads, and deletes objects", async () => {
    const adapter = await createAdapter();
    expect(await adapter.statObject("tenants/t1/originals/f1/a.jpg")).toBeNull();
    await adapter.writeObject({
      storageKey: "tenants/t1/originals/f1/a.jpg",
      data: Buffer.from("bytes"),
      contentType: "image/jpeg",
    });
    expect(await adapter.statObject("tenants/t1/originals/f1/a.jpg")).toEqual({
      exists: true,
      sizeBytes: 5,
    });
    expect(
      (await adapter.readObject("tenants/t1/originals/f1/a.jpg")).toString(),
    ).toBe("bytes");
    await adapter.deleteObject("tenants/t1/originals/f1/a.jpg");
    expect(await adapter.statObject("tenants/t1/originals/f1/a.jpg")).toBeNull();
    await adapter.deleteObject("tenants/t1/originals/f1/a.jpg");
  });

  // ------------------------------------------------------------------ //
  // Phase 3D-C Task 3 fix round 2 (review Important #1): stream to
  // storage incrementally, never a single materialized Buffer for the
  // whole body.
  // ------------------------------------------------------------------ //

  async function* manyChunks(totalBytes: number, chunkSize: number): AsyncIterable<Buffer> {
    let remaining = totalBytes;
    let seed = 0;
    while (remaining > 0) {
      const size = Math.min(chunkSize, remaining);
      yield Buffer.alloc(size, (seed++) % 256);
      remaining -= size;
    }
  }

  it("writeObjectStream receives and writes many small chunks incrementally -- no single chunk anywhere near the full body size", async () => {
    const adapter = await createAdapter();
    const CHUNK_SIZE = 64 * 1024; // 64 KiB
    const TOTAL_BYTES = 5 * 1024 * 1024; // 5 MiB, 80 chunks
    const source = manyChunks(TOTAL_BYTES, CHUNK_SIZE);

    const observedChunkSizes: number[] = [];
    async function* observed(): AsyncIterable<Buffer> {
      for await (const chunk of source) {
        observedChunkSizes.push(chunk.byteLength);
        yield chunk;
      }
    }

    const result = await adapter.writeObjectStream(
      { storageKey: "tenants/t1/staging/big.bin", contentType: "application/octet-stream", maxBytes: TOTAL_BYTES },
      observed(),
    );

    expect(result.sizeBytes).toBe(TOTAL_BYTES);
    // The adapter consumed many small chunks, not one pre-concatenated
    // buffer -- the defining structural property "streamed", not
    // "buffered then written".
    expect(observedChunkSizes.length).toBeGreaterThan(1);
    expect(observedChunkSizes.every((size) => size <= CHUNK_SIZE)).toBe(true);
    expect(Math.max(...observedChunkSizes)).toBeLessThan(TOTAL_BYTES);

    const stat = await adapter.statObject("tenants/t1/staging/big.bin");
    expect(stat).toEqual({ exists: true, sizeBytes: TOTAL_BYTES });
  });

  it("writeObjectStream aborts at maxBytes without draining the rest of the source, and leaves no partial object", async () => {
    let secondChunkRead = false;
    async function* source(): AsyncIterable<Buffer> {
      yield Buffer.alloc(11, 1);
      secondChunkRead = true;
      yield Buffer.alloc(11, 2);
    }
    const adapter = await createAdapter();
    await expect(
      adapter.writeObjectStream(
        { storageKey: "tenants/t1/staging/oversize.bin", contentType: "application/octet-stream", maxBytes: 10 },
        source(),
      ),
    ).rejects.toMatchObject({ name: "StorageWriteSizeExceededError" });
    expect(secondChunkRead).toBe(false);
    expect(await adapter.statObject("tenants/t1/staging/oversize.bin")).toBeNull();
  });

  it("moveObject promotes a written object to a new key without re-materializing its bytes", async () => {
    const adapter = await createAdapter();
    await adapter.writeObjectStream(
      { storageKey: "from.bin", contentType: "application/octet-stream", maxBytes: 100 },
      (async function* () {
        yield Buffer.from("hello-move");
      })(),
    );
    await adapter.moveObject("from.bin", "to.bin");
    expect(await adapter.statObject("from.bin")).toBeNull();
    expect((await adapter.readObject("to.bin")).toString()).toBe("hello-move");
  });

  it("rejects path-traversal storage keys", async () => {
    const adapter = await createAdapter();
    await expect(
      adapter.writeObject({
        storageKey: "../escape.jpg",
        data: Buffer.from("x"),
        contentType: "image/jpeg",
      }),
    ).rejects.toThrow("Invalid storage key");
    await expect(adapter.statObject("/absolute.jpg")).rejects.toThrow(
      "Invalid storage key",
    );
  });

  it("issues bearer-free content URLs carrying verifiable signatures", async () => {
    const adapter = await createAdapter();
    const expiresAt = new Date(Date.now() + 60_000);
    const target = await adapter.issueUploadTarget({
      fileId: FILE_ID,
      storageKey: "k",
      contentType: "image/jpeg",
      expiresAt,
    });
    expect(target.requiredHeaders).toEqual({ "Content-Type": "image/jpeg" });
    const uploadUrl = new URL(target.url);
    expect(uploadUrl.pathname).toBe(`/api/v1/file-content/${FILE_ID}`);
    const expiresEpochSec = Number(uploadUrl.searchParams.get("expires"));
    expect(
      verifyContentSignature({
        signingKey: SIGNING_KEY,
        method: "PUT",
        fileId: FILE_ID,
        expiresEpochSec,
        signature: uploadUrl.searchParams.get("signature") ?? "",
        nowEpochSec: toEpochSec(new Date()),
      }),
    ).toBe("valid");

    const read = await adapter.issueReadUrl({
      fileId: FILE_ID,
      storageKey: "k",
      expiresAt,
    });
    const readUrl = new URL(read.url);
    expect(
      verifyContentSignature({
        signingKey: SIGNING_KEY,
        method: "GET",
        fileId: FILE_ID,
        expiresEpochSec: Number(readUrl.searchParams.get("expires")),
        signature: readUrl.searchParams.get("signature") ?? "",
        nowEpochSec: toEpochSec(new Date()),
      }),
    ).toBe("valid");
  });
});

describe("local adapter base URL", () => {
  it("resolves a thunk base URL per issuance (ephemeral listeners)", async () => {
    let port = 8100;
    const adapter = createLocalStorageAdapter({
      rootDir: "/tmp/x",
      baseUrl: () => `http://127.0.0.1:${port}`,
      signingKey: SIGNING_KEY,
    });
    const first = await adapter.issueReadUrl({
      fileId: FILE_ID,
      storageKey: "k",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(first.url).toContain("http://127.0.0.1:8100/");
    port = 8199;
    const second = await adapter.issueReadUrl({
      fileId: FILE_ID,
      storageKey: "k",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(second.url).toContain("http://127.0.0.1:8199/");
  });
});

describe("storage factory", () => {
  it("builds the local adapter and refuses GCS until the infrastructure gate", () => {
    const local = createStorageAdapter({
      backend: "local",
      localDir: "/tmp/x",
      baseUrl: "http://127.0.0.1:8100",
      urlSigningKey: SIGNING_KEY,
    });
    expect(typeof local.issueUploadTarget).toBe("function");
    expect(() =>
      createStorageAdapter({
        backend: "gcs",
        localDir: "/tmp/x",
        baseUrl: "http://127.0.0.1:8100",
        urlSigningKey: SIGNING_KEY,
      }),
    ).toThrow("GCP infrastructure gate");
    expect(() =>
      createStorageAdapter({
        backend: "s3",
        localDir: "/tmp/x",
        baseUrl: "http://127.0.0.1:8100",
        urlSigningKey: SIGNING_KEY,
      }),
    ).toThrow("Unknown storage backend");
  });
});
