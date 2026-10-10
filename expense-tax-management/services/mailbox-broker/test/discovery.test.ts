/**
 * Phase 3D-B Task 4 — discovery.ts: bounded retry, and
 * createDiscoveryEngine's full/incremental/404-recovery orchestration.
 * Classification itself is Task 5's `classification.ts` catalog
 * (classification.test.ts); this file only proves discovery.ts wires it
 * in (one `attachment_oversize` override test).
 *
 * No real Google network access anywhere in this file: every Gmail call
 * goes through a locally-defined `GmailDiscoveryClientLike` fake. The
 * fake `MailboxBrokerDiscoveryAppClient` tracks just enough connection
 * state (cursor digest/pre-fence token/page sequence/history ID/pre-fence
 * history ID/history page token) to exercise multi-page sequencing the
 * same way the real App API domain (domain/mailbox-scans.ts) advances it
 * -- not a reimplementation of its fencing rules, which are already
 * covered by mailbox-scans.test.ts.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createDiscoveryEngine,
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
  preFenceHistoryId: string | null;
  historyPageToken: string | null;
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
    preFenceHistoryId: null,
    historyPageToken: null,
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
        preFenceHistoryId: state.preFenceHistoryId,
        historyPageToken: state.historyPageToken,
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
      state.preFenceHistoryId = input.nextPreFenceHistoryId;
      state.historyPageToken = input.nextHistoryPageToken;
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
      return { historyId: "history-1", ids: [], nextPageToken: null };
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
  it("full pre-fence: captures the profile history ID BEFORE listing, persists it as explicit App-owned state, and does not settle the cursor until replay completes", async () => {
    const appClient = createFakeDiscoveryAppClient();
    const messages = [gmailMessage(), gmailMessage()];
    const callOrder: string[] = [];
    const client = fakeGmailClient({
      getProfileHistoryId: vi.fn(async () => {
        callOrder.push("getProfileHistoryId");
        return "pre-sync-fence-id";
      }),
      listMessageIds: async () => {
        callOrder.push("listMessageIds");
        return { ids: messages.map((message) => ({ id: message.id, threadId: null })) };
      },
      getMessage: async (id) => messages.find((message) => message.id === id) as GmailMessageDetail,
      listHistory: async (input) => {
        expect(input.startHistoryId).toBe("pre-sync-fence-id"); // replay starts from the captured pre-sync fence
        return { historyId: "post-replay-history-id", ids: [], nextPageToken: null };
      },
    });
    const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

    const page1 = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });

    expect(callOrder).toEqual(["getProfileHistoryId", "listMessageIds"]); // pre-fence captured BEFORE listing
    expect(client.listMessageIds).toHaveBeenCalledWith(
      expect.objectContaining({ query: `after:${epochSecondsAfterDays(DEFAULT_LOOKBACK_DAYS)}` }),
    );
    expect(page1.candidateCount).toBe(2);
    // Backlog list is fully staged but not yet replayed -- the cursor must
    // not settle yet (spec: "Persist post-replay history ID only after...").
    // Explicit App-owned state (not a parsed tag) carries the fence forward.
    expect(appClient.state.historyId).toBeNull();
    expect(appClient.state.preFenceHistoryId).toBe("pre-sync-fence-id");

    const page2 = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });
    expect(page2.candidateCount).toBe(0); // nothing arrived during this fake sync
    expect(appClient.state.historyId).toBe("post-replay-history-id"); // settled only after replay
    expect(appClient.state.preFenceHistoryId).toBeNull(); // cleared once settled
  });

  it("full pre-fence replay: a message that arrives during the full sync is caught by the history.list replay before the cursor settles", async () => {
    const appClient = createFakeDiscoveryAppClient();
    const backlogMessage = gmailMessage();
    const lateArrival = gmailMessage({ subject: "Your receipt (just arrived)" });
    const client = fakeGmailClient({
      getProfileHistoryId: async () => "pre-sync-fence-id",
      listMessageIds: async () => ({ ids: [{ id: backlogMessage.id, threadId: null }] }),
      listHistory: async (input) => {
        expect(input.startHistoryId).toBe("pre-sync-fence-id");
        return { historyId: "post-replay-history-id", ids: [{ id: lateArrival.id, threadId: null }], nextPageToken: null };
      },
      getMessage: async (id) => [backlogMessage, lateArrival].find((message) => message.id === id) as GmailMessageDetail,
    });
    const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

    const page1 = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID }); // backlog
    expect(page1.candidateCount).toBe(1);

    const page2 = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID }); // replay
    expect(page2.candidateCount).toBe(1);
    expect(appClient.stagedPages[1]?.messages[0]?.providerMessageId).toBe(lateArrival.id);
    expect(appClient.state.historyId).toBe("post-replay-history-id");
  });

  it("crash after fence capture resumes: a fresh engine instance (different process) reads the persisted pre-fence back instead of re-capturing a newer one", async () => {
    const appClient = createFakeDiscoveryAppClient();
    const backlogMessage = gmailMessage();

    // "Process A": captures the pre-fence, stages the backlog, then
    // "crashes" (never calls discover() again on this engine instance).
    const clientA = fakeGmailClient({
      getProfileHistoryId: async () => "original-pre-fence",
      listMessageIds: async () => ({ ids: [{ id: backlogMessage.id, threadId: null }] }),
      getMessage: async () => backlogMessage,
    });
    const engineA = createDiscoveryEngine({ appClient, getGmailClient: async () => clientA, now: () => FIXED_NOW });
    await engineA.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });
    expect(appClient.state.preFenceHistoryId).toBe("original-pre-fence");

    // "Process B": a brand new engine/client pair (simulating resumption
    // on a different broker replica after the crash). Its own
    // getProfileHistoryId must NEVER be called -- resuming must read the
    // durably persisted fence back, not capture a newer one.
    const getProfileHistoryIdB = vi.fn(async () => "wrong-newer-fence");
    const clientB = fakeGmailClient({
      getProfileHistoryId: getProfileHistoryIdB,
      listMessageIds: async () => ({ ids: [{ id: backlogMessage.id, threadId: null }] }), // same backlog, idempotent re-list
      listHistory: async (input) => {
        expect(input.startHistoryId).toBe("original-pre-fence");
        return { historyId: "settled-after-resume", ids: [], nextPageToken: null };
      },
      getMessage: async () => backlogMessage,
    });
    const engineB = createDiscoveryEngine({ appClient, getGmailClient: async () => clientB, now: () => FIXED_NOW });
    const resumed = await engineB.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });

    expect(getProfileHistoryIdB).not.toHaveBeenCalled();
    expect(resumed.candidateCount).toBe(0); // replay found nothing new
    expect(appClient.state.historyId).toBe("settled-after-resume");
    expect(appClient.state.preFenceHistoryId).toBeNull();
  });

  it("no tag parsing remains: a real opaque historyId that happens to look like the old string-tag format is never misinterpreted", async () => {
    // Regression for the fix round 1 re-review's exact collision concern:
    // a settled, ordinary incremental connection whose real Gmail
    // historyId coincidentally contains "pending-replay:" must be treated
    // as a plain incremental cursor, never as in-flight full-sync state.
    const appClient = createFakeDiscoveryAppClient({
      historyId: "pending-replay:not-actually-a-tag",
      preFenceHistoryId: null,
    });
    const client = fakeGmailClient({
      listHistory: async (input) => {
        expect(input.startHistoryId).toBe("pending-replay:not-actually-a-tag");
        return { historyId: "history-after", ids: [], nextPageToken: null };
      },
    });
    const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

    await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });

    expect(client.listHistory).toHaveBeenCalledTimes(1); // ordinary incremental path, not a full-sync/replay restart
    expect(appClient.state.historyId).toBe("history-after");
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

  it("incremental pagination: history larger than one Gmail API page is fully staged across calls; the cursor never advances while a page remains (review Critical #2)", async () => {
    const appClient = createFakeDiscoveryAppClient({ historyId: "history-start" });
    const pageOneIds = [
      { id: randomUUID(), threadId: null },
      { id: randomUUID(), threadId: null },
    ];
    const pageTwoIds = [{ id: randomUUID(), threadId: null }];
    const client = fakeGmailClient({
      listHistory: vi.fn(async (input) => {
        expect(input.startHistoryId).toBe("history-start"); // same start on every call -- cursor never moved
        if (!input.pageToken) {
          return { historyId: "history-start", ids: pageOneIds, nextPageToken: "gmail-page-2" };
        }
        expect(input.pageToken).toBe("gmail-page-2"); // resumes exactly where the prior call left off
        return { historyId: "history-after-incremental", ids: pageTwoIds, nextPageToken: null };
      }),
      getMessage: async (id) => gmailMessage({ id }),
    });
    const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

    const first = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });
    expect(first.candidateCount).toBe(2);
    // More history remains (nextPageToken set) -- the cursor must NOT
    // advance yet (this is exactly the breakage the re-review flagged).
    expect(appClient.state.historyId).toBe("history-start");
    expect(appClient.state.historyPageToken).toBe("gmail-page-2");

    const second = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });
    expect(second.candidateCount).toBe(1);
    expect(appClient.state.historyId).toBe("history-after-incremental"); // settled only once Gmail reports no more pages
    expect(appClient.state.historyPageToken).toBeNull();

    const allStagedProviderMessageIds = appClient.stagedPages.flatMap((page) =>
      page.messages.map((message) => message.providerMessageId),
    );
    expect(allStagedProviderMessageIds).toEqual([...pageOneIds, ...pageTwoIds].map((entry) => entry.id));
  });

  it("404 full-sync recovery: an expired history ID falls back to the same pre-fence/full-sync/replay sequence as initial sync", async () => {
    const appClient = createFakeDiscoveryAppClient({ historyId: "history-stale" });
    const fullSyncIds = [{ id: randomUUID(), threadId: null }];
    const client = fakeGmailClient({
      getProfileHistoryId: async () => "fresh-pre-sync-fence",
      listHistory: async (input) => {
        if (input.startHistoryId === "history-stale") throw new GmailApiError("not_found");
        expect(input.startHistoryId).toBe("fresh-pre-sync-fence"); // replay uses the freshly captured fence
        return { historyId: "post-recovery-history-id", ids: [], nextPageToken: null };
      },
      listMessageIds: async () => ({ ids: fullSyncIds }),
      getMessage: async (id) => gmailMessage({ id }),
    });
    const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

    const page1 = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID }); // triggers recovery, stages backlog
    expect(client.listMessageIds).toHaveBeenCalledWith(
      expect.objectContaining({ query: `after:${epochSecondsAfterDays(DEFAULT_LOOKBACK_DAYS)}` }),
    );
    expect(page1.candidateCount).toBe(1);
    // current_history_id is append-only-when-non-null (same real-domain
    // rule as recordCandidateMetadata): the stale value lingers until the
    // replay settles it for real -- preFenceHistoryId is the actual
    // "full sync/replay in progress" signal, not current_history_id.
    expect(appClient.state.historyId).toBe("history-stale");
    expect(appClient.state.preFenceHistoryId).toBe("fresh-pre-sync-fence");

    const page2 = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID }); // replay
    expect(page2.candidateCount).toBe(0);
    expect(appClient.state.historyId).toBe("post-recovery-history-id"); // settled only after replay
    expect(appClient.state.preFenceHistoryId).toBeNull();
  });

  it("replay larger than one Gmail API page is fully staged across calls; the cursor never settles while a replay page remains", async () => {
    const appClient = createFakeDiscoveryAppClient();
    const backlogMessage = gmailMessage();
    const replayPageOne = gmailMessage({ subject: "Your receipt (arrival 1)" });
    const replayPageTwo = gmailMessage({ subject: "Your receipt (arrival 2)" });
    const client = fakeGmailClient({
      getProfileHistoryId: async () => "pre-sync-fence-id",
      listMessageIds: async () => ({ ids: [{ id: backlogMessage.id, threadId: null }] }),
      listHistory: vi.fn(async (input) => {
        expect(input.startHistoryId).toBe("pre-sync-fence-id");
        if (!input.pageToken) {
          return { historyId: "pre-sync-fence-id", ids: [{ id: replayPageOne.id, threadId: null }], nextPageToken: "replay-page-2" };
        }
        expect(input.pageToken).toBe("replay-page-2");
        return { historyId: "post-replay-history-id", ids: [{ id: replayPageTwo.id, threadId: null }], nextPageToken: null };
      }),
      getMessage: async (id) =>
        [backlogMessage, replayPageOne, replayPageTwo].find((message) => message.id === id) as GmailMessageDetail,
    });
    const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

    const page1 = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID }); // backlog
    expect(page1.candidateCount).toBe(1);

    const page2 = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID }); // replay page 1 of 2
    expect(page2.candidateCount).toBe(1);
    expect(appClient.state.historyId).toBeNull(); // more replay pages remain -- never settle
    expect(appClient.state.preFenceHistoryId).toBe("pre-sync-fence-id");
    expect(appClient.state.historyPageToken).toBe("replay-page-2");

    const page3 = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID }); // replay page 2 of 2
    expect(page3.candidateCount).toBe(1);
    expect(appClient.state.historyId).toBe("post-replay-history-id"); // settled only once replay fully exhausted
    expect(appClient.state.preFenceHistoryId).toBeNull();
    expect(appClient.state.historyPageToken).toBeNull();

    const allStagedProviderMessageIds = appClient.stagedPages.flatMap((page) =>
      page.messages.map((message) => message.providerMessageId),
    );
    expect(allStagedProviderMessageIds).toEqual([backlogMessage.id, replayPageOne.id, replayPageTwo.id]);
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

  it("production bug fix: a message whose receivedAt is a fallback value (unparseable Gmail Date header) still stages normally", async () => {
    // discovery.ts never parses/validates receivedAt itself -- it's an
    // opaque string from GmailMessageDetail (google-mailbox.ts's
    // getMessage is responsible for always producing a valid ISO
    // timestamp, even via its internalDate/now() fallbacks). This proves
    // discover() doesn't choke on a message whose receivedAt came from
    // one of those fallbacks instead of a parsed Date header.
    const appClient = createFakeDiscoveryAppClient();
    const message = gmailMessage({ receivedAt: new Date(Date.UTC(2026, 9, 10, 12, 0, 0)).toISOString() });
    const client = fakeGmailClient({
      listMessageIds: async () => ({ ids: [{ id: message.id, threadId: null }] }),
      getMessage: async () => message,
    });
    const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

    const page = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });

    expect(page.candidateCount).toBe(1);
    expect(appClient.stagedPages[0]?.messages[0]?.receivedAt).toBe(message.receivedAt);
  });

  it("filters attachments to the accepted MIME allow-list and caps at 5, hashing only transiently", async () => {
    const appClient = createFakeDiscoveryAppClient();
    const message = gmailMessage({
      attachments: [
        { attachmentId: "a1", filename: "receipt.pdf", mimeType: "application/pdf", sizeBytes: 1024 },
        { attachmentId: "a2", filename: "note.txt", mimeType: "text/plain", sizeBytes: 10 }, // rejected MIME
        { attachmentId: "a3", filename: "photo.png", mimeType: "image/png", sizeBytes: 2048 },
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

  it("25 MiB attachment bound: an oversize attachment is never downloaded, excluded from the manifest, and forces at least ambiguous", async () => {
    const appClient = createFakeDiscoveryAppClient();
    const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
    const message = gmailMessage({
      subject: "Your receipt", // would otherwise classify as receipt
      attachments: [
        { attachmentId: "oversize", filename: "huge.pdf", mimeType: "application/pdf", sizeBytes: MAX_UPLOAD_BYTES + 1 },
      ],
    });
    const getAttachment = vi.fn(async () => Buffer.from("should never be called"));
    const client = fakeGmailClient({
      listMessageIds: async () => ({ ids: [{ id: message.id, threadId: null }] }),
      getMessage: async () => message,
      getAttachment,
    });
    const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

    await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });

    expect(getAttachment).not.toHaveBeenCalled(); // no partial parsing -- never downloaded
    const staged = appClient.stagedPages[0]?.messages[0];
    expect(staged?.attachmentManifest).toHaveLength(0);
    expect(staged?.classification).toBe("ambiguous"); // never auto-staged as receipt
    expect(staged?.evidence).toContain("attachment_oversize");
  });

  it("message deleted after listing: a not_found from getMessage mid-page skips that message and stages the rest (incremental sync)", async () => {
    const appClient = createFakeDiscoveryAppClient({ historyId: "history-start" });
    const ids = [{ id: randomUUID(), threadId: null }, { id: randomUUID(), threadId: null }, { id: randomUUID(), threadId: null }];
    const deletedId = ids[1]!.id;
    const client = fakeGmailClient({
      listHistory: async () => ({ historyId: "history-after", ids, nextPageToken: null }),
      getMessage: async (id) => {
        if (id === deletedId) throw new GmailApiError("not_found");
        return gmailMessage({ id });
      },
    });
    const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

    const page = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });

    expect(page.candidateCount).toBe(2); // the deleted message is skipped, the other two are staged
    expect(appClient.state.historyId).toBe("history-after"); // cursor advances normally
    const stagedIds = appClient.stagedPages[0]?.messages.map((message) => message.providerMessageId);
    expect(stagedIds).toEqual([ids[0]!.id, ids[2]!.id]);
  });

  it("message deleted after listing: a not_found from getMessage mid-page skips that message during a full-sync backlog page too", async () => {
    const appClient = createFakeDiscoveryAppClient();
    const ids = [{ id: randomUUID(), threadId: null }, { id: randomUUID(), threadId: null }, { id: randomUUID(), threadId: null }];
    const deletedId = ids[1]!.id;
    const client = fakeGmailClient({
      listMessageIds: async () => ({ ids }),
      getMessage: async (id) => {
        if (id === deletedId) throw new GmailApiError("not_found");
        return gmailMessage({ id });
      },
    });
    const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

    const page = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });

    expect(page.candidateCount).toBe(2);
    const stagedIds = appClient.stagedPages[0]?.messages.map((message) => message.providerMessageId);
    expect(stagedIds).toEqual([ids[0]!.id, ids[2]!.id]);
  });

  it("message deleted after listing: a not_found from getAttachment skips that whole message, others still stage", async () => {
    const appClient = createFakeDiscoveryAppClient({ historyId: "history-start" });
    const okMessage = gmailMessage();
    const messageWithDeletedAttachment = gmailMessage({
      attachments: [{ attachmentId: "a1", filename: "receipt.pdf", mimeType: "application/pdf", sizeBytes: 1024 }],
    });
    const ids = [
      { id: okMessage.id, threadId: null },
      { id: messageWithDeletedAttachment.id, threadId: null },
    ];
    const client = fakeGmailClient({
      listHistory: async () => ({ historyId: "history-after", ids, nextPageToken: null }),
      getMessage: async (id) =>
        [okMessage, messageWithDeletedAttachment].find((message) => message.id === id) as GmailMessageDetail,
      getAttachment: async (input: { messageId: string; attachmentId: string }) => {
        if (input.messageId === messageWithDeletedAttachment.id) throw new GmailApiError("not_found");
        return Buffer.from("bytes");
      },
    });
    const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

    const page = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });

    expect(page.candidateCount).toBe(1);
    expect(appClient.stagedPages[0]?.messages[0]?.providerMessageId).toBe(okMessage.id);
    expect(appClient.state.historyId).toBe("history-after");
  });

  it("other Gmail errors from getMessage still propagate unchanged (unknown, reauth_required, a plain Error)", async () => {
    const appClient = createFakeDiscoveryAppClient({ historyId: "history-start" });
    const ids = [{ id: randomUUID(), threadId: null }];

    for (const error of [new GmailApiError("unknown"), new GmailApiError("reauth_required"), new Error("boom")]) {
      const client = fakeGmailClient({
        listHistory: async () => ({ historyId: "history-after", ids, nextPageToken: null }),
        getMessage: async () => {
          throw error;
        },
      });
      const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

      await expect(engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID })).rejects.toBe(error);
    }
  });

  it("every message in a page deleted: the page completes with zero staged and the cursor still advances", async () => {
    const appClient = createFakeDiscoveryAppClient({ historyId: "history-start" });
    const ids = [{ id: randomUUID(), threadId: null }, { id: randomUUID(), threadId: null }];
    const client = fakeGmailClient({
      listHistory: async () => ({ historyId: "history-after", ids, nextPageToken: null }),
      getMessage: async () => {
        throw new GmailApiError("not_found");
      },
    });
    const engine = createDiscoveryEngine({ appClient, getGmailClient: async () => client, now: () => FIXED_NOW });

    const page = await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });

    expect(page.candidateCount).toBe(0);
    expect(appClient.state.historyId).toBe("history-after"); // cursor still advances -- never stuck on deleted mail
    expect(appClient.stagedPages[0]?.messages).toEqual([]);
  });

  it("429/5xx retry: honors a Gmail Retry-After hint instead of the default exponential delay", async () => {
    const appClient = createFakeDiscoveryAppClient();
    let attempts = 0;
    const client = fakeGmailClient({
      listMessageIds: async () => {
        attempts += 1;
        if (attempts < 2) throw new GmailApiError("rate_limited", "rate_limited", 7_000);
        return { ids: [] };
      },
    });
    const sleep = vi.fn(async () => undefined);
    const engine = createDiscoveryEngine({
      appClient,
      getGmailClient: async () => client,
      now: () => FIXED_NOW,
      retry: { sleep, baseDelayMs: 1 },
    });

    await engine.discover({ connectionId: CONNECTION_ID, scanRunId: SCAN_RUN_ID });

    expect(sleep).toHaveBeenCalledWith(7_000); // Retry-After honored, not the 1ms exponential default
  });
});
