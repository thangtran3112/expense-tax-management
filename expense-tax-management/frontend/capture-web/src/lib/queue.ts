import { openDB, type DBSchema } from "idb";

export type QueueStatus = "queued" | "uploading" | "processing" | "review" | "failed";

export interface QueueItem {
  id: string;
  file: Blob;
  filename: string;
  contentType: string;
  modeKey: "ocr_mode_fast" | "ocr_mode_balanced" | "ocr_mode_accurate";
  status: QueueStatus;
  progress: number;
  error: string | null;
  fileId: string | null;
  jobId: string | null;
  createdAt: string;
}

interface CaptureDb extends DBSchema {
  queue: { key: string; value: QueueItem; indexes: { "by-created": string } };
}

function db() {
  return openDB<CaptureDb>("expense-tax-capture", 1, {
    upgrade(database) {
      const store = database.createObjectStore("queue", { keyPath: "id" });
      store.createIndex("by-created", "createdAt");
    },
  });
}

export async function enqueue(file: File, modeKey: QueueItem["modeKey"]): Promise<QueueItem> {
  const item: QueueItem = {
    id: crypto.randomUUID(),
    file,
    filename: file.name || `capture-${Date.now()}.jpg`,
    contentType: file.type,
    modeKey,
    status: "queued",
    progress: 0,
    error: null,
    fileId: null,
    jobId: null,
    createdAt: new Date().toISOString(),
  };
  await (await db()).put("queue", item);
  return item;
}

export async function listQueue(): Promise<QueueItem[]> {
  return (await (await db()).getAllFromIndex("queue", "by-created")).reverse();
}

export async function getQueueItem(id: string): Promise<QueueItem | undefined> {
  return (await db()).get("queue", id);
}

export async function updateQueue(item: QueueItem): Promise<void> {
  await (await db()).put("queue", item);
}

export async function removeQueue(id: string): Promise<void> {
  await (await db()).delete("queue", id);
}
