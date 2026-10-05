// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const match = (overrides: Record<string, unknown> = {}) => ({
  id: "match-1",
  tenantId: "tenant-1",
  businessId: "business-1",
  personalProfileId: null,
  existingExpenseId: "existing-1",
  candidateExpenseId: "candidate-1",
  matchType: "file_sha256",
  confidence: 0.96,
  evidence: {
    existingAmountMinorUnits: 1200,
    candidateAmountMinorUnits: 1200,
    currency: "USD",
    existingIncurredOn: "2026-09-01",
    candidateIncurredOn: "2026-09-01",
  },
  status: "pending",
  version: 4,
  resolvedBy: null,
  resolvedAt: null,
  resolutionIdempotencyKey: null,
  idempotencyKey: "match-key",
  createdAt: "2026-09-11T00:00:00.000Z",
  ...overrides,
});
type TestMatch = ReturnType<typeof match>;

const harness = vi.hoisted(() => ({
  officeData: { mode: "pending", data: { items: [] as TestMatch[], nextCursor: null as string | null } },
  api: {
    fetchDuplicateMatches: vi.fn(),
    resolveDuplicateMatch: vi.fn(),
    announceDuplicateReviewUpdated: vi.fn(),
  },
  readOfficeSession: vi.fn(),
  clerk: {
    getToken: vi.fn().mockResolvedValue("office-token"),
    organization: { id: "org_123" },
  },
  DuplicateReviewError: class extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = "DuplicateReviewError";
      this.status = status;
    }
  },
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: harness.clerk.getToken }),
  useOrganization: () => ({ organization: harness.clerk.organization }),
}));
vi.mock("@/components/office-data", () => ({
  OfficeData: ({ children }: { children: (data: typeof harness.officeData.data) => React.ReactNode }) => {
    if (harness.officeData.mode === "loading") return <div>Loading secure data...</div>;
    if (harness.officeData.mode === "unauthorized") return <div role="alert">Office authorization required</div>;
    if (harness.officeData.mode === "error") return <div role="alert">Duplicate matches unavailable</div>;
    return children(harness.officeData.data);
  },
}));
vi.mock("@/lib/page-data", () => ({ loadDuplicates: vi.fn() }));
vi.mock("@/lib/session", () => ({ readOfficeSession: () => harness.readOfficeSession() }));
vi.mock("@/lib/api", () => ({
  DuplicateReviewError: harness.DuplicateReviewError,
  announceDuplicateReviewUpdated: harness.api.announceDuplicateReviewUpdated,
  fetchDuplicateMatches: harness.api.fetchDuplicateMatches,
  resolveDuplicateMatch: harness.api.resolveDuplicateMatch,
  getDuplicateReviewState: ({ items, conflict }: { items: unknown[]; conflict?: boolean }) => conflict ? "conflict" : items.length === 0 ? "empty" : "pending",
  getSourceBadge: (type: string) => type === "file_sha256" ? { label: "Source file", tone: "ok" } : type === "fingerprint" ? { label: "Expense fingerprint", tone: "ok" } : { label: "Matching fields", tone: "warn" },
}));

import Duplicates from "../app/(office)/duplicates/page";

function renderPage() {
  return render(<Duplicates />);
}

describe("rendered Office duplicate review", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    harness.officeData.mode = "pending";
    harness.officeData.data = { items: [match()], nextCursor: "cursor-2" };
    harness.readOfficeSession.mockReturnValue({ apiBaseUrl: "http://app.test", tenantId: "tenant-1", scope: { kind: "business", businessId: "business-1" }, label: "Family" });
    harness.api.resolveDuplicateMatch.mockResolvedValue({ status: "merged" });
    harness.api.fetchDuplicateMatches.mockResolvedValue({ items: [match({ id: "match-2", existingExpenseId: "existing-2", candidateExpenseId: "candidate-2" })], nextCursor: null });
  });

  it.each([
    ["loading", "Loading secure data..."],
    ["unauthorized", "Office authorization required"],
    ["error", "Duplicate matches unavailable"],
  ])("renders %s state", (mode, text) => {
    harness.officeData.mode = mode;
    renderPage();
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("renders empty and pending comparison states with source badges", () => {
    harness.officeData.data = { items: [], nextCursor: null };
    const { unmount } = renderPage();
    expect(screen.getByText("No pending duplicate matches. New evidence will appear here for review.")).toBeTruthy();
    unmount();

    harness.officeData.data = { items: [match({ matchType: "fingerprint" }), match({ id: "match-3", matchType: "fuzzy_fields" })], nextCursor: null };
    renderPage();
    expect(screen.getByText("Expense fingerprint")).toBeTruthy();
    expect(screen.getByText("Matching fields")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Merge" })).toHaveLength(2);
    expect(screen.getAllByRole("region", { name: "Expense comparison" })).toHaveLength(2);
  });

  it.each(["merge", "keep_both", "discard_new"] as const)("submits %s action and disables controls while pending", async (action) => {
    let resolveAction!: (value: unknown) => void;
    harness.api.resolveDuplicateMatch.mockReturnValue(new Promise((resolve) => { resolveAction = resolve; }));
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: action === "keep_both" ? "Keep both" : action === "discard_new" ? "Discard new" : "Merge" }));

    await waitFor(() => expect(harness.api.resolveDuplicateMatch).toHaveBeenCalledWith(expect.anything(), "match-1", action, 4, expect.anything(), "org_123"));
    expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Resolving duplicate");
    resolveAction({ status: "merged" });
  });

  it("shows action failure without removing pending match", async () => {
    harness.api.resolveDuplicateMatch.mockRejectedValue(new Error("Resolution unavailable"));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Resolution unavailable");
    expect(screen.getByText("Possible duplicate")).toBeTruthy();
  });

  it.each([401, 403])("fails closed when action authorization expires with %s", async (status) => {
    harness.api.resolveDuplicateMatch.mockRejectedValue(new harness.DuplicateReviewError("expired", status));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Office authorization required");
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });

  it("fails closed when active session read rejects", async () => {
    harness.readOfficeSession.mockImplementation(() => { throw new Error("session unavailable"); });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Office authorization required");
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });

  it("removes resolved item, announces success, and shows live resolution message", async () => {
    harness.officeData.data = { items: [match()], nextCursor: null };
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(await screen.findByText("Merged duplicate review.")).toBeTruthy();
    expect(screen.queryByText("Possible duplicate")).toBeNull();
    expect(harness.api.announceDuplicateReviewUpdated).toHaveBeenCalledTimes(1);
  });

  it("announces successful resolution while another pending item remains", async () => {
    harness.officeData.data = { items: [match(), match({ id: "match-2", existingExpenseId: "existing-2", candidateExpenseId: "candidate-2" })], nextCursor: null };
    renderPage();
    fireEvent.click(screen.getAllByRole("button", { name: "Merge" })[0]);
    expect(await screen.findByText("Merged duplicate review.")).toBeTruthy();
    expect(screen.getAllByText("Possible duplicate")).toHaveLength(1);
    expect(screen.getByText("candidate-2")).toBeTruthy();
    expect(harness.api.announceDuplicateReviewUpdated).toHaveBeenCalledTimes(1);
  });

  it("refreshes list after conflict and announces conflict", async () => {
    harness.api.resolveDuplicateMatch.mockRejectedValue(new harness.DuplicateReviewError("changed", 409));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Match changed while you were reviewing");
    expect(harness.api.fetchDuplicateMatches).toHaveBeenCalledTimes(1);
    expect(screen.getByText("candidate-2")).toBeTruthy();
  });

  it("loads more matches and preserves existing pending items", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("candidate-2")).toBeTruthy();
    expect(screen.getByText("existing-1")).toBeTruthy();
    expect(harness.api.fetchDuplicateMatches).toHaveBeenCalledWith(expect.anything(), expect.anything(), "org_123", undefined, "cursor-2");
  });

  it("shows pagination failure without dropping existing matches", async () => {
    harness.api.fetchDuplicateMatches.mockRejectedValue(new Error("Page unavailable"));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Page unavailable");
    expect(screen.getByText("existing-1")).toBeTruthy();
  });

  it("shows refresh progress and handles refresh failure", async () => {
    let finishRefresh!: (value: unknown) => void;
    harness.api.fetchDuplicateMatches.mockReturnValue(new Promise((resolve) => { finishRefresh = resolve; }));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Refresh list" }));
    expect(screen.getByRole("status").textContent).toContain("Refreshing duplicate list");
    expect((screen.getByRole("button", { name: "Refresh list" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(true);
    finishRefresh({ items: [match()], nextCursor: null });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("1 pending duplicate matches"));

    harness.api.fetchDuplicateMatches.mockRejectedValue(new Error("Refresh unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh list" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Refresh unavailable");
  });

  it("fails closed when refresh authorization expires", async () => {
    harness.api.fetchDuplicateMatches.mockRejectedValue(new harness.DuplicateReviewError("expired", 403));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Refresh list" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Office authorization required");
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });
});
