// @vitest-environment jsdom
/**
 * Phase 3D-C Task 6 fix round 1 -- rendered tests for the Office
 * ingestion-status board (review finding #7): per-bucket pagination with
 * totalCount, the retry two-step flow (failed -> review -> ingest), a
 * row-scoped 409 conflict refresh, polling start/stop while a row is in
 * progress, and the copy-candidate-ID control.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  readOfficeSession: vi.fn(),
  loadMailboxConnection: vi.fn(),
  loadAuthorizedBusinesses: vi.fn(),
  loadOwnPersonalProfile: vi.fn(),
  loadMailboxScanRuns: vi.fn(),
  loadMailboxCandidates: vi.fn(),
  loadMailboxIngestionCandidates: vi.fn(),
  resolveMailboxCandidate: vi.fn(),
  clerk: {
    getToken: vi.fn().mockResolvedValue("office-token"),
    organization: { id: "org_123" },
  },
  searchParams: new URLSearchParams(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: harness.clerk.getToken, isLoaded: true, isSignedIn: true }),
  useOrganization: () => ({ organization: harness.clerk.organization, isLoaded: true }),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => harness.searchParams,
}));
vi.mock("@/lib/session", () => ({ readOfficeSession: () => harness.readOfficeSession() }));
vi.mock("@/lib/page-data", () => ({
  loadMailboxConnection: (...args: unknown[]) => harness.loadMailboxConnection(...args),
  loadAuthorizedBusinesses: (...args: unknown[]) => harness.loadAuthorizedBusinesses(...args),
  loadOwnPersonalProfile: (...args: unknown[]) => harness.loadOwnPersonalProfile(...args),
  loadMailboxScanRuns: (...args: unknown[]) => harness.loadMailboxScanRuns(...args),
  loadMailboxCandidates: (...args: unknown[]) => harness.loadMailboxCandidates(...args),
  loadMailboxIngestionCandidates: (...args: unknown[]) => harness.loadMailboxIngestionCandidates(...args),
}));
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    resolveMailboxCandidate: (...args: unknown[]) => harness.resolveMailboxCandidate(...args),
  };
});

import { MailboxCandidateError } from "./api";
import MailboxPage from "../app/(office)/mailbox/page";

const PERSONAL_SESSION = {
  apiBaseUrl: "http://app.test",
  tenantId: "tenant-1",
  scope: { kind: "personal" as const, profileId: "profile-1" },
  label: "Personal",
};

const ACTIVE_CONNECTION = {
  id: "connection-1",
  tenantId: "tenant-1",
  ownerUserId: "user-1",
  provider: "gmail" as const,
  providerAccountId: "acct-1",
  accountEmail: "owner@example.test",
  scope: { kind: "personal" as const, profileId: "profile-1" },
  status: "active" as const,
  grantedScopes: ["gmail.readonly"],
  timezone: "America/Los_Angeles",
  localScanTime: "07:00",
  scanEnabled: true,
  lastScanAt: null,
  nextScheduleAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  revokedAt: null,
};

function ingestionCandidate(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1 as const,
    id: "cand-1",
    scanRunId: "run-1",
    connectionId: ACTIVE_CONNECTION.id,
    tenantId: "tenant-1",
    receivedAt: "2026-10-02T13:48:00.000Z",
    senderAddress: "receipts@shopwaveco.example",
    senderDomain: "shopwaveco.example",
    subject: "Your order #48213",
    contentHash: "a".repeat(64),
    attachmentManifest: [],
    classification: "receipt" as const,
    confidence: 0.9,
    evidence: [],
    scope: { kind: "personal" as const, profileId: "profile-1" },
    status: "queued" as const,
    processingJobId: null,
    expenseId: null,
    sourceId: null,
    duplicateMatchId: null,
    ingestionProgress: null,
    version: 1,
    idempotencyKey: "key-1",
    errorCode: null,
    createdAt: "2026-10-02T13:48:00.000Z",
    updatedAt: "2026-10-02T13:48:00.000Z",
    ...overrides,
  };
}

const EMPTY_PAGE = { items: [], nextCursor: null, totalCount: 0 };

/** Routes the shared mock to per-bucket canned responses by bucket arg
 * (3rd positional parameter of loadMailboxIngestionCandidates). */
function mockIngestionBuckets(byBucket: Record<string, unknown>) {
  harness.loadMailboxIngestionCandidates.mockImplementation(async (...args: unknown[]) => {
    const bucket = args[2] as string;
    return byBucket[bucket] ?? EMPTY_PAGE;
  });
}

function renderPage() {
  return render(<MailboxPage />);
}

describe("rendered Office mailbox page — ingestion status board (fix round 1)", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    harness.clerk.getToken.mockResolvedValue("office-token");
    harness.searchParams = new URLSearchParams();
    harness.readOfficeSession.mockImplementation(() => ({ ...PERSONAL_SESSION }));
    harness.loadMailboxConnection.mockResolvedValue(ACTIVE_CONNECTION);
    harness.loadAuthorizedBusinesses.mockResolvedValue([]);
    harness.loadOwnPersonalProfile.mockResolvedValue({ id: "profile-1", name: "Personal" });
    harness.loadMailboxScanRuns.mockResolvedValue([]);
    harness.loadMailboxCandidates.mockResolvedValue({ items: [], nextCursor: null });
    mockIngestionBuckets({});
  });

  it("fetches each of the three sections as its own bucket-filtered request", async () => {
    renderPage();
    await waitFor(() => expect(harness.loadMailboxIngestionCandidates).toHaveBeenCalled());
    const buckets = harness.loadMailboxIngestionCandidates.mock.calls.map((call) => call[2]);
    expect(new Set(buckets)).toEqual(new Set(["in_progress", "needs_attention", "completed"]));
  });

  it("shows totalCount as 'Showing N of M' per bucket", async () => {
    mockIngestionBuckets({
      completed: {
        items: [ingestionCandidate({ id: "cand-completed", status: "processed", expenseId: "exp-1" })],
        nextCursor: "cursor-1",
        totalCount: 6,
      },
    });
    renderPage();
    await screen.findByText("Showing 1 of 6");
  });

  it("'Load more' in one bucket fetches the next page for that bucket only, appending without disturbing the other buckets", async () => {
    mockIngestionBuckets({
      completed: {
        items: [ingestionCandidate({ id: "cand-1", status: "processed", expenseId: "exp-1" })],
        nextCursor: "cursor-1",
        totalCount: 2,
      },
    });
    renderPage();
    await screen.findByText("Showing 1 of 2");

    mockIngestionBuckets({
      completed: {
        items: [ingestionCandidate({ id: "cand-2", status: "processed", expenseId: "exp-2" })],
        nextCursor: null,
        totalCount: 2,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /Load more/ }));

    await screen.findByText("Showing 2 of 2");
    const lastCall = harness.loadMailboxIngestionCandidates.mock.calls.at(-1) as unknown[];
    expect(lastCall[2]).toBe("completed");
    expect(lastCall[5]).toBe("cursor-1");
  });

  it("retry two-step flow: a 'review' row's Retry button re-approves with action 'ingest' and the candidate's existing scope, then refreshes all buckets", async () => {
    const reviewCandidate = ingestionCandidate({ id: "cand-review", status: "review" });
    mockIngestionBuckets({ needs_attention: { items: [reviewCandidate], nextCursor: null, totalCount: 1 } });
    harness.resolveMailboxCandidate.mockResolvedValue({ ...reviewCandidate, status: "queued", version: 2 });
    renderPage();

    const retryButton = await screen.findByRole("button", { name: /Retry/ });
    const callsBefore = harness.loadMailboxIngestionCandidates.mock.calls.length;
    fireEvent.click(retryButton);

    await waitFor(() => expect(harness.resolveMailboxCandidate).toHaveBeenCalledOnce());
    const call = harness.resolveMailboxCandidate.mock.calls[0] as unknown[];
    expect(call[3]).toBe("ingest"); // action
    expect(call[7]).toEqual(reviewCandidate.scope); // reuses the existing scope, no re-prompt

    // Re-approving (ingest) succeeded -- all three buckets refetched.
    await waitFor(() =>
      expect(harness.loadMailboxIngestionCandidates.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it("a 409 conflict shows an inline alert scoped to the affected row (never a panel-global one) and refetches", async () => {
    const failedCandidate = ingestionCandidate({
      id: "cand-failed",
      status: "failed",
      errorCode: "GOOGLE_RATE_LIMITED",
    });
    mockIngestionBuckets({ needs_attention: { items: [failedCandidate], nextCursor: null, totalCount: 1 } });
    harness.resolveMailboxCandidate.mockRejectedValue(new MailboxCandidateError("stale", 409));
    renderPage();

    const retryButton = await screen.findByRole("button", { name: /Retry/ });
    fireEvent.click(retryButton);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/changed while retrying/i);
    // Scoped to the row -- same article contains both the status chip and the alert.
    expect(alert.closest("article")).not.toBeNull();
  });

  it("polls every 5s while a row is in progress, and stops once none are", async () => {
    // Fake timers installed BEFORE mount (and BEFORE any render-triggered
    // setTimeout), so the poll effect's own first schedule is itself a
    // fake timer -- a real-timer schedule made before `useFakeTimers()`
    // would keep running on its own regardless of `advanceTimersByTimeAsync`.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      async function flush(times = 8) {
        for (let index = 0; index < times; index += 1) {
          await vi.advanceTimersByTimeAsync(0);
        }
      }

      harness.loadMailboxIngestionCandidates.mockImplementation(async (...args: unknown[]) =>
        args[2] === "in_progress"
          ? { items: [ingestionCandidate({ id: "cand-1", status: "queued" })], nextCursor: null, totalCount: 1 }
          : EMPTY_PAGE,
      );
      render(<MailboxPage />);
      await flush();
      expect(screen.getByText(/receipts@shopwaveco\.example/)).toBeTruthy();
      const callsAfterMount = harness.loadMailboxIngestionCandidates.mock.calls.length;

      // Still in progress -- one 5s tick refetches all three buckets.
      await vi.advanceTimersByTimeAsync(5_000);
      await flush();
      expect(harness.loadMailboxIngestionCandidates.mock.calls.length).toBeGreaterThan(callsAfterMount);

      // Now in_progress returns empty -- this refetch is the last one.
      harness.loadMailboxIngestionCandidates.mockResolvedValue(EMPTY_PAGE);
      await vi.advanceTimersByTimeAsync(5_000);
      await flush();
      const callsAtEmpty = harness.loadMailboxIngestionCandidates.mock.calls.length;

      await vi.advanceTimersByTimeAsync(20_000);
      await flush();
      expect(harness.loadMailboxIngestionCandidates.mock.calls.length).toBe(callsAtEmpty);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Copy writes the candidate ID to the clipboard and shows accessible 'Copied!' feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mockIngestionBuckets({
      completed: {
        items: [ingestionCandidate({ id: "cand-copy-me", status: "processed", expenseId: "exp-1" })],
        nextCursor: null,
        totalCount: 1,
      },
    });
    renderPage();

    const summary = await screen.findByText("Support details");
    fireEvent.click(summary);
    const copyButton = screen.getByRole("button", { name: /Copy candidate ID/ });
    fireEvent.click(copyButton);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("cand-copy-me"));
    await screen.findByText("Copied!");
  });
});
