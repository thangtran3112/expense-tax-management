// @vitest-environment jsdom
import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { enqueue, listQueue } from "./queue";
import type { CaptureSession } from "./session";

vi.mock("./api", () => ({ uploadQueuedReceipt: vi.fn() }));
import { uploadQueuedReceipt } from "./api";
import { processQueueItem, processQueuedItems } from "./upload-processor";

const session: CaptureSession = {
  apiBaseUrl: "http://app.test",
  tenantId: "tenant-1",
  scope: { kind: "personal", profileId: "profile-1", label: "Personal" },
};
const getToken = vi.fn().mockResolvedValue("tok");

describe("processQueueItem", () => {
  beforeEach(async () => {
    vi.mocked(uploadQueuedReceipt).mockReset();
    for (const item of await listQueue()) {
      await import("./queue").then((m) => m.removeQueue(item.id));
    }
  });

  it("marks the item processing with fileId/jobId on success", async () => {
    vi.mocked(uploadQueuedReceipt).mockResolvedValue({ fileId: "file-1", jobId: "job-1" });
    const item = await enqueue(new File(["x"], "r.jpg", { type: "image/jpeg" }), "ocr_mode_balanced");

    await processQueueItem(session, item, getToken, "org_1");

    const [updated] = await listQueue();
    expect(updated).toMatchObject({ status: "processing", fileId: "file-1", jobId: "job-1", error: null });
  });

  it("marks the item failed with the error message, never throwing", async () => {
    vi.mocked(uploadQueuedReceipt).mockRejectedValue(new Error("network down"));
    const item = await enqueue(new File(["x"], "r.jpg", { type: "image/jpeg" }), "ocr_mode_balanced");

    await expect(processQueueItem(session, item, getToken, "org_1")).resolves.toBeUndefined();

    const [updated] = await listQueue();
    expect(updated).toMatchObject({ status: "failed", error: "network down" });
  });

  it("is a no-op while offline, leaving the item queued", async () => {
    const item = await enqueue(new File(["x"], "r.jpg", { type: "image/jpeg" }), "ocr_mode_balanced");
    const spy = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);

    await processQueueItem(session, item, getToken, "org_1");

    expect(uploadQueuedReceipt).not.toHaveBeenCalled();
    const [updated] = await listQueue();
    expect(updated).toMatchObject({ status: "queued" });
    spy.mockRestore();
  });
});

describe("processQueuedItems", () => {
  beforeEach(async () => {
    vi.mocked(uploadQueuedReceipt).mockReset();
    for (const item of await listQueue()) {
      await import("./queue").then((m) => m.removeQueue(item.id));
    }
  });

  it("processes every queued item sequentially, one failure does not stop the rest", async () => {
    vi.mocked(uploadQueuedReceipt)
      .mockRejectedValueOnce(new Error("first failed"))
      .mockResolvedValueOnce({ fileId: "file-2", jobId: "job-2" });
    const first = await enqueue(new File(["x"], "a.jpg", { type: "image/jpeg" }), "ocr_mode_balanced");
    const second = await enqueue(new File(["x"], "b.jpg", { type: "image/jpeg" }), "ocr_mode_balanced");

    await processQueuedItems([first, second], session, getToken, "org_1");

    const items = await listQueue();
    expect(items.find((i) => i.id === first.id)).toMatchObject({ status: "failed", error: "first failed" });
    expect(items.find((i) => i.id === second.id)).toMatchObject({ status: "processing", fileId: "file-2" });
  });

  it("skips non-queued items", async () => {
    const processing = await enqueue(new File(["x"], "c.jpg", { type: "image/jpeg" }), "ocr_mode_balanced");
    await import("./queue").then((m) => m.updateQueue({ ...processing, status: "processing" }));

    await processQueuedItems([{ ...processing, status: "processing" }], session, getToken, "org_1");

    expect(uploadQueuedReceipt).not.toHaveBeenCalled();
  });

  it("is a no-op with no session", async () => {
    const item = await enqueue(new File(["x"], "d.jpg", { type: "image/jpeg" }), "ocr_mode_balanced");
    await processQueuedItems([item], null, getToken, "org_1");
    expect(uploadQueuedReceipt).not.toHaveBeenCalled();
  });
});
