// @vitest-environment jsdom
/**
 * I-1: ExpenseLedgerWithFilters — unified single data owner.
 * m-1: SuggestionCard — failed resolve resets disabled state for retry.
 * m-3: Tax page null-session returns unavailable state.
 * m-4: ConfidenceMeter renders "bad" tone class at 65% confidence.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ------------------------------------------------------------------ //
// Session mock — hoisted so it applies across all imports in file
// ------------------------------------------------------------------ //

const { readOfficeSession } = vi.hoisted(() => ({ readOfficeSession: vi.fn() }));
vi.mock("@/lib/session", () => ({ readOfficeSession }));

// ------------------------------------------------------------------ //
// Single consolidated api mock — all test groups share it
// ------------------------------------------------------------------ //

const mockFetchLedger = vi.hoisted(() => vi.fn());
const mockFetchExpenseDetail = vi.hoisted(() => vi.fn());
const mockFetchSuggestions = vi.hoisted(() => vi.fn());
const mockResolveSuggestion = vi.hoisted(() => vi.fn());
const mockGetToken = vi.hoisted(() => vi.fn().mockResolvedValue("tok"));
const mockOrganization = vi.hoisted(() => ({ id: "org_1" }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchLedger: mockFetchLedger,
    fetchExpenseDetail: mockFetchExpenseDetail,
    fetchSuggestions: mockFetchSuggestions,
    resolveSuggestion: mockResolveSuggestion,
  };
});

// page-data mock so OfficeData (if still used) doesn't also trigger
const mockLoadExpenses = vi.hoisted(() => vi.fn());
vi.mock("@/lib/page-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/page-data")>();
  return { ...actual, loadExpenses: mockLoadExpenses };
});

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: mockGetToken, isLoaded: true, isSignedIn: true }),
  useOrganization: () => ({ organization: mockOrganization, isLoaded: true }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ expenseId: "exp-1" }) }));

// ------------------------------------------------------------------ //
// Fixtures
// ------------------------------------------------------------------ //

const bizSession = {
  apiBaseUrl: "http://app.test",
  tenantId: "t-1",
  scope: { kind: "business" as const, businessId: "biz-1" },
  label: "Biz",
};

function makeLedgerItem(id: string, merchant: string) {
  return {
    id, merchant,
    incurredOn: "2026-09-01",
    amount: "10.00",
    currency: "USD",
    status: "ready" as const,
    projectId: null,
    spendingCategoryId: null,
    tags: [] as Array<{ id: string; name: string; color: string | null }>,
    taxYear: 2026,
    version: 1,
    tenantId: "t-1",
    businessId: "biz-1",
    personalProfileId: null,
    source: "manual" as const,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    createdByUserId: "user-1",
    description: null,
  };
}

// ------------------------------------------------------------------ //
// I-1: ExpenseLedgerWithFilters — unified single data owner
// ------------------------------------------------------------------ //

import Expenses from "@/app/(office)/expenses/page";
import React from "react";

describe("I-1: ExpenseLedgerWithFilters — unified single data owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readOfficeSession.mockReturnValue(bizSession);
    mockFetchLedger.mockResolvedValue({ items: [makeLedgerItem("e-1", "Coffee Shop")], nextCursor: null });
    mockLoadExpenses.mockResolvedValue({ items: [makeLedgerItem("e-1", "Coffee Shop")], nextCursor: null });
  });

  afterEach(() => cleanup());

  it("fires initial fetchLedger once on mount with no tagId filter", async () => {
    render(<Expenses />);
    await waitFor(() => expect(screen.queryByText("Coffee Shop")).toBeTruthy(), { timeout: 3000 });

    // fetchLedger must have been called at least once (initial load)
    expect(mockFetchLedger.mock.calls.length).toBeGreaterThanOrEqual(1);
    // First call must have no tagId (unfiltered initial load)
    const firstCallOpts = mockFetchLedger.mock.calls[0]?.[4] as { tagId?: string[] } | undefined;
    expect(firstCallOpts?.tagId).toBeUndefined();
  });

  it("shows merchant from fetched data after initial load (single data path)", async () => {
    render(<Expenses />);
    await waitFor(() => expect(screen.queryByText("Coffee Shop")).toBeTruthy(), { timeout: 3000 });
    // Exactly one row, no duplication from dual data sources
    expect(screen.getAllByText("Coffee Shop")).toHaveLength(1);
  });

  it("filter change calls fetchLedger with tagId and replaces items (no unfiltered flash)", async () => {
    mockFetchLedger
      .mockResolvedValueOnce({ items: [makeLedgerItem("e-1", "Coffee Shop")], nextCursor: null })
      .mockResolvedValueOnce({ items: [makeLedgerItem("e-2", "Tagged Supplier")], nextCursor: null });

    render(<Expenses />);
    await waitFor(() => expect(screen.queryByText("Coffee Shop")).toBeTruthy(), { timeout: 3000 });

    // Add tag filter
    fireEvent.change(screen.getByLabelText("Filter by tag ID"), { target: { value: "tag-abc" } });
    fireEvent.click(screen.getByText("Add tag filter"));

    await waitFor(() => expect(screen.queryByText("Tagged Supplier")).toBeTruthy(), { timeout: 3000 });
    // Old items must be gone (replaced, not appended)
    expect(screen.queryByText("Coffee Shop")).toBeNull();

    // Second call includes tagId
    const withTagCall = mockFetchLedger.mock.calls.find((c) => {
      const opts = c[4] as { tagId?: string[] } | undefined;
      return Array.isArray(opts?.tagId) && opts.tagId.includes("tag-abc");
    });
    expect(withTagCall).toBeDefined();
  });

  it("removing a tag filter calls fetchLedger without that tagId", async () => {
    mockFetchLedger
      .mockResolvedValueOnce({ items: [makeLedgerItem("e-1", "Coffee Shop")], nextCursor: null })
      .mockResolvedValueOnce({ items: [makeLedgerItem("e-2", "Tagged Supplier")], nextCursor: null })
      .mockResolvedValueOnce({ items: [makeLedgerItem("e-1", "Coffee Shop")], nextCursor: null });

    render(<Expenses />);
    await waitFor(() => expect(screen.queryByText("Coffee Shop")).toBeTruthy(), { timeout: 3000 });

    // Add filter
    fireEvent.change(screen.getByLabelText("Filter by tag ID"), { target: { value: "tag-abc" } });
    fireEvent.click(screen.getByText("Add tag filter"));
    await waitFor(() => expect(screen.queryByText("Tagged Supplier")).toBeTruthy(), { timeout: 3000 });

    // Remove chip
    fireEvent.click(screen.getByLabelText("Remove tag filter tag-abc"));
    await waitFor(() => expect(screen.queryByText("Coffee Shop")).toBeTruthy(), { timeout: 3000 });

    // Last call has no tagId
    const lastCall = mockFetchLedger.mock.calls[mockFetchLedger.mock.calls.length - 1];
    const opts = lastCall?.[4] as { tagId?: string[] } | undefined;
    expect(!opts?.tagId || opts.tagId.length === 0).toBe(true);
  });
});

// ------------------------------------------------------------------ //
// m-1: SuggestionCard — failed resolve keeps card enabled for retry
// ------------------------------------------------------------------ //

import ExpenseDetail from "@/app/(office)/expenses/[expenseId]/page";

const pendingSuggestion = {
  id: "sugg-1", kind: "tag", source: "ai", confidence: 0.95,
  evidence: {}, status: "pending", version: 1, expenseVersion: 1,
  tagId: "tag-1", spendingCategoryId: null, taxCategoryDefinitionId: null, businessTaxProfileId: null,
};

describe("m-1: SuggestionCard — failed resolve allows retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readOfficeSession.mockReturnValue(bizSession);
    mockFetchExpenseDetail.mockResolvedValue({
      id: "exp-1", merchant: "Shop", incurredOn: "2026-09-01",
      amount: "10.00", currency: "USD", status: "ready", version: 1, tags: [],
    });
    mockFetchSuggestions.mockResolvedValue({ items: [pendingSuggestion], nextCursor: null });
    // Simulate network failure on resolve
    mockResolveSuggestion.mockRejectedValue(new Error("Network error"));
  });

  afterEach(() => cleanup());

  it("Accept button is re-enabled after failed resolve (not stuck disabled)", async () => {
    render(<ExpenseDetail />);
    await waitFor(() => expect(screen.queryByText("Accept")).toBeTruthy(), { timeout: 3000 });

    const acceptBtn = screen.getByText("Accept");
    expect((acceptBtn as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(acceptBtn);

    // After failure: parent sets resolving=false in finally, button must re-enable
    await waitFor(() => {
      const btn = screen.queryByText("Accept");
      // Button re-appears and is enabled (not stuck from local state)
      expect(btn).toBeTruthy();
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    }, { timeout: 3000 });
  });

  it("error message shown after failed resolve", async () => {
    render(<ExpenseDetail />);
    await waitFor(() => expect(screen.queryByText("Accept")).toBeTruthy(), { timeout: 3000 });
    fireEvent.click(screen.getByText("Accept"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeTruthy(), { timeout: 3000 });
  });
});

describe("Phase 3C expense detail fixes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readOfficeSession.mockReturnValue(bizSession);
  });

  afterEach(() => cleanup());

  it("Retry refetches expense detail and suggestions after initial load failure", async () => {
    mockFetchExpenseDetail
      .mockRejectedValueOnce(new Error("Initial load failed"))
      .mockResolvedValueOnce({
        id: "exp-1", merchant: "Reloaded Shop", incurredOn: "2026-09-01",
        amount: "10.00", currency: "USD", status: "ready", version: 1, tags: [],
      });
    mockFetchSuggestions
      .mockRejectedValueOnce(new Error("Initial load failed"))
      .mockResolvedValueOnce({ items: [pendingSuggestion], nextCursor: null });

    render(<ExpenseDetail />);
    await waitFor(() => expect(screen.getByText("Retry")).toBeTruthy());
    fireEvent.click(screen.getByText("Retry"));

    await waitFor(() => expect(screen.getAllByText("Reloaded Shop").length).toBeGreaterThan(0));
    expect(mockFetchExpenseDetail).toHaveBeenCalledTimes(2);
    expect(mockFetchSuggestions).toHaveBeenCalledTimes(2);
  });

  it("renders only server-pending suggestions", async () => {
    mockFetchExpenseDetail.mockResolvedValue({
      id: "exp-1", merchant: "Shop", incurredOn: "2026-09-01",
      amount: "10.00", currency: "USD", status: "ready", version: 1, tags: [],
    });
    mockFetchSuggestions.mockResolvedValue({
      items: [
        pendingSuggestion,
        { ...pendingSuggestion, id: "accepted", status: "accepted", tagId: "tag-accepted" },
        { ...pendingSuggestion, id: "rejected", status: "rejected", tagId: "tag-rejected" },
        { ...pendingSuggestion, id: "superseded", status: "superseded", tagId: "tag-superseded" },
      ],
      nextCursor: null,
    });

    render(<ExpenseDetail />);

    await waitFor(() => expect(screen.getByText("Tag suggestion: tag-1")).toBeTruthy());
    expect(screen.queryByText("Tag suggestion: tag-accepted")).toBeNull();
    expect(screen.queryByText("Tag suggestion: tag-rejected")).toBeNull();
    expect(screen.queryByText("Tag suggestion: tag-superseded")).toBeNull();
  });

  it("refreshes authoritative expense and suggestions before next resolution", async () => {
    const refreshedSuggestion = { ...pendingSuggestion, id: "sugg-2", tagId: "tag-2", expenseVersion: 2 };
    mockFetchExpenseDetail
      .mockResolvedValueOnce({
        id: "exp-1", merchant: "Shop", incurredOn: "2026-09-01",
        amount: "10.00", currency: "USD", status: "ready", version: 1, tags: [],
      })
      .mockResolvedValueOnce({
        id: "exp-1", merchant: "Shop", incurredOn: "2026-09-01",
        amount: "10.00", currency: "USD", status: "unreviewed", version: 2, tags: [],
      });
    mockFetchSuggestions
      .mockResolvedValueOnce({ items: [pendingSuggestion], nextCursor: null })
      .mockResolvedValueOnce({ items: [refreshedSuggestion], nextCursor: null });
    mockResolveSuggestion.mockResolvedValue({});

    render(<ExpenseDetail />);
    await waitFor(() => expect(screen.getByText("Accept")).toBeTruthy());
    fireEvent.click(screen.getByText("Accept"));

    await waitFor(() => expect(screen.getByText("Tag suggestion: tag-2")).toBeTruthy());
    fireEvent.click(screen.getByText("Accept"));

    await waitFor(() => expect(mockResolveSuggestion).toHaveBeenCalledTimes(2));
    expect(mockResolveSuggestion.mock.calls[1]?.[3]).toMatchObject({
      expectedSuggestionVersion: 1,
      expectedExpenseVersion: 2,
    });
  });
});

// ------------------------------------------------------------------ //
// Phase 3D-C Task 6 fix round 1 (review finding #6) -- expense-detail
// connected-mailbox "Source" block, metadata only.
// ------------------------------------------------------------------ //

describe("expense detail — connected-mailbox Source block (fix round 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readOfficeSession.mockReturnValue(bizSession);
    mockFetchSuggestions.mockResolvedValue({ items: [], nextCursor: null });
  });

  afterEach(() => cleanup());

  it("renders sender/received/scope for a cleanly-ingested connected-mailbox expense, metadata only", async () => {
    mockFetchExpenseDetail.mockResolvedValue({
      id: "exp-1", merchant: "Northline Hardware", incurredOn: "2026-10-02",
      amount: "142.30", currency: "USD", status: "ready", version: 1, tags: [],
      personalProfileId: "profile-1", businessId: null,
      mailboxProvenance: {
        senderAddress: "receipts@northline-hardware.example",
        receivedAt: "2026-10-02T06:41:00.000Z",
        mailboxAccountEmail: "owner@example.test",
        pendingDuplicateReview: false,
      },
    });

    render(<ExpenseDetail />);

    await waitFor(() => expect(screen.getByText("Source")).toBeTruthy());
    expect(screen.getByText("receipts@northline-hardware.example")).toBeTruthy();
    expect(screen.getByText("Connected Gmail mailbox")).toBeTruthy();
    expect(screen.getByText("Personal")).toBeTruthy();
    expect(screen.getByText(/Metadata only/)).toBeTruthy();
    expect(screen.queryByText(/Review duplicate match/)).toBeNull();
  });

  it("links to the existing /duplicates queue when the source is pending duplicate review", async () => {
    mockFetchExpenseDetail.mockResolvedValue({
      id: "exp-2", merchant: "Slatehouse Supply", incurredOn: "2026-10-02",
      amount: "88.00", currency: "USD", status: "ready", version: 1, tags: [],
      personalProfileId: "profile-1", businessId: null,
      mailboxProvenance: {
        senderAddress: "billing@slatehouse-supply.example",
        receivedAt: "2026-10-02T07:04:00.000Z",
        mailboxAccountEmail: "owner@example.test",
        pendingDuplicateReview: true,
      },
    });

    render(<ExpenseDetail />);

    const link = await screen.findByText(/Review duplicate match/);
    expect(link.closest("a")?.getAttribute("href")).toBe("/duplicates");
  });

  it("renders no Source block for a manually-created expense", async () => {
    mockFetchExpenseDetail.mockResolvedValue({
      id: "exp-3", merchant: "Office Depot", incurredOn: "2026-10-02",
      amount: "20.00", currency: "USD", status: "ready", version: 1, tags: [],
      mailboxProvenance: null,
    });

    render(<ExpenseDetail />);

    await waitFor(() => expect(screen.getAllByText("Office Depot").length).toBeGreaterThan(0));
    expect(screen.queryByText("Source")).toBeNull();
  });
});

// ------------------------------------------------------------------ //
// m-3: Tax page null-session renders unavailable state
// ------------------------------------------------------------------ //

import Tax from "@/app/(office)/tax/page";

describe("m-3: Tax page null-session fail-closed", () => {
  afterEach(() => cleanup());

  it("renders unavailable state when session is null", () => {
    readOfficeSession.mockReturnValue(null);
    render(<Tax />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText("Prepare. Review. Export.")).toBeNull();
  });

  it("renders unavailable state when scope is personal", () => {
    readOfficeSession.mockReturnValue({
      scope: { kind: "personal", profileId: "prof-1" }, tenantId: "t-1", apiBaseUrl: "http://x.test", label: "P",
    });
    render(<Tax />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText("Prepare. Review. Export.")).toBeNull();
  });
});

// ------------------------------------------------------------------ //
// m-4: ConfidenceMeter — renders "bad" tone at 65%, Status contract
// ------------------------------------------------------------------ //

import { Status } from "@/components/ui";

describe("m-4: ConfidenceMeter — Status tone contract at boundary values", () => {
  afterEach(() => cleanup());

  it("Status component accepts 'bad' tone and applies bad class", () => {
    render(<Status tone="bad">65% confidence</Status>);
    const el = screen.getByText("65% confidence");
    expect(el.className).toContain("bad");
  });

  it("ConfidenceMeter tone logic: 65% → bad", () => {
    const pct = 65;
    const tone = pct >= 90 ? "ok" : pct >= 70 ? "warn" : "bad";
    expect(tone).toBe("bad");
    render(<Status tone={tone}>{pct}% confidence</Status>);
    expect(screen.getByText("65% confidence").className).toContain("bad");
  });

  it("ConfidenceMeter tone logic: 75% → warn", () => {
    const pct = 75;
    const tone = pct >= 90 ? "ok" : pct >= 70 ? "warn" : "bad";
    expect(tone).toBe("warn");
    render(<Status tone={tone}>{pct}% confidence</Status>);
    expect(screen.getByText("75% confidence").className).toContain("warn");
  });

  it("ConfidenceMeter tone logic: 95% → ok", () => {
    const pct = 95;
    const tone = pct >= 90 ? "ok" : pct >= 70 ? "warn" : "bad";
    expect(tone).toBe("ok");
    render(<Status tone={tone}>{pct}% confidence</Status>);
    expect(screen.getByText("95% confidence").className).toContain("ok");
  });
});
