import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { createContentSignature, toEpochSec } from "./signing.js";
import {
  StorageWriteSizeExceededError,
  type IssueReadUrlInput,
  type IssueUploadTargetInput,
  type ObjectStat,
  type StorageAdapter,
  type WriteObjectInput,
  type WriteObjectStreamInput,
  type WriteObjectStreamResult,
} from "./types.js";

const HEADER_BYTES_LENGTH = 16;

function finishWriteStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
  });
}

function waitForDrain(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      stream.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      stream.off("drain", onDrain);
      reject(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

export interface LocalStorageConfig {
  readonly rootDir: string;
  /**
   * Base URL stamped into bearer-free content URLs. A thunk when the
   * address isn't known at construction (ephemeral test listeners);
   * production always passes a plain string.
   */
  readonly baseUrl: string | (() => string);
  readonly signingKey: string;
}

function resolveBaseUrl(baseUrl: string | (() => string)): string {
  return (typeof baseUrl === "function" ? baseUrl() : baseUrl).replace(/\/$/, "");
}

function resolveObjectPath(rootDir: string, storageKey: string): string {
  if (!storageKey || storageKey.startsWith("/") || storageKey.includes("..")) {
    throw new Error("Invalid storage key");
  }
  const resolved = path.resolve(rootDir, storageKey);
  const root = path.resolve(rootDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Invalid storage key");
  }
  return resolved;
}

function contentUrl(
  baseUrl: string | (() => string),
  signingKey: string,
  method: "PUT" | "GET",
  fileId: string,
  expiresAt: Date,
): string {
  const expiresEpochSec = toEpochSec(expiresAt);
  const signature = createContentSignature({
    signingKey,
    method,
    fileId,
    expiresEpochSec,
  });
  return `${resolveBaseUrl(baseUrl)}/api/v1/file-content/${fileId}?expires=${expiresEpochSec}&signature=${signature}`;
}

export function createLocalStorageAdapter(
  config: LocalStorageConfig,
): StorageAdapter {
  return {
    async issueUploadTarget(input: IssueUploadTargetInput) {
      return {
        url: contentUrl(
          config.baseUrl,
          config.signingKey,
          "PUT",
          input.fileId,
          input.expiresAt,
        ),
        requiredHeaders: { "Content-Type": input.contentType },
      };
    },

    async issueReadUrl(input: IssueReadUrlInput) {
      return {
        url: contentUrl(
          config.baseUrl,
          config.signingKey,
          "GET",
          input.fileId,
          input.expiresAt,
        ),
      };
    },

    async statObject(storageKey: string): Promise<ObjectStat | null> {
      const objectPath = resolveObjectPath(config.rootDir, storageKey);
      try {
        const stats = await stat(objectPath);
        if (!stats.isFile()) return null;
        return { exists: true, sizeBytes: stats.size };
      } catch (error: unknown) {
        if ((error as { code?: string }).code === "ENOENT") return null;
        throw error;
      }
    },

    async readObject(storageKey: string): Promise<Buffer> {
      return readFile(resolveObjectPath(config.rootDir, storageKey));
    },

    async writeObject(input: WriteObjectInput): Promise<void> {
      const objectPath = resolveObjectPath(config.rootDir, input.storageKey);
      await mkdir(path.dirname(objectPath), { recursive: true });
      await writeFile(objectPath, input.data);
    },

    /**
     * Phase 3D-C Task 3 fix round 2 (review: stream to storage incrementally,
     * hashing/counting as chunks flow, aborting at the limit). Never calls
     * Buffer.concat or otherwise materializes the whole body: each chunk is
     * hashed, counted, and written to the destination file as it arrives, with
     * real backpressure (awaiting "drain" when the write stream's internal
     * buffer is full). The instant the running total exceeds maxBytes, the
     * write stream is destroyed and the partial file deleted before
     * StorageWriteSizeExceededError is thrown -- no orphaned partial object.
     */
    async writeObjectStream(
      input: WriteObjectStreamInput,
      source: AsyncIterable<Buffer>,
    ): Promise<WriteObjectStreamResult> {
      const objectPath = resolveObjectPath(config.rootDir, input.storageKey);
      await mkdir(path.dirname(objectPath), { recursive: true });
      const hash = createHash("sha256");
      let sizeBytes = 0;
      let headerBytes = Buffer.alloc(0);
      const writeStream = createWriteStream(objectPath);
      try {
        for await (const chunk of source) {
          sizeBytes += chunk.byteLength;
          if (sizeBytes > input.maxBytes) {
            throw new StorageWriteSizeExceededError(input.maxBytes);
          }
          if (headerBytes.length < HEADER_BYTES_LENGTH) {
            headerBytes = Buffer.concat([headerBytes, chunk]).subarray(
              0,
              HEADER_BYTES_LENGTH,
            );
          }
          hash.update(chunk);
          if (!writeStream.write(chunk)) {
            await waitForDrain(writeStream);
          }
        }
        await finishWriteStream(writeStream);
      } catch (error) {
        // Wait for the underlying file descriptor to actually close before
        // deleting -- destroy() alone can race createWriteStream's own
        // async open, which would otherwise recreate an empty file right
        // after unlink() runs.
        await new Promise<void>((resolve) => {
          writeStream.once("close", resolve);
          writeStream.destroy();
        });
        await unlink(objectPath).catch(() => {});
        throw error;
      }
      return { sizeBytes, sha256Hex: hash.digest("hex"), headerBytes };
    },

    async moveObject(fromStorageKey: string, toStorageKey: string): Promise<void> {
      const fromPath = resolveObjectPath(config.rootDir, fromStorageKey);
      const toPath = resolveObjectPath(config.rootDir, toStorageKey);
      await mkdir(path.dirname(toPath), { recursive: true });
      await rename(fromPath, toPath);
    },

    async deleteObject(storageKey: string): Promise<void> {
      try {
        await unlink(resolveObjectPath(config.rootDir, storageKey));
      } catch (error: unknown) {
        if ((error as { code?: string }).code === "ENOENT") return;
        throw error;
      }
    },
  };
}
