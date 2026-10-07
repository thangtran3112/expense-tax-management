/**
 * Web session wiring design (2026-10-06) -- createFilesDomain's
 * issueWorkerReadUrl must issue its read URL through the injected
 * `workerStorage` adapter (production: STORAGE_INTERNAL_BASE_URL) when
 * provided, and fall back to the browser-facing `storage` adapter
 * (today's behavior) when it is not. A hand-rolled fluent fake stands in
 * for Kysely here -- this is a pure wiring test, not a query test (the
 * query itself is already covered by the live-PostgreSQL files.ts
 * integration suites), so it only needs to answer the two calls
 * issueWorkerReadUrl actually makes: the expense_files lookup and the
 * audit-event insert.
 */
import { describe, expect, it, vi } from "vitest";
import type { Kysely, Transaction } from "kysely";

import { createFilesDomain } from "../src/domain/files.js";
import type { AppDatabase } from "../src/database/types.js";
import type { StorageAdapter } from "../src/storage/types.js";

const FILE_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  personal_profile_id: null,
  business_id: null,
  expense_id: null,
  original_filename: "receipt.jpg",
  content_type: "image/jpeg",
  size_bytes: 10,
  sha256_hex: "a".repeat(64),
  storage_key: "tenants/t/originals/f/receipt.jpg",
  thumbnail_storage_key: null,
  thumbnail_status: "skipped",
  status: "READY",
  version: 1,
  created_at: new Date(),
  updated_at: new Date(),
};

function fakeDatabase() {
  const builder = {
    selectFrom: () => builder,
    selectAll: () => builder,
    where: () => builder,
    executeTakeFirst: async () => FILE_ROW,
    insertInto: () => builder,
    values: () => builder,
    execute: async () => undefined,
  };
  const database = {
    transaction: () => ({
      execute: (callback: (transaction: Transaction<AppDatabase>) => unknown) =>
        callback(builder as unknown as Transaction<AppDatabase>),
    }),
  } as unknown as Kysely<AppDatabase>;
  return database;
}

function fakeStorageAdapter(url: string): StorageAdapter {
  return {
    issueUploadTarget: vi.fn(),
    issueReadUrl: vi.fn(async () => ({ url })),
    statObject: vi.fn(),
    readObject: vi.fn(),
    writeObject: vi.fn(),
    writeObjectStream: vi.fn(),
    moveObject: vi.fn(),
    deleteObject: vi.fn(),
  } as unknown as StorageAdapter;
}

describe("createFilesDomain issueWorkerReadUrl storage selection", () => {
  it("issues through workerStorage when provided, never through the browser-facing adapter", async () => {
    const browserStorage = fakeStorageAdapter("https://expense-api.example/api/v1/file-content/x");
    const workerStorage = fakeStorageAdapter("http://app-api:8100/api/v1/file-content/x");
    const filesDomain = createFilesDomain(fakeDatabase(), browserStorage, {
      mailboxScanner: { scanStagedObject: vi.fn() },
      workerStorage,
    });

    const result = await filesDomain.issueWorkerReadUrl({
      fileId: FILE_ROW.id,
      actorServicePrincipal: "ai-worker",
      requestId: "req-1",
    });

    expect(result.url).toBe("http://app-api:8100/api/v1/file-content/x");
    expect(workerStorage.issueReadUrl).toHaveBeenCalledOnce();
    expect(browserStorage.issueReadUrl).not.toHaveBeenCalled();
  });

  it("falls back to the browser-facing adapter when workerStorage is omitted (today's behavior)", async () => {
    const browserStorage = fakeStorageAdapter("https://expense-api.example/api/v1/file-content/x");
    const filesDomain = createFilesDomain(fakeDatabase(), browserStorage, {
      mailboxScanner: { scanStagedObject: vi.fn() },
    });

    const result = await filesDomain.issueWorkerReadUrl({
      fileId: FILE_ROW.id,
      actorServicePrincipal: "ai-worker",
      requestId: "req-1",
    });

    expect(result.url).toBe("https://expense-api.example/api/v1/file-content/x");
    expect(browserStorage.issueReadUrl).toHaveBeenCalledOnce();
  });
});
