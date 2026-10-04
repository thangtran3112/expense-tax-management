// @vitest-environment jsdom
/**
 * Phase 3D-A Task 4, fix round 2 — rendered tests for the Office mailbox
 * page covering two review findings:
 *
 * - [important] readOfficeSession() returns a fresh object every render;
 *   the page's status-fetch effect must not depend on that object
 *   directly (or it refetches forever). Proven here by forcing several
 *   re-renders (via unrelated state updates) and asserting the mocked
 *   loader was still only called once per distinct scope.
 * - [important] the scope picker must render every authorized option
 *   (Personal + active businesses from App API), none preselected, with
 *   Connect disabled until one is chosen.
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
  connectMailboxGoogle: vi.fn(),
  startMailboxScan: vi.fn(),
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
}));
vi.mock("@/lib/mailbox", async () => {
  const actual = await vi.importActual<typeof import("./mailbox")>("./mailbox");
  return {
    ...actual,
    connectMailboxGoogle: (...args: unknown[]) => harness.connectMailboxGoogle(...args),
  };
});
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    startMailboxScan: (...args: unknown[]) => harness.startMailboxScan(...args),
    resolveMailboxCandidate: (...args: unknown[]) => harness.resolveMailboxCandidate(...args),
  };
});

import MailboxPage from "../app/(office)/mailbox/page";

const PERSONAL_SESSION = {
  apiBaseUrl: "http://app.test",
  tenantId: "tenant-1",
  scope: { kind: "personal" as const, profileId: "profile-1" },
  label: "Personal",
};

function renderPage() {
  return render(<MailboxPage />);
}

describe("rendered Office mailbox page", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    harness.clerk.getToken.mockResolvedValue("office-token");
    harness.searchParams = new URLSearchParams();
    harness.readOfficeSession.mockImplementation(() => ({ ...PERSONAL_SESSION }));
    harness.loadMailboxConnection.mockResolvedValue(null);
    harness.loadAuthorizedBusinesses.mockResolvedValue([]);
    harness.loadOwnPersonalProfile.mockResolvedValue({ id: "profile-1", name: "Personal" });
    harness.loadMailboxScanRuns.mockResolvedValue([]);
    harness.loadMailboxCandidates.mockResolvedValue({ items: [], nextCursor: null });
  });

  // ------------------------------------------------------------------ //
  // Finding 2 -- stable session reference, no refetch loop
  // ------------------------------------------------------------------ //

  it("fetches mailbox status exactly once per scope, even across several unrelated re-renders", async () => {
    harness.loadAuthorizedBusinesses.mockResolvedValue([{ id: "biz-1", name: "Tran Studio" }]);
    renderPage();

    await waitFor(() => expect(harness.loadMailboxConnection).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Personal")).toBeTruthy());

    // Each radio click triggers a setState -> re-render. readOfficeSession()
    // is called again on each render (it's not React state), returning a
    // *new* object every time -- if the status-fetch effect depended on
    // that object directly, this would refetch on every click.
    fireEvent.click(screen.getByRole("radio", { name: /Personal/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Tran Studio/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Personal/ }));

    // Give any (incorrect) additional effect runs a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.loadMailboxConnection).toHaveBeenCalledTimes(1);
    expect(harness.loadAuthorizedBusinesses).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------ //
  // Finding 3 -- real authorized scope options, none preselected
  // ------------------------------------------------------------------ //

  it("renders Personal plus every active business, none preselected, Connect disabled until chosen", async () => {
    harness.loadAuthorizedBusinesses.mockResolvedValue([
      { id: "biz-1", name: "Tran Studio" },
      { id: "biz-2", name: "Second Shop" },
    ]);
    renderPage();

    const personalRadio = await screen.findByRole("radio", { name: /Personal/ });
    const bizRadio1 = screen.getByRole("radio", { name: /Tran Studio/ });
    const bizRadio2 = screen.getByRole("radio", { name: /Second Shop/ });

    expect((personalRadio as HTMLInputElement).checked).toBe(false);
    expect((bizRadio1 as HTMLInputElement).checked).toBe(false);
    expect((bizRadio2 as HTMLInputElement).checked).toBe(false);

    const connectButton = screen.getByRole("button", { name: /Connect Gmail/ }) as HTMLButtonElement;
    expect(connectButton.disabled).toBe(true);

    fireEvent.click(bizRadio1);
    expect((bizRadio1 as HTMLInputElement).checked).toBe(true);
    expect(connectButton.disabled).toBe(false);
  });

  // ------------------------------------------------------------------ //
  // Finding 1 (fix round 3) -- Personal always offered, via the real
  // scope-authorized lookup, not derived from session.scope.kind
  // ------------------------------------------------------------------ //

  it("still shows Personal under a business-scoped session, when the lookup resolves a profile", async () => {
    harness.readOfficeSession.mockImplementation(() => ({
      apiBaseUrl: "http://app.test",
      tenantId: "tenant-1",
      scope: { kind: "business" as const, businessId: "biz-1" },
      label: "Tran Studio",
    }));
    harness.loadAuthorizedBusinesses.mockResolvedValue([{ id: "biz-1", name: "Tran Studio" }]);
    harness.loadOwnPersonalProfile.mockResolvedValue({ id: "profile-mine", name: "Personal" });
    renderPage();

    await screen.findByRole("radio", { name: /Tran Studio/ });
    expect(screen.getByRole("radio", { name: /^Personal$/ })).toBeTruthy();
  });

  it("shows no Personal option when the member has no Personal profile in this tenant", async () => {
    harness.readOfficeSession.mockImplementation(() => ({
      apiBaseUrl: "http://app.test",
      tenantId: "tenant-1",
      scope: { kind: "business" as const, businessId: "biz-1" },
      label: "Tran Studio",
    }));
    harness.loadAuthorizedBusinesses.mockResolvedValue([{ id: "biz-1", name: "Tran Studio" }]);
    harness.loadOwnPersonalProfile.mockResolvedValue(null);
    renderPage();

    await screen.findByRole("radio", { name: /Tran Studio/ });
    expect(screen.queryByRole("radio", { name: /^Personal$/ })).toBeNull();
  });

  it("looks up only the caller's own profile -- no member/profile id parameter that could request another member's", async () => {
    renderPage();

    await waitFor(() => expect(harness.loadOwnPersonalProfile).toHaveBeenCalledTimes(1));
    const call = harness.loadOwnPersonalProfile.mock.calls[0] as unknown[];
    // session, getToken, organizationId -- never a profileId/memberId/userId argument.
    expect(call).toHaveLength(3);
    expect(typeof call[1]).toBe("function");
    expect(call[2]).toBe("org_123");
  });

  it("connects using the explicitly selected scope, not necessarily session.scope", async () => {
    harness.loadAuthorizedBusinesses.mockResolvedValue([{ id: "biz-1", name: "Tran Studio" }]);
    harness.connectMailboxGoogle.mockResolvedValue({ authorizationUrl: "https://broker.test/begin" });
    renderPage();

    const bizRadio = await screen.findByRole("radio", { name: /Tran Studio/ });
    fireEvent.click(bizRadio);
    fireEvent.click(screen.getByRole("button", { name: /Connect Gmail/ }));

    await waitFor(() => expect(harness.connectMailboxGoogle).toHaveBeenCalledOnce());
    const [, selectedScope] = harness.connectMailboxGoogle.mock.calls[0] as [unknown, unknown];
    expect(selectedScope).toEqual({ kind: "business", businessId: "biz-1" });
  });
});

// ------------------------------------------------------------------ //
// Fix round 1 (review Important #2) -- scan status polling must restart
// after a manual "Scan now" trigger, and must stop once the run reaches
// a terminal status again (no runaway polling).
// ------------------------------------------------------------------ //

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

function scanRun(status: "pending" | "running" | "completed", id = "run-1") {
  return {
    schemaVersion: 1 as const,
    id,
    connectionId: ACTIVE_CONNECTION.id,
    tenantId: "tenant-1",
    initiatedBy: "user-1",
    entitlementVersion: 1,
    connectionVersion: 1,
    status,
    discoveredCount: 0,
    stagedCount: 0,
    reviewCount: 0,
    duplicateCount: 0,
    skippedCount: 0,
    failedCount: 0,
    errorCode: null,
    idempotencyKey: `key-${id}`,
    createdAt: "2026-10-03T07:00:00.000Z",
    startedAt: status === "pending" ? null : "2026-10-03T07:00:00.000Z",
    completedAt: status === "completed" ? "2026-10-03T07:05:00.000Z" : null,
  };
}

describe("rendered Office mailbox page — scan status polling (connected)", () => {
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
    harness.loadMailboxCandidates.mockResolvedValue({ items: [], nextCursor: null });
  });

  it("restarts polling after a manual Scan now trigger, and stops once the new run reaches a terminal status", async () => {
    // Idle on mount: a single initial poll finds the last run already
    // completed. Real timers for mount settling (React's own passive-
    // effect scheduling is not under test here); only `setTimeout`/
    // `clearTimeout` are faked below, once mount has settled, so the
    // poll loop's own 5s interval can be controlled without fighting
    // React's scheduler.
    harness.loadMailboxScanRuns.mockResolvedValueOnce([scanRun("completed", "run-0")]);
    render(<MailboxPage />);

    const scanButton = await screen.findByRole("button", { name: /Scan now/ });
    await waitFor(() => expect(harness.loadMailboxScanRuns).toHaveBeenCalledTimes(1));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Several small flushes rather than one large advance: each
      // `advanceTimersByTimeAsync` call drains microtasks once per due
      // timer, and the chain here (state update -> effect re-run ->
      // await -> state update) is several hops deep.
      async function flush(times = 6) {
        for (let index = 0; index < times; index += 1) {
          await vi.advanceTimersByTimeAsync(0);
        }
      }

      // No further polling while idle -- advancing well past the 5s
      // interval must not call loadMailboxScanRuns again (completed run
      // never scheduled a next tick).
      await vi.advanceTimersByTimeAsync(20_000);
      await flush();
      expect(harness.loadMailboxScanRuns).toHaveBeenCalledTimes(1);

      // Trigger a manual scan: the new run is immediately pending.
      harness.startMailboxScan.mockResolvedValue({ status: "started" });
      harness.loadMailboxScanRuns.mockResolvedValueOnce([scanRun("running", "run-1")]);
      fireEvent.click(scanButton);
      await flush();

      expect(harness.startMailboxScan).toHaveBeenCalledOnce();
      // Polling restarted: one more fetch immediately after the trigger.
      expect(harness.loadMailboxScanRuns).toHaveBeenCalledTimes(2);
      // Synchronous check (not `findByText`/`waitFor`): testing-library's
      // own async polling uses `setTimeout` too, which is faked here --
      // `flush()` above has already settled every pending state update.
      expect(screen.getByText(/Scan in progress/)).toBeTruthy();

      // Still running after one 5s tick -- polling continues.
      harness.loadMailboxScanRuns.mockResolvedValueOnce([scanRun("running", "run-1")]);
      await vi.advanceTimersByTimeAsync(5_000);
      await flush();
      expect(harness.loadMailboxScanRuns).toHaveBeenCalledTimes(3);

      // Reaches a terminal status on the next tick -- one candidate
      // refresh, then polling stops (no further calls on later ticks).
      harness.loadMailboxScanRuns.mockResolvedValueOnce([scanRun("completed", "run-1")]);
      await vi.advanceTimersByTimeAsync(5_000);
      await flush();
      expect(harness.loadMailboxScanRuns).toHaveBeenCalledTimes(4);
      expect(harness.loadMailboxCandidates).toHaveBeenCalled();

      const callsAtTerminal = harness.loadMailboxScanRuns.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      await flush();
      expect(harness.loadMailboxScanRuns).toHaveBeenCalledTimes(callsAtTerminal);
    } finally {
      vi.useRealTimers();
    }
  });
});
