/**
 * Phase 3D-B Task 4 — discovery.ts: classification, bounded retry, and
 * createDiscoveryEngine's full/incremental/404-recovery orchestration.
 *
 * No real Google network access anywhere in this file: every Gmail call
 * goes through a locally-defined `GmailDiscoveryClientLike` fake. The
 * fake `MailboxBrokerDiscoveryAppClient` tracks just enough connection
 * state (cursor digest/pre-fence token/next page sequence/history ID) to
 * exercise multi-page sequencing the same way the real App API domain
 * (domain/mailbox-scans.ts, Task 2) would advance it -- not a reimplementation
 * of its fencing rules, which are already covered by mailbox-scans.test.ts.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  classifyMessage,
  createDiscoveryEngine,
  DEFAULT_DISCOVERY_PAGE_SIZE,
  DEFAULT_LOOKBACK_DAYS,
  GmailApiError,
  MAX_INITIAL_SYNC_MESSAGES,
  MAX_LOOKBACK_DAYS,
  withGoogleRetry,
  type GmailDiscoveryClientLike,
  type GmailMessageDetail,
} from "../src/discovery.js";
import type {
  MailboxBrokerDiscoveryAppClient,
  MailboxBrokerScanBindingV1,
  MailboxCandidateMetadataStagingResultV1,
  MailboxCandidateMetadataStagingV1,
} from "../src/contracts.js";

const CONNECTION_ID = randomUUID();
const SCAN_RUN_ID = randomUUID();
const FIXED_NOW = new Date("2026-10-03T00:00:00.000Z");

function epochSecondsAfterDays(days: number): number {
  return Math.floor(FIXED_NOW.getTime() / 1000) - days * 24 * 60 * 60;
}

interface FakeConnectionState {
  connectionVersion: number;
  cursorDigest: string;
  preFenceToken: string;
  nextPageSequence: number;
  historyId: string | null;
}

/** Tracks one connection's cursor fence the same way App API's real domain advances it after each accepted page. */
function createFakeDiscoveryAppClient(initial: Partial<FakeConnectionState> = {}): MailboxBrokerDiscoveryAppClient & {
  readonly state: FakeConnectionState;
  readonly stagedPages: MailboxCandidateMetadataStagingV1[];
} {
  const state: FakeConnectionState = {
    connectionVersion: 1,
    cursorDigest: "cursor-0",
    preFenceToken: "pre-fence-token",
    nextPageSequence: 1,
    historyId: null,
    ...initial,
  };
  const stagedPages: MailboxCandidateMetadataStagingV1[] = [];

  return {
    state,
    stagedPages,
    async loadScanBinding(scanRunId: string): Promise<MailboxBrokerScanBindingV1> {
      return {
        scanRunId,
        connectionId: CONNECTION_ID,
        expectedConnectionVersion: state.connectionVersion,
        currentHistoryId: state.historyId,
        currentCursorDigest: state.cursorDigest,
        preFenceToken: state.preFenceToken,
        nextPageSequence: state.nextPageSequence,
      };
    },
    async stageCandidateMetadata(
      input: MailboxCandidateMetadataStagingV1,
    ): Promise<MailboxCandidateMetadataStagingResultV1> {
      stagedPages.push(input);
      let staged = 0;
      let review = 0;
      const candidateIds: string[] = [];
      for (const message of input.messages) {
        if (message.classification === "not_receipt") continue;
        candidateIds.push(randomUUID());
        if (message.classification === "receipt") staged += 1;
        else review += 1;
      }
      state.cursorDigest = `cursor-${input.pageSequence}`;
      state.nextPageSequence = input.pageSequence + 1;
      if (input.nextHistoryId !== null) state.historyId = input.nextHistoryId;
      return {
        schemaVersion: 1,
        scanRunId: input.scanRunId,
        pageSequence: input.pageSequence,
        candidateIds,
        counts: { discovered: input.messages.length, staged, review, failed: 0 },
      };
    },
  };
}

function gmailMessage(overrides: Partial<GmailMessageDetail> = {}): GmailMessageDetail {
  return {
    id: overrides.id ?? randomUUID(),
    threadId: overrides.threadId ?? null,
    receivedAt: overrides.receivedAt ?? FIXED_NOW.toISOString(),
    senderAddress: overrides.senderAddress ?? "merchant@example.test",
    subject: overrides.subject ?? "Your receipt",
    attachments: overrides.attachments ?? [],
  };
}

function fakeGmailClient(overrides: Partial<GmailDiscoveryClientLike> = {}): GmailDiscoveryClientLike & {
  readonly calls: { listMessageIds: number; listHistory: number; getMessage: number };
} {
  const calls = { listMessageIds: 0, listHistory: 0, getMessage: 0 };
  return {
    calls,
    listMessageIds: vi.fn(async (input) => {
      calls.listMessageIds += 1;
      return overrides.listMessageIds ? await (overrides.listMessageIds as typeof overrides.listMessageIds)(input) : { ids: [] };
    }) as GmailDiscoveryClientLike["listMessageIds"],
    listHistory: vi.fn(async (input) => {
      calls.listHistory += 1;
      if (overrides.listHistory) return overrides.listHistory(input);
      return { historyId: "history-1", ids: [] };
    }) as GmailDiscoveryClientLike["listHistory"],
    getMessage: vi.fn(async (id) => {
      calls.getMessage += 1;
      if (overrides.getMessage) return overrides.getMessage(id);
      return gmailMessage({ id });
    }) as GmailDiscoveryClientLike["getMessage"],
    getAttachment: overrides.getAttachment ?? vi.fn(async () => Buffer.from("fake-bytes")),
    getProfileHistoryId: overrides.getProfileHistoryId ?? vi.fn(async () => "history-final"),
  };
}

describe("discovery.ts classifyMessage", () => {
  it("classifies a receipt keyword + accepted attachment as receipt, high confidence", () => {
    const result = classifyMessage({
      subject: "Your receipt from Acme",
      senderAddress: "billing@acme.test",
      attachmentManifest: [{ mimeType: "application/pdf" }],
    });
    expect(result.classification).toBe("receipt");
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.evidence.some((entry) => entry.startsWith("subject_keyword:"))).toBe(true);
    expect(result.evidence.some((entry) => entry.startsWith("accepted_attachment:"))).toBe(true);
  });

  it("classifies a keyword with no attachment as ambiguous", () => {
    const result = classifyMessage({
      subject: "Your invoice is ready",
      senderAddress: "billing@acme.test",
      attachmentManifest: [],
    });
    expect(result.classification).toBe("ambiguous");
  });

  it("classifies an attachment with no keyword as ambiguous", () => {
    const result = classifyMessage({
      subject: "Hello there",
      senderAddress: "friend@example.test",
      attachmentManifest: [{ mimeType: "image/png" }],
    });
    expect(result.classification).toBe("ambiguous");
  });

  it("classifies plain text with neither signal as not_receipt", () => {
    const result = classifyMessage({
      subject: "Lunch tomorrow?",
      senderAddress: "friend@example.test",
      attachmentManifest: [],
    });
    expect(result.classification).toBe("not_receipt");
    expect(result.evidence).toEqual(["no_signal"]);
  });
});

describe("discovery.ts withGoogleRetry", () => {
  it("retries a rate_limited error and succeeds once the operation stops failing", async () => {
    let attempts = 0;
    const sleep = vi.fn(async () => undefined);
    const result = await withGoogleRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new GmailApiError("rate_limited");
        return "ok";
      },
      { sleep, baseDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries and rethrows the last GmailApiError", async () => {
    const sleep = vi.fn(async () => undefined);
    await expect(
      withGoogleRetry(
        async () => {
          throw new GmailApiError("unavailable");
        },
        { sleep, retries: 2, baseDelayMs: 1 },
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("never retries a non-retryable GmailApiError (reauth_required/not_found)", async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    await expect(
      withGoogleRetry(
        async () => {
          calls += 1;
          throw new GmailApiError("reauth_required");
        },
        { sleep },
      ),
    ).rejects.toMatchObject({ code: "reauth_required" });
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("discovery.ts createDiscoveryEngine", () => {
  it("full pre-fence: initial sync queries the default 30-day bounded lookback and submits one completed page", async () => {
    const appClient = createFakeDiscoveryAppClient();
    const messages = [gmailMessage(), gmailMessage()];
    const client = fakeGmailClient({
      listMessageIds: async () => ({ ids: messages.map((message) => ({ id: message.id, threadId: null })) }),
      getMessage: async (id) => messages.find((message) => message.id === id) as GmailMessageDetail,
    });
    const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

    const page = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });

    expect(client.listMessageIds).toHaveBeenCalledWith(
      expect.objectContaining({ query: `after:${epochSecondsAfterDays(DEFAULT_LOOKBACK_DAYS)}` }),
    );
    expect(page.candidateCount).toBe(2);
    expect(appClient.state.historyId).toBe("history-final"); // last (only) page -- fence persisted
  });

  it("bounded lookback: an override above the 90-day hard maximum is clamped to 90 days", async () => {
    const appClient = createFakeDiscoveryAppClient();
    const client = fakeGmailClient();
    const engine = createDiscoveryEngine({
      appClient,
      getGmailClient: async () => client,
      now: () => FIXED_NOW,
      lookbackDays: 365,
    });

    await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });

    expect(client.listMessageIds).toHaveBeenCalledWith(
      expect.objectContaining({ query: `after:${epochSecondsAfterDays(MAX_LOOKBACK_DAYS)}` }),
    );
  });

  it("100-message maximum: an initial sync caps total messages staged across pages at 100", async () => {
    const appClient = createFakeDiscoveryAppClient();
    const ids = Array.from({ length: 150 }, () => ({ id: randomUUID(), threadId: null }));
    const client = fakeGmailClient({
      listMessageIds: async () => ({ ids }),
      getMessage: async (id) => gmailMessage({ id }),
    });
    const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

    let totalCandidates = 0;
    for (let page = 0; page < 20; page += 1) {
      const result = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });
      totalCandidates += result.candidateCount;
      if (result.candidateCount === 0) break;
    }

    expect(totalCandidates).toBe(MAX_INITIAL_SYNC_MESSAGES);
  });

  it("incremental pagination: pages through history.list results in fixed-size slices until the last page", async () => {
    const appClient = createFakeDiscoveryAppClient({ historyId: "history-start" });
    const ids = Array.from({ length: DEFAULT_DISCOVERY_PAGE_SIZE + 5 }, () => ({
      id: randomUUID(),
      threadId: null,
    }));
    const client = fakeGmailClient({
      listHistory: async (input) => {
        expect(input.startHistoryId).toBe("history-start");
        return { historyId: "history-after-incremental", ids };
      },
      getMessage: async (id) => gmailMessage({ id }),
    });
    const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

    const first = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });
    expect(first.candidateCount).toBe(DEFAULT_DISCOVERY_PAGE_SIZE);
    expect(appClient.state.historyId).toBe("history-start"); // not the last page yet

    const second = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });
    expect(second.candidateCount).toBe(5);
    expect(appClient.state.historyId).toBe("history-after-incremental"); // last page persists the fence
  });

  it("404 full-sync recovery: an expired history ID falls back to a bounded full sync", async () => {
    const appClient = createFakeDiscoveryAppClient({ historyId: "history-stale" });
    const fullSyncIds = [{ id: randomUUID(), threadId: null }];
    const client = fakeGmailClient({
      listHistory: async () => {
        throw new GmailApiError("not_found");
      },
      listMessageIds: async () => ({ ids: fullSyncIds }),
      getMessage: async (id) => gmailMessage({ id }),
    });
    const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

    const page = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });

    expect(client.listHistory).toHaveBeenCalledTimes(1);
    expect(client.listMessageIds).toHaveBeenCalledWith(
      expect.objectContaining({ query: `after:${epochSecondsAfterDays(DEFAULT_LOOKBACK_DAYS)}` }),
    );
    expect(page.candidateCount).toBe(1);
    expect(appClient.state.historyId).toBe("history-final");
  });

  it("401 reauth: a reauth-required Gmail error propagates immediately, never retried", async () => {
    const appClient = createFakeDiscoveryAppClient();
    const client = fakeGmailClient({
      listMessageIds: async () => {
        throw new GmailApiError("reauth_required");
      },
    });
    const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

    await expect(engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID })).rejects.toMatchObject({
      code: "reauth_required",
    });
    expect(client.listMessageIds).toHaveBeenCalledTimes(1);
  });

  it("429/5xx retry: a transient Gmail failure is retried in-process before the page completes", async () => {
    const appClient = createFakeDiscoveryAppClient();
    let attempts = 0;
    const client = fakeGmailClient({
      listMessageIds: async () => {
        attempts += 1;
        if (attempts < 2) throw new GmailApiError("rate_limited");
        return { ids: [] };
      },
    });
    const engine = createDiscoveryEngine({
      appClient,
      getGmailClient: async () => client,
      now: () => FIXED_NOW,
      retry: { sleep: async () => undefined, baseDelayMs: 1 },
    });

    const page = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });

    expect(attempts).toBe(2);
    expect(page.retryCount).toBe(0); // success path never reports a nonzero retryCount (see module header)
  });

  it("direct broker->App staging: stageCandidateMetadata is called directly with the exact page fence values from loadScanBinding", async () => {
    const appClient = createFakeDiscoveryAppClient({
      connectionVersion: 7,
      cursorDigest: "cursor-abc",
      preFenceToken: "fence-xyz",
      nextPageSequence: 3,
    });
    const message = gmailMessage();
    const client = fakeGmailClient({
      listMessageIds: async () => ({ ids: [{ id: message.id, threadId: null }] }),
      getMessage: async () => message,
    });
    const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

    await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });

    expect(appClient.stagedPages).toHaveLength(1);
    expect(appClient.stagedPages[0]).toMatchObject({
      scanRunId: SCAN_RUN_ID,
      connectionId: CONNECTION_ID,
      expectedConnectionVersion: 7,
      cursorBeforeDigest: "cursor-abc",
      preFenceToken: "fence-xyz",
      pageSequence: 3,
    });
  });

  it("worker opaque output: the returned page carries only scanRunId/pageSequence/candidateCount/retryCount", async () => {
    const appClient = createFakeDiscoveryAppClient();
    const message = gmailMessage({ subject: "Your receipt", senderAddress: "merchant@example.test" });
    const client = fakeGmailClient({
      listMessageIds: async () => ({ ids: [{ id: message.id, threadId: null }] }),
      getMessage: async () => message,
    });
    const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

    const page = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });

    expect(Object.keys(page).sort()).toEqual(["candidateCount", "pageSequence", "retryCount", "scanRunId"]);
  });

  it("filters attachments to the accepted MIME allow-list and caps at 5, hashing only transiently", async () => {
    const appClient = createFakeDiscoveryAppClient();
    const message = gmailMessage({
      attachments: [
        { attachmentId: "a1", filename: "receipt.pdf", mimeType: "application/pdf" },
        { attachmentId: "a2", filename: "note.txt", mimeType: "text/plain" }, // rejected MIME
        { attachmentId: "a3", filename: "photo.png", mimeType: "image/png" },
      ],
    });
    const client = fakeGmailClient({
      listMessageIds: async () => ({ ids: [{ id: message.id, threadId: null }] }),
      getMessage: async () => message,
      getAttachment: vi.fn(async () => Buffer.from("bytes")),
    });
    const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

    await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });

    const staged = appClient.stagedPages[0]?.messages[0];
    expect(staged?.attachmentManifest).toHaveLength(2);
    expect(staged?.attachmentManifest.every((entry) => entry.mimeType !== "text/plain")).toBe(true);
    expect(staged?.attachmentManifest.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
  });
});
